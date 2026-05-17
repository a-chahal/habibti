"use client";
import { create } from "zustand";

export interface Belief {
  id: string;
  shipment_id: string;
  version: number;
  risk_level: string;
  narrative: string | null;
  current_eta: string | null;
  supporting_signal_ids: string[] | null;
  created_at: string;
}

interface BeliefsState {
  current: Belief | null;
  history: Belief[];

  setBeliefs: (beliefs: Belief[]) => void;
  reset: () => void;
}

export const useBeliefsStore = create<BeliefsState>((set) => ({
  current: null,
  history: [],

  setBeliefs: (beliefs) => {
    const sorted = [...beliefs].sort((a, b) => b.version - a.version);
    set({ current: sorted[0] ?? null, history: sorted });
  },

  reset: () => set({ current: null, history: [] }),
}));
