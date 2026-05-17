"use client";

import dynamic from "next/dynamic";

const ThreeJSGlobeWithDots = dynamic(
  () => import("@/components/map/ThreeJSGlobeWithDots"),
  { ssr: false }
);

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  color: string;
  size?: number;
  pulsing?: boolean;
}

export interface MapArc {
  id: string;
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
  risk?: "low" | "medium" | "high";
  active?: boolean;
}

interface WorldMapProps {
  markers?: MapMarker[];
  arcs?: MapArc[];
  mode: "sourcing" | "monitoring";
  activeArcId?: string;
  vesselPosition?: { lat: number; lng: number; heading?: number | null } | null;
}

const RISK_COLORS: Record<string, string> = {
  low: "#ffffff",
  medium: "#f59e0b",
  high: "#ef4444",
};

export default function WorldMap({
  markers = [],
  arcs = [],
  mode,
  activeArcId,
  vesselPosition,
}: WorldMapProps) {
  const routes = arcs.map((arc) => ({
    lat1: arc.lat1,
    lon1: arc.lon1,
    lat2: arc.lat2,
    lon2: arc.lon2,
    color: RISK_COLORS[arc.risk ?? "low"] ?? "#ffffff",
  }));

  const globeMarkers = [
    ...markers.map((m) => ({
      id: m.id,
      lat: m.lat,
      lon: m.lng,
      color: m.color,
      size: m.size,
      pulsing: m.pulsing,
    })),
    ...(vesselPosition
      ? [
          {
            id: "vessel",
            lat: vesselPosition.lat,
            lon: vesselPosition.lng,
            color: "#00ffff",
            size: 0.022,
            pulsing: true,
          },
        ]
      : []),
  ];

  return (
    <div className="relative w-full h-full bg-[#0a0a0a]">
      <ThreeJSGlobeWithDots
        routes={routes}
        markers={globeMarkers}
        arcHeightMultiplier={0.4}
        routeThickness={0.005}
      />
    </div>
  );
}
