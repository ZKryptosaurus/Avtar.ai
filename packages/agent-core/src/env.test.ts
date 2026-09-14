import assert from 'node:assert/strict';
import { test } from 'node:test';
import { midnightSettlementNetwork, realChainFromEnv } from './env.js';
import { LocalAvtarEscrowChainClient } from './chain.js';

test('explicit local simulation wins over live credentials; live addresses are required', async () => {
  const simulated = realChainFromEnv({ MIDNIGHT_LOCAL_SIM: 'true', MIDNIGHT_WALLET_SEED: 'unused', MIDNIGHT_AVTAR_ESCROW_ADDRESS: 'unused' });
  assert(simulated?.chain instanceof LocalAvtarEscrowChainClient);
  assert.equal(simulated.network, 'midnight:local-sim');
  assert.equal(realChainFromEnv({}), null);
  assert.equal(midnightSettlementNetwork({ MIDNIGHT_NETWORK_ID: 'preprod' }), 'midnight:preprod');
  assert.throws(() => midnightSettlementNetwork({ MIDNIGHT_NETWORK_ID: 'mainnet' }), /Preprod or Preview/);
  assert.throws(() => realChainFromEnv({ MIDNIGHT_WALLET_SEED: 'unused' }), /ESCROW_ADDRESS/);
  assert.throws(() => realChainFromEnv({ MIDNIGHT_WALLET_SEED: 'unused', MIDNIGHT_AVTAR_ESCROW_ADDRESS: 'unused' }), /DEPOSITOR_ADDRESS/);
});
