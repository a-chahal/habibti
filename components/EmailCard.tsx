"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";

const SCENARIO_NAMES: Record<string, string> = {
  cotton: "Marcus Chen, RetailCorp",
  cinnamon: "Sarah Kim, FoodTrade Inc",
  lithium: "James Park, TechSupply Co",
};

interface EmailCardProps {
  alert: {
    id: string;
    headline: string;
    draft_email: string | null;
  } | null;
  intentRaw?: string;
  onClose: () => void;
}

function parseDraftEmail(raw: string | null): { subject: string; body: string } {
  if (!raw) return { subject: "", body: "" };
  try {
    const parsed = JSON.parse(raw);
    return {
      subject: parsed.subject_line ?? parsed.subject ?? "",
      body: parsed.body ?? "",
    };
  } catch {
    return { subject: "Re: Shipment Update", body: raw };
  }
}

function inferRecipient(intentRaw?: string): string {
  if (!intentRaw) return "Your Customer";
  const lower = intentRaw.toLowerCase();
  if (lower.includes("cotton")) return SCENARIO_NAMES.cotton;
  if (lower.includes("cinnamon")) return SCENARIO_NAMES.cinnamon;
  if (lower.includes("lithium") || lower.includes("battery")) return SCENARIO_NAMES.lithium;
  return "Your Customer";
}

export default function EmailCard({ alert, intentRaw, onClose }: EmailCardProps) {
  const initial = parseDraftEmail(alert?.draft_email ?? null);
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);

  const recipient = inferRecipient(intentRaw);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(`Subject: ${subject}\n\nTo: ${recipient}\n\n${body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <AnimatePresence>
      {alert && (
        <motion.div
          initial={{ x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0 }}
          transition={{ type: "spring", stiffness: 320, damping: 34 }}
          className="fixed top-0 right-0 h-full w-[38%] max-w-md z-50 flex flex-col bg-[#0a0d1a]/98 backdrop-blur border-l border-white/10 shadow-2xl"
        >
          {/* Close */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-white/30 hover:text-white/70 transition-colors z-10"
          >
            <X size={18} />
          </button>

          <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4">
            <div className="text-[10px] font-mono text-white/25 uppercase tracking-widest">Draft Email</div>

            {/* To */}
            <div>
              <label className="text-[10px] text-white/30 font-mono uppercase">To</label>
              <div className="mt-1 px-3 py-2 bg-white/[0.04] border border-white/8 rounded-lg text-sm text-white/50">
                {recipient}
              </div>
            </div>

            {/* Subject */}
            <div>
              <label className="text-[10px] text-white/30 font-mono uppercase">Subject</label>
              <input
                value={subject}
                onChange={e => setSubject(e.target.value)}
                className="mt-1 w-full px-3 py-2 bg-white/[0.04] border border-white/8 rounded-lg text-sm text-white/80 focus:outline-none focus:border-white/20 transition-colors"
              />
            </div>

            {/* Body */}
            <div className="flex-1 flex flex-col">
              <label className="text-[10px] text-white/30 font-mono uppercase mb-1">Body</label>
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                rows={12}
                className="flex-1 w-full px-3 py-2 bg-white/[0.04] border border-white/8 rounded-lg text-sm text-white/70 leading-relaxed resize-none focus:outline-none focus:border-white/20 transition-colors"
              />
            </div>

            <p className="text-[10px] text-white/20 font-mono text-center">
              Drafted by Synthesizer · Edit as needed before sending
            </p>
          </div>

          {/* Actions */}
          <div className="p-4 border-t border-white/5 flex gap-2">
            <button
              onClick={handleCopy}
              className="flex-1 py-2.5 bg-white text-black rounded-lg text-sm font-medium hover:bg-white/90 transition-all"
            >
              {copied ? "Copied!" : "Copy to Clipboard"}
            </button>
            <button
              onClick={() => setSent(true)}
              disabled={sent}
              className="px-4 py-2.5 border border-white/10 text-white/50 rounded-lg text-sm hover:border-white/20 hover:text-white/70 transition-all disabled:opacity-40"
            >
              {sent ? "✓ Sent" : "Mark as Sent"}
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
