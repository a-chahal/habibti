import { NextResponse } from "next/server";
import { createSignal } from "../../../../lib/db/queries";
import { emit } from "../../../../lib/events/emitter";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { shipment_id, signal_type, severity, payload, citations, agent_name } =
    body as Record<string, unknown>;

  if (!shipment_id || typeof shipment_id !== "string") {
    return NextResponse.json({ error: "shipment_id required" }, { status: 400 });
  }
  if (!signal_type || typeof signal_type !== "string") {
    return NextResponse.json({ error: "signal_type required" }, { status: 400 });
  }

  const validSeverities = ["info", "low", "medium", "high", "critical"];
  const sev = (typeof severity === "string" && validSeverities.includes(severity))
    ? (severity as "info" | "low" | "medium" | "high" | "critical")
    : "medium" as const;

  const signal = await createSignal({
    shipment_id,
    agent_name: typeof agent_name === "string" ? agent_name : "demo-injector",
    signal_type,
    severity: sev,
    payload: (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>,
    citations: Array.isArray(citations) ? citations : [],
    occurred_at: new Date(),
  });

  emit("SIGNAL_NEW", {
    signalId: signal.id,
    shipmentId: shipment_id,
    agentName: signal.agent_name,
    signalType: signal_type,
    severity: sev,
  });

  return NextResponse.json({ id: signal.id, shipment_id, signal_type, severity: sev });
}
