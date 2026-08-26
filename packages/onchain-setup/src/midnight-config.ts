/**
 * Deployed Midnight contract address + network endpoints for TypeScript
 * clients. Nothing here is defaulted to a real hostname: Midnight's
 * indexer/node/proof-server URLs are deployment-specific and guessing one
 * wrong fails silently (a client happily talks to the wrong network), so
 * every endpoint is required from the environment.
 */
export interface MidnightConfig {
  /** GraphQL HTTP endpoint of the Midnight indexer. */
  indexerUrl: string;
  /** GraphQL WebSocket endpoint of the Midnight indexer (subscriptions). */
  indexerWsUrl: string;
  /** JSON-RPC endpoint of a Midnight node. */
  nodeUrl: string;
  /** Local or remote proof server (`compact` circuit proving, /prove + /check). */
  proofServerUrl: string;
  /** Deployed `avtar-escrow` contract address (from `pnpm midnight:deploy`). */
  contractAddress: string;
}

/** Local proof server default port used by Midnight's `docker run midnightnetwork/proof-server`. */
const DEFAULT_LOCAL_PROOF_SERVER_URL = "http://localhost:6300";

/** Read Midnight endpoint/contract config from the environment. */
export function midnightConfigFromEnv(
  overrides: Partial<MidnightConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): MidnightConfig {
  return {
    indexerUrl: env.MIDNIGHT_INDEXER_URL ?? "",
    indexerWsUrl: env.MIDNIGHT_INDEXER_WS_URL ?? "",
    nodeUrl: env.MIDNIGHT_NODE_URL ?? "",
    proofServerUrl: env.MIDNIGHT_PROOF_SERVER_URL ?? DEFAULT_LOCAL_PROOF_SERVER_URL,
    contractAddress: env.MIDNIGHT_AVTAR_ESCROW_ADDRESS ?? "",
    ...overrides,
  };
}

export function assertMidnightConfig(config: MidnightConfig): void {
  if (!config.indexerUrl) throw new Error("MidnightConfig.indexerUrl is required (MIDNIGHT_INDEXER_URL)");
  if (!config.indexerWsUrl) {
    throw new Error("MidnightConfig.indexerWsUrl is required (MIDNIGHT_INDEXER_WS_URL)");
  }
  if (!config.nodeUrl) throw new Error("MidnightConfig.nodeUrl is required (MIDNIGHT_NODE_URL)");
  if (!config.proofServerUrl) {
    throw new Error("MidnightConfig.proofServerUrl is required (MIDNIGHT_PROOF_SERVER_URL)");
  }
  if (!config.contractAddress) {
    throw new Error(
      "MidnightConfig.contractAddress is required (MIDNIGHT_AVTAR_ESCROW_ADDRESS) — run `pnpm midnight:deploy` first",
    );
  }
}
