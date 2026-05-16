import "dotenv/config";
import { SynthesizerAgent, SynthesizerOutput } from "../lib/agents/synthesizer";
import { cache } from "../lib/cache";
import type { SignalRow, BeliefRow, ShipmentContext, SynthesizerInput } from "../lib/agents/synthesizer";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SHIP_ID = "00000000-0000-0000-0000-000000000001";

const COTTON_CONTEXT: ShipmentContext = {
  hs_code: "5208.11",
  origin_country: "VN",
  destination_port: "USLAX",
  expected_eta: "2024-07-08",
  intent: {
    product_description: "organic cotton fabric",
    quantity: 5000,
    quantity_unit: "yards",
    budget_usd: 30000,
  },
};

const PRIOR_BELIEF_LOW: BeliefRow = {
  id: "00000000-0000-0000-0000-000000000010",
  version: 1,
  current_eta: new Date("2024-07-08"),
  risk_level: "low",
  narrative: "Shipment on track. Vessel departed Ho Chi Minh City on June 15. Current ETA July 8 to Los Angeles.",
  created_at: new Date("2024-06-15T00:00:00Z"),
};

function makeSignal(id: string, agentName: string, signalType: string, severity: string, payload: object): SignalRow {
  return {
    id,
    agent_name: agentName,
    signal_type: signalType,
    severity,
    payload,
    occurred_at: new Date(),
    recorded_at: new Date(),
  };
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

const SCENARIOS: Array<{
  name: string;
  demoKey?: string;
  input: SynthesizerInput;
  check: (output: SynthesizerOutput) => { pass: boolean; notes: string[] };
}> = [
  {
    name: "Scenario 1 — Routine vessel position (no change expected)",
    input: {
      shipmentId: SHIP_ID,
      newSignals: [
        makeSignal(
          "sig-a1b2-c3d4-e5f6-001",
          "route-prescorer",
          "vessel_position",
          "info",
          {
            vessel: "OOCL CALIFORNIA",
            lat: 23.4,
            lon: 139.1,
            speed_knots: 17.2,
            expected_speed_range: [17, 18],
            course: "on_route",
            eta_unchanged: true,
          }
        ),
      ],
      priorBelief: PRIOR_BELIEF_LOW,
      shipmentContext: COTTON_CONTEXT,
      skipDbWrites: true,
    },
    check(o) {
      const notes: string[] = [];
      const pass = !o.materiality_assessment.is_material;
      if (o.materiality_assessment.is_material) notes.push("FAIL: is_material should be false for routine position");
      if (o.causal_chain.length > 0) notes.push(`FAIL: causal_chain should be [] but has ${o.causal_chain.length} steps`);
      if (o.new_belief !== null) notes.push("FAIL: new_belief should be null");
      if (o.alert_decision.should_alert) notes.push("FAIL: should_alert should be false");
      if (o.alert !== null) notes.push("FAIL: alert should be null");
      if (pass && notes.length === 0) notes.push("✓ Correctly identified routine signal as non-material");
      return { pass: pass && notes.length === 1, notes };
    },
  },

  {
    name: "Scenario 2 — Suez Canal congestion (demo scenario)",
    demoKey: "demo:suez:eta_shift",
    input: {
      shipmentId: SHIP_ID,
      newSignals: [
        makeSignal(
          "sig-suez-gdelt-2024-0628",
          "country-risk",
          "gdelt_news",
          "high",
          {
            source: "GDELT",
            event_type: "canal_disruption",
            location: "Suez Canal",
            headline: "Suez Canal Authority announces 5-7 day vessel queuing delays due to congestion",
            delay_days_min: 5,
            delay_days_max: 7,
            affected_traffic: "all northbound and southbound vessels",
            source_url: "https://gdelt.example.com/event/suez-2024-0628",
          }
        ),
      ],
      priorBelief: PRIOR_BELIEF_LOW,
      // India → New York: genuine Suez Canal route
      shipmentContext: {
        hs_code: "5208.11",
        origin_country: "IN",
        destination_port: "USNYC",
        expected_eta: "2024-07-08",
        intent: {
          product_description: "organic cotton fabric",
          quantity: 5000,
          quantity_unit: "yards",
          budget_usd: 30000,
          route_notes: "Trans-Suez Canal routing: Mumbai → Red Sea → Suez → Mediterranean → New York",
        },
      },
      skipDbWrites: true,
    },
    check(o) {
      const notes: string[] = [];
      let pass = true;

      if (!o.materiality_assessment.is_material) {
        notes.push("FAIL: is_material should be true"); pass = false;
      }

      if (!o.new_belief) {
        notes.push("FAIL: new_belief should not be null"); pass = false;
      } else {
        const eta = o.new_belief.current_eta;
        if (!eta) {
          notes.push("FAIL: current_eta should be set"); pass = false;
        } else {
          const etaDate = new Date(eta);
          const etaDay = etaDate.getDate();
          if (etaDay < 13 || etaDay > 15) {
            notes.push(`FAIL: ETA should be July 13–15, got ${eta}`); pass = false;
          } else {
            notes.push(`✓ ETA shifted to ${eta} (expected July 13–15)`);
          }
        }

        if (o.new_belief.risk_level !== "medium") {
          notes.push(`FAIL: risk_level should be medium, got ${o.new_belief.risk_level}`); pass = false;
        } else {
          notes.push("✓ Risk escalated to medium");
        }

        // Check for inline citations
        const signalId = "sig-suez-gdelt-2024-0628";
        const narrative = o.new_belief.narrative;
        const citationMatches = [...narrative.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
        const hasCitation = citationMatches.some(id => id === signalId);
        if (!hasCitation) {
          notes.push(`FAIL: narrative missing [${signalId}] citation`); pass = false;
        } else {
          notes.push(`✓ Narrative cites [${signalId}]`);
        }

        // Check narrative length — should be meaningful, not one-liners
        if (narrative.length < 100) {
          notes.push(`FAIL: narrative too short (${narrative.length} chars) — lacks analyst depth`); pass = false;
        }
      }

      if (!o.alert_decision.should_alert) {
        notes.push("FAIL: should_alert should be true"); pass = false;
      } else {
        notes.push("✓ Alert triggered");
      }

      if (o.alert_decision.threshold_triggered !== "eta_shift_24h") {
        notes.push(`FAIL: threshold should be eta_shift_24h, got ${o.alert_decision.threshold_triggered}`); pass = false;
      }

      if (!o.alert) {
        notes.push("FAIL: alert should not be null"); pass = false;
      } else {
        const body = o.alert.draft_email.body;
        if (body.length > 600) {
          notes.push(`FAIL: email body exceeds 600 chars (${body.length})`); pass = false;
        } else {
          notes.push(`✓ Email body within limit (${body.length} chars)`);
        }

        // Should contain a specific date
        const hasDate = /july\s+1[3-5]/i.test(body) || /jul[\s.]+1[3-5]/i.test(body) || /2024-07-1[3-5]/.test(body);
        if (!hasDate) {
          notes.push("FAIL: email body should contain specific revised date (July 13–15)"); pass = false;
        } else {
          notes.push("✓ Email names specific revised date");
        }
      }

      return { pass, notes };
    },
  },

  {
    name: "Scenario 3 — Compounding delays (Suez + NY port)",
    input: {
      shipmentId: SHIP_ID,
      newSignals: [
        makeSignal(
          "sig-suez-gdelt-2024-0628",
          "country-risk",
          "gdelt_news",
          "high",
          {
            source: "GDELT",
            event_type: "canal_disruption",
            location: "Suez Canal",
            headline: "Suez Canal Authority announces 5-7 day queuing delays",
            delay_days_min: 5,
            delay_days_max: 7,
          }
        ),
        makeSignal(
          "sig-ny-port-ais-2024-0628",
          "route-prescorer",
          "port_congestion",
          "medium",
          {
            port: "New York",
            anchorage_vessels: 31,
            additional_dwell_days: 2,
            thirty_day_average_dwell: 0.4,
            source: "AIS",
          }
        ),
      ],
      priorBelief: PRIOR_BELIEF_LOW,
      // India → New York: genuine Suez Canal route
      shipmentContext: {
        hs_code: "5208.11",
        origin_country: "IN",
        destination_port: "USNYC",
        expected_eta: "2024-07-08",
        intent: {
          product_description: "organic cotton fabric",
          quantity: 5000,
          quantity_unit: "yards",
          budget_usd: 30000,
          route_notes: "Trans-Suez Canal routing: Mumbai → Red Sea → Suez → Mediterranean → New York",
        },
      },
      skipDbWrites: true,
    },
    check(o) {
      const notes: string[] = [];
      let pass = true;

      if (!o.materiality_assessment.is_material) {
        notes.push("FAIL: is_material should be true"); pass = false;
      }

      // Should have at least 2 causal chain steps, each citing a different signal
      const chainIds = new Set(o.causal_chain.map(s => s.signal_id_cited));
      if (chainIds.size < 2) {
        notes.push(`FAIL: causal_chain should cite at least 2 different signals, cites ${chainIds.size}`); pass = false;
      } else {
        notes.push("✓ Causal chain references both signals");
      }

      if (!o.new_belief) {
        notes.push("FAIL: new_belief should not be null"); pass = false;
      } else {
        // ETA should include both delays: 6 + 2 = 8 days, so July 16 (+/- 1)
        const eta = o.new_belief.current_eta;
        if (!eta) {
          notes.push("FAIL: current_eta should be set"); pass = false;
        } else {
          const etaDate = new Date(eta);
          const etaDay = etaDate.getDate();
          if (etaDay < 14 || etaDay > 18) {
            notes.push(`FAIL: ETA should account for both delays (July 14–18), got ${eta}`); pass = false;
          } else {
            notes.push(`✓ ETA shifted to ${eta} (accounts for both delays)`);
          }
        }

        // Narrative should reference both signal IDs
        const narrative = o.new_belief.narrative;
        const hasSuezCite = narrative.includes("sig-suez-gdelt-2024-0628");
        const hasPortCite = narrative.includes("sig-ny-port-ais-2024-0628");
        if (!hasSuezCite) { notes.push("FAIL: narrative missing Suez signal citation"); pass = false; }
        else notes.push("✓ Narrative cites Suez signal");
        if (!hasPortCite) { notes.push("FAIL: narrative missing NY port signal citation"); pass = false; }
        else notes.push("✓ Narrative cites NY port signal");

        if (o.new_belief.supporting_signal_ids.length < 2) {
          notes.push("FAIL: supporting_signal_ids should include both signals"); pass = false;
        }
      }

      if (!o.alert_decision.should_alert) {
        notes.push("FAIL: should_alert should be true"); pass = false;
      }

      return { pass, notes };
    },
  },

  {
    name: "Scenario 4 — UFLPA sanctions hit (compliance addition, demo scenario)",
    demoKey: "demo:uflpa:compliance_addition",
    input: {
      shipmentId: SHIP_ID,
      newSignals: [
        makeSignal(
          "sig-uflpa-add-2024-0628",
          "compliance-screener",
          "sanctions_addition",
          "critical",
          {
            list: "UFLPA",
            entity_name: "Xinjiang Textile Co., Ltd.",
            country: "CN",
            listing_date: "2024-06-28",
            reason: "Forced labor in Xinjiang cotton supply chain",
            shipment_impact: "Goods from this supplier cannot enter the US without rebuttable evidence waiver",
            action_required: "Contact customs broker immediately",
          }
        ),
      ],
      priorBelief: PRIOR_BELIEF_LOW,
      shipmentContext: {
        ...COTTON_CONTEXT,
        intent: {
          ...COTTON_CONTEXT.intent as object,
          product_description: "organic cotton fabric from Vietnam (Xinjiang-sourced raw fiber)",
        },
      },
      skipDbWrites: true,
    },
    check(o) {
      const notes: string[] = [];
      let pass = true;

      if (!o.materiality_assessment.is_material) {
        notes.push("FAIL: is_material should be true for UFLPA hit"); pass = false;
      }

      if (!o.alert_decision.should_alert) {
        notes.push("FAIL: should_alert should be true"); pass = false;
      }

      const validComplianceThresholds = ["compliance_addition", "critical_signal"];
      if (!validComplianceThresholds.includes(o.alert_decision.threshold_triggered)) {
        notes.push(`FAIL: threshold should be compliance_addition or critical_signal, got ${o.alert_decision.threshold_triggered}`); pass = false;
      } else {
        const preferred = o.alert_decision.threshold_triggered === "compliance_addition";
        notes.push(`✓ Threshold: ${o.alert_decision.threshold_triggered}${preferred ? "" : " (preferred: compliance_addition)"}`);
      }

      if (!o.alert) {
        notes.push("FAIL: alert should not be null"); pass = false;
      } else {
        if (o.alert.alert_type !== "compliance_issue") {
          notes.push(`FAIL: alert_type should be compliance_issue, got ${o.alert.alert_type}`); pass = false;
        } else {
          notes.push("✓ Alert type is compliance_issue");
        }

        const body = o.alert.draft_email.body;
        if (body.length > 600) {
          notes.push(`FAIL: email body exceeds 600 chars (${body.length})`); pass = false;
        }

        // Should mention customs broker
        const mentionsCustomsBroker = /customs\s+broker/i.test(body);
        if (!mentionsCustomsBroker) {
          notes.push("FAIL: email should mention customs broker"); pass = false;
        } else {
          notes.push("✓ Email mentions customs broker");
        }

        // Should mention UFLPA
        const mentionsUFLPA = /uflpa/i.test(body) || /forced\s+labor/i.test(body);
        if (!mentionsUFLPA) {
          notes.push("FAIL: email should mention UFLPA or forced labor"); pass = false;
        } else {
          notes.push("✓ Email references UFLPA/forced labor issue");
        }

        // Should be urgent but not panicked — no exclamation marks, no ALL-CAPS except known acronyms
        if (/!/.test(body)) {
          notes.push("FAIL: email should not use exclamation marks — keep calm urgency"); pass = false;
        }
        // Strip known acronyms before checking for inappropriate caps
        const bodyNoAcronyms = body.replace(/\b(UFLPA|OFAC|US|USA|UN|ETA|AIS|IMO|DOC)\b/g, "");
        if (/[A-Z]{3,}/.test(bodyNoAcronyms)) {
          notes.push("FAIL: email should not use ALL CAPS — keep professional tone"); pass = false;
        }
        if (pass) notes.push("✓ Email tone: urgent but professional");
      }

      return { pass, notes };
    },
  },

  {
    name: "Scenario 5 — Low-relevance noise (regional politics, unrelated)",
    input: {
      shipmentId: SHIP_ID,
      newSignals: [
        makeSignal(
          "sig-gdelt-politics-2024-0628",
          "country-risk",
          "gdelt_news",
          "low",
          {
            source: "GDELT",
            event_type: "political_statement",
            location: "Hanoi, Vietnam",
            headline: "Vietnamese government announces new agricultural subsidy program for rural provinces",
            relevance_to_trade: "none",
            topic: "domestic_agriculture",
          }
        ),
      ],
      priorBelief: PRIOR_BELIEF_LOW,
      shipmentContext: COTTON_CONTEXT,
      skipDbWrites: true,
    },
    check(o) {
      const notes: string[] = [];
      let pass = true;

      const isNonMaterial = !o.materiality_assessment.is_material;
      const noAlert = !o.alert_decision.should_alert;

      if (!isNonMaterial) {
        notes.push(`FAIL: agricultural subsidy news should not be material (rationale: "${o.materiality_assessment.rationale}")`);
        pass = false;
      } else {
        notes.push("✓ Correctly identified as non-material");
      }

      if (!noAlert) {
        notes.push("FAIL: should_alert should be false for unrelated regional news");
        pass = false;
      } else {
        notes.push("✓ No alert triggered");
      }

      if (o.alert !== null) {
        notes.push("FAIL: alert should be null"); pass = false;
      }

      if (o.causal_chain.length > 0) {
        notes.push("FAIL: causal_chain should be empty"); pass = false;
      }

      return { pass, notes };
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

function printSection(title: string, content: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
  console.log(content);
}

async function runScenario(
  agent: SynthesizerAgent,
  scenario: (typeof SCENARIOS)[number],
  cacheOnSuccess: boolean
): Promise<boolean> {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${scenario.name}`);
  console.log("═".repeat(70));

  let output: SynthesizerOutput | null = null;
  try {
    output = (await agent.process(scenario.input)) as SynthesizerOutput | null;
  } catch (err) {
    console.error(`  ERROR: ${err}`);
    return false;
  }

  if (!output) {
    console.log("  RESULT: null output — synthesis skipped or validation failed");
    return false;
  }

  // Print structured output
  printSection("STRUCTURED OUTPUT", JSON.stringify(output, null, 2));

  // Print narrative
  if (output.new_belief) {
    printSection("NARRATIVE", output.new_belief.narrative);
    printSection("CONFIDENCE NOTE", output.new_belief.confidence_note);
  } else {
    printSection("NARRATIVE", "(none — not material)");
  }

  // Print email
  if (output.alert?.draft_email) {
    printSection(
      "DRAFT EMAIL",
      `Subject: ${output.alert.draft_email.subject_line}\n\n${output.alert.draft_email.body}`
    );
    console.log(`  [${output.alert.draft_email.body.length} chars]`);
  } else {
    printSection("DRAFT EMAIL", "(none — no alert triggered)");
  }

  // Run pass/fail checks
  const { pass, notes } = scenario.check(output);
  console.log(`\n  CHECKS:`);
  for (const note of notes) {
    console.log(`    ${note}`);
  }
  console.log(`\n  RESULT: ${pass ? "✅ PASS" : "❌ FAIL"}`);

  // Cache successful demo output
  if (pass && cacheOnSuccess && scenario.demoKey) {
    const ttlDays = 30;
    await cache.set(scenario.demoKey, output, ttlDays * 24 * 60 * 60);
    console.log(`  [Cached as "${scenario.demoKey}" for ${ttlDays} days]`);
  }

  return pass;
}

async function runBestOf5(agent: SynthesizerAgent, scenario: (typeof SCENARIOS)[number]) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  BEST-OF-5: ${scenario.name}`);
  console.log("═".repeat(70));

  const results: Array<{ output: SynthesizerOutput; citationCount: number; narrativeLen: number; pass: boolean }> = [];

  for (let i = 1; i <= 5; i++) {
    process.stdout.write(`  Run ${i}/5...`);
    try {
      const output = await agent.process({ ...scenario.input, skipDbWrites: true }) as SynthesizerOutput | null;
      if (output) {
        const { pass } = scenario.check(output);
        const citations = output.new_belief
          ? [...output.new_belief.narrative.matchAll(/\[[^\]]+\]/g)].length
          : 0;
        results.push({
          output,
          citationCount: citations,
          narrativeLen: output.new_belief?.narrative.length ?? 0,
          pass,
        });
        console.log(` ${pass ? "✅" : "❌"} (narrative ${output.new_belief?.narrative.length ?? 0} chars, ${citations} citations)`);
      } else {
        console.log(" null output");
      }
    } catch (err) {
      console.log(` error: ${err}`);
    }
  }

  if (results.length === 0) {
    console.log("  No successful runs — cannot cache");
    return;
  }

  // Pick best: prefer passing, then most citations, then longest narrative
  const passing = results.filter(r => r.pass);
  const pool = passing.length > 0 ? passing : results;
  const best = pool.sort((a, b) => {
    if (b.citationCount !== a.citationCount) return b.citationCount - a.citationCount;
    return b.narrativeLen - a.narrativeLen;
  })[0];

  if (scenario.demoKey) {
    const ttlDays = 30;
    await cache.set(scenario.demoKey, best.output, ttlDays * 24 * 60 * 60);
    console.log(`\n  Best-of-5 cached as "${scenario.demoKey}" (${best.citationCount} citations, ${best.narrativeLen} chars)`);
    printSection("CACHED NARRATIVE", best.output.new_belief?.narrative ?? "(none)");
    if (best.output.alert?.draft_email) {
      printSection("CACHED EMAIL", `Subject: ${best.output.alert.draft_email.subject_line}\n\n${best.output.alert.draft_email.body}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const runBest5 = args.includes("--best-of-5");
  const scenarioFilter = args.find(a => a.startsWith("--scenario="))?.split("=")[1];

  const agent = new SynthesizerAgent();

  let passed = 0;
  let failed = 0;

  const scenariosToRun = scenarioFilter
    ? SCENARIOS.filter((_, i) => String(i + 1) === scenarioFilter)
    : SCENARIOS;

  if (runBest5) {
    // Run best-of-5 for demo scenarios
    const demoScenarios = SCENARIOS.filter(s => s.demoKey);
    for (const scenario of demoScenarios) {
      await runBestOf5(agent, scenario);
    }
    return;
  }

  for (const scenario of scenariosToRun) {
    const pass = await runScenario(agent, scenario, true);
    if (pass) passed++;
    else failed++;
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  SUMMARY: ${passed} passed, ${failed} failed`);
  console.log("═".repeat(70));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
