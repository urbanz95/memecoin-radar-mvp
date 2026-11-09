import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Scanner } from '../src/scanner.mjs';
import { SolUsdOracle } from '../src/sol-usd-oracle.mjs';

const now = Date.parse('2026-11-08T00:47:18.000Z');
const point = age => new Date(now - age).toISOString();
const observation = (signature, age, evidenceSource='rpc:logsSubscribe') => ({
  signature, slot: 1, receivedAt: point(age), evidenceSource,
  confirmationStatus:'confirmed', contextPriority: 0,
});

test('cloud selection defaults are not silently applied to local scanner', () => {
  const local = loadConfig({SOLANA_PROGRAMS:'pump_fun'});
  assert.equal(local.contextMaxPriority,3);
  assert.equal(local.contextMaxAgeMs,0);
  assert.equal(local.solUsdFallbackEnabled,false);
  const cloud = loadConfig({
    SOLANA_PROGRAMS:'pump_fun,pump_swap', SOLANA_CONTEXT_PRIORITIES_ENABLED:'true',
    SOLANA_CONTEXT_MAX_PRIORITY:'0', SOLANA_CONTEXT_MAX_AGE_MS:'90000',
    SOLANA_SOL_USD_FALLBACK:'true', SOLANA_SOL_USD_FEED:'coingecko',
  });
  assert.equal(cloud.contextMaxPriority,0);
  assert.equal(cloud.contextMaxAgeMs,90000);
  assert.equal(cloud.solUsdFallbackEnabled,true);
  assert.throws(()=>loadConfig({SOLANA_CONTEXT_MAX_PRIORITY:'4'}),/INVALID_CONFIG/);
  assert.throws(()=>loadConfig({SOLANA_CONTEXT_MAX_AGE_MS:'-1'}),/INVALID_CONFIG/);
  assert.throws(()=>loadConfig({SOLANA_SOL_USD_FALLBACK:'yes'}),/INVALID_SOLANA/);
});

test('expiry only skips old unclaimed live log enrichment, not raw logs or recovery', () => {
  const db = new Store(':memory:');
  try {
    db.receiveBatch([
      observation('old-live',120000), observation('young-live',10000),
      observation('old-recovery',120000,'rpc:getSignaturesForAddress'),
    ]);
    const expired = db.expireStaleLogContext({now,maxAgeMs:90000});
    assert.equal(expired,1);
    assert.equal(db.expireStaleLogContext({now,maxAgeMs:90000}),0);
    assert.equal(db.db.prepare("SELECT status FROM inbox WHERE signature='old-live'").get().status,'EXPIRED');
    assert.equal(db.stats().pending,2);
    assert.deepEqual(new Set(db.pending().map(x=>x.signature)),new Set(['young-live','old-recovery']));
    assert.throws(()=>db.expireStaleLogContext({now,maxAgeMs:0}),/INVALID_CONTEXT_EXPIRY/);
  } finally {db.close()}
});

test('expired queued context is not allowed to consume an HTTP RPC slot', async () => {
  const db = new Store(':memory:');
  let calls=0;
  const scanner=new Scanner({
    ...loadConfig({SOLANA_PROGRAMS:'pump_fun'}),
    contextMaxAgeMs:90000,
  }, {
    store:db,
    rpc:{ async request(){calls++;throw Error('NO_RPC_ALLOWED')},async close(){} },
  });
  const old = observation('stale-sig',120000);
  db.receiveBatch([old]);
  try {
    assert.equal(await scanner.processObservation(old),false);
    assert.equal(calls,0);
    assert.equal(db.db.prepare("SELECT status FROM inbox WHERE signature='stale-sig'").get().status,'EXPIRED');
    assert.equal(scanner.health().metrics.counters.contextEnrichmentExpired,1);
  } finally {await scanner.stop()}
});

test('P0 context survives while buy and unknown-tier context are omitted from HTTP inbox', async () => {
  const created=JSON.parse(readFileSync(new URL('../fixtures/pump-create-v2-mainnet.json',import.meta.url))).result;
  const bought=JSON.parse(readFileSync(new URL('../fixtures/pump-buy-v3-mainnet.json',import.meta.url))).result;
  const db = new Store(':memory:');
  const scanner=new Scanner({
    ...loadConfig({SOLANA_PROGRAMS:'pump_fun'}),
    fdvMinimumUsd:0,contextPrioritiesEnabled:true,
    contextMaxPriority:0, maxDurableBacklog:64,
  },{
    store:db,rpc:{async close(){}},oracle:{snapshot:()=>null,async refresh(){return false}},
  });
  const incoming=tx=>({
    signature:tx.transaction.signatures[0],slot:tx.slot,
    logs:tx.meta.logMessages,err:tx.meta.err,
    receivedAt:new Date().toISOString(),confirmationStatus:'confirmed',
  });
  try {
    scanner.receive(incoming(bought));
    scanner.flush();
    assert.equal(db.stats().inbox,0);
    assert.ok(db.observations({signature:bought.transaction.signatures[0]}).length>0);
    assert.equal(scanner.health().metrics.counters.contextEnrichmentExcludedByPolicy,1);
    scanner.receive(incoming(created));
    scanner.flush();
    assert.equal(db.pendingByPriority(0).length,1);
    assert.ok(db.observations({signature:created.transaction.signatures[0]}).length>0);
    assert.equal(scanner.health().contextPriorityScheduler.maxHttpPriority,0);
  } finally {await scanner.stop()}
});

test('optional free Kraken fallback validates data, records receipt time and obeys 2min quota', async () => {
  let clock=now,calls=[];
  const oracle=new SolUsdOracle({
    enabled:true,fallbackEnabled:true,now:()=>clock,
    fetchFn:async url=>{
      calls.push(url);
      if(url.includes('coingecko'))return {ok:false,status:429};
      if(url.includes('kraken'))return {ok:true,json:async()=>({
        error:[],result:{SOLUSD:{c:['150.1234','1.00']}},
      })};
      throw Error('UNEXPECTED_HOST');
    },
  });
  assert.equal(await oracle.refresh(),true);
  assert.equal(oracle.snapshot().usdCents,15013);
  assert.equal(oracle.snapshot().at,now);
  assert.equal(oracle.snapshot().source,'kraken_SOLUSD_last_trade_fetched_not_trade_timestamp');
  assert.equal(oracle.fallbackSuccesses,1);
  assert.equal(oracle.failures,0);
  assert.equal(await oracle.refresh(),false);
  assert.equal(calls.length,2);
  clock+=120001;
  assert.equal(await oracle.refresh(),true);
  assert.equal(calls.length,4);
});

test('invalid or unavailable free quotes fail closed without guessed FDV',async()=>{
  let clock=now, calls=0;
  const oracle=new SolUsdOracle({
    enabled:true,fallbackEnabled:true,now:()=>clock,fetchFn:async(url)=>{
      calls++;
      if(url.includes('coingecko'))return {ok:false,status:403};
      return {ok:true,json:async()=>({error:[],result:{BTCUSD:{c:['90000']}}})};
    },
  });
  assert.equal(await oracle.refresh(),false);
  assert.equal(oracle.snapshot(),null);
  assert.equal(oracle.failures,1);
  assert.equal(calls,2);
  const html=readFileSync(new URL('../static/radar.html',import.meta.url),'utf8');
  assert.match(html,/SEM WEBSOCKET/);
  assert.match(html,/WebSocket ligado/);
});
