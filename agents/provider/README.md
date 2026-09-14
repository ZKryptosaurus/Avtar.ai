# @avtar/agent-provider

The provider exposes weather, crypto-price, and translation tools over HTTP. A consumer opens a metered channel through an x402-style `402 → X-PAYMENT → open` authorization exchange, sends a signed cumulative voucher with each tool call, and settles through Avtar's Midnight local simulation.

## Run

```bash
MIDNIGHT_LOCAL_SIM=true pnpm --filter @avtar/agent-provider serve
```

The provider listens on port `4021` by default and publishes an agent card at `/.well-known/agent-card.json`.

## Configuration

- `AVTAR_PROVIDER_PORT` — HTTP port, default `4021`
- `MIDNIGHT_PROVIDER_ADDRESS` — provider 32-byte hexadecimal payload
- `MIDNIGHT_TOKEN_ADDRESS` — settlement-token 32-byte hexadecimal payload
- `MIDNIGHT_RATE_ATOMIC` — private rate per metered unit, default `100`
- `MIDNIGHT_X402_MAX_AMOUNT_ATOMIC` — advertised channel limit, default `10000`

The supported mode is `midnight:local-sim`. The authorization header only opens the HTTP metering channel; the consumer executes final settlement through the compiled `avtar-escrow` circuit.
