import { z } from "zod";
import { Agent } from "../base";
import type { DiscoveredSupplier } from "../supplier-discoverer";

const PriceQuote = z.object({
  supplier_name: z.string(),
  source_url: z.string(),
  price_usd_per_unit: z.number().nullable(),
  currency_original: z.string().nullable(),
  price_original: z.number().nullable(),
  moq: z.number().nullable(),
  moq_unit: z.string().nullable(),
  notes: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export const SupplierPriceExtractorOutput = z.object({
  country: z.string(),
  hs_code: z.string(),
  quotes: z.array(PriceQuote),
  median_price_usd_per_unit: z.number().nullable(),
  low_price_usd_per_unit: z.number().nullable(),
  high_price_usd_per_unit: z.number().nullable(),
  citations: z.array(z.string()),
});

export type SupplierPriceExtractorOutput = z.infer<typeof SupplierPriceExtractorOutput>;
export type PriceQuote = z.infer<typeof PriceQuote>;

interface ExtractorInput {
  shipmentId?: string;
  country: string;
  hs_code: string;
  product_description: string;
  quantity?: number | null;
  quantity_unit?: string | null;
  suppliers: DiscoveredSupplier[];
}

function median(nums: number[]): number | null {
  const sorted = nums.filter((n) => n > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export class SupplierPriceExtractorAgent extends Agent {
  readonly name = "supplier-price-extractor";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<SupplierPriceExtractorOutput> {
    const {
      shipmentId,
      country,
      hs_code,
      product_description,
      quantity,
      quantity_unit,
      suppliers,
    } = input as ExtractorInput;

    // Cap at top 3 suppliers — extra calls don't materially improve median price
    const top = (suppliers ?? []).slice(0, 3);
    if (top.length === 0) {
      const empty = {
        country, hs_code,
        quotes: [], median_price_usd_per_unit: null,
        low_price_usd_per_unit: null, high_price_usd_per_unit: null,
        citations: ["no suppliers provided"],
      };
      return empty;
    }

    const urls = top
      .map((s) => ({ name: s.name, url: s.evidence_url ?? s.website ?? null }))
      .filter((s) => !!s.url) as { name: string; url: string }[];

    if (urls.length === 0) {
      const empty = {
        country, hs_code,
        quotes: [], median_price_usd_per_unit: null,
        low_price_usd_per_unit: null, high_price_usd_per_unit: null,
        citations: ["suppliers have no URLs to extract from"],
      };
      return empty;
    }

    const qtyHint = quantity ? `${quantity}${quantity_unit ? " " + quantity_unit : ""}` : "small order";

    const systemPrompt = `You are a sourcing analyst extracting REAL price quotes from supplier websites.

For each supplier URL provided, use web search to visit the listing or company page and find the actual product price.

Many B2B sites (Alibaba, IndiaMART, ExportHub, company catalogues) list:
- "USD 8-12 / piece, MOQ 500"
- "Min order: 1 container, FOB price negotiable"
- Currency in CNY/EUR/INR — convert to USD using rough current rates (CNY ~0.14, EUR ~1.08, INR ~0.012, JPY ~0.0067)

Return ONLY this JSON (no fences, no prose):
{
  "country": "<ISO-2>",
  "hs_code": "<HS code>",
  "quotes": [
    {
      "supplier_name": "...",
      "source_url": "<the actual page you read>",
      "price_usd_per_unit": <number or null if no price visible>,
      "currency_original": "<USD|CNY|EUR|...> or null",
      "price_original": <number in original currency or null>,
      "moq": <number or null>,
      "moq_unit": "<piece|kg|MT|container> or null",
      "notes": "<short note like 'FOB Shanghai' or 'request quote only' or null>",
      "confidence": 0.0
    }
  ],
  "median_price_usd_per_unit": <number or null>,
  "low_price_usd_per_unit": <number or null>,
  "high_price_usd_per_unit": <number or null>,
  "citations": ["url1", ...]
}

Rules:
- One quote per supplier URL given, even if the price isn't visible (set price_usd_per_unit to null and explain in notes).
- Convert all prices to USD per single unit.
- For "price on request" pages, set price_usd_per_unit to null with notes="quote-on-request only".
- Don't invent prices. If you didn't actually see a number, leave it null.
- median/low/high should be computed across only the quotes where you found real numbers.`;

    const userPrompt = `Product: ${product_description}
HS code: ${hs_code}
Country: ${country}
Buyer's quantity: ${qtyHint}

Suppliers to extract from:
${urls.map((u, i) => `${i + 1}. ${u.name} — ${u.url}`).join("\n")}

Extract the actual per-unit price from each URL. Convert to USD. Return JSON.`;

    let parsed: SupplierPriceExtractorOutput;
    try {
      parsed = await this.callLLMValidated(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        SupplierPriceExtractorOutput,
        { web: true, maxTokens: 2200, temperature: 0.1 }
      );
    } catch (err: any) {
      console.error(`[supplier-price-extractor] failed for ${country}:`, err.message);
      const fallback = {
        country, hs_code,
        quotes: [], median_price_usd_per_unit: null,
        low_price_usd_per_unit: null, high_price_usd_per_unit: null,
        citations: [`extractor failed: ${err.message}`],
      };
      await this.publishSignal({
        shipmentId,
        signalType: "supplier_price_extracted",
        severity: "low",
        payload: fallback,
        confidence: 0.0,
      });
      return fallback;
    }

    // Re-derive median / low / high from the quotes we actually got — Mercury's
    // own math is unreliable, but the per-quote prices are usually fine.
    const realPrices = parsed.quotes
      .map((q) => q.price_usd_per_unit)
      .filter((p): p is number => typeof p === "number" && p > 0);
    if (realPrices.length > 0) {
      parsed.median_price_usd_per_unit = median(realPrices);
      parsed.low_price_usd_per_unit = Math.min(...realPrices);
      parsed.high_price_usd_per_unit = Math.max(...realPrices);
    } else {
      parsed.median_price_usd_per_unit = null;
      parsed.low_price_usd_per_unit = null;
      parsed.high_price_usd_per_unit = null;
    }

    await this.publishSignal({
      shipmentId,
      signalType: "supplier_price_extracted",
      severity: "info",
      payload: parsed as unknown as Record<string, unknown>,
      confidence: realPrices.length > 0 ? 0.85 : 0.2,
      citations: parsed.citations,
    });

    return parsed;
  }
}
