import type { MeterChannelSnapshot } from "./db.js";
import type { SettlementResult } from "./channel.js";

/**
 * Assembles a settlement from durable channel state. No proof to build: a
 * Midnight circuit call proves its own execution, so this just gathers the
 * raw private witnesses `avtar-escrow.settle` needs from the persisted
 * channel terms plus the final accepted voucher — the actual proving happens
 * when the call is submitted (see `ChainClient` in `chain.ts`). Throws if no
 * voucher was ever accepted (nothing to settle).
 *
 * Type-only import of MeterChannelSnapshot keeps this module free of
 * node:sqlite, so it is safe to re-export from the main barrel.
 */
export function settlementFromSnapshot(snapshot: MeterChannelSnapshot): SettlementResult {
  const final = snapshot.latestVoucher;
  if (final === undefined) {
    throw new Error("no accepted vouchers — nothing to settle");
  }
  return {
    channelId: snapshot.terms.channelId,
    rate: snapshot.terms.rate,
    rateBlind: snapshot.terms.rateBlind,
    totalUnits: final.totalUnits,
    channelSecret: snapshot.terms.channelSecret,
    signature: final.signature,
    escrowAmount: snapshot.terms.escrow,
  };
}
