/** Logical service providers behind the x402 gateway (one tool = one provider). */
export const TOOL_PROVIDERS: Record<string, { id: string; label: string }> = {
  get_weather: { id: "weather-provider", label: "Weather" },
  get_crypto_price: { id: "crypto-provider", label: "Crypto price" },
  translate_text: { id: "translation-provider", label: "Translation" },
};

export const ALL_TOOLS = Object.keys(TOOL_PROVIDERS);

export function providerForTool(tool: string): { id: string; label: string } {
  return TOOL_PROVIDERS[tool] ?? { id: tool, label: tool };
}

/** Comma-separated labels for all toolbox providers (matches demo.ts "services offered"). */
export function allProviderLabels(): string {
  return Object.values(TOOL_PROVIDERS)
    .map((p) => p.label)
    .join(", ");
}

export function gatewayStepDetail(gateway: { name: string; url: string }): string {
  return `${gateway.name} · ${gateway.url}\nProviders: ${allProviderLabels()}`;
}
