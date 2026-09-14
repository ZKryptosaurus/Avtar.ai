import { formatUnits } from "@avtar/agent-core";
import type { CallRecord, TurnPayment } from "./agent.js";
import { providerForTool, gatewayStepDetail } from "./providers.js";

export interface ProviderInfo {
  name: string;
  url: string;
}

export interface AgentStep {
  kind: "gateway" | "tool_call" | "answer" | "provider_settlement" | "payment_total";
  label: string;
  detail?: string;
  tool?: string;
  service?: string;
  providerId?: string;
  args?: Record<string, unknown>;
  served?: boolean;
  summary?: string;
  reason?: string;
}

function summarizeCall(tool: string, result: unknown): string {
  if (result === null || typeof result !== "object") return String(result);
  const r = result as Record<string, unknown>;

  if (tool === "get_weather") {
    return `${r.location}: ${r.temperatureC}°C, ${r.summary ?? "—"}`;
  }
  if (tool === "get_crypto_price") {
    return `${r.coin ?? r.id}: ${r.price ?? r.usd}`;
  }
  if (tool === "translate_text") {
    return String(r.translatedText ?? r.text ?? "—");
  }
  return JSON.stringify(result);
}

export function buildAgentSteps(
  gateway: ProviderInfo,
  calls: CallRecord[],
  answer: string,
  payment: TurnPayment,
): AgentStep[] {
  const steps: AgentStep[] = [
    {
      kind: "gateway",
      label: "x402 gateway",
      detail: gatewayStepDetail(gateway),
    },
  ];

  for (const [index, call] of calls.entries()) {
    const provider = providerForTool(call.tool);
    steps.push({
      kind: "tool_call",
      label: `Call ${index + 1}: ${provider.label}`,
      tool: call.tool,
      service: provider.label,
      providerId: provider.id,
      args: call.args,
      served: call.served,
      summary: call.served ? summarizeCall(call.tool, call.result) : undefined,
      reason: call.served ? undefined : call.reason,
      detail: call.served
        ? summarizeCall(call.tool, call.result)
        : (call.reason ?? "not served"),
    });
  }

  steps.push({
    kind: "answer",
    label: "Final answer",
    detail: answer,
  });

  if (payment.providers.length > 0) {
    for (const p of payment.providers) {
      if (p.turnCalls === 0) continue;
      const turnAmt = formatUnits(BigInt(p.turnBillable));
      steps.push({
        kind: "provider_settlement",
        label: `Settlement: ${p.providerLabel}`,
        providerId: p.providerId,
        tool: p.tool,
        service: p.providerLabel,
        detail: `${p.turnCalls} call(s) · ${turnAmt} ${payment.tokenSymbol}`,
      });
    }
  }

  const turnBillable = formatUnits(BigInt(payment.turnBillable));
  const usedProviders = payment.providers.filter((p) => p.turnCalls > 0).length;
  steps.push({
    kind: "payment_total",
    label: "Turn payment (metered, settles on session close)",
    detail:
      payment.turnCalls > 0
        ? `${payment.turnCalls} call(s) across ${usedProviders} provider(s) · ${turnBillable} ${payment.tokenSymbol}`
        : "No metered calls this turn",
  });

  return steps;
}
