import type { PaymentRequirements } from "./x402.js";

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface PaymentVerifier {
  verify(payment: string, requirements: PaymentRequirements): Promise<VerifyResult>;
}

export class LocalAuthorizationVerifier implements PaymentVerifier {
  async verify(payment: string): Promise<VerifyResult> {
    if (payment.trim().length === 0) {
      return { ok: false, reason: "missing-authorization" };
    }
    return { ok: true };
  }
}

export function createPaymentVerifier(): PaymentVerifier {
  return new LocalAuthorizationVerifier();
}
