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
datoen indeksen ble bygget (`kilde_dato`), tidspunktet for siste innspilte
endring (`oppdatert_til`), og kundelisten.

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
så en re-bygging koster ingenting når filen er uendret. Med synken under trengs
re-bygging bare hvis indeksen skal settes opp på nytt.

Lokal utvikling: bytt `--remote` mot `--local`, så `npx wrangler dev`.

## Holde indeksen oppdatert

En cron-trigger kjører hvert minutt og spiller inn Enhetsregisterets
endringsfeed (`/oppdateringer/roller`). For hver endret enhet hentes
`/enheter/{orgnr}/roller`, og enhetens rader i `kunde` erstattes med dagens
REGN-roller. `antall_kunder` justeres med differansen.

- Pekeren ligger i `metadata.siste_hendelse_id`. Mangler den, starter synken ett
  døgn før `kilde_dato`; hver hendelse leses som nåtilstand, så avspilling er
  ufarlig.
- 40 enheter per kjøring holder seg under Workers Free-grensen på 50
  subrequests. Normal dag er rundt 1 500 endringer, som tas unna fortløpende;
  etter en ny import tar innhentingen noen timer.
- `bygg_indeks.py` skriver metadata sist, så en re-bygging nullstiller pekeren.
- Databaser bygget før indeksen `kunde_etter_kunde` fantes, trenger den én gang:
  `npx wrangler d1 execute brreg --remote --command "CREATE INDEX IF NOT EXISTS kunde_etter_kunde ON kunde (kunde_orgnr)"`

Test lokalt: `npx wrangler dev --test-scheduled`, så
`curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`.

## Forbehold

- Registrering av regnskapsfører i Enhetsregisteret er **frivillig** for de
  fleste selskapsformer. Listen er et gulv, ikke en fasit — kundeforhold som
  ikke er registrert, er ikke synlige.
- Indeksen er ikke begrenset til autoriserte regnskapsforetak. Konsern som
  fører regnskap for egne datterselskaper dukker også opp; Equinor ASA står
  f.eks. som regnskapsfører for 65 enheter. Sjekk `godkjenningsstatus` i svaret.
- Indeksen henger etter feeden med opptil noen minutter. `oppdatert_til` i
  svaret sier hvor langt synken har kommet.

Data: Enhetsregisteret, Brønnøysundregistrene. Lisens: NLOD.
