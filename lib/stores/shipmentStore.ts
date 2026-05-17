"use client";
import { create } from "zustand";

export interface VesselPosition {
  lat: number | null;
  lng: number | null;
  heading: number | null;
  speed: number | null;
  source: "live_ais" | "replay";
  last_updated: string | null;
  route_progress_pct: number | null;
}

export interface ShipmentOption {
  id: string;
  rank: number;
  country: string | null;
  supplier: { id: string; name: string; country: string | null; verification_status: string } | null;
  route_data: Record<string, unknown> | null;
  cost_breakdown: Record<string, unknown> | null;
  eta: string | null;
  risk_summary: Record<string, unknown> | null;
  reasoning: string | null;
}

export interface ShipmentState {
  id: string | null;
  status: string | null;
  intent: Record<string, unknown> | null;
  origin_country: string | null;
  origin_port: string | null;
  destination_port: string | null;
  hs_code: string | null;
  expected_eta: string | null;
  current_eta: string | null;
  current_belief: {
    id: string;
    version: number;
    risk_level: string;
    narrative: string | null;
    current_eta: string | null;
  } | null;
  options: ShipmentOption[];
  vesselPosition: VesselPosition | null;

  setShipment: (data: Partial<ShipmentState>) => void;
  setOptions: (options: ShipmentOption[]) => void;
  setVesselPosition: (pos: VesselPosition | null) => void;
  reset: () => void;
}

const initialState = {
  id: null,
  status: null,
  intent: null,
  origin_country: null,
  origin_port: null,
  destination_port: null,
  hs_code: null,
  expected_eta: null,
  current_eta: null,
  current_belief: null,
  options: [],
  vesselPosition: null,
};

export const useShipmentStore = create<ShipmentState>((set) => ({
  ...initialState,
  setShipment: (data) => set((s) => ({ ...s, ...data })),
  setOptions: (options) => set({ options }),
  setVesselPosition: (pos) => set({ vesselPosition: pos }),
  reset: () => set(initialState),
}));
