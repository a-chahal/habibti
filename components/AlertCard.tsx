"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useAlertsStore } from "@/lib/stores/alertsStore";

interface Alert {
  id: string;
  alert_type: string;
  headline: string;
  full_narrative: string | null;
  draft_email: string | null;
  created_at: string;
  status: string;
}

interface AlertCardProps {
  alert: Alert;
  previousEta?: string | null;
  currentEta?: string | null;
  onViewEmail: (alert: Alert) => void;
}

const SEVERITY_STYLE: Record<string, { badge: string; border: string }> = {
  info: { badge: "bg-slate-800 text-slate-400", border: "border-slate-700" },
  low: { badge: "bg-blue-900/60 text-blue-300", border: "border-blue-700/40" },
  medium: { badge: "bg-yellow-900/60 text-yellow-300", border: "border-yellow-700/40" },
  high: { badge: "bg-orange-900/60 text-orange-300", border: "border-orange-700/40" },
  critical: { badge: "bg-red-900/60 text-red-300", border: "border-red-700/40" },
};

function inferSeverity(alert: Alert): string {
  const t = alert.alert_type?.toLowerCase() ?? "";
  if (t.includes("critical") || t.includes("sanctions")) return "critical";
  if (t.includes("eta_shift") || t.includes("weather") || t.includes("disruption")) return "high";
  if (t.includes("compliance") || t.includes("tariff")) return "medium";
  return "info";
}

export default function AlertCard({ alert, previousEta, currentEta, onViewEmail }: AlertCardProps) {
  const { localDismiss } = useAlertsStore();
  const [dismissed, setDismissed] = useState(false);

  const severity = inferSeverity(alert);
  const style = SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.info;

  const handleDismiss = async () => {
    setDismissed(true);
    localDismiss(alert.id);
    await fetch(`/api/alerts/${alert.id}/dismiss`, { method: "POST" }).catch(() => {});
  };

  const etaDelta = previousEta && currentEta
    ? Math.round((new Date(currentEta).getTime() - new Date(previousEta).getTime()) / 86400000)
    : null;

  const currentEtaStr = currentEta
    ? new Date(currentEta).toLocaleDateString("en-US", { month: "long", day: "numeric" })
    : null;

  return (
    <AnimatePresence>
      {!dismissed && (
        <motion.div
          initial={{ x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 32 }}
          className={`fixed top-0 right-0 h-full w-[36%] max-w-sm z-40 flex flex-col bg-[#0c0f1d]/95 backdrop-blur border-l ${style.border} shadow-2xl`}
        >
          {/* Dismiss */}
          <button
            onClick={handleDismiss}
            className="absolute top-4 right-4 text-white/30 hover:text-white/70 transition-colors z-10"
          >
            <X size={18} />
          </button>

          <div className="flex-1 overflow-y-auto p-6">
            {/* Severity badge */}
            <span className={`inline-block text-[10px] font-mono px-2 py-0.5 rounded uppercase tracking-widest ${style.badge} mb-4`}>
              {severity}
            </span>

            {/* Headline */}
            <h2 className="text-lg font-semibold text-white leading-snug mb-4">
              {alert.headline}
            </h2>

            {/* Updated ETA */}
            {currentEtaStr && (
              <div className="mb-4 p-3 bg-white/[0.04] rounded-lg border border-white/5">
                <div className="text-[10px] text-white/30 font-mono uppercase mb-1">Updated ETA</div>
                <div className="text-base font-mono text-white">
                  {currentEtaStr}
                  {etaDelta != null && etaDelta !== 0 && (
                    <span className={`ml-2 text-sm ${etaDelta > 0 ? "text-orange-400" : "text-green-400"}`}>
                      {etaDelta > 0 ? `+${etaDelta}` : etaDelta} days
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Impact narrative */}
            {alert.full_narrative && (
              <div className="mb-4">
                <div className="text-[10px] text-white/25 font-mono uppercase tracking-widest mb-2">Impact Summary</div>
                <p className="text-sm text-white/60 leading-relaxed">{alert.full_narrative}</p>
              </div>
            )}

            {/* Alert type */}
            <div className="text-[10px] font-mono text-white/20 mt-4">
              {alert.alert_type?.replace(/_/g, " ").toUpperCase()} · {new Date(alert.created_at).toLocaleTimeString()}
            </div>
          </div>

          {/* Actions */}
          <div className="p-4 border-t border-white/5 flex gap-2">
            <button
              onClick={() => onViewEmail(alert)}
              className="flex-1 py-2.5 bg-white text-black rounded-lg text-sm font-medium hover:bg-white/90 transition-all"
            >
              View Draft Email
            </button>
            <button
              onClick={handleDismiss}
              className="px-4 py-2.5 border border-white/10 text-white/50 rounded-lg text-sm hover:border-white/20 hover:text-white/70 transition-all"
            >
              Dismiss
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
