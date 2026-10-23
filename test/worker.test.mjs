import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, utimes, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker, STALE_MS } from '../src/worker/service.mjs';
import { readDocument, atomicDocument, retainArchives } from '../src/worker/storage.mjs';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'radar-worker-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  let time = Date.now(); let run = 0;
  const result = () => {
    const runId = `test-${++run}`;
    return { payload: { runId, rawEvidenceFile: `runs/${runId}.rpc.json`, collectorHash: 'verified-config',
      operationalStatus: 'PARTIAL', completedAt: new Date(time).toISOString(),
      discovery: { catalog: ['pool'] }, observations: {}, evaluationState: { streak: run },
      coverage: { catalogPools: 1, discoveredTargetContracts: 1 }, observedHead: { number: run }, rpcRequestCount: 10,
      snapshots: [{ address: '0x1111111111111111111111111111111111111111' }],
      results: [{ status: 'INCOMPLETE' }], alerts: [] }, evidence: { runId, rpc: [{ method: 'eth_chainId', result: '0x1237' }] } };
  };
  return { directory, result, now: () => time, advance(ms) { time += ms; },
    worker(collect = async () => result(), options = {}) {
      return new Worker({ directory, now: () => time, collect, minimumFreeBytes: 0, ...options });
    } };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const exists = (path) => access(path).then(() => true, () => false);

test('worker arquiva gzip, confirma o estado e outra instância retoma continuidade', async t => {
  const f = await setup(t);
  assert.equal((await f.worker().runOnce()).status, 'COMPLETED');
  const state = await readDocument(join(f.directory, 'latest.json'));
  const raw = JSON.parse(gunzipSync(await readFile(join(f.directory, state.rawEvidenceFile + '.gz'))));
  assert.equal(raw.runId, state.runId);
  let resumed;
  await f.worker(async ({ previous }) => { resumed = previous; return f.result(); }).runOnce();
  assert.deepEqual(resumed.evaluationState, { streak: 1 });
  const health = await f.worker().health();
  assert.equal(health.status, 'COMPLETED'); assert.equal(health.lastRun.results.INCOMPLETE, 1);
  assert.equal(health.currentSignalsAvailable, false);
});

test('worker não sobrepõe ciclos no mesmo processo', async t => {
  const f = await setup(t); const entered = deferred(); const finish = deferred();
  const worker = f.worker(async () => { entered.resolve(); await finish.promise; return f.result(); });
  const running = worker.runOnce(); await entered.promise;
  assert.equal((await worker.runOnce()).status, 'SKIPPED');
  finish.resolve(); assert.equal((await running).status, 'COMPLETED');
});

test('interrupção sem finally reinicia confirmação e preserva o catálogo', async t => {
  const f = await setup(t); await f.worker().runOnce();
  const health = await readDocument(join(f.directory, 'worker-status.json'));
  await atomicDocument(join(f.directory, 'worker-status.json'), { ...health, status: 'RUNNING' });
  f.advance(301000);
  assert.equal((await f.worker().health()).status, 'ABANDONED');
  let resumed;
  await f.worker(async ({ previous }) => { resumed = previous; return f.result(); }).runOnce();
  assert.deepEqual(resumed.evaluationState, {}); assert.deepEqual(resumed.discovery.catalog, ['pool']);
});

test('falha não publica URL privada e invalida resultados antes do retry', async t => {
  const f = await setup(t); await f.worker().runOnce();
  const old = await f.worker().health();
  const failed = await f.worker(async () => { throw new Error('https://secret-provider/private-key'); }).runOnce();
  assert.equal(failed.status, 'ERROR'); assert.ok(!JSON.stringify(failed).includes('private-key'));
  const state = await readDocument(join(f.directory, 'latest.json'));
  assert.deepEqual(state.results, []); assert.deepEqual(state.evaluationState, {});
  assert.deepEqual(state.discovery.catalog, ['pool']);
  const health = await f.worker().health(); assert.equal(health.lastSuccessAt, old.lastSuccessAt);
  let resumed;
  await f.worker(async ({ previous }) => { resumed = previous; return f.result(); }).runOnce();
  assert.deepEqual(resumed.evaluationState, {});
});

test('estado corrompido permanece intacto e impede recolha', async t => {
  const f = await setup(t); const path = join(f.directory, 'latest.json');
  await writeFile(path, '{truncated'); let called = false;
  await assert.rejects(f.worker(async () => { called = true; return f.result(); }).runOnce(), /INVALID_STATE/);
  assert.equal(await readFile(path, 'utf8'), '{truncated'); assert.equal(called, false);
  assert.equal((await f.worker().health()).status, 'ERROR');
});

test('prazo global vencido descarta dados mesmo se o collector ignorar o abort', async t => {
  const f = await setup(t); const controller = new AbortController();
  const run = await f.worker(async () => { controller.abort(); return f.result(); }).runOnce({ signal: controller.signal });
  assert.equal(run.status, 'ERROR'); assert.equal(run.reason, 'STOPPED');
  assert.deepEqual((await readDocument(join(f.directory, 'latest.json'))).results, []);
  assert.equal(await exists(join(f.directory, 'runs/test-1.rpc.json.gz')), false);
});

test('saúde deteta ausência de ciclos e nunca apresenta sinais antigos como atuais', async t => {
  const f = await setup(t); await f.worker().runOnce(); f.advance(STALE_MS + 1);
  const health = await f.worker().health(); assert.equal(health.status, 'STALE'); assert.equal(health.stale, true);
  assert.equal(health.currentSignalsAvailable, false);
});

test('retenção preserva provas e remove arquivos expirados e excesso de orçamento', async t => {
  const f = await setup(t); const runs = join(f.directory, 'runs'); await mkdir(runs);
  for (const name of ['proof', 'expired', 'recent']) await writeFile(join(runs, name + '.rpc.json.gz'), Buffer.alloc(100));
  const old = new Date(f.now() - 8 * 86400000);
  for (const name of ['proof', 'expired']) await utimes(join(runs, name + '.rpc.json.gz'), old, old);
  const state = { observations: { token: { creation: { evidenceFile: 'runs/proof.rpc.json' } } } };
  const stats = await retainArchives({ directory: f.directory, state, now: f.now(), maxBytes: 120, minimumFreeBytes: 0 });
  assert.equal(stats.deleted, 2); assert.equal(stats.pinnedBytes, 100);
  assert.equal(await exists(join(runs, 'proof.rpc.json.gz')), true);
  await assert.rejects(retainArchives({ directory: f.directory, state, maxBytes: 50, minimumFreeBytes: 0 }), /ARCHIVE_BUDGET_EXCEEDED/);
});

test('quota de arquivos impede avançar catálogo e preserva as provas atuais', async t => {
  const f = await setup(t); await f.worker().runOnce();
  const failed = await f.worker(undefined, { maxArchiveBytes: 1 }).runOnce();
  assert.equal(failed.reason, 'ARCHIVE_BUDGET_EXCEEDED');
  const latest = await readDocument(join(f.directory, 'latest.json'));
  assert.deepEqual(latest.discovery.catalog, ['pool']);
  assert.equal(await exists(join(f.directory, 'runs/test-1.rpc.json.gz')), true);
});

test('temporários de rename abandonados são removidos sem tocar em locks ou outros ficheiros', async t => {
  const f = await setup(t);
  const orphan = join(f.directory, 'latest.json.12345678-1234-1234-1234-123456789abc.tmp');
  await writeFile(orphan, 'partial'); await writeFile(join(f.directory, 'worker.lock'), '');
  await f.worker().runOnce();
  assert.equal(await exists(orphan), false); assert.equal(await exists(join(f.directory, 'worker.lock')), true);
});

test('flock exclui outro processo e o kernel liberta o lock após SIGKILL', { timeout: 10000 }, async t => {
  const f = await setup(t); const path = join(f.directory, 'worker.lock');
  const ready = join(f.directory, 'ready');
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = spawn('flock', ['--no-fork', '--nonblock', path, process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},1000)', ready], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  for (let i = 0; i < 100 && !await exists(ready); i++) await delay(20);
  assert.ok(await exists(ready), 'Processo não ficou pronto');
  assert.equal(spawnSync('flock', ['--nonblock', path, '/bin/true'], { env }).status, 1);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.equal(spawnSync('flock', ['--nonblock', path, '/bin/true'], { env }).status, 0);
});
