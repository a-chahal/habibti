import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getShipment, getOptionsForShipment, updateShipment } from "@/lib/db/queries";
import { emit } from "@/lib/events/emitter";
import "@/lib/boot";

const ConfirmBody = z.object({
  option_id: z.string().uuid(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json();
    const parsed = ConfirmBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    }

    const shipment = await getShipment(params.id);
    if (!shipment) {
      return NextResponse.json({ error: "Shipment not found" }, { status: 404 });
    }
    if (shipment.status !== "sourcing_complete") {
      return NextResponse.json(
        { error: `Shipment status is '${shipment.status}', expected 'sourcing_complete'` },
        { status: 409 }
      );
    }

    const opts = await getOptionsForShipment(params.id);
    const chosen = opts.find((o) => o.id === parsed.data.option_id);
    if (!chosen) {
      return NextResponse.json({ error: "Option not found for this shipment" }, { status: 404 });
    }

    const routeData = chosen.route_data as Record<string, unknown> | null;
    const updated = await updateShipment(params.id, {
      status: "in_transit",
      supplier_id: chosen.supplier_id ?? undefined,
      origin_country: chosen.country ?? undefined,
      expected_eta: chosen.eta ?? undefined,
      current_eta: chosen.eta ?? undefined,
    });

    emit("SHIPMENT_CONFIRMED", {
      shipmentId: params.id,
      vesselMmsi: undefined,
    });

    return NextResponse.json({
      shipment_id: params.id,
      status: updated.status,
      option_id: chosen.id,
      route_data: routeData,
      eta: chosen.eta,
    });
  } catch (err: any) {
    console.error("[POST /api/shipments/:id/confirm]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
