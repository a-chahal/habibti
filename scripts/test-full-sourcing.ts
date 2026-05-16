import "dotenv/config";
import { db } from "../lib/db/client";
import { signals, options, shipments, supplier_history, route_history } from "../lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { FeedbackLoopAgent } from "../lib/agents/feedback-loop";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const SARAH_INTENT =
  "I need 5000 yards of organic cotton fabric, delivered to Los Angeles by July 15, budget $30K landed";

async function postShipment(intent: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/shipments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent }),
  });
  if (!res.ok) throw new Error(`POST /api/shipments failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.id;
}

async function pollForOptions(
  shipmentId: string,
  timeoutMs = 4 * 60 * 1000
): Promise<typeof options.$inferSelect[]> {
  const deadline = Date.now() + timeoutMs;
  let lastSignalCount = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));

    const opts = await db
      .select()
      .from(options)
      .where(eq(options.shipment_id, shipmentId));

    const sigs = await db
      .select({ agent_name: signals.agent_name })
      .from(signals)
      .where(eq(signals.shipment_id, shipmentId));

    if (sigs.length !== lastSignalCount) {
      const agents = [...new Set(sigs.map((s) => s.agent_name))].filter(
        (a) => a !== "orchestrator"
      );
      process.stdout.write(
        `\r  Signals: ${sigs.length} | Options: ${opts.length} | Agents: [${agents.join(", ")}]   `
      );
      lastSignalCount = sigs.length;
    }

    if (opts.length >= 3) {
      process.stdout.write("\n");
      return opts;
    }
  }

  throw new Error("Timeout: 3 options never appeared within 4 minutes");
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function hasNumbers(text: string): boolean {
  return /\$[\d,]+|[\d]+%|[\d]+ days?|[\d]+\.[\d]+ days?/.test(text);
}

function acknowledgesTradeoffs(text: string): boolean {
  return /\b(risk|tradeoff|constraint|critical risk|weakness|buffer|deadline|however|but the|caveat)\b/i.test(
    text
  );
}

function hasAnalystCitations(text: string): boolean {
  // At least 3 specific data points referenced
  const patterns = [
    /\$[\d,]+/g,       // dollar amounts
    /[\d]+\.?\d*%/g,   // percentages
    /[\d]+ days?/g,    // transit days
    /[\d]+\.[\d]+/g,   // decimal scores
  ];
  const totalMatches = patterns.reduce(
    (sum, re) => sum + (text.match(re)?.length ?? 0),
    0
  );
  return totalMatches >= 3;
}

async function testFeedbackLoop(shipmentId: string) {
  console.log("\n=== Feedback Loop Test ===");

  // Simulate delivery 4 days later than predicted
  const predictedDate = new Date();
  predictedDate.setDate(predictedDate.getDate() + 16); // 16-day transit
  const actualDate = new Date(predictedDate.getTime() + 4 * 24 * 60 * 60 * 1000); // 4 days late
  const actualDeliveredAt = actualDate.toISOString().slice(0, 10);

  console.log(`  Simulating delivery on ${actualDeliveredAt} (4 days late)`);

  const agent = new FeedbackLoopAgent();
  let result: Awaited<ReturnType<typeof agent.process>>;
  try {
    result = await agent.process({
      shipmentId,
      actual_delivered_at: actualDeliveredAt,
      notes: "Port congestion at Long Beach added 4 days to transit",
    });
  } catch (err: any) {
    console.log(`  ❌ Feedback loop failed: ${err.message}`);
    return false;
  }

  console.log(`  delay_days: ${result.delay_days}`);
  console.log(`  reliability_score: ${result.reliability_score}`);
  console.log(`  learning_note: "${result.learning_note.slice(0, 120)}..."`);

  // Verify supplier_history written (if supplier_id exists)
  const shipHistRows = await db
    .select()
    .from(supplier_history)
    .where(eq(supplier_history.shipment_id, shipmentId));

  const routeHistRows = await db
    .select()
    .from(route_history)
    .where(eq(route_history.shipment_id, shipmentId));

  let passed = true;

  if (routeHistRows.length > 0) {
    console.log(`  ✅ route_history written: predicted=${routeHistRows[0].predicted_transit_days}d actual=${routeHistRows[0].actual_transit_days}d`);
  } else {
    console.log(`  ❌ route_history not written`);
    passed = false;
  }

  if (shipHistRows.length > 0) {
    console.log(`  ✅ supplier_history written: delay=${shipHistRows[0].delay_days}d reliability=${shipHistRows[0].reliability_score}`);
  } else {
    console.log(`  ℹ supplier_history skipped (no supplier_id on rank-1 option — acceptable)`);
  }

  return passed;
}

async function main() {
  console.log("=== Full Sourcing Flow Test (Sarah's Demo) ===\n");
  console.log(`Intent: "${SARAH_INTENT}"\n`);

  const shipmentId = await postShipment(SARAH_INTENT);
  console.log(`  → Created shipment ${shipmentId}\n`);

  console.log("Polling for 3 ranked options (up to 4 min)...");
  const opts = await pollForOptions(shipmentId);

  // Print each option
  console.log("\n=== 3 Ranked Options ===\n");
  let passed = 0;
  let failed = 0;

  function check(label: string, ok: boolean, detail?: string) {
    if (ok) { console.log(`  ✅ ${label}`); passed++; }
    else { console.log(`  ❌ ${label}${detail ? ": " + detail : ""}`); failed++; }
  }

  // Sort by rank
  opts.sort((a, b) => a.rank - b.rank);

  const seenCountries = new Set<string>();
  for (const opt of opts) {
    const cb = opt.cost_breakdown as any;
    const rs = opt.risk_summary as any;
    const rd = opt.route_data as any;

    console.log(`\n--- Option #${opt.rank}: ${opt.country} ---`);
    console.log(`  Supplier:   ${opt.supplier_id ? "(supplier upserted)" : "no supplier_id"}`);
    console.log(`  ETA:        ${opt.eta?.toISOString().slice(0, 10) ?? "unknown"}`);
    console.log(`  Landed cost: $${cb?.total_landed_cost_usd?.toLocaleString() ?? "?"}`);
    console.log(`  Total duty: ${cb?.total_duty_pct}% (301: ${cb?.section_301_pct ?? "N/A"}%)`);
    console.log(`  Risk:       ${rs?.overall} — ${rs?.country_risk}`);
    console.log(`  Route:      ${rd?.routes?.[0]?.lane_name ?? rd?.lane_name ?? "?"}`);
    console.log(`  Reasoning:  "${opt.reasoning?.slice(0, 200)}..."`);

    seenCountries.add(opt.country ?? "");
  }

  console.log("\n=== Option Quality Validation ===\n");

  check("Exactly 3 options written", opts.length === 3, `got ${opts.length}`);
  check("3 options from 3 different countries", seenCountries.size === 3, `countries: ${[...seenCountries].join(", ")}`);

  for (const opt of opts) {
    const reasoning = opt.reasoning ?? "";
    const words = countWords(reasoning);
    check(`Option #${opt.rank} reasoning ≥20 words`, words >= 20, `${words} words`);
    check(`Option #${opt.rank} reasoning cites ≥3 data points`, hasAnalystCitations(reasoning));
    check(`Option #${opt.rank} reasoning acknowledges tradeoffs`, acknowledgesTradeoffs(reasoning));
    check(`Option #${opt.rank} reasoning contains numbers`, hasNumbers(reasoning));
    check(`Option #${opt.rank} has cost breakdown`, !!(opt.cost_breakdown as any)?.total_landed_cost_usd);
    check(`Option #${opt.rank} has risk summary`, !!(opt.risk_summary as any)?.overall);
    check(`Option #${opt.rank} has ETA`, !!opt.eta);
  }

  // Test feedback loop
  const feedbackOk = await testFeedbackLoop(shipmentId);
  check("Feedback loop completes", feedbackOk);

  console.log(`\n${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log("\n✅ Full sourcing flow is demo-ready");
    process.exit(0);
  } else {
    console.log("\n❌ Some checks failed — review option-ranker prompt or agent outputs");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Test failed:", err.message);
  process.exit(1);
});
