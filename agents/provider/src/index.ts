// @avtar/agent-provider — metered provider services sold per call through the
// @avtar/agent-core channel. Consumers buy these via signed vouchers and settle
// once with a ZK proof. Each service is keyless (no API key) so it runs offline
// in tests (injectable HttpClient) and live without secrets.
//
// It also exposes an x402 HTTP resource server (createProviderServer): the
// provider is the thing exposing the endpoint, so the server lives here. See
// serve.ts for the runnable entrypoint (`pnpm --filter @avtar/agent-provider serve`).

export * from "./http.js";
export * from "./weather.js";
export * from "./crypto.js";
export * from "./translation.js";
export * from "./tools.js";

export * from "./config.js";
export * from "./x402.js";
export * from "./payments.js";
export * from "./channels.js";
export * from "./server.js";
