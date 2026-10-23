import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { collectOnce, validateCollectorConfig } from '../onchain/collect.mjs';
import { validateConfig } from '../engine.mjs';
import { Worker } from './service.mjs';

function setting(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('INVALID_WORKER_CONFIG');
  return value;
}
export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { once: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  if (values.help) { console.log('npm run worker -- [--once]. Linux + flock; variáveis RADAR_DATA_DIR, RADAR_POLL_SECONDS, RADAR_RETENTION_DAYS, RADAR_MAX_ARCHIVE_BYTES.'); return; }
  const directory = resolve(process.env.RADAR_DATA_DIR ?? 'runtime/worker');
  const pollMs = setting('RADAR_POLL_SECONDS', 60, 10, 86400) * 1000;
  const base = JSON.parse(await readFile(new URL('../../config/collector.json', import.meta.url), 'utf8'));
  const config = { ...base, maxTokensPerRun: 4, backfillChunksPerVenue: 1, maxRpcRequests: 800, timeoutMs: 12000, retries: 1 };
  validateCollectorConfig(config);
  const policy = validateConfig(JSON.parse(await readFile(new URL('../../config/policies.json', import.meta.url), 'utf8')));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const worker = new Worker({ directory,
      retentionDays: setting('RADAR_RETENTION_DAYS', 7, 1, 90),
      maxArchiveBytes: setting('RADAR_MAX_ARCHIVE_BYTES', 8 * 1024 ** 3, 1024 ** 2, 100 * 1024 ** 3),
      collect: ({ previous, signal }) => collectOnce({ config, policy, previous, signal }) });
    while (!controller.signal.aborted) {
      const start = Date.now();
      const result = await worker.runOnce({ signal: controller.signal });
      console.log(JSON.stringify({ component: 'collector-worker', ...result }));
      if (values.once) { if (result.status === 'ERROR') process.exitCode = 1; break; }
      if (controller.signal.aborted) break;
      const wait = Math.max(result.status === 'ERROR' ? 15000 : 5000, pollMs - (Date.now() - start));
      await delay(wait, undefined, { signal: controller.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
    }
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error(JSON.stringify({ component: 'collector-worker', status: 'FATAL', reason: 'CHECK_CONFIG_STORAGE_AND_HEALTH_FILE' }));
  process.exitCode = 1;
});
