import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { encodeAbiParameters, parseAbiParameters, encodeEventTopics } from 'viem';
import { collectFree } from '../src/cloudflare/collector.mjs';
import worker from '../src/cloudflare/worker.mjs';
import { OPERATIONS_CONFIG } from '../src/cloudflare/operations.mjs';
import { EVENTS } from '../src/onchain/abi.mjs';
import { QUOTE_ASSETS } from '../src/network.mjs';
import { hex } from '../src/cloudflare/rpc.mjs';
import { prepareDecisionRecords } from '../src/mvp/records.mjs';
import { prepareWeeklyReport, runWeeklyReportJob, getWeeklyReportPage } from '../src/mvp/weekly-report.mjs';
import { setup, TOKEN, policyHash } from './helpers/mvp-sqlite.mjs';

const migrationDir = new URL('../cloudflare/migrations/', import.meta.url);
const migrationNames = (await readdir(migrationDir)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
const migrations = await Promise.all(migrationNames.filter(name => !name.startsWith('0001_'))
  .map(name => readFile(new URL(name, migrationDir), 'utf8')));
const TARGET = '0x1111111111111111111111111111111111111111';
const POOL = '0x2222222222222222222222222222222222222222';
const FACTORY = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f';
const blockHash = number => '0x' + BigInt(number + 1).toString(16).padStart(64, '0');

function fixture(t) {
  // Use the real SQLite schema and every migration, in production order.
  const DB = setup(t, { migrate: false });
  for (const sql of migrations) DB.sqlite.exec(sql);
  // The collector commit fence compares against SQLite wall time. Advancing the
  // observation clock also keeps this fixture after Monday's 00:15 report time.
  let at = Date.now() + 3600000;
  if (new Date(at).getUTCDay() === 1 && new Date(at).getUTCHours() === 0) at += 3600000;
  let head = 1000;
  const log = { address: FACTORY,
    topics: encodeEventTopics({ abi: [EVENTS.v2], eventName: 'PairCreated', args: { token0: QUOTE_ASSETS.WETH, token1: TARGET } }),
    data: encodeAbiParameters(parseAbiParameters('address,uint256'), [POOL, 1n]),
    blockNumber: hex(995), blockHash: blockHash(995), transactionHash: blockHash(99999), logIndex: '0x0', removed: false };
  const rpc = { audit: [],
    async request(method, params) {
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getLogs') {
        const filter = params[0];
        return Number(BigInt(filter.fromBlock)) <= 995 && Number(BigInt(filter.toBlock)) >= 995 ? [log] : [];
      }
      throw Error(`Unexpected fixture RPC method: ${method}`);
    },
    async block(number = 'latest') {
      number = number === 'latest' ? head : number;
      return { number, timestamp: Math.floor(at / 1000) - Math.max(0, head - number), hash: blockHash(number) };
    },
    async batch(calls) {
      return calls.map(([method]) => ({ value: method === 'eth_getCode' ? '0x60006000' : '0x' + '0'.repeat(63) + '1' }));
    },
  };
  const env = { DB, LOG_CHUNK: '512', MAX_LOGS: '4', MVP_RECORDING_ENABLED: '1', MVP_PHASE: '3' };
  const collect = () => collectFree(env, { rpc, now: () => at,
    fetchImpl: async () => { throw Error('UNEXPECTED_FIXTURE_NETWORK'); } });
  return { DB, env, collect, now: () => at, advance() { at += 60000; head += 60; } };
}
async function seedFifteenMatureCohorts(f) {
  const date = new Date(f.now());
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const monday = midnight - ((date.getUTCDay() + 6) % 7) * 86400000;
  const observedAt = monday - 14 * 86400000 + 3600000;
  for (let n = 1; n <= 15; n++) await f.DB.batch(prepareDecisionRecords(f.DB, {
    runId: `capacity-seed-${n}`, observedAt,
    decisions: [{ address: TOKEN(n), status: 'REJECTED', scoreVersion: `capacity-cohort-${String(n).padStart(2,'0')}`,
      profile: 'profile_new', policyHash, isLaunch: true,
      features: { snapshot: { synthetic: false, chainState: { blockNumber: 10, blockHash: blockHash(10) } },
        decision: { synthetic: false, score: 80, wallets: { status: 'READY', score: 80 } },
        externalMarket: { priceUsd: 1, liquidityUsd: 1000 } } }],
  }).commands);
}
const count = (DB, table) => DB.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test('A02: two real collector transactions persist while 15 mature cohorts exceed the legacy combined report limit', async t => {
  const f = fixture(t); await seedFifteenMatureCohorts(f);
  await assert.rejects(prepareWeeklyReport(f.DB, { now: f.now }), /MVP_WEEKLY_REPORT_LIMIT_EXCEEDED/);
  const before = count(f.DB, 'mvp_decision_events');
  const first = await f.collect();
  assert.equal(first.status, 'COMPLETED');
  f.advance();
  const second = await f.collect();
  assert.equal(second.status, 'COMPLETED');
  assert.notEqual(first.runId, second.runId);
  assert.equal(count(f.DB, 'runs'), 2);
  assert.ok(count(f.DB, 'mvp_decision_events') > before);
  assert.equal(count(f.DB, 'mvp_weekly_reports'), 0, 'ingestion never prepares/inserts the legacy report');
  const control = f.DB.sqlite.prepare('SELECT status,last_error,last_success FROM control WHERE id=1').get();
  assert.equal(control.status, 'COMPLETED'); assert.equal(control.last_error, null); assert.equal(control.last_success, f.now());
  const published = JSON.parse(f.DB.sqlite.prepare('SELECT report_json FROM runs WHERE id=?').get(second.runId).report_json);
  assert.equal(published.mvp.weekly.status, 'INDEPENDENT_JOB');

  const weekly = await runWeeklyReportJob(f.DB, { now: f.now });
  assert.equal(weekly.pagesWritten, 1);
  assert.equal(count(f.DB, 'mvp_weekly_cohort_pages'), 1);
  const page = await getWeeklyReportPage(f.DB);
  assert.equal(page.cohorts.length, 1); assert.equal(page.totals.realDecisions, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 65536);
  assert.equal(count(f.DB, 'runs'), 2, 'the report job publishes no collector run');
});

test('A02: an independent report aggregate failure and retry never block subsequent collection or its archive writes', async t => {
  const f = fixture(t); await seedFifteenMatureCohorts(f);
  assert.equal((await f.collect()).status, 'COMPLETED');
  const before = count(f.DB, 'mvp_decision_events');
  const prepare = f.DB.prepare.bind(f.DB);
  f.DB.prepare = sql => {
    if (sql.startsWith('WITH raw')) throw Error('MVP_WEEKLY_TEST_AGGREGATE_FAILURE');
    return prepare(sql);
  };
  const failed = await runWeeklyReportJob(f.DB, { now: f.now });
  assert.equal(failed.status, 'RETRY'); assert.equal(failed.error, 'MVP_WEEKLY_TEST_AGGREGATE_FAILURE');
  assert.equal(count(f.DB, 'mvp_weekly_cohort_pages'), 0);
  assert.equal(f.DB.sqlite.prepare('SELECT state FROM mvp_weekly_jobs').get().state, 'RETRY');
  // Keep the failed-report adapter installed: any accidental aggregate call
  // from ingestion would fail this second cycle as well.
  f.advance();
  assert.equal((await f.collect()).status, 'COMPLETED');
  assert.equal(count(f.DB, 'runs'), 2); assert.ok(count(f.DB, 'mvp_decision_events') > before);
  f.DB.prepare = prepare;
  const recovered = await runWeeklyReportJob(f.DB, { now: f.now });
  assert.equal(recovered.pagesWritten, 1); assert.equal(count(f.DB, 'mvp_weekly_cohort_pages'), 1);
});

test('A02: the independent weekly cron routes to its own actor while the collector cron retains the primary actor', async t => {
  const names = []; const requests = [];
  t.mock.method(console, 'log', () => {});
  const namespace = {
    idFromName(name) { names.push(name); return name; },
    get(id) { return { async fetch(input, init) {
      const request = new Request(input, init);
      requests.push({ id, method: request.method, path: new URL(request.url).pathname });
      return Response.json({ status: 'COMPLETED' });
    } }; },
  };
  const env = new Proxy({ OPERATIONS_ENABLED: '1', COLLECTOR_INSTANCE: 'phase3b-main', COLLECTOR: namespace }, {
    get(target, property) {
      assert.ok(['OPERATIONS_ENABLED', 'COLLECTOR_INSTANCE', 'COLLECTOR'].includes(property),
        `cron must not read database or RPC bindings: ${String(property)}`);
      return target[property];
    },
  });
  await worker.scheduled({ cron: OPERATIONS_CONFIG.weekly.cron }, env);
  await worker.scheduled({ cron: '* * * * *' }, env);
  assert.deepEqual(names, ['phase3b-main-weekly', 'phase3b-main']);
  assert.deepEqual(requests, [
    { id: 'phase3b-main-weekly', method: 'POST', path: '/weekly' },
    { id: 'phase3b-main', method: 'POST', path: '/collect' },
  ]);
});
