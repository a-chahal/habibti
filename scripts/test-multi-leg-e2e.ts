import "dotenv/config";
import { orchestrator, registerAllAgents } from "../lib/agents/orchestrator";
import { createShipment, getOptionsForShipment } from "../lib/db/queries";

async function run() {
  registerAllAgents();

  // China → Rotterdam: a true multi-leg case requiring Malacca + Suez + Gibraltar.
  const intent = {
    raw_text: "I need 500 lithium batteries from China to Rotterdam by Aug 30, 2026, budget $80,000",
    hs_code: "850760",
    product_description: "lithium-ion batteries",
    quantity: 500,
    quantity_unit: "unit",
    budget_usd: 80_000,
    deadline_date: "2026-08-30",
    destination_port: "NLRTM",
    destination_country: "NL",
    origin_country: "CN",
    supplier: null,
    clarification_needed: null,
    citations: [],
  };

  const productValueUsd = Math.round((intent.budget_usd ?? 0) / 1.25);

  console.log("=== MULTI-LEG E2E: China → Rotterdam (expect Malacca + Suez + Gibraltar) ===\n");

  const ship = await createShipment({
    intent: { ...(intent as any), product_value_usd: productValueUsd },
    hs_code: intent.hs_code,
    origin_country: intent.origin_country,
    destination_country: intent.destination_country,
    destination_port: intent.destination_port,
    expected_eta: new Date(intent.deadline_date),
    status: "pending",
  });

  console.log(`shipment ${ship.id}\n`);
  const t0 = Date.now();
  await orchestrator.runSourcingPipeline(ship.id, intent as any, productValueUsd);
  console.log(`\nPipeline complete in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const options = await getOptionsForShipment(ship.id);

  for (const o of options) {
    const rd = o.route_data as any;
    console.log(`RANK ${o.rank} — ${o.country} via ${rd?.origin_port?.locode} (${rd?.origin_port?.name})`);
    console.log(`  ${rd?.total_distance_nm}nm, ${rd?.total_transit_days}d, chokepoints=[${(rd?.chokepoints ?? []).join(",")}]`);
    console.log(`  LEGS (${rd?.legs?.length ?? 0}):`);
    for (const leg of rd?.legs ?? []) {
      console.log(
        `    ${leg.from?.name?.padEnd(22)} → ${leg.to?.name?.padEnd(22)} ` +
        `${String(leg.distance_nm).padStart(5)}nm  ${String(leg.estimated_days).padStart(4)}d  ` +
        `cp=${leg.chokepoint_id ?? "—"}  risk=${leg.risk_severity ?? "none"}`
      );
    }
    console.log("");
  }

  // Acceptance: each option should have ≥ 2 legs (multi-leg by definition)
  const allMultiLeg = options.every((o) => ((o.route_data as any)?.legs?.length ?? 0) >= 2);
  console.log(`${allMultiLeg ? "✓" : "✗"} All options have ≥ 2 legs (multi-leg)`);

  process.exit(allMultiLeg ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
