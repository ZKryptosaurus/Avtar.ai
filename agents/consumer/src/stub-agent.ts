import type { ToolResult } from "@avtar/agent-core";
import type { AgentBrain, AgentDecision } from "./agent.js";
import type { ToolSpec } from "@avtar/agent-provider";

const COINS: Record<string, string> = {
  btc: "bitcoin", bitcoin: "bitcoin", eth: "ethereum", ethereum: "ethereum",
  sol: "solana", solana: "solana",
  usdc: "usd-coin", ada: "cardano", cardano: "cardano", doge: "dogecoin", dogecoin: "dogecoin",
};
const CURRENCIES: Record<string, string> = { usd: "usd", eur: "eur", gbp: "gbp", jpy: "jpy" };
const LANGS: Record<string, string> = {
  japanese: "ja", french: "fr", spanish: "es", german: "de", italian: "it",
  portuguese: "pt", hindi: "hi", chinese: "zh-CN", korean: "ko", russian: "ru", arabic: "ar",
};

/**
 * A deterministic, offline brain that ROUTES a goal to the right tools by
 * keyword — no LLM, no key, no network. It's good enough to demo multi-service
 * selection offline; the {@link OpenAiAgentBrain} does the real reasoning. It
 * emits all detected calls in the first round, then answers by summarising the
 * results it got back.
 */
export class StubAgentBrain implements AgentBrain {
  async decide(goal: string, _tools: ToolSpec[], gathered: ToolResult[]): Promise<AgentDecision> {
    if (gathered.length > 0) {
      const parts = gathered.map((g) => formatToolResult(g.tool, g.result));
      return { answer: parts.join("\n\n") };
    }

    const g = goal.toLowerCase();
    const words = g.split(/[^a-z0-9-]+/).filter((w) => w.length > 0);
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];

    // crypto spot price
    const coin = words.map((w) => COINS[w]).find((c) => c !== undefined);
    if (coin !== undefined) {
      const vs = words.map((w) => CURRENCIES[w]).find((c) => c !== undefined) ?? "usd";
      calls.push({ tool: "get_crypto_price", args: { coin, vs } });
    }

    // translation
    if (g.includes("translat")) {
      const parsed = parseTranslation(goal);
      if (parsed !== null) calls.push({ tool: "translate_text", args: parsed });
    }

    // weather
    const weatherish = /weather|temperature|warm|forecast|climate|rain|hot|cold/.test(g);
    if (weatherish || calls.length === 0) {
      for (const place of extractPlaces(goal).slice(0, 3)) {
        calls.push({ tool: "get_weather", args: { location: place } });
      }
    }

    if (calls.length === 0) calls.push({ tool: "get_weather", args: { location: "London" } });
    return { calls };
  }
}

function parseTranslation(goal: string): { text: string; to: string } | null {
  const lower = goal.toLowerCase();
  let to: string | undefined;
  for (const [name, code] of Object.entries(LANGS)) {
    if (lower.includes(name)) {
      to = code;
      break;
    }
  }
  if (to === undefined) return null;

  const quoted = goal.match(/["'\u201c\u201d]([^"'\u201c\u201d]+)["'\u201c\u201d]/);
  if (quoted?.[1]?.trim()) {
    return { text: quoted[1].trim(), to };
  }

  const unquoted = goal.match(/translat(?:e|ion)?\s+(.+?)\s+(?:to|into)\s+/i);
  if (unquoted?.[1]) {
    const text = unquoted[1].replace(/^["'\u201c\u201d]|["'\u201c\u201d]$/g, "").trim();
    if (text.length > 0) return { text, to };
  }

  return null;
}

const NOISE = new Set([
  "Which", "What", "Where", "When", "The", "Is", "Are", "Or", "And", "For", "A", "An",
  "In", "Of", "To", "Into", "Compare", "Tell", "Me", "Current", "Weather", "Today",
  "Tomorrow", "City", "Price", "USD", "EUR", "GBP", "JPY", "ETH", "BTC", "SOL",
  "Japanese", "French", "Spanish", "German", "Italian", "Portuguese", "Hindi", "Chinese",
  "Korean", "Russian", "Arabic", "Translate", "Good", "Morning",
]);

function extractPlaces(goal: string): string[] {
  const matches = goal.match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\b/g) ?? [];
  const out: string[] = [];
  for (const m of matches) {
    if (NOISE.has(m)) continue;
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

function formatToolResult(tool: string, result: unknown): string {
  if (result === null || typeof result !== "object") return String(result);

  const r = result as Record<string, unknown>;

  if (tool === "get_weather") {
    const location = r.location ?? "Unknown";
    const temp = r.temperatureC;
    const summary = r.summary ?? "unknown conditions";
    const wind = r.windKph;
    return `Weather in ${location}: ${temp}°C, ${summary}${wind !== undefined ? `, wind ${wind} km/h` : ""}.`;
  }

  if (tool === "get_crypto_price") {
    const coin = r.coin ?? r.id ?? "asset";
    const price = r.price ?? r.usd;
    const change = r.change24h ?? r.change_24h;
    const suffix = change !== undefined ? ` (${Number(change) >= 0 ? "+" : ""}${change}% 24h)` : "";
    return `${coin} price: ${price}${suffix}.`;
  }

  if (tool === "translate_text") {
    const translated = r.translatedText ?? r.text ?? JSON.stringify(result);
    return `Translation: ${translated}`;
  }

  return JSON.stringify(result);
}
