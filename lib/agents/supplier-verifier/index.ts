import { z } from "zod";
import { Agent } from "../base";
import { searchCompanies } from "../../sources/companies-house";
import { searchLEI } from "../../sources/gleif";

// Legal-entity suffixes to strip before similarity scoring
const LEGAL_SUFFIXES = /\b(co\.?|ltd\.?|llc\.?|corp\.?|inc\.?|pvt\.?|gmbh|s\.a\.?|b\.v\.?|limited|company|corporation|trading|textile|textiles|group|international|enterprises?|industries|manufacturing|factory|factories)\b\.?/gi;

const MatchCandidate = z.object({
  name: z.string(),
  registry_id: z.string(),
  country: z.string(),
  incorporation_date: z.string().nullable(),
  status: z.string(),
  officers: z.array(z.string()),
  parent_company: z.string().nullable(),
  match_confidence: z.number(),
});

export const SupplierVerifierOutput = z.object({
  supplier_name: z.string(),
  country: z.string(),
  registry_source: z.string(),
  match_candidates: z.array(MatchCandidate),
  limited_data: z.boolean(),
  citations: z.array(z.string()),
});

export type SupplierVerifierOutput = z.infer<typeof SupplierVerifierOutput>;

function stripSuffixes(s: string): string {
  return s.replace(LEGAL_SUFFIXES, "").replace(/\s+/g, " ").trim();
}

function nameSimilarity(a: string, b: string): number {
  const normalize = (s: string) => stripSuffixes(s).toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const wordsA = new Set(na.split(/\s+/).filter((w) => w.length > 2));
  const wordsB = new Set(nb.split(/\s+/).filter((w) => w.length > 2));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

export class SupplierVerifierAgent extends Agent {
  readonly name = "supplier-verifier";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<SupplierVerifierOutput> {
    const { supplier_name, country, shipmentId } = input as {
      supplier_name?: string | null;
      country: string;
      shipmentId?: string;
    };

    // If no supplier name was provided, skip the registry lookup entirely
    if (!supplier_name) {
      const skipped: SupplierVerifierOutput = {
        supplier_name: "",
        country,
        registry_source: "skipped",
        match_candidates: [],
        limited_data: true,
        citations: ["No supplier name specified — registry verification skipped"],
      };
      await this.publishSignal({
        shipmentId,
        signalType: "supplier_verification_skipped",
        severity: "info",
        payload: { country, reason: "no_supplier_name" },
        confidence: 1.0,
      });
      return skipped;
    }

    const isUK = ["GB", "UK"].includes(country.toUpperCase());
    let candidates: z.infer<typeof MatchCandidate>[] = [];
    let registrySource = "";
    let limited = false;

    if (isUK) {
      registrySource = "UK Companies House";
      try {
        const results = await searchCompanies(supplier_name, 5);
        candidates = results.map((c) => ({
          name: c.title,
          registry_id: c.company_number,
          country: "GB",
          incorporation_date: c.date_of_creation ?? null,
          status: c.company_status,
          officers: [],
          parent_company: null,
          match_confidence: nameSimilarity(supplier_name, c.title),
        }));
      } catch {
        limited = true;
      }
    } else {
      registrySource = "GLEIF LEI Registry";
      try {
        const results = await searchLEI(supplier_name, country);
        candidates = results.map((r) => ({
          name: r.legalName,
          registry_id: r.lei,
          country: r.legalAddress.country,
          incorporation_date: r.registrationDate ?? null,
          status: r.status,
          officers: [],
          // GLEIF returns ultimate parent relationship — use it if available
          parent_company: (r as any).ultimateParent?.legalName ?? null,
          match_confidence: nameSimilarity(supplier_name, r.legalName),
        }));
      } catch {
        limited = true;
      }
    }

    // Sort by confidence descending
    candidates.sort((a, b) => b.match_confidence - a.match_confidence);

    // If we have hits, use Mercury to enhance with context
    if (candidates.length > 0) {
      const systemPrompt = `You are a supplier verification analyst. Given registry data for a searched supplier, return enhanced match candidates.

Return JSON:
{
  "supplier_name": "${supplier_name}",
  "country": "${country}",
  "registry_source": "${registrySource}",
  "match_candidates": [{ "name": string, "registry_id": string, "country": string, "incorporation_date": string|null, "status": string, "officers": string[], "parent_company": string|null, "match_confidence": 0-1 }],
  "limited_data": false,
  "citations": string[]
}

Adjust match_confidence based on: name similarity (primary), country match, active status, registration age. Inactive/dissolved companies get confidence penalty 0.3. Where registry data includes a parent company or controlling entity, preserve it in "parent_company".`;

      try {
        const enhanced = await this.callLLMValidated(
          [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Registry results for "${supplier_name}" (${country}) via ${registrySource}:\n${JSON.stringify(candidates, null, 2)}\n\nReturn enhanced candidates with accurate confidence scores.`,
            },
          ],
          SupplierVerifierOutput
        );

        await this.publishSignal({
          shipmentId,
          signalType: "supplier_verification",
          severity: "info",
          payload: enhanced as unknown as Record<string, unknown>,
          confidence: 0.8,
        });

        return enhanced;
      } catch {
        // Fall through to basic output
      }
    }

    const result: SupplierVerifierOutput = {
      supplier_name,
      country,
      registry_source: registrySource || "GLEIF LEI Registry",
      match_candidates: candidates,
      limited_data: limited || candidates.length === 0,
      citations: [
        registrySource
          ? `${registrySource} (searched: "${supplier_name}", country: ${country})`
          : `Limited public registry data available for ${country}`,
      ],
    };

    await this.publishSignal({
      shipmentId,
      signalType: "supplier_verification",
      severity: "info",
      payload: result as unknown as Record<string, unknown>,
      confidence: 0.6,
    });

    return result;
  }
}
