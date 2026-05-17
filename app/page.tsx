"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, HelpCircle, Check, Compass, ShieldAlert, ArrowRight, RotateCw, BookOpen, User } from "lucide-react";
import { BackgroundGradientAnimation } from "@/components/ui/background-gradient-animation";

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

type ProfileAnswers = {
  cadence: string;
  use: string;
  deadline: string;
  experience: string;
};

const PILL_OPTIONS = {
  cadence: ["One-time order", "Recurring supply", "Not sure yet"],
  use: ["Resale / retail", "Manufacturing input", "Personal / wholesale", "E-commerce"],
  deadline: ["Hard — production stops", "Soft — would be nice", "Flexible"],
  experience: ["First time", "Yes, I have suppliers", "Yes, exploring new ones"],
};

const HELP_TOOLTIPS = {
  cadence: "Determines if agents should negotiate long-term stability agreements or prioritize spot-market rates.",
  use: "Guides risk thresholds (e.g. e-commerce/retail has strict penalization for delays; manufacturing requires strict quality certificates).",
  deadline: "Directs route planner. Hard deadlines force routes avoiding high-congestion or disrupted chokepoints like the Suez/Panama canal.",
  experience: "First-time importers trigger additional regulatory warnings, step-by-step educational flags, and automated customs broker pairings.",
};

export default function HomePage() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [intent, setIntent] = useState("");
  const [selectedDirectives, setSelectedDirectives] = useState<string[]>([]);
  const [profileAnswers, setProfileAnswers] = useState<ProfileAnswers>({
    cadence: "",
    use: "",
    deadline: "",
    experience: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const [refineStatus, setRefineStatus] = useState("");

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (step === 1) {
      textareaRef.current?.focus();
    }
  }, [step]);

  const [shiningPillIndex, setShiningPillIndex] = useState<number>(0);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (step === 2 && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [step, intent, selectedDirectives, profileAnswers]);

  useEffect(() => {
    // Select one random quick intent pill to be the target hint for this session
    setShiningPillIndex(Math.floor(Math.random() * QUICK_INTENTS.length));
  }, []);

  const isPromptMeaningful = (text: string): boolean => {
    const trimmed = text.trim();
    if (trimmed.length < 10) return false;
    
    // Core trade keywords
    const keywords = [
      "cotton", "fabric", "textile", "battery", "batteries", "lithium", "cinnamon", "spice", 
      "coffee", "beans", "solar", "panel", "wood", "steel", "clothing", "shirt", "apparel", 
      "electronic", "toy", "goods", "product", "item", "cargo", "freight", "import", "export", 
      "source", "buy", "order", "purchase", "ship", "delivery", "transport", "logistic", "transit",
      "from", "into", "to", "by", "budget", "dollars", "$", "kg", "tons", "yards", "units", "pieces", "pcs"
    ];
    
    const lower = trimmed.toLowerCase();
    return keywords.some(k => lower.includes(k));
  };

  const getWordCount = (text: string): number => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return 0;
    return trimmed.split(/\s+/).length;
  };

  const getIdentifiedProduct = () => {
    const lower = intent.toLowerCase();
    if (lower.includes("cotton") || lower.includes("fabric") || lower.includes("textile")) return "cotton";
    if (lower.includes("battery") || lower.includes("batteries") || lower.includes("lithium")) return "battery";
    if (lower.includes("cinnamon") || lower.includes("spice")) return "cinnamon";
    if (lower.includes("coffee")) return "coffee";
    if (lower.includes("solar")) return "solar";
    return "general";
  };

  const getSmartPills = () => {
    const prod = getIdentifiedProduct();
    if (prod === "cotton") {
      return [
        { label: "Organic GOTS Certificate", text: "Must have organic GOTS certification." },
        { label: "OEKO-TEX Standard 100", text: "OEKO-TEX Standard 100 certified only." },
        { label: "Section 301 Tariffs Check", text: "Examine Section 301 tariff exposures." },
        { label: "Xinjiang Cotton Ban", text: "Strict compliance with UFLPA (no Xinjiang cotton)." },
      ];
    }
    if (prod === "battery") {
      return [
        { label: "UN 38.3 Safety Report", text: "Require UN 38.3 test summary report." },
        { label: "Class 9 HAZMAT transit", text: "Shipment requires Class 9 HAZMAT handling." },
        { label: "Carbon Footprint audit", text: "Supplier must share battery carbon footprint data." },
        { label: "UL 1642 safety standards", text: "Batteries must meet UL 1642 safety certificate standards." },
      ];
    }
    if (prod === "cinnamon") {
      return [
        { label: "FDA Prior Notice", text: "FDA Prior Notice filing required before arrival." },
        { label: "Phytosanitary Certificate", text: "Phytosanitary certificate is mandatory." },
        { label: "USDA Organic verification", text: "Verify USDA Organic label registration." },
        { label: "Aflatoxin lab review", text: "Review latest aflatoxin lab test reports." },
      ];
    }
    return [
      { label: "Supplier OFAC screening", text: "Strict screening against OFAC SDN list." },
      { label: "Congestion Bypass", text: "Prioritize routes that bypass high-risk choke points." },
      { label: "Duty minimization analysis", text: "Identify potential tariff exemptions." },
      { label: "Standard cargo insurance", text: "Include full cargo insurance coverage." },
    ];
  };

  const handleToggleDirective = (pillText: string) => {
    setSelectedDirectives((prev) =>
      prev.includes(pillText) ? prev.filter((d) => d !== pillText) : [...prev, pillText]
    );
  };

  const handleRefinePrompt = () => {
    if (!intent.trim() || isRefining) return;
    setIsRefining(true);
    setRefineStatus("Analyzing parameters...");

    const text = intent.toLowerCase();
    let product = "high-quality goods";
    let origin = "";
    let destination = "";
    let quantity = "";
    let budget = "";
    let extra: string[] = [];

    // Parse product
    if (text.includes("cotton") || text.includes("fabric") || text.includes("textile")) {
      product = "premium organic cotton fabric (HS 5208)";
      extra.push("Verify GOTS / OEKO-TEX certifications");
    } else if (text.includes("battery") || text.includes("batteries") || text.includes("lithium")) {
      product = "lithium-ion battery packs (HS 8507)";
      extra.push("Check UN 38.3 HAZMAT safety reports");
    } else if (text.includes("cinnamon") || text.includes("spice")) {
      product = "organic Ceylon cinnamon (HS 0906)";
      extra.push("Verify FDA import approval & phytosanitary certificate");
    } else if (text.includes("coffee")) {
      product = "single-origin Arabica coffee beans (HS 0901)";
      extra.push("Require fair-trade & organic certifications");
    } else if (text.includes("solar")) {
      product = "high-efficiency monocrystalline solar panels (HS 8541)";
      extra.push("Analyze Anti-Dumping / Countervailing Duties (AD/CVD)");
    } else {
      const matched = intent.match(/(?:import|buy|need|get)\s+([a-zA-Z\s]+?)(?:\s+from|\s+into|\s+to|\s+by|\s+with|\s+\d|$)/i);
      if (matched?.[1]) {
        product = matched[1].trim();
      } else {
        product = intent.trim();
      }
    }

    // Parse origin
    if (text.includes("vietnam") || text.includes(" vn")) {
      origin = "Vietnam (VN)";
    } else if (text.includes("china") || text.includes(" cn")) {
      origin = "China (CN)";
    } else if (text.includes("indonesia") || text.includes(" id")) {
      origin = "Indonesia (ID)";
    } else if (text.includes("india") || text.includes(" in")) {
      origin = "India (IN)";
    } else if (text.includes("brazil") || text.includes(" br")) {
      origin = "Brazil (BR)";
    } else if (text.includes("mexico") || text.includes(" mx")) {
      origin = "Mexico (MX)";
    } else if (text.includes("germany") || text.includes(" de")) {
      origin = "Germany (DE)";
    }

    // Parse destination
    if (text.includes("los angeles") || text.includes("la ") || text.includes("lax") || text.includes("california")) {
      destination = "Port of Los Angeles (USLAX)";
    } else if (text.includes("new york") || text.includes("nyc") || text.includes("ny ")) {
      destination = "Port of New York (USNYC)";
    } else if (text.includes("miami")) {
      destination = "Port of Miami (USMIA)";
    } else if (text.includes("seattle")) {
      destination = "Port of Seattle (USSEA)";
    } else if (text.includes("oakland")) {
      destination = "Port of Oakland (USOAK)";
    } else if (text.includes("houston")) {
      destination = "Port of Houston (USHOU)";
    }

    // Parse quantity
    const qtyMatch = intent.match(/(\d+[\d,]*\s*(?:yards|kg|units|packs|tons|ton|meters|pieces))/i);
    if (qtyMatch?.[1]) {
      quantity = qtyMatch[1];
    }

    // Parse budget
    const budgetMatch = intent.match(/(?:\$|budget\s*of\s*)(\d+[\d,]*k?)/i);
    if (budgetMatch?.[1]) {
      budget = budgetMatch[1].toLowerCase().includes("k") ? `$${parseFloat(budgetMatch[1]) * 1000}` : `$${budgetMatch[1]}`;
    }

    setTimeout(() => {
      setRefineStatus("Formatting trade compliance schema...");
      
      let refined = `I need to import ${quantity || "a bulk shipment"} of ${product}`;
      if (origin) refined += `, sourced from premium suppliers in ${origin}`;
      if (destination) refined += `, delivered safely into ${destination}`;
      
      const dateMatch = intent.match(/(?:by|deadline|before)\s+([a-zA-Z]+\s+\d+|\d{4}-\d{2}-\d{2})/i);
      if (dateMatch?.[1]) {
        refined += `, with a target deadline of ${dateMatch[1]}`;
      } else {
        refined += `, by late summer`;
      }

      if (budget) {
        refined += `, working within a total landing budget of ${budget}`;
      }
      
      if (extra.length > 0) {
        refined += `.\n[System Directives]: Run end-to-end OFAC/sanctions check. ${extra.join(". ")}. Compare shipping routes to bypass high-congestion bottlenecks.`;
      } else {
        refined += `.\n[System Directives]: Run end-to-end OFAC/sanctions screening on all potential entities, perform automatic HS-code discovery, and score viability based on tariff schedules.`;
      }

      setTimeout(() => {
        setRefineStatus("Simulating typewriter typing...");
        let currentText = "";
        let charIndex = 0;
        const speed = 5;

        const typeChar = () => {
          if (charIndex < refined.length) {
            currentText += refined.charAt(charIndex);
            setIntent(currentText);
            charIndex++;
            setTimeout(typeChar, speed);
          } else {
            setIsRefining(false);
            setRefineStatus("");
          }
        };

        typeChar();
      }, 600);
    }, 600);
  };

  const handleReset = async () => {
    setResetting(true);
    setError(null);
    try {
      const res = await fetch("/api/reset", { method: "POST" });
      if (!res.ok) throw new Error("Reset failed");
      setResetDone(true);
      setIntent("");
      setSelectedDirectives([]);
      setProfileAnswers({ cadence: "", use: "", deadline: "", experience: "" });
      setStep(1);
      setTimeout(() => setResetDone(false), 2000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setResetting(false);
    }
  };

  const handleNextStep = (intentText?: string) => {
    const text = (intentText ?? intent).trim();
    if (!text) return;
    if (intentText) setIntent(intentText);
    setStep(2);
  };

  const buildFullIntent = (isSkip: boolean) => {
    const finalIntent = intent.trim();
    const directivesText = isSkip ? "" : selectedDirectives.join("\n- ");

    const profileLines = Object.entries(profileAnswers)
      .filter(([, v]) => v)
      .map(([k, v]) => {
        const labels: Record<string, string> = {
          cadence: "Order cadence",
          use: "End use",
          deadline: "Deadline firmness",
          experience: "Import experience",
        };
        return `${labels[k]}: ${v}`;
      });

    let full = finalIntent;
    if (directivesText) {
      full += `\n\n[Constraints & Requirements]:\n- ${directivesText}`;
    }
    if (profileLines.length > 0) {
      full += `\n\n[Import Profile]: ${profileLines.join(" | ")}`;
    }
    return full;
  };

  const handleSubmit = async (isSkip = false) => {
    const finalIntent = intent.trim();
    if (!finalIntent) return;

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/shipments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: buildFullIntent(isSkip) }),
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

  const setPill = (key: keyof ProfileAnswers, value: string) => {
    setProfileAnswers((prev) => ({
      ...prev,
      [key]: prev[key] === value ? "" : value,
    }));
  };

  const PillGroup = ({
    label,
    field,
    options,
  }: {
    label: string;
    field: keyof ProfileAnswers;
    options: string[];
  }) => (
    <div className="mb-6 p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:border-white/[0.15] transition-all">
      <div className="flex justify-between items-center mb-3">
        <p className="text-xs font-mono font-bold text-indigo-200/70 tracking-wide uppercase">{label}</p>
        <div className="group relative cursor-help">
          <HelpCircle className="w-3.5 h-3.5 text-white/45 hover:text-indigo-400 transition-colors" />
          <div className="absolute right-0 bottom-6 w-60 p-2.5 rounded-lg border border-white/20 bg-[#0c0c0e] text-[10px] text-white/80 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20 shadow-xl leading-relaxed">
            {HELP_TOOLTIPS[field]}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <button
            key={opt}
            onClick={() => setPill(field, opt)}
            className={`px-3.5 py-2 rounded-lg text-xs font-semibold border transition-all ${
              profileAnswers[field] === opt
                ? "border-indigo-400 text-indigo-200 bg-indigo-500/15 shadow-[0_0_20px_rgba(99,102,241,0.3)]"
                : "border-white/[0.12] text-white/60 bg-white/[0.03] hover:border-white/30 hover:text-white hover:bg-white/[0.06]"
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <AnimatePresence mode="wait">
      {!exiting && (
        <motion.main
          key="landing"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
          className="min-h-screen w-screen bg-black text-white relative overflow-hidden"
        >
          <BackgroundGradientAnimation
            gradientBackgroundStart="rgb(8, 7, 16)"
            gradientBackgroundEnd="rgb(3, 2, 8)"
            firstColor="54, 47, 120"
            secondColor="20, 80, 140"
            thirdColor="8, 14, 44"
            fourthColor="40, 18, 70"
            fifthColor="12, 10, 30"
            pointerColor="99, 102, 241"
            brightness={1.0}
            containerClassName="absolute inset-0 w-full h-full"
            className="w-full h-full flex flex-col items-center justify-center px-6 overflow-y-auto relative z-10"
          >
            <div className="w-full max-w-2xl mt-[8vh] mb-12 relative z-20">
            {/* Wordmark Header */}
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1, duration: 0.5 }}
              className="mb-8 text-center"
            >
              <span className="text-xs tracking-[0.45em] text-white/60 uppercase font-mono font-semibold">
                habibti
              </span>
              <h1 className="text-sm tracking-[0.1em] text-indigo-400/90 font-mono mt-2 uppercase font-bold">
                Agent-Native Supply Swarm
              </h1>
            </motion.div>

            <AnimatePresence mode="wait">
              {step === 1 ? (
                <motion.div
                  key="step1"
                  initial={{ opacity: 0, x: -15 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 15 }}
                  transition={{ duration: 0.3 }}
                >
                  <div className="relative">
                    <div
                      className="absolute -inset-8 rounded-3xl pointer-events-none"
                      style={{
                        background:
                          "radial-gradient(ellipse at center, rgba(99,102,241,0.05) 0%, transparent 70%)",
                      }}
                    />
                    <div className="relative">
                      <textarea
                        ref={textareaRef}
                        value={intent}
                        onChange={(e) => setIntent(e.target.value)}
                        placeholder="What are you trying to bring into this world?"
                        rows={6}
                        disabled={submitting || isRefining}
                        className="w-full bg-white/[0.04] border border-white/20 rounded-2xl px-5 py-4 text-white placeholder-white/50 text-xl resize-none focus:outline-none focus:border-indigo-400 focus:bg-white/[0.06] transition-all leading-relaxed font-sans shadow-inner backdrop-blur-md"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            handleNextStep();
                          }
                        }}
                      />

                      {/* Client-Side Prompt AI Button */}
                      {getWordCount(intent) >= 2 && isPromptMeaningful(intent) && (
                        <button
                          onClick={handleRefinePrompt}
                          disabled={isRefining}
                          className="absolute right-3.5 bottom-4 px-3.5 py-2 rounded-lg text-xs font-mono font-semibold tracking-wider uppercase border border-indigo-500/20 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20 hover:border-indigo-500/40 hover:text-white transition-all flex items-center gap-1.5 shadow-[0_0_12px_rgba(99,102,241,0.15)] disabled:opacity-50"
                        >
                          <Sparkles className={`w-3.5 h-3.5 ${isRefining ? "animate-spin text-white" : ""}`} />
                          {isRefining ? "Refining..." : "Optimize Prompt (Free)"}
                        </button>
                      )}
                    </div>
                  </div>

                  {isRefining && (
                    <div className="mt-3 text-center flex items-center justify-center gap-2">
                      <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-ping" />
                      <span className="text-xs font-mono text-indigo-400/80 uppercase tracking-widest">{refineStatus}</span>
                    </div>
                  )}

                  {error && (
                    <p className="mt-3 text-red-400/80 text-sm text-center font-mono">{error}</p>
                  )}

                  <div className="mt-6 flex justify-between items-center">
                    <span className="text-xs font-mono text-white/55 font-semibold">Step 1 of 2 · Discovery</span>
                    <button
                      onClick={() => handleNextStep()}
                      disabled={!intent.trim() || isRefining}
                      className="px-6 py-3 bg-white text-black rounded-full text-sm font-semibold disabled:opacity-30 hover:bg-white/90 active:scale-95 transition-all shadow-[0_0_20px_rgba(255,255,255,0.12)] flex items-center gap-1.5"
                    >
                      Configure Swarm <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="mt-8 flex flex-wrap gap-2 justify-center">
                    {QUICK_INTENTS.map((q, idx) => {
                      const isShining = getWordCount(intent) >= 2 && !isPromptMeaningful(intent) && idx === shiningPillIndex;
                      return (
                        <button
                          key={q.label}
                          disabled={submitting || isRefining}
                          onClick={() => setIntent(q.intent)}
                          className={`px-4.5 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-30 ${
                            isShining
                              ? "border border-indigo-400 bg-indigo-500/15 text-indigo-200 shadow-[0_0_20px_rgba(99,102,241,0.35)] scale-105"
                              : "border border-white/15 bg-white/[0.03] text-white/60 hover:border-white/30 hover:bg-white/[0.07] hover:text-white"
                          }`}
                        >
                          {q.label}
                        </button>
                      );
                    })}
                  </div>

                  <p className="mt-6 text-center text-white/35 text-xs font-mono font-medium">
                    ⌘ + Enter to continue
                  </p>
                </motion.div>
              ) : (
                <motion.div
                  key="step2"
                  initial={{ opacity: 0, x: 15 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -15 }}
                  transition={{ duration: 0.3 }}
                >
                  <div className="mb-6 p-5 border border-white/15 bg-white/[0.04] rounded-2xl backdrop-blur-xl">
                    <span className="text-[9px] tracking-widest text-indigo-400 font-mono uppercase block mb-1.5 font-bold">
                      Phase 2 · Swarm Risk & Compliance Configuration
                    </span>
                    <h2 className="text-lg font-bold text-white leading-snug">
                      Fine-tune the agent swarm prioritization
                    </h2>
                    <p className="text-[11px] text-white/70 mt-1.5 leading-relaxed font-medium">
                      Select active constraints and profile configurations. All swarms default to standard safety protocols; custom directives override standard profiles.
                    </p>
                  </div>

                  {/* Smart Compliance/Logistics Directives */}
                  <div className="mb-6 p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:border-white/[0.15] transition-all">
                    <div className="flex justify-between items-center mb-3">
                      <p className="text-xs font-mono font-bold text-indigo-200/70 tracking-wide uppercase">Active Swarm Directives</p>
                      <div className="group relative cursor-help">
                        <HelpCircle className="w-3.5 h-3.5 text-white/45 hover:text-indigo-400 transition-colors" />
                        <div className="absolute right-0 bottom-6 w-60 p-2.5 rounded-lg border border-white/20 bg-[#0c0c0e] text-[10px] text-white/80 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20 shadow-xl leading-relaxed">
                          Active regulatory audits, shipping constraints, or compliance checks injected directly into the swarm agent's reasoning process.
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {getSmartPills().map((pill) => {
                        const isSelected = selectedDirectives.includes(pill.text);
                        return (
                          <button
                            key={pill.label}
                            type="button"
                            onClick={() => handleToggleDirective(pill.text)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-mono border transition-all duration-200 active:scale-95 ${
                              isSelected
                                ? "border-indigo-400 text-indigo-200 bg-indigo-500/15 shadow-[0_0_20px_rgba(99,102,241,0.3)]"
                                : "border-white/[0.12] text-white/60 bg-white/[0.03] hover:border-white/30 hover:text-white hover:bg-white/[0.06]"
                            }`}
                          >
                            {pill.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <PillGroup
                    label="Import Cadence"
                    field="cadence"
                    options={PILL_OPTIONS.cadence}
                  />
                  <PillGroup
                    label="Primary Intent / End Use"
                    field="use"
                    options={PILL_OPTIONS.use}
                  />
                  <PillGroup
                    label="Deadline Severity"
                    field="deadline"
                    options={PILL_OPTIONS.deadline}
                  />
                  <PillGroup
                    label="Trade Experience"
                    field="experience"
                    options={PILL_OPTIONS.experience}
                  />

                  {error && (
                    <p className="mt-3 text-red-400/80 text-sm text-center font-mono">{error}</p>
                  )}

                  <div className="mt-6 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <button
                        onClick={() => setStep(1)}
                        disabled={submitting}
                        className="text-xs text-white/60 hover:text-white transition-colors font-mono font-semibold"
                      >
                        ← Back
                      </button>
                      <span className="text-[10px] font-mono text-white/55 font-semibold">Step 2 of 2</span>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => handleSubmit(true)}
                        disabled={submitting}
                        className="px-4 py-2 border border-white/20 rounded-full text-xs text-white/70 hover:border-white/40 hover:text-white active:scale-95 transition-all font-medium"
                      >
                        Skip All Profile (N/A)
                      </button>

                      <button
                        onClick={() => handleSubmit()}
                        disabled={submitting}
                        className="px-5 py-2.5 bg-indigo-600 text-white rounded-full text-xs font-semibold hover:bg-indigo-500 active:scale-95 transition-all shadow-[0_0_25px_rgba(99,102,241,0.35)] flex items-center gap-1.5"
                      >
                        {submitting ? (
                          <>
                            <RotateCw className="w-3.5 h-3.5 animate-spin" />
                            Launching Swarm...
                          </>
                        ) : (
                          <>
                            <Compass className="w-3.5 h-3.5" />
                            Launch Swarm →
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  <p className="mt-6 text-center text-white/35 text-[10px] font-mono font-medium">
                    ⌘ + Enter to launch agent swarm
                  </p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Reset DB Control */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.7, duration: 0.5 }}
              className="mt-12 flex justify-center"
            >
              <button
                onClick={handleReset}
                disabled={resetting || submitting}
                className="text-[10px] text-white/40 hover:text-indigo-400 hover:bg-indigo-500/[0.05] border border-white/10 hover:border-indigo-500/20 px-3 py-1.5 rounded-lg transition-all font-mono disabled:opacity-30 flex items-center gap-1.5"
              >
                <RotateCw className={`w-3 h-3 ${resetting ? "animate-spin" : ""}`} />
                {resetting ? "Clearing database..." : resetDone ? "✓ database cleared" : "reset system database"}
              </button>
            </motion.div>
            </div>
          </BackgroundGradientAnimation>
        </motion.main>
      )}
    </AnimatePresence>
  );
}