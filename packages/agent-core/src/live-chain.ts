import { connectAvtarEscrow, midnightConfigFromEnv, type MidnightConfig } from '@avtar/onchain-setup';
import type { ChainClient, OpenChannelArgs, SettleArgs } from './chain.js';

/** Uses the SDK to prove, balance, submit and confirm real testnet calls. */
export class LiveAvtarEscrowChainClient implements ChainClient {
  #connection: ReturnType<typeof connectAvtarEscrow> | undefined;
  constructor(private readonly config: MidnightConfig = midnightConfigFromEnv(), private readonly sponsorUrl?: string) {}

  #connect() {
    return this.#connection ??= connectAvtarEscrow(this.config, this.sponsorUrl).catch(error => {
      this.#connection = undefined;
      throw error;
    });
  }

  async openChannel(args: OpenChannelArgs): Promise<{ channelId: string; openTx: string }> {
    const client = await this.#connect();
    if (!Buffer.from(args.depositor).equals(client.depositorPayload)) throw new Error('MIDNIGHT_DEPOSITOR_ADDRESS must match the funding wallet');
    const state = await client.readLedger();
    if (!state.whitelistedTokens.member(args.token)) await client.callTx.whitelistToken(args.token);
    const tx = await client.callTx.openChannel(args.channelId, args.rateCommitment,
      args.consumerPublicKey.x, args.consumerPublicKey.y, args.depositor, args.provider, args.token, args.escrow);
    return { channelId: args.channelId.toString(), openTx: tx.public.txId };
  }

  async settle(args: SettleArgs): Promise<{ settleTx: string }> {
    const client = await this.#connect();
    const s = args.signature;
    const tx = await client.callTx.settle(args.channelId, args.rate, args.rateBlind, args.totalUnits,
      args.channelSecret, s.sigRx, s.sigRy, s.sigRemainder, s.sigQuotient, s.sigS,
      args.escrowAmount, args.depositor, args.provider, args.token);
    return { settleTx: tx.public.txId };
  }

  async close(): Promise<void> {
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection) await (await connection).close();
  }
}
