// Manual-only, dry-run-first R2 object cleanup prototype.
// Never called by the scanner, backup publisher or any scheduled task.
import { BACKUP_INDEX_KEY, readVerifiedBackupIndex } from './backup-object-store.mjs';

const ROOT = 'radar-backups/v1/';
const VALID_OBJECT = /^radar-backups\/v1\/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/(?:manifest\.json|snapshot\.sqlite\.gz)$/i;
const MIN_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GRACE_MS = 48 * 60 * 60 * 1000;

// Adapter listObjects({prefix,maxKeys}) must return a COMPLETE listing,
// {objects:[{key,lastModified,size}], truncated:false}; never accept partial.
// deleteObject(key) is only called after a separate explicit opt-in.
export async function pruneUnreferencedBackupObjects({
  store, now = () => Date.now(), graceMs = DEFAULT_GRACE_MS,
  maxDeletes = 10, execute = false, acknowledgeDataDeletion = false,
} = {}) {
  if (typeof store?.listObjects !== 'function' ||
      typeof store?.deleteObject !== 'function' ||
      typeof store?.getText !== 'function' ||
      !Number.isSafeInteger(graceMs) || graceMs < MIN_GRACE_MS ||
      !Number.isSafeInteger(maxDeletes) || maxDeletes < 1 || maxDeletes > 20)
    throw Error('BACKUP_RETENTION_ARGUMENTS_INVALID');
  if (execute && acknowledgeDataDeletion !== true)
    throw Error('BACKUP_RETENTION_EXPLICIT_APPROVAL_REQUIRED');
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw Error('BACKUP_RETENTION_TIME_INVALID');

  const index = await readVerifiedBackupIndex(store);
  if (!index) throw Error('BACKUP_RETENTION_INDEX_MISSING');
  const protectedKeys = new Set([
    BACKUP_INDEX_KEY,
    ...index.entries.flatMap(e => [e.archiveKey, e.manifestKey]),
  ]);
  const listing = await store.listObjects({ prefix: ROOT, maxKeys: 1000 });
  if (listing?.truncated !== false || !Array.isArray(listing.objects) ||
      listing.objects.length > 1000)
    throw Error('BACKUP_RETENTION_LISTING_INCOMPLETE');

  const candidates = [];
  const seen = new Set();
  let protectedCount = 0, ignoredCount = 0;
  for (const obj of listing.objects) {
    const key = obj?.key;
    if (typeof key !== 'string' || !key.startsWith(ROOT) ||
        !VALID_OBJECT.test(key) || seen.has(key)) {
      ignoredCount++;
      continue;
    }
    seen.add(key);
    if (protectedKeys.has(key)) {
      protectedCount++;
      continue;
    }
    const lastModifiedMs = Date.parse(obj?.lastModified ?? '');
    if (!Number.isFinite(lastModifiedMs) || lastModifiedMs > timestamp ||
        timestamp - lastModifiedMs < graceMs) {
      ignoredCount++;
      continue;
    }
    candidates.push({ key, lastModified: obj.lastModified,
      size: Number.isSafeInteger(obj.size) && obj.size >= 0 ? obj.size : null });
  }
  candidates.sort((a, b) =>
    a.lastModified.localeCompare(b.lastModified) || a.key.localeCompare(b.key));
  const selected = candidates.slice(0, maxDeletes);

  if (!execute) return {
    dryRun: true, protectedCount, ignoredCount,
    eligibleObjects: candidates.length, selected, deleted: 0,
  };
  let deleted = 0;
  for (const item of selected) {
    // Re-read the index before every DELETE. Fail closed on CAS/change.
    const current = await readVerifiedBackupIndex(store);
    if (!current || current.etag !== index.etag ||
        current.entries.some(e => e.archiveKey === item.key ||
                                  e.manifestKey === item.key))
      throw Error('BACKUP_RETENTION_INDEX_CHANGED');
    await store.deleteObject(item.key);
    deleted++;
  }
  return {
    dryRun: false, protectedCount, ignoredCount,
    eligibleObjects: candidates.length, selected, deleted,
  };
}
