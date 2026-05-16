import "dotenv/config";
import { OptionRankerAgent } from "../lib/agents/option-ranker";
import { db } from "../lib/db/client";
import { dispatches } from "../lib/db/schema";
import { eq, desc } from "drizzle-orm";

async function main() {
  // Find the most recent option-ranker dispatch to get the shipment ID
  const rows = await db
    .select()
    .from(dispatches)
    .where(eq(dispatches.agent_name, "option-ranker"))
    .orderBy(desc(dispatches.created_at))
    .limit(1);

  const shipmentId = rows[0]?.shipment_id;
  if (!shipmentId) { console.error("No option-ranker dispatch found"); process.exit(1); }

  console.log(`Testing OptionRankerAgent on shipment ${shipmentId.slice(0, 8)}...`);
  const agent = new OptionRankerAgent();
  try {
    const result = await agent.process({ shipmentId, intent_data: {} });
    console.log("✅ Success:", result.options.length, "options");
    for (const o of result.options) {
      console.log(`  #${o.rank} ${o.country_code}: $${o.cost_breakdown.total_landed_cost_usd} — ${o.reasoning.slice(0, 80)}...`);
    }
  } catch (err: any) {
    console.error("❌ FAILED:", err.message);
    if (err.stack) console.error(err.stack.split("\n").slice(0, 10).join("\n"));
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
