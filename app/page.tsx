"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

const QUICK_INTENTS = [
  {
    label: "Cotton · Vietnam",
    intent: "5000 yards organic cotton fabric, from Vietnam, into LA, by July 15, $30k budget",
  },
  {
    label: "Cinnamon · Indonesia",
    intent: "2000 kg Ceylon cinnamon, from Indonesia, into Miami, by August 1, $15k budget",
  },
  {
    label: "Lithium · China",
    intent: "500 lithium battery packs, from China, into Seattle, by September 30, $80k budget",
  },
];

export default function HomePage() {
  const router = useRouter();
  const [intent, setIntent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleReset = async () => {
    setResetting(true);
    setError(null);
    try {
      const res = await fetch("/api/reset", { method: "POST" });
      if (!res.ok) throw new Error("Reset failed");
      setResetDone(true);
      setIntent("");
      // Brief confirmation, then clear the done state
      setTimeout(() => setResetDone(false), 2000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setResetting(false);
    }
  };

  const handleSubmit = async (intentText?: string) => {
    const text = (intentText ?? intent).trim();
    if (!text) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/shipments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create shipment");
      setExiting(true);
      setTimeout(() => router.push(`/shipment/${data.id}`), 400);
    } catch (err: any) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {!exiting && (
        <motion.main
          key="landing"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
          className="min-h-screen bg-black text-white flex flex-col items-center justify-center px-6"
        >
          <div className="w-full max-w-xl">
            {/* Wordmark */}
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1, duration: 0.5 }}
              className="mb-12 text-center"
            >
              <span className="text-xs tracking-[0.3em] text-white/30 uppercase">habibti</span>
            </motion.div>

            {/* Input area with gradient halo */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, duration: 0.6 }}
              className="relative"
            >
              {/* Gradient halo */}
              <div
                className="absolute -inset-8 rounded-3xl pointer-events-none"
                style={{
                  background: "radial-gradient(ellipse at center, rgba(99,102,241,0.08) 0%, transparent 70%)",
                }}
              />

              <textarea
                ref={textareaRef}
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder="What are you trying to bring into the world?"
                rows={4}
                disabled={submitting}
                className="relative w-full bg-white/[0.04] border border-white/10 rounded-2xl px-5 py-4 text-white placeholder-white/20 text-lg resize-none focus:outline-none focus:border-white/20 focus:bg-white/[0.06] transition-all leading-relaxed"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
              />
            </motion.div>

            {/* Error */}
            {error && (
              <p className="mt-3 text-red-400/80 text-sm text-center">{error}</p>
            )}

            {/* Submit */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.35, duration: 0.5 }}
              className="mt-4 flex justify-end"
            >
              <button
                onClick={() => handleSubmit()}
                disabled={submitting || !intent.trim()}
                className="px-5 py-2 bg-white text-black rounded-full text-sm font-medium disabled:opacity-30 hover:bg-white/90 transition-all"
              >
                {submitting ? "Starting…" : "Source it →"}
              </button>
            </motion.div>

            {/* Quick-load pills */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5, duration: 0.5 }}
              className="mt-8 flex flex-wrap gap-2 justify-center"
            >
              {QUICK_INTENTS.map((q) => (
                <button
                  key={q.label}
                  disabled={submitting}
                  onClick={() => handleSubmit(q.intent)}
                  className="px-3 py-1.5 rounded-full text-xs text-white/40 border border-white/10 hover:border-white/25 hover:text-white/70 transition-all disabled:opacity-30"
                >
                  {q.label}
                </button>
              ))}
            </motion.div>

            {/* Hint */}
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.65, duration: 0.5 }}
              className="mt-6 text-center text-white/15 text-xs"
            >
              ⌘ + Enter to submit
            </motion.p>

            {/* Reset button */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.7, duration: 0.5 }}
              className="mt-10 flex justify-center"
            >
              <button
                onClick={handleReset}
                disabled={resetting || submitting}
                className="text-[11px] text-white/15 hover:text-white/40 transition-colors font-mono disabled:opacity-30"
              >
                {resetting ? "clearing…" : resetDone ? "✓ db cleared" : "reset db"}
              </button>
            </motion.div>
          </div>
        </motion.main>
      )}
    </AnimatePresence>
  );
}
