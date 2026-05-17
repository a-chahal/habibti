import { z } from "zod";
import { Agent } from "../base";
import {
  getShipment,
  getSignalsForShipment,
  getLatestBelief,
  createBelief,
  createAlert,
  listAlerts,
} from "../../db/queries";
import { emit } from "../../events/emitter";
import { cache } from "../../cache";
import type { Message } from "../../llm/openrouter";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SignalRow {
  id: string;
  agent_name: string;
  signal_type: string;
  severity: string;
  payload: unknown;
  citations?: unknown;
  occurred_at: Date;
  recorded_at?: Date;
}

export interface BeliefRow {
  id: string;
  version: number;
  current_eta: Date | null;
  risk_level: string;
  narrative: string | null;
  created_at: Date;
}

export interface ShipmentContext {
  hs_code: string | null;
  origin_country: string | null;
  destination_port: string | null;
  expected_eta: string | null;
  intent: unknown;
}

export interface SynthesizerInput {
  shipmentId: string;
  newSignals: SignalRow[];
  priorBelief: BeliefRow | null;
  shipmentContext: ShipmentContext;
  recentAlerts?: Array<{ alert_type: string; headline: string; created_at: Date }>;
  latestVesselPosition?: {
    lat: number; lon: number; speed_knots?: number;
    on_schedule: boolean; schedule_deviation?: number;
  } | null;
  /** Cache key for pre-loaded demo output, e.g. "demo:suez:eta_shift" */
  demoKey?: string;
  /** Skip DB writes and event emits — for test harness use */
  skipDbWrites?: boolean;
}

// ─── Zod Schema ──────────────────────────────────────────────────────────────

export const SynthesizerOutput = z.object({
  new_signals_summary: z.array(z.object({
    signal_id: z.string(),
    one_sentence_summary: z.string().max(200),
  })).min(1),

  prior_belief_summary: z.object({
    had_prior_belief: z.boolean(),
    prior_eta: z.string().nullable(),
    prior_risk_level: z.enum(["low", "medium", "high", "critical"]).nullable(),
  }),

  materiality_assessment: z.object({
    is_material: z.boolean(),
    rationale: z.string().max(300),
  }),

  causal_chain: z.array(z.object({
    step_number: z.number(),
    signal_id_cited: z.string(),
    implication: z.string().max(200),
    impact_on_belief: z.string().max(200),
  })).max(6),

  new_belief: z.object({
    current_eta: z.string().nullable(),
    risk_level: z.enum(["low", "medium", "high", "critical"]),
    narrative: z.string().min(50).max(800),
    supporting_signal_ids: z.array(z.string()).min(1),
    confidence_note: z.string().max(200),
  }).nullable(),

  alert_decision: z.object({
    should_alert: z.boolean(),
    threshold_triggered: z.enum([
      "eta_shift_24h",
      "risk_escalation",
      "critical_signal",
      "compliance_addition",
      "none",
    ]),
  }),

  alert: z.object({
    alert_type: z.enum(["eta_shift", "risk_escalation", "compliance_issue", "route_disruption"]),
    headline: z.string().max(80),
    impact_summary_lines: z.array(z.string().max(120)).min(2).max(4),
    draft_email: z.object({
      subject_line: z.string().max(80),
      body: z.string().min(40).max(600),
    }),
  }).nullable(),
});

export type SynthesizerOutput = z.infer<typeof SynthesizerOutput>;

// ─── Prompt builders ─────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `## SECTION A — ROLE

You are a senior trade analyst writing for Sarah, a small business importer. Your job is to read new signals about an in-transit shipment and decide whether they materially change the shipment's belief state. If they do, you produce a structured analytical update with exact citations. Your reasoning is precise and your language is plain. You never hedge unless the evidence genuinely conflicts. You write as if Sarah is depending on you to tell her exactly what is happening and what it means for her shipment, right now.

You follow the output schema in order, step by step. Every field must be filled. You cannot skip a step.

---

## SECTION B — OUTPUT SCHEMA

Return a single JSON object matching this schema exactly:

\`\`\`typescript
{
  // STEP 1 — List every new signal. Do not skip any.
  new_signals_summary: Array<{
    signal_id: string;            // exact ID from input
    one_sentence_summary: string; // max 200 chars, factual
  }>;                             // min 1

  // STEP 2 — State the prior belief.
  prior_belief_summary: {
    had_prior_belief: boolean;
    prior_eta: string | null;     // ISO date e.g. "2024-07-08"
    prior_risk_level: "low" | "medium" | "high" | "critical" | null;
  };

  // STEP 3 — Decide materiality.
  materiality_assessment: {
    is_material: boolean;
    rationale: string;            // max 300 chars
  };

  // STEP 4 — Causal chain. MUST be [] if is_material is false.
  causal_chain: Array<{
    step_number: number;
    signal_id_cited: string;      // REQUIRED — exact ID from new_signals_summary
    implication: string;          // max 200 chars
    impact_on_belief: string;     // max 200 chars
  }>;                             // max 6; [] when is_material=false

  // STEP 5 — Updated belief. MUST be null if is_material is false.
  new_belief: {
    current_eta: string | null;
    risk_level: "low" | "medium" | "high" | "critical";
    narrative: string;            // min 50, max 800 chars — cite every claim as [signal_id]
    supporting_signal_ids: string[];  // min 1
    confidence_note: string;      // max 200 chars
  } | null;

  // STEP 6 — Alert decision.
  alert_decision: {
    should_alert: boolean;
    threshold_triggered: "eta_shift_24h" | "risk_escalation" | "critical_signal" | "compliance_addition" | "none";
  };

  // STEP 7 — Alert content. MUST be null if should_alert is false.
  alert: {
    alert_type: "eta_shift" | "risk_escalation" | "compliance_issue" | "route_disruption";
    headline: string;             // max 80 chars
    impact_summary_lines: string[];  // min 2, max 4, each max 120 chars
    draft_email: {
      subject_line: string;       // max 80 chars
      body: string;               // min 40, max 600 chars
    };
  } | null;
}
\`\`\`

---

## SECTION C — POSITIVE EXAMPLES

### Example 1 — Routine signal, no change

Input:
\`\`\`
Shipment: HS 5208.11, Vietnam → Los Angeles, ETA July 8
Prior belief: ETA July 8, risk low

Signal 1 (sig-a1b2-vessel-pos): vessel_position, info
  Vessel OOCL CALIFORNIA, 23.4°N 139.1°E, speed 17.2 kt (expected 17–18), on route
\`\`\`

Ideal output:
\`\`\`json
{
  "new_signals_summary": [
    {"signal_id": "sig-a1b2-vessel-pos", "one_sentence_summary": "Vessel OOCL CALIFORNIA at 23.4°N 139.1°E, speed 17.2 knots, on expected course to Los Angeles."}
  ],
  "prior_belief_summary": {"had_prior_belief": true, "prior_eta": "2024-07-08", "prior_risk_level": "low"},
  "materiality_assessment": {"is_material": false, "rationale": "Vessel is on expected course at expected speed. Position update confirms prior ETA remains valid. No deviation to analyze."},
  "causal_chain": [],
  "new_belief": null,
  "alert_decision": {"should_alert": false, "threshold_triggered": "none"},
  "alert": null
}
\`\`\`

### Example 2 — Suez Canal congestion (single material event)

Input:
\`\`\`
Shipment: HS 5208.11, Vietnam → Los Angeles (via Suez), ETA July 8
Prior belief: ETA July 8, risk low

Signal 1 (sig-c3d4-suez-gdelt): gdelt_news, high
  Suez Canal Authority announces 5–7 day vessel queuing delays due to congestion, effective immediately
\`\`\`

Ideal output:
\`\`\`json
{
  "new_signals_summary": [
    {"signal_id": "sig-c3d4-suez-gdelt", "one_sentence_summary": "Suez Canal Authority announced 5–7 day vessel queuing delays due to congestion, affecting all traffic effective immediately."}
  ],
  "prior_belief_summary": {"had_prior_belief": true, "prior_eta": "2024-07-08", "prior_risk_level": "low"},
  "materiality_assessment": {"is_material": true, "rationale": "Suez Canal congestion directly affects this shipment's transit route. A 5–7 day delay shifts ETA to July 13–15, well above the 24-hour materiality threshold."},
  "causal_chain": [
    {"step_number": 1, "signal_id_cited": "sig-c3d4-suez-gdelt", "implication": "Suez Canal Authority declared 5–7 day queuing delays affecting all vessels in transit.", "impact_on_belief": "ETA shifts from July 8 to approximately July 14 using the 6-day midpoint of the official range."},
    {"step_number": 2, "signal_id_cited": "sig-c3d4-suez-gdelt", "implication": "Congestion-driven delays are dynamic and may worsen before improving.", "impact_on_belief": "Risk escalates from low to medium; single-source confidence is noted."}
  ],
  "new_belief": {
    "current_eta": "2024-07-14",
    "risk_level": "medium",
    "narrative": "The shipment's ETA has shifted from July 8 to July 14. The Suez Canal Authority announced 5–7 day vessel queuing delays due to congestion [sig-c3d4-suez-gdelt]. This shipment transits the canal, so the delay applies directly. Risk escalates to medium: congestion delays are unpredictable in duration, and no clearance window has been issued [sig-c3d4-suez-gdelt]. The July 14 estimate is based on the 6-day midpoint of the official 5–7 day range.",
    "supporting_signal_ids": ["sig-c3d4-suez-gdelt"],
    "confidence_note": "Single GDELT source. Using 6-day midpoint of official 5–7 day range. Estimate narrows if additional sources confirm or Canal Authority issues an updated timeline."
  },
  "alert_decision": {"should_alert": true, "threshold_triggered": "eta_shift_24h"},
  "alert": {
    "alert_type": "eta_shift",
    "headline": "Suez Canal congestion delays your shipment approximately 6 days",
    "impact_summary_lines": [
      "New estimated arrival: July 14 (was July 8)",
      "Cause: Suez Canal Authority declared 5–7 day queuing delays due to vessel congestion",
      "Risk elevated to medium — delays may extend before the canal clears"
    ],
    "draft_email": {
      "subject_line": "Update on your order: shipment delayed approximately 6 days",
      "body": "Your shipment has been delayed. The Suez Canal Authority announced 5–7 day queuing delays due to vessel congestion, which directly affects your route. Your new estimated arrival date is July 14 (previously July 8). I am tracking the canal situation closely and will update you if the timeline shifts further. Thanks for your patience."
    }
  }
}
\`\`\`

### Example 3 — Compounding events (Suez + LA port congestion)

Input:
\`\`\`
Shipment: HS 5208.11, Vietnam → Los Angeles (via Suez), ETA July 8
Prior belief: ETA July 8, risk low

Signal 1 (sig-c3d4-suez-gdelt): gdelt_news, high
  Suez Canal congestion, 5–7 day delays

Signal 2 (sig-e5f6-la-port): port_congestion, medium
  Los Angeles anchorage: 47 vessels waiting, +2 days dwell above 30-day average
\`\`\`

Ideal output:
\`\`\`json
{
  "new_signals_summary": [
    {"signal_id": "sig-c3d4-suez-gdelt", "one_sentence_summary": "Suez Canal Authority announced 5–7 day vessel queuing delays due to congestion."},
    {"signal_id": "sig-e5f6-la-port", "one_sentence_summary": "Los Angeles port anchorage shows 47 vessels waiting, adding approximately 2 days of dwell time above the 30-day average."}
  ],
  "prior_belief_summary": {"had_prior_belief": true, "prior_eta": "2024-07-08", "prior_risk_level": "low"},
  "materiality_assessment": {"is_material": true, "rationale": "Two independent delays compound sequentially: Suez adds 5–7 days, LA port adds 2 days. Combined shift is 7–9 days, far above the 24-hour threshold."},
  "causal_chain": [
    {"step_number": 1, "signal_id_cited": "sig-c3d4-suez-gdelt", "implication": "Suez Canal congestion delays the vessel's transit by approximately 6 days (midpoint of 5–7 day official range).", "impact_on_belief": "ETA shifts from July 8 to July 14."},
    {"step_number": 2, "signal_id_cited": "sig-e5f6-la-port", "implication": "Los Angeles port anchorage backlog adds approximately 2 days of dwell time on arrival.", "impact_on_belief": "ETA extends further from July 14 to July 16."},
    {"step_number": 3, "signal_id_cited": "sig-c3d4-suez-gdelt", "implication": "Both delays are ongoing with uncertain resolution; they are independent so they compound rather than overlap.", "impact_on_belief": "Risk escalates to high — two concurrent disruptions with no confirmed clearance windows."}
  ],
  "new_belief": {
    "current_eta": "2024-07-16",
    "risk_level": "high",
    "narrative": "Two simultaneous disruptions have pushed the ETA from July 8 to July 16. The Suez Canal Authority declared 5–7 day queuing delays [sig-c3d4-suez-gdelt]. Los Angeles port is showing a 2-day anchorage backlog with 47 vessels waiting [sig-e5f6-la-port]. The delays apply sequentially: the vessel transits the canal first, then faces the port queue. Risk is now high: two independent disruptions are compounding, and neither has a confirmed resolution window [sig-c3d4-suez-gdelt] [sig-e5f6-la-port].",
    "supporting_signal_ids": ["sig-c3d4-suez-gdelt", "sig-e5f6-la-port"],
    "confidence_note": "Suez estimate uses 6-day midpoint of 5–7 day official range. LA dwell based on current AIS queue depth versus 30-day average. Both values may shift."
  },
  "alert_decision": {"should_alert": true, "threshold_triggered": "eta_shift_24h"},
  "alert": {
    "alert_type": "eta_shift",
    "headline": "Two delays compounding: shipment now arriving July 16",
    "impact_summary_lines": [
      "New estimated arrival: July 16 (was July 8) — 8 days later than planned",
      "Delay 1: Suez Canal congestion, 5–7 day queuing (source: Suez Canal Authority)",
      "Delay 2: Los Angeles port backlog, 2-day anchorage wait on arrival",
      "Risk elevated to high — both delays ongoing with no confirmed resolution"
    ],
    "draft_email": {
      "subject_line": "Update on your order: two delays push arrival to July 16",
      "body": "Your shipment is now expected to arrive July 16, eight days later than planned. Two separate issues are compounding: the Suez Canal has announced 5–7 days of vessel queuing, and Los Angeles port currently has a 2-day anchorage backlog. I am monitoring both situations and will update you as they develop. Thanks for your patience."
    }
  }
}
\`\`\`

---

## SECTION D — REJECTED OUTPUTS (DO NOT WRITE LIKE THESE)

### REJECTED OUTPUT 1 — Vague, hedged narrative

narrative field: "It appears that there may be a potential delay impacting your shipment due to ongoing developments in the Suez Canal region. The situation is evolving and we are continuing to monitor. At this time it is difficult to assess the full extent of the impact."

WHY REJECTED: No specific date. No citation. "Appears," "may," "potential," "difficult to assess" are forbidden hedges. Sarah cannot make a business decision from this sentence.

### REJECTED OUTPUT 2 — Marketing tone in email body

email body: "Hi Sarah! Just wanted to give you a quick heads-up that we're navigating some exciting global shipping dynamics right now. Our team is working tirelessly to keep your amazing order on track! Rest assured we're monitoring things closely."

WHY REJECTED: No revised date. No specific cause. No concrete impact. "Exciting dynamics" and "amazing order" are inappropriate when a real shipment is delayed. Sarah still does not know when her fabric arrives after reading this.

---

## SECTION E — EMAIL BODY VOICE GUIDE

The email body is exactly five sentences in this order. Total under 600 characters.

1. SITUATION: One sentence stating what happened. No softening. Start with the subject.
   GOOD: "Your shipment has been delayed."
   BAD: "I wanted to reach out regarding a potential issue with your recent order."

2. CAUSE: Name the specific event with its real-world cause. Plain language, no jargon.
   GOOD: "The Suez Canal Authority announced 5–7 day queuing delays due to vessel congestion, which directly affects your route."
   BAD: "Due to macroeconomic headwinds in the MENA region affecting maritime corridors..."

3. REVISED DATE: State the specific new date. Include the original for comparison.
   GOOD: "Your new estimated arrival date is July 14 (previously July 8)."
   BAD: "We expect this may add approximately 6 days to your current timeline."

4. ACTION: What is being done. First person, specific.
   GOOD: "I am tracking the canal situation closely and will update you if the timeline shifts."
   BAD: "We will continue monitoring and proactively communicate developments."

5. CLOSE: One sentence, brief.
   GOOD: "Thanks for your patience."
   BAD: "We sincerely apologize for any inconvenience this delay may cause to your business operations."

---

## SECTION F — CITATION RULES

1. Every factual claim in the narrative ends with [signal_id] — the exact ID from new_signals_summary.
2. The signal_id must match exactly. No abbreviations. No invented IDs.
3. If a claim cannot be directly cited, frame it as inference: "This is consistent with prior Suez disruptions, though we have one source so far."
4. The signal_id_cited in each causal_chain step must exactly match a signal_id in new_signals_summary.
5. Validation fails if narrative cites an ID not present in supporting_signal_ids.

---

## SECTION G — COMPLIANCE AND SANCTIONS RULES

### G1 — Confirmed sanctions match → critical
If a sanctions_addition signal names the same company as the shipment's supplier (identical or near-identical name, same sector), set risk_level "critical", threshold_triggered "compliance_addition", alert_type "compliance_issue". ETA becomes null — clearance is blocked.

### G2 — Name-prefix near-miss → always material, medium risk
If a sanctions_addition signal names an entity sharing a distinctive 2–3-word prefix with the shipment's supplier — even if the sector differs — the signal is ALWAYS MATERIAL. In Chinese corporate naming the first words identify the conglomerate family. "Anhui Hengyi Chemical" and "Anhui Hengyi Textiles" may share a parent despite being different businesses.

Required for a near-miss:
- is_material: true
- risk_level: "medium" (unconfirmed link — not critical)
- should_alert: true, threshold_triggered: "compliance_addition"
- alert_type: "compliance_issue"
- Narrative: state the shared prefix, the sector difference, that corporate linkage is unconfirmed, and that verification is required before next customs filing
- Email: recommend the importer contact their customs broker to verify no ownership link exists

DO NOT dismiss a near-miss as non-material because sectors differ. DO NOT escalate to critical without confirmed linkage.

### G3 — Positive signals can de-escalate risk
If new signals confirm a prior disruption is resolved or the vessel recovered schedule, risk de-escalation is appropriate. Set is_material: true, write a new belief with lower risk and revised (earlier) ETA. Do not preserve a high risk level when evidence supports improvement.

### G4 — No duplicate alerts within 6 hours
Do NOT set should_alert: true if an alert of the same alert_type was already issued within the past 6 hours AND the ETA has not shifted by more than 24 hours since that alert. You will be given a list of recent alerts to check. A second Suez alert is redundant unless the ETA changed materially. When in doubt, update the belief narrative without triggering a new alert.`;
}

function buildUserPrompt(input: SynthesizerInput): string {
  const { shipmentId, newSignals, priorBelief, shipmentContext } = input;

  const lines: string[] = [];

  lines.push("=== SHIPMENT CONTEXT ===");
  lines.push(`Shipment ID: ${shipmentId}`);
  lines.push(`HS Code: ${shipmentContext.hs_code ?? "unknown"}`);
  lines.push(`Origin: ${shipmentContext.origin_country ?? "unknown"}`);
  lines.push(`Destination port: ${shipmentContext.destination_port ?? "unknown"}`);
  lines.push(`Expected ETA: ${shipmentContext.expected_eta ?? "unknown"}`);
  if (shipmentContext.intent) {
    const intent = shipmentContext.intent as Record<string, unknown>;
    if (intent.product_description) lines.push(`Product: ${intent.product_description}`);
    if (intent.quantity) lines.push(`Quantity: ${intent.quantity} ${intent.quantity_unit ?? ""}`);
    if (intent.budget_usd) lines.push(`Budget: $${intent.budget_usd}`);
    if (intent.supplier) lines.push(`Supplier: ${intent.supplier}`);
    if (intent.route_notes) lines.push(`Route: ${intent.route_notes}`);
  }

  lines.push("\n=== PRIOR BELIEF ===");
  if (priorBelief) {
    lines.push(`Had prior belief: true`);
    lines.push(`Prior ETA: ${priorBelief.current_eta ? priorBelief.current_eta.toISOString().split("T")[0] : "unknown"}`);
    lines.push(`Prior risk level: ${priorBelief.risk_level}`);
    if (priorBelief.narrative) lines.push(`Prior narrative: ${priorBelief.narrative.slice(0, 300)}...`);
  } else {
    lines.push(`Had prior belief: false`);
    lines.push(`Prior ETA: null`);
    lines.push(`Prior risk level: null`);
  }

  lines.push(`\n=== NEW SIGNALS (${newSignals.length} in this batch) ===`);
  for (let i = 0; i < newSignals.length; i++) {
    const s = newSignals[i];
    lines.push(`\nSignal ${i + 1}:`);
    lines.push(`- ID: ${s.id}`);
    lines.push(`- Agent: ${s.agent_name}`);
    lines.push(`- Type: ${s.signal_type}`);
    lines.push(`- Severity: ${s.severity}`);
    lines.push(`- Occurred at: ${s.occurred_at.toISOString()}`);
    lines.push(`- Payload: ${JSON.stringify(s.payload ?? {})}`);
    if (s.citations && Array.isArray(s.citations) && (s.citations as unknown[]).length > 0) {
      lines.push(`- Citations: ${JSON.stringify(s.citations)}`);
    }
  }

  // Pass recent alerts so LLM can apply Rule G4
  if (input.recentAlerts && input.recentAlerts.length > 0) {
    lines.push("\n=== RECENT ALERTS (last 5, for Rule G4 dedup check) ===");
    for (const a of input.recentAlerts) {
      lines.push(`  [${a.alert_type}] ${a.headline} — issued ${a.created_at.toISOString()}`);
    }
  }

  // Include latest vessel position for spatial grounding
  if (input.latestVesselPosition) {
    const vp = input.latestVesselPosition;
    lines.push(`\n=== LATEST VESSEL POSITION ===`);
    lines.push(`  Position: ${vp.lat}°, ${vp.lon}°, speed=${vp.speed_knots ?? "?"}kt, on_schedule=${vp.on_schedule}`);
    if (!vp.on_schedule) lines.push(`  ⚠ Vessel is OFF SCHEDULE (deviation: ${vp.schedule_deviation ?? "?"})`);
  }

  lines.push("\n=== TASK ===");
  lines.push("Work through Steps 1–7 of the output schema in order. Return valid JSON only.");
  lines.push("CRITICAL RULES:");
  lines.push("- causal_chain MUST be [] when is_material is false");
  lines.push("- new_belief MUST be null when is_material is false");
  lines.push("- alert MUST be null when should_alert is false");
  lines.push("- Every claim in narrative MUST include [signal_id] citation using exact IDs from new_signals_summary");
  lines.push("- signal_id_cited in each causal_chain step MUST exactly match an ID from new_signals_summary");
  lines.push("- Rule G4: Do NOT alert if same alert_type was issued in the past 6h unless ETA shifted >24h");

  return lines.join("\n");
}

// ─── Citation self-check ─────────────────────────────────────────────────────

function validateCitations(output: SynthesizerOutput): string | null {
  const knownIds = new Set(output.new_signals_summary.map((s) => s.signal_id));

  // Check causal_chain signal_id_cited
  for (const step of output.causal_chain) {
    if (!knownIds.has(step.signal_id_cited)) {
      return `causal_chain step ${step.step_number} cites unknown signal_id "${step.signal_id_cited}". Valid IDs: ${[...knownIds].join(", ")}`;
    }
  }

  // Check supporting_signal_ids
  if (output.new_belief) {
    for (const id of output.new_belief.supporting_signal_ids) {
      if (!knownIds.has(id)) {
        return `supporting_signal_ids contains unknown signal_id "${id}". Valid IDs: ${[...knownIds].join(", ")}`;
      }
    }

    // Check inline citations in narrative — find [some-id] patterns
    const narrative = output.new_belief.narrative;
    const cited = [...narrative.matchAll(/\[([^\]]{4,})\]/g)].map((m) => m[1]);
    for (const id of cited) {
      if (!knownIds.has(id)) {
        return `Narrative cites unknown signal_id "[${id}]". Valid IDs: ${[...knownIds].join(", ")}`;
      }
    }
  }

  return null;
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export class SynthesizerAgent extends Agent {
  readonly name = "synthesizer";
  readonly tier = "mercury" as const;

  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastSynthesisAt = new Map<string, Date>();

  /** Wire up SIGNAL_NEW subscription with 30-second trailing debounce per shipment */
  startListening() {
    this.subscribe(["SIGNAL_NEW"], (payload) => {
      const { shipmentId } = payload;
      if (!shipmentId) return;

      const existing = this.debounceTimers.get(shipmentId);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        this.debounceTimers.delete(shipmentId);
        this.synthesizeForShipment(shipmentId).catch((err) =>
          console.error(`[synthesizer] error synthesizing ${shipmentId}:`, err)
        );
      }, 30000); // 30s trailing debounce — waits for burst to settle

      this.debounceTimers.set(shipmentId, timer);
    });

    console.log("[synthesizer] listening on SIGNAL_NEW (3s debounce per shipment)");
  }

  private async synthesizeForShipment(shipmentId: string) {
    // Bound the multi-DB read at 5s so a stalled query can't hang the synthesizer.
    const dbReads = Promise.all([
      getShipment(shipmentId),
      getSignalsForShipment(shipmentId),
      getLatestBelief(shipmentId),
      listAlerts(shipmentId),
    ]);
    let shipment: Awaited<ReturnType<typeof getShipment>>;
    let allSignals: Awaited<ReturnType<typeof getSignalsForShipment>>;
    let priorBelief: Awaited<ReturnType<typeof getLatestBelief>>;
    let recentAlertsRaw: Awaited<ReturnType<typeof listAlerts>>;
    try {
      [shipment, allSignals, priorBelief, recentAlertsRaw] = await Promise.race([
        dbReads,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("synthesizer DB read timed out after 5s")), 5000)
        ),
      ]);
    } catch (err: any) {
      console.error(`[synthesizer] DB timeout for ${shipmentId}:`, err.message);
      return;
    }

    if (!shipment) return;

    // Only process signals recorded after the last belief
    const cutoff = priorBelief?.created_at ?? new Date(0);
    const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
    const allNewSignals = allSignals
      .filter((s) => {
        const recordedAt = (s as unknown as { recorded_at: Date }).recorded_at ?? s.occurred_at;
        return recordedAt > cutoff;
      })
      .sort((a, b) => {
        // Severity-prioritized retention: critical/high signals never evicted by routine pings
        const sevDiff = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
        if (sevDiff !== 0) return sevDiff;
        const aAt = ((a as unknown as { recorded_at: Date }).recorded_at ?? a.occurred_at).getTime();
        const bAt = ((b as unknown as { recorded_at: Date }).recorded_at ?? b.occurred_at).getTime();
        return bAt - aAt;
      });
    const newSignals = allNewSignals.slice(0, 5);

    if (newSignals.length === 0) return;

    // Track so we don't double-synthesize on burst events
    const lastAt = this.lastSynthesisAt.get(shipmentId);
    if (lastAt && Date.now() - lastAt.getTime() < 2000) return;
    this.lastSynthesisAt.set(shipmentId, new Date());

    const shipmentContext: ShipmentContext = {
      hs_code: shipment.hs_code,
      origin_country: shipment.origin_country,
      destination_port: shipment.destination_port,
      expected_eta: shipment.expected_eta?.toISOString() ?? null,
      intent: shipment.intent,
    };

    // Extract latest vessel position from new signals
    const latestVesselSig = newSignals.find(s => s.signal_type === "vessel_position");
    const latestVesselPosition = latestVesselSig
      ? (latestVesselSig.payload as any)
      : null;

    // Recent alerts for Rule G4
    const recentAlerts = recentAlertsRaw
      .slice(0, 5)
      .map(a => ({ alert_type: a.alert_type, headline: a.headline, created_at: a.created_at }));

    await this.process({
      shipmentId,
      newSignals: newSignals as unknown as SignalRow[],
      priorBelief: priorBelief as unknown as BeliefRow | null,
      shipmentContext,
      recentAlerts,
      latestVesselPosition,
    });
  }

  async process(rawInput: unknown): Promise<SynthesizerOutput | null> {
    const input = rawInput as SynthesizerInput;
    const { shipmentId, newSignals, priorBelief, shipmentContext, demoKey, skipDbWrites } = input;

    if (newSignals.length === 0) return null;

    // Check demo cache
    if (demoKey) {
      const cached = await cache.get<SynthesizerOutput>(demoKey);
      if (cached) {
        console.log(`[synthesizer] returning cached demo output for ${demoKey}`);
        return cached;
      }
    }

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(input);

    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    // Call LLM with error-feedback retry
    const output = await this.callLLMWithErrorFeedback(messages, { maxTokens: 4000 });
    if (!output) {
      console.error(`[synthesizer] synthesis failed for ${shipmentId} — skipping`);
      return null;
    }

    // Citation self-check
    const citationError = validateCitations(output);
    if (citationError) {
      console.warn(`[synthesizer] citation error: ${citationError} — retrying`);
      const fixMessages: Message[] = [
        ...messages,
        { role: "assistant", content: JSON.stringify(output) },
        {
          role: "user",
          content: `Your output failed citation validation: ${citationError}. Fix the signal_id references so they exactly match the IDs from new_signals_summary. Re-emit valid JSON.`,
        },
      ];
      const fixedRaw = await this.callLLM(fixMessages, { json: true, maxTokens: 4000 });
      let fixed: SynthesizerOutput | null = null;
      try {
        fixed = SynthesizerOutput.parse(JSON.parse(fixedRaw));
        const fixedCitationError = validateCitations(fixed);
        if (fixedCitationError) {
          console.error(`[synthesizer] citation still invalid after retry: ${fixedCitationError} — dropping synthesis`);
          return null; // Hard-fail: citation errors mean the output cannot be trusted
        } else {
          return await this.persistAndEmit(fixed, input);
        }
      } catch {
        console.error(`[synthesizer] could not parse fixed output`);
      }
    }

    return await this.persistAndEmit(output, input);
  }

  private async callLLMWithErrorFeedback(
    messages: Message[],
    opts: { maxTokens?: number }
  ): Promise<SynthesizerOutput | null> {
    const raw = await this.callLLM(messages, { json: true, maxTokens: opts.maxTokens });

    try {
      const parsed = SynthesizerOutput.parse(JSON.parse(raw));
      return parsed;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[synthesizer] parse failed, retrying with error feedback: ${errorMsg.slice(0, 200)}`);

      const retryMessages: Message[] = [
        ...messages,
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `Your previous output failed validation: ${errorMsg.slice(0, 400)}. Re-emit a valid JSON object that matches the schema exactly. Pay attention to: (1) causal_chain must be [] when is_material is false; (2) new_belief must be null when is_material is false; (3) alert must be null when should_alert is false; (4) all signal_id_cited values must exactly match IDs from new_signals_summary.`,
        },
      ];

      const retry = await this.callLLM(retryMessages, { json: true, maxTokens: opts.maxTokens });
      try {
        return SynthesizerOutput.parse(JSON.parse(retry));
      } catch (err2) {
        console.error(`[synthesizer] validation failed after retry:`, err2);
        return null;
      }
    }
  }

  private async persistAndEmit(
    output: SynthesizerOutput,
    input: SynthesizerInput
  ): Promise<SynthesizerOutput> {
    const { shipmentId, priorBelief, skipDbWrites } = input;

    if (skipDbWrites) return output;
    if (!output.materiality_assessment.is_material || !output.new_belief) return output;

    // Rule G4 code-level enforcement: suppress duplicate alerts within 6h unless ETA shifted >24h
    let mutableOutput = output;
    if (mutableOutput.alert_decision.should_alert && mutableOutput.alert && input.recentAlerts?.length) {
      const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000);
      const recentSameType = input.recentAlerts.filter(
        (a) => a.alert_type === mutableOutput.alert?.alert_type && a.created_at > sixHoursAgo
      );
      if (recentSameType.length > 0) {
        const priorEta = priorBelief?.current_eta;
        const newEtaStr = mutableOutput.new_belief?.current_eta;
        const newEta = newEtaStr ? new Date(newEtaStr) : null;
        const etaShiftHours = priorEta && newEta
          ? Math.abs(newEta.getTime() - priorEta.getTime()) / 3600000
          : 0;
        if (etaShiftHours < 24) {
          console.log(`[synthesizer] Rule G4: suppressing ${mutableOutput.alert.alert_type} alert for ${shipmentId} — same type within 6h, ETA shift ${etaShiftHours.toFixed(1)}h < 24h`);
          mutableOutput = {
            ...mutableOutput,
            alert_decision: { ...mutableOutput.alert_decision, should_alert: false, threshold_triggered: "none" },
            alert: null,
          };
        }
      }
    }

    const nextVersion = (priorBelief?.version ?? 0) + 1;
    const etaDate = mutableOutput.new_belief!.current_eta
      ? new Date(mutableOutput.new_belief!.current_eta)
      : null;

    const belief = await createBelief({
      shipment_id: shipmentId,
      version: nextVersion,
      current_eta: etaDate,
      risk_level: mutableOutput.new_belief!.risk_level,
      narrative: mutableOutput.new_belief!.narrative,
      supporting_signal_ids: mutableOutput.new_belief!.supporting_signal_ids,
    });

    emit("BELIEF_UPDATED", {
      beliefId: belief.id,
      shipmentId,
      riskLevel: mutableOutput.new_belief!.risk_level,
      version: nextVersion,
    });

    if (mutableOutput.alert_decision.should_alert && mutableOutput.alert) {
      const alertRecord = await createAlert({
        shipment_id: shipmentId,
        belief_id: belief.id,
        alert_type: mutableOutput.alert.alert_type,
        headline: mutableOutput.alert.headline,
        full_narrative: mutableOutput.new_belief!.narrative,
        draft_email: JSON.stringify(mutableOutput.alert.draft_email),
      });

      emit("ALERT_CREATED", {
        alertId: alertRecord.id,
        shipmentId,
        alertType: mutableOutput.alert.alert_type,
        headline: mutableOutput.alert.headline,
      });
    }

    return mutableOutput;
  }
}
