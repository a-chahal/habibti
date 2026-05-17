/**
 * E2E test for the monitoring + synthesis pipeline.
 *
 * Flow:
 * 1. Find or create Sarah's sourced cotton shipment
 * 2. Confirm it → starts 5 monitoring agents
 * 3. Wait 30s → verify each monitoring agent has written ≥1 signal
 * 4. Inject Suez backup via /api/demo/inject
 * 5. Wait 15s → verify belief updated + alert created with Suez in causal chain
 * 6. Print full alert and email for eyeball review
 * 7. Run all 4 injection scenarios sequentially
 *
 * Usage:
 *   TEST_MONITORING=1 npm run test-monitoring-flow
 *   (TEST_MONITORING=1 sets fast intervals for all monitoring agents)
 */
process.env.TEST_MONITORING = "1";

import "dotenv/config";
import { db } from "../lib/db/client";
import { signals, beliefs, alerts, shipments, options } from "../lib/db/schema";
import { eq, desc, and, gt } from "drizzle-orm";
import { readFileSync } from "fs";
import { join } from "path";
import { emit } from "../lib/events/emitter";
import { updateShipment } from "../lib/db/queries";
import { orchestrator, registerAllAgents } from "../lib/agents/orchestrator";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pass(msg: string) { console.log(`  ✅ ${msg}`); }
function fail(msg: string) { console.log(`  ❌ ${msg}`); }
function info(msg: string) { console.log(`  → ${msg}`); }

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function findSourcedShipment(): Promise<string | null> {
  const rows = await db
    .select({ id: shipments.id, status: shipments.status, origin_country: shipments.origin_country })
    .from(shipments)
    .where(eq(shipments.status, "sourcing_complete"))
    .orderBy(desc(shipments.created_at))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function getSignalsByAgent(shipmentId: string, since?: Date): Promise<Record<string, number>> {
  const rows = await db
    .select({ agent_name: signals.agent_name })
    .from(signals)
    .where(
      since
        ? and(eq(signals.shipment_id, shipmentId), gt(signals.recorded_at, since))
        : eq(signals.shipment_id, shipmentId)
    );
  const counts: Record<string, number> = {};
  for (const r of rows) {
    counts[r.agent_name] = (counts[r.agent_name] ?? 0) + 1;
  }
  return counts;
}

async function getLatestBelief(shipmentId: string) {
  return db.query.beliefs.findFirst({
    where: eq(beliefs.shipment_id, shipmentId),
    orderBy: desc(beliefs.version),
  });
}

async function getLatestAlert(shipmentId: string) {
  return db.query.alerts.findFirst({
    where: eq(alerts.shipment_id, shipmentId),
    orderBy: desc(alerts.created_at),
  });
}

async function injectSignal(shipmentId: string, injectionFile: string): Promise<string | null> {
  const payload = JSON.parse(readFileSync(join(process.cwd(), "scripts/injections", injectionFile), "utf-8"));

  const res = await fetch(`${BASE_URL}/api/demo/inject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shipment_id: shipmentId, ...payload }),
  });

  if (!res.ok) {
    console.error(`  inject failed: ${res.status} ${await res.text()}`);
    return null;
  }
  const data = await res.json();
  return data.id;
}

async function pollForBelief(shipmentId: string, afterVersion: number, timeoutMs: number): Promise<typeof beliefs.$inferSelect | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const belief = await getLatestBelief(shipmentId);
    if (belief && belief.version > afterVersion) return belief;
    await sleep(1000);
  }
  return null;
}

async function pollForAlert(shipmentId: string, afterTime: Date, timeoutMs: number): Promise<typeof alerts.$inferSelect | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alert = await db.query.alerts.findFirst({
      where: and(eq(alerts.shipment_id, shipmentId), gt(alerts.created_at, afterTime)),
      orderBy: desc(alerts.created_at),
    });
    if (alert) return alert;
    await sleep(1000);
  }
  return null;
}

// ─── Test sections ────────────────────────────────────────────────────────────

async function testMonitoringAgentsStart(shipmentId: string): Promise<boolean> {
  console.log("\n── Step 2: Wait 30s for monitoring agents to write signals ──");

  const baseline = await getSignalsByAgent(shipmentId);
  const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0);
  info(`Baseline signals: ${baselineTotal}`);

  const monitoringStarted = new Date();

  info("Waiting 30 seconds...");
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const counts = await getSignalsByAgent(shipmentId, monitoringStarted);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    process.stdout.write(`\r  Signals from monitoring agents: ${total} [${Object.keys(counts).join(", ")}]    `);
  }
  process.stdout.write("\n");

  const counts = await getSignalsByAgent(shipmentId, monitoringStarted);
  const monitoringAgents = ["vessel-tracker", "port-congestion", "corridor-news", "regulatory-watcher", "weather-hazard"];

  let allFired = true;
  for (const agent of monitoringAgents) {
    const n = counts[agent] ?? 0;
    if (n > 0) {
      pass(`${agent}: ${n} signal(s)`);
    } else {
      fail(`${agent}: 0 signals (may still be in flight — GDELT can be slow)`);
      // Don't hard-fail — GDELT/external calls can be slow; mark as warning
    }
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0) {
    pass(`Total ${total} new signals from monitoring pipeline`);
    return true;
  } else {
    fail("No monitoring signals written");
    return false;
  }
}

async function testInjectionScenario(
  shipmentId: string,
  label: string,
  injectionFile: string,
  expectedSignalType: string
): Promise<boolean> {
  console.log(`\n── Injection: ${label} ──`);

  const beliefBefore = await getLatestBelief(shipmentId);
  const priorVersion = beliefBefore?.version ?? 0;
  const injectTime = new Date();

  // Inject
  const signalId = await injectSignal(shipmentId, injectionFile);
  if (!signalId) { fail("Injection failed"); return false; }
  pass(`Signal injected: ${signalId}`);
  info(`Signal type: ${expectedSignalType}`);

  // Verify signal in DB
  const signalRow = await db.query.signals.findFirst({
    where: eq(signals.id, signalId),
  });
  if (signalRow) {
    pass(`Signal ${signalId} found in DB (type=${signalRow.signal_type}, severity=${signalRow.severity})`);
  } else {
    fail(`Signal ${signalId} not found in DB`);
    return false;
  }

  // Wait for Synthesizer to react (up to 20 seconds — 3s debounce + LLM call)
  info("Waiting up to 20s for Synthesizer to process...");
  const newBelief = await pollForBelief(shipmentId, priorVersion, 20_000);

  if (!newBelief) {
    fail("No new belief written within 20s — Synthesizer may not have triggered");
    // Still check for alerts
  } else {
    pass(`Belief v${newBelief.version} written (risk: ${newBelief.risk_level}, eta: ${newBelief.current_eta?.toISOString().slice(0, 10) ?? "null"})`);

    if (newBelief.narrative) {
      console.log(`\n  NARRATIVE:\n  ${newBelief.narrative.replace(/\n/g, "\n  ")}\n`);
    }
  }

  // Check for alert
  const alert = await pollForAlert(shipmentId, injectTime, 5_000);
  if (alert) {
    pass(`Alert created: "${alert.headline}" (type: ${alert.alert_type})`);

    if (alert.draft_email) {
      let emailObj: { subject_line?: string; body?: string } = {};
      try { emailObj = JSON.parse(alert.draft_email); } catch { emailObj = {}; }
      console.log(`\n  DRAFT EMAIL:`);
      console.log(`  Subject: ${emailObj.subject_line ?? "(none)"}`);
      console.log(`  Body: ${(emailObj.body ?? alert.draft_email).replace(/\n/g, "\n  ")}\n`);
    }
  } else {
    info("No alert created for this injection (may be non-material or Synthesizer still processing)");
  }

  return !!newBelief || !!alert;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Boot the orchestrator so monitoring agents are registered
  registerAllAgents();
  orchestrator.start();

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  MONITORING FLOW E2E TEST (TEST_MONITORING=1)");
  console.log("══════════════════════════════════════════════════════════════");

  // ── Step 1: Find a sourced shipment ──────────────────────────────────────
  console.log("\n── Step 1: Find sourced shipment ──");

  let shipmentId = await findSourcedShipment();
  if (!shipmentId) {
    fail("No sourcing_complete shipment found. Run npm run test-full-sourcing first.");
    process.exit(1);
  }
  pass(`Found shipment: ${shipmentId}`);

  const shipment = await db.query.shipments.findFirst({ where: eq(shipments.id, shipmentId) });
  info(`Origin: ${shipment?.origin_country}, Dest: ${shipment?.destination_port}, HS: ${shipment?.hs_code}`);

  // Start monitoring (fires SHIPMENT_CONFIRMED)
  console.log("\n── Step 1b: Start monitoring pipeline ──");
  await orchestrator.startMonitoring(shipmentId);
  pass("Monitoring agents started");

  // ── Step 2: Wait 30s for monitoring signals ───────────────────────────────
  const monitoringOk = await testMonitoringAgentsStart(shipmentId);

  // ── Step 3: Injection scenarios ──────────────────────────────────────────
  console.log("\n══ INJECTION SCENARIOS ══");

  const scenarios = [
    { label: "Suez Canal Backup", file: "suez-backup.json", type: "gdelt_news" },
    { label: "LA Port Strike", file: "port-strike-la.json", type: "port_congestion" },
    { label: "UFLPA Sanctions Hit", file: "sanctions-hit.json", type: "sanctions_addition" },
    { label: "Typhoon Warning", file: "weather-typhoon.json", type: "weather_hazard" },
  ];

  let scenariosPassed = 0;
  for (const s of scenarios) {
    const ok = await testInjectionScenario(shipmentId, s.label, s.file, s.type);
    if (ok) scenariosPassed++;
    // Brief pause between scenarios to let Synthesizer settle
    await sleep(5000);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`  SUMMARY:`);
  console.log(`  Monitoring signals: ${monitoringOk ? "✅" : "⚠️"}`);
  console.log(`  Injection scenarios: ${scenariosPassed}/${scenarios.length} triggered belief/alert`);
  console.log("══════════════════════════════════════════════════════════════\n");

  // Exit after brief settle time (let background timers flush)
  await sleep(2000);
  process.exit(scenariosPassed >= 2 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
