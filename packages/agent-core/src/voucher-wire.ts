import type { Voucher } from "@avtar/proving-setup";

/** JSON-safe voucher for HTTP transport / storage (bigints as decimal strings).
 * Schnorr-over-Jubjub-signed (`sigRx/sigRy/sigRemainder/sigQuotient/sigS`) —
 * see `packages/proving-setup/src/midnight.ts`. */
export interface WireVoucher {
  channelId: string;
  totalUnits: string;
  message: string;
  consumerPublicKey: { x: string; y: string };
  signature: {
    sigRx: string;
    sigRy: string;
    sigRemainder: string;
    sigQuotient: string;
    sigS: string;
  };
}

export function serializeVoucher(v: Voucher): WireVoucher {
  return {
    channelId: v.channelId.toString(),
    totalUnits: v.totalUnits.toString(),
    message: v.message.toString(),
    consumerPublicKey: { x: v.consumerPublicKey.x.toString(), y: v.consumerPublicKey.y.toString() },
    signature: {
      sigRx: v.signature.sigRx.toString(),
      sigRy: v.signature.sigRy.toString(),
      sigRemainder: v.signature.sigRemainder.toString(),
      sigQuotient: v.signature.sigQuotient.toString(),
      sigS: v.signature.sigS.toString(),
    },
  };
}

export function deserializeVoucher(w: WireVoucher): Voucher {
  return {
    channelId: BigInt(w.channelId),
    totalUnits: BigInt(w.totalUnits),
    message: BigInt(w.message),
    consumerPublicKey: { x: BigInt(w.consumerPublicKey.x), y: BigInt(w.consumerPublicKey.y) },
    signature: {
      sigRx: BigInt(w.signature.sigRx),
      sigRy: BigInt(w.signature.sigRy),
      sigRemainder: BigInt(w.signature.sigRemainder),
      sigQuotient: BigInt(w.signature.sigQuotient),
      sigS: BigInt(w.signature.sigS),
    },
  };
}

/** Runtime type guard for an incoming {@link WireVoucher}. */
export function isWireVoucher(value: unknown): value is WireVoucher {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.channelId !== "string" || typeof v.totalUnits !== "string") return false;
  const pk = v.consumerPublicKey as Record<string, unknown> | undefined;
  const sig = v.signature as Record<string, unknown> | undefined;
  if (typeof pk?.x !== "string" || typeof pk?.y !== "string") return false;
  return (
    typeof sig?.sigRx === "string" &&
    typeof sig?.sigRy === "string" &&
    typeof sig?.sigRemainder === "string" &&
    typeof sig?.sigQuotient === "string" &&
    typeof sig?.sigS === "string"
  );
}
