export type FetchLike = typeof fetch;

export interface PaidFetchInput {
  url: string;
  init?: RequestInit;
  fetchImpl?: FetchLike;
  /** Payment authorization to present on the retry. Mock value by default. */
  paymentSignature?: string;
}

/**
 * Minimal x402 client: make the request, and if it comes back `402`, retry once
 * with a base64 `X-PAYMENT` header per the x402 spec. For local/demo runs the
 * payload carries a mock authorization; a real Midnight-auth entry would
 * go in `payload` once a facilitator is wired in.
 */
export async function fetchWithManualX402({
  url,
  init,
  fetchImpl = fetch,
  paymentSignature = "mock_payment_signature",
}: PaidFetchInput): Promise<Response> {
  const first = await fetchImpl(url, init);
  if (first.status !== 402) return first;

  await first.json().catch(() => undefined);

  const xPayment = Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: "midnight:local-sim",
      payload: { authorization: paymentSignature },
    }),
  ).toString("base64");

  return fetchImpl(url, {
    ...init,
    headers: { ...headersToRecord(init?.headers as HeaderInput), "X-PAYMENT": xPayment },
  });
}

type HeaderInput = Record<string, string> | Array<[string, string]> | undefined;

function headersToRecord(headers: HeaderInput): Record<string, string> {
  if (headers === undefined) return {};
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}

/**
 * The x402 payment requirements a provider advertises in its `402` response
 * (`accepts[0]`). `rate` is a Avtar extension: the provider's per-unit price in
 * the settlement token's decimal units, which the consumer accepts as the
 * channel rate.
 */
export interface X402Requirements {
  scheme?: string;
  network?: string;
  maxAmountRequired?: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  payTo?: string;
  asset?: string;
  rate?: string;
  maxTimeoutSeconds?: number;
}

/**
 * Discover a provider's x402 payment requirements by making an UNPAID request
 * and reading `accepts[0]` from the `402` response. Returns undefined when the
 * endpoint does not answer with 402 (e.g. it isn't x402-gated). This is how the
 * consumer learns the provider's rate, settlement address and asset before
 * agreeing to open a channel.
 */
export async function discoverX402Requirements(
  url: string,
  fetchImpl: FetchLike = fetch,
): Promise<X402Requirements | undefined> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ probe: true }),
  });
  if (res.status !== 402) {
    await res.json().catch(() => undefined);
    return undefined;
  }
  const body = (await res.json().catch(() => ({}))) as { accepts?: X402Requirements[] };
  return body.accepts?.[0];
}
