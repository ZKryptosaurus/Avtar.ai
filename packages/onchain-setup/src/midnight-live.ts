import { CompiledContract, type Contract as CompactContract } from '@midnight-ntwrk/compact-js';
import { submitCallTx, verifyContractState } from '@midnight-ntwrk/midnight-js-contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { firstValueFrom, from, timeout } from 'rxjs';
import { Contract, ledger } from '../midnight/contracts/avtar-escrow/managed/contract/index.js';
import { assertMidnightConfig, type MidnightConfig } from './midnight-config.js';
import { buildMidnightNetworkProviders, DEFAULT_MANAGED_CONTRACT_DIR, type AvtarEscrowCircuitId } from './midnight-providers.js';
import { buildMidnightWallet, createWalletAndMidnightProvider, parseWalletSeed, waitForWalletState, withSponsoredFees } from './midnight-wallet.js';

/** Connect to a matching deployed contract; every call waits for chain confirmation. */
export async function connectAvtarEscrow(config: MidnightConfig, sponsorUrl?: string) {
  assertMidnightConfig(config);
  if (config.networkId !== 'preprod' && config.networkId !== 'preview') throw new Error('Live client requires Preprod or Preview');
  if (sponsorUrl && sponsorUrl !== new URL(config.indexerUrl).origin) throw new Error('Fee sponsor must match the 1AM indexer origin');
  setNetworkId(config.networkId);
  const ctx = await buildMidnightWallet(config, parseWalletSeed(config.walletSeed));
  try {
    const network = buildMidnightNetworkProviders(config);
    const contractState = await network.publicDataProvider.queryContractState(config.contractAddress);
    if (!contractState) throw new Error('Deployed contract not found');
    const circuitIds: AvtarEscrowCircuitId[] = ['whitelistToken', 'openChannel', 'settle', 'refund'];
    verifyContractState(await Promise.all(circuitIds.map(async id => [id, await network.zkConfigProvider.getVerifierKey(id)] as [AvtarEscrowCircuitId, Awaited<ReturnType<typeof network.zkConfigProvider.getVerifierKey>>])), contractState);
    let state;
    if (sponsorUrl) {
      // This contract transfers unshielded tokens only. The sponsor supplies DUST.
      await ctx.wallet.unshielded.start();
      await firstValueFrom(from(ctx.wallet.unshielded.waitForSyncedState()).pipe(timeout(120_000)));
      state = await firstValueFrom(ctx.wallet.state());
    } else {
      await ctx.wallet.start(ctx.shieldedSecretKeys, ctx.dustSecretKey);
      state = await waitForWalletState(ctx.wallet);
    }
    let walletProvider = createWalletAndMidnightProvider(ctx, state);
    if (sponsorUrl) {
      const sponsored = withSponsoredFees(walletProvider, sponsorUrl, new URL(config.indexerUrl).searchParams.get('session_token') ?? '');
      walletProvider = {
        ...walletProvider,
        async balanceTx(tx, ttl) {
          const balanced = await ctx.wallet.unshielded.balanceUnboundTransaction(tx) ?? tx;
          try {
            const signed = await ctx.wallet.unshielded.signUnboundTransaction(balanced, data => ctx.unshieldedKeystore.signData(data));
            return await sponsored.balanceTx(signed, ttl);
          } catch (error) {
            await ctx.wallet.unshielded.revertTransaction(balanced);
            throw error;
          }
        },
      };
    }
    const providers = { ...network, walletProvider, midnightProvider: walletProvider };
    const compiledContract = CompiledContract.make('avtar-escrow', Contract).pipe(
      CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets(DEFAULT_MANAGED_CONTRACT_DIR));
    const options = { compiledContract, contractAddress: config.contractAddress };
    const callTx = {
      whitelistToken: (...args: CompactContract.CircuitParameters<Contract<undefined>, 'whitelistToken'>) => submitCallTx<Contract<undefined>, AvtarEscrowCircuitId>(providers, { ...options, circuitId: 'whitelistToken', args }),
      openChannel: (...args: CompactContract.CircuitParameters<Contract<undefined>, 'openChannel'>) => submitCallTx<Contract<undefined>, AvtarEscrowCircuitId>(providers, { ...options, circuitId: 'openChannel', args }),
      settle: (...args: CompactContract.CircuitParameters<Contract<undefined>, 'settle'>) => submitCallTx<Contract<undefined>, AvtarEscrowCircuitId>(providers, { ...options, circuitId: 'settle', args }),
      refund: (...args: CompactContract.CircuitParameters<Contract<undefined>, 'refund'>) => submitCallTx<Contract<undefined>, AvtarEscrowCircuitId>(providers, { ...options, circuitId: 'refund', args }),
    };
    return {
      callTx,
      depositorPayload: Uint8Array.from(Buffer.from(ctx.unshieldedKeystore.getAddress(), 'hex')),
      async readLedger() {
        const current = await network.publicDataProvider.queryContractState(config.contractAddress);
        if (!current) throw new Error('Deployed contract not found');
        return ledger(current.data);
      },
      async close() {
        try { await ctx.saveState(); } finally { await ctx.wallet.stop(); }
      },
    };
  } catch (error) {
    await ctx.wallet.stop();
    throw error;
  }
}
