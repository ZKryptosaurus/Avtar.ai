import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { computeRateCommitment } from "@avtar/proving-setup";
import {
  ServiceChannel,
  realChainFromEnv,
} from "@avtar/agent-core";
import { MeterDb } from "@avtar/agent-core/db";
import type { ChainClient, ChannelTerms } from "@avtar/agent-core";
import { FetchHttpClient, buildToolbox, TOOL_SPECS } from "@avtar/agent-provider";
import { ServiceAgent } from "./agent.js";
import { StubAgentBrain } from "./stub-agent.js";
import { OpenAiAgentBrain } from "./openai-agent.js";

// Load .env from consumer directory first, then monorepo root as fallback
const consumerEnvPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
const rootEnvPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");

let envLoad = loadEnv({ path: consumerEnvPath });
if (envLoad.error) {
  envLoad = loadEnv({ path: rootEnvPath });
  if (envLoad.error) {
    console.log(`env: no .env found at ${consumerEnvPath} or ${rootEnvPath}`);
  } else {
    console.log(`env: loaded ${Object.keys(envLoad.parsed ?? {}).length} var(s) from ${rootEnvPath}`);
  }
} else {
  console.log(`env: loaded ${Object.keys(envLoad.parsed ?? {}).length} var(s) from ${consumerEnvPath}`);
}

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/onchain-setup/.env") });

/** A random BN254 field element (31 random bytes stays below the prime). */
function randField(): bigint {
  return BigInt("0x" + randomBytes(31).toString("hex"));
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt("0x" + Buffer.from(bytes).toString("hex"));
}

async function main(): Promise<void> {
  const goal =
    process.argv.slice(2).join(" ") ||
    "What's the weather in Tokyo, the price of ETH in USD, and translate 'good morning' into Japanese?";

  const symbol = process.env.MIDNIGHT_TOKEN_SYMBOL ?? "LOCAL";
  const rate = BigInt(process.env.MIDNIGHT_RATE_ATOMIC ?? "100");
  const escrow = BigInt(process.env.MIDNIGHT_ESCROW_ATOMIC ?? "10000");

  const real = realChainFromEnv();
  if (real === null) {
    throw new Error(
      "No chain client configured. Set MIDNIGHT_LOCAL_SIM=true for local simulation, " +
      "or MIDNIGHT_WALLET_SEED + MIDNIGHT_AVTAR_ESCROW_ADDRESS for live Preprod."
    );
  }
  const chain: ChainClient = real.chain;
  const mode = real.label.includes("preprod") ? "midnight-preprod" : "midnight-local-sim";
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
  const rateCommitment = bytesToBigInt(rateCommitmentBytes);
  const meterDb = new MeterDb(process.env.METER_DB_PATH ?? "artifacts/metering.db");

  // One channel over a TOOLBOX of services — the agent picks which tool to use,
  // every call meters here, and the whole session settles with one proof.
  const http = new FetchHttpClient();
  const toolbox = buildToolbox(http);
  const channel = await ServiceChannel.open(terms, toolbox, {
    meterDb,
    rateCommitment,
    serviceName: "toolbox",
  });

  // ── OPEN ──────────────────────────────────────────────────────────────
  console.log("═══ OPEN CHANNEL ═══");
  console.log(`  settlement chain:  ${mode}`);
  if (real) {
    console.log(`  addresses:         ${real.label}`);
  }
  console.log(`  services offered:  ${toolbox.toolNames().join(", ")}`);
  console.log(`  rate (PRIVATE):    ${rate} ${symbol} atomic units / call`);
  console.log(`  escrow (public):   ${escrow} ${symbol} atomic units`);
  console.log(`  rate commitment:   ${rateCommitment.toString().slice(0, 16)}…  (Poseidon(rate, blind))`);

  const opened = await chain.openChannel({
    channelId: terms.channelId,
    rateCommitment: rateCommitmentBytes,
    consumerPublicKey: channel.consumerPublicKey,
    depositor: depositorPayload,
    provider: providerPayload,
    token: tokenPayload,
    escrow,
  });
  meterDb.updateOpenTx(terms.channelId, opened.openTx);
  console.log(`  open tx:           ${opened.openTx}`);

  // ── METER (off-chain) — the agent chooses which services to use ───────
  const useOpenAi = Boolean(process.env.OPENAI_API_KEY);
  const brain = useOpenAi ? new OpenAiAgentBrain() : new StubAgentBrain();
  console.log(`\n═══ METER (off-chain) — ${useOpenAi ? "OpenAI" : "stub"} tool-using agent ═══`);
  console.log(`  goal: ${goal}`);

  const { answer, calls } = await new ServiceAgent(channel, brain, TOOL_SPECS).run(goal);
  for (const c of calls) {
    const detail = c.served ? JSON.stringify(c.result) : (c.reason ?? "refused");
    console.log(
      `  ${c.served ? "paid+served" : "skipped   "}  ${c.tool.padEnd(16)} ${JSON.stringify(c.args)} → ${detail}`,
    );
  }
  console.log(`  answer: ${answer}`);

  // ── SETTLE (one ZK proof, for the whole mixed session) ────────────────
  console.log(`\n═══ SETTLE — one on-chain settlement (${mode}) ═══`);
  const served = calls.filter((c) => c.served).length;
  const settlement = await channel.close(); // generates the settlement witnesses
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
  console.log(`  paid calls (PRIVATE):    ${served}  across ${new Set(calls.filter((c) => c.served).map((c) => c.tool)).size} service(s)`);
  console.log(`  settled to provider:     ${settlementAmount} ${symbol} atomic units`);
  console.log(`  refunded to consumer:    ${escrow - settlementAmount} ${symbol} atomic units`);
  console.log(`  settle tx:               ${settled.settleTx}`);
  await chain.close?.();
  meterDb.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
