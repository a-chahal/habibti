"use client";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";
import { usePolling } from "@/lib/hooks/usePolling";
import { useShipmentStore } from "@/lib/stores/shipmentStore";
import { useSignalsStore } from "@/lib/stores/signalsStore";
import { useBeliefsStore } from "@/lib/stores/beliefsStore";
import { useAlertsStore } from "@/lib/stores/alertsStore";
import AgentPanel from "@/components/AgentPanel";
import RouteDetailPanel from "@/components/RouteDetailPanel";
import InProgressRoutePanel from "@/components/InProgressRoutePanel";
import HandoffAnimation from "@/components/HandoffAnimation";
import AlertCard from "@/components/AlertCard";
import EmailCard from "@/components/EmailCard";
import { useMapStore } from "@/lib/stores/mapStore";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RISK_COLORS_HEX: Record<string, string> = {
  low: "#ffffff",
  medium: "#f59e0b",
  high: "#ef4444",
};

// Port lat/lon for major exporting countries — used to draw candidate arcs from route_prescore signals
const COUNTRY_PORT: Record<string, { lat: number; lon: number }> = {
  CN: { lat: 31.23, lon: 121.47 },  // Shanghai
  VN: { lat: 10.82, lon: 106.63 }, // Ho Chi Minh
  IN: { lat: 18.93, lon: 72.84 },  // Mumbai
  BD: { lat: 22.35, lon: 91.82 },  // Chittagong
  TH: { lat: 13.09, lon: 100.60 }, // Bangkok
  ID: { lat: -6.09, lon: 106.88 }, // Jakarta
  MY: { lat: 3.10,  lon: 101.59 }, // Klang
  KR: { lat: 37.45, lon: 126.69 }, // Incheon
  JP: { lat: 35.45, lon: 139.64 }, // Yokohama
  TW: { lat: 25.15, lon: 121.77 }, // Keelung
  MX: { lat: 20.96, lon: -97.35 }, // Veracruz
  DE: { lat: 53.55, lon: 9.99 },   // Hamburg
  TR: { lat: 41.01, lon: 28.98 },  // Istanbul
  BR: { lat: -23.96, lon: -46.33 }, // Santos
  PK: { lat: 24.86, lon: 67.01 },  // Karachi
  KH: { lat: 10.62, lon: 103.50 }, // Sihanoukville
  LK: { lat: 6.93,  lon: 79.85 },  // Colombo
  PH: { lat: 14.54, lon: 120.98 }, // Manila
  HK: { lat: 22.29, lon: 114.16 }, // Hong Kong
  SG: { lat: 1.29,  lon: 103.82 }, // Singapore
};

// Destination port coords for common US gateway ports
const DEST_PORT: Record<string, { lat: number; lon: number }> = {
  USLAX: { lat: 33.74,  lon: -118.26 },
  USLGB: { lat: 33.76,  lon: -118.19 },
  USSEA: { lat: 47.61,  lon: -122.33 },
  USNYC: { lat: 40.64,  lon: -74.04  },
  USHOU: { lat: 29.73,  lon: -94.98  },
  USSAV: { lat: 32.08,  lon: -81.09  },
};

function guessDestPort(locode: string | null | undefined): { lat: number; lon: number } {
  if (locode) {
    const key = locode.toUpperCase().replace(/\s/g, "");
    if (DEST_PORT[key]) return DEST_PORT[key];
  }
  return DEST_PORT.USLAX; // sensible default
}

const LOADING_MESSAGES = [
  "Analyzing candidate suppliers across 6 countries…",
  "Cross-referencing tariff schedules…",
  "Checking sanctions lists…",
  "Computing landed cost scenarios…",
  "Assessing chokepoint risk…",
  "Verifying supplier registry entries…",
  "Calculating Section 301 exposure…",
  "Ranking options by risk-adjusted cost…",
];

function useLoadingMessage() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIdx(i => (i + 1) % LOADING_MESSAGES.length), 3200);
    return () => clearInterval(t);
  }, []);
  return LOADING_MESSAGES[idx];
}

// ─── Mobile fallback ──────────────────────────────────────────────────────────

function MobileFallback() {
  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-8">
      <div className="text-center max-w-sm">
        <div className="text-white/20 text-sm mb-3 font-mono">habibti</div>
        <p className="text-white/60 text-base leading-relaxed">
          This experience is designed for desktop.
          <br />Please view on a larger screen.
        </p>
      </div>
    </div>
  );
}

// ─── Timeline bar ─────────────────────────────────────────────────────────────

function TimelineBar({ progress }: { progress: number | null }) {
  const pct = Math.max(0, Math.min(100, progress ?? 0));
  return (
    <div className="h-10 bg-[#080c18] border-t border-white/5 flex items-center px-6 gap-4">
      <span className="text-[10px] font-mono text-white/25 uppercase tracking-widest w-14">Origin</span>
      <div className="flex-1 relative h-1 bg-white/5 rounded-full">
        <div
          className="absolute left-0 top-0 h-full bg-white/40 rounded-full transition-all duration-1000"
          style={{ width: `${pct}%` }}
        />
        {/* Vessel dot */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)] transition-all duration-1000"
          style={{ left: `calc(${pct}% - 6px)` }}
        />
      </div>
      <span className="text-[10px] font-mono text-white/25 uppercase tracking-widest text-right w-14">Dest</span>
      {progress != null && (
        <span className="text-[10px] font-mono text-cyan-400/60">{Math.round(pct)}%</span>
      )}
    </div>
  );
}

// ─── Phase header ─────────────────────────────────────────────────────────────

function ResetButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");

  const handleReset = async () => {
    if (state === "busy") return;
    setState("busy");
    try {
      await fetch("/api/reset", { method: "POST" });
      setState("done");
      setTimeout(() => router.replace("/"), 600);
    } catch {
      setState("idle");
    }
  };

  return (
    <button
      onClick={handleReset}
      disabled={state === "busy"}
      className="text-[10px] font-mono text-white/15 hover:text-white/40 transition-colors disabled:opacity-30 ml-2"
      title="Reset database and start over"
    >
      {state === "busy" ? "resetting…" : state === "done" ? "✓" : "reset db"}
    </button>
  );
}

function PhaseHeader({
  status,
  currentEta,
  isPolling,
  lastError,
  id,
  belief,
}: {
  status: string | null;
  currentEta: string | null;
  isPolling: boolean;
  lastError: string | null;
  id: string;
  belief: any;
}) {
  const phaseLabel =
    status === "sourcing_complete" ? "OPTIONS READY" :
    status === "in_transit" ? "IN TRANSIT" :
    status === "delayed" ? "DELAYED" :
    status === "arrived" ? "ARRIVED" :
    "SOURCING";

  const etaStr = (currentEta ?? belief?.current_eta)
    ? new Date((currentEta ?? belief?.current_eta)!).toLocaleDateString("en-US", {
        month: "long", day: "numeric", year: "numeric"
      })
    : null;

  const RISK_LABEL: Record<string, string> = {
    low: "text-green-400",
    medium: "text-yellow-400",
    high: "text-orange-400",
    critical: "text-red-400",
  };

  return (
    <div className="h-12 bg-[#060910] border-b border-white/5 flex items-center px-4 gap-4 shrink-0">
      <a href="/" className="text-[10px] font-mono text-white/20 hover:text-white/50 transition-colors">
        ← habibti
      </a>
      <ResetButton />
      <div className="h-4 w-px bg-white/10" />

      <span className={`text-[10px] font-mono px-2 py-0.5 rounded tracking-wider ${
        status === "in_transit" ? "bg-blue-900/60 text-blue-300" :
        status === "delayed" ? "bg-orange-900/60 text-orange-300" :
        status === "sourcing_complete" ? "bg-purple-900/60 text-purple-300" :
        status === "arrived" ? "bg-green-900/60 text-green-300" :
        "bg-white/5 text-white/30"
      }`}>
        {phaseLabel}
      </span>

      {etaStr && (
        <>
          <div className="h-4 w-px bg-white/10" />
          <span className="text-xs text-white/50">ETA: <strong className="text-white/80">{etaStr}</strong></span>
        </>
      )}

      {belief?.risk_level && (
        <>
          <div className="h-4 w-px bg-white/10" />
          <span className={`text-[10px] font-mono ${RISK_LABEL[belief.risk_level] ?? "text-white/40"}`}>
            risk: {belief.risk_level}
          </span>
        </>
      )}

      <div className="ml-auto flex items-center gap-3">
        <span className="text-[10px] font-mono text-white/20">{id.slice(0, 8)}</span>
        {isPolling && (
          <span className="flex items-center gap-1 text-[10px] text-white/25">
            <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse inline-block" />
            live
          </span>
        )}
        {lastError && <span className="text-[10px] text-red-400/70 font-mono">⚠ {lastError}</span>}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ShipmentPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const { isPolling, lastError } = usePolling(id);
  const loadingMsg = useLoadingMessage();

  const shipment = useShipmentStore();
  const { signals } = useSignalsStore();
  const { current: belief } = useBeliefsStore();
  const { alerts } = useAlertsStore();

  const status = shipment.status;
  const isSourceing = !status || status === "draft" || status === "pending";
  const isSourcingComplete = status === "sourcing_complete";
  const isInTransit = status === "in_transit" || status === "delayed";

  // Panel state
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [activeArcId, setActiveArcId] = useState<string | null>(null);
  const [selectedRouteSignal, setSelectedRouteSignal] = useState<any | null>(null);
  const [handoffActive, setHandoffActive] = useState(false);
  const [emailAlert, setEmailAlert] = useState<any | null>(null);

  // Reset on unmount
  useEffect(() => {
    return () => {
      useShipmentStore.getState().reset();
      useSignalsStore.getState().reset();
      useBeliefsStore.getState().reset();
      useAlertsStore.getState().reset();
    };
  }, [id]);

  // Auto-show first alert when in transit
  const firstAlert = alerts[0] ?? null;

  // Normalise origin/destination across old and new route_data shapes
  const getOrigin = (rd: any) => {
    if (!rd) return null;
    if (rd.origin_port?.lat != null) return { lat: rd.origin_port.lat, lon: rd.origin_port.lon, locode: rd.origin_port.locode };
    if (rd.origin?.lat != null) return { lat: rd.origin.lat, lon: rd.origin.lng ?? rd.origin.lon, locode: rd.origin.locode };
    return null;
  };
  const getDest = (rd: any) => {
    if (!rd) return null;
    if (rd.destination_port?.lat != null) return { lat: rd.destination_port.lat, lon: rd.destination_port.lon, locode: rd.destination_port.locode };
    if (rd.destination?.lat != null) return { lat: rd.destination.lat, lon: rd.destination.lng ?? rd.destination.lon, locode: rd.destination.locode };
    return null;
  };

  // Build map arcs — candidate arcs from signals + confirmed option arcs
  const mapArcs = useMemo(() => {
    const buildLegsForOption = (opt: any, active: boolean) => {
      const rd = opt.route_data as any;
      const overall = (opt.risk_summary as any)?.overall ?? "low";
      const legs: any[] = rd?.legs ?? [];
      const opacityBase = active ? 0.95 : 0.6;

      // New shape: emit one arc per leg
      if (legs.length > 0) {
        return legs
          .map((leg: any, i: number) => {
            const from = leg.from, to = leg.to;
            if (from?.lat == null || to?.lat == null) return null;
            const legSev = leg.risk_severity && leg.risk_severity !== "none" ? leg.risk_severity : overall;
            return {
              id: `${opt.id}-leg-${i}`,
              optionId: opt.id,
              lat1: from.lat,
              lon1: from.lon ?? from.lng,
              lat2: to.lat,
              lon2: to.lon ?? to.lng,
              risk: legSev as "low" | "medium" | "high",
              active,
              opacity: opacityBase,
            };
          })
          .filter((a): a is NonNullable<typeof a> => a !== null);
      }

      // Old shape fallback: single origin → destination
      const origin = getOrigin(rd);
      const dest = getDest(rd);
      if (!origin || !dest) return [];
      return [{
        id: opt.id,
        optionId: opt.id,
        lat1: origin.lat,
        lon1: origin.lon,
        lat2: dest.lat,
        lon2: dest.lon,
        risk: overall as "low" | "medium" | "high",
        active,
        opacity: opacityBase,
      }];
    };

    if (isInTransit) {
      const sel = shipment.options.find(o => o.id === selectedOptionId) ?? shipment.options[0];
      if (!sel) return [];
      return buildLegsForOption(sel, true);
    }

    // Candidate, Refined, and Discarded arcs from route_discovered signals — shown progressively during sourcing
    // Once sourcing completes and the final three options are presented, drop these to avoid stale blue lines.
    const candidateArcs: any[] = [];
    if (isSourceing) {
      // Find all route_discovered signals
      const routeDiscoveredSignals = signals.filter(s => s.signal_type === "route_discovered");

      // Group by ID to ensure we only render the latest status for each route candidate
      const latestSignalsMap = new Map<string, typeof routeDiscoveredSignals[number]>();
      routeDiscoveredSignals.forEach(sig => {
        const payload = sig.payload as any;
        const id = payload?.id || `cand-${payload?.country_code}`;
        if (!latestSignalsMap.has(id)) {
          latestSignalsMap.set(id, sig);
        } else {
          // If we find a newer state (e.g. status: refined or status: discarded is more recent than status: candidate),
          // keep the most recently recorded or higher-priority status.
          const existing = latestSignalsMap.get(id)!.payload as any;
          if (payload.status === "discarded" || (payload.status === "refined" && existing.status === "candidate")) {
            latestSignalsMap.set(id, sig);
          }
        }
      });

      latestSignalsMap.forEach((sig) => {
        const p = sig.payload as any;
        const status = p.status as "candidate" | "refined" | "discarded";
        const routeData = p.route;
        const legs = routeData?.legs ?? [];
        const countryCode = p.country_code;

        // Custom styling based on progressive status
        let color = "#818cf8"; // indigo-400 for candidate
        let opacity = 0.25;
        if (status === "refined") {
          color = "#22d3ee"; // cyan-400 for refined
          opacity = 0.5;
        } else if (status === "discarded") {
          color = "#ef4444"; // red-500 for discarded
          opacity = 0.15;
        }

        const arcId = p.id || `cand-${countryCode}`;

        if (legs.length > 0) {
          legs.forEach((leg: any, idx: number) => {
            if (leg.from?.lat != null && leg.to?.lat != null) {
              candidateArcs.push({
                id: arcId, // link back to the signal ID for click detection
                optionId: undefined, // this is in-progress, not a finalized option card
                lat1: leg.from.lat,
                lon1: leg.from.lon ?? leg.from.lng,
                lat2: leg.to.lat,
                lon2: leg.to.lon ?? leg.to.lng,
                active: false,
                opacity,
                color,
              });
            }
          });
        } else if (p.lat1 != null && p.lat2 != null) {
          // Simple direct arc fallback
          candidateArcs.push({
            id: arcId,
            optionId: undefined,
            lat1: p.lat1,
            lon1: p.lon1,
            lat2: p.lat2,
            lon2: p.lon2,
            active: false,
            opacity,
            color,
          });
        }
      });

      // Keep support for legacy route_prescore signals just in case
      const seenCountries = new Set<string>();
      signals
        .filter(s => s.signal_type === "route_prescore")
        .forEach(sig => {
          const p = sig.payload as any;
          const countryCode = (p?.origin_country ?? "").toUpperCase().slice(0, 2);
          const destLocode = (p?.destination_port ?? "").toUpperCase();
          if (!countryCode || seenCountries.has(countryCode)) return;
          seenCountries.add(countryCode);

          const srcPort = COUNTRY_PORT[countryCode];
          const dstPort = guessDestPort(destLocode);
          if (!srcPort) return;

          // Only add if not already covered by our premium route_discovered signals
          if (latestSignalsMap.has(`cand-${countryCode}`) || latestSignalsMap.has(`refined-${countryCode}-${p.origin_port}`)) return;

          const routes: any[] = p?.routes ?? [];
          const waypoints: any[] = routes[0]?.waypoints ?? [];

          if (waypoints.length >= 2) {
            for (let i = 0; i < waypoints.length - 1; i++) {
              candidateArcs.push({
                id: `cand-${countryCode}`,
                optionId: undefined,
                lat1: waypoints[i].lat,
                lon1: waypoints[i].lon,
                lat2: waypoints[i + 1].lat,
                lon2: waypoints[i + 1].lon,
                risk: "low" as const,
                active: false,
                opacity: 0.18,
              });
            }
            candidateArcs.push({
              id: `cand-${countryCode}`,
              optionId: undefined,
              lat1: srcPort.lat,
              lon1: srcPort.lon,
              lat2: waypoints[0].lat,
              lon2: waypoints[0].lon,
              risk: "low" as const,
              active: false,
              opacity: 0.18,
            });
          } else {
            candidateArcs.push({
              id: `cand-${countryCode}`,
              optionId: undefined,
              lat1: srcPort.lat,
              lon1: srcPort.lon,
              lat2: dstPort.lat,
              lon2: dstPort.lon,
              risk: "low" as const,
              active: false,
              opacity: 0.18,
            });
          }
        });
    }

    // Final option arcs (brighter) — appear progressively as options are computed
    const optionArcs = shipment.options.flatMap(opt =>
      buildLegsForOption(opt, opt.id === activeArcId)
    );

    return [...candidateArcs, ...optionArcs];
  }, [signals, shipment.options, selectedOptionId, activeArcId, isInTransit, isSourceing, isSourcingComplete]);

  // Build map markers — origin ports, destination, and chokepoint waypoints along each route
  const mapMarkers = useMemo(() => {
    const markers: any[] = [];

    // Destination (single)
    const firstRd = shipment.options[0]?.route_data as any;
    const dest = getDest(firstRd);
    if (dest) {
      markers.push({
        id: "destination",
        lat: dest.lat,
        lng: dest.lon,
        color: "#ffffff",
        size: 0.025,
      });
    }

    if (isSourceing || isSourcingComplete) {
      // Origin port per option + chokepoint waypoints along each leg
      shipment.options.forEach(opt => {
        const rd = opt.route_data as any;
        const overall = (opt.risk_summary as any)?.overall ?? "low";
        const color = RISK_COLORS_HEX[overall] ?? "#ffffff";

        const origin = getOrigin(rd);
        if (origin) {
          markers.push({
            id: `origin-${opt.id}`,
            lat: origin.lat,
            lng: origin.lon,
            color,
            size: 0.018,
          });
        }

        // Chokepoint markers — each leg whose .to is a chokepoint
        const legs: any[] = rd?.legs ?? [];
        legs.forEach((leg: any, i: number) => {
          if (leg.chokepoint_id && leg.to?.lat != null && i < legs.length - 1) {
            // Only intermediate chokepoints (not the final destination leg)
            markers.push({
              id: `${opt.id}-cp-${i}`,
              lat: leg.to.lat,
              lng: leg.to.lon ?? leg.to.lng,
              color: "#fbbf24", // amber for chokepoints
              size: 0.014,
            });
          }
        });
      });
    }
    return markers;
  }, [shipment.options, isSourceing, isSourcingComplete]);

  // Handle option selection with handoff animation
  const handleSelectOption = useCallback(async (optionId: string) => {
    setSelectedOptionId(optionId);
    setActiveArcId(null);
    setHandoffActive(true);

    await fetch(`/api/shipments/${id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ option_id: optionId }),
    }).catch(() => {});
  }, [id]);

  // Handle arc click from globe — open option panel or the custom in-progress route overlay
  const handleArcClick = useCallback((optionId: string, arcId: string) => {
    if (optionId) {
      setActiveArcId(prev => prev === optionId ? null : optionId);
      setSelectedRouteSignal(null);
    } else if (arcId) {
      // It's an in-progress candidate signal
      const matchingSignal = signals.find(s => 
        s.signal_type === "route_discovered" && 
        (s.payload as any)?.id === arcId
      );
      if (matchingSignal) {
        setSelectedRouteSignal((prev: any) => prev?.id === (matchingSignal.payload as any)?.id ? null : matchingSignal.payload);
        setActiveArcId(null);
      } else {
        // Fallback or pattern-based extraction
        const parts = arcId.split("-");
        const countryCode = parts[1];
        if (countryCode) {
          const matchingDirect = signals.find(s => 
            s.signal_type === "route_discovered" && 
            (s.payload as any)?.country_code === countryCode
          );
          if (matchingDirect) {
            setSelectedRouteSignal((prev: any) => prev?.id === (matchingDirect.payload as any)?.id ? null : matchingDirect.payload);
            setActiveArcId(null);
          }
        }
      }
    }
  }, [signals]);

  const handleHandoffComplete = useCallback(() => {
    setHandoffActive(false);
  }, []);

  const intentRaw = shipment.intent
    ? typeof shipment.intent === "object"
      ? String((shipment.intent as any).raw ?? "")
      : String(shipment.intent)
    : "";

  // Selected option data for route panel
  const selectedOption = activeArcId
    ? shipment.options.find(o => o.id === activeArcId)
    : null;

  const vesselPos = shipment.vesselPosition?.lat != null
    ? { lat: shipment.vesselPosition.lat!, lng: shipment.vesselPosition.lng!, heading: shipment.vesselPosition.heading }
    : null;

  useEffect(() => {
    useMapStore.getState().setMapState({
      arcs: mapArcs,
      markers: mapMarkers,
      mode: isInTransit ? "monitoring" : "sourcing",
      activeArcId: activeArcId ?? undefined,
      vesselPosition: vesselPos,
      onArcClick: handleArcClick
    });
  }, [mapArcs, mapMarkers, isInTransit, activeArcId, vesselPos, handleArcClick]);

  return (
    <>
      {/* Mobile fallback */}
      <div className="lg:hidden">
        <MobileFallback />
      </div>

      {/* Desktop layout */}
      <div className="hidden lg:flex flex-col h-screen bg-transparent text-white overflow-hidden pointer-events-none">

        {/* Header */}
        <div className="pointer-events-auto z-10 shrink-0">
          <PhaseHeader
            status={status}
            currentEta={shipment.current_eta}
            isPolling={isPolling}
            lastError={lastError}
            id={id}
            belief={belief}
          />
        </div>

        {/* Main area */}
        <div className="flex flex-1 overflow-hidden relative">

          {/* Left: Agent panel (320px) */}
          <div className="w-80 shrink-0 overflow-hidden pointer-events-auto">
            <AgentPanel />
          </div>

          {/* Center: Map */}
          <div className="flex-1 relative overflow-hidden bg-transparent pointer-events-none">

            {/* Sourcing overlay */}
            {isSourceing && (
              <div className="fixed bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 pointer-events-none z-50">
                <div className="px-4 py-2 bg-black/60 backdrop-blur rounded-full border border-white/10">
                  <span className="text-xs text-white/50 font-mono animate-pulse">{loadingMsg}</span>
                </div>
              </div>
            )}

            {/* Options overlay (Phase 2) */}
            {isSourcingComplete && shipment.options.length > 0 && (
              <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent pointer-events-auto">
                <p className="text-xs text-white/40 font-mono mb-3 text-center">
                  {shipment.options.length} sourcing options · click an arc or card to explore
                </p>
                <div className="flex gap-3 justify-center">
                  {shipment.options.map(opt => {
                    const cost = opt.cost_breakdown as any;
                    const risk = opt.risk_summary as any;
                    const rd = opt.route_data as any;
                    const modality = rd?.modality as ("fcl" | "lcl" | "air" | undefined);
                    const modalityStyle =
                      modality === "air" ? "bg-sky-900/50 text-sky-300 border-sky-700/40" :
                      modality === "lcl" ? "bg-indigo-900/50 text-indigo-300 border-indigo-700/40" :
                      modality === "fcl" ? "bg-teal-900/50 text-teal-300 border-teal-700/40" :
                      "bg-slate-800 text-slate-400 border-slate-700";
                    const modalityShort =
                      modality === "air" ? "✈ AIR" :
                      modality === "lcl" ? "⛴ LCL" :
                      modality === "fcl" ? "⛴ FCL" : "";
                    const transit = rd?.total_transit_days;
                    const isActive = activeArcId === opt.id;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => setActiveArcId(isActive ? null : opt.id)}
                        className={`flex-1 max-w-xs px-4 py-3 rounded-xl text-left transition-all border ${
                          isActive
                            ? "border-white/40 bg-white/10"
                            : "border-white/10 bg-white/[0.04] hover:border-white/25 hover:bg-white/[0.07]"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] font-mono text-white/30">#{opt.rank}</span>
                            {modalityShort && (
                              <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono border ${modalityStyle}`}>
                                {modalityShort}
                              </span>
                            )}
                          </div>
                          <span className={`text-[10px] font-mono ${
                            risk?.overall === "high" ? "text-orange-400" :
                            risk?.overall === "medium" ? "text-yellow-400" :
                            "text-green-400"
                          }`}>
                            {risk?.overall ?? "—"}
                          </span>
                        </div>
                        <div className="text-sm font-medium text-white/80 truncate">
                          {opt.country}{rd?.origin_port?.locode ? ` · ${rd.origin_port.locode}` : ""}
                        </div>
                        <div className="flex items-center justify-between mt-0.5">
                          {cost?.total_landed_cost_usd && (
                            <span className="text-xs text-white/40 font-mono">
                              ${(cost.total_landed_cost_usd as number).toLocaleString()}
                            </span>
                          )}
                          {transit != null && (
                            <span className="text-[10px] text-white/30 font-mono">{transit}d</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Monitoring status overlay */}
            {isInTransit && shipment.vesselPosition && (
              <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-none">
                <div className="px-4 py-2 bg-black/50 backdrop-blur rounded-full border border-cyan-500/20 flex items-center gap-3">
                  <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                  <span className="text-xs font-mono text-cyan-400/70">
                    {shipment.vesselPosition.lat?.toFixed(2)}°N · {shipment.vesselPosition.speed ?? "?"}kts
                    {shipment.vesselPosition.route_progress_pct != null && ` · ${shipment.vesselPosition.route_progress_pct}% to port`}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Timeline bar — monitoring only */}
        {isInTransit && (
          <div className="pointer-events-auto z-10 shrink-0">
            <TimelineBar progress={shipment.vesselPosition?.route_progress_pct ?? null} />
          </div>
        )}
      </div>

      {/* Route detail panel (slide-in from right) */}
      <AnimatePresence>
        {selectedOption && !handoffActive && (
          <div className="pointer-events-auto z-20">
            <RouteDetailPanel
              key={selectedOption.id}
              option={selectedOption}
              shipmentId={id}
              onClose={() => setActiveArcId(null)}
              onSelect={() => handleSelectOption(selectedOption.id)}
              selecting={handoffActive}
            />
          </div>
        )}
      </AnimatePresence>

      {/* In-progress candidate route detail panel */}
      <AnimatePresence>
        {selectedRouteSignal && (
          <div className="pointer-events-auto z-20">
            <InProgressRoutePanel
              key={selectedRouteSignal.id}
              routeInfo={selectedRouteSignal}
              onClose={() => setSelectedRouteSignal(null)}
            />
          </div>
        )}
      </AnimatePresence>

      {/* Alert card (slide-in from right, monitoring only) */}
      <AnimatePresence>
        {isInTransit && firstAlert && !emailAlert && !selectedOption && (
          <div className="pointer-events-auto z-20">
            <AlertCard
              key={firstAlert.id}
              alert={firstAlert}
              previousEta={shipment.expected_eta}
              currentEta={shipment.current_eta ?? belief?.current_eta}
              onViewEmail={setEmailAlert}
            />
          </div>
        )}
      </AnimatePresence>

      {/* Email card */}
      <AnimatePresence>
        {emailAlert && (
          <div className="pointer-events-auto z-30">
            <EmailCard
              key={emailAlert.id}
              alert={emailAlert}
              intentRaw={intentRaw}
              onClose={() => setEmailAlert(null)}
            />
          </div>
        )}
      </AnimatePresence>

      {/* Handoff animation */}
      <HandoffAnimation active={handoffActive} onComplete={handleHandoffComplete} />
    </>
  );
}
