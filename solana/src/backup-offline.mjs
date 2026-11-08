// Offline-only SQLite snapshot/restore prototype. No cloud integration or scheduler.
import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, link } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';

const FORMAT = 'solana-radar-sqlite-offline-v1';
const MAX_BYTES = 512 * 1024 * 1024;
const TABLE = /^[A-Za-z_][A-Za-z_0-9]*$/;
const HEX = /^[a-f0-9]{64}$/;

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function inspectDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const checks = db.prepare('PRAGMA integrity_check').all();
    if (checks.length !== 1 || checks[0].integrity_check !== 'ok')
      throw Error('BACKUP_INTEGRITY_FAILED');
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw Error('BACKUP_FOREIGN_KEY_FAILED');
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x => x.name);
    if (!names.length) throw Error('BACKUP_SCHEMA_EMPTY');
    const tables = {};
    for (const name of names) {
      if (!TABLE.test(name)) throw Error('BACKUP_TABLE_NAME_UNSAFE');
      tables[name] = db.prepare('SELECT COUNT(*) AS n FROM "' + name + '"').get().n;
    }
    return { schemaVersion: db.prepare('PRAGMA user_version').get().user_version, tables };
  } finally {
    db.close();
  }
}

function validateManifest(manifest) {
  if (!manifest || manifest.format !== FORMAT || manifest.compression !== 'gzip' ||
      !HEX.test(manifest.sha256 ?? '') ||
      !Number.isSafeInteger(manifest.compressedBytes) || manifest.compressedBytes < 1 ||
      !Number.isSafeInteger(manifest.uncompressedBytes) || manifest.uncompressedBytes < 1 ||
      !Number.isSafeInteger(manifest.schemaVersion) ||
      !manifest.tables || typeof manifest.tables !== 'object' ||
      Array.isArray(manifest.tables) || !Object.keys(manifest.tables).length)
    throw Error('BACKUP_MANIFEST_INVALID');
  for (const [name, count] of Object.entries(manifest.tables))
    if (!TABLE.test(name) || !Number.isSafeInteger(count) || count < 0)
      throw Error('BACKUP_MANIFEST_INVALID');
}

// The only supported source is an already OPEN DatabaseSync connection.
// Never copy a live SQLite file directly, since its WAL can contain new data.
export async function createOfflineSnapshot(source, { directory, now = () => Date.now(), maxBytes = MAX_BYTES } = {}) {
  if (!(source instanceof DatabaseSync) || typeof directory !== 'string' || !directory ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw Error('BACKUP_ARGUMENTS_INVALID');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const workDir = await mkdtemp(join(directory, 'snapshot-'));
  const sqlitePath = join(workDir, 'snapshot.sqlite');
  const archivePath = join(workDir, 'snapshot.sqlite.gz');
  try {
    await backup(source, sqlitePath);
    const info = await stat(sqlitePath);
    if (info.size < 1 || info.size > maxBytes)
      throw Error('BACKUP_SNAPSHOT_SIZE_EXCEEDED');
    const schema = inspectDatabase(sqlitePath);
    await pipeline(createReadStream(sqlitePath), createGzip({ level: 6 }), createWriteStream(archivePath, { mode: 0o600 }));
    const compressed = await stat(archivePath);
    if (compressed.size > maxBytes) throw Error('BACKUP_ARCHIVE_SIZE_EXCEEDED');
    const manifest = {
      format: FORMAT, compression: 'gzip', createdAt: new Date(now()).toISOString(),
      compressedBytes: compressed.size, uncompressedBytes: info.size,
      sha256: await sha256(archivePath), ...schema,
    };
    validateManifest(manifest);
    await rm(sqlitePath, { force: true });
    return { archivePath, manifest, workDir };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

// Restores ONLY into a new path; hardlink is atomic create-if-absent on same FS.
// This never opens/changes the running scanner database or a remote service.
export async function restoreOfflineSnapshot({ archivePath, manifest, destinationPath, maxBytes = MAX_BYTES } = {}) {
  validateManifest(manifest);
  if (typeof archivePath !== 'string' || typeof destinationPath !== 'string' ||
      !archivePath || !destinationPath || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw Error('RESTORE_ARGUMENTS_INVALID');
  if (manifest.compressedBytes > maxBytes || manifest.uncompressedBytes > maxBytes)
    throw Error('RESTORE_SIZE_EXCEEDED');
  const archiveInfo = await stat(archivePath);
  if (archiveInfo.size !== manifest.compressedBytes || await sha256(archivePath) !== manifest.sha256)
    throw Error('RESTORE_SHA256_MISMATCH');
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  const workDir = await mkdtemp(join(dirname(destinationPath), '.restore-'));
  const tempDb = join(workDir, 'restored.sqlite');
  let written = 0;
  const limit = new Transform({ transform(chunk, _encoding, done) {
    written += chunk.length;
    if (written > maxBytes || written > manifest.uncompressedBytes)
      done(Error('RESTORE_UNCOMPRESSED_SIZE_EXCEEDED'));
    else done(null, chunk);
  }});
  try {
    await pipeline(createReadStream(archivePath), createGunzip(), limit,
      createWriteStream(tempDb, { mode: 0o600, flags: 'wx' }));
    if (written !== manifest.uncompressedBytes) throw Error('RESTORE_SIZE_MISMATCH');
    const actual = inspectDatabase(tempDb);
    if (actual.schemaVersion !== manifest.schemaVersion ||
        JSON.stringify(actual.tables) !== JSON.stringify(manifest.tables))
      throw Error('RESTORE_SCHEMA_OR_ROWS_MISMATCH');
    // link() fails with EEXIST and NEVER replaces an existing file.
    await link(tempDb, destinationPath);
    return { destinationPath, schemaVersion: actual.schemaVersion, tables: actual.tables };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
