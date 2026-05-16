/**
 * Seed 3 pre-canned demo scenarios into the DB + cache.
 * Run before demos so all sourcing flows are instant (cache hits).
 *
 * Usage: npm run seed-scenarios
 */
import "dotenv/config";
import { db } from "../lib/db/client";
import { signals, options } from "../lib/db/schema";
import { eq } from "drizzle-orm";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const SCENARIOS = [
  {
    label: "A — Cotton fabric (Sarah's primary demo)",
    intent: "I need 5000 yards of organic cotton fabric, delivered to Los Angeles by July 15, budget $30K landed",
  },
  {
    label: "B — Cinnamon from Indonesia",
    intent: "200kg of cinnamon from Indonesia, into New York, need it within 45 days, budget $8K",
  },
  {
    label: "C — Lithium batteries to Long Beach",
    intent: "1000 lithium battery packs for EVs, into Long Beach, by August 1, budget $150K",
  },
];

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

async function pollUntilOptions(
  shipmentId: string,
  label: string,
  timeoutMs = 4 * 60 * 1000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let ticks = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    ticks++;

    const opts = await db
      .select({ rank: options.rank })
      .from(options)
      .where(eq(options.shipment_id, shipmentId));

    const sigs = await db
      .select({ type: signals.signal_type })
      .from(signals)
      .where(eq(signals.shipment_id, shipmentId));

    const hasComplete = sigs.some((s) => s.type === "sourcing_complete");
    const hasOptions = opts.length >= 3;

    process.stdout.write(
      `\r  [${label}] ${Math.round((ticks * 5) / 60)}m ${(ticks * 5) % 60}s — signals=${sigs.length} options=${opts.length}${hasComplete ? " ✓sourcing" : ""}${hasOptions ? " ✓options" : ""}   `
    );

    if (hasOptions) {
      process.stdout.write("\n");
      return true;
    }
  }

  process.stdout.write("\n");
  return false;
}

async function seedScenario(scenario: { label: string; intent: string }) {
  console.log(`\nSeeding scenario ${scenario.label}`);
  console.log(`  Intent: "${scenario.intent.slice(0, 80)}..."`);

  const shipmentId = await postShipment(scenario.intent);
  console.log(`  → Shipment ${shipmentId}`);

  const ok = await pollUntilOptions(shipmentId, scenario.label);
  if (ok) {
    const opts = await db
      .select({ rank: options.rank, country: options.country })
      .from(options)
      .where(eq(options.shipment_id, shipmentId))
      .orderBy(options.rank);

    console.log(`  ✅ 3 options ready:`);
    for (const o of opts) {
      console.log(`     #${o.rank}: ${o.country}`);
    }
  } else {
    console.log(`  ❌ Scenario ${scenario.label} timed out — partial data in DB`);
  }

  return { shipmentId, ok };
}

async function main() {
  console.log("=== Seed Demo Scenarios ===");
  console.log(`Server: ${BASE_URL}`);
  console.log(
    "Note: each scenario runs the full sourcing pipeline (~4 min). Subsequent runs will be instant from cache.\n"
  );

  const results: Array<{ label: string; shipmentId: string; ok: boolean }> = [];

  // Run sequentially to avoid overwhelming the semaphore across scenarios
  for (const scenario of SCENARIOS) {
    const { shipmentId, ok } = await seedScenario(scenario);
    results.push({ label: scenario.label, shipmentId, ok });
  }

  console.log("\n=== Summary ===");
  let allOk = true;
  for (const r of results) {
    console.log(`  ${r.ok ? "✅" : "❌"} Scenario ${r.label}: ${r.shipmentId}`);
    if (!r.ok) allOk = false;
  }

  if (allOk) {
    console.log(
      "\n✅ All 3 scenarios seeded. Agent caches (24h/6h/3h/2h) are warm — demo runs will be instant."
    );
    process.exit(0);
  } else {
    console.log("\n⚠ Some scenarios timed out — re-run seed-scenarios to retry.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Seed failed:", err.message);
  process.exit(1);
});
