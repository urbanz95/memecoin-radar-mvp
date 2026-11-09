import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapR2Backup, loadR2BackupSettings } from '../src/backup-runtime.mjs';
import { publishVerifiedBackup } from '../src/backup-object-store.mjs';
import { Store } from '../src/store.mjs';

const mib = 1048576;
const enabled = {
  SOLANA_R2_BACKUP_ENABLED: 'true',
  SOLANA_R2_ACCOUNT_ID: 'a'.repeat(32),
  SOLANA_R2_ACCESS_KEY_ID: 'fake-access-key',
  SOLANA_R2_SECRET_ACCESS_KEY: 'fake-secret-key',
  SOLANA_R2_BUCKET: 'test-backup-bucket',
  SOLANA_R2_FIRST_DELAY_SECONDS: '5',
};

class Remote {
  constructor() { this.data = new Map(); this.revision = 0; this.down = false; }
  async putText(key, body, options) {
    if (this.down) throw Error('NO_NETWORK');
    return this.put(key, Buffer.from(body), options);
  }
  async putFile(key, path, options) {
    if (this.down) throw Error('NO_NETWORK');
    return this.put(key, await readFile(path), options);
  }
  put(key, bytes, options) {
    const old = this.data.get(key);
    if ((options?.ifNoneMatch === '*' && old) ||
        (options?.ifMatch && options.ifMatch !== old?.etag))
      throw Error('REMOTE_CONDITION_FAILED');
    const etag = '"v' + (++this.revision) + '"';
    this.data.set(key, { data: bytes, etag, time: new Date('2026-11-01T00:00:00Z') });
    return { etag };
  }
  async getText(key) {
    if (this.down) throw Error('NO_NETWORK');
    const value = this.data.get(key);
    return value ? { body: value.data.toString('utf8'), etag: value.etag } : null;
  }
  async getFile(key, path) {
    if (this.down) throw Error('NO_NETWORK');
    const value = this.data.get(key);
    if (!value) throw Error('REMOTE_NOT_FOUND');
    await writeFile(path, value.data, { flag: 'wx' });
  }
  async listObjects({ prefix }) {
    if (this.down) throw Error('NO_NETWORK');
    return { truncated: false, objects: [...this.data].filter(([key]) =>
      key.startsWith(prefix)).map(([key,x]) => ({
        key, size: x.data.length, lastModified: x.time.toISOString(),
      })) };
  }
  async deleteObject(key) { this.data.delete(key); }
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'r2-bootstrap-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'live.sqlite');
  return { dir, path, remote: new Remote() };
}
const start = f => bootstrapR2Backup({
  env: enabled, dbPath: f.path, directory: f.dir,
  storeFactory: async () => f.remote,
});
async function seedRemote(f) {
  const db = new DatabaseSync(f.path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE checkpoints (program TEXT PRIMARY KEY, slot INTEGER)');
  db.prepare('INSERT INTO checkpoints VALUES (?,?)').run('pump', 123);
  await publishVerifiedBackup({
    source: db, directory: f.dir, store: f.remote,
  });
  db.close();
  await rm(f.path);
}

test('disabled backup ignores credentials and does not create DB', async t => {
  const f = await fixture(t);
  assert.deepEqual(loadR2BackupSettings({}), { enabled: false });
  const result = await bootstrapR2Backup({ dbPath: f.path, env: {} });
  assert.equal(result.enabled, false);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});
test('enabled requires all private R2 env settings', () => {
  assert.throws(() => loadR2BackupSettings({
    SOLANA_R2_BACKUP_ENABLED: 'true',
  }), /R2_BACKUP_REQUIRED_CONFIGURATION_MISSING/);
  assert.throws(() => loadR2BackupSettings({
    ...enabled, SOLANA_R2_INTERVAL_MINUTES: '1',
  }), /INVALID_SOLANA_R2_INTERVAL_MINUTES/);
});
test('missing remote snapshot index fails startup closed by default', async t => {
  const f = await fixture(t);
  await assert.rejects(start(f), /R2_BACKUP_RESTORE_REQUIRED/);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});
test('fresh start requires an explicit migration flag and missing index', async t => {
  const f = await fixture(t);
  const out = await bootstrapR2Backup({
    dbPath: f.path, directory: f.dir, storeFactory: async () => f.remote,
    env: { ...enabled, SOLANA_R2_ALLOW_FRESH_START: 'true' },
  });
  assert.equal(out.restoreStatus, 'FRESH_START_EXPLICIT');
  await out.agent.stop();
});
test('restores valid remote snapshot BEFORE opening Scanner Store', async t => {
  const f = await fixture(t);
  await seedRemote(f);
  const out = await start(f);
  assert.equal(out.restoreStatus, 'RESTORED_LATEST');
  const restored = new DatabaseSync(f.path, { readOnly: true });
  assert.equal(restored.prepare('SELECT slot FROM checkpoints WHERE program=?')
    .get('pump').slot, 123);
  restored.close();
  await out.agent.stop();
});
test('local SQLite is preserved when R2 unavailable', async t => {
  const f = await fixture(t);
  await writeFile(f.path, 'do-not-overwrite');
  f.remote.down = true;
  const out = await start(f);
  assert.equal(out.restoreStatus, 'LOCAL_DB_EXISTS');
  assert.equal(await readFile(f.path, 'utf8'), 'do-not-overwrite');
  await out.agent.stop();
});
test('R2 network outage during required restore never creates fresh DB', async t => {
  const f = await fixture(t);
  f.remote.down = true;
  await assert.rejects(bootstrapR2Backup({
    dbPath: f.path, directory: f.dir, storeFactory: async () => f.remote,
    env: { ...enabled, SOLANA_R2_ALLOW_FRESH_START: 'true' },
  }), /R2_BACKUP_RESTORE_REQUIRED/);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});
test('corrupt latest snapshot fails closed even with fresh-start flag', async t => {
  const f = await fixture(t);
  await seedRemote(f);
  const index = JSON.parse((await f.remote.getText('radar-backups/v1/latest.json')).body);
  const archive = f.remote.data.get(index.entries[0].archiveKey);
  archive.data[archive.data.length - 1] ^= 0xff;
  await assert.rejects(bootstrapR2Backup({
    dbPath: f.path, directory: f.dir, storeFactory: async () => f.remote,
    env: { ...enabled, SOLANA_R2_ALLOW_FRESH_START: 'true' },
  }), /R2_BACKUP_RESTORE_REQUIRED/);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});
test('live Store snapshot has real checkpoint counts and sanitized status', async t => {
  const f = await fixture(t);
  const out = await bootstrapR2Backup({
    dbPath: f.path, directory: f.dir, storeFactory: async () => f.remote,
    env: { ...enabled, SOLANA_R2_ALLOW_FRESH_START: 'true' },
  });
  const live = new Store(f.path);
  t.after(() => live.close());
  live.db.prepare('INSERT INTO checkpoints(program_id,updated_at,payload) VALUES(?,?,?)')
    .run('pump', 1, '{"slot":1}');
  out.agent.statfsFn = async () => ({ bavail: 65536, bsize: 65536 });
  const result = await out.agent.once(live.db);
  assert.equal(result.fullyDownloadedAndRestored, true);
  const stat = out.agent.status();
  assert.equal(stat.enabled, true);
  assert.equal(stat.successes, 1);
  assert.equal(stat.lastErrorCode, null);
  assert.equal(JSON.stringify(stat).includes('fake-secret'), false);
  assert.equal(f.remote.data.has('radar-backups/v1/latest.json'), true);
  await out.agent.stop();
});
test('backup refuses insufficient local disk and leaves remote untouched', async t => {
  const f = await fixture(t);
  const out = await bootstrapR2Backup({
    dbPath: f.path, directory: f.dir, storeFactory: async () => f.remote,
    env: { ...enabled, SOLANA_R2_ALLOW_FRESH_START: 'true' },
  });
  const live = new Store(f.path);
  t.after(() => live.close());
  out.agent.statfsFn = async () => ({ bavail: 1, bsize: 4096 });
  await assert.rejects(out.agent.once(live.db),
    /R2_BACKUP_LOCAL_SPACE_INSUFFICIENT/);
  assert.equal(f.remote.data.size, 0);
  await out.agent.stop();
});
test('failed scheduled backup only records an error and does not stop scanner', async t => {
  const f = await fixture(t);
  const out = await bootstrapR2Backup({
    dbPath: f.path, directory: f.dir, storeFactory: async () => f.remote,
    env: { ...enabled, SOLANA_R2_ALLOW_FRESH_START: 'true' },
  });
  const live = new Store(f.path);
  t.after(() => live.close());
  out.agent.statfsFn = async () => ({ bavail: 65536, bsize: 65536 });
  f.remote.down = true;
  let fn;
  out.agent.setTimeoutFn = callback => { fn = callback; return { id: 1 }; };
  out.agent.setIntervalFn = () => ({ id: 2 });
  out.agent.clearTimeoutFn = () => {};
  out.agent.clearIntervalFn = () => {};
  const events = [];
  out.agent.start(live.db, code => events.push(code));
  fn();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(out.agent.status().lastErrorCode, 'R2_BACKUP_TRANSFER_FAILED');
  assert.ok(events.includes('R2_BACKUP_TRANSFER_FAILED'));
  await out.agent.stop();
});
