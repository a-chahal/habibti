import "dotenv/config";
import { db } from "../lib/db/client";
import { shipments, dispatches } from "../lib/db/schema";
import { eq, inArray } from "drizzle-orm";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const TEST_INTENTS = [
  "I need 5000 yards of organic cotton fabric, delivered to Los Angeles by July 15, budget $30K landed",
  "looking to import 200kg of cinnamon from Indonesia, into NY",
  "lithium batteries for EV, into California, 1000 units",
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

async function pollUntilParsed(ids: string[], timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const remaining = new Set(ids);

  while (remaining.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));

    const rows = await db
      .select({ id: shipments.id, intent: shipments.intent, hs_code: shipments.hs_code })
      .from(shipments)
      .where(inArray(shipments.id, Array.from(remaining)));

    for (const row of rows) {
      const intent = row.intent as any;
      // Intent is parsed when it has hs_code field (set by orchestrator)
      if (intent && typeof intent === "object" && "hs_code" in intent) {
        remaining.delete(row.id);
        console.log(`\n✅ Shipment ${row.id} parsed:`);
        console.log(`   hs_code:          ${intent.hs_code}`);
        console.log(`   product:          ${intent.product_description}`);
        console.log(`   quantity:         ${intent.quantity} ${intent.quantity_unit ?? ""}`);
        console.log(`   origin:           ${intent.origin_country ?? "(not specified)"}`);
        console.log(`   destination_port: ${intent.destination_port ?? "(not specified)"}`);
        console.log(`   destination:      ${intent.destination_country ?? "(not specified)"}`);
        console.log(`   deadline:         ${intent.deadline_date ?? "(not specified)"}`);
        console.log(`   budget_usd:       ${intent.budget_usd != null ? "$" + intent.budget_usd.toLocaleString() : "(not specified)"}`);
        if (intent.clarification_needed) {
          console.log(`   ⚠️  clarification: ${intent.clarification_needed}`);
        }
      }
    }

    if (remaining.size > 0) {
      process.stdout.write(`\r⏳ Waiting for ${remaining.size} shipment(s) to parse...`);
    }
  }

  if (remaining.size > 0) {
    throw new Error(`Timeout: ${remaining.size} shipment(s) never parsed: ${[...remaining].join(", ")}`);
  }
}

async function verifyDispatches(ids: string[]) {
  const rows = await db
    .select()
    .from(dispatches)
    .where(inArray(dispatches.shipment_id, ids));

  const byShipment = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!byShipment.has(row.shipment_id)) byShipment.set(row.shipment_id, []);
    byShipment.get(row.shipment_id)!.push(row);
  }

  console.log("\n=== Dispatch Records ===");
  for (const id of ids) {
    const dispatchRows = byShipment.get(id) ?? [];
    const intentDispatch = dispatchRows.find((d) => d.agent_name === "intent-parser");
    if (intentDispatch) {
      console.log(`✅ Shipment ${id}: intent-parser dispatch ${intentDispatch.status} (${intentDispatch.completed_at ? "completed" : "pending"})`);
    } else {
      console.log(`❌ Shipment ${id}: no intent-parser dispatch found`);
    }
  }
}

async function main() {
  console.log("=== Intent Parsing End-to-End Test ===\n");
  console.log(`Submitting ${TEST_INTENTS.length} test shipments to ${BASE_URL}...\n`);

  const ids: string[] = [];

  for (const intent of TEST_INTENTS) {
    const id = await postShipment(intent);
    ids.push(id);
    console.log(`  → Created shipment ${id}`);
    console.log(`    Intent: "${intent.slice(0, 60)}..."`);
  }

  console.log(`\nPolling for parsed intents (up to 60s)...`);
  await pollUntilParsed(ids, 60_000);

  await verifyDispatches(ids);

  // Validation: check HS codes
  console.log("\n=== HS Code Validation ===");
  const rows = await db
    .select({ id: shipments.id, intent: shipments.intent })
    .from(shipments)
    .where(inArray(shipments.id, ids));

  let passed = 0;
  const expected = ["5208", "0906", "8507"];
  for (let i = 0; i < rows.length; i++) {
    // Match by order they were created (IDs are chronological UUIDs)
    const row = rows.find((r) => r.id === ids[i]);
    if (!row) continue;
    const intent = row.intent as any;
    const hs = intent?.hs_code;
    const exp = expected[i];
    const ok = hs === exp;
    console.log(`  [${ok ? "✅" : "❌"}] Shipment ${i + 1}: expected HS ${exp}, got ${hs}`);
    if (ok) passed++;
  }

  console.log(`\n${passed}/${expected.length} HS codes matched expected values`);
  console.log("\n✅ Test complete");
  process.exit(passed === expected.length ? 0 : 1);
}

main().catch((err) => {
  console.error("❌ Test failed:", err.message);
  process.exit(1);
});
