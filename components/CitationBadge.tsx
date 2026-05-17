"use client";

import { useState, useRef, useEffect } from "react";

type SourceType = "news" | "regulatory" | "trade-data" | "registry" | "sanctions" | "weather";

interface CitationBadgeProps {
  sourceType?: SourceType;
  label?: string;
  url?: string;
  date?: string;
  title?: string;
  snippet?: string;
}

const TYPE_COLORS: Record<SourceType, string> = {
  news: "bg-blue-900/60 text-blue-300 border-blue-700/40",
  regulatory: "bg-purple-900/60 text-purple-300 border-purple-700/40",
  "trade-data": "bg-green-900/60 text-green-300 border-green-700/40",
  registry: "bg-amber-900/60 text-amber-300 border-amber-700/40",
  sanctions: "bg-red-900/60 text-red-300 border-red-700/40",
  weather: "bg-cyan-900/60 text-cyan-300 border-cyan-700/40",
};

export default function CitationBadge({
  sourceType = "news",
  label,
  url,
  date,
  title,
  snippet,
}: CitationBadgeProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const displayDate = date ? new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;
  const badgeLabel = label ?? (title ? title.slice(0, 20) + (title.length > 20 ? "…" : "") : "Source");

  return (
    <span ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen(v => !v)}
        className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border font-mono cursor-pointer transition-opacity hover:opacity-80 ${TYPE_COLORS[sourceType]}`}
      >
        [{badgeLabel}{displayDate ? ` · ${displayDate}` : ""}]
      </button>

      {open && (
        <span
          className="absolute bottom-full left-0 mb-1.5 z-50 w-64 bg-[#0e1220] border border-white/10 rounded-lg shadow-2xl p-3 text-left flex flex-col gap-1.5"
          style={{ pointerEvents: "all" }}
        >
          {title && (
            <span className="text-xs font-medium text-white/80 leading-snug">{title}</span>
          )}
          {displayDate && (
            <span className="text-[10px] text-white/30 font-mono">{displayDate}</span>
          )}
          {snippet && (
            <span className="text-[11px] text-white/50 leading-snug line-clamp-3">{snippet}</span>
          )}
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-blue-400 hover:text-blue-300 truncate mt-0.5"
            >
              {url}
            </a>
          ) : (
            <span className="text-[10px] text-white/20 italic">No source URL</span>
          )}
        </span>
      )}
    </span>
  );
}
