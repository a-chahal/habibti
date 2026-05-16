import { z } from "zod";
import { Agent } from "../base";

const EchoOutput = z.object({
  echo: z.string(),
  timestamp: z.string(),
  model: z.literal("mercury"),
  charCount: z.number(),
});

export type EchoOutput = z.infer<typeof EchoOutput>;

export class EchoAgent extends Agent {
  readonly name = "echo-agent";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<EchoOutput> {
    const text = typeof input === "string" ? input : JSON.stringify(input);

    return this.callLLMValidated(
      [
        {
          role: "system",
          content:
            "You are an echo agent. Return a JSON object with exactly these fields: echo (the user's message repeated), timestamp (current ISO timestamp), model (always the string 'mercury'), charCount (number of characters in the echo string).",
        },
        { role: "user", content: text },
      ],
      EchoOutput
    );
  }
}
