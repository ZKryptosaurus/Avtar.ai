export interface ConsumerServerConfig {
  port: number;
  providerUrl: string;
  corsOrigin: string;
  rateAtomic: string;
  escrowAtomic: string;
  paymentAuthorization: string;
}

export function readConsumerServerConfig(env: NodeJS.ProcessEnv = process.env): ConsumerServerConfig {
  return {
    port: Number(env.AVTAR_CONSUMER_PORT ?? "4022"),
    providerUrl: env.AVTAR_PROVIDER_URL ?? "http://localhost:4021",
    corsOrigin: env.AVTAR_CORS_ORIGIN ?? "http://localhost:3000",
    rateAtomic: env.MIDNIGHT_RATE_ATOMIC ?? "100",
    escrowAtomic: env.MIDNIGHT_ESCROW_ATOMIC ?? "10000",
    paymentAuthorization: env.AVTAR_X402_AUTHORIZATION ?? "local-demo-authorization",
  };
}
