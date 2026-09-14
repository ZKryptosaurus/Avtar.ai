import "./websocket.js";
import { mnemonicToSeedSync, validateMnemonic } from "bip39";
import { filter, firstValueFrom, timeout } from "rxjs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DustSecretKey, LedgerParameters, Transaction, ZswapSecretKeys, type Binding, type Proof, type SignatureEnabled, type FinalizedTransaction } from "@midnight-ntwrk/ledger-v8";
import { InMemoryTransactionHistoryStorage } from "@midnight-ntwrk/wallet-sdk-abstractions";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { WalletFacade, WalletEntrySchema, mergeWalletEntries, type FacadeState } from "@midnight-ntwrk/wallet-sdk-facade";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import { createKeystore, PublicKey, UnshieldedWallet } from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import type { MidnightProvider, WalletProvider } from "@midnight-ntwrk/midnight-js-types";
import type { MidnightConfig } from "./midnight-config.js";

export function parseWalletSeed(value = ""): Buffer {
  const seed = value.trim().replace(/\s+/g, " ");
  if (/^(?:[0-9a-f]{64}|[0-9a-f]{128})$/i.test(seed)) return Buffer.from(seed, "hex");
  if (!validateMnemonic(seed)) {
    throw new Error("MIDNIGHT_WALLET_SEED must be a valid BIP-39 mnemonic or 32/64-byte hex seed");
  }
  // Keep all 64 bytes: truncating a BIP-39 seed derives a different wallet from Lace.
  return mnemonicToSeedSync(seed);
}

export async function buildMidnightWallet(config: MidnightConfig, seed: Uint8Array) {
  const result = HDWallet.fromSeed(seed);
  if (result.type !== "seedOk") throw new Error("Cannot initialize Midnight HD wallet");
  const derived = result.hdWallet.selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  result.hdWallet.clear();
  if (derived.type !== "keysDerived") throw new Error("Cannot derive Midnight wallet keys");
  const shieldedSecretKeys = ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
  const dustSecretKey = DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(derived.keys[Roles.NightExternal], config.networkId);
  const indexerUrl = new URL(config.indexerUrl);
  if (["api-preprod.1am.xyz", "api-preview.1am.xyz"].includes(indexerUrl.hostname)) {
    const wsUrl = new URL(config.indexerWsUrl);
    if (indexerUrl.protocol !== "https:" || wsUrl.protocol !== "wss:" || wsUrl.hostname !== indexerUrl.hostname) {
      throw new Error("1AM indexer HTTP and WebSocket URLs must use HTTPS/WSS on the same host");
    }
    const challengeResponse = await fetch(`${indexerUrl.origin}/auth/challenge`, { signal: AbortSignal.timeout(10_000) });
    if (!challengeResponse.ok) throw new Error(`1AM challenge failed: HTTP ${challengeResponse.status}`);
    const challenge = await challengeResponse.json() as { domain: string; nonce: string };
    if (challenge.domain !== "1am.xyz" || !/^[0-9a-f-]{36}$/i.test(challenge.nonce)) throw new Error("Unexpected 1AM login challenge");
    const timestamp = Math.floor(Date.now() / 1000);
    const message = Buffer.from(["1AM-AUTH-v1", challenge.domain, challenge.nonce, timestamp].join("\n"));
    const verification = await fetch(`${indexerUrl.origin}/auth/verify`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ nonce: challenge.nonce, timestamp, pubkey: unshieldedKeystore.getPublicKey(), signature: unshieldedKeystore.signData(message) }),
    });
    if (!verification.ok) throw new Error(`1AM wallet authentication failed: HTTP ${verification.status}`);
    const session = await verification.json() as { token: string };
    if (typeof session.token !== "string" || !session.token) throw new Error("Missing 1AM session token");
    indexerUrl.searchParams.set("session_token", session.token);
    wsUrl.searchParams.set("session_token", session.token);
    config.indexerUrl = indexerUrl.toString();
    config.indexerWsUrl = wsUrl.toString();
    const nodeUrl = new URL(config.nodeUrl);
    if (nodeUrl.hostname === indexerUrl.hostname && nodeUrl.pathname === '/rpc/midnight') {
      if (!['https:', 'wss:'].includes(nodeUrl.protocol)) throw new Error('1AM node URL must use HTTPS or WSS');
      nodeUrl.searchParams.set('session_token', session.token);
      config.nodeUrl = nodeUrl.toString();
    }
  }
  const stateDir = fileURLToPath(new URL("../.midnight/", import.meta.url));
  const stateFile = join(stateDir, `${unshieldedKeystore.getBech32Address()}.json`);
  let saved: { shielded: string; unshielded: string; dust: string } | undefined;
  try {
    saved = JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const configuration = {
    networkId: config.networkId,
    indexerClientConnection: { indexerHttpUrl: config.indexerUrl, indexerWsUrl: config.indexerWsUrl },
    provingServerUrl: new URL(config.proofServerUrl),
    relayURL: new URL(config.nodeUrl.replace(/^http/, "ws")),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
    batchUpdates: { size: 1_000, timeout: 100, spacing: 0 },
  };
  const wallet = await WalletFacade.init({
    configuration,
    // Submit through our HTTP MidnightProvider; do not start the SDK's unused
    // WebSocket submission client (which also logs authenticated endpoint URLs).
    submissionService: () => ({
      async submitTransaction() { throw new Error('Use the MidnightProvider HTTP submission path'); },
      async close() {},
    }),
    shielded: (cfg) => saved ? ShieldedWallet(cfg).restore(saved.shielded) : ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (cfg) => saved ? UnshieldedWallet(cfg).restore(saved.unshielded) : UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (cfg) => saved ? DustWallet(cfg).restore(saved.dust) : DustWallet(cfg).startWithSecretKey(dustSecretKey, LedgerParameters.initialParameters().dust),
  });
  async function saveState() {
    const [shielded, unshielded, dust] = await Promise.all([
      wallet.shielded.serializeState(), wallet.unshielded.serializeState(), wallet.dust.serializeState(),
    ]);
    await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
    await writeFile(`${stateFile}.tmp`, JSON.stringify({ shielded, unshielded, dust }), { mode: 0o600 });
    await rename(`${stateFile}.tmp`, stateFile);
  }
  async function submitTransaction(tx: FinalizedTransaction): Promise<string> {
    // The wallet SDK's node client disconnects between metadata and submission.
    // HTTP submission avoids that lifecycle; midnight-js waits for indexer confirmation.
    const { ApiPromise, HttpProvider } = await import('@polkadot/api');
    const api = await ApiPromise.create({ provider: new HttpProvider(config.nodeUrl.replace(/^ws/, 'http')), noInitWarn: true });
    try {
      const send = api.tx.midnight?.sendMnTransaction;
      if (!send) throw new Error('Node does not expose midnight.sendMnTransaction');
      const response = await fetch(config.nodeUrl.replace(/^ws/, 'http'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'author_submitExtrinsic',
          params: [send('0x' + Buffer.from(tx.serialize()).toString('hex')).toHex()] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Node rejected submission: HTTP ${response.status}`);
      const result = await response.json() as { result?: string; error?: { code: number; message: string } };
      if (result.error) throw new Error(`Node rejected submission (${result.error.code}): ${result.error.message}`);
      if (!result.result || !/^0x[0-9a-f]{64}$/i.test(result.result)) throw new Error('Node returned no transaction hash');
      const id = tx.identifiers().at(-1);
      if (!id) throw new Error('Submitted transaction has no identifier');
      return id;
    } finally {
      await api.disconnect();
    }
  }
  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore, saveState, submitTransaction };
}

export function waitForWalletState(
  wallet: WalletFacade,
  predicate: (state: FacadeState) => boolean = () => true,
  timeoutMs = 900_000,
): Promise<FacadeState> {
  return firstValueFrom(wallet.state().pipe(
    filter((state) => state.isSynced && predicate(state)),
    timeout({ first: timeoutMs }),
  ));
}

export function createWalletAndMidnightProvider(
  ctx: Awaited<ReturnType<typeof buildMidnightWallet>>,
  state: FacadeState,
): WalletProvider & MidnightProvider {
  return {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx, ttl = new Date(Date.now() + 30 * 60_000)) {
      const recipe = await ctx.wallet.balanceUnboundTransaction(tx, ctx, { ttl });
      const signed = await ctx.wallet.signRecipe(recipe, (data) => ctx.unshieldedKeystore.signData(data));
      return ctx.wallet.finalizeRecipe(signed);
    },
    submitTx: (tx) => ctx.submitTransaction(tx),
  };
}

/** Add sponsored DUST to an already proven deployment; contract proving stays local. */
export function withSponsoredFees(provider: WalletProvider & MidnightProvider, origin: string, sessionToken: string): WalletProvider & MidnightProvider {
  if (!["https://api-preprod.1am.xyz", "https://api-preview.1am.xyz"].includes(origin) || !sessionToken) {
    throw new Error("Fee sponsorship requires an authenticated 1AM testnet session");
  }
  return {
    ...provider,
    async balanceTx(tx) {
      const response = await fetch(`${origin}/balance-only`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "X-Session-Token": sessionToken },
        body: Uint8Array.from(tx.serialize()).buffer,
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after');
        const detail = response.status === 429 ? await response.json().catch(() => ({})) as { error?: string; message?: string } : {};
        throw new Error(`1AM fee sponsorship failed: HTTP ${response.status}${retryAfter ? `; retry after ${retryAfter}` : ''}${typeof detail.error === 'string' ? `; ${detail.error}` : ''}`);
      }
      const result = await response.json() as { txBytes?: unknown; tx?: unknown };
      const hex = result.txBytes ?? result.tx;
      if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error("Invalid sponsored transaction encoding");
      const finalized = Transaction.deserialize<SignatureEnabled, Proof, Binding>("signature", "proof", "binding", Buffer.from(hex, "hex"));
      // A fee sponsor may add a balancing transaction, but must preserve our deployment.
      const ids = new Set(finalized.identifiers());
      if (!tx.identifiers().every((id) => ids.has(id))) throw new Error("Fee sponsor changed the deployment transaction");
      return finalized;
    },
  };
}
