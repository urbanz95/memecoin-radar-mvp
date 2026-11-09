import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { buildRadarSnapshot } from '../src/radar.mjs';
import { applyRadarRollups,pruneRadarRollups,readRadarRollups } from '../src/radar-time-aggregation.mjs';
import { Scanner } from '../src/scanner.mjs';
import { loadConfig } from '../src/config.mjs';

let seq = 0;
const ts = n => new Date(n).toISOString();
function notification({ at, mint='mint-sample', protocol='pump_fun',
  eventType='TOKEN_BOUGHT', signature=null }={}) {
  const idNum=++seq;
  const sig=signature??('fixture-signature-'+idNum);
  const logs=['Program log: synthetic-event-'+idNum];
  const hash=createHash('sha256').update(JSON.stringify(logs)).digest('hex');
  return {
    notification:{
      signature:sig,slot:12345,receivedAt:ts(at),err:null,
      logs,confirmationStatus:'confirmed',
    },
    observations:[{
      id:idNum.toString(16).padStart(64,'0'),
      chain:'solana',schemaVersion:1,dataMode:'REAL_RPC_LOG_OBSERVATION',
      evidenceStatus:'VERIFIED_RPC_LOG_EVENT',
      evidenceSource:{kind:'rpc:logsSubscribe',sourceMessageSha256:hash},
      transactionSignature:sig,slot:12345,
      tokenMint:mint,poolAddress:null,wallet:null,
      protocol,eventType,receivedAt:ts(at),confirmationStatus:'confirmed',
      amountTokenRaw:null,amountQuoteRaw:null,
    }]
  };
}
function summary(store,now){
  return applyRadarRollups(buildRadarSnapshot(store.radarObservations({limit:1,now}),{
    now,limit:50,sampleLimit:1,
  }),store.radarRollups({now}),{now,limit:50});
}

test('1s buckets preserve 15/60/300s counts even when raw evidence is capped at one row',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const now=Date.now();
  const rows=[
    notification({at:now-3000,mint:'shared',eventType:'TOKEN_BOUGHT'}),
    notification({at:now-25000,mint:'shared',eventType:'TOKEN_SOLD'}),
    notification({at:now-125000,mint:'shared',eventType:'TOKEN_MIGRATED'}),
    notification({at:now-4000,mint:'other',protocol:'pump_swap'}),
  ];
  for(const item of rows) store.persistLogBatch([item],{maxRows:1});
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM event_observations').get().n,1);
  const r=summary(store,now);
  assert.equal(r.sample.aggregationSource,'DURABLE_SQLITE_1S_BUCKETS');
  assert.equal(r.sample.rawSamplePotentiallyTruncated,true);
  assert.equal(r.sample.possibleTruncation,false);
  assert.equal(r.sample.verifiedUniqueEvents,4);
  assert.equal(r.totals.observedDistinctMints,2);
  const token=r.candidates.find(x=>x.mint==='shared');
  assert.deepEqual(token.activity['15s'],{events:1,buys:1,sells:0,lifecycle:0});
  assert.deepEqual(token.activity['60s'],{events:2,buys:1,sells:1,lifecycle:0});
  assert.deepEqual(token.activity['300s'],{events:3,buys:1,sells:1,lifecycle:1});
  assert.equal(token.distinctObservedTransactions,null);
  assert.equal(token.observedWalletsIdentified,null);
  assert.equal(r.coverage,'PARTIAL');
  assert.ok(r.candidates.some(x=>x.protocols.includes('pump_swap')));
});

test('replay after raw pruning cannot inflate persisted rolling counts',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const now=Date.now();
  const first=notification({at:now-3000,mint:'replay-token'});
  const second=notification({at:now-2000,mint:'newer-token'});
  store.persistLogBatch([first],{maxRows:1});
  store.persistLogBatch([second],{maxRows:1});
  store.persistLogBatch([first],{maxRows:1});
  const r=summary(store,now);
  assert.equal(r.sample.verifiedUniqueEvents,2);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM radar_seen_ids').get().n,2);
  assert.equal(store.db.prepare('SELECT SUM(events) n FROM radar_second_buckets').get().n,2);
});

test('invalid later event rolls back raw evidence, seen IDs and bucket increments',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const now=Date.now();
  const valid=notification({at:now-1000});
  const invalid=notification({at:now-1000});
  invalid.observations[0].slot=3333;
  assert.throws(()=>store.persistLogBatch([
    {notification:valid.notification,observations:[
      valid.observations[0],
      {...invalid.observations[0],transactionSignature:valid.notification.signature,
        receivedAt:valid.notification.receivedAt,
        evidenceSource:valid.observations[0].evidenceSource},
    ]},
  ],{maxRows:1}),/LOG_OBSERVATION_IDENTITY_MISMATCH/);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM event_observations').get().n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM radar_seen_ids').get().n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM radar_second_buckets').get().n,0);
});

test('rollups, seen-ID dedup and warmup marker survive SQLite WAL close/reopen',t=>{
  const dir=mkdtempSync(join(tmpdir(),'radar-rollup-restart-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'scanner.sqlite');
  const now=Date.now(),e=notification({at:now-1200});
  let store=new Store(path);
  store.persistLogBatch([e],{maxRows:1});store.close();
  store=new Store(path);t.after(()=>store.close());
  store.persistLogBatch([e],{maxRows:1});
  const after=summary(store,now);
  assert.equal(after.sample.verifiedUniqueEvents,1);
  assert.equal(after.candidates[0].activity['15s'].events,1);
  assert.equal(after.sample.aggregateAvailable,true);
  assert.ok(after.sample.firstAggregateRecordedAt);
});

test('bounded TTL removes old seen IDs and buckets, but not raw/canonical tables',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const now=Date.now(),e=notification({at:now-1000});
  store.persistLogBatch([e],{maxRows:1});
  pruneRadarRollups(store.db,now+370000);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM radar_seen_ids').get().n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM radar_second_buckets').get().n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM event_observations').get().n,1);
  assert.equal(readRadarRollups(store.db,{now:now+370000}).rows.length,0);
});

test('conservative 1-second boundary excludes an event before exact window start',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const now=Date.now();
  store.persistLogBatch([notification({at:now-15020,mint:'edge'})],{maxRows:1});
  const result=summary(store,now);
  assert.equal(result.candidates[0].activity['15s'].events,0);
  assert.equal(result.candidates[0].activity['60s'].events,1);
  assert.equal(result.sample.aggregationGranularityMs,1000);
});

test('pre-migration snapshot without aggregate state remains explicit legacy partial',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const old=readRadarRollups(store.db);
  assert.equal(old,null);
  const legacy=summary(store,Date.now());
  assert.equal(legacy.sample.aggregateAvailable,false);
  assert.equal(legacy.sample.aggregationSource,'LEGACY_BOUNDED_RAW_SAMPLE');
  assert.equal(legacy.sample.window300sPotentiallyTruncated,true);
});

test('scanner radar uses persisted aggregate source, not the raw 1-row cap',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const now=Date.now();
  store.persistLogBatch([notification({at:now-1000,mint:'mint-a'})],{maxRows:1});
  store.persistLogBatch([notification({at:now-3000,mint:'mint-b'})],{maxRows:1});
  const scanner=new Scanner({
    ...loadConfig({SOLANA_PROGRAMS:'pump_fun'}),maxObservationRows:100,
  },{store,rpc:{async request(){return[]},async close(){}},
    oracle:{snapshot:()=>null,async refresh(){return false;},failures:0,fallbackSuccesses:0}});
  const result=scanner.radar({now,limit:50});
  assert.equal(result.sample.aggregateAvailable,true);
  assert.equal(result.totals.observedDistinctMints,2);
  assert.equal(result.sample.verifiedUniqueEvents,2);
});
