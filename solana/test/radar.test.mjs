import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRadarSnapshot } from '../src/radar.mjs';
import { decodeLogObservation } from '../src/log-observations.mjs';
import { SOL_MINT } from '../src/protocols/pump.mjs';
import { Store } from '../src/store.mjs';
import { Scanner } from '../src/scanner.mjs';
import { serve } from '../src/api.mjs';
const now = Date.parse('2026-11-06T12:00:00Z');
const iso = offset => new Date(now - offset).toISOString();
let id = 0;
function observed(mint, type, ageMs, patch = {}) {
  id++;
  return {
    id: ('0'.repeat(64) + id.toString(16)).slice(-64),
    chain: 'solana', schemaVersion: 1,
    dataMode: 'REAL_RPC_LOG_OBSERVATION',
    evidenceStatus: 'VERIFIED_RPC_LOG_EVENT',
    evidenceSource: { kind: 'rpc:logsSubscribe', sourceMessageSha256: 'abc' },
    transactionSignature: 'sig-' + id, slot: 100,
    protocol: 'pump_fun', eventType: type, tokenMint: mint,
    receivedAt: iso(ageMs), wallet: null, quoteMint: SOL_MINT,
    confirmationStatus: 'confirmed',
    ...patch,
  };
}
const price = { usdCents: 16000, at: now, source: 'test-fresh-quote' };

test('projection groups by mint, deduplicates and uses receivedAt windows', () => {
  const a = observed('mint-A', 'TOKEN_BOUGHT', 10000, { wallet: 'wallet1' });
  const b = observed('mint-A', 'TOKEN_SOLD', 45000, { wallet: 'wallet1' });
  const c = observed('mint-A', 'TOKEN_BOUGHT', 120000);
  const d = observed('mint-B', 'TOKEN_BOUGHT', 10000);
  const fake = observed('mint-B', 'TOKEN_BOUGHT', 5000,
    { evidenceStatus: 'UNKNOWN' });
  const old = observed('mint-C', 'TOKEN_CREATED', 310000);
  const r = buildRadarSnapshot([a,a,b,c,d,fake,old], { now, quote: price });
  assert.equal(r.coverage, 'PARTIAL');
  assert.equal(r.totals.observedDistinctMints, 2);
  assert.equal(r.sample.verifiedUniqueEvents, 4);
  const x = r.candidates.find(t => t.mint === 'mint-A');
  assert.deepEqual(x.activity['15s'], { events:1,buys:1,sells:0,lifecycle:0 });
  assert.deepEqual(x.activity['60s'], { events:2,buys:1,sells:1,lifecycle:0 });
  assert.equal(x.activity['300s'].events,3);
  assert.equal(x.observedWalletsIdentified,1);
  assert.equal(x.unattributedBuySellEvents,1);
  assert.equal(x.fdvStatus,'FDV_UNKNOWN');
  assert.equal(x.safetyConclusion,null);
});

test('verified SOL creation + reserves gives FDV band; missing/stale quote never yields zero', () => {
  const supply = '1000000000000000';
  const reserves = sol => ({
    virtualTokenRaw: supply,
    virtualQuoteRaw: sol + '000000000',
  });
  const create = (mint,sol) => observed(mint,'TOKEN_CREATED',6000,{
    totalSupplyRaw:supply,reserves:reserves(sol),
  });
  const r = buildRadarSnapshot([
    create('above',40),create('near',30),create('below',10),
  ],{now,quote:price,minimumFdvUsd:5000});
  assert.equal(r.totals.aboveFloor,1);
  assert.equal(r.totals.nearFloor,1);
  assert.equal(r.totals.belowFloorNotDisplayed,1);
  assert.deepEqual(r.candidates.map(x=>x.mint),['above','near']);
  assert.equal(r.candidates[0].estimatedFdvUsd,6400);
  assert.equal(r.candidates[1].estimatedFdvUsd,4800);
  assert.equal(r.candidates[0].fdvEvidence.kind,'PUMP_FUN_VIRTUAL_RESERVE_PROXY_NOT_CIRCULATING_MARKET_CAP');
  const stale = buildRadarSnapshot([create('unknown',40)],{
    now,quote:{...price,at:now-400000},
  });
  assert.equal(stale.candidates[0].fdvStatus,'FDV_UNKNOWN');
  assert.equal(stale.candidates[0].estimatedFdvUsd,null);
});

test('PumpSwap never reuses Pump.fun virtual-reserve formula; unknown kept', () => {
  const e=observed('pool-token','TOKEN_BOUGHT',500,{protocol:'pump_swap',reserves:{
    virtualTokenRaw:'1',virtualQuoteRaw:'1000000000000',
  }});
  const r=buildRadarSnapshot([e],{now,quote:price});
  assert.equal(r.candidates[0].fdvStatus,'FDV_UNKNOWN');
  assert.equal(r.candidates[0].observedEvents,1);
  assert.equal(r.candidates[0].protocols[0],'pump_swap');
});

test('read-only /radar and standalone /dashboard use persisted authentic Pump log fixture', async t => {
  const tx=JSON.parse(readFileSync(
    new URL('../fixtures/pump-create-v2-mainnet.json',import.meta.url)
  )).result;
  const notification={
    signature:tx.transaction.signatures[0],slot:tx.slot,logs:tx.meta.logMessages,
    err:tx.meta.err,receivedAt:new Date().toISOString(),
    confirmationStatus:'confirmed',
  };
  const logs=decodeLogObservation(notification);
  assert.ok(logs.observations.length>0);
  const store=new Store(':memory:');
  store.persistLogBatch([{notification,observations:logs.observations}]);
  const scanner=new Scanner({
    dbPath:':memory:',programs:['pump_fun'],maxObservationRows:10000,
    fdvMinimumUsd:5000,securityEnabled:false,
  },{
    store,oracle:{snapshot:()=>null,async refresh(){return false;}},
    rpc:{
      async close(){},async assertMainnet(){},
      async request(){throw Error('NETWORK_NOT_EXPECTED')},
    },
  });
  const server=await serve(scanner,{host:'127.0.0.1',port:0});
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    await scanner.stop();
  });
  const root='http://127.0.0.1:'+server.address().port;
  const response=await fetch(root+'/radar?limit=10');
  assert.equal(response.status,200);
  const radar=await response.json();
  assert.equal(radar.coverage,'PARTIAL');
  assert.ok(radar.totals.observedDistinctMints>=1);
  assert.ok(radar.candidates.some(x=>x.mint===logs.observations[0].tokenMint));
  const page=await fetch(root+'/dashboard');
  assert.equal(page.status,200);
  assert.match(page.headers.get('content-type'),/text\/html/);
  const html=await page.text();
  assert.match(html,/Solana · Memecoin Radar/);
  assert.match(html,/application\/json/);
  assert.doesNotMatch(html,/__SNAPSHOT_JSON__/);
  assert.match(html,/PARTIAL/);
  const after=store.radarObservations({limit:10});
  assert.equal(after.length,logs.observations.length);
});
