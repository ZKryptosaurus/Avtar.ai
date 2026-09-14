import type { LlmClient, LlmDecision } from "./llm.js";
import type { WeatherResult } from "@avtar/agent-provider";

/**
 * OpenAI-backed consumer brain. Uses function-calling: the model is given a
 * `lookup_weather` tool and asked to either request locations or produce a final
 * answer.
 *
 * Requires OPENAI_API_KEY. The `openai` package is imported dynamically so the
 * offline path (StubLlmClient) never needs it installed.
 */
export class OpenAiLlmClient implements LlmClient {
  constructor(private readonly opts: { apiKey?: string; model?: string } = {}) {}

  async decide(goal: string, gathered: WeatherResult[]): Promise<LlmDecision> {
    const apiKey = this.opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    const model = this.opts.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini";

    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey });

    const tools = [
      {
        type: "function" as const,
        function: {
          name: "lookup_weather",
          description:
            "Get current weather for one or more place names. Each place is one paid metered call, so only request what you need.",
          parameters: {
            type: "object",
            properties: {
              locations: {
                type: "array",
                items: { type: "string" },
                description: "Place names to look up, e.g. ['Tokyo','London']",
              },
            },
            required: ["locations"],
          },
        },
      },
    ];

    const gatheredText = gathered.length
      ? gathered
          .map((g) => `${g.location}: ${g.temperatureC}°C, ${g.summary}, wind ${g.windKph} kph`)
          .join("\n")
      : "(none yet)";

    const res = await client.chat.completions.create({
      model,
      tools,
      messages: [
        {
          role: "system",
          content:
            "You are a consumer agent that buys weather data per call from a metered provider. " +
            "Call lookup_weather for the places you need; once you have enough data, reply with a final answer and no tool call.",
        },
        { role: "user", content: `Goal: ${goal}\n\nWeather gathered so far:\n${gatheredText}` },
      ],
    });

    const msg = res.choices[0]?.message;
    const call = msg?.tool_calls?.[0];
    if (call && call.type === "function" && call.function?.name === "lookup_weather") {
      const args = JSON.parse(call.function.arguments || "{}");
      const locations: string[] = Array.isArray(args.locations) ? args.locations : [];
      if (locations.length) return { lookups: locations };
    }
    return { answer: msg?.content ?? "(no answer)" };
  }
}
