import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson } from '../src/cli.mjs';
import { fixture } from '../examples/fixtures.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
// A CLI é uma aplicação independente, não um worker do runner de testes.
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
const run = (...args) => exec(process.execPath, [cli, ...args], { env: childEnv });
const parse = async (file) => JSON.parse(await readFile(file, 'utf8'));
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'memecoin-radar-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.json');
  const output = join(directory, 'output.json');
  const now = Date.now();
  const snapshot = fixture('new', now);
  snapshot.contractCreatedAt = new Date(now - 2 * 3600000).toISOString();
  snapshot.market.oldestPoolCreatedAt = new Date(now - 100 * 60000).toISOString();
  await writeFile(input, JSON.stringify([snapshot]));
  return { directory, input, output };
}

test('CLI persiste estado, não conta a mesma observação duas vezes e invalida após input corrompido', async (t) => {
  const { input, output } = await setup(t);
  const args = ['--input', input, '--output', output, '--pipeline', 'new'];
  await run(...args);
  const first = await parse(output);
  assert.equal(first.results[0].status, 'CONFIRMING');
  assert.equal(Object.values(first.state)[0].count, 1);
  await run(...args);
  assert.equal(Object.values((await parse(output)).state)[0].count, 1);
  await writeFile(input, '{broken');
  await assert.rejects(run(...args));
  const failed = await parse(output);
  assert.equal(failed.operationalStatus, 'ERROR');
  assert.deepEqual(failed.results, []);
  assert.deepEqual(failed.alerts, []);
  assert.deepEqual(failed.state, {});
  await assert.rejects(access(`${output}.lock`));
});

test('CLI recusa dois workers no mesmo relatório sem apagar o lock do outro', async (t) => {
  const { input, output } = await setup(t);
  await writeFile(`${output}.lock`, 'outro-worker');
  await assert.rejects(run('--input', input, '--output', output), { code: 1 });
  assert.equal(await readFile(`${output}.lock`, 'utf8'), 'outro-worker');
});

test('CLI não sobrescreve input nem aceita rede/pipeline desconhecido', async (t) => {
  const { input, output } = await setup(t);
  const original = await readFile(input, 'utf8');
  await assert.rejects(run('--input', input, '--output', input), { code: 1 });
  assert.equal(await readFile(input, 'utf8'), original);
  await assert.rejects(run('--input', input, '--output', output, '--pipeline', 'base'), { code: 1 });
});

test('escrita atómica não apaga ficheiros temporários que não criou', async (t) => {
  const { output } = await setup(t);
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, 'sentinela');
  await assert.rejects(atomicJson(output, { anything: true }), { code: 'EEXIST' });
  assert.equal(await readFile(temporary, 'utf8'), 'sentinela');
});

test('CLI rejeita snapshots sintéticos antigos em vez de os apresentar como atuais', async (t) => {
  const { input, output } = await setup(t);
  const old = fixture();
  const now = Date.now();
  old.contractCreatedAt = new Date(now - 2 * 3600000).toISOString();
  old.market.oldestPoolCreatedAt = new Date(now - 100 * 60000).toISOString();
  for (const group of ['security', 'holders', 'market', 'activity', 'liquidityProtection', 'quote']) old[group].checkedAt = new Date(now - 3600000).toISOString();
  await writeFile(input, JSON.stringify([old]));
  await run('--input', input, '--output', output, '--pipeline', 'new');
  const report = await parse(output);
  assert.equal(report.results[0].status, 'INCOMPLETE');
  assert.equal(report.results[0].evidenceExpiresAt, null);
  assert.deepEqual(report.alerts, []);
});

test('watch executa, recebe SIGTERM e liberta o lock', async (t) => {
  const { input, output } = await setup(t);
  const child = spawn(process.execPath, [cli, '--input', input, '--output', output, '--pipeline', 'new', '--watch'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL'); });
  let written = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await access(output); written = true; break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  assert.equal(written, true, 'watch deve publicar um relatório');
  child.kill('SIGTERM');
  const result = await completed;
  assert.equal(result.code, 0);
  assert.equal((await parse(output)).results[0].status, 'CONFIRMING');
  await assert.rejects(access(`${output}.lock`));
});
