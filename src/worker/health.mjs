import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDocument } from './storage.mjs';
import { healthView } from './service.mjs';

export async function main() {
  try {
    const directory = resolve(process.env.RADAR_DATA_DIR ?? 'runtime/worker');
    const health = healthView(await readDocument(join(directory, 'worker-status.json'), 65536));
    console.log(JSON.stringify(health, null, 2));
    if (health.stale || !['COMPLETED', 'RUNNING'].includes(health.status)) process.exitCode = 1;
  } catch {
    console.error(JSON.stringify({ status: 'ERROR', reason: 'HEALTH_UNREADABLE' })); process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
