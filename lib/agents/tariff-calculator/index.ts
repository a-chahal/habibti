import { z } from "zod";
import { Agent } from "../base";
import { fetchFederalRegisterUSTR } from "../../sources/ustr";
import { cache } from "../../cache";

// Freight estimates per lane in USD per container
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
};

const DEFAULT_FREIGHT = 5000;

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
  citations: z.array(z.string()),
});

export type TariffOutput = z.infer<typeof TariffOutput>;

export class TariffCalculatorAgent extends Agent {
  readonly name = "tariff-calculator";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<TariffOutput> {
    const { hs_code, origin_country, product_value_usd = 0, shipmentId } = input as {
      hs_code: string;
      origin_country: string;
      product_value_usd?: number;
      shipmentId?: string;
    };

    const cacheKey = `tariff:${hs_code}:${origin_country}`;
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

    // Fetch recent USTR Federal Register docs for tariff context
    let frContext = "";
    try {
      const docs = await fetchFederalRegisterUSTR(5);
      frContext = docs
        .map((d) => `- ${d.title} (${d.publication_date}): ${d.abstract ?? ""}`)
        .join("\n");
    } catch {
      frContext = "Federal Register unavailable";
    }

    const freight = FREIGHT_LANES[origin_country.toUpperCase()] ?? DEFAULT_FREIGHT;
    const insurance = +(product_value_usd * 0.012).toFixed(2);
    const brokerFee = 250;

    const systemPrompt = `You are a US customs tariff expert. Given an HS code and origin country, calculate import duties.

Return JSON with these fields (all numbers, use null if a tariff type doesn't apply):
- hs_code: string
- origin_country: string (ISO2)
- product_value_usd: number
- base_duty_pct: MFN base rate (number or null)
- section_301_pct: Section 301 tariff if origin is China (number or null for non-China)
- section_232_pct: Section 232 tariff for steel/aluminum chapters 72/73/76 (number or null)
- section_122_pct: Section 122 surcharge if applicable (number or null)
- total_duty_pct: sum of all applicable rates
- freight_estimate_usd: ${freight} (fixed from lane table)
- insurance_usd: ${insurance} (1.2% of product value)
- broker_fee_usd: ${brokerFee} (flat)
- total_landed_cost_usd: product_value_usd + (product_value_usd * total_duty_pct/100) + freight + insurance + broker_fee
- citations: array of strings (cite USTR/HTS sources)

Key rates to apply:
- HS 52xx (cotton fabrics): base ~7.5–9%, Section 301 List 4A adds 7.5% for China
- HS 61xx/62xx (apparel): base ~12–32%
- HS 84xx/85xx (machinery/electronics): base 0%, Section 301 adds 25% for China
- HS 09xx (spices/coffee): base 0%
- HS 72xx/73xx (steel): base 0–3%, Section 232 adds 25% if origin is CN/EU/TR
- HS 76xx (aluminum): Section 232 adds 10%
- Section 301 applies ONLY to China (CN)
- Section 232 applies to China, EU, and a few others for metals chapters

Recent USTR Federal Register context:
${frContext}`;

    const result = await this.callLLMValidated(
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Calculate tariffs for HS ${hs_code} imported from ${origin_country}. Product value: $${product_value_usd}. Freight: $${freight}. Insurance: $${insurance}. Broker: $${brokerFee}.`,
        },
      ],
      TariffOutput
    );

    await cache.set(cacheKey, result as unknown as object, 6 * 60 * 60); // 6h cache

    await this.publishSignal({
      shipmentId,
      signalType: "tariff_calculation",
      severity: result.total_duty_pct > 25 ? "high" : result.total_duty_pct > 10 ? "medium" : "low",
      payload: result as unknown as Record<string, unknown>,
      confidence: 0.85,
    });

    return result;
  }

  private recomputeLanded(
    base: TariffOutput,
    productValue: number
  ): { total_landed_cost_usd: number; insurance_usd: number } {
    const insurance = +(productValue * 0.012).toFixed(2);
    const dutyAmount = productValue * (base.total_duty_pct / 100);
    const total = productValue + dutyAmount + base.freight_estimate_usd + insurance + base.broker_fee_usd;
    return { total_landed_cost_usd: +total.toFixed(2), insurance_usd: insurance };
  }
}
