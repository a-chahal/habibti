import { create } from 'zustand';
import type { MapArc, MapMarker } from '@/components/WorldMap';

interface MapState {
  arcs: MapArc[];
  markers: MapMarker[];
  mode: "sourcing" | "monitoring";
  activeArcId?: string;
  vesselPosition?: { lat: number; lng: number; heading?: number | null } | null;
  onArcClick?: (optionId: string, arcId: string) => void;
  // ─── Globe animation state ───────────────────────────────────────────────────
  globeZoom: number;       // CSS scale applied to the fixed background div (1 = normal)
  globeSpinBoost: number;  // Multiplier on the 0.003 base rotation speed (1 = normal)
  // ────────────────────────────────────────────────────────────────────────────

  setMapState: (state: Partial<Omit<MapState, "setMapState" | "resetMapState">>) => void;
  resetMapState: () => void;
}

export const useMapStore = create<MapState>((set) => ({
  arcs: [],
  markers: [],
  mode: "sourcing",
  activeArcId: undefined,
  vesselPosition: null,
  onArcClick: undefined,
  globeZoom: 1,
  globeSpinBoost: 1,

  setMapState: (state) => set((prev) => ({ ...prev, ...state })),
  resetMapState: () => set({
    arcs: [],
    markers: [],
    mode: "sourcing",
    activeArcId: undefined,
    vesselPosition: null,
    onArcClick: undefined,
    globeZoom: 1,
    globeSpinBoost: 1,
  }),
}));
