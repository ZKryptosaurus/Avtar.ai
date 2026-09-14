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
