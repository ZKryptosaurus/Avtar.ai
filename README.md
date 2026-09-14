# Avtar.ai — Midnight Agent Marketplace

Privacy-preserving agent-to-agent service marketplace built on Midnight blockchain with x402 micropayment protocol.

## Overview

Avtar enables AI agents to sell services (weather, crypto prices, translation) to other agents through metered micropayments. Built for the Midnight Wave 1 Buildathon.

### Key Features

- **Zero-knowledge settlement**: All payments settled through compiled Compact circuit with Schnorr-over-Jubjub signatures
- **Privacy-preserving**: Rate commitments and nullifiers hide transaction details while proving correctness
- **x402 protocol**: HTTP authorization layer for metered API access
- **Local simulation mode**: Full end-to-end testing without live blockchain
- **Atomic units**: All amounts in smallest indivisible units (no decimals)

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         AVTAR.AI SYSTEM                          │
└─────────────────────────────────────────────────────────────────┘

┌──────────────┐                              ┌──────────────┐
│   CONSUMER   │                              │   PROVIDER   │
│    AGENT     │                              │    AGENT     │
└──────┬───────┘                              └──────┬───────┘
       │                                             │
       │  1. Open x402 channel                       │
       ├────────────────────────────────────────────>│
       │     (rate commitment, escrow)               │
       │                                             │
       │  2. Sign voucher (off-chain metering)       │
       │<────────────────────────────────────────────┤
       │     (Poseidon(rate, rateBlind))             │
       │                                             │
       │  3. Call services                           │
       ├────────────────────────────────────────────>│
       │     • get_weather                           │
       │     • get_crypto_price                      │
       │     • translate_text                        │
       │<────────────────────────────────────────────┤
       │  4. Receive responses                       │
       │                                             │
       │  5. Settle with ZK proof                    │
       ├────────────────────────────────────────────>│
       │     (Schnorr signature, nullifier)          │
       └─────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    CHAIN CLIENT (Two Tiers)                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────┐      ┌──────────────────────┐        │
│  │  LOCAL SIMULATION    │      │   LIVE PREPROD       │        │
│  │  MIDNIGHT_LOCAL_SIM  │      │   MIDNIGHT_WALLET    │        │
│  │      =true           │      │   _SEED +            │        │
│  │                      │      │   MIDNIGHT_AVTAR     │        │
│  │  • Compiled circuit  │      │   _ESCROW_ADDRESS    │        │
│  │  • In-memory ledger  │      │                      │        │
│  │  • Real crypto       │      │  • Deployed contract │        │
│  │  • No network        │      │  • Midnight network  │        │
│  │                      │      │  • Transaction sub   │        │
│  └──────────────────────┘      └──────────────────────┘        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                  AVTAR-ESCROW COMPACT CIRCUIT                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Circuits:                                                       │
│  • whitelistToken(token)                                         │
│  • openChannel(channelId, rateCommitment, consumerPubkey, ...)  │
│  • settle(channelId, rate, rateBlind, totalUnits, signature)    │
│  • refund(depositor, token)                                      │
│                                                                  │
│  Privacy Model:                                                  │
│  • Rate commitment: Poseidon(rate, rateBlind)                   │
│  • Nullifier: Poseidon(channelId, channelSecret)                │
│  • Schnorr-over-Jubjub signatures                               │
│  • Channel closure tracking (prevents repeat settlement)        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Component Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        PACKAGES                                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  agent-core          Shared types, chain clients, channel logic  │
│  ├── chain.ts        ChainClient interface                       │
│  ├── live-chain.ts   LiveAvtarEscrowChainClient (Preprod)        │
│  ├── env.ts          Two-tier selection logic                    │
│  └── channel.ts      ServiceChannel, voucher signing             │
│                                                                   │
│  proving-setup       Circuit compilation, witness generation     │
│  └── midnight.ts     Schnorr signatures, Poseidon hashes         │
│                                                                   │
│  onchain-setup       Contract deployment, configuration          │
│  ├── midnight/       avtar-escrow.compact (compiled circuit)     │
│  ├── deploy.mjs      Preprod deployment script                   │
│  └── midnight-*.ts   Network providers, wallet integration       │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                         AGENTS                                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  provider            Service provider with x402 HTTP server      │
│  ├── server.ts       x402 protocol implementation                │
│  ├── weather.ts      get_weather service                         │
│  ├── crypto.ts       get_crypto_price service                    │
│  ├── translation.ts  translate_text service                      │
│  └── payments.ts     Authorization verification                  │
│                                                                   │
│  consumer            Service consumer with settlement            │
│  ├── demo.ts         End-to-end demo (both tiers)                │
│  ├── session.ts      x402 session management                     │
│  └── agent.ts        ServiceAgent with tool calling              │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
CONSUMER                    PROVIDER                   MIDNIGHT
   │                           │                           │
   │  1. Open channel          │                           │
   │  (rate commitment)        │                           │
   ├──────────────────────────>│                           │
   │                           │  2. Validate & accept     │
   │                           ├──────────────────────────>│
   │                           │                           │
   │  3. Request service       │                           │
   │  (X-PAYMENT header)       │                           │
   ├──────────────────────────>│                           │
   │                           │  4. Verify authorization  │
   │                           │  5. Sign voucher          │
   │  6. Return voucher        │                           │
   │<──────────────────────────┤                           │
   │                           │                           │
   │  7. Call service          │                           │
   ├──────────────────────────>│                           │
   │                           │  8. Execute service       │
   │  9. Return result         │                           │
   │<──────────────────────────┤                           │
   │                           │                           │
   │  10. Settle               │                           │
   │  (voucher signature)      │                           │
   ├──────────────────────────────────────────────────────>│
   │                           │                           │
   │                           │  11. Verify & transfer    │
   │                           │<──────────────────────────┤
   │                           │                           │
```

### Privacy Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    ZERO-KNOWLEDGE PRIVACY                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  PUBLIC (on-chain)              PRIVATE (off-chain)              │
│  ─────────────────              ───────────────────              │
│  • Channel ID                   • Agreed rate                    │
│  • Rate commitment              • Rate blind                     │
│  • Consumer pubkey              • Channel secret                 │
│  • Escrow amount                • Consumer private key           │
│  • Nullifier                    • Total units (until settle)     │
│  • Settlement amount                                         │
│                                                                  │
│  VERIFIABLE WITHOUT REVEALING:                                   │
│  ✓ Rate commitment matches agreed rate                          │
│  ✓ Voucher signature is valid                                   │
│  ✓ Nullifier is unique (no double-spend)                        │
│  ✓ Channel not already closed                                   │
│  ✓ Settlement ≤ escrow                                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Components

- **`packages/agent-core`**: Shared types, channel state, voucher signing
- **`packages/proving-setup`**: Midnight circuit compilation and witness generation
- **`agents/provider`**: Service provider with x402 HTTP server
- **`agents/consumer`**: Service consumer with settlement logic

### Privacy Model

- **Rate commitment**: `Poseidon(rate, rateBlind)` — hides agreed rate
- **Nullifier**: `Poseidon(channelId, channelSecret)` — prevents double-spending
- **Schnorr signatures**: Prove voucher authenticity without revealing keys
- **Compiled circuit**: `avtar-escrow.compact` enforces all constraints

## Quick Start

Run all commands from the repository root (`Avtar.ai`). Use Node.js 25.8.1
(the version tested here), pnpm, and the Midnight Compact compiler. Live Preprod
also requires Docker, a funded depositor wallet, and a deployed contract.

### Build

```bash
pnpm install
pnpm --filter @avtar/onchain-setup compact:build
pnpm build
```

For an already installed and compiled checkout, run only `pnpm build`.

### Live Preprod HTTP Demo

This flow opens and settles a channel on the public Preprod testnet. Only contract
proving runs locally. The provider receives payment at its configured address;
unused escrow returns to the depositor. They can be different wallets.

**1. Configure the shared environment.** Both HTTP servers load the repository-root
`.env`, then `packages/onchain-setup/.env` for missing values. Shell variables take
precedence. Keep the existing configured file; on a fresh checkout, copy
`packages/onchain-setup/.example.env` to `packages/onchain-setup/.env` and fill in:

```dotenv
MIDNIGHT_NETWORK_ID=preprod
MIDNIGHT_LOCAL_SIM=false
MIDNIGHT_INDEXER_URL=https://api-preprod.1am.xyz/api/v4/graphql
MIDNIGHT_INDEXER_WS_URL=wss://api-preprod.1am.xyz/api/v4/graphql/ws
MIDNIGHT_NODE_URL=https://api-preprod.1am.xyz/rpc/midnight
MIDNIGHT_PROOF_SERVER_URL=http://127.0.0.1:6300
MIDNIGHT_FEE_SPONSOR_URL=https://api-preprod.1am.xyz
MIDNIGHT_WALLET_SEED=<depositor wallet seed or mnemonic>
MIDNIGHT_AVTAR_ESCROW_ADDRESS=<deployed contract address>
MIDNIGHT_DEPOSITOR_ADDRESS=<depositor's 64-character hex address payload>
MIDNIGHT_PROVIDER_ADDRESS=<provider's 64-character hex address payload>
MIDNIGHT_TOKEN_ADDRESS=<64-character tNIGHT token type>
MIDNIGHT_RATE_ATOMIC=100
```

Address settings take decoded 32-byte hexadecimal payloads, not `mn_addr_preprod…`
strings. The depositor must match the funding wallet. The provider needs only a
public receiving address. Keep wallet seeds private and never commit `.env`.
1AM authentication signs a wallet challenge automatically; no 1AM API key is needed.
See [deployment and wallet setup](packages/onchain-setup/midnight/README.md) if you
still need to deploy. An existing deployment does not need redeploying to change
the provider for new channels.

**2. Start the local proof server.** For the existing container:

```bash
docker start avtar-midnight-proof-server
```

On a fresh checkout, create it once instead:

```bash
docker run -d --name avtar-midnight-proof-server -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:8.1.0
```

**3. Terminal 1 — start the provider:**

```bash
MIDNIGHT_LOCAL_SIM=false MIDNIGHT_RATE_ATOMIC=100 pnpm --filter @avtar/agent-provider serve
```

It listens on `http://localhost:4021` and advertises `midnight:preprod`.

**4. Terminal 2 — start the consumer:**

```bash
OPENAI_API_KEY= MIDNIGHT_LOCAL_SIM=false MIDNIGHT_RATE_ATOMIC=100 MIDNIGHT_ESCROW_ATOMIC=1000 \
pnpm --filter @avtar/agent-consumer serve
```

Startup funds a channel with **1,000 atomic tNIGHT**. Wait until it prints
`listening on http://localhost:4022`; wallet sync, proving, and confirmation take
time. An empty OpenAI key selects the built-in demo agent; service APIs still
require internet access. Starting the server does not run tool calls or settle.

**5. Terminal 3 — call the services:**

```bash
curl -sS http://localhost:4022/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What is the weather in Tokyo, the price of ETH in USD, and translate good morning into Japanese?"}'
```

**6. Settle the channel:**

```bash
curl -sS -X POST http://localhost:4022/settle
```

Three successful calls at 100 atomic units each pay **300 atomic tNIGHT** to the
provider and refund **700** to the depositor. The settlement response includes the
confirmed transaction ID. Actual service results depend on the external APIs.

If 1AM reports `429` or a pending sponsorship transaction, keep the consumer
running, wait 60 seconds, and retry only `/settle`. Do not open another channel to
retry settlement. If the process has exited, retain its metering database and use
the [settlement recovery command](packages/onchain-setup/midnight/README.md).
Restart both servers after changing their environment settings.

### Local Simulation

For a single-process demo using the compiled circuit and an in-memory ledger:

```bash
OPENAI_API_KEY= MIDNIGHT_LOCAL_SIM=true pnpm --filter @avtar/agent-consumer demo
```

This runs the provider tools in-process; it does not start the HTTP servers. It
needs no wallet or blockchain connection, but the service APIs use the internet.

## Testing

Run the contract and wallet adapter checks after building:

```bash
pnpm --filter @avtar/onchain-setup test
```

For the live HTTP demo with your configured provider, use the steps above.
`pnpm --filter @avtar/onchain-setup midnight:live-check` is a separate funded
Preprod integration check: it deliberately overrides the provider to the depositor's
own address and therefore does not test payment to your separate provider wallet.

## Buildathon Submission

**Wave 1**: August 29 – September 16, 2026  
**Grant Pool**: 3,500 USDT  
**Track**: Privacy-enhanced Midnight ZK application

### Judging Criteria (from Akindo listing)

- **Engineering & Implementation** (emphasis): Clean architecture, working code
- **Quality Assurance & Reliability** (emphasis): End-to-end verification, error handling
- **Innovation**: Novel use of ZK proofs for agent micropayments
- **Privacy**: Rate commitments and nullifiers hide transaction details

### Deliverables

- [x] Working application with local simulation mode
- [x] Compiled Midnight circuit (`avtar-escrow.compact`)
- [x] End-to-end test (provider → consumer → settlement)
- [x] Documentation (this README)
- [ ] Demo video (3-5 min)
- [ ] Slide deck (~10 slides)

## Technical Details

### Why Midnight?

Midnight's Compact language enables privacy-preserving smart contracts with:
- **Schnorr-over-Jubjub signatures**: Efficient ZK-friendly signatures
- **Poseidon hash function**: ZK-optimized commitment scheme
- **Compiled circuits**: Enforce constraints at settlement time
- **Local simulation**: Full testing without live blockchain

### Why x402?

x402 is an HTTP authorization protocol for metered API access:
- **Standard HTTP**: Works with existing web infrastructure
- **Metered access**: Pay per call, not subscription
- **Authorization-only**: Settlement happens off-chain with ZK proofs
- **Agent-friendly**: Designed for machine-to-machine payments

### Atomic Units

All amounts use atomic units (smallest indivisible unit):
- No decimal places (unlike Stellar's 7-decimal XLM)
- Simplified arithmetic (BigInt, not parseUnits)
- 32-byte addresses (not Stellar's 56-char accounts)
- Rate = 100 atomic units, not 0.0000100 tokens

## Project Structure

```
Avtar.ai/
├── packages/
│   ├── agent-core/          # Shared types and utilities
│   │   ├── src/
│   │   │   ├── channel.ts   # Channel state management
│   │   │   ├── voucher.ts   # Voucher signing and verification
│   │   │   └── env.ts       # Environment variable parsing
│   │   └── package.json
│   └── proving-setup/       # Midnight circuit compilation
│       ├── src/
│       │   └── midnight.ts  # Circuit witness generation
│       └── circuits/
│           └── avtar-escrow.compact
├── agents/
│   ├── provider/            # Service provider
│   │   ├── src/
│   │   │   ├── server.ts    # x402 HTTP server
│   │   │   ├── weather.ts   # Weather service (mock)
│   │   │   ├── crypto.ts    # Crypto price service (mock)
│   │   │   ├── translation.ts # Translation service (mock)
│   │   │   ├── payments.ts  # Authorization verification
│   │   │   └── config.ts    # Provider configuration
│   │   └── package.json
│   └── consumer/            # Service consumer
│       ├── src/
│       │   ├── session.ts   # x402 session management
│       │   ├── demo.ts      # End-to-end demo
│       │   └── x402-demo.ts # x402 protocol demo
│       └── package.json
└── docs/
    └── midnight-buildathon-plan.md
```

## Porting Notes

This project was ported from Stellar/Soroban to Midnight. Key differences:

| Feature | Stellar/Soroban | Midnight |
|---------|----------------|----------|
| Signatures | Ed25519 | Schnorr-over-Jubjub |
| Hash function | SHA-256 | Poseidon |
| Address format | 56-char base32 | 32-byte hex (0x...) |
| Decimal places | 7 (stroops) | 0 (atomic units) |
| Proof system | Groth16 | Compiled circuit |
| Test mode | Mock fallback | Local simulation required |

All legacy terminology (Stellar, Soroban, Drongo, Slate, XLM) has been removed.

## License

[Apache License 2.0](LICENSE)

## Links

- **Buildathon**: [Akindo Wave 1](https://app.akindo.io/wave-hacks/jaMZjqPOBsLXvjdG)
- **Midnight**: [midnight.network](https://midnight.network)
- **x402 Protocol**: [x402.org](https://x402.org)
