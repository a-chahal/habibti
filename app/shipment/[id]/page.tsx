"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import HandoffAnimation from "@/components/HandoffAnimation";
import AlertCard from "@/components/AlertCard";
import EmailCard from "@/components/EmailCard";

const WorldMap = dynamic(() => import("@/components/WorldMap"), { ssr: false });

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RISK_COLORS_HEX: Record<string, string> = {
  low: "#ffffff",
  medium: "#f59e0b",
  high: "#ef4444",
};

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

  // Build map arcs from options
  const mapArcs = useMemo(() => {
    if (isInTransit) {
      // Only selected option arc in monitoring mode
      const sel = shipment.options.find(o => o.id === selectedOptionId) ?? shipment.options[0];
      if (!sel?.route_data) return [];
      const rd = sel.route_data as any;
      if (!rd.origin?.lat || !rd.destination?.lat) return [];
      return [{
        id: sel.id,
        lat1: rd.origin.lat,
        lon1: rd.origin.lng,
        lat2: rd.destination.lat,
        lon2: rd.destination.lng,
        risk: (sel.risk_summary as any)?.overall ?? "low",
        active: true,
      }];
    }
    // Sourcing: all options
    return shipment.options.flatMap(opt => {
      const rd = opt.route_data as any;
      if (!rd?.origin?.lat || !rd?.destination?.lat) return [];
      return [{
        id: opt.id,
        lat1: rd.origin.lat,
        lon1: rd.origin.lng,
        lat2: rd.destination.lat,
        lon2: rd.destination.lng,
        risk: (opt.risk_summary as any)?.overall ?? "low",
        active: opt.id === activeArcId,
      }];
    });
  }, [shipment.options, selectedOptionId, activeArcId, isInTransit]);

  // Build map markers
  const mapMarkers = useMemo(() => {
    const markers: any[] = [];
    const dest = shipment.options[0]?.route_data as any;
    if (dest?.destination?.lat) {
      markers.push({
        id: "destination",
        lat: dest.destination.lat,
        lng: dest.destination.lng,
        color: "#ffffff",
        size: 0.025,
      });
    }
    if (isSourceing || isSourcingComplete) {
      shipment.options.forEach((opt, i) => {
        const rd = opt.route_data as any;
        if (rd?.origin?.lat) {
          markers.push({
            id: `origin-${opt.id}`,
            lat: rd.origin.lat,
            lng: rd.origin.lng,
            color: RISK_COLORS_HEX[(opt.risk_summary as any)?.overall ?? "low"] ?? "#ffffff",
            size: 0.018,
          });
        }
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

  return (
    <>
      {/* Mobile fallback */}
      <div className="lg:hidden">
        <MobileFallback />
      </div>

      {/* Desktop layout */}
      <div className="hidden lg:flex flex-col h-screen bg-[#0a0e1a] text-white overflow-hidden">

        {/* Header */}
        <PhaseHeader
          status={status}
          currentEta={shipment.current_eta}
          isPolling={isPolling}
          lastError={lastError}
          id={id}
          belief={belief}
        />

        {/* Main area */}
        <div className="flex flex-1 overflow-hidden relative">

          {/* Left: Agent panel (320px) */}
          <div className="w-80 shrink-0 overflow-hidden">
            <AgentPanel />
          </div>

          {/* Center: Map */}
          <div className="flex-1 relative overflow-hidden bg-[#0a0a0a]">
            <WorldMap
              arcs={mapArcs}
              markers={mapMarkers}
              mode={isInTransit ? "monitoring" : "sourcing"}
              activeArcId={activeArcId ?? undefined}
              vesselPosition={vesselPos}
            />

            {/* Sourcing overlay */}
            {isSourceing && (
              <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 pointer-events-none">
                <div className="px-4 py-2 bg-black/60 backdrop-blur rounded-full border border-white/10">
                  <span className="text-xs text-white/50 font-mono animate-pulse">{loadingMsg}</span>
                </div>
              </div>
            )}

            {/* Options overlay (Phase 2) */}
            {isSourcingComplete && shipment.options.length > 0 && (
              <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent">
                <p className="text-xs text-white/40 font-mono mb-3 text-center">
                  {shipment.options.length} sourcing options · click an arc or card to explore
                </p>
                <div className="flex gap-3 justify-center">
                  {shipment.options.map(opt => {
                    const cost = opt.cost_breakdown as any;
                    const risk = opt.risk_summary as any;
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
                          <span className="text-[10px] font-mono text-white/30">#{opt.rank}</span>
                          <span className={`text-[10px] font-mono ${
                            risk?.overall === "high" ? "text-orange-400" :
                            risk?.overall === "medium" ? "text-yellow-400" :
                            "text-green-400"
                          }`}>
                            {risk?.overall ?? "—"}
                          </span>
                        </div>
                        <div className="text-sm font-medium text-white/80 truncate">
                          {opt.supplier?.name ?? `${opt.country} supplier`}
                        </div>
                        {cost?.total_landed_cost_usd && (
                          <div className="text-xs text-white/40 font-mono mt-0.5">
                            ${(cost.total_landed_cost_usd as number).toLocaleString()}
                          </div>
                        )}
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
          <TimelineBar progress={shipment.vesselPosition?.route_progress_pct ?? null} />
        )}
      </div>

      {/* Route detail panel (slide-in from right) */}
      <AnimatePresence>
        {selectedOption && !handoffActive && (
          <RouteDetailPanel
            key={selectedOption.id}
            option={selectedOption}
            shipmentId={id}
            onClose={() => setActiveArcId(null)}
            onSelect={() => handleSelectOption(selectedOption.id)}
            selecting={handoffActive}
          />
        )}
      </AnimatePresence>

      {/* Alert card (slide-in from right, monitoring only) */}
      <AnimatePresence>
        {isInTransit && firstAlert && !emailAlert && !selectedOption && (
          <AlertCard
            key={firstAlert.id}
            alert={firstAlert}
            previousEta={shipment.expected_eta}
            currentEta={shipment.current_eta ?? belief?.current_eta}
            onViewEmail={setEmailAlert}
          />
        )}
      </AnimatePresence>

      {/* Email card */}
      <AnimatePresence>
        {emailAlert && (
          <EmailCard
            key={emailAlert.id}
            alert={emailAlert}
            intentRaw={intentRaw}
            onClose={() => setEmailAlert(null)}
          />
        )}
      </AnimatePresence>

      {/* Handoff animation */}
      <HandoffAnimation active={handoffActive} onComplete={handleHandoffComplete} />
    </>
  );
}
