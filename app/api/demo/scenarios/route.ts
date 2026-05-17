import { NextResponse } from "next/server";
import { listShipments } from "@/lib/db/queries";
import "@/lib/boot";

// Pre-defined demo scenario metadata keyed by shipment intent keywords
const SCENARIO_META: Record<string, { title: string; description: string; badge: string }> = { // eslint-disable-line @typescript-eslint/no-explicit-any
  cotton: {
    title: "Sarah's Cotton Import",
    description: "5000 yards organic cotton fabric, Vietnam → Los Angeles",
    badge: "VN → USLAX",
  },
  cinnamon: {
    title: "Cinnamon Supply Chain",
    description: "Bulk spices, Indonesia → New York, Suez Canal route",
    badge: "ID → USNYC",
  },
  battery: {
    title: "EV Battery Components",
    description: "Lithium battery cells, China → Long Beach",
    badge: "CN → USLGB",
  },
};

export async function GET() {
  try {
    const all = await listShipments();

    // Return shipments that are in a demo-ready state
    const demos = all
      .filter((s) => s.status === "sourcing_complete" || s.status === "in_transit")
      .slice(0, 6)
      .map((s) => {
        const rawIntent =
          typeof s.intent === "object" && s.intent !== null
            ? (s.intent as Record<string, unknown>).raw ?? ""
            : s.intent ?? "";
        const intentStr = String(rawIntent).toLowerCase();

        // Match to a scenario
        let meta: { title: string; description: string; badge: string } = { title: "Demo Shipment", description: String(rawIntent), badge: s.status };
        for (const [key, m] of Object.entries(SCENARIO_META)) {
          if (intentStr.includes(key)) {
            meta = m;
            break;
          }
        }

        return {
          id: s.id,
          status: s.status,
          title: meta.title,
          description: meta.description,
          badge: meta.badge,
          origin_country: s.origin_country,
          destination_port: s.destination_port,
          created_at: s.created_at,
        };
      });

    return NextResponse.json(demos);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
