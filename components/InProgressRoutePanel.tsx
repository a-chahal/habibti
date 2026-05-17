"use client";

import { motion } from "framer-motion";
import { X, ShieldAlert, Navigation, Anchor, Flag } from "lucide-react";

interface InProgressRoutePanelProps {
  routeInfo: {
    id: string;
    status: "candidate" | "refined" | "discarded";
    country_code: string;
    country_name: string;
    port_locode: string;
    port_name: string;
    reason?: string;
    route?: {
      totalDistanceKm?: number;
      legs?: Array<{
        from: { name: string; lat: number; lon: number };
        to: { name: string; lat: number; lon: number; chokepoint_id?: string };
        distanceKm?: number;
      }>;
    };
  };
  onClose: () => void;
}

const STATUS_CONFIG = {
  candidate: {
    label: "Discovered Country Candidate",
    badgeClass: "bg-indigo-950/60 text-indigo-300 border border-indigo-700/50",
    glowClass: "shadow-[0_0_15px_rgba(99,102,241,0.25)]",
    textClass: "text-indigo-400",
  },
  refined: {
    label: "Sourced Port Option",
    badgeClass: "bg-cyan-950/60 text-cyan-300 border border-cyan-700/50",
    glowClass: "shadow-[0_0_15px_rgba(6,182,212,0.25)]",
    textClass: "text-cyan-400",
  },
  discarded: {
    label: "Ruled Out Candidate",
    badgeClass: "bg-red-950/60 text-red-300 border border-red-700/50",
    glowClass: "shadow-[0_0_15px_rgba(239,68,68,0.25)]",
    textClass: "text-red-400",
  },
};

export default function InProgressRoutePanel({
  routeInfo,
  onClose,
}: InProgressRoutePanelProps) {
  const cfg = STATUS_CONFIG[routeInfo.status] ?? STATUS_CONFIG.candidate;
  const legs = routeInfo.route?.legs ?? [];
  const distanceKm = routeInfo.route?.totalDistanceKm;
  const distanceNm = distanceKm ? Math.round(distanceKm * 0.539957) : null;

  return (
    <motion.div
      initial={{ x: "100%" }}
      animate={{ x: 0 }}
      exit={{ x: "100%" }}
      transition={{ type: "spring", stiffness: 280, damping: 30 }}
      className={`fixed top-0 right-0 h-full w-[42%] max-w-xl z-40 flex flex-col bg-[#070b16]/95 backdrop-blur border-l border-white/10 shadow-2xl ${cfg.glowClass}`}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/30 hover:text-white/70 transition-colors z-10 p-2 hover:bg-white/5 rounded-full"
      >
        <X size={18} />
      </button>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto pb-8">
        
        {/* Header strip */}
        <div className="px-6 pt-8 pb-6 border-b border-white/5 bg-gradient-to-b from-white/[0.02] to-transparent">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[10px] font-mono text-white/30 uppercase tracking-widest">In-Progress swarm trace</span>
          </div>
          
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className={`text-xs px-2.5 py-1 rounded-full font-semibold font-mono tracking-wide ${cfg.badgeClass}`}>
                {cfg.label.toUpperCase()}
              </span>
            </div>
            
            <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2 mt-1">
              <Navigation className={`w-5 h-5 ${cfg.textClass} animate-pulse`} />
              {routeInfo.port_name} → United States
            </h1>
            <p className="text-xs text-white/40 font-mono">
              Trace ID: <span className="text-white/60">{routeInfo.id}</span>
            </p>
          </div>
        </div>

        {/* Rule Out Alert Callout */}
        {routeInfo.status === "discarded" && routeInfo.reason && (
          <div className="mx-6 mt-6 p-4 bg-red-950/30 border border-red-800/50 rounded-xl flex gap-3 items-start animate-fade-in shadow-lg">
            <ShieldAlert className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-xs font-semibold text-red-300 font-mono uppercase tracking-wider">swarm rejection trigger</div>
              <p className="text-xs text-red-200/80 mt-1 leading-relaxed">
                {routeInfo.reason}
              </p>
            </div>
          </div>
        )}

        {/* Origin Location Details */}
        <Section title="Candidate Origin details">
          <div className="grid grid-cols-2 gap-4">
            <div className="p-3 bg-white/[0.02] border border-white/5 rounded-xl">
              <div className="flex items-center gap-1.5 text-white/30 text-[10px] uppercase font-mono tracking-wider mb-1">
                <Flag className="w-3.5 h-3.5 text-white/30" />
                country
              </div>
              <div className="text-sm font-semibold text-white/90">
                {routeInfo.country_name} ({routeInfo.country_code})
              </div>
            </div>

            <div className="p-3 bg-white/[0.02] border border-white/5 rounded-xl">
              <div className="flex items-center gap-1.5 text-white/30 text-[10px] uppercase font-mono tracking-wider mb-1">
                <Anchor className="w-3.5 h-3.5 text-white/30" />
                port code
              </div>
              <div className="text-sm font-semibold text-white/90">
                {routeInfo.port_locode}
              </div>
            </div>
          </div>
        </Section>

        {/* Route Details */}
        <Section title="Evaluated Path Metrics">
          <div className="space-y-3 text-xs text-white/60">
            <div className="flex justify-between items-center py-1.5 border-b border-white/5">
              <span className="text-white/40 font-mono">Discovered source</span>
              <span className="text-white/80 font-medium">{routeInfo.port_name}</span>
            </div>
            
            {distanceNm && (
              <div className="flex justify-between items-center py-1.5 border-b border-white/5">
                <span className="text-white/40 font-mono">Calculated Distance</span>
                <span className="text-cyan-400 font-mono font-medium">{distanceNm.toLocaleString()} nm</span>
              </div>
            )}

            <div className="flex justify-between items-center py-1.5 border-b border-white/5">
              <span className="text-white/40 font-mono">Ocean transit window</span>
              <span className="text-white/80 font-mono font-medium">Progressive calculation...</span>
            </div>
          </div>
        </Section>

        {/* Journey Legs */}
        {legs.length > 0 && (
          <Section title={`Calculated Journey Legs — ${legs.length} ${legs.length === 1 ? "leg" : "legs"}`}>
            <div className="space-y-3 mt-2">
              {legs.map((leg: any, idx: number) => {
                const legDistNm = leg.distanceKm ? Math.round(leg.distanceKm * 0.539957) : null;
                return (
                  <div key={idx} className="relative border-l-2 border-indigo-500/20 hover:border-indigo-500/50 pl-4 py-1.5 transition-all">
                    {/* Circle bullet point */}
                    <div className="absolute w-2 h-2 rounded-full bg-indigo-400 -left-[5px] top-3 shadow-[0_0_8px_rgba(129,140,248,0.6)]" />
                    
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-white/90">
                        {leg.from?.name} → {leg.to?.name}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 mt-1.5 text-[10px] text-white/40 font-mono">
                      {legDistNm && <span>{legDistNm.toLocaleString()} nm</span>}
                      {leg.chokepoint_id && (
                        <span className="text-amber-400/80 font-medium">↳ Pass: {leg.chokepoint_id.replace(/_/g, " ")}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

      </div>
    </motion.div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-6 py-5 border-b border-white/5">
      <div className="text-[10px] font-mono text-white/20 uppercase tracking-widest mb-3">{title}</div>
      {children}
    </div>
  );
}
