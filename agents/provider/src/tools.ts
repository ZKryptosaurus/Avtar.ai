import { ToolboxService } from "@avtar/agent-core";
import type { HttpClient } from "./http.js";
import { WeatherService } from "./weather.js";
import { CryptoPriceService } from "./crypto.js";
import { TranslationService } from "./translation.js";

/** A tool the provider offers, described for an LLM consumer (JSON-schema params). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * The provider's offered tools, advertised to consumers (e.g. via the x402
 * agent-card). Each `name` MUST match the key used in {@link buildToolbox} so a
 * ToolCall routes to the right sub-service.
 */
export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "get_weather",
    description: "Current weather for a place (temperature, wind, conditions). One paid call.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "Place name, e.g. 'Tokyo' or 'Paris, France'" },
      },
      required: ["location"],
    },
  },
  {
    name: "get_crypto_price",
    description: "Current crypto spot price and 24h change. One paid call.",
    parameters: {
      type: "object",
      properties: {
        coin: {
          type: "string",
          description: "CoinGecko coin id, e.g. 'bitcoin' or 'ethereum'",
        },
        vs: { type: "string", description: "Quote currency, e.g. 'usd' (default), 'eur'" },
      },
      required: ["coin"],
    },
  },
  {
    name: "translate_text",
    description: "Translate text into a target language. One paid call.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to translate" },
        to: { type: "string", description: "Target language ISO 639-1 code, e.g. 'fr', 'ja'" },
        from: { type: "string", description: "Source language code, default 'en'" },
      },
      required: ["text", "to"],
    },
  },
];

/**
 * Build the toolbox this provider serves. Keys MUST match {@link TOOL_SPECS}
 * names — that mapping is how a tool call routes to its sub-service. Everything
 * meters over one channel, so any mix of tools settles with one proof.
 */
export function buildToolbox(http: HttpClient): ToolboxService {
  return new ToolboxService({
    get_weather: new WeatherService(http, 1n),
    get_crypto_price: new CryptoPriceService(http, 1n),
    translate_text: new TranslationService(http, 1n),
  });
}
