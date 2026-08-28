import type { ConsumerPublicKey } from "@avtar/proving-setup";
import { LocalAvtarEscrowContract } from "@avtar/onchain-setup";
import type { SettlementResult } from "./channel.js";

/**
 * The on-chain seam. `settle` takes raw private witnesses (rate, rateBlind,
 * totalUnits, channelSecret, Schnorr signature) rather than a serialized
 * proof, because on Midnight the `settle` circuit call itself IS the proof —
 * there's nothing to build client-side before submitting.
 */
export interface OpenChannelArgs {
  channelId: bigint;
  rateCommitment: Uint8Array;
  consumerPublicKey: ConsumerPublicKey;
  depositor: Uint8Array;
  provider: Uint8Array;
  token: Uint8Array;
  /** Escrow to lock, in the settlement token's atomic units. */
  escrow: bigint;
}

export interface SettleArgs extends SettlementResult {
  depositor: Uint8Array;
  provider: Uint8Array;
  token: Uint8Array;
}

export interface ChainClient {
  openChannel(args: OpenChannelArgs): Promise<{ channelId: string; openTx: string }>;
  settle(args: SettleArgs): Promise<{ settleTx: string }>;
}

function shortHex(value: bigint): string {
  return value.toString(16).slice(0, 10);
}

/**
 * In-memory fake for local demos/tests: records calls, touches no contract,
 * no crypto. Use {@link LocalAvtarEscrowChainClient} instead when you want
 * the actual compiled circuit's logic (signature checks, escrow/balance
 * bookkeeping) exercised without a live network.
 */
export class MockChainClient implements ChainClient {
  async openChannel(args: OpenChannelArgs): Promise<{ channelId: string; openTx: string }> {
    return { channelId: args.channelId.toString(), openTx: `mock_open_${shortHex(args.channelId)}` };
  }

  async settle(args: SettleArgs): Promise<{ settleTx: string }> {
    return { settleTx: `mock_settle_${shortHex(args.channelId)}_${args.totalUnits}` };
  }
}

/**
 * Runs `avtar-escrow`'s REAL compiled circuits against local, in-memory
 * ledger state (via `LocalAvtarEscrowContract`) — no network, no wallet, no
 * transaction submission, but genuine cryptographic + contract-logic
 * execution: an invalid voucher signature or an over-budget settlement is
 * rejected exactly as it would be on-chain, because it's the same compiled
 * circuit doing the rejecting.
 *
 * This is the honest stand-in for a live network client until the deploy SDK
 * version question is resolved (see `onchain-setup/midnight/deploy.mjs`) —
 * once it is, a live client wraps proof generation + submission around the
 * same circuit calls this class already makes.
 */
export class LocalAvtarEscrowChainClient implements ChainClient {
  readonly #contract: LocalAvtarEscrowContract;

  constructor(contract: LocalAvtarEscrowContract = new LocalAvtarEscrowContract()) {
    this.#contract = contract;
  }

  /** Read the local contract's ledger state (for tests/inspection). */
  get ledger(): LocalAvtarEscrowContract["ledger"] {
    return this.#contract.ledger;
  }

  /** Whitelist a settlement token — required once before any channel can open with it. */
  whitelistToken(token: Uint8Array): void {
    this.#contract.whitelistToken(token);
  }

  async openChannel(args: OpenChannelArgs): Promise<{ channelId: string; openTx: string }> {
    this.#contract.openChannel({
      channelId: args.channelId,
      rateCommitment: args.rateCommitment,
      consumerPublicKey: args.consumerPublicKey,
      depositor: args.depositor,
      provider: args.provider,
      token: args.token,
      amount: args.escrow,
    });
    return { channelId: args.channelId.toString(), openTx: `local_open_${shortHex(args.channelId)}` };
  }

  async settle(args: SettleArgs): Promise<{ settleTx: string }> {
    this.#contract.settle({
      channelId: args.channelId,
      rate: args.rate,
      rateBlind: args.rateBlind,
      totalUnits: args.totalUnits,
      channelSecret: args.channelSecret,
      signature: args.signature,
      escrowAmount: args.escrowAmount,
      depositor: args.depositor,
      provider: args.provider,
      token: args.token,
    });
    return { settleTx: `local_settle_${shortHex(args.channelId)}_${args.totalUnits}` };
  }
}
