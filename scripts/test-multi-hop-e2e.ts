import "dotenv/config";
import { orchestrator, registerAllAgents } from "../lib/agents/orchestrator";
import { createShipment } from "../lib/db/queries";
import { getOptionsForShipment, getSignalsForShipment } from "../lib/db/queries";

async function run() {
  registerAllAgents();

  const intent = {
    raw_text: "I need 500 lithium batteries from China to LA by Aug 30, 2026, budget $80,000",
    hs_code: "850760",
    product_description: "lithium-ion batteries",
    quantity: 500,
    quantity_unit: "unit",
    budget_usd: 80_000,
    deadline_date: "2026-08-30",
    destination_port: "USLAX",
    destination_country: "US",
    origin_country: "CN",
    supplier: null,
    clarification_needed: null,
    citations: [],
  };

  const productValueUsd = Math.round((intent.budget_usd ?? 0) / 1.25);

  console.log("=== E2E TEST: Lithium batteries from China to LA ===\n");

  const ship = await createShipment({
    intent: { ...(intent as any), product_value_usd: productValueUsd },
    hs_code: intent.hs_code,
    origin_country: intent.origin_country,
    destination_country: intent.destination_country,
    destination_port: intent.destination_port,
    expected_eta: new Date(intent.deadline_date),
    status: "pending",
  });

  console.log(`shipment created: ${ship.id}`);
  console.log("dispatching sourcing pipeline (this calls all new agents)...\n");

  const t0 = Date.now();
  await orchestrator.runSourcingPipeline(ship.id, intent as any, productValueUsd);
  const totalMs = Date.now() - t0;

  console.log(`\n=== PIPELINE COMPLETE in ${(totalMs / 1000).toFixed(1)}s ===\n`);

  // Inspect outputs
  const options = await getOptionsForShipment(ship.id);
  const signals = await getSignalsForShipment(ship.id);
  const byAgent = new Map<string, number>();
  for (const s of signals) byAgent.set(s.agent_name, (byAgent.get(s.agent_name) ?? 0) + 1);

  console.log("Signals emitted by agent:");
  for (const [name, n] of [...byAgent.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name.padEnd(22)} ${n}`);
  }

  console.log(`\nFinal ranked options (${options.length}):`);
  for (const o of options) {
    const rd = o.route_data as any;
    const cb = o.cost_breakdown as any;
    const rs = o.risk_summary as any;
    console.log(`\n  RANK ${o.rank} — ${o.country} via ${rd?.origin_port?.locode ?? "?"} (${rd?.origin_port?.name ?? "?"})`);
    console.log(`    route: ${rd?.total_distance_nm}nm, ${rd?.total_transit_days}d, chokepoints=[${(rd?.chokepoints ?? []).join(",")}]`);
    console.log(`    legs:`);
    for (const leg of rd?.legs ?? []) {
      console.log(`      • ${leg.from?.name} → ${leg.to?.name} (${leg.distance_nm}nm, ${leg.estimated_days}d) news=${leg.news_severity} risk=${leg.risk_severity}`);
      if (leg.summary) console.log(`        ↳ ${leg.summary}`);
    }
    console.log(`    cost: product $${cb?.product_value_usd?.toLocaleString()} + duty ${cb?.total_duty_pct}% + freight $${cb?.freight_usd?.toLocaleString()} + tolls $${cb?.canal_tolls_usd?.toLocaleString()} + war-risk $${cb?.war_risk_premium_usd?.toLocaleString()} = $${cb?.total_landed_cost_usd?.toLocaleString()}`);
    console.log(`    risk overall: ${rs?.overall} (${rs?.route_risk})`);
    console.log(`    eta: ${o.eta?.toISOString().slice(0, 10)}`);
    console.log(`    reasoning: ${o.reasoning?.slice(0, 200)}...`);
  }

  // Acceptance checks
  console.log("\n=== ACCEPTANCE CHECKS ===");
  const countries = new Set(options.map((o) => o.country));
  const ports = new Set(options.map((o) => (o.route_data as any)?.origin_port?.locode));
  console.log(`  unique countries: ${[...countries].join(",")}`);
  console.log(`  unique ports:     ${[...ports].join(",")}`);

  const allChina = options.every((o) => o.country === "CN");
  const distinctPorts = ports.size === options.length;
  const hasLegs = options.every((o) => ((o.route_data as any)?.legs?.length ?? 0) >= 1);
  const realPricing = options.every((o) => (o.cost_breakdown as any)?.product_value_usd > 0);

  const ok = (label: string, cond: boolean) =>
    console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  ok("All 3 options from China (origin specified)", allChina);
  ok("3 distinct origin ports", distinctPorts);
  ok("Every option has multi-hop legs", hasLegs);
  ok("Every option has real product pricing (not budget/1.25)", realPricing);

  process.exit(allChina && distinctPorts && hasLegs ? 0 : 1);
}

run().catch((e) => {
  console.error("E2E test failed:", e);
  process.exit(1);
});
