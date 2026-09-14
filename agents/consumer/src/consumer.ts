import type { LlmClient } from "./llm.js";
import type { MeteredServiceChannel } from "@avtar/agent-core";
import type { WeatherRequest, WeatherResult } from "@avtar/agent-provider";

export interface LookupRecord {
  location: string;
  served: boolean;
  result?: WeatherResult;
  reason?: string;
}

export interface ConsumerRunResult {
  answer: string;
  lookups: LookupRecord[];
}

/**
 * An LLM-driven consumer agent. Given a natural-language goal, it asks the LLM
 * which locations to look up, buys each weather call through the metered channel
 * (paying per call), feeds the results back to the LLM, and repeats until the
 * LLM produces a final answer. The channel handles the privacy-preserving
 * payment; the LLM handles the "what to ask" — together they are a meaningful
 * consumer that genuinely uses the provider's service.
 */
export class WeatherConsumerAgent {
  constructor(
    private readonly channel: MeteredServiceChannel<WeatherRequest, WeatherResult>,
    private readonly llm: LlmClient,
    private readonly maxRounds = 4,
  ) {}

  async run(goal: string): Promise<ConsumerRunResult> {
    const gathered: WeatherResult[] = [];
    const lookups: LookupRecord[] = [];

    for (let round = 0; round < this.maxRounds; round++) {
      const decision = await this.llm.decide(goal, gathered);
      if (decision.answer !== undefined) {
        return { answer: decision.answer, lookups };
      }
      const locations = decision.lookups ?? [];
      if (locations.length === 0) break;

      for (const location of locations) {
        const out = await this.channel.call({ location });
        lookups.push({ location, served: out.served, result: out.result, reason: out.reason });
        if (out.served && out.result) {
          gathered.push(out.result);
        } else if (out.reason === "ceiling-exceeded") {
          // Escrow exhausted — stop buying and let the LLM answer with what we have.
          const final = await this.llm.decide(goal, gathered);
          return { answer: final.answer ?? "(escrow exhausted)", lookups };
        }
      }
    }

    // Force a final synthesis round.
    const final = await this.llm.decide(goal, gathered);
    return { answer: final.answer ?? "(no answer)", lookups };
  }
}
