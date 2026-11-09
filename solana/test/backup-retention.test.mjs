import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_INDEX_KEY } from '../src/backup-object-store.mjs';
import { pruneUnreferencedBackupObjects } from '../src/backup-retention.mjs';

const ROOT = 'radar-backups/v1/';
const LIVE_ID = '11111111-1111-4111-8111-111111111111';
const ORPHAN_ID = '22222222-2222-4222-8222-222222222222';
const RECENT_ID = '33333333-3333-4333-8333-333333333333';
const keys = id => ({
  archiveKey: ROOT + id + '/snapshot.sqlite.gz',
  manifestKey: ROOT + id + '/manifest.json',
});
const older = '2026-11-01T00:00:00.000Z';
const recent = '2026-11-08T21:59:00.000Z';
const currentTime = Date.parse('2026-11-08T22:00:00.000Z');

class MemoryRetentionStore {
  constructor() {
    const active = {
      id: LIVE_ID, ...keys(LIVE_ID), createdAt: '2026-11-08T20:00:00Z',
      sha256: 'a'.repeat(64),
    };
    this.index = JSON.stringify({
      format: 'solana-radar-backup-index-v1', entries: [active],
    });
    this.etag = '"live-v1"';
    this.deleted = [];
    this.objects = [
      { key: BACKUP_INDEX_KEY, lastModified: older, size: 100 },
      { key: active.archiveKey, lastModified: older, size: 100 },
      { key: active.manifestKey, lastModified: older, size: 100 },
      { key: keys(ORPHAN_ID).archiveKey, lastModified: older, size: 100 },
      { key: keys(ORPHAN_ID).manifestKey, lastModified: older, size: 100 },
      { key: keys(RECENT_ID).archiveKey, lastModified: recent, size: 100 },
      { key: ROOT + 'unknown/not-a-snapshot.zip', lastModified: older, size: 100 },
      { key: 'different-project/private.txt', lastModified: older, size: 100 },
    ];
    this.truncated = false;
  }
  async getText(key) {
    if (key !== BACKUP_INDEX_KEY) return null;
    return { body: this.index, etag: this.etag };
  }
  async listObjects({ prefix, maxKeys }) {
    assert.equal(prefix, ROOT);
    assert.equal(maxKeys, 1000);
    return { objects: this.objects, truncated: this.truncated };
  }
  async deleteObject(key) {
    this.deleted.push(key);
    this.objects = this.objects.filter(x => x.key !== key);
  }
}

const args = store => ({ store, now: () => currentTime });

test('dry-run reports only old orphan objects without deleting anything', async () => {
  const store = new MemoryRetentionStore();
  const result = await pruneUnreferencedBackupObjects(args(store));
  assert.equal(result.dryRun, true);
  assert.equal(result.eligibleObjects, 2);
  assert.equal(result.deleted, 0);
  assert.equal(result.protectedCount, 2);
  assert.deepEqual(store.deleted, []);
});

test('actual deletion requires separate explicit approval', async () => {
  const store = new MemoryRetentionStore();
  await assert.rejects(pruneUnreferencedBackupObjects({
    ...args(store), execute: true,
  }), /EXPLICIT_APPROVAL_REQUIRED/);
  assert.equal(store.deleted.length, 0);
});

test('approved cleanup never deletes latest, recent, unrelated or malformed keys', async () => {
  const store = new MemoryRetentionStore();
  const result = await pruneUnreferencedBackupObjects({
    ...args(store), execute: true, acknowledgeDataDeletion: true,
  });
  assert.equal(result.deleted, 2);
  assert.deepEqual(new Set(store.deleted), new Set([
    keys(ORPHAN_ID).archiveKey, keys(ORPHAN_ID).manifestKey,
  ]));
  assert.ok(store.objects.some(x => x.key === keys(LIVE_ID).archiveKey));
  assert.ok(store.objects.some(x => x.key === keys(RECENT_ID).archiveKey));
  assert.ok(store.objects.some(x => x.key === BACKUP_INDEX_KEY));
});

test('a changing latest ETag aborts deletion before touching objects', async () => {
  const store = new MemoryRetentionStore();
  const read = store.getText.bind(store);
  let reads = 0;
  store.getText = async (...x) => {
    const response = await read(...x);
    reads++;
    return { ...response, etag: reads > 1 ? '"changed"' : response.etag };
  };
  await assert.rejects(pruneUnreferencedBackupObjects({
    ...args(store), execute: true, acknowledgeDataDeletion: true,
  }), /BACKUP_RETENTION_INDEX_CHANGED/);
  assert.deepEqual(store.deleted, []);
});

test('truncated object listing blocks deletion', async () => {
  const store = new MemoryRetentionStore();
  store.truncated = true;
  await assert.rejects(pruneUnreferencedBackupObjects({
    ...args(store), execute: true, acknowledgeDataDeletion: true,
  }), /BACKUP_RETENTION_LISTING_INCOMPLETE/);
  assert.equal(store.deleted.length, 0);
});

test('missing or malformed latest pointer blocks deletion', async () => {
  const store = new MemoryRetentionStore();
  store.getText = async () => null;
  await assert.rejects(pruneUnreferencedBackupObjects(args(store)),
    /BACKUP_RETENTION_INDEX_MISSING/);
  store.getText = async () => ({ body: '{"entries":[]}', etag: '"bad"' });
  await assert.rejects(pruneUnreferencedBackupObjects(args(store)),
    /BACKUP_INDEX_INVALID/);
  assert.equal(store.deleted.length, 0);
});

test('delete cap and minimum age cannot be bypassed', async () => {
  const store = new MemoryRetentionStore();
  await assert.rejects(pruneUnreferencedBackupObjects({
    ...args(store), maxDeletes: 1000,
  }), /BACKUP_RETENTION_ARGUMENTS_INVALID/);
  await assert.rejects(pruneUnreferencedBackupObjects({
    ...args(store), graceMs: 1000,
  }), /BACKUP_RETENTION_ARGUMENTS_INVALID/);
});

test('orphan objects newer than 48h remain protected by grace period', async () => {
  const store = new MemoryRetentionStore();
  store.objects = store.objects.map(x => ({
    ...x,
    lastModified: x.key.includes(ORPHAN_ID) ? recent : x.lastModified,
  }));
  const result = await pruneUnreferencedBackupObjects({
    ...args(store), execute: true, acknowledgeDataDeletion: true,
  });
  assert.equal(result.deleted, 0);
  assert.equal(result.eligibleObjects, 0);
  assert.deepEqual(store.deleted, []);
});
