import assert from "node:assert/strict";
import { Subject } from "rxjs";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { createUnprovenDeployTx } from "@midnight-ntwrk/midnight-js-contracts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { CostModel, sampleCoinPublicKey, sampleEncryptionPublicKey, sampleSigningKey, verifySignature } from "@midnight-ntwrk/ledger-v8";
import { midnightConfigFromEnv, assertMidnightConfig } from "../dist/midnight-config.js";
import { buildMidnightNetworkProviders, DEFAULT_MANAGED_CONTRACT_DIR } from "../dist/midnight-providers.js";
import { buildMidnightWallet, createWalletAndMidnightProvider, parseWalletSeed, waitForWalletState, withSponsoredFees } from "../dist/midnight-wallet.js";
import { Contract } from "./contracts/avtar-escrow/managed/contract/index.js";

// BIP-39 test vector: preserve the full 64-byte seed, not the old truncated one.
assert.equal(parseWalletSeed("abandon ".repeat(11) + "about").toString("hex"),
  "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a" +
  "5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4");
assert.equal(parseWalletSeed("01".repeat(32)).toString("hex"), "01".repeat(32));
assert.equal(parseWalletSeed("02".repeat(64)).length, 64);
for (const invalid of [undefined, "", "not a mnemonic", "a".repeat(63)]) {
  assert.throws(() => parseWalletSeed(invalid), /MIDNIGHT_WALLET_SEED/);
}

const states = new Subject();
const synced = { isSynced: true };
const waiting = waitForWalletState({ state: () => states }, () => true, 100);
states.next({ isSynced: false });
states.next(synced);
assert.equal(await waiting, synced);
await assert.rejects(waitForWalletState({ state: () => states }, () => true, 5), /Timeout/);

const calls = [];
const tx = {}, recipe = {}, signed = {}, finalized = {};
const ttl = new Date();
const ctx = {
  shieldedSecretKeys: {}, dustSecretKey: {},
  unshieldedKeystore: { signData: () => "signature" },
  async submitTransaction(input) { assert.equal(input, finalized); calls.push("submit"); return "tx-id"; },
  wallet: {
    async balanceUnboundTransaction(input, keys, options) {
      assert.equal(input, tx); assert.equal(keys, ctx); assert.equal(options.ttl, ttl);
      calls.push("balance"); return recipe;
    },
    async signRecipe(input, sign) {
      assert.equal(input, recipe); assert.equal(sign(new Uint8Array()), "signature");
      calls.push("sign"); return signed;
    },
    async finalizeRecipe(input) { assert.equal(input, signed); calls.push("finalize"); return finalized; },
    async submitTransaction(input) { assert.equal(input, finalized); calls.push("submit"); return "tx-id"; },
  },
};
const coinPublicKey = sampleCoinPublicKey();
const encryptionPublicKey = sampleEncryptionPublicKey();
const provider = createWalletAndMidnightProvider(ctx, { shielded: {
  coinPublicKey: { toHexString: () => coinPublicKey },
  encryptionPublicKey: { toHexString: () => encryptionPublicKey },
} });
assert.equal(provider.getCoinPublicKey(), coinPublicKey);
assert.equal(provider.getEncryptionPublicKey(), encryptionPublicKey);
assert.equal(await provider.balanceTx(tx, ttl), finalized);
assert.equal(await provider.submitTx(finalized), "tx-id");
assert.deepEqual(calls, ["balance", "sign", "finalize", "submit"]);

// Build a real deployment without networking: catches SDK/runtime and asset-path mismatches.
const config = midnightConfigFromEnv({}, {
  MIDNIGHT_INDEXER_URL: "http://localhost:8088/api/v4/graphql",
  MIDNIGHT_INDEXER_WS_URL: "ws://localhost:8088/api/v4/graphql/ws",
  MIDNIGHT_NODE_URL: "http://localhost:9944",
});
assertMidnightConfig(config, false);
assert.throws(() => assertMidnightConfig(config), /contractAddress/);
const compiledContract = CompiledContract.make("avtar-escrow", Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(DEFAULT_MANAGED_CONTRACT_DIR),
);
setNetworkId("preprod");
const deployment = await createUnprovenDeployTx({
  ...buildMidnightNetworkProviders(config), walletProvider: provider,
}, { compiledContract, signingKey: sampleSigningKey() });
assert.match(deployment.public.contractAddress, /^[0-9a-f]{64}$/);
assert.ok(deployment.private.unprovenTx.serialize().length > 0);

// Authentication signs only the expected 1AM login message; never arbitrary challenges.
const originalFetch = globalThis.fetch;
const authConfig = { ...config,
  indexerUrl: "https://api-preprod.1am.xyz/api/v4/graphql",
  indexerWsUrl: "wss://api-preprod.1am.xyz/api/v4/graphql/ws",
};
try {
  globalThis.fetch = async () => Response.json({ domain: "unexpected.example", nonce: "0".repeat(36) });
  await assert.rejects(buildMidnightWallet(authConfig, Buffer.alloc(32, 1)), /Unexpected 1AM login challenge/);
  const nonce = "11111111-2222-3333-4444-555555555555";
  let signedLogin = false;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/auth/challenge")) return Response.json({ domain: "1am.xyz", nonce });
    assert.equal(url, "https://api-preprod.1am.xyz/auth/verify");
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body).sort(), ["nonce", "pubkey", "signature", "timestamp"]);
    assert.equal(body.nonce, nonce);
    assert.ok(verifySignature(body.pubkey, Buffer.from(`1AM-AUTH-v1\n1am.xyz\n${nonce}\n${body.timestamp}`), body.signature));
    signedLogin = true;
    return new Response(null, { status: 401 });
  };
  await assert.rejects(buildMidnightWallet(authConfig, Buffer.alloc(32, 1)), /authentication failed: HTTP 401/);
  assert.ok(signedLogin);
} finally {
  globalThis.fetch = originalFetch;
}

// A sponsored response must decode and retain the original deployment identifier.
const unbound = await deployment.private.unprovenTx.prove({
  check: async () => { throw new Error("Unexpected circuit proof in public deployment"); },
  prove: async () => { throw new Error("Unexpected circuit proof in public deployment"); },
}, CostModel.initialCostModel());
const boundDeployment = unbound.bind();
const sponsored = withSponsoredFees(provider, "https://api-preprod.1am.xyz", "test-session");
try {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api-preprod.1am.xyz/balance-only");
    assert.equal(options.headers["X-Session-Token"], "test-session");
    assert.deepEqual(new Uint8Array(options.body), unbound.serialize());
    return Response.json({ txBytes: Buffer.from(boundDeployment.serialize()).toString("hex") });
  };
  assert.deepEqual((await sponsored.balanceTx(unbound)).identifiers(), unbound.identifiers());
  await assert.rejects(sponsored.balanceTx({ serialize: () => unbound.serialize(), identifiers: () => ["changed"] }), /changed the deployment/);
  globalThis.fetch = async () => Response.json({ txBytes: "not hex" });
  await assert.rejects(sponsored.balanceTx(unbound), /Invalid sponsored transaction encoding/);
  globalThis.fetch = async () => Response.json({ error: "A balance transaction is already pending" }, { status: 429, headers: { "retry-after": "60" } });
  await assert.rejects(sponsored.balanceTx(unbound), /HTTP 429; retry after 60; A balance transaction is already pending/);
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(sponsored.balanceTx(unbound), /HTTP 503/);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("midnight/wallet-selfcheck: all checks passed");
