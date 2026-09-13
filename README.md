# brreg-mcp

MCP-server som svarer på ett spørsmål: **hvilke enheter har oppgitt dette
regnskapsforetaket som regnskapsfører?**

Enhetsregisteret indekserer rollen `REGN` fra kunden og utover
(`/enheter/{orgnr}/roller` → hvem er *min* regnskapsfører), aldri motsatt vei.
Den omvendte indeksen finnes ikke som API, så den bygges lokalt av den åpne
rolledumpen og lastes inn i D1.

Stateless Worker, ingen Durable Object, ingen autentisering.

**Live:** `https://brreg-mcp.hans-christian-thjomoe.workers.dev/mcp`

## Tool

`kunder_for_regnskapsforer(orgnr, limit=500, offset=0, berik=true)`

| Felt | |
|---|---|
| `orgnr` | organisasjonsnummeret til regnskapsforetaket, 9 siffer |
| `limit` / `offset` | paginering, maks 1000 per kall |
| `berik` | `true` slår opp navn, bransje, sted, ansatte og konkursstatus live fra Enhetsregisteret. `false` gir bare organisasjonsnumre |

Svaret inneholder foretakets navn og godkjenningsstatus, totalt antall kunder,
datoen indeksen ble bygget, og kundelisten.

## Bygge og laste indeksen

```bash
npm install
python3 bygg_indeks.py                 # laster dumpen (304 hvis uendret), skriver sql/data_*.sql
npx wrangler d1 create brreg  # legg database_id inn i wrangler.jsonc
npx wrangler d1 execute brreg --remote --file=sql/schema.sql
for f in sql/data_*.sql; do npx wrangler d1 execute brreg --remote --file=$f; done
npx wrangler deploy
```

Per 2026-09-04: 2 773 regnskapsforetak, 443 307 kunderelasjoner, ~13 MB SQL.

Dumpen legges ut på nytt hver natt. Nedlastingen er betinget (`If-None-Match`),
så en ukentlig re-bygging koster ingenting når filen er uendret.

Lokal utvikling: bytt `--remote` mot `--local`, så `npx wrangler dev`.

## Forbehold

- Registrering av regnskapsfører i Enhetsregisteret er **frivillig** for de
  fleste selskapsformer. Listen er et gulv, ikke en fasit — kundeforhold som
  ikke er registrert, er ikke synlige.
- Indeksen er ikke begrenset til autoriserte regnskapsforetak. Konsern som
  fører regnskap for egne datterselskaper dukker også opp; Equinor ASA står
  f.eks. som regnskapsfører for 65 enheter. Sjekk `godkjenningsstatus` i svaret.
- Indeksen er et øyeblikksbilde fra dumpedatoen. `kilde_dato` i svaret sier
  hvor gammel den er.

Data: Enhetsregisteret, Brønnøysundregistrene. Lisens: NLOD.
