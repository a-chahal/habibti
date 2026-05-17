"use client";
import { create } from "zustand";

export interface Signal {
  id: string;
  shipment_id: string | null;
  agent_name: string;
  signal_type: string;
  severity: string;
  payload: Record<string, unknown> | null;
  citations: unknown[] | null;
  confidence: string | null;
  occurred_at: string;
  recorded_at: string;
}

interface SignalsState {
  signals: Signal[];
  lastFetchedAt: string | null;

  setSignals: (signals: Signal[]) => void;
  appendSignals: (incoming: Signal[]) => void;
  setLastFetchedAt: (ts: string) => void;
  reset: () => void;
}

export const useSignalsStore = create<SignalsState>((set, get) => ({
  signals: [],
  lastFetchedAt: null,

  setSignals: (signals) =>
    set({
      signals: [...signals].sort(
        (a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()
      ),
    }),

  appendSignals: (incoming) => {
    const existing = get().signals;
    const existingIds = new Set(existing.map((s) => s.id));
    const novel = incoming.filter((s) => !existingIds.has(s.id));
    if (novel.length === 0) return;
    const merged = [...novel, ...existing].sort(
      (a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()
    );
    set({ signals: merged });
  },

  setLastFetchedAt: (ts) => set({ lastFetchedAt: ts }),

  reset: () => set({ signals: [], lastFetchedAt: null }),
}));
