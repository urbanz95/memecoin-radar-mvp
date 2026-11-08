// One-shot synthetic disk/CPU/RSS benchmark. NEVER runs in Render production.
// Usage: node solana/backup-r2/capacity-bench.mjs 64|128|256
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createOfflineSnapshot, restoreOfflineSnapshot } from '../src/backup-offline.mjs';

const mib = Number(process.argv[2]);
if (![64, 128, 256].includes(mib))
  throw Error('BENCH_SIZE_MUST_BE_64_128_OR_256_MIB');
const dir = await mkdtemp(join(tmpdir(), 'solana-radar-bench-'));
const dbPath = join(dir, 'synthetic.sqlite');
const db = new DatabaseSync(dbPath);
let maxObservedRss = process.memoryUsage().rss;
const ticker = setInterval(() => {
  maxObservedRss = Math.max(maxObservedRss, process.memoryUsage().rss);
}, 100);
let closed = false;
try {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; CREATE TABLE payload (seq INTEGER PRIMARY KEY, bytes BLOB NOT NULL)');
  const insert = db.prepare('INSERT INTO payload(seq,bytes) VALUES(?,?)');
  const t0 = performance.now();
  // Random, mostly incompressible payloads are a pessimistic size baseline.
  // One MiB per row; does not model exact live scanner data distribution.
  for (let i = 0; i < mib; i++) insert.run(i, randomBytes(1024 * 1024));
  const populatedAt = performance.now();
  const snapshot = await createOfflineSnapshot(db, {
    directory: join(dir, 'snapshots'),
    maxBytes: 512 * 1024 * 1024,
  });
  const snapAt = performance.now();
  const restoredPath = join(dir, 'recovered.sqlite');
  const result = await restoreOfflineSnapshot({
    archivePath: snapshot.archivePath,
    manifest: snapshot.manifest,
    destinationPath: restoredPath,
    maxBytes: 512 * 1024 * 1024,
  });
  const restoredAt = performance.now();
  assert: {
    const reopened = new DatabaseSync(restoredPath, { readOnly: true });
    try {
      if (reopened.prepare('SELECT COUNT(*) n FROM payload').get().n !== mib)
        throw Error('BENCH_RESTORE_ROW_COUNT_INCORRECT');
    } finally { reopened.close(); }
  }
  db.close(); closed = true;
  const archiveBytes = (await stat(snapshot.archivePath)).size;
  const restoredDbBytes = (await stat(restoredPath)).size;
  console.log('SOLANA_BACKUP_CAPACITY_BENCH ' + JSON.stringify({
    syntheticPayloadMiB: mib,
    payloadKind: 'random_incompressible_not_real_scanner_db',
    populateMs: Math.round(populatedAt - t0),
    snapshotAndCompressMs: Math.round(snapAt - populatedAt),
    offlineRestoreMs: Math.round(restoredAt - snapAt),
    compressedArchiveMiB: +(archiveBytes / 1048576).toFixed(2),
    restoredDbMiB: +(restoredDbBytes / 1048576).toFixed(2),
    observedMaxProcessRssMiB: +(Math.max(maxObservedRss, process.memoryUsage().rss) / 1048576).toFixed(2),
    integrityVerified: true,
    restoredRows: result.tables.payload,
    solanaRpcCalls: 0, r2Calls: 0,
    limitations: 'GitHub runner hardware, not Render Free; sampled RSS, not exact kernel process peak; includes no network.',
  }));
} finally {
  clearInterval(ticker);
  if (!closed) db.close();
  await rm(dir, { recursive: true, force: true });
}
