import { NextRequest, NextResponse } from "next/server";
import { getShipment, getOptionsForShipment, getSupplier, getPrimaryPortForCountry } from "@/lib/db/queries";
import { resolvePortWithFallback } from "@/lib/sources/locations";
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

    const opts = await getOptionsForShipment(params.id);

    // Enrich each option with resolved port coordinates
    const enriched = await Promise.all(
      opts.map(async (opt) => {
        const supplier = opt.supplier_id ? await getSupplier(opt.supplier_id) : null;
        const routeData = (opt.route_data ?? {}) as Record<string, unknown>;

        // Resolve origin + destination coordinates
        const originCountry = opt.country ?? (routeData.origin_country as string) ?? shipment.origin_country ?? null;
        const destinationPort = shipment.destination_port ?? (routeData.destination_port as string) ?? null;

        let originCoords = null;
        let destinationCoords = null;

        if (originCountry) {
          const loc = await getPrimaryPortForCountry(originCountry);
          if (loc) originCoords = { name: loc.name, locode: loc.locode, lat: Number(loc.latitude), lng: Number(loc.longitude) };
        }
        if (destinationPort) {
          destinationCoords = await resolvePortWithFallback(destinationPort);
        }

        return {
          ...opt,
          supplier: supplier
            ? { id: supplier.id, name: supplier.name, country: supplier.country, verification_status: supplier.verification_status }
            : null,
          route_data: {
            ...routeData,
            origin: originCoords
              ? { name: originCoords.name, locode: originCoords.locode, lat: originCoords.lat, lng: originCoords.lng }
              : null,
            destination: destinationCoords
              ? { name: destinationCoords.name, locode: destinationCoords.locode, lat: destinationCoords.lat, lng: destinationCoords.lng }
              : null,
          },
        };
      })
    );

    return NextResponse.json(enriched);
  } catch (err: any) {
    console.error("[GET /api/shipments/:id/options]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
