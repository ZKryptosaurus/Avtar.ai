import type { WeatherResult } from "@avtar/agent-provider";

/**
 * The decision an LLM consumer makes each round: either ask for more weather
 * lookups, or produce a final answer from the results gathered so far.
 */
export interface LlmDecision {
  /** Place names to look up next (each becomes one paid weather call). */
  lookups?: string[];
  /** Final natural-language answer; when set, the consumer stops. */
  answer?: string;
}

export interface LlmClient {
  /** Given the goal and the weather gathered so far, decide the next step. */
  decide(goal: string, gathered: WeatherResult[]): Promise<LlmDecision>;
}

/**
 * A deterministic stub LLM for offline tests and demos — no network, no key. It
 * extracts candidate place names from the goal, requests them once, then answers
 * by naming the warmest gathered location. Swap in {@link OpenAiLlmClient} for
 * the real thing.
 */
export class StubLlmClient implements LlmClient {
  async decide(goal: string, gathered: WeatherResult[]): Promise<LlmDecision> {
    if (gathered.length === 0) {
      const places = extractPlaces(goal);
      return { lookups: places.length ? places : ["London"] };
    }
    const warmest = [...gathered].sort((a, b) => b.temperatureC - a.temperatureC)[0];
    if (!warmest) return { answer: "No weather data was gathered." };
    const list = gathered
      .map((g) => `${g.location} ${g.temperatureC}°C (${g.summary})`)
      .join("; ");
    return {
      answer: `Checked ${gathered.length} location(s): ${list}. Warmest right now: ${warmest.location} at ${warmest.temperatureC}°C.`,
    };
  }
}

const STOPWORDS = new Set([
  "Which", "What", "Where", "When", "The", "Is", "Are", "Or", "And", "For", "A", "An",
  "In", "Of", "To", "Compare", "Tell", "Me", "Current", "Weather", "Today", "Tomorrow", "City",
]);

function extractPlaces(goal: string): string[] {
  const matches = goal.match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\b/g) ?? [];
  const out: string[] = [];
  for (const m of matches) {
    if (STOPWORDS.has(m)) continue;
    if (!out.includes(m)) out.push(m);
  }
  return out.slice(0, 5);
}
