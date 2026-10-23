import { open, mkdir, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, readJson } from '../cli.mjs';
import { validateConfig } from '../engine.mjs';
import { collectOnce, validateCollectorConfig } from './collect.mjs';

async function loadState(path) {
  let file;
  try {
    file = await open(path, 'r');
    if ((await file.stat()).size > 200 * 1024 * 1024) throw new Error('Estado do collector excede 200 MiB');
    const value = JSON.parse(await file.readFile('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Estado do collector inválido');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  finally { await file?.close(); }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    config: { type: 'string', default: fileURLToPath(new URL('../../config/collector.json', import.meta.url)) },
    policy: { type: 'string', default: fileURLToPath(new URL('../../config/policies.json', import.meta.url)) },
    output: { type: 'string', default: 'runtime/onchain' },
    watch: { type: 'boolean', default: false },
    'max-tokens': { type: 'string' }, 'recent-hours': { type: 'string' }, 'backfill-chunks': { type: 'string' },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('npm run collect -- [--watch] [--max-tokens 8] [--recent-hours 2] [--backfill-chunks 2] [--output runtime/onchain]\nRPC: ROBINHOOD_RPC_URL opcional, ou endpoint público oficial. Apenas leitura; sem chaves de carteira.');
    return;
  }
  const config = await readJson(resolve(values.config));
  for (const [option, field] of [['max-tokens', 'maxTokensPerRun'], ['recent-hours', 'recentHours'], ['backfill-chunks', 'backfillChunksPerVenue']]) {
    if (values[option] !== undefined) config[field] = Number(values[option]);
  }
  validateCollectorConfig(config);
  const policy = validateConfig(await readJson(resolve(values.policy)));
  const directory = resolve(values.output);
  await mkdir(directory, { recursive: true });
  const latest = join(directory, 'latest.json');
  let lock;
  try { lock = await open(`${latest}.lock`, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Já existe um collector para este diretório; verificar o processo antes de remover o lock'); throw error; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    let previous = await loadState(latest);
    do {
      try {
        const { payload, evidence } = await collectOnce({ config, policy, previous });
        // A evidência é imutável por run e precede o commit do bundle atual.
        await atomicJson(join(directory, payload.rawEvidenceFile), evidence);
        await atomicJson(join(directory, 'runs', `${payload.runId}.snapshots.json`), payload.snapshots);
        await atomicJson(latest, payload);
        previous = payload;
        const statuses = payload.results.reduce((all, r) => ({ ...all, [r.status]: (all[r.status] ?? 0) + 1 }), {});
        console.log(JSON.stringify({ runId: payload.runId, operationalStatus: payload.operationalStatus,
          block: payload.observedHead.number, catalogPools: payload.coverage.catalogPools,
          targetContracts: payload.coverage.discoveredTargetContracts, enrichedContracts: payload.snapshots.length,
          rpcRequests: payload.rpcRequestCount, statuses, alerts: payload.alerts.length }));
      } catch (error) {
        // Nunca escrever a URL RPC: pode conter API keys. Manter o catálogo
        // anterior para retomar a descoberta, mas invalidar sinais/continuidade.
        const failed = { schemaVersion: 1, collectorHash: previous.collectorHash,
          completedAt: new Date().toISOString(), operationalStatus: 'ERROR',
          error: error.code ?? 'COLLECTION_FAILED', snapshots: [], results: [], alerts: [], evaluationState: {},
          discovery: previous.discovery, observations: previous.observations };
        await atomicJson(latest, failed);
        previous = failed;
        console.error(`Recolha falhou (${failed.error}); resultados atuais invalidados.`);
        if (!values.watch) { process.exitCode = 1; return; }
      }
      if (!values.watch || controller.signal.aborted) break;
      await delay(config.pollSeconds * 1000, undefined, { signal: controller.signal }).catch((error) => { if (error.name !== 'AbortError') throw error; });
    } while (!controller.signal.aborted);
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await lock.close(); await unlink(`${latest}.lock`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('Não foi possível iniciar o collector. Verificar configuração, estado e lock; nenhum segredo foi registado.');
  process.exitCode = 1;
});
