import { randomBytes } from "node:crypto";
import { computeRateCommitment, deriveConsumerPublicKey, createVoucher } from "@avtar/proving-setup";
import {
  X402ServiceChannel,
  realChainFromEnv,
  midnightSettlementNetwork,
  toBigIntKey,
  addressToPayload,
  settlementFromSnapshot,
} from "@avtar/agent-core";
import { MeterDb } from "@avtar/agent-core/db";
import type { ChainClient, ChannelTerms, ToolCall, ToolResult, X402Requirements } from "@avtar/agent-core";
import { TOOL_SPECS } from "@avtar/agent-provider";
import { ServiceAgent } from "./agent.js";
import type { AgentRunResult, ProviderSettlement, TurnPayment } from "./agent.js";
import { StubAgentBrain } from "./stub-agent.js";
import { OpenAiAgentBrain } from "./openai-agent.js";
import type { ConsumerServerConfig } from "./config.js";
import { TOOL_PROVIDERS } from "./providers.js";

function bytesToBigInt(bytes: Uint8Array | string): bigint {
  if (typeof bytes === "string") {
    return BigInt(bytes.startsWith("0x") ? bytes : `0x${bytes}`);
  }
  return BigInt("0x" + Buffer.from(bytes).toString("hex"));
}

function toUint8Array(value: Uint8Array | string): Uint8Array {
  if (typeof value === "string") {
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }
  return value;
}

function randField(): bigint {
  return BigInt("0x" + randomBytes(31).toString("hex"));
}

type ToolStats = { sessionCalls: number; sessionBillable: bigint };

export interface ChatResult extends AgentRunResult {
  payment: TurnPayment;
}

/** One stage of the on-demand settlement performed when the UI hits "Settle". */
export interface SettleStep {
  kind: "proof" | "verify" | "transfer" | "done" | "skipped";
  label: string;
  detail?: string;
}

/** Result of closing + settling the live channel from the UI. */
export interface SettleOutcome {
  /** True when a real (or mock) on-chain settlement was submitted. */
  settled: boolean;
  /** Present when nothing was settled or settlement failed. */
  reason?: string;
  steps: SettleStep[];
  /** On-chain settle transaction hash (or mock id). */
  settleTx?: string;
  /** Total metered units in the final voucher. */
  totalUnits?: string;
  /** settlement_amount = totalUnits · rate, in token base units. */
  settlementAmount?: string;
  /** Escrow ceiling that backed the channel, in token base units. */
  escrow?: string;
  tokenSymbol: string;
}

/**
 * One metered x402 session. On open it DISCOVERS the provider's terms from the
 * 402 (atomic rate, provider payload, token payload), accepts the provider's
 * rate, opens a local Midnight-simulation escrow, persists the channel to a
 * MeterDb, serves many chat turns, and settles once through the compiled
 * `avtar-escrow` circuit.
 */
export class AgentSession {
  #channel: X402ServiceChannel<ToolCall, ToolResult> | undefined;
  #chain: ChainClient | undefined;
  #terms: ChannelTerms | undefined;
  #meterDb: MeterDb | undefined;
  #advertised: X402Requirements | undefined;
  #ready = false;
  #busy = false;
  #sessionBillable = 0n;
  #sessionCalls = 0;
  #byTool = new Map<string, ToolStats>();
  #tokenSymbol: string;

  constructor(private readonly config: ConsumerServerConfig) {
    this.#tokenSymbol = process.env.MIDNIGHT_TOKEN_SYMBOL ?? "LOCAL";
  }

  get ready(): boolean {
    return this.#ready;
  }

  /** The provider terms discovered from the 402 (advertised rate/address/asset). */
  getProviderTerms(): { rate?: string; address?: string; asset?: string } {
    return {
      rate: this.#advertised?.rate,
      address: this.#advertised?.payTo,
      asset: this.#advertised?.asset,
    };
  }

  #buildProviderSettlements(turnCounts: Map<string, number>): ProviderSettlement[] {
    const rate = this.#terms?.rate ?? 0n;
    const providers: ProviderSettlement[] = [];

    for (const [tool, meta] of Object.entries(TOOL_PROVIDERS)) {
      const turnCalls = turnCounts.get(tool) ?? 0;
      const stats = this.#byTool.get(tool) ?? { sessionCalls: 0, sessionBillable: 0n };
      providers.push({
        providerId: meta.id,
        providerLabel: meta.label,
        tool,
        turnCalls,
        turnBillable: (BigInt(turnCalls) * rate).toString(),
        sessionCalls: stats.sessionCalls,
        sessionBillable: stats.sessionBillable.toString(),
      });
    }

    return providers.sort((a, b) => a.providerLabel.localeCompare(b.providerLabel));
  }

  #allSessionProviders(): ProviderSettlement[] {
    const providers: ProviderSettlement[] = [];
    for (const [tool, meta] of Object.entries(TOOL_PROVIDERS)) {
      const stats = this.#byTool.get(tool) ?? { sessionCalls: 0, sessionBillable: 0n };
      providers.push({
        providerId: meta.id,
        providerLabel: meta.label,
        tool,
        turnCalls: 0,
        turnBillable: "0",
        sessionCalls: stats.sessionCalls,
        sessionBillable: stats.sessionBillable.toString(),
      });
    }
    return providers.sort((a, b) => a.providerLabel.localeCompare(b.providerLabel));
  }

  getPaymentSummary(): TurnPayment {
    return {
      turnCalls: 0,
      turnBillable: "0",
      sessionCalls: this.#sessionCalls,
      sessionBillable: this.#sessionBillable.toString(),
      tokenSymbol: this.#tokenSymbol,
      providers: this.#allSessionProviders(),
    };
  }

  async initialize(): Promise<void> {
    const escrow = BigInt(this.config.escrowAtomic);

    // 1) Discover the provider's terms from its x402 402 response.
    const advertised = await X402ServiceChannel.discoverTerms(this.config.providerUrl);
    if (advertised === undefined) {
      throw new Error(`provider at ${this.config.providerUrl} did not advertise x402 terms`);
    }
    if (advertised.network !== midnightSettlementNetwork()) {
      throw new Error(`provider advertised unsupported network: ${advertised.network}`);
    }
    const rate = BigInt(advertised.rate ?? this.config.rateAtomic);

    const real = realChainFromEnv();
    if (real === null) {
      throw new Error("Configure a live Midnight wallet or set MIDNIGHT_LOCAL_SIM=true");
    }
    const depositorPayload = real.depositorPayload;
    const providerPayload = advertised.payTo === undefined ? real.providerPayload : addressToPayload(advertised.payTo);
    const tokenPayload = advertised.asset === undefined ? real.tokenPayload : addressToPayload(advertised.asset);
    if (!Buffer.from(providerPayload).equals(Buffer.from(real.providerPayload))) {
      throw new Error("provider payload does not match MIDNIGHT_PROVIDER_ADDRESS");
    }
    if (!Buffer.from(tokenPayload).equals(Buffer.from(real.tokenPayload))) {
      throw new Error("token payload does not match MIDNIGHT_TOKEN_ADDRESS");
    }
    const chain: ChainClient = real.chain;

    const terms: ChannelTerms = {
      channelId: randField(),
      rate,
      rateBlind: randField(),
      escrow,
      channelSecret: randField(),
      consumerPrivateKey: randomBytes(31),
      depositorPayload,
      providerPayload,
      tokenPayload,
    };

    const rateCommitmentBytes = await computeRateCommitment(rate, terms.rateBlind);
    const rateCommitment = bytesToBigInt(rateCommitmentBytes);
    const privateKeyBigInt = bytesToBigInt(terms.consumerPrivateKey);
    const consumerPublicKey = await deriveConsumerPublicKey(privateKeyBigInt);
    const meterDb = new MeterDb(process.env.METER_DB_PATH ?? "artifacts/metering.db");

    // Persist recovery material before any funds are sent to the contract.
    meterDb.saveChannel({ terms, consumerPublicKey, rateCommitment, lastAcceptedUnits: 0n, serviceName: "toolbox" });
    // 3) Consumer funds the escrow on-chain (depositor pays).
    try {
      const opened = await chain.openChannel({
        channelId: terms.channelId,
        rateCommitment: rateCommitmentBytes,
        consumerPublicKey,
        depositor: depositorPayload,
        provider: providerPayload,
        token: tokenPayload,
        escrow,
      });

      meterDb.updateOpenTx(terms.channelId, opened.openTx);

      // 4) x402-open the metered channel and persist the channel + advertised
      //    recipient to the MeterDb so settlement can be driven from durable state.
      const channel = await X402ServiceChannel.open<ToolCall, ToolResult>({
        providerUrl: this.config.providerUrl,
        terms,
        paymentSignature: this.config.paymentAuthorization,
        meterDb,
        rateCommitment,
        openTx: opened.openTx,
        serviceName: "toolbox",
      });

      this.#chain = chain;
      this.#terms = terms;
      this.#channel = channel;
      this.#meterDb = meterDb;
      this.#advertised = advertised;
      this.#sessionBillable = 0n;
      this.#sessionCalls = 0;
      this.#byTool.clear();
      this.#ready = true;
    } catch (error) {
      meterDb.close();
      await chain.close?.();
      throw error;
    }
  }

  async chat(message: string): Promise<ChatResult> {
    if (!this.#ready || this.#channel === undefined) {
      throw new Error("session not ready");
    }
    if (this.#busy) {
      throw new Error("session busy");
    }

    this.#busy = true;
    try {
      const useOpenAi = Boolean(process.env.OPENAI_API_KEY);
      const brain = useOpenAi ? new OpenAiAgentBrain() : new StubAgentBrain();
      const result = await new ServiceAgent(this.#channel, brain, TOOL_SPECS).run(message.trim());

      const served = result.calls.filter((c) => c.served);
      const rate = this.#terms?.rate ?? 0n;
      const turnCounts = new Map<string, number>();

      for (const call of served) {
        turnCounts.set(call.tool, (turnCounts.get(call.tool) ?? 0) + 1);
        const prev = this.#byTool.get(call.tool) ?? { sessionCalls: 0, sessionBillable: 0n };
        prev.sessionCalls += 1;
        prev.sessionBillable += rate;
        this.#byTool.set(call.tool, prev);
      }

      const turnCalls = served.length;
      const lastBillable = served.at(-1)?.billable;
      const turnBillable =
        lastBillable !== undefined
          ? BigInt(lastBillable) - this.#sessionBillable
          : BigInt(turnCalls) * rate;

      if (lastBillable !== undefined) {
        this.#sessionBillable = BigInt(lastBillable);
      } else {
        this.#sessionBillable += turnBillable;
      }
      this.#sessionCalls += turnCalls;

      const payment: TurnPayment = {
        turnCalls,
        turnBillable: turnBillable.toString(),
        sessionCalls: this.#sessionCalls,
        sessionBillable: this.#sessionBillable.toString(),
        tokenSymbol: this.#tokenSymbol,
        providers: this.#buildProviderSettlements(turnCounts),
      };

      return { ...result, payment };
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Close the channel and settle it once from durable MeterDb state. The final
   * voucher supplies the witnesses for the compiled `avtar-escrow.settle`
   * circuit, which verifies the signature, enforces `settlement ≤ escrow`,
   * records the nullifier, and applies the local ledger transfer.
   *
   * On success (or when there is nothing to settle) the session is torn down and
   * becomes not-ready — the caller must open a {@link newSession} before chatting
   * again, since a channel's nullifier can only be spent once. On a real failure
   * the channel is left intact so the caller can retry or keep chatting.
   */
  async settle(): Promise<SettleOutcome> {
    if (this.#busy) throw new Error("session busy");
    const tokenSymbol = this.#tokenSymbol;
    if (this.#terms === undefined || this.#chain === undefined || this.#meterDb === undefined) {
      return {
        settled: false,
        reason: "no active channel to settle",
        steps: [{ kind: "skipped", label: "No active channel", detail: "Open a session first." }],
        tokenSymbol,
      };
    }

    const snapshot = this.#meterDb.loadChannel(this.#terms.channelId);
    if (!snapshot) throw new Error("Persisted channel is missing; refusing to discard the active escrow");
    if (!snapshot.latestVoucher) {
      // Zero usage still has a funded escrow: prove a zero-unit voucher to refund it.
      snapshot.latestVoucher = createVoucher(toBigIntKey(snapshot.terms.consumerPrivateKey), snapshot.terms.channelId, 0n);
    }

    const totalUnits = snapshot.latestVoucher.totalUnits;
    const settlementAmount = totalUnits * snapshot.terms.rate;
    const steps: SettleStep[] = [];
    this.#busy = true;

    try {
      const settlement = await settlementFromSnapshot(snapshot);
      steps.push({
        kind: "proof",
        label: "Compact settlement witnesses assembled",
        detail: `${totalUnits} metered unit(s) from the final signed voucher`,
      });

      const settled = await this.#chain.settle({
        channelId: settlement.channelId,
        rate: settlement.rate,
        rateBlind: settlement.rateBlind,
        totalUnits: settlement.totalUnits,
        channelSecret: settlement.channelSecret,
        signature: settlement.signature,
        escrowAmount: settlement.escrowAmount,
        depositor: toUint8Array(snapshot.terms.depositorPayload),
        provider: toUint8Array(snapshot.terms.providerPayload),
        token: toUint8Array(snapshot.terms.tokenPayload),
      });
      steps.push({
        kind: "verify",
        label: "Compiled circuit accepted settlement",
        detail: "signature verified · settlement ≤ escrow · nullifier unspent",
      });
      steps.push({
        kind: "transfer",
        label: "Split transfer executed",
        detail: "settlement → provider, remaining escrow refunded to depositor",
      });
      steps.push({ kind: "done", label: "Settlement complete", detail: settled.settleTx });

      await this.#teardown();
      return {
        settled: true,
        steps,
        settleTx: settled.settleTx,
        totalUnits: totalUnits.toString(),
        settlementAmount: settlementAmount.toString(),
        escrow: snapshot.terms.escrow.toString(),
        tokenSymbol,
      };
    } catch (error) {
      // Settlement failed mid-flight — leave the channel intact so the caller can
      // retry or keep chatting; do NOT tear down or mark the nullifier spent.
      const reason = error instanceof Error ? error.message : String(error);
      steps.push({ kind: "skipped", label: "Settlement failed", detail: reason });
      return { settled: false, reason, steps, tokenSymbol };
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Open a fresh channel between consumer and provider, discarding any prior
   * (already-settled or torn-down) channel. Re-runs the full open handshake:
   * discover the provider's 402 terms, fund a new escrow, and persist a new
   * channel to the MeterDb.
   */
  async newSession(): Promise<void> {
    if (this.#busy) throw new Error("session busy");
    if (this.#ready) {
      const result = await this.settle();
      if (!result.settled) throw new Error(result.reason ?? "Previous channel could not settle");
    }
    await this.initialize();
  }

  /** Persist-nothing teardown of the in-memory channel + meter DB handle. */
  async #teardown(): Promise<void> {
    await this.#chain?.close?.();
    this.#meterDb?.close();
    this.#ready = false;
    this.#channel = undefined;
    this.#terms = undefined;
    this.#chain = undefined;
    this.#meterDb = undefined;
  }

  /** Settle and tear down on process exit (SIGINT/SIGTERM). */
  async shutdown(): Promise<void> {
    await this.settle();
  }
}
