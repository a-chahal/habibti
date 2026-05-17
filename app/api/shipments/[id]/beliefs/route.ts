import { NextRequest, NextResponse } from "next/server";
import { getShipment, getBeliefHistory } from "@/lib/db/queries";
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
    const history = await getBeliefHistory(params.id);
    return NextResponse.json(history);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
