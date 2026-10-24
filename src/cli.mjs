import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { validateConfig } from './engine.mjs';
import { runScan } from './runner.mjs';

export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  let created = false;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    created = true;
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
  } finally {
    if (file) await file.close();
    if (created) await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function readJson(path) {
  const file = await open(path, 'r');
  try {
    if ((await file.stat()).size > 10 * 1024 * 1024) throw new Error('Ficheiro JSON excede 10 MiB');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    input: { type: 'string', default: 'runtime/inbox.json' },
    output: { type: 'string', default: 'runtime/report.json' },
    config: { type: 'string', default: fileURLToPath(new URL('../config/policies.json', import.meta.url)) },
    pipeline: { type: 'string', default: 'all' },
    watch: { type: 'boolean', default: false },
    'validate-config': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('npm run scan -- --input snapshots.json [--output runtime/report.json] [--pipeline new|established|all] [--watch]\nSem input real, usar npm run demo. Não recolhe dados da rede nem executa ordens.');
    return;
  }
  const config = validateConfig(await readJson(resolve(values.config)));
  if (values['validate-config']) {
    await import('./cloudflare/operations.mjs');
    await import('./mvp/wallet-accounting-config.mjs');
    console.log(`Configuração válida: ${config.version}`); return;
  }
  const pipelines = values.pipeline === 'all' ? Object.keys(config.pipelines) : [values.pipeline];
  if (pipelines.some((id) => !Object.hasOwn(config.pipelines, id))) throw new Error('Pipeline deve ser new, established ou all');
  const input = resolve(values.input);
  const output = resolve(values.output);
  if (input === output || resolve(values.config) === output) throw new Error('Input, configuração e output devem ter caminhos distintos');
  await mkdir(dirname(output), { recursive: true });
  let lock;
  try { lock = await open(`${output}.lock`, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Já existe um lock para este relatório. Confirme se o processo anterior terminou antes de remover o lock.');
    throw error;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    let state = {};
    try {
      const saved = await readJson(output);
      if (!saved.state || typeof saved.state !== 'object' || Array.isArray(saved.state)) throw new Error('Estado anterior inválido');
      state = saved.state;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    do {
      try {
        const snapshots = await readJson(input);
        if (!Array.isArray(snapshots) || snapshots.length > 1000) throw new Error('Esperado array com no máximo 1000 snapshots');
        const report = runScan(snapshots, config, { state, pipelines });
        await atomicJson(output, report);
        state = report.state;
        const summary = report.results.reduce((counts, r) => ({ ...counts, [r.status]: (counts[r.status] ?? 0) + 1 }), {});
        console.log(JSON.stringify({ at: report.evaluatedAt, summary, newAlerts: report.alerts.length }));
      } catch (error) {
        state = {};
        await atomicJson(output, { schemaVersion: 2, evaluatedAt: new Date().toISOString(), mode: 'observe', operationalStatus: 'ERROR',
          error: error.message, results: [], alerts: [], state: {} });
        console.error(`Scan falhou: ${error.message}`);
        if (!values.watch) { process.exitCode = 1; return; }
      }
      if (!values.watch || controller.signal.aborted) break;
      const interval = Math.min(...pipelines.map((p) => config.pipelines[p].pollSeconds));
      await setTimeout(interval * 1000, undefined, { signal: controller.signal }).catch((error) => { if (error.name !== 'AbortError') throw error; });
    } while (!controller.signal.aborted);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await lock.close();
    await unlink(`${output}.lock`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
