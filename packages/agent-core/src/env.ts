import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { LocalAvtarEscrowChainClient } from "./chain.js";
import type { ChainClient } from "./chain.js";

/** A configured chain client plus the 32-byte address payloads it binds. */
export interface RealChainSetup {
  chain: ChainClient;
  depositorPayload: Uint8Array;
  providerPayload: Uint8Array;
  tokenPayload: Uint8Array;
  label: string;
}

/**
 * Convert an address advertised by a provider into the 32-byte payload the
 * settlement binds. A deterministic SHA-256 of the string, so any address
 * format (or a demo placeholder) always produces a consistent payload.
 */
export function addressToPayload(address: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(address).digest());
}

function hexOrRandom(hex: string | undefined): Uint8Array {
  if (hex === undefined) return randomBytes(32);
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`expected 64 hex chars (32 bytes), received "${hex}"`);
  }
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

/**
 * Build a chain client from the environment, or `null` when the caller
 * should fall back to a {@link MockChainClient}.
 *
 * There is no live-network tier yet (see
 * `packages/onchain-setup/midnight/deploy.mjs` for exactly why —
 * `deployContract`/submission need an SDK version pairing that isn't
 * resolved). Setting `MIDNIGHT_WALLET_SEED` (the "go real" signal) throws
 * with that same explanation rather than silently doing something else, so a
 * real seed never gets ignored quietly.
 *
 * The honest middle tier available today: `MIDNIGHT_LOCAL_SIM=true` runs
 * the ACTUAL compiled `avtar-escrow` circuits against local, in-memory
 * ledger state (see {@link LocalAvtarEscrowChainClient}) — real signature
 * verification and escrow/balance bookkeeping, just no network.
 *
 * Env:
 *  - `MIDNIGHT_LOCAL_SIM`            "true" to use the local-simulation chain client.
 *  - `MIDNIGHT_WALLET_SEED`          reserved for the live tier; throws until that's wired.
 *  - `MIDNIGHT_DEPOSITOR_ADDRESS`, `MIDNIGHT_PROVIDER_ADDRESS`, `MIDNIGHT_TOKEN_ADDRESS`
 *                                    optional 32-byte hex payloads; random per-run if unset
 *                                    (fine for local simulation, not for anything durable).
 */
export function realChainFromEnv(env: NodeJS.ProcessEnv = process.env): RealChainSetup | null {
  if (env.MIDNIGHT_WALLET_SEED) {
    throw new Error(
      "MIDNIGHT_WALLET_SEED is set, but live Midnight submission isn't wired yet — " +
        "see packages/onchain-setup/midnight/deploy.mjs for the exact blocker " +
        "(the deployContract() CompiledContract SDK version). Unset it, or set " +
        "MIDNIGHT_LOCAL_SIM=true to run the real compiled circuit locally (no network) instead.",
    );
  }
  if ((env.MIDNIGHT_LOCAL_SIM ?? "").toLowerCase() !== "true") return null;

  const depositorPayload = hexOrRandom(env.MIDNIGHT_DEPOSITOR_ADDRESS);
  const providerPayload = hexOrRandom(env.MIDNIGHT_PROVIDER_ADDRESS);
  const tokenPayload = hexOrRandom(env.MIDNIGHT_TOKEN_ADDRESS);

  const chain = new LocalAvtarEscrowChainClient();
  chain.whitelistToken(tokenPayload);

  return {
    chain,
    depositorPayload,
    providerPayload,
    tokenPayload,
    label: `midnight-local-sim depositor=${Buffer.from(depositorPayload).toString("hex").slice(0, 6)}… provider=${Buffer.from(providerPayload).toString("hex").slice(0, 6)}… token=${Buffer.from(tokenPayload).toString("hex").slice(0, 6)}…`,
  };
}
