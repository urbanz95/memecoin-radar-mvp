import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOfflineSnapshot, restoreOfflineSnapshot } from '../src/backup-offline.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'radar-backup-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(join(dir, 'source.sqlite'));
  t.after(() => db.close());
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE evidence (signature TEXT PRIMARY KEY, slot INTEGER NOT NULL); CREATE TABLE checkpoints (program TEXT PRIMARY KEY, slot INTEGER NOT NULL);');
  db.prepare('INSERT INTO evidence VALUES (?,?)').run('abc', 7);
  db.prepare('INSERT INTO checkpoints VALUES (?,?)').run('pump', 7);
  return { dir, db };
}
test('consistent WAL snapshot restores original event and checkpoint rows', async t => {
  const { dir, db } = await fixture(t);
  const snap = await createOfflineSnapshot(db, { directory: join(dir, 'snapshots') });
  db.prepare('INSERT INTO evidence VALUES (?,?)').run('later', 8);
  const dest = join(dir, 'restored.sqlite');
  const result = await restoreOfflineSnapshot({ archivePath: snap.archivePath, manifest: snap.manifest, destinationPath: dest });
  assert.deepEqual(result.tables, { checkpoints: 1, evidence: 1 });
  const restored = new DatabaseSync(dest, { readOnly: true });
  assert.equal(restored.prepare('SELECT slot FROM checkpoints WHERE program=?').get('pump').slot, 7);
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM evidence').get().n, 1);
  restored.close();
});
test('tampered archive is rejected without creating destination', async t => {
  const { dir, db } = await fixture(t);
  const snap = await createOfflineSnapshot(db, { directory: join(dir, 'snapshots') });
  const bytes = await readFile(snap.archivePath);
  bytes[16] ^= 0xff;
  await writeFile(snap.archivePath, bytes);
  const dest = join(dir, 'restored.sqlite');
  await assert.rejects(restoreOfflineSnapshot({ archivePath: snap.archivePath, manifest: snap.manifest, destinationPath: dest }), /RESTORE_SHA256_MISMATCH/);
  await assert.rejects(readFile(dest), { code: 'ENOENT' });
});
test('existing local DB is never overwritten', async t => {
  const { dir, db } = await fixture(t);
  const snap = await createOfflineSnapshot(db, { directory: join(dir, 'snapshots') });
  const dest = join(dir, 'restored.sqlite');
  await writeFile(dest, 'do-not-replace');
  await assert.rejects(restoreOfflineSnapshot({ archivePath: snap.archivePath, manifest: snap.manifest, destinationPath: dest }), { code: 'EEXIST' });
  assert.equal(await readFile(dest, 'utf8'), 'do-not-replace');
});
test('manifest count mismatch is rejected without publishing a restored DB', async t => {
  const { dir, db } = await fixture(t);
  const snap = await createOfflineSnapshot(db, { directory: join(dir, 'snapshots') });
  const dest = join(dir, 'restored.sqlite');
  const manifest = { ...snap.manifest, tables: { ...snap.manifest.tables, evidence: 123 } };
  await assert.rejects(restoreOfflineSnapshot({ archivePath: snap.archivePath, manifest, destinationPath: dest }), /RESTORE_SCHEMA_OR_ROWS_MISMATCH/);
  await assert.rejects(readFile(dest), { code: 'ENOENT' });
});
