import { z } from "zod";
import { Agent } from "../base";
import { getSignalsForShipment, createOption, upsertSupplier } from "../../db/queries";

// ─── Zod schema for Opus output ──────────────────────────────────────────────

const CostBreakdown = z.object({
  product_value_usd: z.number().nullable().default(0),
  base_duty_pct: z.number().nullable(),
  section_301_pct: z.number().nullable(),
  section_232_pct: z.number().nullable(),
  total_duty_pct: z.number().nullable().default(0),
  freight_usd: z.number().nullable().default(0),
  insurance_usd: z.number().nullable().default(0),
  broker_fee_usd: z.number().nullable().default(250),
  total_landed_cost_usd: z.number().nullable().default(0),
});

const RouteData = z.object({
  lane_name: z.string(),
  chokepoints: z.array(z.string()),
  traffic_density: z.string(),
  weather_outlook: z.string(),
  chokepoint_risks: z.array(
    z.object({ name: z.string(), severity: z.string(), summary: z.string() })
  ).optional(),
});

const RiskSummary = z.object({
  country_risk: z.string(),
  compliance: z.string(),
  route_risk: z.string(),
  overall: z.string().transform((v) => {
    const s = v.toLowerCase();
    if (s.includes("high") || s.includes("critical")) return "high";
    if (s.includes("medium") || s.includes("moderate")) return "medium";
    return "low";
  }),
});

const RankedOption = z.object({
  rank: z.number().int().min(1).max(3),
  country_code: z.string(),
  country_name: z.string(),
  supplier_name: z.string().nullable(),
  transit_days: z.number(),
  route_data: RouteData,
  cost_breakdown: CostBreakdown,
  risk_summary: RiskSummary,
  reasoning: z.string().min(10),
});

export const OptionRankerOutput = z.object({
  options: z.array(RankedOption).length(3),
});

export type OptionRankerOutput = z.infer<typeof OptionRankerOutput>;

// ─── Context builder ─────────────────────────────────────────────────────────

type Signal = { agent_name: string; signal_type: string; payload: unknown };

function buildContext(signals: Signal[], intent: Record<string, unknown>): string {
  const byAgent = new Map<string, Signal[]>();
  for (const s of signals) {
    if (!byAgent.has(s.agent_name)) byAgent.set(s.agent_name, []);
    byAgent.get(s.agent_name)!.push(s);
  }

  const p = (s: Signal) => (s.payload ?? {}) as Record<string, unknown>;
  const lines: string[] = [];

  const today = new Date();
  const deadline = intent.deadline_date ? new Date(String(intent.deadline_date)) : null;

  lines.push("=== SHIPMENT INTENT ===");
  lines.push(`HS Code: ${intent.hs_code}`);
  lines.push(`Product: ${intent.product_description}`);
  lines.push(`Quantity: ${intent.quantity} ${intent.quantity_unit ?? ""}`);
  lines.push(`Budget: $${intent.budget_usd ?? "unspecified"}`);
  lines.push(`Product value (est): $${intent.product_value_usd ?? "unspecified"} (budget / 1.25 heuristic)`);
  lines.push(`Deadline: ${intent.deadline_date ?? "unspecified"}`);
  lines.push(`Destination port: ${intent.destination_port ?? "USLAX"}`);
  if (intent.supplier) lines.push(`Buyer-specified supplier: ${intent.supplier}`);
  if (intent.origin_country) lines.push(`BUYER-SPECIFIED ORIGIN: ${intent.origin_country} — MUST be ranked #1 unless hard-disqualified by compliance`);

  lines.push("\n=== CANDIDATE COUNTRIES ===");
  for (const s of byAgent.get("country-discoverer") ?? []) {
    const candidates = (p(s).candidates as any[]) ?? [];
    for (const c of candidates) {
      lines.push(
        `  ${c.country_code} (${c.country_name}): US imports $${Number(c.us_import_volume_usd).toLocaleString()}, trend=${c.trend}, established_lane=${c.lane_established}`
      );
    }
  }

  lines.push("\n=== TARIFF CALCULATIONS ===");
  for (const s of byAgent.get("tariff-calculator") ?? []) {
    const q = p(s);
    lines.push(
      `  ${q.origin_country}: base=${q.base_duty_pct ?? 0}%, 301=${q.section_301_pct ?? "N/A"}%, 232=${q.section_232_pct ?? "N/A"}%, total=${q.total_duty_pct}%, freight=$${q.freight_estimate_usd}, landed=$${q.total_landed_cost_usd}`
    );
  }

  lines.push("\n=== COMPLIANCE SCREENING ===");
  for (const s of byAgent.get("compliance-screener") ?? []) {
    const q = p(s);
    const matches = (q.matches as any[]) ?? [];
    lines.push(
      `  ${q.country}: verdict=${q.verdict}, UFLPA_flag=${q.uflpa_flag}, confirmed_matches=${matches.length}`
    );
    if (matches.length > 0) {
      lines.push(`    Matches: ${matches.map((m: any) => m.entity_name).join(", ")}`);
    }
  }

  lines.push("\n=== SUPPLIER VERIFICATION ===");
  for (const s of byAgent.get("supplier-verifier") ?? []) {
    const q = p(s);
    const candidates = (q.match_candidates as any[]) ?? [];
    const top = candidates[0];
    lines.push(
      `  ${q.country}: registry=${q.registry_source}, limited_data=${q.limited_data}`
    );
    if (top) {
      lines.push(
        `    Best match: "${top.name}" conf=${top.match_confidence?.toFixed(2)}, status=${top.status}, incorporated=${top.incorporation_date ?? "unknown"}`
      );
    } else {
      lines.push(`    No registry matches found`);
    }
  }

  lines.push("\n=== COUNTRY RISK ===");
  for (const s of byAgent.get("country-risk") ?? []) {
    const q = p(s);
    const events = (q.top_events as any[]) ?? [];
    const cats = q.event_count_by_category as Record<string, number> | undefined;
    const totalEvents = cats ? Object.values(cats).reduce((a, b) => a + b, 0) : 0;
    lines.push(`  ${q.country_code}: stability=${q.stability}, total_events=${totalEvents}`);
    for (const ev of events.slice(0, 3)) {
      lines.push(`    [${ev.severity}] ${ev.date}: ${ev.headline} (relevance=${ev.relevance_score?.toFixed(2)})`);
    }
  }

  lines.push("\n=== ROUTE ASSESSMENTS ===");
  for (const s of byAgent.get("route-prescorer") ?? []) {
    const q = p(s);
    const routes = (q.routes as any[]) ?? [];
    const route = routes[0];
    if (!route) continue;
    lines.push(
      `  ${q.origin_country}→${q.destination_port}: "${route.lane_name}", ${route.typical_transit_days}d, density=${route.current_traffic_density}, weather="${route.weather_outlook}"`
    );
    if (q.transit_buffer_days !== undefined && q.transit_buffer_days !== null) {
      lines.push(`    Transit buffer: ${q.transit_buffer_days} days${(q.transit_buffer_days as number) < 5 ? " ⚠ TIGHT" : ""}`);
    }
    for (const cp of route.chokepoint_risks ?? []) {
      if (cp.severity !== "none") {
        lines.push(`    ⚠ ${cp.name} [${cp.severity}]: ${(cp.current_events ?? "").slice(0, 100)}`);
      }
    }
  }

  // Pre-compute derived delivery estimates so LLM does not need to do date math
  lines.push("\n=== DERIVED DELIVERY ESTIMATES (use these, do not recalculate) ===");
  for (const s of byAgent.get("route-prescorer") ?? []) {
    const q = p(s);
    const routes = (q.routes as any[]) ?? [];
    const route = routes[0];
    if (!route) continue;
    const transitDays = route.typical_transit_days as number;
    const eta = new Date(today.getTime() + transitDays * 86400000);
    const bufferDays = deadline ? Math.round((deadline.getTime() - eta.getTime()) / 86400000) : null;
    lines.push(
      `  ${q.origin_country}: transit=${transitDays}d, estimated_arrival=${eta.toISOString().slice(0, 10)}` +
      (bufferDays !== null ? `, deadline_buffer=${bufferDays}d${bufferDays < 0 ? " ⚠ MISSES DEADLINE" : ""}` : "")
    );
  }

  // Include signal confidence so LLM can discount low-confidence sources
  lines.push("\n=== SIGNAL CONFIDENCE NOTES ===");
  const lowConfidenceSignals = signals.filter(s => {
    const conf = (s as any).confidence;
    return conf !== undefined && conf !== null && Number(conf) < 0.5;
  });
  for (const s of lowConfidenceSignals) {
    lines.push(`  ${s.agent_name} (${s.signal_type}): confidence=${Number((s as any).confidence).toFixed(2)} — low confidence, treat as indicative only`);
  }

  return lines.join("\n");
}

// ─── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior trade analyst briefing a small business owner (Sarah) on her three best sourcing options.

ANALYST WRITING RULES — strictly enforced:
1. Every claim cites a specific number from the data ($ landed cost, duty %, transit days, confidence score, event count, relevance score).
2. Name the specific risk and why it matters for THIS shipment's deadline and budget.
3. State the option's biggest weakness honestly. Use "the critical risk" or "the main constraint."
4. Never use "could," "may," "might," "appears to," or "seems" without a qualifying data point.
5. Each reasoning paragraph must be at least 120 words.

GOOD EXAMPLE 1 — model this voice exactly:
"Vietnam earns rank #1 because it delivers the lowest total landed cost ($28,400) against a $30,000 budget with zero Section 301 exposure. The tariff analysis shows a 12.9% total duty rate — $7,500 less than the China equivalent. Country-risk returned 'stable' with zero port disruption events in 30 days (GDELT, 30-day window). The GLEIF registry returned a partial match at confidence 0.61 — lower than ideal — but the Malacca Strait showed 'none' severity in chokepoint screening. Route: 16 days trans-Pacific puts estimated arrival July 9, leaving 6 days of schedule buffer before the July 15 deadline. The critical risk: GLEIF's limited data for Vietnamese mills means supplier verification requires a pre-shipment inspection before funds are committed."

GOOD EXAMPLE 2 — model this voice exactly:
"India ranks #2 because it offers the strongest supplier verification in this analysis: the GLEIF match returned confidence 0.94 — an active LEI since 2010 confirms the entity is real and registered. Compliance screening returned 'clean' with zero OFAC or UFLPA matches. Landed cost is $31,200 — $1,200 over Sarah's $30,000 budget — but the 25% Section 301 avoidance (vs. China) saves $6,250 on larger orders, making India more cost-competitive at scale. Country-risk shows 'watch' stability: one Tamil Nadu labor event (relevance score 0.38 — minor, no port impact). The critical risk: 28 days via Suez puts estimated arrival at July 13, leaving only 2 days of deadline buffer. If the Bab-el-Mandeb situation (currently 'medium' severity) adds 3+ days, delivery fails."

DO NOT WRITE LIKE THIS — this will be rejected:
"This option offers a balanced combination of cost efficiency and supply chain reliability. The supplier appears to have adequate capabilities and the country has a generally stable environment. Transit times are within acceptable ranges. There may be some considerations around tariffs. Overall this represents a viable option."

FILTERING RULES (apply before ranking):
- Discard any country where compliance-screener verdict = "flagged" AND uflpa_flag = true. Hard disqualification.
- Prefer countries where compliance verdict = "clean."
- The 3 options must be from 3 different country_codes.
- If the intent includes a BUYER-SPECIFIED ORIGIN, that country_code MUST be rank 1 unless it is hard-disqualified. No exceptions.

OUTPUT JSON schema (return exactly this, no markdown):
{
  "options": [
    {
      "rank": 1,
      "country_code": "VN",
      "country_name": "Vietnam",
      "supplier_name": "Vietnam Textile Corp or null if no registry match",
      "transit_days": 16,
      "route_data": {
        "lane_name": "Trans-Pacific (Vietnam → Los Angeles)",
        "chokepoints": ["Malacca Strait"],
        "traffic_density": "medium",
        "weather_outlook": "Calm (avg wave 1.2m)",
        "chokepoint_risks": [{ "name": "Malacca Strait", "severity": "none", "summary": "No active disruptions" }]
      },
      "cost_breakdown": {
        "product_value_usd": 25000,
        "base_duty_pct": 9.0,
        "section_301_pct": null,
        "section_232_pct": null,
        "total_duty_pct": 9.0,
        "freight_usd": 4500,
        "insurance_usd": 300,
        "broker_fee_usd": 250,
        "total_landed_cost_usd": 28325
      },
      "risk_summary": {
        "country_risk": "stable — 0 port events, GDELT 30-day clean",
        "compliance": "clean — no OFAC/UFLPA matches",
        "route_risk": "low — Malacca severity: none",
        "overall": "low"
      },
      "reasoning": "120+ word analyst paragraph citing specific signal data..."
    }
  ]
}`;

// ─── Agent ───────────────────────────────────────────────────────────────────

export class OptionRankerAgent extends Agent {
  readonly name = "option-ranker";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<OptionRankerOutput> {
    const { shipmentId, intent_data } = input as {
      shipmentId: string;
      intent_data?: Record<string, unknown>;
    };

    const allSignals = await getSignalsForShipment(shipmentId);
    // Exclude orchestrator meta-signals
    const sourcingSignals = allSignals.filter(
      (s) => s.agent_name !== "orchestrator"
    );

    const intent = intent_data ?? {};
    const context = buildContext(sourcingSignals as Signal[], intent);

    const rawResult = await this.callLLMValidated(
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Here is the complete sourcing intelligence for this shipment:\n\n${context}\n\nProduce exactly 3 ranked options from 3 different countries. Apply filtering rules. Return only JSON.`,
        },
      ],
      OptionRankerOutput,
      { maxTokens: 4000 }
    );

    // Hard-enforce: preferred origin must be rank 1 in code (LLM may slip)
    const preferredCountry = (intent.origin_country as string | undefined)?.toUpperCase();
    let options = rawResult.options;
    if (preferredCountry) {
      const idx = options.findIndex(o => o.country_code.toUpperCase() === preferredCountry);
      if (idx > 0) {
        const [preferred] = options.splice(idx, 1);
        options = [preferred, ...options];
        options.forEach((o, i) => { (o as any).rank = i + 1; });
        console.log(`[option-ranker] hard-enforced ${preferredCountry} to rank 1 (LLM had it at rank ${idx + 1})`);
      }
    }
    const result = { ...rawResult, options };

    // Write each option to the options table
    const today = new Date();
    for (const opt of result.options) {
      // Upsert supplier record only for real supplier names (not synthetic placeholders)
      const isSyntheticSupplier = !opt.supplier_name || /\bsupplier\b/i.test(opt.supplier_name);
      let supplierId: string | null = null;
      if (!isSyntheticSupplier) {
        try {
          const supplier = await upsertSupplier({
            name: opt.supplier_name!,
            country: opt.country_code,
            registry_source: "option-ranker",
            verification_status: "unverified",
          });
          supplierId = supplier.id;
        } catch {
          // non-fatal — supplier_id stays null
        }
      }

      const eta = new Date(today.getTime() + opt.transit_days * 24 * 60 * 60 * 1000);

      await createOption({
        shipment_id: shipmentId,
        rank: opt.rank,
        country: opt.country_code,
        supplier_id: supplierId ?? undefined,
        route_data: opt.route_data as any,
        cost_breakdown: opt.cost_breakdown as any,
        eta,
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
        top_landed_cost: result.options[0]?.cost_breakdown.total_landed_cost_usd,
      },
      confidence: 0.9,
    });

    return result;
  }
}
