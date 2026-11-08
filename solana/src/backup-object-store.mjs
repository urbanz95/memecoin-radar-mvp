// Transport-neutral R2-compatible backup protocol. NO configured network,
// credentials, cron, server hooks, deployment, or public API surface.
// An adapter is injected by the caller; tests use a memory adapter only.
import { randomUUID } from 'node:crypto';
import { readFile, lstat, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createOfflineSnapshot, restoreOfflineSnapshot } from './backup-offline.mjs';

export const BACKUP_INDEX_KEY = 'radar-backups/v1/latest.json';
const INDEX_FORMAT = 'solana-radar-backup-index-v1';
const ROOT = 'radar-backups/v1/';
const MAX_HISTORY = 3;
const MAX_INDEX_BYTES = 16384;
const MAX_MANIFEST_BYTES = 65536;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const isTime = x => typeof x === 'string' && Number.isFinite(Date.parse(x));

function validateStore(store) {
  for (const method of ['getText', 'putText', 'getFile', 'putFile'])
    if (typeof store?.[method] !== 'function')
      throw Error('BACKUP_STORE_ADAPTER_INVALID');
}

function keys(id) {
  return {
    archiveKey: ROOT + id + '/snapshot.sqlite.gz',
    manifestKey: ROOT + id + '/manifest.json',
  };
}

function validateEntry(e) {
  if (!e || !UUID.test(e.id ?? '') || !SHA.test(e.sha256 ?? '') ||
      !isTime(e.createdAt)) throw Error('BACKUP_INDEX_INVALID');
  const expected = keys(e.id);
  if (e.archiveKey !== expected.archiveKey ||
      e.manifestKey !== expected.manifestKey)
    throw Error('BACKUP_INDEX_INVALID');
}

function parseIndex(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_INDEX_BYTES)
    throw Error('BACKUP_INDEX_INVALID');
  let doc;
  try { doc = JSON.parse(text); }
  catch { throw Error('BACKUP_INDEX_INVALID'); }
  if (doc?.format !== INDEX_FORMAT || !Array.isArray(doc.entries) ||
      !doc.entries.length || doc.entries.length > MAX_HISTORY)
    throw Error('BACKUP_INDEX_INVALID');
  const ids = new Set();
  for (const e of doc.entries) {
    validateEntry(e);
    if (ids.has(e.id)) throw Error('BACKUP_INDEX_INVALID');
    ids.add(e.id);
  }
  return doc;
}

async function readIndex(store) {
  const result = await store.getText(BACKUP_INDEX_KEY, { maxBytes: MAX_INDEX_BYTES });
  if (result === null) return null;
  if (typeof result?.etag !== 'string' || !result.etag ||
      typeof result?.body !== 'string') throw Error('BACKUP_INDEX_INVALID');
  return { ...parseIndex(result.body), etag: result.etag };
}

// Publish a fresh local SQLite backup as immutable objects, verify the exact
// bytes by reading back and fully restoring, then commit a CAS-protected pointer.
// A failure before that final pointer update leaves the old latest intact.
// Remote orphan objects can be cleaned up later, never by this function.
export async function publishVerifiedBackup({
  source, directory, store, maxBytes = DEFAULT_MAX_BYTES, now,
} = {}) {
  validateStore(store);
  if (typeof directory !== 'string' || !directory ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw Error('BACKUP_ARGUMENTS_INVALID');
  // Read pointer before starting. Never overwrite a corrupt index.
  const prior = await readIndex(store);
  const snap = await createOfflineSnapshot(source, { directory, maxBytes, now });
  const scratch = await mkdtemp(join(directory, 'verify-'));
  const id = randomUUID();
  const entry = { id, ...keys(id),
    sha256: snap.manifest.sha256, createdAt: snap.manifest.createdAt };
  try {
    validateEntry(entry);
    const remoteArchive = join(scratch, 'remote.sqlite.gz');
    await store.putFile(entry.archiveKey, snap.archivePath, { ifNoneMatch: '*' });
    await store.getFile(entry.archiveKey, remoteArchive, { maxBytes });
    // Checks SHA-256, compressed/uncompressed limits, SQLite integrity,
    // foreign keys, all table names/row counts and recreates a SQLite file.
    await restoreOfflineSnapshot({
      archivePath: remoteArchive, manifest: snap.manifest,
      destinationPath: join(scratch, 'verified.sqlite'), maxBytes,
    });
    const manifestText = await readFile(snap.manifestPath, 'utf8');
    if (Buffer.byteLength(manifestText) > MAX_MANIFEST_BYTES)
      throw Error('BACKUP_MANIFEST_SIZE_EXCEEDED');
    await store.putText(entry.manifestKey, manifestText, { ifNoneMatch: '*' });
    const published = await store.getText(entry.manifestKey, {
      maxBytes: MAX_MANIFEST_BYTES,
    });
    if (published?.body !== manifestText) throw Error('BACKUP_MANIFEST_REMOTE_MISMATCH');
    const entries = [entry, ...(prior?.entries ?? [])].slice(0, MAX_HISTORY);
    const indexText = JSON.stringify({ format: INDEX_FORMAT, entries });
    if (Buffer.byteLength(indexText) > MAX_INDEX_BYTES) throw Error('BACKUP_INDEX_TOO_LARGE');
    await store.putText(BACKUP_INDEX_KEY, indexText,
      prior ? { ifMatch: prior.etag } : { ifNoneMatch: '*' });
    return { entry, retainedInIndex: entries.length, fullyDownloadedAndRestored: true };
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await rm(snap.workDir, { recursive: true, force: true });
  }
}

// Will NEVER overwrite any already-existing destination. If the latest backup
// is unavailable/corrupt, tries older immutable entries from a valid index.
// Every attempted copy is checked by the existing fail-closed SQLite restorer.
export async function restoreLatestVerifiedBackup({
  store, destinationPath, directory, maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  validateStore(store);
  if (typeof directory !== 'string' || !directory ||
      typeof destinationPath !== 'string' || !destinationPath ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw Error('RESTORE_ARGUMENTS_INVALID');
  try {
    await lstat(destinationPath);
    throw Error('RESTORE_DESTINATION_EXISTS');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const index = await readIndex(store);
  if (!index) throw Error('RESTORE_INDEX_NOT_FOUND');
  const scratch = await mkdtemp(join(directory, 'download-'));
  const attempts = [];
  try {
    for (const entry of index.entries) {
      const localArchive = join(scratch, entry.id + '.sqlite.gz');
      try {
        const remoteManifest = await store.getText(entry.manifestKey, {
          maxBytes: MAX_MANIFEST_BYTES,
        });
        if (typeof remoteManifest?.body !== 'string' ||
            Buffer.byteLength(remoteManifest.body) > MAX_MANIFEST_BYTES)
          throw Error('RESTORE_MANIFEST_UNAVAILABLE');
        let manifest;
        try { manifest = JSON.parse(remoteManifest.body); }
        catch { throw Error('RESTORE_MANIFEST_INVALID'); }
        if (manifest.sha256 !== entry.sha256 ||
            manifest.createdAt !== entry.createdAt)
          throw Error('RESTORE_MANIFEST_INDEX_MISMATCH');
        await store.getFile(entry.archiveKey, localArchive, { maxBytes });
        const result = await restoreOfflineSnapshot({
          archivePath: localArchive, manifest, destinationPath, maxBytes,
        });
        return {
          entry, tables: result.tables, fallbackUsed: attempts.length > 0,
          earlierFailures: attempts, restoredAt: new Date().toISOString(),
        };
      } catch (error) {
        // A competing process may have created the target. Never continue,
        // because the next attempt must not overwrite or modify that DB.
        if (error.code === 'EEXIST' || error.message === 'RESTORE_DESTINATION_EXISTS')
          throw error;
        attempts.push({ id: entry.id, reason: String(error.message).slice(0, 100) });
      }
    }
    throw Error('RESTORE_NO_VERIFIED_COPY: ' + JSON.stringify(attempts));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
