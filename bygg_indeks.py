#!/usr/bin/env python3
"""Bygger den omvendte indeksen regnskapsfører -> kunder som SQL for D1.

    python3 bygg_indeks.py                 # alle regnskapsforetak
    python3 bygg_indeks.py --kun 918097902 # bare ett, for rask lokal test

Kilde: https://data.brreg.no/enhetsregisteret/api/roller/totalbestand
       ~124 MB gzip, ny fil hver natt, ingen nøkkel, NLOD-lisens.
Enhetsregisteret indekserer rollen fra kunden og utover, aldri motsatt vei,
så den omvendte indeksen må bygges lokalt av hele dumpen.

Ut: sql/data_NNN.sql — importeres med
    npx wrangler d1 execute brreg --remote --file=sql/data_001.sql
"""
import argparse, gzip, json, os, sys, time, urllib.error, urllib.request
from collections import defaultdict

DUMP = "roller_totalbestand.json.gz"
DUMP_URL = "https://data.brreg.no/enhetsregisteret/api/roller/totalbestand"
RADER_PER_SETNING = 200
RADER_PER_FIL = 100_000


def hent_dump():
    """Betinget nedlasting: serveren svarer 304 hvis dumpen er uendret."""
    etag = None
    if os.path.exists(DUMP) and os.path.exists(DUMP + ".etag"):
        etag = open(DUMP + ".etag").read().strip()
    req = urllib.request.Request(DUMP_URL)
    if etag:
        req.add_header("If-None-Match", etag)
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            print("laster ned rolledump (~124 MB) ...", flush=True)
            with open(DUMP + ".tmp", "wb") as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
            os.replace(DUMP + ".tmp", DUMP)
            if ny := r.headers.get("ETag"):
                open(DUMP + ".etag", "w").write(ny)
            return r.headers.get("Last-Modified") or time.strftime("%Y-%m-%d")
    except urllib.error.HTTPError as e:
        if e.code != 304:
            raise
        print("dumpen er uendret (304) - bruker lokal kopi", flush=True)
        return time.strftime("%Y-%m-%d", time.gmtime(os.path.getmtime(DUMP)))


def les_relasjoner(kun=None):
    """Streamer dumpen linjevis. Hvert toppnivåobjekt er én enhet med rollegrupper."""
    kunder = defaultdict(list)   # regn_orgnr -> [kunde_orgnr]
    firma = {}                   # regn_orgnr -> (navn, godkjenningsstatus)
    buf, inne, n = [], False, 0
    with gzip.open(DUMP, "rt", encoding="utf-8") as f:
        for line in f:
            s = line.rstrip("\n")
            if not inne:
                if s in ("  {", "{"):
                    inne, buf = True, ["{\n"]
                continue
            if s in ("},", "}", "} ]"):
                inne = False
                n += 1
                if n % 200_000 == 0:
                    print(f"  {n} enheter lest ...", flush=True)
                txt = "".join(buf) + "}"
                if "REGN" in txt:
                    o = json.loads(txt)
                    for g in o.get("rollegrupper", []):
                        for r in g.get("roller", []):
                            if r["type"]["kode"] != "REGN" or r.get("avregistrert"):
                                continue
                            e = r.get("enhet")
                            if not e:
                                continue  # regnskapsfører registrert som person
                            rn = e["organisasjonsnummer"]
                            if kun and rn not in kun:
                                continue
                            kunder[rn].append(o["organisasjonsnummer"])
                            firma.setdefault(
                                rn,
                                ((e.get("navn") or [""])[0], e.get("godkjenningsstatus")),
                            )
                continue
            buf.append(line)
    print(f"  {n} enheter lest totalt", flush=True)
    return kunder, firma


def sitat(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def skriv_sql(kunder, firma, kilde_dato):
    os.makedirs("sql", exist_ok=True)
    for gammel in os.listdir("sql"):
        if gammel.startswith("data_"):
            os.remove(os.path.join("sql", gammel))

    filnr, radnr, ut = 1, 0, []

    def nyfil():
        nonlocal filnr, radnr, ut
        if ut:
            sti = f"sql/data_{filnr:03d}.sql"
            open(sti, "w").write("\n".join(ut) + "\n")
            print(f"  skrev {sti} ({radnr} rader)", flush=True)
            filnr += 1
        radnr, ut = 0, []

    ut.append("DELETE FROM metadata;")
    ut.append(
        f"INSERT INTO metadata (nokkel, verdi) VALUES "
        f"('kilde_dato', {sitat(kilde_dato)}), "
        f"('kilde', 'Enhetsregisteret rolledump, rollen REGN');"
    )
    ut.append("DELETE FROM regnskapsforer;")
    verdier = [
        f"({sitat(rn)}, {sitat(navn)}, {sitat(godkj)}, {len(kunder[rn])})"
        for rn, (navn, godkj) in firma.items()
    ]
    for i in range(0, len(verdier), RADER_PER_SETNING):
        ut.append(
            "INSERT INTO regnskapsforer (orgnr, navn, godkjenning, antall_kunder) VALUES "
            + ", ".join(verdier[i : i + RADER_PER_SETNING])
            + ";"
        )
    ut.append("DELETE FROM kunde;")
    nyfil()

    par = [(rn, kn) for rn, liste in kunder.items() for kn in sorted(set(liste))]
    for i in range(0, len(par), RADER_PER_SETNING):
        blokk = par[i : i + RADER_PER_SETNING]
        ut.append(
            "INSERT OR IGNORE INTO kunde (regn_orgnr, kunde_orgnr) VALUES "
            + ", ".join(f"({sitat(a)}, {sitat(b)})" for a, b in blokk)
            + ";"
        )
        radnr += len(blokk)
        if radnr >= RADER_PER_FIL:
            nyfil()
    nyfil()
    return len(par)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--kun", help="kommaseparerte orgnr, bygg indeks bare for disse")
    a = p.parse_args()
    kun = set(a.kun.split(",")) if a.kun else None

    kilde_dato = hent_dump()
    kunder, firma = les_relasjoner(kun)
    antall = skriv_sql(kunder, firma, kilde_dato)
    print(f"\n{len(firma)} regnskapsforetak, {antall} kunderelasjoner, kilde {kilde_dato}")
    print("importer med:  npx wrangler d1 execute brreg --remote --file=sql/data_001.sql  (osv.)")
