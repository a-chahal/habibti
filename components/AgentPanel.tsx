"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useSignalsStore } from "@/lib/stores/signalsStore";

interface AgentCard {
  name: string;
  tier: "mercury" | "sonnet" | "opus";
  type: "sourcing" | "monitoring";
  latestText: string;
  displayedText: string;
  status: "idle" | "working" | "complete" | "error";
  severity?: string;
}

const AGENT_META: Record<string, { tier: "mercury" | "sonnet" | "opus"; type: "sourcing" | "monitoring"; label: string }> = {
  "intent-parser": { tier: "sonnet", type: "sourcing", label: "Intent Parser" },
  "country-discoverer": { tier: "sonnet", type: "sourcing", label: "Country Discoverer" },
  "tariff-calculator": { tier: "mercury", type: "sourcing", label: "Tariff Calculator" },
  "country-risk": { tier: "sonnet", type: "sourcing", label: "Country Risk" },
  "route-prescorer": { tier: "mercury", type: "sourcing", label: "Route Prescorer" },
  "supplier-verifier": { tier: "sonnet", type: "sourcing", label: "Supplier Verifier" },
  "compliance-screener": { tier: "mercury", type: "sourcing", label: "Compliance Screener" },
  "option-ranker": { tier: "opus", type: "sourcing", label: "Option Ranker" },
  "vessel-tracker": { tier: "mercury", type: "monitoring", label: "Vessel Tracker" },
  "port-congestion": { tier: "mercury", type: "monitoring", label: "Port Congestion" },
  "weather-hazard": { tier: "mercury", type: "monitoring", label: "Weather Hazard" },
  "corridor-news": { tier: "sonnet", type: "monitoring", label: "Corridor News" },
  "regulatory-watcher": { tier: "mercury", type: "monitoring", label: "Regulatory Watcher" },
  "synthesizer": { tier: "opus", type: "monitoring", label: "Synthesizer" },
  "feedback-loop": { tier: "sonnet", type: "monitoring", label: "Feedback Loop" },
  "orchestrator": { tier: "sonnet", type: "sourcing", label: "Orchestrator" },
};

const TIER_BADGE: Record<string, string> = {
  mercury: "bg-slate-700 text-slate-400",
  sonnet: "bg-indigo-900/60 text-indigo-400",
  opus: "bg-violet-900/60 text-violet-400",
};

const TIER_LABEL: Record<string, string> = {
  mercury: "Mercury 2",
  sonnet: "Sonnet 4.6",
  opus: "Opus 4.7",
};

const STATUS_ICON: Record<string, React.ReactNode> = {
  idle: <span className="w-2 h-2 rounded-full bg-slate-600 inline-block" />,
  working: <span className="w-2 h-2 rounded-full bg-blue-400 inline-block animate-pulse" />,
  complete: <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />,
  error: <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />,
};

function signalToOneLiner(signalType: string, payload: Record<string, unknown> | null): string {
  const p = payload ?? {};
  if (signalType === "vessel_position") return `Position ${(p.lat as number)?.toFixed(2)}°N @ ${p.speed_knots ?? "?"}kts`;
  if (signalType === "port_congestion" || signalType === "port_status") return `${p.port ?? "?"}: ${p.congested ? "CONGESTED" : "clear"}`;
  if (signalType === "news_event") return String(p.headline ?? p.impact_on_shipping ?? "News event");
  if (signalType === "weather_hazard") return String(p.summary ?? `Hazard: ${p.hazard_level}`);
  if (signalType === "weather_status") return String(p.summary ?? "Weather assessed");
  if (signalType === "tariff_assessment") return `Tariff: ${p.total_duty_pct ?? "?"}%`;
  if (signalType === "compliance_check") return String(p.result ?? p.status ?? "Compliance assessed");
  if (signalType === "route_assessment") return String(p.lane_name ?? "Route assessed");
  if (signalType === "supplier_found") return String(p.name ?? "Supplier found");
  if (signalType === "country_risk_assessment") return `Risk: ${p.level ?? p.risk_level ?? "assessed"}`;
  if (signalType === "sanctions_addition") return `SANCTIONS: ${p.entity_name ?? "?"}`;
  if (signalType === "regulatory_event" || signalType === "tariff_change") return String(p.title ?? p.relevance_reason ?? signalType);
  const keys = Object.keys(p).filter(k => !["confidence", "citations"].includes(k));
  return keys.length > 0 ? String(p[keys[0]] ?? signalType) : signalType;
}

const STREAM_RATE = 25; // chars per tick

export default function AgentPanel() {
  const { signals } = useSignalsStore();
  const [cards, setCards] = useState<Map<string, AgentCard>>(new Map());
  const streamBuffers = useRef<Map<string, { target: string; displayed: string }>>(new Map());
  const streamInterval = useRef<NodeJS.Timeout | null>(null);

  // Derive cards from signals
  useEffect(() => {
    setCards(prev => {
      const next = new Map(prev);
      signals.forEach(sig => {
        if (!sig.agent_name || sig.agent_name === "orchestrator") return;
        const meta = AGENT_META[sig.agent_name];
        if (!meta) return;
        const oneLiner = signalToOneLiner(sig.signal_type, sig.payload as any);
        const existing = next.get(sig.agent_name);
        const buf = streamBuffers.current.get(sig.agent_name);

        if (!existing) {
          streamBuffers.current.set(sig.agent_name, { target: oneLiner, displayed: "" });
          next.set(sig.agent_name, {
            name: sig.agent_name,
            tier: meta.tier,
            type: meta.type,
            latestText: oneLiner,
            displayedText: "",
            status: "complete",
            severity: sig.severity,
          });
        } else if (existing.latestText !== oneLiner) {
          streamBuffers.current.set(sig.agent_name, { target: oneLiner, displayed: existing.displayedText });
          next.set(sig.agent_name, { ...existing, latestText: oneLiner, status: "working", severity: sig.severity });
        }
      });
      return next;
    });
  }, [signals]);

  // Stream text character by character
  useEffect(() => {
    if (streamInterval.current) clearInterval(streamInterval.current);
    streamInterval.current = setInterval(() => {
      let anyStreaming = false;
      streamBuffers.current.forEach((buf, agentName) => {
        if (buf.displayed.length < buf.target.length) {
          anyStreaming = true;
          const next = buf.target.slice(0, buf.displayed.length + STREAM_RATE);
          buf.displayed = next;
          setCards(prev => {
            const updated = new Map(prev);
            const card = updated.get(agentName);
            if (card) {
              updated.set(agentName, {
                ...card,
                displayedText: next,
                status: next === buf.target ? "complete" : "working",
              });
            }
            return updated;
          });
        }
      });
      if (!anyStreaming && streamInterval.current) {
        clearInterval(streamInterval.current);
      }
    }, 60);
    return () => { if (streamInterval.current) clearInterval(streamInterval.current); };
  }, [cards.size]);

  const orderedCards = Array.from(cards.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type === "sourcing" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-[#0a0e1a] border-r border-white/5 p-3 flex flex-col gap-2">
      <div className="text-[10px] font-mono text-white/20 uppercase tracking-widest mb-1 px-1">Agents</div>
      <AnimatePresence initial={false}>
        {orderedCards.map(card => {
          const meta = AGENT_META[card.name];
          const borderColor = card.type === "sourcing"
            ? "border-indigo-500/30"
            : "border-amber-500/30";
          const isWorking = card.status === "working";

          return (
            <motion.div
              key={card.name}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0, scale: isWorking ? [1, 1.01, 1] : 1 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.25 }}
              className={`border-l-2 ${borderColor} bg-white/[0.03] rounded-r-lg px-3 py-2.5`}
            >
              <div className="flex items-center gap-2 mb-1">
                {STATUS_ICON[card.status]}
                <span className="text-xs font-medium text-white/70 truncate flex-1">{meta?.label ?? card.name}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${TIER_BADGE[card.tier]}`}>
                  {TIER_LABEL[card.tier]}
                </span>
              </div>
              <p className="text-[11px] text-white/40 leading-snug min-h-[1.2em] font-mono">
                {card.displayedText || <span className="animate-pulse">…</span>}
              </p>
            </motion.div>
          );
        })}
      </AnimatePresence>
      {orderedCards.length === 0 && (
        <div className="text-[11px] text-white/15 font-mono px-1 mt-2 animate-pulse">
          Waiting for agents…
        </div>
      )}
    </div>
  );
}
