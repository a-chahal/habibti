const BASE_URL = "https://openrouter.ai/api/v1/chat/completions";

// Strip markdown code fences that models sometimes add despite response_format: json_object
// Also handles truncated (unclosed) fenced blocks — strip opening fence, keep content as-is
function stripFences(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("```")) {
    const firstNewline = trimmed.indexOf("\n");
    if (firstNewline !== -1) {
      const lastFence = trimmed.lastIndexOf("```");
      if (lastFence > firstNewline) {
        // Complete fenced block — strip both fences
        return trimmed.slice(firstNewline + 1, lastFence).trim();
      } else {
        // Truncated block (no closing fence) — strip only opening fence line
        return trimmed.slice(firstNewline + 1).trim();
      }
    }
  }
  return trimmed;
}
const TIMEOUT_MS = 60_000;

const MODELS = {
  opus: "anthropic/claude-opus-4-7",
  sonnet: "anthropic/claude-sonnet-4-6",
  mercury: "inception/mercury-2",
} as const;

// Rough cost per million tokens (input/output) in USD
const COST_PER_M: Record<string, [number, number]> = {
  "anthropic/claude-opus-4-7": [15, 75],
  "anthropic/claude-sonnet-4-6": [3, 15],
  "inception/mercury-2": [0.25, 1.25],
};

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CallOpts {
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Enable OpenRouter's built-in web-search plugin (Exa-backed). Adds ~$0.02/call. */
  web?: boolean;
}

interface OpenRouterResponse {
  id: string;
  choices: { message: { content: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function call(
  model: string,
  messages: Message[],
  opts: CallOpts = {},
  attempt = 0
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 2048,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  if (opts.web) body.plugins = [{ id: "web" }];

  let res: Response;
  try {
    res = await fetchWithTimeout(BASE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://habibti.trade",
        "X-Title": "Habibti Trade Platform",
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    if (attempt === 0 && (err.name === "AbortError" || err.message?.includes("timeout"))) {
      return call(model, messages, opts, 1);
    }
    throw err;
  }

  if (res.status >= 500 && attempt === 0) {
    return call(model, messages, opts, 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }

  const data: OpenRouterResponse = await res.json();
  const raw = data.choices[0]?.message?.content ?? "";

  // Log token usage + estimated cost
  if (data.usage) {
    const [inCost, outCost] = COST_PER_M[model] ?? [0, 0];
    const cost =
      (data.usage.prompt_tokens / 1_000_000) * inCost +
      (data.usage.completion_tokens / 1_000_000) * outCost;
    console.log(
      `[LLM] ${model} | in=${data.usage.prompt_tokens} out=${data.usage.completion_tokens} | ~$${cost.toFixed(6)}`
    );
  }

  // Strip markdown code fences that some models add despite json_object mode
  const content = stripFences(raw);

  // Retry once on JSON parse failure when json mode requested
  if (opts.json && attempt === 0) {
    try {
      JSON.parse(content);
    } catch {
      return call(model, messages, opts, 1);
    }
  }

  return content;
}

export async function callOpus(messages: Message[], opts?: CallOpts) {
  return call(MODELS.opus, messages, opts);
}

export async function callSonnet(messages: Message[], opts?: CallOpts) {
  return call(MODELS.sonnet, messages, opts);
}

export async function callMercury(messages: Message[], opts?: CallOpts) {
  return call(MODELS.mercury, messages, opts);
}
