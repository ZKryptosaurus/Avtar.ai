// Runnable entrypoint for the provider's x402 HTTP server.
//   pnpm --filter @avtar/agent-provider serve
// Env: MIDNIGHT_LOCAL_SIM, MIDNIGHT_PROVIDER_ADDRESS, MIDNIGHT_TOKEN_ADDRESS,
//      MIDNIGHT_RATE_ATOMIC, MIDNIGHT_X402_MAX_AMOUNT_ATOMIC, AVTAR_PROVIDER_PORT.
// Loads the shared repo-root .env. Shell env still wins.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { readProviderServerConfig } from "./config.js";
import { FetchHttpClient } from "./http.js";
import { buildToolbox } from "./tools.js";
import { createProviderServer } from "./server.js";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
loadEnv({ path: envPath });
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/onchain-setup/.env") });

const config = readProviderServerConfig();
const toolbox = buildToolbox(new FetchHttpClient());
const app = createProviderServer({ config, toolbox });

app.listen(config.port, () => {
  console.log(`avtar provider (x402) listening on http://localhost:${config.port}`);
  console.log(`  mode:          ${config.network}`);
  console.log(`  token payload: ${config.asset}`);
  console.log(`  tools:         ${toolbox.toolNames().join(", ")}`);
  console.log(`  open channel:  POST /agent/open   (402 → X-PAYMENT → open)`);
  console.log(`  agent card:    GET  /.well-known/agent-card.json`);
});
