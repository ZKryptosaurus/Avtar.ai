// Deploys `avtar-escrow` to a live Midnight network and prints the contract
// address to set as MIDNIGHT_AVTAR_ESCROW_ADDRESS.
//
//   pnpm midnight:deploy   (after `pnpm build` and `pnpm compact:build`)
//
// Env (see ../.example.env):
//   MIDNIGHT_INDEXER_URL, MIDNIGHT_INDEXER_WS_URL, MIDNIGHT_NODE_URL,
//   MIDNIGHT_PROOF_SERVER_URL, MIDNIGHT_WALLET_SEED
//
// STATUS: everything up to building the network providers (proof/indexer/
// zkConfig — see ../dist/midnight-providers.js) is real and wired against
// the installed @midnight-ntwrk/midnight-js-* v4.1.1 packages. The actual
// deployContract() call below is NOT wired yet: midnight-js-contracts@4.1.1
// expects a `CompiledContract` from the separate `@midnight-ntwrk/compact-js`
// package (currently 2.5.x — a different version line entirely), which wraps
// the classic `Contract` class differently than what `compact` CLI 0.5.1 /
// `compact-runtime@0.16.0` emit into managed/contract/index.js. Pairing
// these correctly needs Midnight's official compiler/runtime/SDK
// compatibility matrix, which isn't something to guess at — get that value
// (or upgrade the whole toolchain and re-verify `pnpm test` still passes),
// then finish the two TODOs below.
import { midnightConfigFromEnv, assertMidnightConfig } from "../dist/midnight-config.js";
import { buildMidnightNetworkProviders } from "../dist/midnight-providers.js";

const config = midnightConfigFromEnv();
assertMidnightConfig(config);

console.log("Network providers (proof/indexer/zkConfig): building...");
const { proofProvider, publicDataProvider, zkConfigProvider } = buildMidnightNetworkProviders(config);
console.log("  proofServerUrl:", config.proofServerUrl);
console.log("  indexerUrl:    ", config.indexerUrl);
void proofProvider;
void publicDataProvider;
void zkConfigProvider;

// TODO(midnight-sdk-version): build walletProvider + midnightProvider from
// MIDNIGHT_WALLET_SEED via @midnight-ntwrk/wallet's WalletBuilder, and wait
// for it to sync (see @midnight-ntwrk/wallet-api's WalletProvider shape).

// TODO(midnight-sdk-version): wrap the compiled contract
// (../midnight/contracts/avtar-escrow/managed/contract/index.js) into the
// `CompiledContract` shape @midnight-ntwrk/midnight-js-contracts@4.1.1's
// deployContract() expects, then call:
//   const deployed = await deployContract(providers, {
//     compiledContract, privateStateId: "avtar-escrow", initialPrivateState: undefined,
//   });
//   console.log("Deployed at:", deployed.deployTxData.public.contractAddress);

throw new Error(
  "midnight:deploy is not wired to a live network yet — see the STATUS comment " +
    "at the top of this file for exactly what's blocking it and what to do next.",
);
