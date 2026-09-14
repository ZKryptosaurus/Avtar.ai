import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { computeRateCommitment, deriveConsumerPublicKey } from "@avtar/proving-setup";
import {
  X402ServiceChannel,
  realChainFromEnv,
} from "@avtar/agent-core";
import type { ChainClient, ChannelTerms, ToolCall, ToolResult } from "@avtar/agent-core";
import { TOOL_SPECS } from "@avtar/agent-provider";
import { ServiceAgent } from "./agent.js";
import { StubAgentBrain } from "./stub-agent.js";
import { OpenAiAgentBrain } from "./openai-agent.js";

// This is the SAME demo as demo.ts, but the provider is REMOTE: the consumer
// reaches it over HTTP using x402 (402 → X-PAYMENT → open) instead of calling an
// in-process toolbox. Start the provider first:
//   pnpm --filter @avtar/agent-provider serve
// then run:  pnpm --filter @avtar/agent-consumer demo:x402

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
const envLoad = loadEnv({ path: envPath });
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/onchain-setup/.env") });
if (envLoad.error) {
  console.log(`env: no .env found at ${envPath} (${envLoad.error.message})`);
} else {
  console.log(`env: loaded ${Object.keys(envLoad.parsed ?? {}).length} var(s) from ${envPath}`);
}

/** A random BN254 field element (31 random bytes stays below the prime). */
function randField(): bigint {
  return BigInt("0x" + randomBytes(31).toString("hex"));
}

async function main(): Promise<void> {
  const providerUrl = process.env.AVTAR_PROVIDER_URL ?? "http://localhost:4021";
  const goal =
    process.argv.slice(2).join(" ") ||
    "What's the weather in Tokyo, the price of ETH in USD, and translate 'good morning' into Japanese?";

  const symbol = process.env.MIDNIGHT_TOKEN_SYMBOL ?? "LOCAL";
  const rate = BigInt(process.env.MIDNIGHT_RATE_ATOMIC ?? "100");
  const escrow = BigInt(process.env.MIDNIGHT_ESCROW_ATOMIC ?? "10000");

  const real = realChainFromEnv();
  if (real === null) {
    throw new Error("MIDNIGHT_LOCAL_SIM=true is required for this demo");
  }
  const chain: ChainClient = real.chain;
  const mode = real.network;
  const depositorPayload = real.depositorPayload;
  const providerPayload = real.providerPayload;
  const tokenPayload = real.tokenPayload;

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
  const rateCommitment = BigInt("0x" + Buffer.from(rateCommitmentBytes).toString("hex"));
  const privateKeyBigInt = BigInt("0x" + Buffer.from(terms.consumerPrivateKey).toString("hex"));
  const consumerPublicKey = await deriveConsumerPublicKey(privateKeyBigInt);

  // ── OPEN (escrow on-chain) ────────────────────────────────────────────
  console.log("═══ OPEN CHANNEL ═══");
  console.log(`  provider (x402):   ${providerUrl}`);
  console.log(`  settlement chain:  ${mode}`);
  if (real) {
    console.log(`  addresses:         ${real.label}`);
  }
  console.log(`  rate (PRIVATE):    ${rate} ${symbol} atomic units / call`);
  console.log(`  escrow (public):   ${escrow} ${symbol} atomic units`);
  console.log(`  rate commitment:   ${rateCommitment.toString().slice(0, 16)}…  (Poseidon(rate, blind))`);

  const opened = await chain.openChannel({
    channelId: terms.channelId,
    rateCommitment: rateCommitmentBytes,
    consumerPublicKey,
    depositor: depositorPayload,
    provider: providerPayload,
    token: tokenPayload,
    escrow,
  });
  console.log(`  open tx:           ${opened.openTx}`);

  // ── x402 OPEN (HTTP: 402 → X-PAYMENT → open) ──────────────────────────
  const channel = await X402ServiceChannel.open<ToolCall, ToolResult>({
    providerUrl,
    terms,
    paymentSignature: process.env.AVTAR_X402_AUTHORIZATION ?? "local-demo-authorization",
  });
  console.log(`  x402 open:         authorized metered channel established with remote provider`);

  // ── METER (off-chain, over HTTP) — the agent chooses which tools to use ─
  const useOpenAi = Boolean(process.env.OPENAI_API_KEY);
  const brain = useOpenAi ? new OpenAiAgentBrain() : new StubAgentBrain();
  console.log(`\n═══ METER (over x402) — ${useOpenAi ? "OpenAI" : "stub"} tool-using agent ═══`);
  console.log(`  goal: ${goal}`);

  const { answer, calls } = await new ServiceAgent(channel, brain, TOOL_SPECS).run(goal);
  for (const c of calls) {
    const detail = c.served ? JSON.stringify(c.result) : (c.reason ?? "refused");
    console.log(
      `  ${c.served ? "paid+served" : "skipped   "}  ${c.tool.padEnd(16)} ${JSON.stringify(c.args)} → ${detail}`,
    );
  }
  console.log(`  answer: ${answer}`);

  // ── SETTLE (compiled local circuit from the final voucher) ────────────
  console.log(`\n═══ SETTLE — one on-chain settlement (${mode}) ═══`);
  const served = calls.filter((c) => c.served).length;
  const settlement = await channel.close();
  const settled = await chain.settle({
    channelId: settlement.channelId,
    rate: settlement.rate,
    rateBlind: settlement.rateBlind,
    totalUnits: settlement.totalUnits,
    channelSecret: settlement.channelSecret,
    signature: settlement.signature,
    escrowAmount: settlement.escrowAmount,
    depositor: depositorPayload,
    provider: providerPayload,
    token: tokenPayload,
  });

  const settlementAmount = settlement.totalUnits * settlement.rate;
  console.log(
    `  paid calls (PRIVATE):    ${served}  across ${new Set(calls.filter((c) => c.served).map((c) => c.tool)).size} service(s)`,
  );
  console.log(`  settled to provider:     ${settlementAmount} ${symbol} atomic units`);
  console.log(`  refunded to consumer:    ${escrow - settlementAmount} ${symbol} atomic units`);
  console.log(`  settle tx:               ${settled.settleTx}`);
  await chain.close?.();
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ECONNREFUSED|failed to fetch|x402 open failed/i.test(msg)) {
    console.error(`\n✗ Could not reach the provider at ${process.env.AVTAR_PROVIDER_URL ?? "http://localhost:4021"}.`);
    console.error(`  Start it first:  pnpm --filter @avtar/agent-provider serve`);
  }
  console.error(error);
  process.exitCode = 1;
});
