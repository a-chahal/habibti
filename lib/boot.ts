import { orchestrator, registerAllAgents } from "./agents/orchestrator";

let booted = false;

export function boot() {
  if (booted) return;
  booted = true;
  registerAllAgents();
  orchestrator.start();
  console.log("[Boot] trade platform initialized");
}

// Auto-boot: only in Node runtime, not during Next.js static build or client bundle
const isNextBuild = process.env.NEXT_PHASE === "phase-production-build";
const isEdge = typeof (globalThis as any).EdgeRuntime !== "undefined";

if (typeof window === "undefined" && !isNextBuild && !isEdge && process.env.NODE_ENV !== "test") {
  boot();
}
