import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import type { ChargedState, ContractAddress } from "@midnight-ntwrk/compact-runtime";
import type { ConsumerPublicKey, VoucherSignature } from "@avtar/proving-setup/midnight";
import {
  Contract,
  ledger,
  type Ledger,
} from "../midnight/contracts/avtar-escrow/managed/contract/index.js";

export interface OpenChannelArgs {
  channelId: bigint;
  rateCommitment: Uint8Array;
  consumerPublicKey: ConsumerPublicKey;
  depositor: Uint8Array;
  provider: Uint8Array;
  token: Uint8Array;
  /** Escrow to lock, in the settlement token's atomic units. */
  amount: bigint;
}

export interface SettleArgs {
  channelId: bigint;
  /** Private: never appears on the ledger, only its Poseidon commitment does. */
  rate: bigint;
  rateBlind: bigint;
  totalUnits: bigint;
  channelSecret: bigint;
  signature: VoucherSignature;
  escrowAmount: bigint;
  depositor: Uint8Array;
  provider: Uint8Array;
  token: Uint8Array;
}

export interface RefundArgs {
  depositor: Uint8Array;
  token: Uint8Array;
}

/**
 * Runs `avtar-escrow`'s compiled circuits against LOCAL, in-memory ledger
 * state — no network, no wallet, no transaction submission. This is the same
 * local-execution path `compact-runtime` gives any caller (the one
 * `midnight/selfcheck.mjs` uses for the pure signature gadget), extended
 * here to the full stateful lifecycle: `whitelistToken` → `openChannel` →
 * `settle` → `refund`, with real ledger state threaded through each call.
 *
 * Use this for local tests and demos. Live application calls use
 * connectAvtarEscrow, which proves and submits these same compiled circuits.
 */
export class LocalAvtarEscrowContract {
  readonly contractAddress: ContractAddress;
  readonly #contract = new Contract<undefined>({});
  readonly #coinPublicKey: string;
  #stateData: ChargedState;
  #privateState: undefined = undefined;

  /** @param coinPublicKeyHex 64 hex chars. Only affects Zswap bookkeeping, irrelevant to this contract's logic. */
  constructor(coinPublicKeyHex = "00".repeat(32), contractAddress = sampleContractAddress()) {
    this.#coinPublicKey = coinPublicKeyHex;
    this.contractAddress = contractAddress;
    const init = this.#contract.initialState(
      createConstructorContext(this.#privateState, this.#coinPublicKey),
    );
    this.#stateData = init.currentContractState.data;
  }

  /** Read-only view of the current ledger state (`whitelistedTokens`, `channels`, `balances`, `nullifiers`). */
  get ledger(): Ledger {
    return ledger(this.#stateData);
  }

  #context() {
    return createCircuitContext(
      this.contractAddress,
      this.#coinPublicKey,
      this.#stateData,
      this.#privateState,
    );
  }

  whitelistToken(token: Uint8Array): void {
    const { context } = this.#contract.circuits.whitelistToken(this.#context(), token);
    this.#stateData = context.currentQueryContext.state;
    this.#privateState = context.currentPrivateState;
  }

  openChannel(args: OpenChannelArgs): void {
    const { context } = this.#contract.circuits.openChannel(
      this.#context(),
      args.channelId,
      args.rateCommitment,
      args.consumerPublicKey.x,
      args.consumerPublicKey.y,
      args.depositor,
      args.provider,
      args.token,
      args.amount,
    );
    this.#stateData = context.currentQueryContext.state;
    this.#privateState = context.currentPrivateState;
  }

  settle(args: SettleArgs): void {
    const { context } = this.#contract.circuits.settle(
      this.#context(),
      args.channelId,
      args.rate,
      args.rateBlind,
      args.totalUnits,
      args.channelSecret,
      args.signature.sigRx,
      args.signature.sigRy,
      args.signature.sigRemainder,
      args.signature.sigQuotient,
      args.signature.sigS,
      args.escrowAmount,
      args.depositor,
      args.provider,
      args.token,
    );
    this.#stateData = context.currentQueryContext.state;
    this.#privateState = context.currentPrivateState;
  }

  refund(args: RefundArgs): void {
    const { context } = this.#contract.circuits.refund(this.#context(), args.depositor, args.token);
    this.#stateData = context.currentQueryContext.state;
    this.#privateState = context.currentPrivateState;
  }
}
