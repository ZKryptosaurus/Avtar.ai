import type { ToolResult } from "@avtar/agent-core";
import type { AgentBrain, AgentDecision } from "./agent.js";
import type { ToolSpec } from "@avtar/agent-provider";

/**
 * OpenAI-backed tool-using brain. The provider's tools are handed to the model
 * as function tools; the model decides WHICH to call (and with what args), or
 * gives a final answer once it has enough results. This is the piece that makes
 * the consumer "figure out which service it needs."
 *
 * Requires OPENAI_API_KEY; `openai` is imported dynamically so the offline stub
 * path never needs it installed.
 */
export class OpenAiAgentBrain implements AgentBrain {
  constructor(private readonly opts: { apiKey?: string; model?: string } = {}) {}

  async decide(goal: string, tools: ToolSpec[], gathered: ToolResult[]): Promise<AgentDecision> {
    const apiKey = this.opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    const model = this.opts.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini";

    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey });

    const openaiTools = tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const gatheredText = gathered.length
      ? gathered.map((g) => `${g.tool}: ${JSON.stringify(g.result)}`).join("\n")
      : "(nothing yet)";

    const res = await client.chat.completions.create({
      model,
      tools: openaiTools,
      messages: [
        {
          role: "system",
          content:
            "You are a consumer agent with a set of PAID metered tools. Each tool call costs money, " +
            "so call only the tools you actually need to satisfy the goal. When you have enough " +
            "results, reply with a final natural-language answer and no tool call.",
        },
        { role: "user", content: `Goal: ${goal}\n\nResults so far:\n${gatheredText}` },
      ],
    });

    const msg = res.choices[0]?.message;
    const toolCalls = msg?.tool_calls ?? [];
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];

    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.function.arguments || "{}");
        if (parsed !== null && typeof parsed === "object") {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // ignore malformed tool arguments; treat as empty
      }
      calls.push({ tool: call.function.name, args });
    }

    if (calls.length > 0) return { calls };
    return { answer: msg?.content ?? "(no answer)" };
  }
}
