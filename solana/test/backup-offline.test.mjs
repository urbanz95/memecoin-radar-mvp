import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOfflineSnapshot, restoreOfflineSnapshot } from '../src/backup-offline.mjs';
import { Store } from '../src/store.mjs';

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

test('actual scanner Store tables and checkpoints survive a full offline roundtrip', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'real-store-backup-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const live = new Store(join(dir, 'live.sqlite'));
  t.after(() => live.close());
  live.db.prepare('INSERT INTO checkpoints(program_id,updated_at,payload) VALUES(?,?,?)')
    .run('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 100, '{"slot":123}');
  live.db.prepare('INSERT INTO gaps(created_at,code,payload) VALUES(?,?,?)')
    .run(100, 'TEST_GAP', '{"reason":"offline test"}');
  const snap = await createOfflineSnapshot(live.db, { directory: join(dir, 'snapshots') });
  assert.ok(Object.keys(snap.manifest.tables).length >= 15);
  assert.equal(snap.manifest.tables.checkpoints, 1);
  assert.equal(snap.manifest.tables.gaps, 1);
  const dest = join(dir, 'restored.sqlite');
  await restoreOfflineSnapshot({ archivePath: snap.archivePath, manifest: snap.manifest, destinationPath: dest });
  const restored = new Store(dest);
  try {
    assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get().n, 1);
    assert.equal(restored.db.prepare('SELECT code FROM gaps LIMIT 1').get().code, 'TEST_GAP');
  } finally {
    restored.close();
  }
});
