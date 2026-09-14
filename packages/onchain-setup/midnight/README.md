Deploy `avtar-escrow` to Midnight's public Preprod testnet with a local proof server.

From `packages/onchain-setup`:

```sh
docker run -d --name avtar-midnight-proof-server -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:8.1.0
pnpm compact:build
pnpm --filter @avtar/proving-setup build
pnpm build
pnpm test
pnpm midnight:deploy
```

Use `.example.env` for the network settings in `.env`. Set `MIDNIGHT_WALLET_SEED`
to a valid BIP-39 mnemonic or a 32/64-byte hex seed. Mnemonics use the full BIP-39
seed and Midnight account 0, key index 0. Never commit the seed.

The 1AM indexer is also supported: use `https://api-preprod.1am.xyz/api/v4/graphql`
and `wss://api-preprod.1am.xyz/api/v4/graphql/ws`. The script signs 1AM's login
challenge locally and attaches a session token; an API key is not required.

To use the successfully tested deployment route, also set
`MIDNIGHT_FEE_SPONSOR_URL=https://api-preprod.1am.xyz`. Contract proving uses the
local proof server, while 1AM adds its own DUST fee payment. The returned transaction
must preserve the deployment identifier. This avoids waiting for a full wallet
history sync. Omit this setting to use your wallet's own DUST with all proving local.

The script prints the wallet address, waits for sync, and registers funded tNIGHT
for DUST generation when needed. Fund that address using the
[Preprod faucet](https://faucet.preprod.midnight.network/).
Initial sync can take several minutes; the timeout is 15 minutes. Wallet snapshots
are saved on completion or failure under `.midnight/` so subsequent runs can resume.
Run `node check-wallet.mjs` for a read-only balance and sync check.

After confirmation, copy the printed address into `MIDNIGHT_AVTAR_ESCROW_ADDRESS`.
The public receipt is saved in `.midnight/preprod/deployment.json`; encrypted
deployment signing keys are stored alongside it. Keep `.midnight/` and the seed.
The storage password is derived from the seed unless `MIDNIGHT_PRIVATE_STATE_PASSWORD`
is set; keep using the same password if you override it.

The wallet adapter implements `getCoinPublicKey`, `getEncryptionPublicKey`,
`balanceTx` (balance → sign → finalize), and `submitTx`. The workspace pins the
ledger/runtime versions used by `midnight-js` 4.1.1 to avoid duplicate WASM types.

Live application settlement uses `connectAvtarEscrow` and the same compiled keys.
The client checks the deployed verifier keys before making calls, proves locally,
balances the wallet's unshielded tokens, submits through HTTP, and waits for
indexer confirmation. For the tested 1AM route, set:

```sh
MIDNIGHT_NODE_URL=https://api-preprod.1am.xyz/rpc/midnight
MIDNIGHT_FEE_SPONSOR_URL=https://api-preprod.1am.xyz
MIDNIGHT_LOCAL_SIM=false
MIDNIGHT_DEPOSITOR_ADDRESS=<funding wallet's 64-character unshielded address payload>
MIDNIGHT_PROVIDER_ADDRESS=<recipient's 64-character unshielded address payload>
MIDNIGHT_TOKEN_ADDRESS=<64-character unshielded token type>
```

The provider and consumer load the root `.env`, then use this package's `.env`
for missing settings. Set `MIDNIGHT_LOCAL_SIM=true` explicitly to use simulation;
this takes precedence even when wallet credentials exist. Live mode never invents
addresses or transaction IDs.

After building the whole workspace, start the provider and consumer with their
`serve` scripts. Send a message to `POST /chat` on the consumer, then `POST /settle`.
The provider advertises the configured network. Local simulation and live providers
cannot be mixed in one session. A new session settles the previous escrow first;
zero-usage sessions use a signed zero-unit voucher to refund their deposit.

`pnpm midnight:live-check` is an opt-in integration check against the latest local
Preprod deployment receipt. It escrows 1,000 atomic tNIGHT, calls the three real
service APIs, and settles 300 atomic units. Both payment and refund go to the same
owned wallet. It uses 1AM-sponsored DUST and saves the public result in
`.midnight/preprod/live-check.json`. It requires the agent packages to be built.
Sponsor rate limits are reported as errors; no simulated success is returned.

If sponsorship is temporarily held after channel funding, keep the metering
SQLite database. Resume the existing voucher without opening another escrow:

```sh
node midnight/recover-settlement.mjs /path/to/meter.db [channel-id]
```

Recovery retries rate-limited sponsorship at 60-second intervals (at most six
attempts), then verifies the channel is closed on-chain. A still-active hold is
reported as a failure with the database retained. The old deployment is not
upgraded automatically: compile, deploy, and set the newly confirmed address.
