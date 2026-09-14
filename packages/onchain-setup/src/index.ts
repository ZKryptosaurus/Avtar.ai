import "./websocket.js";
export {
  midnightConfigFromEnv,
  assertMidnightConfig,
  type MidnightConfig,
} from "./midnight-config.js";

export {
  buildMidnightNetworkProviders,
  DEFAULT_MANAGED_CONTRACT_DIR,
  type MidnightNetworkProviders,
  type AvtarEscrowCircuitId,
} from "./midnight-providers.js";

export {
  LocalAvtarEscrowContract,
  type OpenChannelArgs as MidnightOpenChannelArgs,
  type SettleArgs as MidnightSettleContractArgs,
  type RefundArgs as MidnightRefundArgs,
} from "./midnight-contract.js";

export { connectAvtarEscrow } from "./midnight-live.js";
