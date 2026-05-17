import { z } from "zod";
import { Agent } from "../base";
import { queryComtrade } from "../../sources/comtrade";
import { cache } from "../../cache";

// ─── Schema ────────────────────────────────────────────────────────────────

export const ProductPriceOutput = z.object({
  hs_code: z.string(),
  origin_country: z.string(),
  unit_price_usd_per_kg: z.number().nullable(),
  unit_price_usd_per_unit: z.number().nullable(),
  total_value_usd: z.number(),
  quantity: z.number(),
  quantity_unit: z.string(),
  confidence: z.number().min(0).max(1),
  source: z.string(),
  period: z.string().nullable(),
});

export type ProductPriceOutput = z.infer<typeof ProductPriceOutput>;

// ─── Input ─────────────────────────────────────────────────────────────────

export interface ProductPricerInput {
  shipmentId?: string;
  hs_code: string;
  origin_country: string; // ISO2
  quantity?: number;
  quantity_unit?: string;
  fallback_budget_usd?: number;
  // NEW: intent-parser's per-product common-knowledge estimates
  intent_unit_weight_kg?: number | null;
  intent_unit_price_usd?: number | null;
  // NEW: supplier-price-extractor median price (per single unit, USD)
  supplier_extracted_unit_price_usd?: number | null;
  supplier_extractor_source?: string | null;
}

// ─── ISO2 → Comtrade numeric ──────────────────────────────────────────────
const NUMERIC_CODES: Record<string, string> = {
  CN: "156", VN: "704", IN: "356", ID: "360", BD: "50", TR: "792",
  PK: "586", MX: "484", TH: "764", KH: "116", MY: "458", LK: "144",
  ET: "231", TW: "158", KR: "410", JP: "392", DE: "276", BR: "76",
  MG: "450", PE: "604", EG: "818", MA: "504", US: "842", GB: "826",
  NL: "528", BE: "56", IT: "380", ES: "724", FR: "250", ZA: "710",
};

// Fallback kg-per-unit by HS chapter — only used when intent-parser couldn't estimate
function fallbackUnitToKg(unit: string | undefined, hsChapter: number): number | null {
  if (!unit) return null;
  const u = unit.toLowerCase().trim();
  if (/^kg$|kilogram/.test(u)) return 1;
  if (/^t$|tonne|metric ton/.test(u)) return 1000;
  if (/^lb$|pound/.test(u)) return 0.4536;
  if (/^g$|gram/.test(u)) return 0.001;
  if (/liter|litre|^l$/.test(u)) return 1; // assume water-density
  if (/piece|pcs|unit|ea/.test(u)) {
    if (hsChapter === 85 || hsChapter === 84) return 0.3;
    if (hsChapter >= 50 && hsChapter <= 63) return 0.2;
    if (hsChapter >= 64 && hsChapter <= 67) return 0.5;
    if (hsChapter === 87) return 1200;
    return 0.5;
  }
  return null;
}

// Resolve kg-per-unit, preferring intent-parser's per-product estimate.
function resolveKgPerUnit(
  intentWeightKg: number | null | undefined,
  unit: string | undefined,
  hsChapter: number
): number | null {
  // For per-mass units (kg/MT/lb), always use the literal conversion — intent estimate is irrelevant
  if (unit) {
    const u = unit.toLowerCase().trim();
    if (/^(kg|kilogram|t|tonne|metric ton|lb|pound|^g$|gram|liter|litre|^l$)/.test(u)) {
      return fallbackUnitToKg(unit, hsChapter);
    }
  }
  // For per-unit units (piece/unit/ea), prefer intent-parser's product-specific estimate
  if (typeof intentWeightKg === "number" && intentWeightKg > 0) return intentWeightKg;
  return fallbackUnitToKg(unit, hsChapter);
}

// Below this total order weight, treat as "small order" and prefer per-unit retail-ish
// pricing over Comtrade wholesale averages.
const SMALL_ORDER_KG_THRESHOLD = 500;

// ─── Agent ─────────────────────────────────────────────────────────────────

export class ProductPricerAgent extends Agent {
  readonly name = "product-pricer";
  readonly tier = "none" as const;

  async process(input: unknown): Promise<ProductPriceOutput> {
    const {
      hs_code,
      origin_country,
      quantity = 1,
      quantity_unit = "unit",
      fallback_budget_usd,
      shipmentId,
      intent_unit_weight_kg,
      intent_unit_price_usd,
      supplier_extracted_unit_price_usd,
      supplier_extractor_source,
    } = input as ProductPricerInput;

    const cc = origin_country.toUpperCase();
    const hsChapter = parseInt(hs_code.slice(0, 2), 10);
    const kgPerUnit = resolveKgPerUnit(intent_unit_weight_kg, quantity_unit, hsChapter);
    const totalOrderKg = kgPerUnit != null ? kgPerUnit * quantity : null;
    const isSmallOrder = totalOrderKg != null && totalOrderKg < SMALL_ORDER_KG_THRESHOLD;

    // ── Priority 1: supplier-extracted price (real listing) ──
    if (typeof supplier_extracted_unit_price_usd === "number" && supplier_extracted_unit_price_usd > 0) {
      const totalValue = Math.round(supplier_extracted_unit_price_usd * quantity);
      const result: ProductPriceOutput = {
        hs_code,
        origin_country: cc,
        unit_price_usd_per_kg: kgPerUnit ? +(supplier_extracted_unit_price_usd / kgPerUnit).toFixed(4) : null,
        unit_price_usd_per_unit: +supplier_extracted_unit_price_usd.toFixed(2),
        total_value_usd: totalValue,
        quantity, quantity_unit,
        confidence: 0.9,
        source: supplier_extractor_source ?? `supplier listings (extracted from ${cc} websites)`,
        period: null,
      };
      await this.publishSignal({
        shipmentId, signalType: "product_price", severity: "info",
        payload: result as unknown as Record<string, unknown>, confidence: 0.9,
      });
      return result;
    }

    // ── Priority 2: small order → use intent-parser's retail-ish per-unit estimate ──
    if (isSmallOrder && typeof intent_unit_price_usd === "number" && intent_unit_price_usd > 0) {
      const totalValue = Math.round(intent_unit_price_usd * quantity);
      const result: ProductPriceOutput = {
        hs_code,
        origin_country: cc,
        unit_price_usd_per_kg: kgPerUnit ? +(intent_unit_price_usd / kgPerUnit).toFixed(4) : null,
        unit_price_usd_per_unit: +intent_unit_price_usd.toFixed(2),
        total_value_usd: totalValue,
        quantity, quantity_unit,
        confidence: 0.6,
        source: `intent-parser unit-price estimate (small order, ~${Math.round(totalOrderKg ?? 0)}kg total)`,
        period: null,
      };
      await this.publishSignal({
        shipmentId, signalType: "product_price", severity: "info",
        payload: result as unknown as Record<string, unknown>, confidence: 0.6,
      });
      return result;
    }

    // ── Priority 3: Comtrade wholesale $/kg × intent weight × quantity (bulk orders) ──
    const reporterCode = NUMERIC_CODES[cc];
    const cacheKey = `product-pricer:v2:${cc}:${hs_code}`;
    let cached = await cache.get<{ unit_price_usd_per_kg: number; period: string; source: string } | null>(cacheKey);

    if (!cached && reporterCode) {
      try {
        const lastYear = new Date().getUTCFullYear() - 1;
        for (const year of [lastYear, lastYear - 1, lastYear - 2]) {
          const res = await queryComtrade({
            reporterCode, cmdCode: hs_code.slice(0, 6),
            period: String(year), flowCode: "X", partnerCode: "842",
          });
          const row = res.data.find((r) => r.primaryValue > 0 && (r.netWgt ?? 0) > 0);
          if (row && row.netWgt) {
            cached = {
              unit_price_usd_per_kg: row.primaryValue / row.netWgt,
              period: String(year),
              source: `UN Comtrade ${year} (reporter=${cc}, partner=US, HS ${hs_code.slice(0, 6)})`,
            };
            await cache.set(cacheKey, cached, 7 * 24 * 60 * 60);
            break;
          }
        }
      } catch (err: any) {
        console.warn(`[product-pricer] Comtrade failed for ${cc}/${hs_code}: ${err.message}`);
      }
    }

    if (cached && kgPerUnit) {
      const unitPriceUsd = cached.unit_price_usd_per_kg * kgPerUnit;
      const totalValue = Math.round(unitPriceUsd * quantity);
      const result: ProductPriceOutput = {
        hs_code,
        origin_country: cc,
        unit_price_usd_per_kg: +cached.unit_price_usd_per_kg.toFixed(4),
        unit_price_usd_per_unit: +unitPriceUsd.toFixed(2),
        total_value_usd: totalValue,
        quantity, quantity_unit,
        confidence: 0.7,
        source: cached.source + (intent_unit_weight_kg ? ` × ${intent_unit_weight_kg}kg/unit (intent-parser)` : ""),
        period: cached.period,
      };
      await this.publishSignal({
        shipmentId, signalType: "product_price", severity: "info",
        payload: result as unknown as Record<string, unknown>, confidence: 0.7,
      });
      return result;
    }

    // ── Priority 4: intent unit-price estimate even for bulk (when Comtrade missing) ──
    if (typeof intent_unit_price_usd === "number" && intent_unit_price_usd > 0) {
      const totalValue = Math.round(intent_unit_price_usd * quantity);
      const result: ProductPriceOutput = {
        hs_code,
        origin_country: cc,
        unit_price_usd_per_kg: kgPerUnit ? +(intent_unit_price_usd / kgPerUnit).toFixed(4) : null,
        unit_price_usd_per_unit: +intent_unit_price_usd.toFixed(2),
        total_value_usd: totalValue,
        quantity, quantity_unit,
        confidence: 0.4,
        source: `intent-parser unit-price estimate (Comtrade unavailable)`,
        period: null,
      };
      await this.publishSignal({
        shipmentId, signalType: "product_price", severity: "info",
        payload: result as unknown as Record<string, unknown>, confidence: 0.4,
      });
      return result;
    }

    // ── Priority 5: budget heuristic (last resort) ──
    const total = fallback_budget_usd ? Math.round(fallback_budget_usd / 1.25) : 0;
    const result: ProductPriceOutput = {
      hs_code,
      origin_country: cc,
      unit_price_usd_per_kg: null,
      unit_price_usd_per_unit: quantity > 0 ? Math.round(total / quantity) : null,
      total_value_usd: total,
      quantity, quantity_unit,
      confidence: 0.2,
      source: "user_budget_estimate (budget ÷ 1.25)",
      period: null,
    };
    await this.publishSignal({
      shipmentId, signalType: "product_price", severity: "info",
      payload: result as unknown as Record<string, unknown>, confidence: 0.2,
    });
    return result;
  }
}
