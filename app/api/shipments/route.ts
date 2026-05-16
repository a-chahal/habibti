import { NextRequest, NextResponse } from "next/server";
import { createShipment, listShipments } from "@/lib/db/queries";
import { emit } from "@/lib/events/emitter";
import "@/lib/boot";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { intent } = body as { intent?: string };

    if (!intent || typeof intent !== "string" || intent.trim().length === 0) {
      return NextResponse.json({ error: "intent is required" }, { status: 400 });
    }

    const shipment = await createShipment({
      status: "draft",
      intent: { raw: intent.trim() } as any,
    });

    emit("SHIPMENT_NEW", {
      shipmentId: shipment.id,
    });

    return NextResponse.json({ id: shipment.id, status: shipment.status }, { status: 201 });
  } catch (err: any) {
    console.error("[POST /api/shipments]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET() {
  try {
    const rows = await listShipments();
    return NextResponse.json(rows);
  } catch (err: any) {
    console.error("[GET /api/shipments]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
