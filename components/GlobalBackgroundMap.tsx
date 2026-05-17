"use client";

import React, { useEffect } from "react";
import { useMapStore } from "@/lib/stores/mapStore";
import WorldMap from "@/components/WorldMap";
import { usePathname } from "next/navigation";

export default function GlobalBackgroundMap() {
  const { arcs, markers, mode, activeArcId, vesselPosition, onArcClick, resetMapState, globeZoom } = useMapStore();
  const pathname = usePathname();

  // Optionally clear map state when navigating back to home
  useEffect(() => {
    if (pathname === "/") {
      resetMapState();
    }
  }, [pathname, resetMapState]);

  return (
    <div
      className="fixed inset-0 z-0 pointer-events-auto bg-[#0a0a0a]"
      style={{
        transform: `scale(${globeZoom})`,
        // ease-out feels natural: snappy zoom-out when submitting
        transition: "transform 1.2s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
        transformOrigin: "center center",
      }}
    >
      <WorldMap
        arcs={arcs}
        markers={markers}
        mode={mode}
        activeArcId={activeArcId}
        vesselPosition={vesselPosition}
        onArcClick={onArcClick}
      />
    </div>
  );
}
