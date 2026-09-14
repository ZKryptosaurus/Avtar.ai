/** Minimal injectable HTTP client so provider services are testable offline. */
export interface HttpClient {
  getJson(url: string): Promise<any>;
}

/** Real HTTP client using the global fetch (Node 20+). Runs on the provider's server. */
export class FetchHttpClient implements HttpClient {
  async getJson(url: string): Promise<any> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
}
