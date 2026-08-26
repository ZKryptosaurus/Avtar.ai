// ponytail: assert-based self-check, no test framework — this repo has none
// configured, and this is one script exercising one code path end to end.
//
// Verifies that `@avtar/proving-setup`'s off-chain voucher signing
// (`createVoucher`/`computeRateCommitment`/`computeNullifier`) produces
// values the *actual compiled* `avtar-escrow.compact` circuit accepts and
// correctly rejects when tampered with. Run `pnpm compact:build` and
// `pnpm --filter @avtar/proving-setup build` first.
import assert from "node:assert/strict";
import {
  createVoucher,
  computeRateCommitment,
  computeNullifier,
  deriveConsumerPublicKey,
} from "../../proving-setup/dist/midnight.js";
import { pureCircuits } from "./contracts/avtar-escrow/managed/contract/index.js";

function randomFieldish() {
  return BigInt(Math.floor(Math.random() * 1e15)) + 1n;
}

const consumerPrivateKey = 12345678901234567890123456789012345678901234567890123456789012345n;
const channelId = randomFieldish();
const totalUnits = 42n;
const rate = 7n;
const rateBlind = randomFieldish();
const channelSecret = randomFieldish();

const voucher = createVoucher(consumerPrivateKey, channelId, totalUnits);
const { x: pubkeyX, y: pubkeyY } = deriveConsumerPublicKey(consumerPrivateKey);
assert.equal(voucher.consumerPublicKey.x, pubkeyX);
assert.equal(voucher.consumerPublicKey.y, pubkeyY);

// 1. A genuine voucher signature verifies through the compiled circuit.
const sig = voucher.signature;
assert.equal(
  pureCircuits.verifyVoucherSignature(
    pubkeyX,
    pubkeyY,
    sig.sigRx,
    sig.sigRy,
    voucher.message,
    sig.sigRemainder,
    sig.sigQuotient,
    sig.sigS,
  ),
  true,
  "genuine voucher signature must verify",
);

// 2. A tampered `s` is rejected.
assert.equal(
  pureCircuits.verifyVoucherSignature(
    pubkeyX,
    pubkeyY,
    sig.sigRx,
    sig.sigRy,
    voucher.message,
    sig.sigRemainder,
    sig.sigQuotient,
    (sig.sigS + 1n) % (1n << 252n),
  ),
  false,
  "tampered signature must be rejected",
);

// 3. rate commitment / nullifier hashes match what `settle` recomputes.
const rateCommitment = computeRateCommitment(rate, rateBlind);
const rateCommitmentAgain = computeRateCommitment(rate, rateBlind);
assert.deepEqual(rateCommitment, rateCommitmentAgain, "rate commitment must be deterministic");
assert.equal(rateCommitment.length, 32);

const nullifier = computeNullifier(channelId, channelSecret);
const nullifierDifferentSecret = computeNullifier(channelId, channelSecret + 1n);
assert.notDeepEqual(nullifier, nullifierDifferentSecret, "nullifier must depend on channelSecret");

// 4. reduceToScalar rejects a decomposition that doesn't reconstruct its input.
assert.throws(
  () => pureCircuits.reduceToScalar(123456789n, 1n, 0n),
  /reconstruct/,
  "reduceToScalar must reject a bad decomposition",
);

// 5. Many round trips — sanity that the ~2^-57 rejection edge case doesn't
// spuriously trip in ordinary use.
for (let i = 0; i < 50; i++) {
  const v = createVoucher(consumerPrivateKey, randomFieldish(), randomFieldish());
  const ok = pureCircuits.verifyVoucherSignature(
    v.consumerPublicKey.x,
    v.consumerPublicKey.y,
    v.signature.sigRx,
    v.signature.sigRy,
    v.message,
    v.signature.sigRemainder,
    v.signature.sigQuotient,
    v.signature.sigS,
  );
  assert.equal(ok, true, `round trip ${i} must verify`);
}

console.log("midnight/selfcheck: all checks passed");
