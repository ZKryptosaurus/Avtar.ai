// @avtar/agent-core — shared agent runtime: the priced Service interface, the
// metering channel (ConsumerMeter / ProviderMeter / ServiceChannel) built on
// @avtar/proving-setup, the on-chain ChainClient seam, and money helpers.
// Agents under agents/* compose these instead of re-implementing crypto.
// Settlement chain: Midnight (avtar-escrow.compact) — see
// packages/onchain-setup/midnight/deploy.mjs for live-network status.

export * from "./service.js";
export * from "./money.js";
export * from "./chain.js";
export * from "./channel.js";
export * from "./toolbox.js";
export * from "./voucher-wire.js";
export * from "./x402-client.js";
export * from "./x402-channel.js";
export * from "./settle.js";
// MeterDb uses node:sqlite (Node 22+). Import via "@avtar/agent-core/db" so
// provider/consumer servers on Node 20 don't load it unless needed.
export * from "./env.js";
export type { ConsumerPublicKey, Voucher } from "@avtar/proving-setup";
