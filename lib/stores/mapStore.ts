import { create } from 'zustand';
import type { MapArc, MapMarker } from '@/components/WorldMap';

interface MapState {
  arcs: MapArc[];
  markers: MapMarker[];
  mode: "sourcing" | "monitoring";
  activeArcId?: string;
  vesselPosition?: { lat: number; lng: number; heading?: number | null } | null;
  onArcClick?: (optionId: string, arcId: string) => void;
  
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

  setMapState: (state) => set((prev) => ({ ...prev, ...state })),
  resetMapState: () => set({
    arcs: [],
    markers: [],
    mode: "sourcing",
    activeArcId: undefined,
    vesselPosition: null,
    onArcClick: undefined,
  }),
}));
