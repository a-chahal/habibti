"use client";
import { useEffect, useRef, useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useShipmentStore } from "@/lib/stores/shipmentStore";
import { useSignalsStore } from "@/lib/stores/signalsStore";
import { useBeliefsStore } from "@/lib/stores/beliefsStore";
import { useAlertsStore } from "@/lib/stores/alertsStore";

const BASE_INTERVAL_MS = 1500;
const BACKOFF_STEPS_MS = [1500, 3000, 6000, 12000];
const MAX_BACKOFF_MS = 12000;

export interface PollingState {
  isPolling: boolean;
  lastError: string | null;
  lastSuccessAt: Date | null;
}

export function usePolling(shipmentId: string | null): PollingState {
  const router = useRouter();
  const [isPolling, setIsPolling] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<Date | null>(null);

  const consecutiveErrors = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadDone = useRef(false);

  const { setShipment, setOptions, setVesselPosition } = useShipmentStore();
  const { setSignals, appendSignals, setLastFetchedAt, lastFetchedAt } = useSignalsStore();
  const { setBeliefs } = useBeliefsStore();
  const { setAlerts } = useAlertsStore();

  const shipmentStatus = useShipmentStore((s) => s.status);

  const poll = useCallback(async () => {
    if (!shipmentId) return;
    if (document.visibilityState !== "visible") return;

    try {
      // 1. Snapshot
      const snapshotRes = await fetch(`/api/shipments/${shipmentId}`);
      if (snapshotRes.status === 404) {
        // Shipment was deleted (e.g. DB reset) — go home
        router.replace("/");
        return;
      }
      if (!snapshotRes.ok) throw new Error(`Snapshot ${snapshotRes.status}`);
      const snapshot = await snapshotRes.json();
      setShipment({
        id: snapshot.id,
        status: snapshot.status,
        intent: snapshot.intent,
        origin_country: snapshot.origin_country,
        origin_port: snapshot.origin_port,
        destination_port: snapshot.destination_port,
        hs_code: snapshot.hs_code,
        expected_eta: snapshot.expected_eta,
        current_eta: snapshot.current_eta ?? snapshot.expected_eta,
        current_belief: snapshot.current_belief ?? null,
      });

      // 2. Options — fetch during all active states so routes appear progressively on the globe
      if (
        snapshot.status === "draft" ||
        snapshot.status === "pending" ||
        snapshot.status === "sourcing_complete" ||
        snapshot.status === "in_transit" ||
        snapshot.status === "delayed"
      ) {
        const optsRes = await fetch(`/api/shipments/${shipmentId}/options`);
        if (optsRes.ok) {
          const opts = await optsRes.json();
          setOptions(opts);
        }
      }

      // 3. Signals — incremental after first load
      const sinceParam = initialLoadDone.current && lastFetchedAt
        ? `?since=${encodeURIComponent(lastFetchedAt)}`
        : "";
      const sigRes = await fetch(`/api/shipments/${shipmentId}/signals${sinceParam}`);
      if (sigRes.ok) {
        const sigs = await sigRes.json();
        if (initialLoadDone.current) {
          appendSignals(sigs);
        } else {
          setSignals(sigs);
        }
        setLastFetchedAt(new Date().toISOString());
      }

      // 4. Beliefs
      const beliefsRes = await fetch(`/api/shipments/${shipmentId}/beliefs`);
      if (beliefsRes.ok) {
        const beliefs = await beliefsRes.json();
        setBeliefs(beliefs);
      }

      // 5. Alerts
      const alertsRes = await fetch(`/api/shipments/${shipmentId}/alerts`);
      if (alertsRes.ok) {
        const alerts = await alertsRes.json();
        setAlerts(alerts);
      }

      // 6. Vessel position — only when in transit
      if (snapshot.status === "in_transit" || snapshot.status === "delayed") {
        const posRes = await fetch(`/api/shipments/${shipmentId}/vessel-position`);
        if (posRes.ok) {
          const pos = await posRes.json();
          setVesselPosition(pos.lat != null ? pos : null);
        }
      }

      initialLoadDone.current = true;
      consecutiveErrors.current = 0;
      setLastError(null);
      setLastSuccessAt(new Date());
    } catch (err: any) {
      consecutiveErrors.current++;
      setLastError(err.message ?? "Unknown polling error");
    }
  }, [shipmentId, lastFetchedAt, setShipment, setOptions, setSignals, appendSignals, setLastFetchedAt, setBeliefs, setAlerts, setVesselPosition]);

  useEffect(() => {
    if (!shipmentId) return;

    setIsPolling(true);
    initialLoadDone.current = false;

    const schedule = () => {
      const errCount = consecutiveErrors.current;
      const delayMs =
        errCount === 0
          ? BASE_INTERVAL_MS
          : Math.min(BACKOFF_STEPS_MS[errCount - 1] ?? MAX_BACKOFF_MS, MAX_BACKOFF_MS);

      timerRef.current = setTimeout(async () => {
        await poll();
        schedule();
      }, delayMs);
    };

    // Fire immediately, then schedule
    poll().then(schedule);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        poll();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      setIsPolling(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [shipmentId, poll]);

  // Stop polling when shipment reaches terminal state
  useEffect(() => {
    if (shipmentStatus === "arrived" || shipmentStatus === "cancelled") {
      setIsPolling(false);
      if (timerRef.current) clearTimeout(timerRef.current);
    }
  }, [shipmentStatus]);

  return { isPolling, lastError, lastSuccessAt };
}
