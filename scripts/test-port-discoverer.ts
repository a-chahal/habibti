import "dotenv/config";
import { PortDiscovererAgent } from "../lib/agents/port-discoverer";

const TESTS: Array<{ country: string; hs: string; description: string }> = [
  { country: "CN", hs: "8507", description: "China lithium batteries" },
  { country: "CN", hs: "6109", description: "China cotton T-shirts" },
  { country: "VN", hs: "6203", description: "Vietnam apparel" },
  { country: "IN", hs: "6204", description: "India textiles" },
  { country: "DE", hs: "8703", description: "Germany passenger cars" },
  { country: "BR", hs: "0901", description: "Brazil coffee" },
];

async function run() {
  const agent = new PortDiscovererAgent();
  for (const t of TESTS) {
    console.log(`\n── ${t.description} (${t.country}, HS ${t.hs}) ──`);
    const start = Date.now();
    try {
      const result = await agent.process({
        country_code: t.country,
        hs_code: t.hs,
      });
      const ms = Date.now() - start;
      console.log(`(${ms}ms) ${result.ports.length} ports`);
      for (const p of result.ports) {
        console.log(
          `  ${p.locode.padEnd(6)} ${p.name.padEnd(24)} score=${p.score.toFixed(2)}  ${p.rationale.slice(0, 100)}${p.rationale.length > 100 ? "…" : ""}`
        );
      }
    } catch (err: any) {
      console.error(`  FAIL: ${err.message}`);
      process.exitCode = 1;
    }
  }
  process.exit(process.exitCode ?? 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
