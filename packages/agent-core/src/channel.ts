import { Buffer } from "node:buffer";
import {
  createVoucher,
  deriveConsumerPublicKey,
  verifyVoucherSignature,
  computeVoucherMessage,
  EMBEDDED_ORDER,
} from "@avtar/proving-setup";
import type { ConsumerPublicKey, Voucher } from "@avtar/proving-setup";
import type { MeterDb } from "./db.js";
import type { Service } from "./service.js";

/** A 32-byte value, accepted as raw bytes or a 64-char hex string. */
export type AddressPayload = Uint8Array | string;

/** Why a provider refused (or could not accept) a metering voucher. */
export type RejectReason =
  | "wrong-channel"
  | "bad-signature"
  | "non-monotonic"
  | "ceiling-exceeded"
  | "underpaid";

/** The fixed parameters of one metered channel. */
export interface ChannelTerms {
  channelId: bigint;
  /** Per-unit rate in the settlement token's atomic units. PRIVATE — only ever committed on-chain. */
  rate: bigint;
  /** Blinding factor for the rate commitment. PRIVATE. */
  rateBlind: bigint;
  /** Escrow ceiling in the settlement token's atomic units. Public on-chain. */
  escrow: bigint;
  /** Per-channel secret for the nullifier. PRIVATE. */
  channelSecret: bigint;
  /** 32-byte Jubjub voucher key (Uint8Array or 64-char hex). */
  consumerPrivateKey: AddressPayload;
  /** 32-byte Midnight address payloads bound into the settlement. */
  depositorPayload: AddressPayload;
  providerPayload: AddressPayload;
  tokenPayload: AddressPayload;
}

/** The outcome of one metered call (request -> pay -> serve). */
export interface CallOutcome<Req, Res> {
  served: boolean;
  request: Req;
  voucher: Voucher;
  result?: Res;
  reason?: RejectReason | string;
  /** The provider's independently-computed price for this call, in units. */
  cost: bigint;
  cumulativeUnits?: bigint;
  /** cumulativeUnits * rate so far, in the settlement token's atomic units. */
  billable?: bigint;
}

/** Everything needed to submit `avtar-escrow.settle` — no proof to build: on
 * Midnight the circuit call itself is the proof, so these are the raw private
 * witnesses (rate, rateBlind, totalUnits, channelSecret, Schnorr signature). */
export interface SettlementResult {
  channelId: bigint;
  rate: bigint;
  rateBlind: bigint;
  totalUnits: bigint;
  channelSecret: bigint;
  signature: Voucher["signature"];
  escrowAmount: bigint;
}

export interface ServiceChannelOptions {
  meterDb?: MeterDb;
  rateCommitment?: bigint;
  openTx?: string;
  serviceName?: string;
}

/** Shared surface for in-process and x402-backed metered clients. */
export interface MeteredServiceChannel<Req, Res> {
  call(req: Req): Promise<CallOutcome<Req, Res>>;
  close(): Promise<SettlementResult>;
}

/**
 * Consumer side of the meter: signs cumulative Schnorr-over-Jubjub vouchers
 * via `@avtar/proving-setup`. Each voucher supersedes the last, so
 * settlement needs only the final one.
 */
export class ConsumerMeter {
  #cumulative = 0n;

  constructor(
    private readonly privateKey: bigint,
    private readonly channelId: bigint,
  ) {}

  /**
   * Sign a cumulative voucher for the NEXT `units` on top of the last committed
   * total, WITHOUT advancing the meter. Call {@link commit} with the voucher
   * once the provider accepts it. If the provider refuses (or the tool errors),
   * simply drop the voucher: the meter is unchanged, so a retry re-signs at the
   * same total and non-served attempts never inflate the settled amount.
   */
  signFor(units: bigint): Voucher {
    if (units <= 0n) throw new Error("units must be positive");
    return createVoucher(this.privateKey, this.channelId, this.#cumulative + units);
  }

  /** Commit an accepted voucher, advancing the running cumulative total. */
  commit(voucher: Voucher): void {
    if (voucher.totalUnits <= this.#cumulative) {
      throw new Error("voucher does not advance the cumulative total");
    }
    this.#cumulative = voucher.totalUnits;
  }

  get cumulativeUnits(): bigint {
    return this.#cumulative;
  }
}

interface ReceiveResult {
  accepted: boolean;
  reason?: RejectReason;
  cumulativeUnits?: bigint;
  billable?: bigint;
}

/**
 * Provider side of the meter: verifies each voucher's Schnorr signature,
 * enforces monotonicity, and halts the moment billable units would exceed
 * the public escrow. Mirrors the on-chain `settlement <= escrow` invariant.
 */
export class ProviderMeter {
  #latest: Voucher | undefined;
  #halted = false;

  constructor(
    private readonly channelId: bigint,
    private readonly consumerPubKey: ConsumerPublicKey,
    private readonly rate: bigint,
    private readonly escrow: bigint,
  ) {}

  /**
   * Validate a voucher (channel, monotonicity, signature, escrow ceiling)
   * WITHOUT committing it. Call {@link commit} once the call is actually served
   * so the meter advances only for served calls — a voucher whose tool later
   * fails must not inflate the settled total. Hitting the ceiling still halts
   * the channel, since that is terminal regardless of the tool outcome.
   */
  verify(voucher: Voucher): ReceiveResult {
    if (this.#halted) return { accepted: false, reason: "ceiling-exceeded" };
    if (voucher.channelId !== this.channelId) return { accepted: false, reason: "wrong-channel" };

    const prev = this.#latest?.totalUnits ?? 0n;
    if (voucher.totalUnits <= prev) return { accepted: false, reason: "non-monotonic" };

    const message = computeVoucherMessage(this.channelId, voucher.totalUnits);
    const ok = verifyVoucherSignature(this.consumerPubKey, message, voucher.signature);
    if (!ok) return { accepted: false, reason: "bad-signature" };

    const billable = voucher.totalUnits * this.rate;
    if (billable > this.escrow) {
      this.#halted = true;
      return { accepted: false, reason: "ceiling-exceeded", cumulativeUnits: voucher.totalUnits, billable };
    }

    return { accepted: true, cumulativeUnits: voucher.totalUnits, billable };
  }

  /** Commit a verified voucher after the call is served, advancing the meter. */
  commit(voucher: Voucher): void {
    const prev = this.#latest?.totalUnits ?? 0n;
    if (voucher.totalUnits <= prev) {
      throw new Error("voucher does not advance the cumulative total");
    }
    this.#latest = voucher;
  }

  get latestVoucher(): Voucher | undefined {
    return this.#latest;
  }
}

/**
 * Wires a {@link ConsumerMeter} and {@link ProviderMeter} over one channel and a
 * priced {@link Service}, exposing the full request -> pay -> serve round-trip
 * plus the settlement close. The close just hands back the raw private
 * witnesses `avtar-escrow.settle` needs — the circuit call itself is the proof.
 */
export class ServiceChannel<Req, Res> implements MeteredServiceChannel<Req, Res> {
  readonly terms: ChannelTerms;
  readonly consumerPublicKey: ConsumerPublicKey;
  readonly #consumer: ConsumerMeter;
  readonly #provider: ProviderMeter;
  readonly #service: Service<Req, Res>;
  readonly #meterDb: MeterDb | undefined;

  private constructor(
    terms: ChannelTerms,
    service: Service<Req, Res>,
    consumer: ConsumerMeter,
    provider: ProviderMeter,
    consumerPublicKey: ConsumerPublicKey,
    meterDb: MeterDb | undefined,
  ) {
    this.terms = terms;
    this.#service = service;
    this.#consumer = consumer;
    this.#provider = provider;
    this.consumerPublicKey = consumerPublicKey;
    this.#meterDb = meterDb;
  }

  /** Derive the consumer key and stand up both meters for the channel. */
  static open<Req, Res>(
    terms: ChannelTerms,
    service: Service<Req, Res>,
    options: ServiceChannelOptions = {},
  ): ServiceChannel<Req, Res> {
    const consumerPrivateKey = toBigIntKey(terms.consumerPrivateKey);
    const consumerPublicKey = deriveConsumerPublicKey(consumerPrivateKey);
    const consumer = new ConsumerMeter(consumerPrivateKey, terms.channelId);
    const provider = new ProviderMeter(terms.channelId, consumerPublicKey, terms.rate, terms.escrow);
    options.meterDb?.saveChannel({
      terms,
      consumerPublicKey,
      rateCommitment: options.rateCommitment,
      lastAcceptedUnits: 0n,
      halted: false,
      openTx: options.openTx,
      serviceName: options.serviceName ?? service.name,
    });
    return new ServiceChannel(terms, service, consumer, provider, consumerPublicKey, options.meterDb);
  }

  /** One full round-trip: consumer pays, provider verifies + serves (or refuses). */
  async call(req: Req): Promise<CallOutcome<Req, Res>> {
    const cost = this.#service.price(req);
    if (cost <= 0n) throw new Error("service price must be positive");

    const voucher = this.#consumer.signFor(cost);
    const res = this.#provider.verify(voucher);

    if (!res.accepted) {
      if (res.reason === "ceiling-exceeded") {
        const latest = this.#provider.latestVoucher;
        this.#meterDb?.updateMeter(
          this.terms.channelId,
          latest?.totalUnits ?? 0n,
          latest,
          true,
          "ceiling_reached",
        );
      }
      return {
        served: false,
        request: req,
        voucher,
        reason: res.reason,
        cost,
        cumulativeUnits: res.cumulativeUnits,
        billable: res.billable,
      };
    }

    // Serve the tool BEFORE committing, so a failing tool bills nothing.
    const result = await this.#service.handle(req);

    // Served — commit both meters so they advance only for served calls and stay
    // in lock-step (provider's last-accepted == consumer's cumulative).
    this.#consumer.commit(voucher);
    this.#provider.commit(voucher);

    this.#meterDb?.updateMeter(
      this.terms.channelId,
      res.cumulativeUnits ?? voucher.totalUnits,
      voucher,
      false,
      "voucher_accepted",
    );

    return {
      served: true,
      request: req,
      voucher,
      result,
      cost,
      cumulativeUnits: res.cumulativeUnits,
      billable: res.billable,
    };
  }

  /** Close the channel: return the raw fields `avtar-escrow.settle` needs. */
  async close(): Promise<SettlementResult> {
    const final = this.#provider.latestVoucher;
    if (!final) throw new Error("no accepted vouchers — nothing to settle");

    return {
      channelId: this.terms.channelId,
      rate: this.terms.rate,
      rateBlind: this.terms.rateBlind,
      totalUnits: final.totalUnits,
      channelSecret: this.terms.channelSecret,
      signature: final.signature,
      escrowAmount: this.terms.escrow,
    };
  }
}

/** `ChannelTerms.consumerPrivateKey` is `AddressPayload` (bytes or hex) elsewhere — typically
 * 32 random bytes, i.e. up to ~256 bits — but Jubjub voucher signing needs a scalar
 * `< EMBEDDED_ORDER` (~252 bits), so reduce mod the curve order at the boundary. Callers
 * that already pass a properly-bounded scalar are unaffected (mod is a no-op below the order). */
export function toBigIntKey(key: AddressPayload): bigint {
  const raw = key instanceof Uint8Array ? BigInt("0x" + Buffer.from(key).toString("hex")) : BigInt(key.startsWith("0x") || key.startsWith("0X") ? key : `0x${key}`);
  return raw % EMBEDDED_ORDER;
}
