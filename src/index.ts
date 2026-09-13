import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  DB: D1Database;
}

const BRREG = "https://data.brreg.no/enhetsregisteret/api";

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
        "selv; dataene kommer fra en indeks bygget av den åpne rolledumpen. " +
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
        "SELECT verdi FROM metadata WHERE nokkel = 'kilde_dato'",
      ).first<{ verdi: string }>();

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
        kilde_dato: meta?.verdi ?? "ukjent",
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
} satisfies ExportedHandler<Env>;
