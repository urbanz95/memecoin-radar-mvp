import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { encodeAbiParameters, parseAbiParameters, encodeEventTopics } from 'viem';
import { collectFree, boundedLogs } from '../src/cloudflare/collector.mjs';
import { FreeRpc, hex } from '../src/cloudflare/rpc.mjs';
import worker, { Collector } from '../src/cloudflare/worker.mjs';
import { EVENTS } from '../src/onchain/abi.mjs';
import { QUOTE_ASSETS } from '../src/network.mjs';
import { prepareDecisionRecords } from '../src/mvp/records.mjs';

const schema = await readFile(new URL('../cloudflare/migrations/0001_collector.sql', import.meta.url), 'utf8');
const mvpSchema = await readFile(new URL('../cloudflare/migrations/0002_mvp_records.sql', import.meta.url), 'utf8');
const outboxSchema = await readFile(new URL('../cloudflare/migrations/0003_mvp_outbox.sql', import.meta.url), 'utf8');
const walletSchema = await readFile(new URL('../cloudflare/migrations/0004_mvp_wallets.sql', import.meta.url), 'utf8');
const weeklySchema = await readFile(new URL('../cloudflare/migrations/0005_mvp_weekly.sql', import.meta.url), 'utf8');
const outcomeCaptureSchema = await readFile(new URL('../cloudflare/migrations/0006_mvp_outcome_capture.sql', import.meta.url), 'utf8');
const TOKEN = '0x1111111111111111111111111111111111111111';
const POOL = '0x2222222222222222222222222222222222222222';
const FACTORY = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f';
const blockHash = n => '0x' + BigInt(n + 1).toString(16).padStart(64, '0');

// Executa as queries reais em SQLite, incluindo transações/CHECK e índices.
// O transporte D1 não é simulado por interpretação de strings SQL.
class SqliteD1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec(schema); }
  prepare(sql) {
    const db = this; let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return db.sqlite.prepare(sql).get(...values) ?? null; },
      async all() { return { results: db.sqlite.prepare(sql).all(...values) }; },
      async run() { const r = db.sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(r.changes) } }; }
    };
  }
  async batch(statements) {
    this.beforeBatch?.(); this.sqlite.exec('BEGIN');
    try { const results = []; for (const s of statements) results.push(await s.run()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
function setup(t) {
  const DB = new SqliteD1(); t.after(() => DB.sqlite.close());
  let time = Date.now();
  const changes = { head: 1000, reorg: false, wrongChain: false, failFinal: false };
  const log = { address: FACTORY,
    topics: encodeEventTopics({ abi: [EVENTS.v2], eventName: 'PairCreated', args: { token0: QUOTE_ASSETS.WETH, token1: TOKEN } }),
    data: encodeAbiParameters(parseAbiParameters('address,uint256'), [POOL, 1n]),
    blockNumber: hex(995), blockHash: blockHash(995), transactionHash: blockHash(99999), logIndex: '0x0', removed: false };
  const rpc = {
    audit: [],
    async request(method, params) {
      if (method === 'eth_chainId') return changes.wrongChain ? '0x1' : '0x1237';
      if (method === 'eth_getLogs') {
        const [f] = params; return Number(BigInt(f.fromBlock)) <= 995 && Number(BigInt(f.toBlock)) >= 995 ? [log] : [];
      }
      throw new Error('Unexpected RPC method');
    },
    async block(n = 'latest') {
      if (changes.failFinal && n === changes.head) throw new Error('https://private-rpc/secret');
      const number = n === 'latest' ? changes.head : n;
      return { number, timestamp: Math.floor(time / 1000) - Math.max(0, changes.head - number),
        hash: changes.reorg && number === 1000 ? blockHash(100000) : blockHash(number) };
    },
    async batch(calls) {
      return calls.map(([method]) => ({ value: method === 'eth_getCode' ? '0x60006000' : '0x' + '0'.repeat(63) + '1' }));
    }
  };
  return { DB, rpc, changes, log, now: () => time, advance(ms) { time += ms; }, env: { DB, LOG_CHUNK: '512', MAX_LOGS: '4' } };
}

async function seedRetentionCatalog(f) {
  const base = (await boundedLogs(f.rpc, 995, 995, 1)).pools[0];
  const insert = f.DB.sqlite.prepare('INSERT INTO pools(id,address,created_block,last_enriched,pool_json) VALUES(?,?,?,?,?)');
  const add = (id, createdBlock, lastEnriched) => insert.run(id, TOKEN, createdBlock, lastEnriched,
    JSON.stringify({ ...base, id, createdBlock, createdBlockHash: blockHash(createdBlock) }));
  f.DB.sqlite.exec('BEGIN');
  try {
    for (let i = 1; i <= 50003; i++) add(`retention-${i}`, 1000 + i, 0);
    add('old-recently-enriched', 1, f.now() - 1000);
    add('old-selected-for-enrichment', 2, -1);
    f.DB.sqlite.exec('COMMIT');
  } catch (error) { f.DB.sqlite.exec('ROLLBACK'); throw error; }
  f.changes.head = 100000;
  f.DB.sqlite.prepare('UPDATE control SET state_json=?').run(JSON.stringify({
    sequence: 1438, recentNext: 995, backfillCursor: -1, historicalCursor: -1,
  }));
}

test('cron apenas delega ao Durable Object estável, sem ler D1 ou RPC no chamador', async t => {
  const identifier = { name: 'main' }; const calls = []; const logged = [];
  const result = { status: 'COMPLETED', runId: 'fixture-do-run', head: 1000, snapshots: 1 };
  t.mock.method(console, 'log', value => logged.push(value));
  const namespace = {
    idFromName(name) { calls.push(['idFromName', name]); return identifier; },
    get(id) {
      assert.equal(id, identifier); calls.push(['get']);
      return { async fetch(input, init) {
        const request = new Request(input, init);
        calls.push(['fetch', request.method, request.url]);
        return Response.json(result);
      } };
    },
  };
  const env = new Proxy({ COLLECTOR: namespace }, {
    get(target, name) {
      assert.equal(name, 'COLLECTOR', `O cron não pode executar a recolha nem ler ${String(name)}`);
      return target[name];
    },
  });
  await worker.scheduled({ cron: '* * * * *' }, env);
  assert.deepEqual(calls, [
    ['idFromName', 'main'], ['get'], ['fetch', 'POST', 'https://collector.internal/collect'],
  ]);
  assert.deepEqual(logged.map(value => JSON.parse(value)), [result]);
});

test('a collector instance can be rotated without changing the D1 identity or giving the cron database access', async t => {
  t.mock.method(console, 'log', () => {});
  const names = [];
  const env = { COLLECTOR_INSTANCE: 'main-mvp-v3', COLLECTOR: {
    idFromName(name) { names.push(name); return name; },
    get(id) { assert.equal(id, 'main-mvp-v3'); return { async fetch() { return Response.json({ status: 'SKIPPED' }); } }; }
  } };
  await worker.scheduled({}, env);
  assert.deepEqual(names, ['main-mvp-v3']);
  env.COLLECTOR_INSTANCE = 'invalid/instance';
  await assert.rejects(worker.scheduled({}, env), /INVALID_COLLECTOR_INSTANCE/);
});

test('POST público não aciona Durable Object, D1 ou RPC, mesmo na rota interna de recolha', async () => {
  const env = new Proxy({}, { get(_target, name) { throw new Error(`Unexpected public binding access: ${String(name)}`); } });
  for (const path of ['/', '/index.html', '/dashboard.js', '/collect', '/health', '/latest']) {
    const response = await worker.fetch(new Request(`https://example.test${path}`, { method: 'POST' }), env);
    assert.equal(response.status, 405);
  }
  assert.equal((await worker.fetch(new Request('https://example.test/collect'), env)).status, 404);
});

test('dashboard e script usam só assets, sem acionar recolha ou ler dados, com cache desativada', async () => {
  const requested = [];
  const env = new Proxy({ ASSETS: { async fetch(request) {
    requested.push(new URL(request.url).pathname);
    return new Response('static asset', { headers: { 'content-type': request.url.endsWith('.js') ? 'text/javascript' : 'text/html' } });
  } } }, { get(target, name) { assert.equal(name, 'ASSETS'); return target[name]; } });
  for (const path of ['/', '/index.html', '/dashboard.js']) {
    const response = await worker.fetch(new Request(`https://example.test${path}`), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'static asset');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  }
  assert.deepEqual(requested, ['/', '/index.html', '/dashboard.js']);
});

test('Durable Object rejeita método ou caminho inválido antes de tocar nos bindings', async () => {
  const env = new Proxy({}, { get(_target, name) { throw new Error(`Unexpected DO binding access: ${String(name)}`); } });
  const collector = new Collector({}, env);
  for (const [method, path, status] of [['GET', '/collect', 405], ['POST', '/other', 404], ['POST', '/collect/', 404]]) {
    const response = await collector.fetch(new Request(`https://collector.internal${path}`, { method }));
    assert.equal(response.status, status);
  }
});

test('POST interno do Durable Object usa o lease D1 existente e devolve o resultado do collector', async t => {
  const f = setup(t);
  f.DB.sqlite.prepare("UPDATE control SET lease_until=?,lease_owner='another-run'").run(Date.now() + 30000);
  const collector = new Collector({}, f.env);
  const response = await collector.fetch(new Request('https://collector.internal/collect', { method: 'POST' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'SKIPPED' });
  assert.equal(f.DB.sqlite.prepare('SELECT lease_owner FROM control').get().lease_owner, 'another-run');
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
});

test('Cloudflare → RPC → SQLite: catálogo, evidência e dois pipelines sem inventar provas', async t => {
  const f = setup(t);
  const result = await collectFree(f.env, { rpc: f.rpc, now: f.now });
  assert.equal(result.status, 'COMPLETED'); assert.equal(result.snapshots, 1);
  const row = f.DB.sqlite.prepare('SELECT * FROM runs').get();
  const report = JSON.parse(row.report_json);
  assert.equal(report.chainId, 4663); assert.equal(report.results.length, 2);
  assert.ok(report.results.every(r => r.status === 'INCOMPLETE'));
  assert.equal(report.snapshots[0].security.hasBytecode, true);
  assert.equal(report.snapshots[0].security.honeypotDetected, undefined);
  assert.equal(report.snapshots[0].contractCreatedAt, undefined);
  assert.equal(report.snapshots[0].market.liquidityUsd, undefined);
  assert.equal(report.snapshots[0].market.oldestPoolCreatedAt, undefined);
  assert.equal(report.snapshots[0].market.hasUnreviewedHooks, undefined);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM pools').get().n, 1);
  const state = JSON.parse(f.DB.sqlite.prepare('SELECT state_json FROM control').get().state_json);
  assert.equal(state.recentNext, 1001); assert.equal(state.backfillCursor, -1);
});

test('lease ativo ignora cron duplicado sem contactar RPC', async t => {
  const f = setup(t);
  f.DB.sqlite.prepare("UPDATE control SET lease_until=?,lease_owner='other'").run(f.now() + 30000);
  const result = await collectFree(f.env, { now: f.now, rpc: { request() { throw new Error('must not run'); } } });
  assert.equal(result.status, 'SKIPPED');
});

test('análise adicional publica filtros e histórico persistente sem aprovar dados desconhecidos', async t => {
  const f = setup(t);
  f.env.ANALYSIS_ENABLED = '1';
  const fetchImpl = async () => Response.json({}, { status: 404 });
  const result = await collectFree(f.env, { rpc: f.rpc, now: f.now, fetchImpl });
  assert.equal(result.status, 'COMPLETED');
  const report = JSON.parse(f.DB.sqlite.prepare('SELECT report_json FROM runs').get().report_json);
  assert.equal(report.screening.entries.length, 1);
  assert.equal(report.screening.currentSignalsAvailable, false);
  const entry = report.screening.entries[0];
  assert.equal(entry.address, TOKEN);
  assert.ok(entry.checks.length > 0);
  assert.ok(entry.unknowns.length > 0);
  assert.equal(entry.age.contractCreatedAt, undefined);
  assert.ok(report.results.every(item => !['CANDIDATE', 'CONFIRMING'].includes(item.status)));
  const state = JSON.parse(f.DB.sqlite.prepare('SELECT state_json FROM control').get().state_json);
  assert.deepEqual(state.screeningEntries, report.screening.entries.map(({ signal, ...entry }) => entry));
  assert.ok(report.screening.entries.every(entry => entry.signal?.tradeApproved === false));
  const response = await worker.fetch(new Request('https://example.test/latest'), f.env);
  assert.deepEqual((await response.json()).screening, report.screening);
});

test('MVP archival records real collector inputs and preserves rejected decisions after operational run expiry', async t => {
  const f = setup(t); f.DB.sqlite.exec(mvpSchema); f.DB.sqlite.exec(outcomeCaptureSchema);
  f.env.ANALYSIS_ENABLED = '1'; f.env.MVP_RECORDING_ENABLED = '1';
  const fetchImpl = async () => Response.json({}, { status: 404 });
  assert.equal((await collectFree(f.env, { rpc: f.rpc, now: f.now, fetchImpl })).status, 'COMPLETED');
  const first = f.DB.sqlite.prepare('SELECT run_id,first_status FROM mvp_decisions JOIN mvp_decision_events USING(decision_key) LIMIT 1').get();
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_decisions').get().n, 2);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_outcome_jobs').get().n, 8);
  assert.equal(f.DB.sqlite.prepare('SELECT tokens_seen FROM mvp_stats WHERE id=1').get().tokens_seen, 1);
  const output = await (await worker.fetch(new Request('https://example.test/latest'), f.env)).json();
  assert.equal(output.mvp.phase, 1);
  assert.equal(output.mvp.dryRun, true);
  assert.equal(output.mvp.archive.decisions, 2);
  assert.equal(output.observations[0].address, TOKEN);
  f.advance(4 * 3600000); f.changes.head += 14400;
  assert.equal((await collectFree(f.env, { rpc: f.rpc, now: f.now, fetchImpl })).status, 'COMPLETED');
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM runs WHERE id=?').get(first.run_id).n, 0);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_decisions').get().n, 2);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_decision_events').get().n, 4);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_outcomes').get().n, 0);
});

test('collector prioritizes live outcome targets, archives original provider times and recovers expired jobs without a new price fetch', async t => {
  const f = setup(t); f.DB.sqlite.exec(mvpSchema); f.DB.sqlite.exec(outcomeCaptureSchema);
  Object.assign(f.env, { ANALYSIS_ENABLED: '1', MVP_RECORDING_ENABLED: '1' });
  const expiredToken = '0x3333333333333333333333333333333333333333';
  const seedAt = f.now() - 62 * 60000;
  await f.DB.batch(prepareDecisionRecords(f.DB, {
    runId: 'prior-decisions', observedAt: seedAt, scoreVersion: 'prior-test-v1', profile: 'prior-test', policyHash: 'prior-policy',
    decisions: [TOKEN].map(address => ({ address, status: 'REJECTED', isLaunch: true,
      features: { externalMarket: { priceUsd: 1, liquidityUsd: 100 } } }))
  }).commands);
  const expiredSeedAt = seedAt - 10 * 60000;
  await f.DB.batch(prepareDecisionRecords(f.DB, {
    runId: 'older-decision', observedAt: expiredSeedAt, scoreVersion: 'prior-test-v1', profile: 'prior-test', policyHash: 'prior-policy',
    decisions: [{ address: expiredToken, status: 'REJECTED', isLaunch: true,
      features: { externalMarket: { priceUsd: 1, liquidityUsd: 100 } } }]
  }).commands);
  // A stored, genuine point can recover the old +15m window. The other token's
  // +1h window is made expired so it must not consume a provider target slot.
  const { prepareMarketObservations } = await import('../src/mvp/outcomes.mjs');
  const historicalAt = expiredSeedAt + 16 * 60000;
  await f.DB.batch(prepareMarketObservations(f.DB, [{ address: expiredToken, externalMarket: {
    source: 'dexscreener', trust: 'provider-reported', chain: 'robinhood', chainId: 4663,
    baseTokenAddress: expiredToken, quoteTokenAddress: QUOTE_ASSETS.WETH, quoteAsset: 'WETH',
    pairAddress: POOL, pairKind: 'address', fetchedAt: new Date(historicalAt).toISOString(), priceUsd: 0, liquidityUsd: 0
  } }], { runId: 'actual-historical-source', observedAt: historicalAt, refreshed: true }).commands);
  const requested = [];
  const fetchImpl = async url => {
    if (!String(url).includes('dexscreener.com/tokens/')) return Response.json({}, { status: 404 });
    requested.push(String(url));
    return Response.json([{ chainId: 'robinhood', pairAddress: POOL,
      baseToken: { address: TOKEN }, quoteToken: { address: QUOTE_ASSETS.WETH },
      priceUsd: '2', liquidity: { usd: 200 } }], { headers: { 'x-radar-fetched-at': new Date(f.now() - 1000).toISOString() } });
  };
  const result = await collectFree(f.env, { rpc: f.rpc, now: f.now, fetchImpl });
  assert.equal(result.status, 'COMPLETED');
  assert.ok(requested.length > 0);
  assert.ok(requested.every(url => !url.includes(expiredToken)), 'expired jobs must use archive recovery, not current provider requests');
  const rows = f.DB.sqlite.prepare('SELECT d.address,o.horizon,o.source_timestamp,o.price_usd,o.liquidity_usd FROM mvp_outcomes o JOIN mvp_decisions d USING(decision_key)').all();
  const recovered = rows.find(row => row.address === expiredToken && row.horizon === '15m');
  assert.ok(recovered); assert.equal(recovered.source_timestamp, historicalAt);
  assert.equal(recovered.price_usd, 0); assert.equal(recovered.liquidity_usd, 0);
  const current = rows.find(row => row.address === TOKEN && row.horizon === '1h');
  assert.ok(current); assert.equal(current.source_timestamp, f.now() - 1000);
  const archived = f.DB.sqlite.prepare('SELECT * FROM mvp_market_observations WHERE address=?').get(TOKEN);
  assert.ok(archived); assert.equal(archived.source_timestamp, f.now() - 1000);
  const report = JSON.parse(f.DB.sqlite.prepare('SELECT report_json FROM runs').get().report_json);
  assert.ok(report.mvp.outcomeCollection.liveJobs > 0);
  assert.ok(report.mvp.outcomeCollection.diagnostics.some(point => point.result === 'COMPLETE'));
});

test('a lost collector fence rolls back archival rows and their exact counters', async t => {
  const f = setup(t); f.DB.sqlite.exec(mvpSchema);
  f.env.MVP_RECORDING_ENABLED = '1';
  f.DB.beforeBatch = () => f.DB.sqlite.prepare("UPDATE control SET lease_owner='other'").run();
  assert.equal((await collectFree(f.env, { rpc: f.rpc, now: f.now })).status, 'ERROR');
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_decisions').get().n, 0);
  assert.equal(f.DB.sqlite.prepare('SELECT tokens_seen FROM mvp_stats WHERE id=1').get().tokens_seen, 0);
});

test('retornos ABI volumosos não são duplicados fora do audit limitado e não bloqueiam a recolha', async t => {
  const f = setup(t);
  f.rpc.audit = [{ method: 'eth_getLogs', result: 'x'.repeat(100000) }];
  const large = '0x' + '0'.repeat(63) + '1' + 'ab'.repeat(50000);
  f.rpc.batch = async calls => calls.map(([method]) => ({ value: method === 'eth_getCode' ? '0x60006000' : large }));
  assert.equal((await collectFree(f.env, { rpc: f.rpc, now: f.now })).status, 'COMPLETED');
  const evidence = f.DB.sqlite.prepare('SELECT evidence_json FROM runs').get().evidence_json;
  assert.ok(Buffer.byteLength(evidence) < 131072);
  assert.equal(evidence.includes(large), false);
  assert.equal(JSON.parse(evidence).tokenFacts[0].metadataEvidence, 'rpc.audit:eth_call:0x313ce567,0x18160ddd');
});

test('verificações de segurança mantêm a pool por três ciclos e persistem resultados sem renovar provas antigas', async t => {
  const f = setup(t); f.env.ANALYSIS_ENABLED = '1';
  const fetchImpl = async () => Response.json({}, { status: 404 });
  let firstHolderTime;
  for (let phase = 0; phase < 3; phase++) {
    const result = await collectFree(f.env, { rpc: f.rpc, now: f.now, fetchImpl });
    assert.equal(result.status, 'COMPLETED');
    const state = JSON.parse(f.DB.sqlite.prepare('SELECT state_json FROM control').get().state_json);
    assert.equal(state.safetyFocus?.phase ?? null, phase < 2 ? phase + 1 : null);
    assert.equal(state.safetyStates.length, 1);
    assert.equal(state.safetyStates[0].poolId, `v2:${POOL}`);
    const entry = state.screeningEntries[0];
    assert.ok(entry.safety.contract);
    assert.ok(entry.safety.holders);
    assert.ok(entry.safety.liquidity);
    assert.ok(entry.safety.simulation);
    if (phase === 0) firstHolderTime = entry.safety.holders.checkedAt;
    else assert.equal(entry.safety.holders.checkedAt, firstHolderTime);
    if (phase === 2) assert.equal(entry.safety.simulation.reason, 'POOL_IDENTITY_NOT_VERIFIED');
    assert.equal(state.screeningEntries[0].address, TOKEN);
    f.advance(60000); f.changes.head += 60;
  }
});

test('falha não avança cursor e invalida confirmação sem expor URL privada', async t => {
  const f = setup(t); await collectFree(f.env, { rpc: f.rpc, now: f.now });
  const before = JSON.parse(f.DB.sqlite.prepare('SELECT state_json FROM control').get().state_json);
  f.changes.head = 1001; f.changes.failFinal = true;
  const result = await collectFree(f.env, { rpc: f.rpc, now: f.now });
  assert.equal(result.status, 'ERROR'); assert.ok(!JSON.stringify(result).includes('secret'));
  const after = JSON.parse(f.DB.sqlite.prepare('SELECT state_json FROM control').get().state_json);
  assert.equal(after.recentNext, before.recentNext); assert.deepEqual(after.evaluationState, {});
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM runs').get().n, 1);
});

test('fencing impede writer antigo de alterar catálogo ou publicar depois de perder o lease', async t => {
  const f = setup(t);
  f.DB.beforeBatch = () => f.DB.sqlite.prepare("UPDATE control SET lease_owner='replacement',lease_until=?").run(f.now() + 300000);
  assert.equal((await collectFree(f.env, { rpc: f.rpc, now: f.now })).status, 'ERROR');
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM pools').get().n, 0);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
  assert.equal(f.DB.sqlite.prepare('SELECT lease_owner FROM control').get().lease_owner, 'replacement');
});

test('a transação recusa um lease expirado no relógio da base mesmo sem outro writer', async t => {
  const f = setup(t);
  f.DB.beforeBatch = () => f.DB.sqlite.prepare('UPDATE control SET lease_until=?').run(Date.now() - 1000);
  assert.equal((await collectFree(f.env, { rpc: f.rpc, now: f.now })).status, 'ERROR');
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM pools').get().n, 0);
});

test('um URL RPC inválido grava erro e liberta o lease imediatamente', async t => {
  const f = setup(t);
  assert.equal((await collectFree({ ...f.env, ROBINHOOD_RPC_URL: 'invalid-private-key' }, { now: f.now })).status, 'ERROR');
  const control = f.DB.sqlite.prepare('SELECT status,lease_until,lease_owner,last_error FROM control').get();
  assert.equal(control.status, 'ERROR'); assert.equal(control.lease_owner, null); assert.equal(control.lease_until, 0);
  assert.ok(!JSON.stringify(control).includes('invalid-private-key'));
});

test('a aquisição limpa confirmação interrompida atomicamente na linha adquirida', async t => {
  const f = setup(t);
  f.DB.sqlite.prepare("UPDATE control SET status='RUNNING',lease_until=0,state_json=?").run(JSON.stringify({ evaluationState: { old: { lastStatus: 'CANDIDATE' } }, sequence: 41 }));
  f.rpc.request = async () => {
    const state = JSON.parse(f.DB.sqlite.prepare('SELECT state_json FROM control').get().state_json);
    assert.deepEqual(state.evaluationState, {}); assert.equal(state.sequence, 41);
    throw new Error('stop-after-acquisition');
  };
  assert.equal((await collectFree(f.env, { rpc: f.rpc, now: f.now })).status, 'ERROR');
});

test('reorganização reinicia catálogo e não mantém pools de uma história anterior', async t => {
  const f = setup(t); await collectFree(f.env, { rpc: f.rpc, now: f.now });
  f.DB.sqlite.prepare("INSERT INTO pools(id,address,created_block,pool_json) VALUES('orphan',?,500,'{}')").run(TOKEN);
  f.changes.head = 1002; f.changes.reorg = true;
  assert.equal((await collectFree(f.env, { rpc: f.rpc, now: f.now })).status, 'COMPLETED');
  assert.equal(f.DB.sqlite.prepare("SELECT id FROM pools WHERE id='orphan'").get(), undefined);
});

test('D1 remove evidência expirada e saúde não apresenta dados antigos como atuais', async t => {
  const f = setup(t);
  f.DB.sqlite.prepare("INSERT INTO runs VALUES('expired',?,1,'{}','{}')").run(f.now() - 4 * 3600000);
  await collectFree(f.env, { rpc: f.rpc, now: f.now });
  assert.equal(f.DB.sqlite.prepare("SELECT id FROM runs WHERE id='expired'").get(), undefined);
  // O relógio do endpoint é real; gravar um sucesso atual para este teste HTTP.
  f.DB.sqlite.prepare('UPDATE control SET last_success=?').run(Date.now());
  let response = await worker.fetch(new Request('https://example.test/health'), f.env);
  assert.equal(response.status, 200); assert.equal((await response.json()).currentSignalsAvailable, false);
  f.DB.sqlite.prepare('UPDATE control SET last_success=?').run(Date.now() - 400000);
  response = await worker.fetch(new Request('https://example.test/health'), f.env);
  assert.equal(response.status, 503); assert.equal((await response.json()).status, 'STALE');
});

test('catálogo é podado apenas a cada 1440 sucessos e preserva pools antigas enriquecidas recentemente', async t => {
  const f = setup(t); await seedRetentionCatalog(f);
  const options = { rpc: f.rpc, now: f.now };
  const beforePrune = await collectFree(f.env, options);
  assert.equal(beforePrune.status, 'COMPLETED');
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM pools').get().n, 50006,
    'O limite é aplicado na cadência declarada, sem eliminar o catálogo a cada ciclo');
  assert.equal(beforePrune.catalogLimit, 50000);
  assert.equal(beforePrune.retentionCadenceCycles, 1440);
  const firstReport = JSON.parse(f.DB.sqlite.prepare('SELECT report_json FROM runs WHERE id=?').get(beforePrune.runId).report_json);
  assert.equal(firstReport.coverage.catalogLimit, 50000);
  assert.equal(firstReport.coverage.retentionCadenceCycles, 1440);
  f.advance(1000);
  const pruned = await collectFree(f.env, options);
  assert.equal(pruned.status, 'COMPLETED');
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM pools').get().n, 50000);
  assert.equal(f.DB.sqlite.prepare("SELECT last_enriched FROM pools WHERE id='old-selected-for-enrichment'").get().last_enriched, f.now(),
    'O enriquecimento deste ciclo protege uma pool antiga antes da poda');
  assert.ok(f.DB.sqlite.prepare("SELECT id FROM pools WHERE id='old-recently-enriched'").get(),
    'A data antiga de criação não elimina metadados enriquecidos recentemente');
  assert.equal(f.DB.sqlite.prepare("SELECT id FROM pools WHERE id='retention-1'").get(), undefined);
  assert.ok(f.DB.sqlite.prepare("SELECT id FROM pools WHERE id='retention-50003'").get(),
    'Entre pools nunca enriquecidas, permanecem as criações mais recentes');
  assert.equal(JSON.parse(f.DB.sqlite.prepare('SELECT state_json FROM control').get().state_json).sequence, 1440);
});

test('falha após a poda faz rollback do catálogo, enriquecimento e cursor; tentativa seguinte repete a retenção', async t => {
  const f = setup(t); await seedRetentionCatalog(f);
  const initial = JSON.parse(f.DB.sqlite.prepare('SELECT state_json FROM control').get().state_json);
  initial.sequence = 1439;
  f.DB.sqlite.prepare('UPDATE control SET state_json=?').run(JSON.stringify(initial));
  let countSeenAtPublication;
  f.DB.sqlite.function('recordRetentionCount', count => { countSeenAtPublication = count; return 0; });
  f.DB.sqlite.exec(`CREATE TRIGGER fail_retention_publication BEFORE INSERT ON runs BEGIN
    SELECT recordRetentionCount((SELECT count(*) FROM pools));
    SELECT RAISE(ABORT,'fixture-publication-failure');
  END`);
  const options = { rpc: f.rpc, now: f.now };
  assert.equal((await collectFree(f.env, options)).status, 'ERROR');
  assert.equal(countSeenAtPublication, 50000, 'A falha foi injetada depois de a poda ter sido aplicada');
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM pools').get().n, 50005);
  assert.equal(f.DB.sqlite.prepare("SELECT last_enriched FROM pools WHERE id='old-selected-for-enrichment'").get().last_enriched, -1);
  assert.equal(f.DB.sqlite.prepare('SELECT id FROM pools WHERE id=?').get(`v2:${POOL}`), undefined,
    'Uma descoberta na transação falhada também é desfeita');
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
  const failedState = JSON.parse(f.DB.sqlite.prepare('SELECT state_json FROM control').get().state_json);
  assert.equal(failedState.sequence, 1439); assert.equal(failedState.recentNext, initial.recentNext);
  f.DB.sqlite.exec('DROP TRIGGER fail_retention_publication');
  assert.equal((await collectFree(f.env, options)).status, 'COMPLETED');
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM pools').get().n, 50000);
  assert.equal(JSON.parse(f.DB.sqlite.prepare('SELECT state_json FROM control').get().state_json).sequence, 1440);
});

test('RPC recusa outra chain e catálogo fica intacto', async t => {
  const f = setup(t); f.changes.wrongChain = true;
  assert.equal((await collectFree(f.env, { rpc: f.rpc, now: f.now })).status, 'ERROR');
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM pools').get().n, 0);
});

test('intervalos demasiado densos são reduzidos sem truncar ou avançar o trecho não lido', async () => {
  const ranges = [];
  const rpc = { async request(_, [filter]) {
    const from = Number(BigInt(filter.fromBlock)); const to = Number(BigInt(filter.toBlock)); ranges.push([from, to]);
    return to - from > 1 ? Array(9).fill({}) : [];
  } };
  const result = await boundedLogs(rpc, 0, 7, 8);
  assert.deepEqual([result.from, result.to], [0, 1]); assert.deepEqual(ranges, [[0, 7], [0, 3], [0, 1]]);
});

test('transporte RPC valida batches, preserva apenas erros sanitizados e recusa escrita', async () => {
  const rpc = new FreeRpc({ url: 'https://example.test/private-api-key', fetchImpl: async url => { throw new Error(url); } });
  await assert.rejects(rpc.request('eth_sendTransaction', []), /READ_ONLY/);
  await assert.rejects(rpc.request('eth_chainId', []), /RPC_TRANSPORT_FAILED/);
  assert.ok(!JSON.stringify(rpc.audit).includes('private-api-key'));
  const valid = new FreeRpc({ fetchImpl: async (_, options) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result: '0x1237' })) });
  assert.equal(await valid.request('eth_chainId'), '0x1237');
  const invalid = new FreeRpc({ fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 999, result: '0x1237' })) });
  await assert.rejects(invalid.request('eth_chainId'), /INVALID_RPC_ENVELOPE/);
});

test('blocos fixados são pedidos com objeto JSON-RPC isolado e ID exato', async () => {
  const number = 94605582; let request;
  const rpc = new FreeRpc({ fetchImpl: async (_, options) => {
    request = JSON.parse(options.body);
    assert.equal(Array.isArray(request), false);
    assert.deepEqual(request, { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: [hex(number), false] });
    return Response.json({ jsonrpc: '2.0', id: request.id,
      result: { number: hex(number), timestamp: '0x1234', hash: blockHash(number) } });
  } });
  assert.deepEqual(await rpc.block(number), { number, timestamp: 0x1234, hash: blockHash(number) });
});

test('respostas isoladas preservam a validação de forma, IDs e exclusividade result/error', async () => {
  const invalid = [null, [], [{ jsonrpc: '2.0', id: 1, result: '0x1237' }],
    { jsonrpc: '2.0', id: 2, result: '0x1237' },
    { jsonrpc: '2.0', id: '1', result: '0x1237' },
    { jsonrpc: '1.0', id: 1, result: '0x1237' },
    { jsonrpc: '2.0', id: 1 },
    { jsonrpc: '2.0', id: 1, result: null, error: { code: -32000, message: 'remote-private-message' } },
    { jsonrpc: '2.0', id: 1, error: null },
    { jsonrpc: '2.0', id: 1, error: { code: '-32000', message: 'remote-private-message' } },
    { jsonrpc: '2.0', id: 1, error: { code: -32000 } }];
  for (const envelope of invalid) {
    const rpc = new FreeRpc({ fetchImpl: async () => Response.json(envelope) });
    await assert.rejects(rpc.request('eth_chainId'), /^Error: INVALID_RPC_ENVELOPE$/);
    assert.deepEqual(rpc.audit, [{ error: 'INVALID_RPC_ENVELOPE' }]);
  }
  const nullable = new FreeRpc({ fetchImpl: async () => Response.json({ jsonrpc: '2.0', id: 1, result: null }) });
  assert.equal(await nullable.request('eth_getBlockByNumber', ['0x1', false]), null);
});

test('batches reais mantêm arrays, reordenam por ID e sanitizam erros remotos', async () => {
  const rpc = new FreeRpc({ fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body);
    assert.equal(Array.isArray(body), true); assert.equal(body.length, 2);
    return Response.json([
      { jsonrpc: '2.0', id: body[1].id, error: { code: -32000, message: 'remote-private-message' } },
      { jsonrpc: '2.0', id: body[0].id, result: '0x1237' }
    ]);
  } });
  assert.deepEqual(await rpc.batch([['eth_chainId', []], ['eth_getCode', [TOKEN, 'latest']]]), [{ value: '0x1237' }, { error: -32000 }]);
  assert.equal(JSON.stringify(rpc.audit).includes('remote-private-message'), false);
});

test('diagnóstico de envelope inválido inclui só forma, métodos e validações sem payload privado', async () => {
  const rpc = new FreeRpc({ url: 'https://example.test/private-api-key', fetchImpl: async () =>
    Response.json([{ jsonrpc: '2.0', id: 1, result: 'private-response-payload' }]) });
  await assert.rejects(rpc.request('eth_chainId'), error => {
    assert.deepEqual(error.rpcDiagnostic, { methods: ['eth_chainId'], requestShape: 'object',
      responseShape: 'array', responseCount: 1, idsMatch: true, versionsValid: true });
    assert.equal(JSON.stringify(error.rpcDiagnostic).includes('private'), false);
    return true;
  });
});

test('batches reais recusam objeto isolado, respostas em falta e IDs duplicados ou alheios', async () => {
  const good = { jsonrpc: '2.0', id: 1, result: '0x1237' };
  const invalid = [good, [good], [good, good], [good, null], [good, []],
    [good, { ...good, id: 3 }], [good, { ...good, id: '2' }],
    [good, { ...good, id: 2, jsonrpc: '1.0' }],
    [good, { jsonrpc: '2.0', id: 2 }]];
  for (const envelope of invalid) {
    const rpc = new FreeRpc({ fetchImpl: async () => Response.json(envelope) });
    await assert.rejects(rpc.batch([['eth_chainId', []], ['eth_getCode', [TOKEN, 'latest']]]), /^Error: INVALID_RPC_ENVELOPE$/);
    assert.deepEqual(rpc.audit, [{ error: 'INVALID_RPC_ENVELOPE' }]);
  }
});

test('fetch nativo recebe o contexto global exigido pelo runtime Cloudflare', async () => {
  const rpc = new FreeRpc({ fetchImpl: async function (_url, options) {
    assert.equal(this, globalThis);
    return Response.json({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result: '0x1237' });
  } });
  assert.equal(await rpc.request('eth_chainId'), '0x1237');
});

test('redirecionamentos RPC são recusados sem reenviar a chamada a outro destino', async () => {
  let requests = 0;
  const rpc = new FreeRpc({ fetchImpl: async (_url, options) => {
    requests++; assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://other.test/' } });
  } });
  await assert.rejects(rpc.request('eth_chainId'), /RPC_HTTP_302/);
  assert.equal(requests, 1);
});

test('erros HTTP conservam apenas o status e nunca o URL, corpo ou credenciais', async t => {
  for (const status of [403, 429, 503]) {
    const rpc = new FreeRpc({ url: 'https://example.test/private-api-key', fetchImpl: async () =>
      new Response('private-api-key body must stay private', { status }) });
    await assert.rejects(rpc.request('eth_chainId'), new RegExp(`^Error: RPC_HTTP_${status}$`));
    assert.deepEqual(rpc.audit, [{ error: `RPC_HTTP_${status}` }]);
    const f = setup(t);
    f.rpc.request = async () => { throw new Error(`RPC_HTTP_${status}`); };
    assert.deepEqual(await collectFree(f.env, { rpc: f.rpc, now: f.now }), { status: 'ERROR', reason: `RPC_HTTP_${status}` });
    assert.equal(f.DB.sqlite.prepare('SELECT last_error FROM control').get().last_error, `RPC_HTTP_${status}`);
  }
});

test('um bloco denso é paginado sem perder logs nem o declarar completo antes do fim', async t => {
  const f = setup(t);
  const logs = Array.from({ length: 5 }, (_, i) => ({ ...f.log, logIndex: hex(i) }));
  const rpc = { request: async () => logs };
  const first = await boundedLogs(rpc, 995, 995, 2);
  const second = await boundedLogs(rpc, 995, 995, 2, false, first.nextOffset);
  const third = await boundedLogs(rpc, 995, 995, 2, false, second.nextOffset);
  assert.deepEqual([first.nextOffset, second.nextOffset, third.nextOffset], [2, 4, 0]);
  assert.deepEqual([...first.pools, ...second.pools, ...third.pools].map(p => p.creationLogIndex), [0, 1, 2, 3, 4]);
});

test('limite de eventos é global e reserva capacidade para histórico sem perder a paginação recente', async t => {
  const f = setup(t); const original = f.rpc.request.bind(f.rpc);
  f.DB.sqlite.prepare('UPDATE control SET state_json=?').run(JSON.stringify({ recentNext: 995, backfillCursor: 488 }));
  const logs = [
    ...Array.from({ length: 4 }, (_, i) => ({ ...f.log, logIndex: hex(i) })),
    { ...f.log, blockNumber: hex(100), blockHash: blockHash(100), transactionHash: blockHash(50000) }
  ];
  f.rpc.request = async (method, params) => method === 'eth_getLogs'
    ? logs.filter(log => Number(BigInt(log.blockNumber)) >= Number(BigInt(params[0].fromBlock)) && Number(BigInt(log.blockNumber)) <= Number(BigInt(params[0].toBlock)))
    : original(method, params);
  const result = await collectFree(f.env, { rpc: f.rpc, now: f.now });
  assert.equal(result.status, 'COMPLETED'); assert.equal(result.discoveredPoolsThisRun, 4);
  const state = JSON.parse(f.DB.sqlite.prepare('SELECT state_json FROM control').get().state_json);
  assert.equal(state.recentNext, 995); assert.equal(state.recentOffset, 3); assert.equal(state.olderSequence, 1);
});

test('backlog mantém cursor contíguo e observa uma amostra independente perto da cabeça', async t => {
  const f = setup(t); const original = f.rpc.request.bind(f.rpc);
  const freshToken = '0x3333333333333333333333333333333333333333';
  const fresh = { ...f.log, topics: encodeEventTopics({ abi: [EVENTS.v2], eventName: 'PairCreated', args: { token0: QUOTE_ASSETS.WETH, token1: freshToken } }) };
  const old = { ...f.log, blockNumber: hex(100), blockHash: blockHash(100), transactionHash: blockHash(50000) };
  f.DB.sqlite.prepare('UPDATE control SET state_json=?').run(JSON.stringify({ recentNext: 100, backfillCursor: 99 }));
  f.rpc.request = async (method, params) => method === 'eth_getLogs'
    ? [old, fresh].filter(log => Number(BigInt(log.blockNumber)) >= Number(BigInt(params[0].fromBlock)) && Number(BigInt(log.blockNumber)) <= Number(BigInt(params[0].toBlock)))
    : original(method, params);
  const result = await collectFree(f.env, { rpc: f.rpc, now: f.now });
  assert.equal(result.status, 'COMPLETED');
  const state = JSON.parse(f.DB.sqlite.prepare('SELECT state_json FROM control').get().state_json);
  const report = JSON.parse(f.DB.sqlite.prepare('SELECT report_json FROM runs').get().report_json);
  assert.equal(state.recentNext, 612, 'A amostra nunca salta a zona contígua por ler');
  assert.deepEqual(report.coverage.recentRange, [100, 611]);
  assert.deepEqual(report.coverage.latestSampleRange, [937, 1000]);
  assert.equal(report.coverage.latestSampleIsCompleteIndex, false);
  assert.equal(report.snapshots[0].address, freshToken);
  assert.ok(report.coverage.discoveredPoolsThisRun <= 4);
});

test('timestamp futuro na segunda cabeça não comprova saúde do sequenciador', async t => {
  const f = setup(t); const block = f.rpc.block.bind(f.rpc); let heads = 0;
  f.rpc.block = async n => {
    const result = await block(n);
    if ((n === undefined || n === 'latest') && ++heads > 1) return { ...result, number: result.number + 1, timestamp: Math.floor(f.now() / 1000) + 3600 };
    return result;
  };
  assert.equal((await collectFree(f.env, { rpc: f.rpc, now: f.now })).status, 'COMPLETED');
  const report = JSON.parse(f.DB.sqlite.prepare('SELECT report_json FROM runs').get().report_json);
  assert.equal(report.snapshots[0].chainState.sequencerHealthy, undefined);
});

test('latest expõe observação e hora sem apresentar avaliações antigas como sinais atuais', async t => {
  const f = setup(t);
  assert.equal((await worker.fetch(new Request('https://example.test/latest'), f.env)).status, 404);
  await collectFree(f.env, { rpc: f.rpc, now: f.now });
  const response = await worker.fetch(new Request('https://example.test/latest'), f.env);
  const body = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(body.currentSignalsAvailable, false); assert.equal(body.dataQuality, 'PARTIAL');
  assert.equal(body.observations[0].address, TOKEN); assert.equal(body.recordedResults.length, 2);
  assert.equal(body.evidence, undefined);
});

test('MVP phase 2 archives its own profile and keeps legacy results without manufacturing a wallet alert', async t => {
  const f = setup(t); f.DB.sqlite.exec(mvpSchema); f.DB.sqlite.exec(outboxSchema);
  Object.assign(f.env, { MVP_RECORDING_ENABLED: '1', MVP_PHASE: '2' });
  const result = await collectFree(f.env, { rpc: f.rpc, now: f.now });
  assert.equal(result.status, 'COMPLETED');
  const report = JSON.parse(f.DB.sqlite.prepare('SELECT report_json FROM runs').get().report_json);
  assert.equal(report.mvp.phase, 2);
  assert.equal(report.mvp.dryRun, true);
  assert.equal(report.mvp.outbox.prepared, 0);
  assert.equal(report.results.length, 2, 'legacy profiles remain compatible');
  const row = f.DB.sqlite.prepare("SELECT * FROM mvp_decisions WHERE profile='profile_new'").get();
  assert.ok(row); assert.equal(row.first_status, 'INCOMPLETE');
  const features = JSON.parse(row.features_json).values;
  assert.equal(features.decision.score, null);
  assert.equal(features.decision.wallets.realizedPnlUsd, null);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_alert_outbox').get().n, 0);
  const response = await worker.fetch(new Request('https://example.test/latest'), f.env);
  const published = await response.json();
  assert.equal(published.mvp.outbox.stats.queuedDryRun, 0);
  assert.deepEqual(published.mvp.outbox.recent, []);
});

test('MVP phase 3 integrates the permanent wallet ledger and one weekly report without claiming an absent wallet history', async t => {
  const f = setup(t);
  for (const sql of [mvpSchema, outboxSchema, walletSchema, weeklySchema, outcomeCaptureSchema]) f.DB.sqlite.exec(sql);
  Object.assign(f.env, { MVP_RECORDING_ENABLED: '1', MVP_PHASE: '3' });
  for (let i = 0; i < 2; i++) {
    assert.equal((await collectFree(f.env, { rpc: f.rpc, now: f.now })).status, 'COMPLETED');
    f.advance(1000);
  }
  const body = await (await worker.fetch(new Request('https://example.test/latest'), f.env)).json();
  assert.equal(body.mvp.phase, 3);
  assert.equal(body.mvp.wallets.tracked, 0);
  assert.equal(body.mvp.wallets.eligible, 0);
  assert.equal(body.mvp.outbox.stats.queuedDryRun, 0);
  assert.equal(body.recordedResults.length, 2);
  assert.equal(body.mvp.futurePhasesEnabled, false);
  assert.equal(body.mvp.weeklyReport.kind, 'mvp-weekly-observation-report');
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_weekly_reports').get().n, 1);
  assert.equal(f.DB.sqlite.prepare("SELECT count(*) AS n FROM mvp_decisions WHERE profile='profile_new'").get().n, 1);
});
