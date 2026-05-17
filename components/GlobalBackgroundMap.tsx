"use client";

import React, { useEffect } from "react";
import { useMapStore } from "@/lib/stores/mapStore";
import WorldMap from "@/components/WorldMap";
import { usePathname } from "next/navigation";

export default function GlobalBackgroundMap() {
  const { arcs, markers, mode, activeArcId, vesselPosition, onArcClick, resetMapState } = useMapStore();
  const pathname = usePathname();

  // Optionally clear map state when navigating back to home
  useEffect(() => {
    if (pathname === "/") {
      resetMapState();
    }
  }, [pathname, resetMapState]);

  return (
    <div className="fixed inset-0 z-0 pointer-events-auto bg-[#0a0a0a]">
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
