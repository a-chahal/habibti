import { NextRequest, NextResponse } from "next/server";
import { getShipment, getSignalsForShipment } from "@/lib/db/queries";
import "@/lib/boot";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const shipment = await getShipment(params.id);
    if (!shipment) {
      return NextResponse.json({ error: "Shipment not found" }, { status: 404 });
    }

    // Find the most recent vessel_position signal
    const signals = await getSignalsForShipment(params.id);
    const posSignal = signals.find((s) => s.signal_type === "vessel_position");

    if (!posSignal) {
      return NextResponse.json({ position: null, source: "replay" });
    }

    const p = (posSignal.payload ?? {}) as Record<string, unknown>;
    const trackIndex = typeof p.track_index === "number" ? p.track_index : 0;

    // Calculate route progress percentage based on track index out of 50 waypoints
    const routeProgressPct = Math.min(100, Math.round((trackIndex / 50) * 100));

    return NextResponse.json({
      lat: p.lat ?? null,
      lng: p.lon ?? null,
      heading: p.heading ?? null,
      speed: p.speed_knots ?? null,
      source: "replay" as const,
      last_updated: posSignal.recorded_at,
      route_progress_pct: routeProgressPct,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
