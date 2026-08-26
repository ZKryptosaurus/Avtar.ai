import { randomBytes } from "node:crypto";
import {
  constructJubjubPoint,
  ecAdd,
  ecMul,
  ecMulGenerator,
  jubjubPointX,
  jubjubPointY,
  persistentHash,
  transientHash,
  CompactTypeField,
  CompactTypeVector,
  type JubjubPoint,
} from "@midnight-ntwrk/compact-runtime";

/**
 * A field-element value accepted from callers. Normalised internally to a
 * `bigint`; strings may be decimal (`"123"`) or hex (`"0x7b"`).
 */
export type FieldInput = string | number | bigint;

/**
 * Voucher signing for the Midnight port of `slate-escrow` (see
 * `packages/onchain-setup/midnight/contracts/slate-escrow/src/slate-escrow.compact`).
 *
 * Midnight's Compact language has no built-in EdDSA/Schnorr verifier, so the
 * contract hand-rolls Schnorr-over-Jubjub using the embedded curve ops
 * (`ecAdd`/`ecMul`/`ecMulGenerator`). This module is the off-chain half:
 * signing uses the exact same primitives (from `@midnight-ntwrk/compact-runtime`)
 * so the math is guaranteed consistent with what the circuit checks, and does
 * genuine mod-`EMBEDDED_ORDER` scalar arithmetic in plain `bigint` (no
 * key-space weakening — this is full-strength ~252-bit Schnorr).
 *
 * The one thing that must stay in lockstep with the contract: `EMBEDDED_ORDER`,
 * `REDUCTION_MODULUS`, and the reduce-to-scalar decomposition below mirror
 * `reduceToScalar` in the `.compact` file exactly. If that circuit ever
 * changes, this must change with it.
 */

/** Jubjub embedded-curve scalar (prime subgroup) order — confirmed empirically
 * against `@midnight-ntwrk/compact-runtime`'s `ecMul` decode bound; matches the
 * canonical zkcrypto/jubjub curve's published `r`. */
export const EMBEDDED_ORDER =
  6554484396890773809930967563523245729705921265872317281365359162392183254199n;

/** 2^200 — the modulus `reduceToScalar` in the contract reduces hash outputs
 * against. Must stay below `EMBEDDED_ORDER` and below Compact's 2^248 Uint
 * ceiling; see the contract's doc comment for the full soundness argument. */
const REDUCTION_MODULUS = 1606938044258990275541962092341162602522202993782792835301376n;

function toBigInt(label: string, value: FieldInput): bigint {
  switch (typeof value) {
    case "bigint":
      return value;
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new Error(`${label} must be a safe integer, bigint, or numeric string`);
      }
      return BigInt(value);
    case "string":
      return BigInt(value.trim());
    default:
      throw new Error(`${label} must be a string, number, or bigint`);
  }
}

/** A cryptographically random scalar in `[0, EMBEDDED_ORDER)`. */
export function randomScalar(): bigint {
  // 32 bytes gives ~256 bits of entropy, comfortably more than EMBEDDED_ORDER's
  // ~252, so `% EMBEDDED_ORDER` bias is negligible (< 2^-4 relative, far below
  // any relevant security margin for a nonce/key of this size).
  let value = 0n;
  for (const byte of randomBytes(32)) {
    value = (value << 8n) | BigInt(byte);
  }
  return value % EMBEDDED_ORDER;
}

function hashFields(fields: readonly bigint[]): bigint {
  return transientHash(new CompactTypeVector(fields.length, CompactTypeField), [...fields]);
}

/** Splits a full-width `transientHash` output into the (remainder, quotient)
 * pair the contract's `reduceToScalar` expects, so `remainder < REDUCTION_MODULUS`
 * (and therefore `< EMBEDDED_ORDER`) is a valid EC scalar. */
function decomposeChallenge(hash: bigint): { remainder: bigint; quotient: bigint } {
  return { remainder: hash % REDUCTION_MODULUS, quotient: hash / REDUCTION_MODULUS };
}

/** A Jubjub public key (the contract's `consumerPubkeyX` / `consumerPubkeyY`). */
export interface ConsumerPublicKey {
  x: bigint;
  y: bigint;
}

/** A Schnorr-over-Jubjub voucher signature, in the shape `slate-escrow.settle` expects. */
export interface VoucherSignature {
  sigRx: bigint;
  sigRy: bigint;
  sigRemainder: bigint;
  sigQuotient: bigint;
  sigS: bigint;
}

function pointOf(point: JubjubPoint): { x: bigint; y: bigint } {
  return { x: jubjubPointX(point), y: jubjubPointY(point) };
}

/** Derive the consumer's Jubjub public key from a private scalar `< EMBEDDED_ORDER`. */
export function deriveConsumerPublicKey(privateKey: FieldInput): ConsumerPublicKey {
  const sk = toBigInt("privateKey", privateKey);
  return pointOf(ecMulGenerator(sk));
}

/**
 * Sign `message` (a field element, typically `transientHash(channelId, totalUnits)`
 * — see {@link computeVoucherMessage}) with a bounded-scalar Schnorr-over-Jubjub
 * signature. Verified on-chain by `slate-escrow.settle` via `verifyVoucherSignature`.
 */
export function signVoucher(privateKey: FieldInput, message: FieldInput): VoucherSignature {
  const sk = toBigInt("privateKey", privateKey);
  const msg = toBigInt("message", message);
  const { x: pubkeyX, y: pubkeyY } = deriveConsumerPublicKey(sk);

  const nonce = randomScalar();
  const R = ecMulGenerator(nonce);
  const { x: sigRx, y: sigRy } = pointOf(R);

  const h = hashFields([sigRx, sigRy, pubkeyX, pubkeyY, msg]);
  const { remainder, quotient } = decomposeChallenge(h);
  const s = (nonce + remainder * sk) % EMBEDDED_ORDER;

  return { sigRx, sigRy, sigRemainder: remainder, sigQuotient: quotient, sigS: s };
}

/**
 * Pure-TS re-implementation of the contract's `verifyVoucherSignature`, for
 * sanity-checking a voucher before submitting it. This must stay exactly in
 * sync with `verifyVoucherSignature`/`reduceToScalar` in
 * `slate-escrow.compact` — the contract itself is the actual verifier; treat
 * this as a fast-fail preflight, not the source of truth.
 */
export function verifyVoucherSignature(
  publicKey: ConsumerPublicKey,
  message: FieldInput,
  signature: VoucherSignature,
): boolean {
  const msg = toBigInt("message", message);
  const A = constructJubjubPoint(publicKey.x, publicKey.y);
  const R = constructJubjubPoint(signature.sigRx, signature.sigRy);

  const h = hashFields([signature.sigRx, signature.sigRy, publicKey.x, publicKey.y, msg]);
  const expected = signature.sigRemainder + signature.sigQuotient * REDUCTION_MODULUS;
  if (h !== expected || signature.sigRemainder >= REDUCTION_MODULUS) {
    return false;
  }

  const lhs = ecMulGenerator(signature.sigS);
  const rhs = ecAdd(R, ecMul(A, signature.sigRemainder));
  return jubjubPointX(lhs) === jubjubPointX(rhs) && jubjubPointY(lhs) === jubjubPointY(rhs);
}

/** `rateCommitment = persistentHash(rate, rateBlind)` — matches the contract's ledger field. */
export function computeRateCommitment(rate: FieldInput, rateBlind: FieldInput): Uint8Array {
  const a = toBigInt("rate", rate);
  const b = toBigInt("rateBlind", rateBlind);
  return persistentHash(new CompactTypeVector(2, CompactTypeField), [a, b]);
}

/** `nullifier = persistentHash(channelId, channelSecret)`. */
export function computeNullifier(channelId: FieldInput, channelSecret: FieldInput): Uint8Array {
  const a = toBigInt("channelId", channelId);
  const b = toBigInt("channelSecret", channelSecret);
  return persistentHash(new CompactTypeVector(2, CompactTypeField), [a, b]);
}

/** Voucher message signed by the consumer: `transientHash(channelId, totalUnits)`. */
export function computeVoucherMessage(channelId: FieldInput, totalUnits: FieldInput): bigint {
  return hashFields([toBigInt("channelId", channelId), toBigInt("totalUnits", totalUnits)]);
}

/** A signed metering voucher, ready to pass into `slate-escrow.settle`. */
export interface Voucher {
  channelId: bigint;
  totalUnits: bigint;
  message: bigint;
  consumerPublicKey: ConsumerPublicKey;
  signature: VoucherSignature;
}

/** Create a signed metering voucher (the consumer side of the protocol). */
export function createVoucher(
  privateKey: FieldInput,
  channelId: FieldInput,
  totalUnits: FieldInput,
): Voucher {
  const channelIdBig = toBigInt("channelId", channelId);
  const totalUnitsBig = toBigInt("totalUnits", totalUnits);
  const message = computeVoucherMessage(channelIdBig, totalUnitsBig);
  const consumerPublicKey = deriveConsumerPublicKey(privateKey);
  const signature = signVoucher(privateKey, message);
  return { channelId: channelIdBig, totalUnits: totalUnitsBig, message, consumerPublicKey, signature };
}
