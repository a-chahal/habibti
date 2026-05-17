import { NextRequest, NextResponse } from "next/server";
import { getShipment, listAlerts } from "@/lib/db/queries";
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
    const includeDismissed = req.nextUrl.searchParams.get("include_dismissed") === "true";
    const rows = await listAlerts(params.id, includeDismissed);
    return NextResponse.json(rows);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
