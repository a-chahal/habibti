import { z } from "zod";
import { Agent } from "../base";
import { searchLEI } from "../../sources/gleif";

const Supplier = z.object({
  name: z.string(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  website: z.string().nullable(),
  products: z.string().nullable(),
  evidence_url: z.string().nullable(),
  min_order: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export const SupplierDiscovererOutput = z.object({
  country: z.string(),
  hs_code: z.string(),
  suppliers: z.array(Supplier),
  citations: z.array(z.string()),
});

export type SupplierDiscovererOutput = z.infer<typeof SupplierDiscovererOutput>;
export type DiscoveredSupplier = z.infer<typeof Supplier> & { registry_verified?: boolean; lei?: string };

function buildSystemPrompt(countryISO: string, countryFullName: string): string {
  return `You are a sourcing analyst helping a small US importer find REAL bulk-goods suppliers.
Use web search to find actual exporters/manufacturers — do not invent names.

⚠ HARD COUNTRY CONSTRAINT ⚠
Every supplier you return MUST be physically located in ${countryFullName} (ISO-2: ${countryISO}) and MUST export from there.
- DO NOT return US/EU/Chinese companies that merely resell ${countryFullName} products.
- DO NOT return importers or distributors based outside ${countryFullName}.
- The supplier's headquarters address must be in ${countryFullName}.
- If your web search keeps returning the wrong country, refine the query with "site:${countryFullName.toLowerCase().replace(/\\s+/g, '')}" or local trade portal names (e.g. "exporters in ${countryFullName}", "${countryFullName} manufacturer directory").

Return ONLY this JSON shape (no prose, no fences):
{
  "country": "${countryISO}",
  "hs_code": "<HS code>",
  "suppliers": [
    {
      "name": "<company legal name>",
      "country": "${countryISO}",
      "city": "<city in ${countryFullName} or null>",
      "website": "<url or null>",
      "products": "<short blurb on what they actually export>",
      "evidence_url": "<the source URL that proves this company exists & exports this product from ${countryFullName}>",
      "min_order": "<MOQ if visible, else null>",
      "confidence": 0.0
    }
  ],
  "citations": ["url1", "url2", ...]
}

Rules:
- Return 4-6 candidates, ALL based in ${countryFullName}.
- Every candidate MUST have an evidence_url you actually found in your web results.
- Prefer manufacturers / direct exporters over brokers for orders >1 container.
- Prefer brokers / trading companies for sub-container orders.
- Skip companies that look defunct, fraudulent, or with no online presence.
- If you genuinely cannot find verifiable ${countryFullName} suppliers after searching, return an empty "suppliers" array and explain in "citations" what you tried.`;
}

// Minimal ISO-2 → country-name mapping for the prompt. Falls back to the code itself.
const ISO_NAMES: Record<string, string> = {
  AR: "Argentina", AU: "Australia", BD: "Bangladesh", BR: "Brazil", CA: "Canada",
  CL: "Chile", CN: "China", CO: "Colombia", DE: "Germany", EC: "Ecuador",
  EG: "Egypt", ES: "Spain", ET: "Ethiopia", FR: "France", GB: "United Kingdom",
  GR: "Greece", HN: "Honduras", ID: "Indonesia", IN: "India", IT: "Italy",
  JP: "Japan", KE: "Kenya", KH: "Cambodia", KR: "South Korea", LK: "Sri Lanka",
  MA: "Morocco", MX: "Mexico", MY: "Malaysia", NG: "Nigeria", PE: "Peru",
  PH: "Philippines", PK: "Pakistan", PL: "Poland", PT: "Portugal", RO: "Romania",
  TH: "Thailand", TR: "Turkey", TW: "Taiwan", UA: "Ukraine", US: "United States",
  VN: "Vietnam", ZA: "South Africa",
};

function userPrompt(args: {
  productDescription: string;
  hsCode: string;
  country: string;
  quantity?: string | number | null;
  quantityUnit?: string | null;
}): string {
  const qty = args.quantity ? `${args.quantity}${args.quantityUnit ? " " + args.quantityUnit : ""}` : "(unspecified)";
  return `Find suppliers for:
- Product: ${args.productDescription}
- HS code: ${args.hsCode}
- Country: ${args.country}
- Quantity: ${qty}
- Destination: United States

Return 4-6 real, verifiable exporters with evidence URLs.`;
}

export class SupplierDiscovererAgent extends Agent {
  readonly name = "supplier-discoverer";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<SupplierDiscovererOutput & { suppliers: DiscoveredSupplier[] }> {
    const {
      shipmentId,
      hs_code,
      country,
      product_description,
      quantity,
      quantity_unit,
    } = input as {
      shipmentId?: string;
      hs_code: string;
      country: string;
      product_description: string;
      quantity?: number | string | null;
      quantity_unit?: string | null;
    };

    if (!product_description || !hs_code || !country) {
      const empty = { country, hs_code, suppliers: [], citations: ["missing inputs"] };
      return empty;
    }

    const countryISO = country.toUpperCase();
    const countryFullName = ISO_NAMES[countryISO] ?? countryISO;
    const systemPrompt = buildSystemPrompt(countryISO, countryFullName);

    const callOnce = (extraNudge = "") =>
      this.callLLMValidated(
        [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content:
              userPrompt({
                productDescription: product_description,
                hsCode: hs_code,
                country: countryFullName,
                quantity,
                quantityUnit: quantity_unit,
              }) + extraNudge,
          },
        ],
        SupplierDiscovererOutput,
        { web: true, maxTokens: 2500, temperature: 0.2 }
      );

    let discovered: SupplierDiscovererOutput;
    try {
      discovered = await callOnce();
    } catch (err: any) {
      console.error(`[supplier-discoverer] LLM/parse failed for ${countryISO}:`, err.message);
      const fallback = { country: countryISO, hs_code, suppliers: [], citations: [`web-discovery failed: ${err.message}`] };
      await this.publishSignal({
        shipmentId,
        signalType: "supplier_discovery",
        severity: "low",
        payload: fallback,
        confidence: 0.0,
      });
      return fallback;
    }

    // Post-filter: drop suppliers whose self-reported country doesn't match the requested one.
    // (Mercury occasionally returns US/EU resellers when asked about origin countries.)
    const beforeFilter = discovered.suppliers.length;
    discovered.suppliers = discovered.suppliers.filter((s) => {
      if (!s.country) return true; // tolerate missing country field
      return s.country.toUpperCase() === countryISO;
    });
    const dropped = beforeFilter - discovered.suppliers.length;
    if (dropped > 0) {
      console.warn(`[supplier-discoverer] ${countryISO}: dropped ${dropped} suppliers from wrong country`);
    }

    // Retry ONCE if the filtered list is empty — usually fixes a bad first search
    if (discovered.suppliers.length === 0) {
      console.warn(`[supplier-discoverer] ${countryISO}: empty result, retrying with stronger nudge`);
      try {
        const retry = await callOnce(
          `\n\nIMPORTANT: Your previous attempt returned no usable ${countryFullName} suppliers. Search trade portals like ExportHub, TradeIndia, Alibaba (filter by ${countryFullName}), local chamber-of-commerce directories, or the official ${countryFullName} export promotion agency website. Return 4-6 real companies headquartered in ${countryFullName}.`
        );
        retry.suppliers = retry.suppliers.filter((s) => !s.country || s.country.toUpperCase() === countryISO);
        if (retry.suppliers.length > 0) discovered = retry;
      } catch (err: any) {
        console.error(`[supplier-discoverer] ${countryISO} retry failed:`, err.message);
      }
    }

    // Cross-verify the TOP candidate against GLEIF for a "registry-verified" badge.
    // GLEIF coverage is best for large entities; misses are fine.
    const enriched: DiscoveredSupplier[] = discovered.suppliers.map((s) => ({ ...s }));
    const top = enriched[0];
    if (top?.name) {
      try {
        const lei = await searchLEI(top.name, country.toUpperCase());
        if (lei.length > 0) {
          top.registry_verified = true;
          top.lei = lei[0].lei;
        } else {
          top.registry_verified = false;
        }
      } catch {
        // GLEIF flakiness is non-fatal
      }
    }

    const out = { ...discovered, suppliers: enriched };

    await this.publishSignal({
      shipmentId,
      signalType: "supplier_discovery",
      severity: "info",
      payload: out as unknown as Record<string, unknown>,
      confidence: 0.8,
      citations: discovered.citations,
    });

    return out;
  }
}
