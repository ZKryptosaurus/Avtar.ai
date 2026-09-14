// Read-only wallet check; shares seed derivation and sync logic with deployment.
import { config as loadDotenv } from "dotenv";
import { throttleTime } from "rxjs";
import { unshieldedToken } from "@midnight-ntwrk/ledger-v8";
import { midnightConfigFromEnv, assertMidnightConfig } from "./dist/midnight-config.js";
import { buildMidnightWallet, parseWalletSeed, waitForWalletState } from "./dist/midnight-wallet.js";

loadDotenv({ path: new URL(".env", import.meta.url) });
const config = midnightConfigFromEnv();
assertMidnightConfig(config, false);
const ctx = await buildMidnightWallet(config, parseWalletSeed(config.walletSeed));
console.log("Network:", config.networkId);
console.log("Wallet address:", ctx.unshieldedKeystore.getBech32Address().toString());
const progress = ctx.wallet.state().pipe(throttleTime(10_000)).subscribe({
  next: (s) => console.log(`Sync: shielded ${s.shielded.progress.appliedIndex}/${s.shielded.progress.highestRelevantWalletIndex}, DUST ${s.dust.progress.appliedIndex}/${s.dust.progress.highestRelevantWalletIndex}; tNIGHT ${s.unshielded.balances[unshieldedToken().raw] ?? 0n}`),
  error: (error) => console.error("Wallet sync failed:", error.message),
});
try {
  await ctx.wallet.start(ctx.shieldedSecretKeys, ctx.dustSecretKey);
  console.log("Waiting for sync...");
  const state = await waitForWalletState(ctx.wallet);
  console.log("tNIGHT:", state.unshielded.balances[unshieldedToken().raw] ?? 0n);
  console.log("DUST:", state.dust.balance(new Date()));
} catch (error) {
  console.error("Wallet check failed:", error.message);
  throw error;
} finally {
  progress.unsubscribe();
  try { await ctx.saveState(); } finally { await ctx.wallet.stop(); }
}
