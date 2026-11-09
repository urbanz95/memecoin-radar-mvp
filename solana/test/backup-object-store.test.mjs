import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKUP_INDEX_KEY, publishVerifiedBackup, restoreLatestVerifiedBackup,
} from '../src/backup-object-store.mjs';

// Memory-only R2/S3-like adapter: implements create-once and If-Match CAS.
// No real bucket, SDK, credentials, HTTP requests or external services.
class MemoryObjectStore {
  constructor() { this.objects = new Map(); this.counter = 0; }
  putBytes(key, value, options = {}) {
    const prior = this.objects.get(key);
    if (options.ifNoneMatch === '*' && prior)
      throw Error('OBJECT_PRECONDITION_FAILED');
    if (options.ifMatch && options.ifMatch !== prior?.etag)
      throw Error('OBJECT_PRECONDITION_FAILED');
    const etag = 'v' + (++this.counter);
    this.objects.set(key, { data: Buffer.from(value), etag });
    return { etag };
  }
  async putText(key, value, opts) {
    if (typeof value !== 'string') throw Error('ADAPTER_TEXT_REQUIRED');
    return this.putBytes(key, Buffer.from(value), opts);
  }
  async getText(key, { maxBytes } = {}) {
    const item = this.objects.get(key);
    if (!item) return null;
    if (item.data.byteLength > maxBytes) throw Error('ADAPTER_TEXT_LIMIT');
    return { body: item.data.toString('utf8'), etag: item.etag };
  }
  async putFile(key, path, opts) {
    return this.putBytes(key, await readFile(path), opts);
  }
  async getFile(key, path, { maxBytes } = {}) {
    const item = this.objects.get(key);
    if (!item) throw Error('ADAPTER_OBJECT_NOT_FOUND');
    if (item.data.byteLength > maxBytes) throw Error('ADAPTER_FILE_LIMIT');
    await writeFile(path, item.data, { flag: 'wx', mode: 0o600 });
  }
  corrupt(key) {
    const obj = this.objects.get(key);
    const altered = Buffer.from(obj.data);
    altered[altered.length - 1] ^= 0xff;
    this.objects.set(key, { data: altered, etag: 'v' + (++this.counter) });
  }
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'solana-remote-backup-'));
  const db = new DatabaseSync(join(dir, 'live.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE events (id TEXT PRIMARY KEY, slot INTEGER); CREATE TABLE checkpoints (program TEXT PRIMARY KEY, slot INTEGER)');
  db.prepare('INSERT INTO events VALUES (?,?)').run('sig-A', 1);
  db.prepare('INSERT INTO checkpoints VALUES (?,?)').run('pump', 1);
  t.after(() => { db.close(); });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, db, store: new MemoryObjectStore() };
}
const snapshot = ({ db, dir, store }) => publishVerifiedBackup({
  source: db, directory: join(dir, 'snapshots'), store,
});
const restore = ({ dir, store }, name = 'restored.sqlite') => restoreLatestVerifiedBackup({
  store, directory: join(dir, 'snapshots'), destinationPath: join(dir, name),
});

test('complete upload->download->integrity restore->commit->restore with WAL', async t => {
  const f = await fixture(t);
  const r = await snapshot(f);
  assert.equal(r.fullyDownloadedAndRestored, true);
  assert.equal(r.retainedInIndex, 1);
  assert.equal(f.store.objects.size, 3);
  f.db.prepare('INSERT INTO events VALUES (?,?)').run('sig-B', 2);
  const restored = await restore(f);
  assert.equal(restored.fallbackUsed, false);
  assert.deepEqual(restored.tables, { checkpoints: 1, events: 1 });
  const db = new DatabaseSync(join(f.dir, 'restored.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT id FROM events ORDER BY id').all().map(row => row.id), ['sig-A']);
    assert.equal(db.prepare('SELECT slot FROM checkpoints WHERE program=?').get('pump').slot, 1);
  } finally { db.close(); }
});

test('truncated remote archive NEVER publishes a latest pointer', async t => {
  const f = await fixture(t);
  const put = f.store.putFile.bind(f.store);
  f.store.putFile = async (key, path, opts) => {
    await put(key, path, opts);
    f.store.corrupt(key);
  };
  await assert.rejects(snapshot(f), /RESTORE_SHA256_MISMATCH/);
  assert.equal(f.store.objects.has(BACKUP_INDEX_KEY), false);
});

test('failed manifest publication preserves previously verified backup pointer', async t => {
  const f = await fixture(t);
  const first = await snapshot(f);
  const old = (await f.store.getText(BACKUP_INDEX_KEY)).body;
  const put = f.store.putText.bind(f.store);
  f.store.putText = async (key, data, opts) => {
    if (key.endsWith('/manifest.json')) throw Error('SIMULATED_MANIFEST_TIMEOUT');
    return put(key, data, opts);
  };
  await assert.rejects(snapshot(f), /SIMULATED_MANIFEST_TIMEOUT/);
  assert.equal((await f.store.getText(BACKUP_INDEX_KEY)).body, old);
  const result = await restore(f);
  assert.equal(result.entry.id, first.entry.id);
});

test('corrupted latest archive falls back to earlier verified immutable backup', async t => {
  const f = await fixture(t);
  const first = await snapshot(f);
  f.db.prepare('INSERT INTO events VALUES (?,?)').run('sig-B', 2);
  const second = await snapshot(f);
  f.store.corrupt(second.entry.archiveKey);
  const recovered = await restore(f);
  assert.equal(recovered.entry.id, first.entry.id);
  assert.equal(recovered.fallbackUsed, true);
  assert.equal(recovered.earlierFailures.length, 1);
  assert.equal(recovered.tables.events, 1);
});

test('CAS failure does not replace previous latest after competing writer', async t => {
  const f = await fixture(t);
  const first = await snapshot(f);
  const put = f.store.putText.bind(f.store);
  f.store.putText = async (key, data, opts) => {
    if (key === BACKUP_INDEX_KEY && opts?.ifMatch)
      throw Error('OBJECT_PRECONDITION_FAILED');
    return put(key, data, opts);
  };
  await assert.rejects(snapshot(f), /OBJECT_PRECONDITION_FAILED/);
  const pointer = JSON.parse((await f.store.getText(BACKUP_INDEX_KEY)).body);
  assert.equal(pointer.entries[0].id, first.entry.id);
});

test('preexisting target is not touched or replaced, even if remote index exists', async t => {
  const f = await fixture(t);
  await snapshot(f);
  const path = join(f.dir, 'restored.sqlite');
  await writeFile(path, 'must survive');
  await assert.rejects(restore(f), /RESTORE_DESTINATION_EXISTS/);
  assert.equal(await readFile(path, 'utf8'), 'must survive');
});

test('malicious index object key is rejected before fetching any files', async t => {
  const f = await fixture(t);
  const original = await snapshot(f);
  const index = JSON.parse((await f.store.getText(BACKUP_INDEX_KEY)).body);
  index.entries[0].archiveKey = 'not-allowed/random.sqlite';
  f.store.putBytes(BACKUP_INDEX_KEY, Buffer.from(JSON.stringify(index)));
  let called = false;
  const getFile = f.store.getFile.bind(f.store);
  f.store.getFile = (...args) => { called = true; return getFile(...args); };
  await assert.rejects(restore(f), /BACKUP_INDEX_INVALID/);
  assert.equal(called, false);
  assert.ok(original.entry.id);
});

test('all remote backups corrupt fails closed without creating a local database', async t => {
  const f = await fixture(t);
  const result = await snapshot(f);
  f.store.corrupt(result.entry.archiveKey);
  await assert.rejects(restore(f), /RESTORE_NO_VERIFIED_COPY/);
  await assert.rejects(readFile(join(f.dir, 'restored.sqlite')), { code: 'ENOENT' });
});

test('remote missing backup index does not create a local database', async t => {
  const f = await fixture(t);
  await assert.rejects(restore(f), /RESTORE_INDEX_NOT_FOUND/);
  await assert.rejects(readFile(join(f.dir, 'restored.sqlite')), { code: 'ENOENT' });
});

test('byte budget refuses remote archives larger than maximum allowed', async t => {
  const f = await fixture(t);
  const entry = await snapshot(f);
  await assert.rejects(restoreLatestVerifiedBackup({
    store: f.store, directory: join(f.dir, 'snapshots'),
    destinationPath: join(f.dir, 'tiny.sqlite'), maxBytes: 10,
  }), /RESTORE_NO_VERIFIED_COPY/);
  assert.ok(entry.entry.id);
});
