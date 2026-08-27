/**
 * A metered service that a provider agent sells per call.
 *
 * The provider prices and performs the work; the consumer pays per call via the
 * channel's cumulative vouchers. Pricing is in the same atomic "units" the
 * channel meters (settlement_amount = total_units * rate), so a service that
 * costs 1 unit/call at rate 0.002 USDC bills 0.002 USDC/call.
 */
export interface Service<Req, Res> {
  /** Stable identifier, surfaced in results and the x402 discovery descriptor. */
  readonly name: string;
  /**
   * Price of a request, in units. The PROVIDER prices independently — it never
   * trusts a consumer-claimed cost. Must be > 0.
   */
  price(req: Req): bigint;
  /**
   * Perform the work and return a result. Only ever called after payment is
   * verified. Async so real services (HTTP APIs, LLMs) can be plugged in.
   */
  handle(req: Req): Promise<Res>;
}

export interface InferenceRequest {
  prompt: string;
}

export interface InferenceResult {
  model: string;
  completion: string;
  /** units this call cost (echoed for convenience) */
  units: bigint;
}

/**
 * A deterministic mock "inference" API — stands in for a real metered service
 * (LLM call, data query, compute job). Deterministic so tests and the demo are
 * reproducible.
 */
export class MockInferenceService implements Service<InferenceRequest, InferenceResult> {
  readonly name = "mock-inference";

  constructor(private readonly unitsPerCall: bigint = 1n) {
    if (unitsPerCall <= 0n) throw new Error("unitsPerCall must be positive");
  }

  price(_req: InferenceRequest): bigint {
    return this.unitsPerCall;
  }

  async handle(req: InferenceRequest): Promise<InferenceResult> {
    const completion = `echo(${req.prompt.length}): ${req.prompt.split("").reverse().join("")}`;
    return { model: this.name, completion, units: this.unitsPerCall };
  }
}
