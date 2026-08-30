import { deriveConsumerPublicKey } from "@avtar/proving-setup";
import type { ConsumerPublicKey, Voucher } from "@avtar/proving-setup";
import { ConsumerMeter, toBigIntKey } from "./channel.js";
import type { CallOutcome, ChannelTerms, MeteredServiceChannel, SettlementResult } from "./channel.js";
import type { MeterDb } from "./db.js";
import { serializeVoucher } from "./voucher-wire.js";
import {
  fetchWithManualX402,
  discoverX402Requirements,
  type FetchLike,
  type X402Requirements,
} from "./x402-client.js";

export interface X402ChannelOptions {
  /** Base URL of the remote provider (e.g. http://localhost:4021). */
  providerUrl: string;
  terms: ChannelTerms;
  fetchImpl?: FetchLike;
  /** x402 payment authorization presented at open (mock by default). */
  paymentSignature?: string;
  /** Units signed per call (defaults to 1). */
  unitsPerCall?: bigint;
  /** Persist the channel + per-call meter to a MeterDb (durable settlement). */
  meterDb?: MeterDb;
  /** On-chain rate commitment to persist alongside the channel. */
  rateCommitment?: bigint;
  /** The escrow-open tx hash to persist alongside the channel. */
  openTx?: string;
  /** Human label for the metered service (persisted). */
  serviceName?: string;
}

interface CallResponseBody {
  served?: boolean;
  result?: unknown;
  reason?: string;
  cumulativeUnits?: string;
  billable?: string;
}

/**
 * Consumer-side x402 transport. It opens a channel with a REMOTE provider over
 * HTTP (x402: 402 → pay → open), signs a cumulative Schnorr voucher per call
 * and posts it to the provider, and hands back the raw settlement witnesses
 * at close (no proof to build — the `settle` circuit call itself is the proof).
 *
 * It implements {@link MeteredServiceChannel}, so the same ServiceAgent drives
 * it exactly like the in-process channel — the LLM still picks which tool to
 * use, but now the provider is a separate service reached over the network.
 *
 * When a {@link MeterDb} is supplied it persists the channel on open and updates
 * the meter on every accepted call, so a session can settle from durable state.
 */
export class X402ServiceChannel<Req, Res> implements MeteredServiceChannel<Req, Res> {
  readonly consumerPublicKey: ConsumerPublicKey;
  readonly #baseUrl: string;
  readonly #terms: ChannelTerms;
  readonly #consumer: ConsumerMeter;
  readonly #fetch: FetchLike;
  readonly #unitsPerCall: bigint;
  readonly #meterDb: MeterDb | undefined;
  #lastAccepted: Voucher | undefined;

  private constructor(
    baseUrl: string,
    terms: ChannelTerms,
    consumer: ConsumerMeter,
    consumerPublicKey: ConsumerPublicKey,
    fetchImpl: FetchLike,
    unitsPerCall: bigint,
    meterDb: MeterDb | undefined,
  ) {
    this.#baseUrl = baseUrl;
    this.#terms = terms;
    this.#consumer = consumer;
    this.consumerPublicKey = consumerPublicKey;
    this.#fetch = fetchImpl;
    this.#unitsPerCall = unitsPerCall;
    this.#meterDb = meterDb;
  }

  /**
   * Discover the provider's advertised x402 terms (rate, payTo address, asset)
   * from its `402` response, WITHOUT paying. The consumer calls this first so it
   * can accept the provider's rate and bind the provider's address into the
   * channel before opening.
   */
  static async discoverTerms(
    providerUrl: string,
    fetchImpl: FetchLike = fetch,
  ): Promise<X402Requirements | undefined> {
    const baseUrl = providerUrl.replace(/\/$/, "");
    return discoverX402Requirements(`${baseUrl}/agent/open`, fetchImpl);
  }

  /** x402-open a channel with the remote provider (retry with X-PAYMENT). */
  static async open<Req, Res>(options: X402ChannelOptions): Promise<X402ServiceChannel<Req, Res>> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const baseUrl = options.providerUrl.replace(/\/$/, "");
    const consumerPrivateKey = toBigIntKey(options.terms.consumerPrivateKey);
    const consumerPublicKey = deriveConsumerPublicKey(consumerPrivateKey);

    const res = await fetchWithManualX402({
      url: `${baseUrl}/agent/open`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: options.terms.channelId.toString(),
          consumerPublicKey: { x: consumerPublicKey.x.toString(), y: consumerPublicKey.y.toString() },
          // The rate is the provider's own (advertised in the 402); the consumer
          // proposes only the escrow ceiling.
          escrow: options.terms.escrow.toString(),
        }),
      },
      fetchImpl,
      paymentSignature: options.paymentSignature,
    });
    if (!res.ok) throw new Error(`x402 open failed: HTTP ${res.status}`);
    await res.json().catch(() => undefined);

    // Persist the opened channel (terms + advertised recipient) so settlement can
    // be driven from the meter DB later.
    options.meterDb?.saveChannel({
      terms: options.terms,
      consumerPublicKey,
      rateCommitment: options.rateCommitment,
      lastAcceptedUnits: 0n,
      halted: false,
      openTx: options.openTx,
      serviceName: options.serviceName,
    });

    const consumer = new ConsumerMeter(consumerPrivateKey, options.terms.channelId);
    return new X402ServiceChannel(
      baseUrl,
      options.terms,
      consumer,
      consumerPublicKey,
      fetchImpl,
      options.unitsPerCall ?? 1n,
      options.meterDb,
    );
  }

  async call(req: Req): Promise<CallOutcome<Req, Res>> {
    const voucher = this.#consumer.signFor(this.#unitsPerCall);
    const res = await this.#fetch(
      `${this.#baseUrl}/channels/${this.#terms.channelId.toString()}/call`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voucher: serializeVoucher(voucher), payload: req }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as CallResponseBody;
    const served = res.ok && body.served === true;
    if (served) {
      // Provider served the call — commit so the meter advances only for served
      // calls; refused attempts leave the cumulative total untouched.
      this.#consumer.commit(voucher);
      this.#lastAccepted = voucher;
      this.#meterDb?.updateMeter(this.#terms.channelId, voucher.totalUnits, voucher, false);
    }

    return {
      served,
      request: req,
      voucher,
      result: served ? (body.result as Res) : undefined,
      reason: body.reason,
      cost: this.#unitsPerCall,
      cumulativeUnits: body.cumulativeUnits !== undefined ? BigInt(body.cumulativeUnits) : undefined,
      billable: body.billable !== undefined ? BigInt(body.billable) : undefined,
    };
  }

  /** No proof to build — just hand back the raw fields `avtar-escrow.settle` needs. */
  async close(): Promise<SettlementResult> {
    const final = this.#lastAccepted;
    if (final === undefined) throw new Error("no accepted vouchers — nothing to settle");

    await this.#fetch(`${this.#baseUrl}/channels/${this.#terms.channelId.toString()}/finalize`, {
      method: "POST",
    }).catch(() => undefined);

    return {
      channelId: this.#terms.channelId,
      rate: this.#terms.rate,
      rateBlind: this.#terms.rateBlind,
      totalUnits: final.totalUnits,
      channelSecret: this.#terms.channelSecret,
      signature: final.signature,
      escrowAmount: this.#terms.escrow,
    };
  }
}
