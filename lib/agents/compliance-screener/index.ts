import { z } from "zod";
import { Agent } from "../base";
import { searchSanctions } from "../../db/queries";

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
      parent_companies = [],
      shipmentId,
    } = input as {
      supplier_name: string;
      country: string;
      parent_companies?: string[];
      shipmentId?: string;
    };

    // Query local sanctions table for supplier name and each parent company
    const namesToCheck = [supplier_name, ...parent_companies].filter(Boolean);
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

    // If no DB hits at all, return clean immediately without LLM call
    if (rawMatches.length === 0) {
      const result: ComplianceOutput = {
        supplier_name,
        country,
        verdict: "clean",
        matches: [],
        uflpa_flag: false,
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

    // Use Mercury to confirm whether DB hits are real matches for this supplier
    const dbContext = rawMatches
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
      .join("\n\n");

    const systemPrompt = `You are a sanctions compliance analyst. Evaluate whether database hits are real matches for the queried supplier.

Return JSON:
{
  "supplier_name": string,
  "country": string,
  "verdict": "clean" | "flagged",
  "matches": [{ "entity_name": string, "list_source": "ofac"|"uflpa", "match_type": "exact"|"partial"|"alias", "confidence": 0-1 }],
  "uflpa_flag": boolean,
  "citations": string[]
}

A hit is a real match if: same country AND (name is identical/abbreviation, or alias matches, or parent company name matches).
Common false positives: generic words ("China company", "Vietnam trading"), different industries, different countries.
UFLPA flag = true only if a confirmed match is on the DHS UFLPA entity list (list_source = "uflpa").

Supplier: "${supplier_name}", Country: ${country}`;

    const result = await this.callLLMValidated(
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Evaluate these sanctions database hits:\n\n${dbContext}\n\nReturn compliance verdict for "${supplier_name}" (${country}).`,
        },
      ],
      ComplianceOutput
    );

    await this.publishSignal({
      shipmentId,
      signalType: "compliance_screen",
      severity: result.uflpa_flag ? "critical" : result.verdict === "flagged" ? "high" : "info",
      payload: result as unknown as Record<string, unknown>,
      confidence: 0.9,
    });

    return result;
  }
}
