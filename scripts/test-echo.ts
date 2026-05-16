import "dotenv/config";
import { EchoAgent } from "../lib/agents/test-echo";

async function main() {
  const input = process.argv[2] ?? "hello world";
  console.log(`\nRunning EchoAgent with input: "${input}"\n`);

  const agent = new EchoAgent();
  const result = await agent.run(input);
  console.log("\nEchoAgent output:");
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error("test-echo failed:", err);
  process.exit(1);
});
