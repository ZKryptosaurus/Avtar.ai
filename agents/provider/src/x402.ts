import type { ProviderServerConfig } from "./config.js";

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  asset: string;
  rate: string;
  maxTimeoutSeconds: number;
}

export interface PaymentRequiredResponse {
  x402Version: 1;
  accepts: PaymentRequirements[];
  error: string;
}

export function buildPaymentRequirements(config: ProviderServerConfig): PaymentRequirements {
  return {
    scheme: "exact",
    network: config.network,
    maxAmountRequired: config.maxAmount,
    resource: "/agent/open",
    description: `Open a metered Avtar channel on ${config.network}.`,
    mimeType: "application/json",
    payTo: config.payTo,
    asset: config.asset,
    rate: config.rate,
    maxTimeoutSeconds: 120,
  };
}

export function build402Response(config: ProviderServerConfig): PaymentRequiredResponse {
  return {
    x402Version: 1,
    accepts: [buildPaymentRequirements(config)],
    error: "x402 authorization is required to open a metered channel.",
  };
}

export function readPaymentHeader(headers: Record<string, unknown>): string | null {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === "x-payment");
  const value = key === undefined ? undefined : headers[key];
  return typeof value === "string" ? value : null;
}
