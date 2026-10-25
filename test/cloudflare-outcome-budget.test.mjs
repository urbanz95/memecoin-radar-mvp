import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { collectFree } from '../src/cloudflare/collector.mjs';
import { queryDueOutcomes } from '../src/mvp/outcomes.mjs';
import { prepareDecisionRecords } from '../src/mvp/records.mjs';
import { setup, TOKEN, policyHash } from './helpers/mvp-sqlite.mjs';

const directory = new URL('../cloudflare/migrations/', import.meta.url);
const migrations = await Promise.all((await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name) && !name.startsWith('0001_'))
  .sort().map(name => readFile(new URL(name, directory), 'utf8')));
const hash = n => '0x' + BigInt(n + 1).toString(16).padStart(64, '0');
function fixture(t) {
  const DB = setup(t, { migrate: false });
  for (const sql of migrations) DB.sqlite.exec(sql);
  const at = Date.now() + 5000;
  let fetches = 0;
  const rpc = { audit: [], async request(method) {
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getLogs') return [];
    throw Error(`Unexpected RPC method: ${method}`);
  }, async block(number = 'latest') {
    number = number === 'latest' ? 1000 : number;
    return { number, timestamp: Math.floor(at / 1000) - Math.max(0,1000-number), hash: hash(number) };
  } };
  const collect = () => collectFree({ DB, MVP_RECORDING_ENABLED: '1', MVP_PHASE: '3', ANALYSIS_ENABLED: '1', LOG_CHUNK: '512' },
    { now: () => at, rpc, fetchImpl: async () => { fetches++; return Response.json({}, { status: 404 }); } });
  return { DB, at, collect, fetches: () => fetches };
}
async function seed(f, { expiredVersions = 3, liveVersions = 0 } = {}) {
  for (let token=1;token<=4;token++) for (const [type,versions,age] of [['expired',expiredVersions,7200000],['live',liveVersions,900000]]) {
    for (let n=0;n<versions;n++) await f.DB.batch(prepareDecisionRecords(f.DB, {
      runId: `budget-${type}-${token}-${n}`, observedAt: f.at-age,
      decisions: [{ address: TOKEN(token), scoreVersion: `budget-${type}-${n}`, profile: 'profile_new', policyHash,
        status: 'INCOMPLETE', isLaunch: true,
        features: { snapshot: { synthetic: false, chainState: { blockNumber: 10, blockHash: hash(10) } },
          decision: { score: null, synthetic: false }, externalMarket: { priceUsd: 10, liquidityUsd: 1000 } } }],
    }).commands);
  }
}
const identity = job => JSON.stringify([job.decisionKey,job.horizon]);
const attemptRows = DB => DB.sqlite.prepare('SELECT decision_key,horizon FROM mvp_outcome_attempts ORDER BY rowid').all();
const attemptIdentity = row => JSON.stringify([row.decision_key,row.horizon]);
const report = DB => JSON.parse(DB.sqlite.prepare('SELECT report_json FROM runs ORDER BY completed_at DESC LIMIT 1').get().report_json);

test('Free quota: a real collector cycle retries only four expired outcomes and preserves every deferred job unchanged', async t => {
  const f=fixture(t);await seed(f);
  const selected=await queryDueOutcomes(f.DB,{now:f.at,limit:4,maxJobs:24});
  assert.equal(selected.length,24);assert.ok(selected.every(job=>job.captureState==='EXPIRED'));
  const before=f.DB.sqlite.prepare('SELECT * FROM mvp_outcome_jobs ORDER BY decision_key,horizon').all();
  assert.equal((await f.collect()).status,'COMPLETED');
  const attempts=attemptRows(f.DB);
  assert.equal(attempts.length,4,'expired historical retries must not consume the full 24-job fanout budget');
  const attempted=new Set(attempts.map(attemptIdentity));
  const after=f.DB.sqlite.prepare('SELECT * FROM mvp_outcome_jobs ORDER BY decision_key,horizon').all();
  assert.equal(after.length,before.length);
  for(let n=0;n<before.length;n++) if(!attempted.has(JSON.stringify([before[n].decision_key,before[n].horizon])))
    assert.deepEqual(after[n],before[n],'deferred jobs keep due time, state, baseline identity and retry timestamp');
  const diagnostics=report(f.DB).mvp.outcomeCollection;
  assert.equal(diagnostics.jobs,4);assert.equal(diagnostics.selectedJobs,24);
  assert.equal(diagnostics.expiredJobs,4);assert.equal(diagnostics.expiredDeferred,20);assert.equal(diagnostics.maxExpiredPerCycle,4);
  assert.equal(f.fetches(),0,'expired-only work must not fetch current prices outside its capture window');
});

test('Free quota: every live version is attempted before four expired retries; the remainder stays archived', async t => {
  const f=fixture(t);await seed(f,{expiredVersions:3,liveVersions:1});
  const selected=await queryDueOutcomes(f.DB,{now:f.at,limit:4,maxJobs:24});
  const live=selected.filter(job=>job.captureState==='LIVE');
  assert.equal(live.length,4);
  const totalJobs=f.DB.sqlite.prepare('SELECT count(*) n FROM mvp_outcome_jobs').get().n;
  assert.equal((await f.collect()).status,'COMPLETED');
  const attempts=attemptRows(f.DB),ids=attempts.map(attemptIdentity);
  assert.deepEqual(ids.slice(0,live.length),live.map(identity),'open capture windows keep full priority and fanout');
  assert.equal(ids.length,live.length+4);
  assert.ok(live.every(job=>ids.includes(identity(job))));
  const diagnostics=report(f.DB).mvp.outcomeCollection;
  assert.equal(diagnostics.liveJobs,4);assert.equal(diagnostics.expiredJobs,4);assert.equal(diagnostics.expiredDeferred,16);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM mvp_outcome_jobs').get().n,totalJobs);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM mvp_outcomes').get().n,0,'missing observations never become zero-valued outcomes');
});

test('Free quota: a full fanout of 24 live outcomes is preserved even though expired retries are capped at four', async t => {
  const f=fixture(t);await seed(f,{expiredVersions:3,liveVersions:6});
  const selected=await queryDueOutcomes(f.DB,{now:f.at,limit:4,maxJobs:24});
  assert.equal(selected.length,24);assert.ok(selected.every(job=>job.captureState==='LIVE'));
  assert.equal((await f.collect()).status,'COMPLETED');
  assert.deepEqual(attemptRows(f.DB).map(attemptIdentity),selected.map(identity));
  const diagnostics=report(f.DB).mvp.outcomeCollection;
  assert.equal(diagnostics.jobs,24);assert.equal(diagnostics.liveJobs,24);assert.equal(diagnostics.expiredJobs,0);
});
