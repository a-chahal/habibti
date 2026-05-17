"use client";
import { create } from "zustand";

export interface Alert {
  id: string;
  shipment_id: string;
  belief_id: string | null;
  alert_type: string;
  headline: string;
  full_narrative: string | null;
  draft_email: string | null;
  status: string;
  created_at: string;
  acknowledged_at: string | null;
}

interface AlertsState {
  alerts: Alert[];
  dismissedIds: Set<string>;

  setAlerts: (alerts: Alert[]) => void;
  localDismiss: (id: string) => void;
  reset: () => void;
}

export const useAlertsStore = create<AlertsState>((set, get) => ({
  alerts: [],
  dismissedIds: new Set(),

  setAlerts: (alerts) => {
    const dismissed = get().dismissedIds;
    const active = alerts.filter((a) => a.status !== "dismissed" && !dismissed.has(a.id));
    set({ alerts: active });
  },

  localDismiss: (id) => {
    const dismissed = new Set(get().dismissedIds);
    dismissed.add(id);
    set({
      dismissedIds: dismissed,
      alerts: get().alerts.filter((a) => a.id !== id),
    });
  },

  reset: () => set({ alerts: [], dismissedIds: new Set() }),
}));
