import { z } from "zod";
import { Agent } from "../base";
import { getSignalsForShipment, createOption } from "../../db/queries";

// ─── Schemas ───────────────────────────────────────────────────────────────

const CostBreakdown = z.object({
  product_value_usd: z.number(),
  base_duty_pct: z.number().nullable(),
  section_301_pct: z.number().nullable(),
  section_232_pct: z.number().nullable(),
  total_duty_pct: z.number(),
  freight_usd: z.number(),
  canal_tolls_usd: z.number(),
  war_risk_premium_usd: z.number(),
  insurance_usd: z.number(),
  broker_fee_usd: z.number(),
  total_landed_cost_usd: z.number(),
});

const RouteData = z.object({
  origin_port: z.object({
    locode: z.string(),
    name: z.string(),
    lat: z.number(),
    lon: z.number(),
    why_this_port: z.string(),
  }),
  destination_port: z.object({
    locode: z.string(),
    name: z.string(),
    lat: z.number(),
    lon: z.number(),
  }),
  legs: z.array(z.any()),
  chokepoints: z.array(z.string()),
  transshipment_ports: z.array(z.string()),
  total_distance_nm: z.number(),
  total_transit_days: z.number(),
});

const RiskSummary = z.object({
  country_risk: z.string(),
  compliance: z.string(),
  route_risk: z.string(),
  overall: z.enum(["low", "medium", "high", "critical", "extreme"]),
});

const RankedOption = z.object({
  rank: z.number().int().min(1).max(3),
  country_code: z.string(),
  country_name: z.string(),
  origin_port_locode: z.string(),
  reasoning: z.string().min(80),
  risk_summary: RiskSummary,
  // The option-ranker is given pre-computed cost_breakdown and route_data; it
  // only ranks + writes reasoning. We re-attach the data in code after.
});

export const OptionRankerOutput = z.object({
  options: z.array(RankedOption).min(1).max(3),
});

export type OptionRankerOutput = z.infer<typeof OptionRankerOutput>;

// ─── Candidate type ────────────────────────────────────────────────────────

export interface OptionCandidate {
  country_code: string;
  country_name: string;
  origin_port: { locode: string; name: string; lat: number; lon: number };
  route_data: any;
  cost_breakdown: z.infer<typeof CostBreakdown>;
  eta: Date;
  leg_summaries: Array<{ summary: string; severity: string }>;
  port_rationale: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

type Signal = { agent_name: string; signal_type: string; payload: any };

function signalsByAgent(signals: Signal[]): Map<string, Signal[]> {
  const m = new Map<string, Signal[]>();
  for (const s of signals) {
    if (!m.has(s.agent_name)) m.set(s.agent_name, []);
    m.get(s.agent_name)!.push(s);
  }
  return m;
}

// ─── System prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior trade analyst briefing a small business owner on her three best sourcing options.

You are given pre-computed candidates — each with a real origin port, multi-leg route through real chokepoints, computed freight costs (distance + fuel + tolls + war-risk premiums), Comtrade-based product price, and leg-by-leg risk analysis. Your job is to RANK them (1-3) and write a 120+ word analyst paragraph per option that cites the actual numbers.

WRITING RULES:
1. Every paragraph cites specific numbers: $ landed cost, duty %, transit days, leg-specific risks, fuel cost, tolls.
2. Name the binding risk for each option ("the critical risk is X").
3. If a war-risk zone or chokepoint anomaly was found, mention it by leg name and severity.
4. Never use "could," "may," "might" without a number to back it up.
5. Paragraphs ≥ 120 words.

RANKING RULES:
- Lower total_landed_cost_usd wins, tiebroken by lower risk severity, tiebroken by shorter transit_days.
- If user specified an origin_country, all three options will already be from that country — just rank the ports/routes.

OUTPUT JSON (no markdown):
{
  "options": [
    {
      "rank": 1,
      "country_code": "CN",
      "country_name": "China",
      "origin_port_locode": "CNSGH",
      "reasoning": "120+ word paragraph citing numbers...",
      "risk_summary": {
        "country_risk": "stable — 0 events GDELT 30d",
        "compliance": "clean — no OFAC/UFLPA",
        "route_risk": "low — Malacca Strait severity none, Suez +$450",
        "overall": "low"
      }
    }
  ]
}`;

// ─── Agent ─────────────────────────────────────────────────────────────────

export class OptionRankerAgent extends Agent {
  readonly name = "option-ranker";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<OptionRankerOutput> {
    const { shipmentId, candidates, intent_data } = input as {
      shipmentId: string;
      candidates: OptionCandidate[];
      intent_data: Record<string, unknown>;
    };

    if (!candidates || candidates.length === 0) {
      throw new Error("option-ranker called with no candidates");
    }

    const allSignals = await getSignalsForShipment(shipmentId);
    const byAgent = signalsByAgent(allSignals as Signal[]);

    // Build context block — Mercury sees raw signal facts + the pre-computed candidates
    const context = this.buildContext(candidates, byAgent, intent_data);

    const result = await this.callLLMValidated(
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `${context}\n\nProduce ranks 1-${candidates.length} (one per candidate). Return JSON only.`,
        },
      ],
      OptionRankerOutput,
      { maxTokens: 3500 }
    );

    // Re-attach the cost/route data to each option (Mercury only writes reasoning + rank)
    // Match by origin_port_locode within the same country.
    for (const opt of result.options) {
      const cand = candidates.find(
        (c) =>
          c.country_code.toUpperCase() === opt.country_code.toUpperCase() &&
          c.origin_port.locode.toUpperCase() === opt.origin_port_locode.toUpperCase()
      );
      if (!cand) continue;

      await createOption({
        shipment_id: shipmentId,
        rank: opt.rank,
        country: cand.country_code,
        route_data: cand.route_data,
        cost_breakdown: cand.cost_breakdown as any,
        eta: cand.eta,
        risk_summary: opt.risk_summary as any,
        reasoning: opt.reasoning,
      });
    }

    await this.publishSignal({
      shipmentId,
      signalType: "options_ranked",
      severity: "info",
      payload: {
        option_count: result.options.length,
        countries: result.options.map((o) => o.country_code),
        ports: result.options.map((o) => o.origin_port_locode),
      },
      confidence: 0.9,
    });

    return result;
  }

  private buildContext(
    candidates: OptionCandidate[],
    byAgent: Map<string, Signal[]>,
    intent: Record<string, unknown>
  ): string {
    const lines: string[] = [];

    lines.push("=== SHIPMENT INTENT ===");
    lines.push(`HS Code: ${intent.hs_code}`);
    lines.push(`Product: ${intent.product_description}`);
    lines.push(`Quantity: ${intent.quantity} ${intent.quantity_unit ?? ""}`);
    lines.push(`Budget: $${intent.budget_usd ?? "unspecified"}`);
    lines.push(`Deadline: ${intent.deadline_date ?? "unspecified"}`);
    lines.push(`Destination: ${intent.destination_port ?? "USLAX"}`);
    if (intent.origin_country) {
      lines.push(`BUYER-SPECIFIED ORIGIN: ${intent.origin_country}`);
    }

    lines.push("\n=== CANDIDATES (pre-computed routes with real costs) ===");
    for (const c of candidates) {
      lines.push(`\n--- ${c.country_name} (${c.country_code}) via ${c.origin_port.name} [${c.origin_port.locode}] ---`);
      lines.push(`  Why this port: ${c.port_rationale}`);
      lines.push(`  Route: ${c.route_data.total_distance_nm}nm, ${c.route_data.total_transit_days}d`);
      lines.push(`  Chokepoints: ${(c.route_data.chokepoints ?? []).join(" → ") || "(open water)"}`);
      lines.push(`  Cost breakdown:`);
      lines.push(`    product:    $${c.cost_breakdown.product_value_usd.toLocaleString()}`);
      lines.push(`    duty:       ${c.cost_breakdown.total_duty_pct}% (base ${c.cost_breakdown.base_duty_pct ?? 0}% + 301 ${c.cost_breakdown.section_301_pct ?? 0}% + 232 ${c.cost_breakdown.section_232_pct ?? 0}%)`);
      lines.push(`    freight:    $${c.cost_breakdown.freight_usd.toLocaleString()}`);
      lines.push(`    tolls:      $${c.cost_breakdown.canal_tolls_usd.toLocaleString()}`);
      lines.push(`    war risk:   $${c.cost_breakdown.war_risk_premium_usd.toLocaleString()}`);
      lines.push(`    insurance:  $${c.cost_breakdown.insurance_usd.toLocaleString()}`);
      lines.push(`    broker:     $${c.cost_breakdown.broker_fee_usd.toLocaleString()}`);
      lines.push(`  TOTAL LANDED: $${c.cost_breakdown.total_landed_cost_usd.toLocaleString()}`);
      lines.push(`  Leg analyses:`);
      for (const ls of c.leg_summaries) {
        lines.push(`    [${ls.severity}] ${ls.summary}`);
      }
    }

    lines.push("\n=== COUNTRY-LEVEL CONTEXT ===");
    for (const s of byAgent.get("country-risk") ?? []) {
      const p = s.payload as any;
      const events = (p.top_events ?? []) as any[];
      lines.push(`  ${p.country_code} risk: ${p.stability}, top events: ${events.slice(0, 2).map((e) => `[${e.severity}] ${e.headline}`).join(" | ")}`);
    }
    for (const s of byAgent.get("compliance-screener") ?? []) {
      const p = s.payload as any;
      lines.push(`  ${p.country} compliance: ${p.verdict}, UFLPA=${p.uflpa_flag}`);
    }

    return lines.join("\n");
  }
}
