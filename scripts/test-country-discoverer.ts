import "dotenv/config";
import { CountryDiscovererAgent } from "../lib/agents/country-discoverer";

async function main() {
  console.log("Testing CountryDiscovererAgent directly...");
  const agent = new CountryDiscovererAgent();
  try {
    const result = await agent.process({
      hs_code: "5208",
      destination_country: "US",
      shipmentId: undefined,
    });
    console.log("✅ Success:", JSON.stringify(result, null, 2).slice(0, 500));
  } catch (err: any) {
    console.error("❌ FAILED:", err.message);
    if (err.cause) console.error("  cause:", err.cause);
    if (err.stack) console.error("  stack:", err.stack.split("\n").slice(0,8).join("\n"));
  }
  process.exit(0);
}

main();
