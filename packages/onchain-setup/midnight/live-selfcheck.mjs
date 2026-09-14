// Opt-in Preprod integration check: small tNIGHT escrow, paid back to the same
// owned wallet. Uses 1AM only for DUST, local proving, and real HTTP tool calls.
import assert from 'node:assert/strict';
import { config as dotenv } from 'dotenv';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { createKeystore } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { parseWalletSeed } from '../dist/midnight-wallet.js';
import { connectAvtarEscrow } from '../dist/midnight-live.js';
import { midnightConfigFromEnv } from '../dist/midnight-config.js';
import { MeterDb } from '../../agent-core/dist/db.js';
import { createProviderServer } from '../../../agents/provider/dist/server.js';
import { readProviderServerConfig } from '../../../agents/provider/dist/config.js';
import { buildToolbox } from '../../../agents/provider/dist/tools.js';
import { FetchHttpClient } from '../../../agents/provider/dist/http.js';
import { AgentSession } from '../../../agents/consumer/dist/session.js';
import { createConsumerServer } from '../../../agents/consumer/dist/server.js';
import { readConsumerServerConfig } from '../../../agents/consumer/dist/config.js';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
dotenv({ path: join(packageDir, '.env') });
assert.equal(process.env.MIDNIGHT_NETWORK_ID, 'preprod');
process.env.MIDNIGHT_LOCAL_SIM = 'false';
process.env.OPENAI_API_KEY = '';
process.env.MIDNIGHT_FEE_SPONSOR_URL = 'https://api-preprod.1am.xyz';
process.env.MIDNIGHT_AVTAR_ESCROW_ADDRESS = JSON.parse(readFileSync(join(packageDir,'.midnight/preprod/deployment.json'),'utf8')).contractAddress;
const root = HDWallet.fromSeed(parseWalletSeed(process.env.MIDNIGHT_WALLET_SEED));
assert.equal(root.type,'seedOk');
const keys = root.hdWallet.selectAccount(0).selectRoles([Roles.NightExternal]).deriveKeysAt(0);
root.hdWallet.clear();
assert.equal(keys.type,'keysDerived');
const owner = createKeystore(keys.keys[Roles.NightExternal], 'preprod').getAddress();
process.env.MIDNIGHT_DEPOSITOR_ADDRESS = owner;
process.env.MIDNIGHT_PROVIDER_ADDRESS = owner;
process.env.MIDNIGHT_TOKEN_ADDRESS = unshieldedToken().raw;
process.env.MIDNIGHT_RATE_ATOMIC = '100';
process.env.MIDNIGHT_ESCROW_ATOMIC = '1000';
process.env.METER_DB_PATH = join(mkdtempSync(join(packageDir,'.midnight/preprod/check-')), 'meter.db');
console.log('Preprod check: 1,000 atomic tNIGHT escrow; provider and refund recipient are the same owned wallet.');
console.log('Recovery database:', process.env.METER_DB_PATH);
const config = readProviderServerConfig();
const provider = await listen(createProviderServer({config,toolbox:buildToolbox(new FetchHttpClient())}));
const consumerConfig = readConsumerServerConfig({...process.env, AVTAR_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}`});
const session = new AgentSession(consumerConfig);
let consumer;
try {
  console.log('Opening funded channel on Preprod...');
  await session.initialize();
  consumer = await listen(createConsumerServer({config:consumerConfig,session}));
  const base = `http://127.0.0.1:${consumer.address().port}`;
  const result = await fetch(base+'/chat',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({message:'Weather in Tokyo, ETH price in USD, translate "good morning" into Japanese'})}).then(r=>r.json());
  assert.equal(result.ok,true);
  assert.equal(result.calls.filter(c=>c.served).length,3);
  console.log('Three real service calls completed; settling on Preprod...');
  let settled;
  for (let attempt=0;attempt<6;attempt++) {
    settled = await fetch(base+'/settle',{method:'POST'}).then(r=>r.json());
    if (settled.settled || !settled.reason?.includes('HTTP 429') || attempt===5) break;
    console.log('Sponsor hold active; waiting 60 seconds before retrying the same voucher.');
    await delay(60_000);
  }
  assert.equal(settled.settled,true,settled.reason);
  assert.match(settled.settleTx,/^[0-9a-f]{64}$/);
  assert.equal(settled.settlementAmount,'300');
  const db = new MeterDb(process.env.METER_DB_PATH);
  const snapshot = db.loadChannels()[0];
  db.close();
  assert.match(snapshot.openTx,/^[0-9a-f]{64}$/);
  const verified = await connectAvtarEscrow(midnightConfigFromEnv(), process.env.MIDNIGHT_FEE_SPONSOR_URL);
  try { assert.equal((await verified.readLedger()).channels.lookup(snapshot.terms.channelId).closed, true); }
  finally { await verified.close(); }
  const receipt = {openTx:snapshot.openTx,channelId:snapshot.terms.channelId.toString(),network:'preprod' ,contractAddress:process.env.MIDNIGHT_AVTAR_ESCROW_ADDRESS,
    settleTx:settled.settleTx,escrow:'1000',settlementAmount:'300',calls:3,recoveryDatabase:process.env.METER_DB_PATH};
  writeFileSync(join(packageDir,'.midnight/preprod/live-check.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
  console.log('PASS:',JSON.stringify(receipt));
} finally {
  // Keep channel recovery data even when an API call fails after escrow funding.
  if(session.ready) await session.shutdown();
  for(const server of [consumer,provider].filter(Boolean)) {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
}
function listen(app) {return new Promise((resolve,reject)=>{
  const server=app.listen(0,'127.0.0.1',()=>resolve(server));server.on('error',reject);
});}
