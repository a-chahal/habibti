import { NextRequest, NextResponse } from "next/server";
import { getShipment, getLatestBelief } from "@/lib/db/queries";
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
    const belief = await getLatestBelief(params.id);
    return NextResponse.json({
      ...shipment,
      current_belief: belief ?? null,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
