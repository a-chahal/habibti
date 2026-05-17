"use client";

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface HandoffAnimationProps {
  active: boolean;
  onComplete: () => void;
}

const SOURCING_AGENTS = ["Intent Parser", "Country Discoverer", "Tariff Calculator", "Compliance Screener", "Route Prescorer", "Supplier Verifier", "Option Ranker"];
const MONITORING_AGENTS = ["Vessel Tracker", "Port Congestion", "Weather Hazard", "Corridor News", "Synthesizer"];

export default function HandoffAnimation({ active, onComplete }: HandoffAnimationProps) {
  const completedRef = useRef(false);

  useEffect(() => {
    if (!active) {
      completedRef.current = false;
      return;
    }
    completedRef.current = false;
    const t = setTimeout(() => {
      if (!completedRef.current) {
        completedRef.current = true;
        onComplete();
      }
    }, 1850);
    return () => clearTimeout(t);
  }, [active, onComplete]);

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm"
        >
          {/* Sourcing agent cards fade out */}
          <div className="absolute left-8 top-1/2 -translate-y-1/2 flex flex-col gap-2 w-48">
            {SOURCING_AGENTS.map((name, i) => (
              <motion.div
                key={name}
                initial={{ opacity: 1, x: 0 }}
                animate={{ opacity: 0, x: -20 }}
                transition={{ delay: 0.05 * i, duration: 0.4 }}
                className="px-3 py-2 bg-indigo-900/40 border border-indigo-500/20 rounded-lg text-xs text-indigo-300/80 font-mono"
              >
                ✓ {name}
              </motion.div>
            ))}
          </div>

          {/* Central particle burst */}
          <div className="relative flex items-center justify-center w-32 h-32">
            {/* Converge particles */}
            {Array.from({ length: 8 }).map((_, i) => {
              const angle = (i / 8) * Math.PI * 2;
              const startX = Math.cos(angle) * 80;
              const startY = Math.sin(angle) * 80;
              return (
                <motion.div
                  key={i}
                  initial={{ x: startX, y: startY, opacity: 0.7, scale: 1 }}
                  animate={{ x: 0, y: 0, opacity: [0.7, 1, 0], scale: [1, 1.5, 0] }}
                  transition={{ delay: 0.3, duration: 0.5, ease: "easeIn" }}
                  className="absolute w-2 h-2 rounded-full bg-indigo-400"
                />
              );
            })}

            {/* Central flash */}
            <motion.div
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: [0, 2, 0], opacity: [0, 1, 0] }}
              transition={{ delay: 0.75, duration: 0.4 }}
              className="absolute w-8 h-8 rounded-full bg-white/30"
            />

            {/* Fanout particles to monitoring slots */}
            {Array.from({ length: 5 }).map((_, i) => {
              const angle = (i / 5) * Math.PI * 2;
              const endX = Math.cos(angle) * 80;
              const endY = Math.sin(angle) * 80;
              return (
                <motion.div
                  key={`fan-${i}`}
                  initial={{ x: 0, y: 0, opacity: 0, scale: 0 }}
                  animate={{ x: endX, y: endY, opacity: [0, 1, 0.5], scale: [0, 1.2, 0.8] }}
                  transition={{ delay: 0.85 + i * 0.04, duration: 0.5, ease: "easeOut" }}
                  className="absolute w-2 h-2 rounded-full bg-amber-400"
                />
              );
            })}
          </div>

          {/* Phase label */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 mt-24 text-center pointer-events-none">
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: [0, 1, 1, 0], y: [6, 0, 0, -6] }}
              transition={{ delay: 0.4, duration: 1.2, times: [0, 0.2, 0.8, 1] }}
              className="text-xs font-mono tracking-[0.25em] text-white/50 uppercase"
            >
              SOURCING → MONITORING
            </motion.div>
          </div>

          {/* Monitoring agent cards fade in */}
          <div className="absolute right-8 top-1/2 -translate-y-1/2 flex flex-col gap-2 w-48">
            {MONITORING_AGENTS.map((name, i) => (
              <motion.div
                key={name}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 1.3 + i * 0.07, duration: 0.3 }}
                className="px-3 py-2 bg-amber-900/40 border border-amber-500/20 rounded-lg text-xs text-amber-300/80 font-mono"
              >
                ○ {name}
              </motion.div>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
