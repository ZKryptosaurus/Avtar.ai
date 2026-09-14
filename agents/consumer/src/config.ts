/** Runtime config for the consumer's HTTP chat server (read from env). */
export interface ConsumerServerConfig {
  port: number;
  /** Remote provider base URL (x402 transport). */
  providerUrl: string;
  /** Allowed browser origin for CORS (Next.js dev server by default). */
  corsOrigin: string;
  /** Per-call rate in settlement token base units. */
  rate: string;
  /** Escrow ceiling in settlement token base units. */
  escrow: string;
  /** x402 payment authorization presented at channel open (mock by default). */
  paymentSignature?: string;
}

export function readConsumerServerConfig(env: NodeJS.ProcessEnv = process.env): ConsumerServerConfig {
  return {
    port: Number(env.CONSUMER_PORT ?? env.PORT ?? "4022"),
    providerUrl: env.PROVIDER_URL ?? "http://localhost:4021",
    corsOrigin: env.CORS_ORIGIN ?? "http://localhost:3000",
    rate: env.RATE ?? "0.0001",
    escrow: env.ESCROW ?? "0.01",
    paymentSignature: env.X402_PAYMENT_SIGNATURE,
  };
}
