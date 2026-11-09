// Opt-in durable backup orchestration. Intentionally separated from the
// scanner's read-only RPC/WebSocket processing and HTTP public API.
import { lstat, mkdir, stat, statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { publishVerifiedBackup, restoreLatestVerifiedBackup } from './backup-object-store.mjs';
import { pruneUnreferencedBackupObjects } from './backup-retention.mjs';

const MIB = 1024 * 1024;
const GIB = 1024 ** 3;
const PREFIX = 'radar-backups/v1/';
const truth = (value, name) => {
  if (value === undefined || value === 'false' || value === '0') return false;
  if (value === 'true' || value === '1') return true;
  throw Error('INVALID_' + name);
};
const number = (env, name, fallback, min, max) => {
  const v = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(v) || v < min || v > max)
    throw Error('INVALID_' + name);
  return v;
};
const absent = async path => {
  try { await lstat(path); return false; }
  catch (e) { if (e?.code === 'ENOENT') return true; throw e; }
};

export function loadR2BackupSettings(env = process.env) {
  const enabled = truth(env.SOLANA_R2_BACKUP_ENABLED, 'SOLANA_R2_BACKUP_ENABLED');
  if (!enabled) return { enabled: false };
  const accountId = env.SOLANA_R2_ACCOUNT_ID;
  const accessKeyId = env.SOLANA_R2_ACCESS_KEY_ID;
  const secretAccessKey = env.SOLANA_R2_SECRET_ACCESS_KEY;
  const bucket = env.SOLANA_R2_BUCKET;
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? '') ||
      typeof accessKeyId !== 'string' || accessKeyId.length < 5 ||
      typeof secretAccessKey !== 'string' || secretAccessKey.length < 8 ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? ''))
    throw Error('R2_BACKUP_REQUIRED_CONFIGURATION_MISSING');

  return Object.freeze({
    enabled: true, accountId, accessKeyId, secretAccessKey, bucket,
    allowFreshStart: truth(env.SOLANA_R2_ALLOW_FRESH_START,
      'SOLANA_R2_ALLOW_FRESH_START'),
    autoPrune: truth(env.SOLANA_R2_AUTO_PRUNE,
      'SOLANA_R2_AUTO_PRUNE'),
    intervalMinutes: number(env, 'SOLANA_R2_INTERVAL_MINUTES', 180, 30, 1440),
    firstDelaySeconds: number(env, 'SOLANA_R2_FIRST_DELAY_SECONDS', 120, 5, 3600),
    maxObjectBytes: number(env, 'SOLANA_R2_MAX_OBJECT_BYTES', 512 * MIB,
      2 * MIB, 512 * MIB),
    maxRemoteBytes: number(env, 'SOLANA_R2_MAX_REMOTE_BYTES', 4 * GIB,
      256 * MIB, 9 * GIB),
    maxRemoteObjects: number(env, 'SOLANA_R2_MAX_REMOTE_OBJECTS', 64, 6, 500),
    minSpareBytes: number(env, 'SOLANA_R2_MIN_SPARE_BYTES', 128 * MIB,
      64 * MIB, GIB),
  });
}

// The caller must invoke this BEFORE new Scanner(), because its constructor
// opens the Store. A missing local DB is NEVER silently replaced by an empty
// one unless the explicit fresh-start migration flag was set.
export async function bootstrapR2Backup({
  env = process.env, dbPath, directory, storeFactory,
  now = () => Date.now(),
} = {}) {
  const settings = loadR2BackupSettings(env);
  if (!settings.enabled) return { enabled: false, restoreStatus: 'DISABLED', agent: null };
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:')
    throw Error('R2_BACKUP_SQLITE_PATH_REQUIRED');
  const path = resolve(dbPath);
  const workingDir = resolve(directory ?? dirname(path));
  await mkdir(workingDir, { recursive: true, mode: 0o700 });
  let store, client;
  if (storeFactory) {
    store = await storeFactory(settings);
  } else {
    const { createR2AdapterFromCredentials } =
      await import('../backup-r2/r2-s3-adapter.mjs');
    const result = await createR2AdapterFromCredentials({
      accountId: settings.accountId, accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey, bucket: settings.bucket,
    });
    store = result.adapter;
    client = result.client;
  }

  let restoreStatus = 'LOCAL_DB_EXISTS';
  try {
    if (await absent(path)) {
      try {
        const result = await restoreLatestVerifiedBackup({
          store, destinationPath: path, directory: workingDir,
          maxBytes: settings.maxObjectBytes,
        });
        restoreStatus = result.fallbackUsed ? 'RESTORED_FALLBACK' : 'RESTORED_LATEST';
      } catch (error) {
        // The ONLY permissible empty bootstrap case is no snapshot index.
        // Corruption, partial data and inaccessible R2 always stop startup.
        if (error.message === 'RESTORE_INDEX_NOT_FOUND' &&
            settings.allowFreshStart) {
          restoreStatus = 'FRESH_START_EXPLICIT';
        } else {
          throw Error('R2_BACKUP_RESTORE_REQUIRED', { cause: error });
        }
      }
    }
    const agent = new R2BackupAgent({
      store, client, settings, dbPath: path, directory: workingDir, now,
    });
    return { enabled: true, restoreStatus, agent };
  } catch (e) {
    client?.destroy?.();
    throw e;
  }
}

export class R2BackupAgent {
  constructor({ store, client, settings, dbPath, directory, now = () => Date.now(),
    setTimeoutFn = setTimeout, setIntervalFn = setInterval,
    clearTimeoutFn = clearTimeout, clearIntervalFn = clearInterval,
    statfsFn = statfs } = {}) {
    if (!settings?.enabled || !store) throw Error('R2_BACKUP_AGENT_INVALID');
    this.store = store; this.client = client; this.settings = settings;
    this.dbPath = dbPath; this.directory = directory; this.now = now;
    this.statfsFn = statfsFn;
    this.setTimeoutFn = setTimeoutFn; this.setIntervalFn = setIntervalFn;
    this.clearTimeoutFn = clearTimeoutFn; this.clearIntervalFn = clearIntervalFn;
    this.timer = null; this.interval = null;
    this.inFlight = null; this.stopping = false;
    this.lastSuccessfulAt = null; this.lastErrorCode = null;
    this.attempts = 0; this.successes = 0;
  }

  status() {
    // Never expose bucket, account, keys, object URIs or scanner wallet data.
    return {
      enabled: true,
      operational: this.interval !== null && !this.stopping,
      backingUp: this.inFlight !== null,
      lastSuccessfulAt: this.lastSuccessfulAt,
      lastErrorCode: this.lastErrorCode,
      attempts: this.attempts, successes: this.successes,
      retentionMode: this.settings.autoPrune ? 'GUARDED' : 'DISABLED',
    };
  }

  async checkCapacity() {
    const fs = await this.statfsFn(this.directory);
    const free = Number(fs.bavail) * Number(fs.bsize);
    // Estimate the temporary copies from CURRENT SQLite size, not the
    // maximum permitted archive size. Reserving 3 x 512 MiB even for a 40 MiB
    // database would permanently disable backup on smaller cloud disks.
    const db = await stat(this.dbPath);
    if (!db.isFile() || db.size < 1 ||
        db.size > this.settings.maxObjectBytes)
      throw Error('R2_BACKUP_SQLITE_SIZE_INVALID');
    // Existing SQLite and its WAL are already counted against free space.
    // Snapshot, archive, remote download and verified restored DB coexist.
    // Allow extra space for compression headers/pages and other writes.
    const required = 3 * Math.max(16 * MIB, db.size) +
      this.settings.minSpareBytes + 16 * MIB;
    if (!Number.isFinite(free) || free < required)
      throw Error('R2_BACKUP_LOCAL_SPACE_INSUFFICIENT');
    const listing = await this.store.listObjects({
      prefix: PREFIX, maxKeys: 1000,
    });
    if (listing?.truncated !== false || !Array.isArray(listing.objects) ||
        listing.objects.length >= this.settings.maxRemoteObjects)
      throw Error('R2_BACKUP_REMOTE_OBJECT_LIMIT');
    const remoteSize = listing.objects.reduce((sum, item) =>
      sum + (Number.isSafeInteger(item?.size) && item.size >= 0
        ? item.size : Number.POSITIVE_INFINITY), 0);
    if (!Number.isFinite(remoteSize) ||
        remoteSize + this.settings.maxObjectBytes + 65536 >
          this.settings.maxRemoteBytes)
      throw Error('R2_BACKUP_REMOTE_BYTE_BUDGET');
  }

  // Only one operation at a time. SDK/S3 failures never mutate scanner state.
  async once(databaseConnection) {
    if (this.stopping) throw Error('R2_BACKUP_STOPPING');
    if (this.inFlight) return { skipped: 'ALREADY_RUNNING' };
    const operation = (async () => {
      this.attempts++;
      try {
        await this.checkCapacity();
        const result = await publishVerifiedBackup({
          source: databaseConnection, directory: this.directory,
          store: this.store, maxBytes: this.settings.maxObjectBytes,
          now: this.now,
        });
        this.lastSuccessfulAt = new Date(this.now()).toISOString();
        this.lastErrorCode = null;
        this.successes++;
        if (this.settings.autoPrune) {
          try {
            await pruneUnreferencedBackupObjects({
              store: this.store, now: this.now, execute: true,
              acknowledgeDataDeletion: true,
            });
          } catch {
            // A failed cleanup does not roll back a verified backup.
            this.lastErrorCode = 'R2_BACKUP_RETENTION_FAILED';
          }
        }
        return result;
      } catch (error) {
        this.lastErrorCode = [
          'R2_BACKUP_SQLITE_SIZE_INVALID', 'R2_BACKUP_LOCAL_SPACE_INSUFFICIENT',
          'R2_BACKUP_REMOTE_OBJECT_LIMIT',
          'R2_BACKUP_REMOTE_BYTE_BUDGET',
        ].includes(error.message) ? error.message : 'R2_BACKUP_TRANSFER_FAILED';
        throw Error(this.lastErrorCode, { cause: error });
      }
    })();
    this.inFlight = operation;
    try { return await operation; }
    finally { this.inFlight = null; }
  }

  start(databaseConnection, report = () => {}) {
    if (this.timer || this.interval || this.stopping)
      throw Error('R2_BACKUP_ALREADY_STARTED');
    const tick = () => {
      if (this.stopping || this.inFlight) return;
      this.once(databaseConnection)
        .then(() => report('R2_BACKUP_OK'))
        .catch(() => report(this.lastErrorCode ?? 'R2_BACKUP_FAILED'));
    };
    this.timer = this.setTimeoutFn(tick, this.settings.firstDelaySeconds * 1000);
    this.interval = this.setIntervalFn(tick, this.settings.intervalMinutes * 60000);
  }

  async stop() {
    this.stopping = true;
    if (this.timer) this.clearTimeoutFn(this.timer);
    if (this.interval) this.clearIntervalFn(this.interval);
    this.timer = null; this.interval = null;
    if (this.inFlight) await this.inFlight.catch(() => {});
    this.client?.destroy?.();
  }
}
