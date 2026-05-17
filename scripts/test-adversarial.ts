/**
 * Adversarial Synthesizer Test
 *
 * Three scenarios designed to stress-test the synthesizer's judgment, not just
 * its formatting. Each scenario presents ambiguity, contradiction, or edge-case
 * matching that the system must resolve correctly — without any artificial
 * scaffolding in the signal payloads to steer the answer.
 *
 *   A1 — ETA RECOVERY: bad news followed by good news.
 *        Prior belief is high-risk, ETA already pushed 14 days late.
 *        New signals: port strike resolved + vessel made up 2 days.
 *        Expected: system de-escalates risk and pulls ETA forward.
 *        Failure mode: system ignores positive signals or treats recovery
 *        as non-material because it's not a new disruption.
 *
 *   A2 — NEAR-MISS SUPPLIER: sanctions hit for a similarly-named supplier.
 *        Shipment supplier: "Anhui Hengyi Textiles Co., Ltd."
 *        Sanctioned entity: "Anhui Hengyi Chemical Co., Ltd." (different sector)
 *        Expected: system flags this as a near-miss and recommends verification,
 *        but does NOT escalate to critical. This is not the same company.
 *        Failure mode (both directions):
 *          - False positive: system escalates to critical and blocks shipment
 *          - False negative: system ignores it entirely and writes is_material=false
 *        Correct answer: material=true, risk=medium or high, NOT critical,
 *        alert recommends supplier verification, not immediate blocking.
 *
 *   A3 — THREE MINOR DELAYS, none individually > 24h.
 *        Three separate vessel position updates each implying a 6-hour slip.
 *        Taken individually: none crosses the ETA-shift-24h threshold.
 *        Taken collectively: 18 hours cumulative — still under 24h.
 *        Expected: system correctly assesses cumulative slip as non-material
 *        (18h < 24h threshold), writes new_belief with updated ETA but does
 *        NOT trigger an alert.
 *        Failure mode: system either (a) alerts on the wrong threshold,
 *        or (b) ignores the ETA movement entirely.
 */

import "dotenv/config";
import { SynthesizerAgent, SynthesizerOutput } from "../lib/agents/synthesizer";
import type { SignalRow, BeliefRow, ShipmentContext, SynthesizerInput } from "../lib/agents/synthesizer";

const SHIP_ID = "00000000-0000-0000-0000-adversarial01";

function makeSignal(id: string, signalType: string, severity: string, payload: object): SignalRow {
  return {
    id,
    agent_name: "test",
    signal_type: signalType,
    severity,
    payload,
    occurred_at: new Date(),
    recorded_at: new Date(),
  };
}

function hr(label: string) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${label}`);
  console.log("═".repeat(70));
}

function section(label: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${label}`);
  console.log("─".repeat(60));
}

function check(label: string, ok: boolean) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  return ok;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SHARED CONTEXT: cotton from Vietnam to LA — prior belief already in distress
// ─────────────────────────────────────────────────────────────────────────────

const DISTRESSED_BELIEF: BeliefRow = {
  id: "00000000-0000-0000-0000-belief000002",
  version: 3,
  current_eta: new Date("2024-07-22"),  // already 14 days late from LA port strike
  risk_level: "high",
  narrative: "LA/Long Beach port labor action has created 89-vessel anchorage queue, adding ~4 days on top of a prior Suez Canal disruption. ETA moved from July 8 to July 22. Risk high.",
  created_at: new Date("2024-06-30T08:00:00Z"),
};

const COTTON_LA_CONTEXT: ShipmentContext = {
  hs_code: "5208.11",
  origin_country: "VN",
  destination_port: "USLAX",
  expected_eta: "2024-07-22",
  intent: {
    product_description: "organic cotton fabric",
    quantity: 5000,
    quantity_unit: "yards",
    budget_usd: 30000,
    supplier: "Anhui Hengyi Textiles Co., Ltd.",
    route_notes: "Trans-Pacific routing: Ho Chi Minh City → South China Sea → Pacific → Los Angeles",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  A1 — ETA RECOVERY: good news after a disruption
// ─────────────────────────────────────────────────────────────────────────────

async function runA1(synth: SynthesizerAgent): Promise<boolean> {
  hr("A1 — ETA RECOVERY: strike resolved + vessel ahead of schedule");
  console.log(
    "\n  Prior state: risk=HIGH, ETA=July 22 (14 days late from port strike + Suez).\n" +
    "  New signals: ILWU strike resolved, anchorage clearing; vessel AIS shows\n" +
    "  it made up 2 days running at 19 knots through favorable current.\n" +
    "  The system must recognize positive signals as material and pull ETA forward.\n"
  );

  const input: SynthesizerInput = {
    shipmentId: SHIP_ID,
    newSignals: [
      makeSignal(
        "sig-la-strike-resolved",
        "port-congestion",
        "medium",
        {
          signal_type: "port_status",
          port: "USLAX",
          event: "labor_action_resolved",
          headline: "ILWU Local 13 and PMA reach tentative agreement; work-to-rule ends at 06:00 PST",
          vessel_count: 62,
          baseline: 42,
          ratio: 1.48,
          congested: false,
          note: "Anchorage queue declining. Prior queue of 89 vessels down to 62, still above baseline but clearing rapidly.",
          source_url: "https://gdelt.example.com/event/ilwu-agreement-2024-0701",
        }
      ),
      makeSignal(
        "sig-vessel-pos-ahead",
        "vessel-tracker",
        "info",
        {
          signal_type: "vessel_position",
          vessel: "OOCL CALIFORNIA",
          lat: 32.1,
          lon: -118.4,
          speed_knots: 19.0,
          heading: 95,
          note: "Vessel running 19 kts in favorable current. At this pace, will arrive 2 days ahead of current ETA of July 22.",
          eta_revised: "2024-07-20",
          distance_to_port_nm: 412,
        }
      ),
    ],
    priorBelief: DISTRESSED_BELIEF,
    shipmentContext: COTTON_LA_CONTEXT,
    skipDbWrites: true,
  };

  const output = await synth.process(input);
  if (!output) { console.log("  ERROR: null output"); return false; }

  section("STRUCTURED OUTPUT");
  console.log(JSON.stringify(output, null, 2));

  section("CHECKS");

  let allPass = true;

  // Must be material — positive signals are material when they change ETA or risk
  allPass = check("is_material=true (positive signals change ETA/risk)", output.materiality_assessment.is_material) && allPass;

  // Must produce a new_belief
  allPass = check("new_belief is not null", output.new_belief !== null) && allPass;

  if (output.new_belief) {
    // ETA should move earlier than July 22 (toward July 20)
    const etaDate = output.new_belief.current_eta ? new Date(output.new_belief.current_eta) : null;
    const etaMovedEarlier = etaDate ? etaDate < new Date("2024-07-22") : false;
    allPass = check(
      `ETA pulled forward from July 22 (got: ${output.new_belief.current_eta})`,
      etaMovedEarlier
    ) && allPass;

    // Risk must de-escalate from high — port clearing + vessel on schedule = medium or low
    const riskDeescalated = output.new_belief.risk_level === "medium" || output.new_belief.risk_level === "low";
    allPass = check(
      `Risk de-escalated from high (got: ${output.new_belief.risk_level})`,
      riskDeescalated
    ) && allPass;

    // Narrative must cite both signals
    const citesStrike = output.new_belief.narrative.includes("sig-la-strike-resolved");
    const citesVessel = output.new_belief.narrative.includes("sig-vessel-pos-ahead");
    allPass = check("Narrative cites strike-resolved signal", citesStrike) && allPass;
    allPass = check("Narrative cites vessel-position signal", citesVessel) && allPass;
  }

  // If an alert fires, it should be eta_shift (earlier arrival) or risk_escalation-down,
  // but it's also acceptable NOT to alert on positive news — that's a judgment call.
  // What's NOT acceptable: a compliance_issue or route_disruption alert on good news.
  if (output.alert) {
    const badAlertType = output.alert.alert_type === "compliance_issue" || output.alert.alert_type === "route_disruption";
    allPass = check(
      `Alert type is appropriate for positive news (got: ${output.alert.alert_type})`,
      !badAlertType
    ) && allPass;
  } else {
    check("No alert on good news (acceptable — not a new disruption)", true);
  }

  console.log(`\n  RESULT: ${allPass ? "✅ PASS" : "❌ FAIL"}`);
  return allPass;
}

// ─────────────────────────────────────────────────────────────────────────────
//  A2 — NEAR-MISS SUPPLIER: similar name, different entity
// ─────────────────────────────────────────────────────────────────────────────

async function runA2(synth: SynthesizerAgent): Promise<boolean> {
  hr("A2 — NEAR-MISS SUPPLIER: similarly-named entity added to OFAC SDN");
  console.log(
    "\n  Shipment supplier: Anhui Hengyi Textiles Co., Ltd.\n" +
    "  Sanctioned entity: Anhui Hengyi Chemical Co., Ltd. (chemicals, not textiles)\n" +
    "  Same province and parent-name prefix 'Anhui Hengyi', but different business.\n" +
    "  The system must flag this for verification WITHOUT escalating to critical.\n" +
    "  Either extreme is wrong: silently passing (false negative) or blocking (false positive).\n"
  );

  const STABLE_BELIEF: BeliefRow = {
    id: "00000000-0000-0000-0000-belief000003",
    version: 1,
    current_eta: new Date("2024-07-08"),
    risk_level: "low",
    narrative: "Shipment on track. ETA July 8.",
    created_at: new Date("2024-06-15T00:00:00Z"),
  };

  const input: SynthesizerInput = {
    shipmentId: SHIP_ID,
    newSignals: [
      makeSignal(
        "sig-ofac-hengyi-chem",
        "regulatory-watcher",
        "high",
        {
          signal_type: "sanctions_addition",
          entity_name: "Anhui Hengyi Chemical Co., Ltd.",
          country: "CN",
          dataset: "us_ofac_sdn",
          listing_date: "2024-06-28",
          reason: "Support for PRC military-civil fusion programs; export control violations",
          sector: "chemicals",
        }
      ),
    ],
    priorBelief: STABLE_BELIEF,
    shipmentContext: COTTON_LA_CONTEXT,
    skipDbWrites: true,
  };

  const output = await synth.process(input);
  if (!output) { console.log("  ERROR: null output"); return false; }

  section("STRUCTURED OUTPUT");
  console.log(JSON.stringify(output, null, 2));

  section("CHECKS");

  let allPass = true;

  // Must be material — a near-miss on sanctions is never ignorable
  allPass = check("is_material=true (sanctions near-miss is always material)", output.materiality_assessment.is_material) && allPass;

  // Must NOT escalate to critical — this is not a confirmed match
  if (output.new_belief) {
    const notCritical = output.new_belief.risk_level !== "critical";
    allPass = check(
      `Risk NOT critical for unconfirmed match (got: ${output.new_belief.risk_level})`,
      notCritical
    ) && allPass;

    // Must elevate risk above low — this is not routine
    const elevated = output.new_belief.risk_level === "medium" || output.new_belief.risk_level === "high";
    allPass = check(
      `Risk elevated above low (got: ${output.new_belief.risk_level})`,
      elevated
    ) && allPass;
  } else {
    // No new_belief is also a failure — this IS material
    allPass = check("new_belief is not null (near-miss must update belief)", false) && allPass;
  }

  // Alert should fire — this requires human investigation
  allPass = check("Alert triggered for supplier verification", output.alert_decision.should_alert) && allPass;

  if (output.alert) {
    // Alert type should be compliance_issue, not eta_shift
    const correctType = output.alert.alert_type === "compliance_issue";
    allPass = check(
      `Alert type is compliance_issue (got: ${output.alert.alert_type})`,
      correctType
    ) && allPass;

    // Email must convey uncertainty — "possible", "verify", "similar name" etc.
    const emailBody = output.alert.draft_email.body.toLowerCase();
    const conveysUncertainty =
      emailBody.includes("similar") ||
      emailBody.includes("verify") ||
      emailBody.includes("possible") ||
      emailBody.includes("potential") ||
      emailBody.includes("confirm") ||
      emailBody.includes("review") ||
      emailBody.includes("investigat");
    allPass = check(
      "Email conveys uncertainty (not treating as confirmed block)",
      conveysUncertainty
    ) && allPass;

    // Email must NOT say the shipment is blocked or customs will reject it
    const wronglyCertain =
      emailBody.includes("cannot enter") ||
      emailBody.includes("blocked") ||
      emailBody.includes("prohibited");
    allPass = check(
      "Email does not wrongly treat near-miss as confirmed block",
      !wronglyCertain
    ) && allPass;
  }

  console.log(`\n  RESULT: ${allPass ? "✅ PASS" : "❌ FAIL"}`);
  return allPass;
}

// ─────────────────────────────────────────────────────────────────────────────
//  A3 — THREE MINOR DELAYS: cumulative 18h slip, below 24h alert threshold
// ─────────────────────────────────────────────────────────────────────────────

async function runA3(synth: SynthesizerAgent): Promise<boolean> {
  hr("A3 — SUB-THRESHOLD CUMULATIVE DELAY: three 6-hour slips, 18h total");
  console.log(
    "\n  Prior belief: risk=low, ETA=July 8.\n" +
    "  New signals: three successive vessel position updates, each showing ~6h\n" +
    "  cumulative slip vs. schedule (bad weather slowing transit through Pacific).\n" +
    "  18 hours total — under the 24h alert threshold.\n" +
    "  Expected: system updates ETA to ~July 8 evening or July 9 morning, keeps\n" +
    "  risk low, does NOT trigger an eta_shift_24h alert.\n" +
    "  Failure mode: system either ignores the drift entirely or over-alerts.\n"
  );

  const PRIOR_LOW: BeliefRow = {
    id: "00000000-0000-0000-0000-belief000004",
    version: 1,
    current_eta: new Date("2024-07-08T08:00:00Z"),
    risk_level: "low",
    narrative: "Vessel departed HCMC on June 15. On schedule, ETA July 8 Los Angeles.",
    created_at: new Date("2024-06-15T00:00:00Z"),
  };

  const input: SynthesizerInput = {
    shipmentId: SHIP_ID,
    newSignals: [
      makeSignal(
        "sig-pos-delay-1",
        "vessel-tracker",
        "info",
        {
          signal_type: "vessel_position",
          vessel: "OOCL CALIFORNIA",
          lat: 38.2,
          lon: 179.1,
          speed_knots: 15.8,
          note: "Speed reduced from scheduled 18 kts due to 3m swell. Running ~6h behind schedule as of this position.",
          cumulative_delay_hours: 6,
        }
      ),
      makeSignal(
        "sig-pos-delay-2",
        "vessel-tracker",
        "info",
        {
          signal_type: "vessel_position",
          vessel: "OOCL CALIFORNIA",
          lat: 39.1,
          lon: 165.3,
          speed_knots: 16.1,
          note: "Still in residual swell from North Pacific storm system. Now running ~12h behind schedule vs. departure plan.",
          cumulative_delay_hours: 12,
        }
      ),
      makeSignal(
        "sig-pos-delay-3",
        "vessel-tracker",
        "info",
        {
          signal_type: "vessel_position",
          vessel: "OOCL CALIFORNIA",
          lat: 41.2,
          lon: 150.9,
          speed_knots: 16.8,
          note: "Vessel returning toward planned speed as storm clears. Cumulative delay now ~18h vs. original schedule. No further deterioration expected.",
          cumulative_delay_hours: 18,
        }
      ),
    ],
    priorBelief: PRIOR_LOW,
    shipmentContext: COTTON_LA_CONTEXT,
    skipDbWrites: true,
  };

  const output = await synth.process(input);
  if (!output) { console.log("  ERROR: null output"); return false; }

  section("STRUCTURED OUTPUT");
  console.log(JSON.stringify(output, null, 2));

  section("CHECKS");

  let allPass = true;

  // This IS material — the ETA moves, even if by less than 24h
  // It is acceptable (but not required) to call this non-material
  // What's NOT acceptable: generating a 24h+ alert when delay is only 18h
  if (output.alert_decision.should_alert) {
    const wrongThreshold = output.alert_decision.threshold_triggered === "eta_shift_24h";
    allPass = check(
      "Should NOT trigger eta_shift_24h alert for 18h delay",
      !wrongThreshold
    ) && allPass;
  } else {
    check("No alert (correct — 18h is below 24h threshold)", true);
  }

  // If the system does update the belief, ETA must NOT jump by more than 24 hours
  if (output.new_belief?.current_eta) {
    const newEta = new Date(output.new_belief.current_eta);
    const priorEta = new Date("2024-07-08T08:00:00Z");
    const deltaHours = (newEta.getTime() - priorEta.getTime()) / (1000 * 60 * 60);
    allPass = check(
      `If updated, ETA shift is ≤24h (got: +${deltaHours.toFixed(1)}h)`,
      deltaHours <= 24
    ) && allPass;
    allPass = check(
      `ETA updated to reflect ~18h slip (got: +${deltaHours.toFixed(1)}h, expected 12–22h)`,
      deltaHours >= 12 && deltaHours <= 24
    ) && allPass;
  } else if (output.new_belief) {
    // new_belief exists but no ETA — acceptable if risk level unchanged
    const riskUnchanged = output.new_belief.risk_level === "low";
    check(`Risk stays low (${output.new_belief.risk_level}) since delay is minor`, riskUnchanged);
  }

  // Narrative must acknowledge ALL three position signals — not just cherry-pick one
  if (output.new_belief) {
    const citesAllThree =
      output.new_belief.narrative.includes("sig-pos-delay-1") &&
      output.new_belief.narrative.includes("sig-pos-delay-2") &&
      output.new_belief.narrative.includes("sig-pos-delay-3");
    // This is a SOFT check — the system may reasonably only cite the most recent
    // if they all tell the same story. We'll warn but not fail.
    if (!citesAllThree) {
      console.log("  ⚠  Narrative does not cite all 3 position signals (may be OK if most-recent cited)");
    } else {
      check("Narrative cites all three position signals", true);
    }
  }

  console.log(`\n  RESULT: ${allPass ? "✅ PASS" : "❌ FAIL"}`);
  return allPass;
}

// ─────────────────────────────────────────────────────────────────────────────
//  RUNNER
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const synth = new SynthesizerAgent();

  const results: boolean[] = [];

  results.push(await runA1(synth));
  results.push(await runA2(synth));
  results.push(await runA3(synth));

  const passed = results.filter(Boolean).length;
  const total = results.length;

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ADVERSARIAL SUMMARY: ${passed} passed, ${total - passed} failed`);
  console.log("═".repeat(70) + "\n");

  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
