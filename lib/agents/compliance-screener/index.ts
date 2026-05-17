import { z } from "zod";
import { Agent } from "../base";
import { searchSanctions } from "../../db/queries";

// HS chapters where UFLPA rebuttable presumption applies (cotton, polysilicon, tomatoes, etc.)
const UFLPA_WATCH_CHAPTERS = new Set(["52", "53", "54", "55", "56", "57", "58", "59", "60", "61", "62", "63", "85"]);

const SanctionsMatch = z.object({
  entity_name: z.string(),
  list_source: z.enum(["ofac", "uflpa"]),
  match_type: z.enum(["exact", "partial", "alias"]),
  confidence: z.number(),
});

export const ComplianceOutput = z.object({
  supplier_name: z.string(),
  country: z.string(),
  verdict: z.enum(["clean", "flagged"]),
  matches: z.array(SanctionsMatch),
  uflpa_flag: z.boolean(),
  uflpa_rebuttable_presumption: z.boolean().optional(),
  citations: z.array(z.string()),
});

export type ComplianceOutput = z.infer<typeof ComplianceOutput>;

export class ComplianceScreenerAgent extends Agent {
  readonly name = "compliance-screener";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<ComplianceOutput> {
    const {
      supplier_name,
      country,
      hs_code,
      parent_companies = [],
      shipmentId,
    } = input as {
      supplier_name?: string | null;
      country: string;
      hs_code?: string | null;
      parent_companies?: string[];
      shipmentId?: string;
    };

    const hsChapter = hs_code?.slice(0, 2) ?? "";
    const isChinaUFLPAWatch = country.toUpperCase() === "CN" && UFLPA_WATCH_CHAPTERS.has(hsChapter);

    // If no supplier name and no parent companies to check, emit skipped signal
    if (!supplier_name && parent_companies.length === 0) {
      const result: ComplianceOutput = {
        supplier_name: "",
        country,
        verdict: "clean",
        matches: [],
        uflpa_flag: false,
        uflpa_rebuttable_presumption: isChinaUFLPAWatch,
        citations: ["No supplier name — entity-level sanctions check skipped", "OFAC SDN List (local copy)", "DHS UFLPA Entity List (local copy)"],
      };
      await this.publishSignal({
        shipmentId,
        signalType: "compliance_screen",
        severity: isChinaUFLPAWatch ? "medium" : "info",
        payload: result as unknown as Record<string, unknown>,
        confidence: 0.7,
      });
      return result;
    }

    // Build list of names to check — real supplier + parent companies
    const namesToCheck = [supplier_name, ...parent_companies].filter(Boolean) as string[];
    const rawMatches: Array<{
      checked_name: string;
      db_matches: Awaited<ReturnType<typeof searchSanctions>>;
    }> = [];

    for (const name of namesToCheck) {
      try {
        const matches = await searchSanctions(name);
        if (matches.length > 0) {
          rawMatches.push({ checked_name: name, db_matches: matches });
        }
      } catch {
        // non-fatal
      }
    }

    // If no DB hits and no UFLPA concern, return clean immediately without LLM call
    if (rawMatches.length === 0 && !isChinaUFLPAWatch) {
      const result: ComplianceOutput = {
        supplier_name: supplier_name ?? "",
        country,
        verdict: "clean",
        matches: [],
        uflpa_flag: false,
        uflpa_rebuttable_presumption: false,
        citations: ["OFAC SDN List (local copy)", "DHS UFLPA Entity List (local copy)"],
      };
      await this.publishSignal({
        shipmentId,
        signalType: "compliance_screen",
        severity: "info",
        payload: result as unknown as Record<string, unknown>,
        confidence: 0.95,
      });
      return result;
    }

    // Use Mercury to confirm whether DB hits are real matches
    const dbContext = rawMatches.length > 0
      ? rawMatches
          .map(
            ({ checked_name, db_matches }) =>
              `Checked name: "${checked_name}"\nDB matches (${db_matches.length}):\n` +
              db_matches
                .slice(0, 10)
                .map(
                  (m) =>
                    `  - "${m.name}" [${m.list_source}] country=${m.country ?? "?"} aliases=${JSON.stringify(m.aliases ?? []).slice(0, 80)}`
                )
                .join("\n")
          )
          .join("\n\n")
      : "No direct sanctions database hits found.";

    const uflpaNote = isChinaUFLPAWatch
      ? `\n\nIMPORTANT: HS chapter ${hsChapter} from China falls under UFLPA rebuttable presumption for Xinjiang-origin goods. Even without a direct entity match, set uflpa_rebuttable_presumption: true and note that the importer must be prepared to provide evidence of origin outside Xinjiang.`
      : "";

    const systemPrompt = `You are a sanctions compliance analyst. Evaluate whether database hits are real matches for the queried supplier.

Return JSON:
{
  "supplier_name": string,
  "country": string,
  "verdict": "clean" | "flagged",
  "matches": [{ "entity_name": string, "list_source": "ofac"|"uflpa", "match_type": "exact"|"partial"|"alias", "confidence": 0-1 }],
  "uflpa_flag": boolean,
  "uflpa_rebuttable_presumption": boolean,
  "citations": string[]
}

A hit is a real match if: same country AND (name is identical/abbreviation, or alias matches, or parent company name matches).
Common false positives: generic words ("China company", "Vietnam trading"), different industries, different countries.
UFLPA flag = true only if a confirmed match is on the DHS UFLPA entity list (list_source = "uflpa").${uflpaNote}

Supplier: "${supplier_name ?? "unknown"}", Country: ${country}${hs_code ? `, HS: ${hs_code}` : ""}`;

    const result = await this.callLLMValidated(
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Evaluate these sanctions database hits:\n\n${dbContext}\n\nReturn compliance verdict for "${supplier_name ?? "unknown"}" (${country}).`,
        },
      ],
      ComplianceOutput
    );

    await this.publishSignal({
      shipmentId,
      signalType: "compliance_screen",
      severity: result.uflpa_flag ? "critical" : result.verdict === "flagged" ? "high" : isChinaUFLPAWatch ? "medium" : "info",
      payload: result as unknown as Record<string, unknown>,
      confidence: 0.9,
    });

    return result;
  }
}
