import type { Service } from "@avtar/agent-core";
import type { HttpClient } from "./http.js";

export interface CryptoPriceRequest {
  /** CoinGecko coin id, e.g. "bitcoin" or "ethereum". */
  coin: string;
  /** Quote currency, e.g. "usd", "eur". Defaults to "usd". */
  vs?: string;
}

export interface CryptoPriceResult {
  coin: string;
  vs: string;
  price: number;
  /** 24h price change in percent, when available. */
  change24hPct?: number;
}

/**
 * A real metered crypto spot-price service backed by the **keyless** CoinGecko
 * public API (`/simple/price`). One unit per call.
 *
 * The HTTP client is injected so tests run offline with canned responses;
 * production uses {@link FetchHttpClient}. Pricing usage remains private to the
 * metered channel.
 */
export class CryptoPriceService implements Service<CryptoPriceRequest, CryptoPriceResult> {
  readonly name = "coingecko-crypto-price";

  constructor(
    private readonly http: HttpClient,
    private readonly unitsPerCall: bigint = 1n,
  ) {
    if (unitsPerCall <= 0n) throw new Error("unitsPerCall must be positive");
  }

  price(_req: CryptoPriceRequest): bigint {
    return this.unitsPerCall;
  }

  async handle(req: CryptoPriceRequest): Promise<CryptoPriceResult> {
    const coin = req.coin.trim().toLowerCase();
    const vs = (req.vs ?? "usd").trim().toLowerCase();
    if (!coin) throw new Error("coin is required");

    const url =
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coin)}` +
      `&vs_currencies=${encodeURIComponent(vs)}&include_24hr_change=true`;
    const data = await this.http.getJson(url);

    const row = data?.[coin];
    if (!row || row[vs] === undefined) {
      throw new Error(`price not found for ${coin} in ${vs}`);
    }

    const change = row[`${vs}_24h_change`];
    return {
      coin,
      vs,
      price: Number(row[vs]),
      change24hPct: change === undefined ? undefined : Number(change),
    };
  }
}
