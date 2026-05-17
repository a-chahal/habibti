import { z } from "zod";
import { Agent } from "../base";
import { fetchFederalRegisterUSTR } from "../../sources/ustr";
import { cache } from "../../cache";

// Freight estimates per lane in USD per FCL (40ft container)
const FREIGHT_LANES: Record<string, number> = {
  VN: 4500,
  ID: 4800,
  CN: 4200,
  IN: 5200,
  MX: 1800,
  BD: 5500,
  TR: 3800,
  PK: 5600,
  TH: 4600,
  KH: 4700,
  MY: 4400,
  LK: 5300,
  TW: 4300,
  KR: 4300,
  JP: 4200,
  DE: 3500,
  BR: 3900,
  EG: 4900,
  MA: 4100,
  ET: 5800,
};

// Adjustments per destination (USLAX = base, others add cost)
const DESTINATION_SURCHARGE: Record<string, number> = {
  USLAX: 0,
  USLGB: 0,
  USNYC: 400,
  USHOU: 200,
  USSAV: 500,
  USSEA: -200,
};

const DEFAULT_FREIGHT = 5000;

// Insurance rate by HS chapter
function insuranceRate(hsCode: string): number {
  const chapter = parseInt(hsCode.slice(0, 2), 10);
  if (chapter === 85 || chapter === 84) return 0.004; // electronics
  if ((chapter >= 28 && chapter <= 38) || chapter === 85) return 0.025; // hazardous/chemicals
  if (chapter >= 50 && chapter <= 63) return 0.012; // textiles
  if (chapter >= 1 && chapter <= 24) return 0.010; // food/ag
  return 0.012; // default
}

// Rough CBM per unit for LCL decision — extremely rough heuristic by unit type
function estimateCBMPerUnit(quantityUnit: string | null | undefined): number {
  const u = (quantityUnit ?? "").toLowerCase();
  if (u.includes("yard") || u.includes("metre") || u.includes("meter")) return 0.003; // fabric
  if (u.includes("kg") || u.includes("mt") || u.includes("ton")) return 0.001;
  if (u.includes("unit") || u.includes("pc") || u.includes("piece")) return 0.05;
  return 0.01;
}

export const TariffOutput = z.object({
  hs_code: z.string(),
  origin_country: z.string(),
  product_value_usd: z.number(),
  base_duty_pct: z.number().nullable(),
  section_301_pct: z.number().nullable(),
  section_232_pct: z.number().nullable(),
  section_122_pct: z.number().nullable(),
  total_duty_pct: z.number(),
  freight_estimate_usd: z.number(),
  insurance_usd: z.number(),
  broker_fee_usd: z.number(),
  total_landed_cost_usd: z.number(),
  shipment_mode: z.enum(["FCL", "LCL"]).optional(),
  citations: z.array(z.string()),
});

export type TariffOutput = z.infer<typeof TariffOutput>;

export class TariffCalculatorAgent extends Agent {
  readonly name = "tariff-calculator";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<TariffOutput> {
    const {
      hs_code,
      origin_country,
      product_value_usd = 0,
      quantity,
      quantity_unit,
      destination_port,
      product_description,
      shipmentId,
    } = input as {
      hs_code: string;
      origin_country: string;
      product_value_usd?: number;
      quantity?: number | null;
      quantity_unit?: string | null;
      destination_port?: string | null;
      product_description?: string | null;
      shipmentId?: string;
    };

    const cacheKey = `tariff:${hs_code}:${origin_country}:${destination_port ?? "USLAX"}`;
    const cached = await cache.get<TariffOutput>(cacheKey);
    if (cached) {
      await this.publishSignal({
        shipmentId,
        signalType: "tariff_calculation",
        severity: "info",
        payload: { ...cached, product_value_usd } as unknown as Record<string, unknown>,
        confidence: 0.9,
      });
      return { ...cached, product_value_usd, ...this.recomputeLanded(cached, product_value_usd) };
    }

    // Fetch recent USTR Federal Register docs, filtered by HS chapter
    const hsChapterPrefix = hs_code.slice(0, 2);
    let frContext = "";
    try {
      const docs = await fetchFederalRegisterUSTR(5);
      const relevant = docs.filter((d) => {
        const text = (d.title + " " + (d.abstract ?? "")).toLowerCase();
        return text.includes(`hs ${hsChapterPrefix}`) || text.includes(`chapter ${hsChapterPrefix}`) ||
          text.includes(hsChapterPrefix) || text.includes("tariff") || text.includes("duty");
      });
      frContext = (relevant.length > 0 ? relevant : docs.slice(0, 3))
        .map((d) => `- ${d.title} (${d.publication_date})`)
        .join("\n");
    } catch {
      frContext = "Federal Register unavailable";
    }

    // Compute freight: FCL vs LCL based on volume estimate
    const baseFCL = (FREIGHT_LANES[origin_country.toUpperCase()] ?? DEFAULT_FREIGHT) +
      (DESTINATION_SURCHARGE[destination_port ?? "USLAX"] ?? 0);
    const cbmPerUnit = estimateCBMPerUnit(quantity_unit);
    const totalCBM = quantity ? quantity * cbmPerUnit : null;
    const FCL_THRESHOLD_CBM = 20;
    const LCL_RATE_PER_CBM = 250;
    let freight: number;
    let shipmentMode: "FCL" | "LCL";
    if (totalCBM !== null && totalCBM < FCL_THRESHOLD_CBM) {
      freight = Math.round(totalCBM * LCL_RATE_PER_CBM);
      shipmentMode = "LCL";
    } else {
      freight = baseFCL;
      shipmentMode = "FCL";
    }

    const insRate = insuranceRate(hs_code);
    const insurance = +(product_value_usd * insRate).toFixed(2);
    const brokerFee = 250;

    const systemPrompt = `You are a US customs tariff expert. Given an HS code and origin country, calculate import duties.

Return JSON with these fields (all numbers, use null if a tariff type doesn't apply):
- hs_code: string
- origin_country: string (ISO2)
- product_value_usd: number
- base_duty_pct: MFN base rate (number or null)
- section_301_pct: Section 301 tariff if origin is China (number or null for non-China)
- section_232_pct: Section 232 tariff for steel/aluminum (chapters 72/73/76) — applies to CN, EU (DE, NL, BE, FR, IT, ES), TR, JP, KR (number or null)
- section_122_pct: Section 122 surcharge if applicable (number or null)
- total_duty_pct: sum of all applicable rates
- freight_estimate_usd: ${freight} (${shipmentMode}, computed from quantity/volume)
- insurance_usd: ${insurance} (${(insRate * 100).toFixed(1)}% of product value — HS chapter ${hsChapterPrefix} rate)
- broker_fee_usd: ${brokerFee} (flat)
- total_landed_cost_usd: product_value_usd + (product_value_usd * total_duty_pct/100) + freight + insurance + broker_fee
- shipment_mode: "${shipmentMode}"
- citations: array of strings (cite USTR/HTS sources)

Key rates to apply:
- HS 52xx (cotton fabrics): base ~7.5–9%, Section 301 List 4A adds 7.5% for China
- HS 61xx/62xx (apparel): base ~12–32%
- HS 84xx/85xx (machinery/electronics): base 0%, Section 301 adds 25% for China
- HS 09xx (spices/coffee): base 0%
- HS 72xx/73xx (steel): base 0–3%, Section 232 adds 25% if CN/EU/TR
- HS 76xx (aluminum): Section 232 adds 10%
- Section 301 applies ONLY to China (CN)
- Section 232 for steel/aluminum applies to: CN, EU countries (DE/NL/BE/FR/IT/ES), TR, BR, IN, KR, JP

${product_description ? `Product context: ${product_description}` : ""}

Recent USTR Federal Register context:
${frContext}`;

    const result = await this.callLLMValidated(
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Calculate tariffs for HS ${hs_code} imported from ${origin_country}${destination_port ? ` to ${destination_port}` : ""}. Product value: $${product_value_usd}. Freight: $${freight} (${shipmentMode}). Insurance: $${insurance}. Broker: $${brokerFee}.${quantity ? ` Quantity: ${quantity} ${quantity_unit ?? "units"}.` : ""}`,
        },
      ],
      TariffOutput
    );

    // Inject computed fields
    const finalResult = { ...result, shipment_mode: shipmentMode };

    await cache.set(cacheKey, finalResult as unknown as object, 6 * 60 * 60);

    await this.publishSignal({
      shipmentId,
      signalType: "tariff_calculation",
      severity: result.total_duty_pct > 25 ? "high" : result.total_duty_pct > 10 ? "medium" : "low",
      payload: finalResult as unknown as Record<string, unknown>,
      confidence: 0.85,
    });

    return finalResult;
  }

  private recomputeLanded(
    base: TariffOutput,
    productValue: number
  ): { total_landed_cost_usd: number; insurance_usd: number } {
    const insRate = insuranceRate(base.hs_code);
    const insurance = +(productValue * insRate).toFixed(2);
    const dutyAmount = productValue * (base.total_duty_pct / 100);
    const total = productValue + dutyAmount + base.freight_estimate_usd + insurance + base.broker_fee_usd;
    return { total_landed_cost_usd: +total.toFixed(2), insurance_usd: insurance };
  }
}
