// Resume a funded channel from its persisted voucher; never opens another escrow.
import assert from 'node:assert/strict';
import { config as dotenv } from 'dotenv';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MeterDb } from '../../agent-core/dist/db.js';
import { realChainFromEnv, settlementFromSnapshot, addressToPayload } from '../../agent-core/dist/index.js';
import { connectAvtarEscrow } from '../dist/midnight-live.js';
import { midnightConfigFromEnv } from '../dist/midnight-config.js';
const packageDir=fileURLToPath(new URL('../',import.meta.url));
dotenv({path:join(packageDir,'.env')});
const path=process.argv[2];
assert(path,'Usage: node midnight/recover-settlement.mjs <meter.db> [channel-id]');
const db=new MeterDb(path);
const rows=db.loadChannels();
const snapshot=process.argv[3] ? rows.find(s=>s.terms.channelId===BigInt(process.argv[3])) : rows.length===1 ? rows[0] : undefined;
db.close();assert(snapshot,'Select exactly one persisted channel');
const setup=realChainFromEnv();assert(setup && setup.network!=='midnight:local-sim','Live network configuration required');
const before=await connectAvtarEscrow(midnightConfigFromEnv(),process.env.MIDNIGHT_FEE_SPONSOR_URL);
let closed;
try {closed=(await before.readLedger()).channels.lookup(snapshot.terms.channelId).closed;}
finally {await before.close();}
if(closed){console.log('Channel is already closed on-chain; no transaction submitted.');process.exit(0);}
const settlement=settlementFromSnapshot(snapshot);
let result;
try {
  for(let attempt=0;attempt<6;attempt++) {
    try {
      result=await setup.chain.settle({...settlement,
        depositor:addressToPayload(snapshot.terms.depositorPayload),provider:addressToPayload(snapshot.terms.providerPayload),token:addressToPayload(snapshot.terms.tokenPayload)});
      break;
    } catch(error) {
      if(!String(error).includes('HTTP 429') || attempt===5) throw error;
      console.log('Sponsor hold still active; preserving the same channel and waiting 60 seconds.');
      await delay(60_000);
    }
  }
} finally {await setup.chain.close?.();}
assert(result);assert.match(result.settleTx,/^[0-9a-f]{64}$/);
const verification=await connectAvtarEscrow(midnightConfigFromEnv(),process.env.MIDNIGHT_FEE_SPONSOR_URL);
try {assert.equal((await verification.readLedger()).channels.lookup(snapshot.terms.channelId).closed,true);}
finally{await verification.close();}
const receipt={network:process.env.MIDNIGHT_NETWORK_ID,contractAddress:process.env.MIDNIGHT_AVTAR_ESCROW_ADDRESS,
  channelId:snapshot.terms.channelId.toString(),openTx:snapshot.openTx,settleTx:result.settleTx,
  escrow:snapshot.terms.escrow.toString(),settlementAmount:(settlement.rate*settlement.totalUnits).toString(),calls:Number(settlement.totalUnits),recoveryDatabase:path};
writeFileSync(join(packageDir,'.midnight/preprod/live-check.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log('Confirmed settlement and closed channel:',JSON.stringify(receipt));
