import { NextRequest, NextResponse } from "next/server";
import { getShipment, getSignalsForShipment } from "@/lib/db/queries";
import "@/lib/boot";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const shipment = await getShipment(params.id);
    if (!shipment) {
      return NextResponse.json({ error: "Shipment not found" }, { status: 404 });
    }

    const sinceParam = req.nextUrl.searchParams.get("since");
    const since = sinceParam ? new Date(sinceParam) : undefined;
    if (since && isNaN(since.getTime())) {
      return NextResponse.json({ error: "Invalid 'since' timestamp" }, { status: 400 });
    }

    const rows = await getSignalsForShipment(params.id, since);
    return NextResponse.json(rows);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
