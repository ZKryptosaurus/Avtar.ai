import type { Service } from "@avtar/agent-core";
import type { HttpClient } from "./http.js";

export interface TranslateRequest {
  /** Text to translate (MyMemory caps a single call at 500 bytes). */
  text: string;
  /** Source language (ISO 639-1), e.g. "en". Defaults to "en". */
  from?: string;
  /** Target language (ISO 639-1), e.g. "fr". */
  to: string;
}

export interface TranslateResult {
  from: string;
  to: string;
  sourceText: string;
  translatedText: string;
  /** Match quality 0..1 for the best candidate, when available. */
  match?: number;
}

/**
 * A real metered translation service backed by the **keyless** MyMemory API
 * (`/get`, no signup — anonymous fair-use quota). One unit per call.
 *
 * The HTTP client is injected so tests run offline with canned responses;
 * production uses {@link FetchHttpClient}. It demonstrates one agent buying
 * real AI work from another, per call.
 */
export class TranslationService implements Service<TranslateRequest, TranslateResult> {
  readonly name = "mymemory-translation";

  constructor(
    private readonly http: HttpClient,
    private readonly unitsPerCall: bigint = 1n,
  ) {
    if (unitsPerCall <= 0n) throw new Error("unitsPerCall must be positive");
  }

  price(_req: TranslateRequest): bigint {
    return this.unitsPerCall;
  }

  async handle(req: TranslateRequest): Promise<TranslateResult> {
    const text = req.text.trim();
    const from = (req.from ?? "en").trim().toLowerCase();
    const to = req.to.trim().toLowerCase();
    if (!text) throw new Error("text is required");
    if (!to) throw new Error("target language (to) is required");

    const url =
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}` +
      `&langpair=${encodeURIComponent(from)}|${encodeURIComponent(to)}`;
    const data = await this.http.getJson(url);

    const translated = data?.responseData?.translatedText;
    if (typeof translated !== "string" || translated.length === 0) {
      throw new Error(`translation failed: ${data?.responseDetails ?? "unknown error"}`);
    }

    const match = data?.responseData?.match;
    return {
      from,
      to,
      sourceText: text,
      translatedText: translated,
      match: typeof match === "number" ? match : undefined,
    };
  }
}
