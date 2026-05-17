import { NextRequest, NextResponse } from "next/server";
import { dismissAlert } from "@/lib/db/queries";
import "@/lib/boot";

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const row = await dismissAlert(params.id);
    if (!row) {
      return NextResponse.json({ error: "Alert not found" }, { status: 404 });
    }
    return NextResponse.json({ id: row.id, status: row.status });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
