"use client";

import { motion } from "framer-motion";
import { X } from "lucide-react";
import CitationBadge from "@/components/CitationBadge";

interface RouteDetailPanelProps {
  option: any;
  shipmentId: string;
  onClose: () => void;
  onSelect: () => void;
  selecting?: boolean;
}

const RISK_BADGE: Record<string, string> = {
  low: "bg-green-900/60 text-green-300",
  medium: "bg-yellow-900/60 text-yellow-300",
  high: "bg-orange-900/60 text-orange-300",
  critical: "bg-red-900/60 text-red-300",
};

function fmt(n: number | null | undefined, prefix = "$") {
  if (n == null) return "—";
  return prefix + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export default function RouteDetailPanel({
  option,
  shipmentId,
  onClose,
  onSelect,
  selecting = false,
}: RouteDetailPanelProps) {
  const cost = option?.cost_breakdown as Record<string, any> | null;
  const risk = option?.risk_summary as Record<string, any> | null;
  const route = option?.route_data as Record<string, any> | null;
  const supplier = option?.supplier as Record<string, any> | null;

  // Normalise origin/destination across old and new route_data shapes
  const originPort = route?.origin_port ?? route?.origin ?? null;
  const destPort = route?.destination_port ?? route?.destination ?? null;
  const legs: any[] = Array.isArray(route?.legs) ? route!.legs : [];
  const suppliers: any[] = Array.isArray(route?.suppliers) ? route!.suppliers : [];
  const totalDistance = route?.total_distance_nm;
  const totalTransit = route?.total_transit_days ?? route?.typical_transit_days;

  const etaStr = option?.eta
    ? new Date(option.eta).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : null;

  const isUFLPA = supplier?.verification_status?.toLowerCase().includes("uflpa") ||
    risk?.compliance?.toLowerCase().includes("uflpa");

  return (
    <motion.div
      initial={{ x: "100%" }}
      animate={{ x: 0 }}
      exit={{ x: "100%" }}
      transition={{ type: "spring", stiffness: 280, damping: 30 }}
      className="fixed top-0 right-0 h-full w-[42%] max-w-xl z-40 flex flex-col bg-[#080c18]/95 backdrop-blur border-l border-white/10 shadow-2xl"
    >
      {/* Close */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/30 hover:text-white/70 transition-colors z-10"
      >
        <X size={18} />
      </button>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto pb-24">

        {/* Header strip */}
        <div className="px-6 pt-6 pb-4 border-b border-white/5">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs font-mono text-white/30">#{option?.rank}</span>
            <span className="text-xs text-white/50">
              {originPort?.locode ?? option?.country} → {destPort?.locode ?? "USLAX"}
            </span>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-2xl font-semibold text-white">
                {fmt(cost?.total_landed_cost_usd)}
              </div>
              <div className="text-xs text-white/40 mt-0.5">total landed cost</div>
            </div>
            <div className="text-right">
              {etaStr && (
                <div className="text-sm text-white/70 font-mono">{etaStr}</div>
              )}
              {risk?.overall && (
                <span className={`text-xs px-2 py-0.5 rounded font-mono mt-1 inline-block ${RISK_BADGE[risk.overall] ?? "bg-slate-800 text-slate-400"}`}>
                  {risk.overall} risk
                </span>
              )}
            </div>
          </div>
          {isUFLPA && (
            <div className="mt-3 px-3 py-2 bg-red-900/30 border border-red-700/50 rounded-lg text-xs text-red-300">
              ⚠ UFLPA flag — Uyghur Forced Labor Prevention Act concerns identified
            </div>
          )}
        </div>

        {/* Cost breakdown */}
        {cost && (
          <Section title="Cost Breakdown">
            <div className="space-y-1.5">
              {[
                ["Product value", cost.product_value_usd],
                ["Ocean freight", cost.freight_usd],
                ["Base tariff", null],
                ["Total duty", cost.total_duty_usd, `(${cost.total_duty_pct?.toFixed(1)}%)`],
                ["Insurance", cost.insurance_usd],
                ["Total landed", cost.total_landed_cost_usd, null, true],
              ].map(([label, val, note, bold]: any) => (
                <div key={label} className={`flex items-center justify-between text-xs ${bold ? "border-t border-white/5 pt-1.5 mt-1.5 font-medium text-white" : "text-white/50"}`}>
                  <span>{label}{note ? <span className="text-white/30 ml-1">{note}</span> : null}</span>
                  <span className={bold ? "text-white font-mono" : "font-mono"}>{fmt(val)}</span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Supplier */}
        {supplier && (
          <Section title="Verified Supplier">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-white/80">{supplier.name}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                supplier.verification_status === "verified" ? "bg-green-900/50 text-green-400" : "bg-slate-800 text-slate-400"
              }`}>
                {supplier.verification_status ?? "unknown"}
              </span>
            </div>
            <div className="text-xs text-white/30">{supplier.country}</div>
          </Section>
        )}

        {/* Real exporters discovered via web search */}
        {suppliers.length > 0 && (
          <Section title={`Real Exporters — ${suppliers.length} found`}>
            <div className="space-y-3">
              {suppliers.slice(0, 5).map((s, i) => (
                <div key={i} className="border-l-2 border-emerald-700/40 pl-3 py-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-white/85 truncate">{s.name}</div>
                      <div className="text-[10px] text-white/40 mt-0.5">
                        {[s.city, s.country].filter(Boolean).join(", ") || "—"}
                      </div>
                    </div>
                    {s.registry_verified && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded font-mono bg-green-900/40 text-green-300 shrink-0">
                        GLEIF ✓
                      </span>
                    )}
                  </div>
                  {s.products && (
                    <p className="text-[11px] text-white/55 mt-1 leading-snug">{s.products}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5">
                    {s.website && (
                      <a
                        href={s.website}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-[10px] text-emerald-400/80 hover:text-emerald-300 underline underline-offset-2"
                      >
                        website
                      </a>
                    )}
                    {s.evidence_url && s.evidence_url !== s.website && (
                      <a
                        href={s.evidence_url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-[10px] text-white/40 hover:text-white/70 underline underline-offset-2"
                      >
                        source
                      </a>
                    )}
                    {s.min_order && (
                      <span className="text-[10px] text-white/40 font-mono">MOQ: {s.min_order}</span>
                    )}
                    {typeof s.confidence === "number" && (
                      <span className="text-[10px] text-white/30 font-mono">
                        conf {Math.round(s.confidence * 100)}%
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Risk events */}
        {risk && (
          <Section title="Risk Signals">
            {[
              { label: "Tariff", value: risk.tariff },
              { label: "Compliance", value: risk.compliance },
              { label: "Supply chain", value: risk.supply_chain },
            ].filter(r => r.value).map(r => (
              <div key={r.label} className="mb-2">
                <span className="text-[10px] text-white/30 uppercase tracking-wider">{r.label}</span>
                <p className="text-xs text-white/60 mt-0.5 leading-snug">{r.value}</p>
              </div>
            ))}
          </Section>
        )}

        {/* Route summary */}
        {route && (
          <Section title="Route Details">
            <div className="space-y-1.5 text-xs">
              {originPort?.name && (
                <div className="flex justify-between">
                  <span className="text-white/40">Origin port</span>
                  <span className="text-white/70 text-right">{originPort.name} ({originPort.locode})</span>
                </div>
              )}
              {originPort?.why_this_port && (
                <div className="text-[11px] text-white/40 italic leading-snug pl-1 border-l border-white/10 ml-1">
                  {originPort.why_this_port}
                </div>
              )}
              {destPort?.name && (
                <div className="flex justify-between">
                  <span className="text-white/40">Destination</span>
                  <span className="text-white/70 text-right">{destPort.name} ({destPort.locode})</span>
                </div>
              )}
              {totalDistance != null && (
                <div className="flex justify-between">
                  <span className="text-white/40">Distance</span>
                  <span className="text-white/70 font-mono">{totalDistance.toLocaleString()} nm</span>
                </div>
              )}
              {totalTransit != null && (
                <div className="flex justify-between">
                  <span className="text-white/40">Transit</span>
                  <span className="text-white/70 font-mono">{totalTransit} days</span>
                </div>
              )}
              {route.chokepoints?.length > 0 && (
                <div>
                  <span className="text-white/40">Chokepoints</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {route.chokepoints.map((cp: string) => (
                      <span key={cp} className="text-[10px] px-2 py-0.5 bg-amber-900/30 text-amber-400 rounded">
                        {cp.replace(/_/g, " ")}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Leg-by-leg journey */}
        {legs.length > 0 && (
          <Section title={`Journey — ${legs.length} ${legs.length === 1 ? "leg" : "legs"}`}>
            <div className="space-y-2">
              {legs.map((leg: any, i: number) => {
                const sev = leg.risk_severity && leg.risk_severity !== "none" ? leg.risk_severity : null;
                const newsSev = leg.news_severity && leg.news_severity !== "none" ? leg.news_severity : null;
                const wxSev = leg.weather_severity && leg.weather_severity !== "none" ? leg.weather_severity : null;
                return (
                  <div key={i} className="border-l-2 border-white/10 pl-3 py-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] text-white/70 font-medium">
                        {leg.from?.name ?? "?"} → {leg.to?.name ?? "?"}
                      </div>
                      {sev && (
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${RISK_BADGE[sev] ?? "bg-slate-800 text-slate-400"}`}>
                          {sev}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-[10px] text-white/40 font-mono">
                      <span>{leg.distance_nm?.toLocaleString()} nm</span>
                      <span>{leg.estimated_days} d</span>
                      {leg.chokepoint_id && (
                        <span className="text-amber-400/70">↳ {leg.chokepoint_id.replace(/_/g, " ")}</span>
                      )}
                    </div>
                    {leg.summary && (
                      <p className="text-[11px] text-white/50 mt-1.5 leading-snug">{leg.summary}</p>
                    )}
                    {(newsSev || wxSev) && (
                      <div className="flex gap-2 mt-1">
                        {newsSev && (
                          <span className="text-[9px] text-white/40">
                            news <span className="text-white/60">{newsSev}</span>
                          </span>
                        )}
                        {wxSev && (
                          <span className="text-[9px] text-white/40">
                            weather <span className="text-white/60">{wxSev}</span>
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {/* Reasoning */}
        {option?.reasoning && (
          <Section title="Ranker Reasoning">
            <p className="text-xs text-white/50 leading-relaxed whitespace-pre-wrap">
              {option.reasoning}
            </p>
          </Section>
        )}
      </div>

      {/* Sticky CTA */}
      <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-[#080c18] via-[#080c18]/90 to-transparent pt-8">
        <button
          onClick={onSelect}
          disabled={selecting}
          className="w-full py-3 bg-white text-black rounded-xl font-semibold text-sm hover:bg-white/90 transition-all disabled:opacity-40"
        >
          {selecting ? "Confirming…" : "Select this option →"}
        </button>
      </div>
    </motion.div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-6 py-4 border-b border-white/5">
      <div className="text-[10px] font-mono text-white/25 uppercase tracking-widest mb-3">{title}</div>
      {children}
    </div>
  );
}
