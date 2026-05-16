import "dotenv/config";
import { db } from "../lib/db/client";
import { dispatches, signals } from "../lib/db/schema";
import { desc, eq } from "drizzle-orm";

async function main() {
  // Show last 20 dispatches
  const rows = await db.select().from(dispatches).orderBy(desc(dispatches.created_at)).limit(20);
  console.log("\n=== Last 20 Dispatches ===");
  for (const r of rows) {
    console.log(`  ${r.status.padEnd(12)} ${r.agent_name.padEnd(24)} ${r.shipment_id.slice(0,8)} ${r.completed_at ? '✓' : '...'}`);
  }

  // Show signals from the most recent sourcing run
  const lastDispatches = rows.filter(r => r.agent_name === "orchestrator" || r.agent_name === "country-discoverer");
  if (lastDispatches.length > 0) {
    const shipmentId = lastDispatches[0].shipment_id;
    console.log(`\n=== Signals for shipment ${shipmentId.slice(0,8)} ===`);
    const sigs = await db.select().from(signals).where(eq(signals.shipment_id, shipmentId)).orderBy(signals.occurred_at);
    for (const s of sigs) {
      console.log(`  ${s.agent_name.padEnd(24)} ${s.signal_type}`);
    }
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
