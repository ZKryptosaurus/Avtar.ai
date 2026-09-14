import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { midnightConfigFromEnv } from "@avtar/onchain-setup";
import { LocalAvtarEscrowChainClient } from "./chain.js";
import { LiveAvtarEscrowChainClient } from "./live-chain.js";
import type { ChainClient } from "./chain.js";

/** A configured chain client plus the 32-byte address payloads it binds. */
export interface RealChainSetup {
  chain: ChainClient;
  depositorPayload: Uint8Array;
  providerPayload: Uint8Array;
  tokenPayload: Uint8Array;
  label: string;
  network: ReturnType<typeof midnightSettlementNetwork>;
}

/** Parse the canonical 32-byte hexadecimal payload advertised by a provider. */
export function addressToPayload(address: string): Uint8Array {
  const clean = address.startsWith("0x") || address.startsWith("0X") ? address.slice(2) : address;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`expected 64 hex chars (32 bytes), received "${address}"`);
  }
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

function hexOrRandom(hex: string | undefined): Uint8Array {
  if (hex === undefined) return randomBytes(32);
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`expected 64 hex chars (32 bytes), received "${hex}"`);
  }
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

/** Explicit simulation always wins; otherwise a configured network is live. */
export function midnightSettlementNetwork(env: NodeJS.ProcessEnv = process.env): "midnight:local-sim" | "midnight:preprod" | "midnight:preview" {
  if ((env.MIDNIGHT_LOCAL_SIM ?? "").toLowerCase() === "true") return "midnight:local-sim";
  if (!env.MIDNIGHT_WALLET_SEED && !env.MIDNIGHT_NETWORK_ID) return "midnight:local-sim";
  const network = env.MIDNIGHT_NETWORK_ID ?? "preprod";
  if (network !== "preprod" && network !== "preview") throw new Error("Live settlement requires Preprod or Preview");
  return `midnight:${network}`;
}

export function realChainFromEnv(env: NodeJS.ProcessEnv = process.env): RealChainSetup | null {
  const local = (env.MIDNIGHT_LOCAL_SIM ?? "").toLowerCase() === "true";
  if (!local && !env.MIDNIGHT_WALLET_SEED) return null;
  const network = midnightSettlementNetwork(env);
  if (!local && !env.MIDNIGHT_AVTAR_ESCROW_ADDRESS) throw new Error("MIDNIGHT_AVTAR_ESCROW_ADDRESS is required for live settlement");
  for (const key of ["MIDNIGHT_DEPOSITOR_ADDRESS", "MIDNIGHT_PROVIDER_ADDRESS", "MIDNIGHT_TOKEN_ADDRESS"]) {
    if (!local && !env[key]) throw new Error(`${key} is required for live settlement; random addresses are only allowed in simulation`);
  }
  const depositorPayload = hexOrRandom(env.MIDNIGHT_DEPOSITOR_ADDRESS);
  const providerPayload = hexOrRandom(env.MIDNIGHT_PROVIDER_ADDRESS);
  const tokenPayload = hexOrRandom(env.MIDNIGHT_TOKEN_ADDRESS);
  let chain: ChainClient;
  if (local) {
    const simulator = new LocalAvtarEscrowChainClient();
    simulator.whitelistToken(tokenPayload);
    chain = simulator;
  } else {
    chain = new LiveAvtarEscrowChainClient(midnightConfigFromEnv({}, env), env.MIDNIGHT_FEE_SPONSOR_URL);
  }
  return { chain, depositorPayload, providerPayload, tokenPayload, network,
    label: `${network} depositor=${Buffer.from(depositorPayload).toString("hex").slice(0,6)}… provider=${Buffer.from(providerPayload).toString("hex").slice(0,6)}…` };
}
