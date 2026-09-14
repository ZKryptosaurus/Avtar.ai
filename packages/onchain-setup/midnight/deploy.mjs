// Deploy to public Preprod/Preview; only the proof server runs locally.
import { config as loadDotenv } from "dotenv";
import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { firstValueFrom, throttleTime } from "rxjs";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { unshieldedToken } from "@midnight-ntwrk/ledger-v8";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { midnightConfigFromEnv, assertMidnightConfig } from "../dist/midnight-config.js";
import { buildMidnightNetworkProviders, DEFAULT_MANAGED_CONTRACT_DIR } from "../dist/midnight-providers.js";
import { buildMidnightWallet, createWalletAndMidnightProvider, parseWalletSeed, waitForWalletState, withSponsoredFees } from "../dist/midnight-wallet.js";
import { Contract } from "./contracts/avtar-escrow/managed/contract/index.js";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv({ path: join(packageDir, ".env") });
const config = midnightConfigFromEnv();
const sponsorUrl = process.env.MIDNIGHT_FEE_SPONSOR_URL;
if (sponsorUrl && sponsorUrl !== new URL(config.indexerUrl).origin) {
  throw new Error("MIDNIGHT_FEE_SPONSOR_URL must match the authenticated 1AM indexer origin");
}
assertMidnightConfig(config, false);
if (!["preprod", "preview"].includes(config.networkId)) {
  throw new Error("This deploy script requires MIDNIGHT_NETWORK_ID=preprod or preview (public testnets)");
}
setNetworkId(config.networkId);
console.log(`Deploying avtar-escrow to public Midnight ${config.networkId}`);
console.log("Indexer:", config.indexerUrl.split("?")[0], "| Proof service:", config.proofServerUrl);
const version = await fetch(`${config.proofServerUrl.replace(/\/$/, "")}/version`, {
  signal: AbortSignal.timeout(10_000),
});
if (!version.ok) throw new Error(`Proof service unavailable: HTTP ${version.status}`);
console.log("Proof server:", await version.text());

const seed = parseWalletSeed(config.walletSeed);
const ctx = await buildMidnightWallet(config, seed);
const { wallet, unshieldedKeystore } = ctx;
console.log("Wallet address:", unshieldedKeystore.getBech32Address().toString());
const progress = sponsorUrl ? undefined : wallet.state().pipe(throttleTime(15_000)).subscribe({
  next: (s) => console.log(`Sync: shielded ${s.shielded.progress.appliedIndex}/${s.shielded.progress.highestRelevantWalletIndex}, DUST ${s.dust.progress.appliedIndex}/${s.dust.progress.highestRelevantWalletIndex}; tNIGHT ${s.unshielded.balances[unshieldedToken().raw] ?? 0n}`),
  error: (error) => console.error("Wallet sync failed:", error.message),
});
try {
  if (!sponsorUrl) await wallet.start(ctx.shieldedSecretKeys, ctx.dustSecretKey);
  console.log(sponsorUrl ? "Contract proving: local; DUST fees: sponsored by 1AM" : "Waiting for wallet sync...");
  let state = sponsorUrl ? await firstValueFrom(wallet.state()) : await waitForWalletState(wallet);
  const night = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  if (!sponsorUrl) console.log(`Synced: ${night} tNIGHT; ${state.dust.balance(new Date())} DUST`);
  if (!sponsorUrl && state.dust.balance(new Date()) === 0n) {
    if (night === 0n) {
      throw new Error(`Fund the wallet above at https://faucet.${config.networkId}.midnight.network/ and rerun`);
    }
    const coins = state.unshielded.availableCoins.filter((coin) => !coin.meta.registeredForDustGeneration);
    if (coins.length > 0) {
      console.log("Registering tNIGHT for testnet DUST generation...");
      const recipe = await wallet.registerNightUtxosForDustGeneration(
        coins, unshieldedKeystore.getPublicKey(), (data) => unshieldedKeystore.signData(data),
      );
      console.log("DUST registration transaction:", await ctx.submitTransaction(await wallet.finalizeRecipe(recipe)));
    }
    console.log("Waiting for DUST to accrue...");
    state = await waitForWalletState(wallet, (s) => s.dust.balance(new Date()) > 0n);
  }

  let walletProvider = createWalletAndMidnightProvider(ctx, state);
  if (sponsorUrl) walletProvider = withSponsoredFees(walletProvider, sponsorUrl, new URL(config.indexerUrl).searchParams.get("session_token"));
  const stateDir = join(packageDir, ".midnight", config.networkId);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  // The SDK stores the deployment signing key even when the contract has no private state.
  const storagePassword = process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD ??
    createHmac("sha256", seed).update("avtar-escrow private storage v1").digest("base64") + "!Aa1";
  const privateStateProvider = levelPrivateStateProvider({
    midnightDbName: join(stateDir, "private-state"),
    accountId: walletProvider.getCoinPublicKey(),
    privateStoragePasswordProvider: () => storagePassword,
  });
  const compiledContract = CompiledContract.make("avtar-escrow", Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(DEFAULT_MANAGED_CONTRACT_DIR),
  );
  console.log("Proving and submitting deployment...");
  const deployed = await deployContract({
    ...buildMidnightNetworkProviders(config),
    privateStateProvider,
    walletProvider,
    midnightProvider: {
      async submitTx(tx) {
        console.log("Submitting transaction:", tx.identifiers().at(-1));
        return walletProvider.submitTx(tx);
      },
    },
  }, { compiledContract });
  const { contractAddress, txId, blockHeight } = deployed.deployTxData.public;
  const receipt = { network: config.networkId, contractAddress, txId, blockHeight };
  await writeFile(join(stateDir, "deployment.json"), JSON.stringify(receipt, (_, value) =>
    typeof value === "bigint" ? value.toString() : value, 2) + "\n", { mode: 0o600 });
  console.log(`Deployment confirmed: MIDNIGHT_AVTAR_ESCROW_ADDRESS=${contractAddress}`);
  console.log("Transaction:", txId, "| Block:", blockHeight);
} finally {
  progress?.unsubscribe();
  try { if (!sponsorUrl) await ctx.saveState(); } finally { await wallet.stop(); }
}
