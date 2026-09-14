// Runnable entrypoint for the consumer's HTTP chat server.
//   MIDNIGHT_LOCAL_SIM=true pnpm --filter @avtar/agent-provider serve
//   MIDNIGHT_LOCAL_SIM=true pnpm --filter @avtar/agent-consumer serve
//
// Env: MIDNIGHT_LOCAL_SIM, MIDNIGHT_DEPOSITOR_ADDRESS,
//      MIDNIGHT_PROVIDER_ADDRESS, MIDNIGHT_TOKEN_ADDRESS, MIDNIGHT_RATE_ATOMIC,
//      MIDNIGHT_ESCROW_ATOMIC, OPENAI_API_KEY (optional).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { readConsumerServerConfig } from "./config.js";
import { AgentSession } from "./session.js";
import { createConsumerServer } from "./server.js";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
loadEnv({ path: envPath });
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/onchain-setup/.env") });

const config = readConsumerServerConfig();
const session = new AgentSession(config);

async function main(): Promise<void> {
  console.log("initializing consumer agent session (x402)…");
  console.log(`  provider:  ${config.providerUrl}`);
  try {
    await session.initialize();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\n✗ Failed to open x402 session with provider at ${config.providerUrl}.`);
    console.error(`  Start the provider first:  pnpm --filter @avtar/agent-provider serve`);
    console.error(`  ${msg}`);
    process.exitCode = 1;
    return;
  }

  const app = createConsumerServer({ config, session });
  const server = app.listen(config.port, () => {
    console.log(`avtar consumer listening on http://localhost:${config.port}`);
    console.log(`  brain:       ${process.env.OPENAI_API_KEY ? "OpenAI" : "stub (offline)"}`);
    console.log(`  chat:        POST /chat   { "message": "…" }`);
    console.log(`  health:      GET  /health`);
  });

  const shutdown = async () => {
    console.log("\nsettling channel…");
    server.close();
    await session.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
