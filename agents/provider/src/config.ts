import { midnightSettlementNetwork } from "@avtar/agent-core";
export interface ProviderServerConfig {
  port: number;
  network: ReturnType<typeof midnightSettlementNetwork>;
  asset: string;
  payTo: string;
  rate: string;
  maxAmount: string;
}

const DEFAULT_PROVIDER_ADDRESS = `0x${"11".repeat(32)}`;
const DEFAULT_TOKEN_ADDRESS = `0x${"22".repeat(32)}`;

export function readProviderServerConfig(env: NodeJS.ProcessEnv = process.env): ProviderServerConfig {
  const network = midnightSettlementNetwork(env);
  if (network !== "midnight:local-sim" && (!env.MIDNIGHT_PROVIDER_ADDRESS || !env.MIDNIGHT_TOKEN_ADDRESS)) {
    throw new Error("Live provider requires MIDNIGHT_PROVIDER_ADDRESS and MIDNIGHT_TOKEN_ADDRESS");
  }
  return {
    port: Number(env.AVTAR_PROVIDER_PORT ?? "4021"),
    network,
    asset: env.MIDNIGHT_TOKEN_ADDRESS ?? DEFAULT_TOKEN_ADDRESS,
    payTo: env.MIDNIGHT_PROVIDER_ADDRESS ?? DEFAULT_PROVIDER_ADDRESS,
    rate: env.MIDNIGHT_RATE_ATOMIC ?? "100",
    maxAmount: env.MIDNIGHT_X402_MAX_AMOUNT_ATOMIC ?? "10000",
  };
}
