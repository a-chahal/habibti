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
}

// ─── ISO2 → Comtrade numeric ──────────────────────────────────────────────
const NUMERIC_CODES: Record<string, string> = {
  CN: "156", VN: "704", IN: "356", ID: "360", BD: "50", TR: "792",
  PK: "586", MX: "484", TH: "764", KH: "116", MY: "458", LK: "144",
  ET: "231", TW: "158", KR: "410", JP: "392", DE: "276", BR: "76",
  MG: "450", PE: "604", EG: "818", MA: "504", US: "842", GB: "826",
  NL: "528", BE: "56", IT: "380", ES: "724", FR: "250", ZA: "710",
};

// Unit-conversion table (cargo HS chapter heuristic → kg per typical unit)
function unitToKg(unit: string | undefined, hsChapter: number): number | null {
  if (!unit) return null;
  const u = unit.toLowerCase().trim();
  if (/^kg$|kilogram/.test(u)) return 1;
  if (/^t$|tonne|metric ton/.test(u)) return 1000;
  if (/^lb$|pound/.test(u)) return 0.4536;
  if (/^g$|gram/.test(u)) return 0.001;
  if (/piece|pcs|unit|ea/.test(u)) {
    // typical mass per piece by HS chapter
    if (hsChapter === 85 || hsChapter === 84) return 0.3; // electronics avg
    if (hsChapter >= 50 && hsChapter <= 63) return 0.2; // garment
    if (hsChapter >= 64 && hsChapter <= 67) return 0.5; // shoes
    if (hsChapter === 87) return 1200; // passenger car
    return 0.5;
  }
  return null;
}

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
    } = input as ProductPricerInput;

    const cc = origin_country.toUpperCase();
    const hsChapter = parseInt(hs_code.slice(0, 2), 10);
    const reporterCode = NUMERIC_CODES[cc];

    const cacheKey = `product-pricer:v1:${cc}:${hs_code}`;
    const cached = await cache.get<ProductPriceOutput>(cacheKey);
    if (cached) {
      const total = this.computeTotalValue(cached, quantity, quantity_unit, hsChapter, fallback_budget_usd);
      const out = { ...cached, total_value_usd: total, quantity, quantity_unit };
      await this.publishSignal({
        shipmentId,
        signalType: "product_price",
        severity: "info",
        payload: out as unknown as Record<string, unknown>,
        confidence: cached.confidence,
      });
      return out;
    }

    let unitPricePerKg: number | null = null;
    let period: string | null = null;
    let source = "user_budget_estimate";
    let confidence = 0.3;

    if (reporterCode) {
      try {
        // Most recent fully-reported year — public preview defaults to last 5y
        const lastYear = new Date().getUTCFullYear() - 1;
        const yearsToTry = [lastYear, lastYear - 1, lastYear - 2];
        for (const year of yearsToTry) {
          const res = await queryComtrade({
            reporterCode,
            cmdCode: hs_code.slice(0, 6),
            period: String(year),
            flowCode: "X",
            partnerCode: "842", // US
          });
          // pick the row with primaryValue and netWgt set
          const row = res.data.find((r) => r.primaryValue > 0 && (r.netWgt ?? 0) > 0);
          if (row && row.netWgt) {
            unitPricePerKg = row.primaryValue / row.netWgt;
            period = String(year);
            source = `UN Comtrade ${year} (reporter=${cc}, partner=US, HS ${hs_code.slice(0, 6)})`;
            confidence = 0.8;
            break;
          }
        }
      } catch (err: any) {
        // Comtrade may rate-limit — fall through to budget heuristic
        console.warn(`[product-pricer] Comtrade failed for ${cc}/${hs_code}: ${err.message}`);
      }
    }

    const kgPerUnit = unitToKg(quantity_unit, hsChapter);
    const unitPricePerUnit =
      unitPricePerKg != null && kgPerUnit != null
        ? +(unitPricePerKg * kgPerUnit).toFixed(2)
        : null;

    const result: ProductPriceOutput = {
      hs_code,
      origin_country: cc,
      unit_price_usd_per_kg: unitPricePerKg != null ? +unitPricePerKg.toFixed(4) : null,
      unit_price_usd_per_unit: unitPricePerUnit,
      total_value_usd: 0, // computed below
      quantity,
      quantity_unit,
      confidence,
      source,
      period,
    };
    result.total_value_usd = this.computeTotalValue(result, quantity, quantity_unit, hsChapter, fallback_budget_usd);

    await cache.set(cacheKey, result as unknown as object, 7 * 24 * 60 * 60); // 7 days

    await this.publishSignal({
      shipmentId,
      signalType: "product_price",
      severity: "info",
      payload: result as unknown as Record<string, unknown>,
      confidence: result.confidence,
    });

    return result;
  }

  private computeTotalValue(
    p: ProductPriceOutput,
    quantity: number,
    unit: string,
    hsChapter: number,
    fallbackBudget?: number
  ): number {
    const kgPerUnit = unitToKg(unit, hsChapter);
    if (p.unit_price_usd_per_kg != null && kgPerUnit != null) {
      return Math.round(p.unit_price_usd_per_kg * kgPerUnit * quantity);
    }
    if (p.unit_price_usd_per_unit != null) {
      return Math.round(p.unit_price_usd_per_unit * quantity);
    }
    // Fallback: budget / 1.25 heuristic
    if (fallbackBudget) return Math.round(fallbackBudget / 1.25);
    return 0;
  }
}
