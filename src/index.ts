import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  DB: D1Database;
}

const BRREG = "https://data.brreg.no/enhetsregisteret/api";

// Workers Free tillater 50 subrequests per kjøring, D1-kallene inkludert.
const ENHETER_PER_KJORING = 40;

type RolleEnhet = { organisasjonsnummer: string; navn?: string[]; godkjenningsstatus?: string };
type Rolle = { type: { kode: string }; enhet?: RolleEnhet; avregistrert?: boolean };
type Hendelse = { id: string; time: string; data: { organisasjonsnummer: string } };

type Kunde = {
  orgnr: string;
  navn?: string;
  organisasjonsform?: string;
  naering?: string;
  sted?: string;
  kommune?: string;
  ansatte?: number | null;
  hjemmeside?: string | null;
  konkurs?: boolean;
  under_avvikling?: boolean;
};

/** Slår opp navn og status for inntil 100 orgnr per kall mot Enhetsregisteret. */
async function berikKunder(orgnumre: string[]): Promise<Map<string, Kunde>> {
  const ut = new Map<string, Kunde>();
  for (let i = 0; i < orgnumre.length; i += 100) {
    const batch = orgnumre.slice(i, i + 100);
    const url = `${BRREG}/enheter?organisasjonsnummer=${batch.join(",")}&size=100`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) continue; // beriking er best effort; orgnr står seg uansett
    const data = (await res.json()) as any;
    for (const e of data?._embedded?.enheter ?? []) {
      ut.set(e.organisasjonsnummer, {
        orgnr: e.organisasjonsnummer,
        navn: e.navn,
        organisasjonsform: e.organisasjonsform?.kode,
        naering: e.naeringskode1?.beskrivelse,
        sted: e.forretningsadresse?.poststed,
        kommune: e.forretningsadresse?.kommune,
        ansatte: e.antallAnsatte ?? null,
        hjemmeside: e.hjemmeside ?? null,
        konkurs: Boolean(e.konkurs),
        under_avvikling: Boolean(e.underAvvikling),
      });
    }
  }
  return ut;
}

/** Samme utvalg som bygg_indeks.py: REGN-roller som ikke er avregistrert og står på en enhet. */
async function regnskapsforereFor(orgnr: string): Promise<RolleEnhet[]> {
  const res = await fetch(`${BRREG}/enheter/${orgnr}/roller`, {
    headers: { accept: "application/json" },
  });
  if (res.status === 404 || res.status === 410) return []; // slettet enhet
  if (!res.ok) throw new Error(`roller for ${orgnr}: HTTP ${res.status}`);
  const data = (await res.json()) as { rollegrupper?: { roller: Rolle[] }[] };
  const forere = new Map<string, RolleEnhet>();
  for (const r of (data.rollegrupper ?? []).flatMap((g) => g.roller)) {
    if (r.type.kode === "REGN" && !r.avregistrert && r.enhet) {
      forere.set(r.enhet.organisasjonsnummer, r.enhet);
    }
  }
  return [...forere.values()];
}

async function hentHendelser(db: D1Database): Promise<Hendelse[]> {
  const meta = await db
    .prepare("SELECT nokkel, verdi FROM metadata WHERE nokkel IN ('siste_hendelse_id', 'kilde_dato')")
    .all<{ nokkel: string; verdi: string }>();
  const m = Object.fromEntries(meta.results.map((r) => [r.nokkel, r.verdi]));

  const url = new URL(`${BRREG}/oppdateringer/roller`);
  url.searchParams.set("size", String(ENHETER_PER_KJORING));
  if (m.siste_hendelse_id) {
    url.searchParams.set("afterId", m.siste_hendelse_id);
  } else {
    const dato = /^\d{4}-\d{2}-\d{2}/.exec(m.kilde_dato ?? "")?.[0];
    if (!dato) throw new Error(`metadata.kilde_dato er ikke en ISO-dato: ${m.kilde_dato}`);
    // Nedlastingsdatoen kan ligge en dag etter dumpen. Å spille av et døgn for mye er
    // ufarlig, fordi hver hendelse leses som enhetens nåtilstand.
    url.searchParams.set("afterTime", new Date(Date.parse(dato) - 86_400_000).toISOString());
  }

  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`oppdateringer/roller: HTTP ${res.status}`);
  return (await res.json()) as Hendelse[];
}

/** Spiller neste porsjon av Enhetsregisterets rolle-feed inn i indeksen. */
async function synkRoller(db: D1Database) {
  const hendelser = await hentHendelser(db);
  if (hendelser.length === 0) return;

  const orgnumre = [...new Set(hendelser.map((h) => h.data.organisasjonsnummer))];
  const nye = new Map<string, RolleEnhet[]>();
  for (const orgnr of orgnumre) nye.set(orgnr, await regnskapsforereFor(orgnr));

  const plass = orgnumre.map(() => "?").join(", ");
  const gamle = await db
    .prepare(`SELECT regn_orgnr FROM kunde WHERE kunde_orgnr IN (${plass})`)
    .bind(...orgnumre)
    .all<{ regn_orgnr: string }>();

  // antall_kunder justeres med differansen; en full opptelling per kjøring ville lest
  // hundretusenvis av rader om dagen.
  const endring = new Map<string, number>();
  const juster = (regn: string, n: number) => endring.set(regn, (endring.get(regn) ?? 0) + n);
  for (const g of gamle.results) juster(g.regn_orgnr, -1);

  const setninger = [db.prepare(`DELETE FROM kunde WHERE kunde_orgnr IN (${plass})`).bind(...orgnumre)];
  for (const [kunde, forere] of nye) {
    for (const f of forere) {
      juster(f.organisasjonsnummer, 1);
      setninger.push(
        db
          .prepare(
            "INSERT INTO regnskapsforer (orgnr, navn, godkjenning, antall_kunder) VALUES (?, ?, ?, 0) " +
              "ON CONFLICT (orgnr) DO UPDATE SET navn = excluded.navn, godkjenning = excluded.godkjenning",
          )
          .bind(f.organisasjonsnummer, f.navn?.[0] ?? "", f.godkjenningsstatus ?? null),
        db.prepare("INSERT INTO kunde (regn_orgnr, kunde_orgnr) VALUES (?, ?)").bind(f.organisasjonsnummer, kunde),
      );
    }
  }
  for (const [regn, n] of endring) {
    if (n === 0) continue;
    setninger.push(
      db.prepare("UPDATE regnskapsforer SET antall_kunder = antall_kunder + ? WHERE orgnr = ?").bind(n, regn),
    );
    if (n < 0) {
      setninger.push(
        db.prepare("DELETE FROM regnskapsforer WHERE orgnr = ? AND antall_kunder <= 0").bind(regn),
      );
    }
  }
  const siste = hendelser[hendelser.length - 1];
  setninger.push(
    db
      .prepare(
        "INSERT OR REPLACE INTO metadata (nokkel, verdi) VALUES ('siste_hendelse_id', ?), ('oppdatert_til', ?)",
      )
      .bind(siste.id, siste.time),
  );
  await db.batch(setninger);
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "brreg",
    version: "1.0.0",
  });

  server.registerTool(
    "kunder_for_regnskapsforer",
    {
      description:
        "Lister enhetene som har oppgitt et gitt regnskapsforetak som regnskapsfører " +
        "(rollen REGN i Enhetsregisteret). Ta inn organisasjonsnummeret til " +
        "regnskapsforetaket, ikke navnet. Enhetsregisteret har ikke dette oppslaget " +
        "selv; dataene kommer fra en indeks bygget av den åpne rolledumpen og holdt " +
        "oppdatert fra Enhetsregisterets endringsfeed. " +
        "Registrering av regnskapsfører er frivillig for de fleste selskapsformer, " +
        "så listen er et minimum, ikke en komplett kundeliste.",
      inputSchema: {
        orgnr: z
          .string()
          .regex(/^\d{9}$/, "orgnr må være 9 siffer")
          .describe("Organisasjonsnummeret til regnskapsforetaket, 9 siffer"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(500)
          .describe("Maks antall kunder i svaret"),
        offset: z.number().int().min(0).default(0).describe("Hopp over de første N"),
        berik: z
          .boolean()
          .default(true)
          .describe(
            "Slå opp navn, bransje, sted og konkursstatus live fra Enhetsregisteret. " +
              "Sett false for å få bare organisasjonsnumre, som er raskere.",
          ),
      },
    },
    async ({ orgnr, limit, offset, berik }) => {
      const firma = await env.DB.prepare(
        "SELECT orgnr, navn, godkjenning, antall_kunder FROM regnskapsforer WHERE orgnr = ?",
      )
        .bind(orgnr)
        .first<{ orgnr: string; navn: string; godkjenning: string | null; antall_kunder: number }>();

      if (!firma) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `Fant ingen enheter som har ${orgnr} registrert som regnskapsfører. ` +
                `Enten er orgnummeret ikke et regnskapsforetak, eller så har ingen ` +
                `av kundene registrert det i Enhetsregisteret.`,
            },
          ],
        };
      }

      const rader = await env.DB.prepare(
        "SELECT kunde_orgnr FROM kunde WHERE regn_orgnr = ? ORDER BY kunde_orgnr LIMIT ? OFFSET ?",
      )
        .bind(orgnr, limit, offset)
        .all<{ kunde_orgnr: string }>();

      const orgnumre = rader.results.map((r) => r.kunde_orgnr);
      let kunder: Kunde[] = orgnumre.map((o) => ({ orgnr: o }));

      if (berik && orgnumre.length > 0) {
        const detaljer = await berikKunder(orgnumre);
        kunder = orgnumre.map((o) => detaljer.get(o) ?? { orgnr: o });
      }

      const meta = await env.DB.prepare(
        "SELECT nokkel, verdi FROM metadata WHERE nokkel IN ('kilde_dato', 'oppdatert_til')",
      ).all<{ nokkel: string; verdi: string }>();
      const m = Object.fromEntries(meta.results.map((r) => [r.nokkel, r.verdi]));

      const resultat = {
        regnskapsforer: {
          orgnr: firma.orgnr,
          navn: firma.navn,
          godkjenningsstatus: firma.godkjenning,
        },
        antall_totalt: firma.antall_kunder,
        antall_i_svaret: kunder.length,
        offset,
        kilde: "Enhetsregisteret, rollen REGN",
        kilde_dato: m.kilde_dato ?? "ukjent",
        oppdatert_til: m.oppdatert_til ?? m.kilde_dato ?? "ukjent",
        kunder,
      };

      const vist = offset + kunder.length;
      const mer =
        vist < firma.antall_kunder
          ? ` Viser ${offset + 1}–${vist}; kall på nytt med offset=${vist} for resten.`
          : "";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${firma.navn} (${firma.orgnr}) har ${firma.antall_kunder} registrerte kunder.` +
              mer +
              `\n\n${JSON.stringify(resultat, null, 1)}`,
          },
        ],
        structuredContent: resultat,
      };
    },
  );

  return server;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        "brreg-mcp — MCP-endepunkt på /mcp (streamable http, ingen autentisering)\n",
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
  async scheduled(_controller, env) {
    await synkRoller(env.DB);
  },
} satisfies ExportedHandler<Env>;
