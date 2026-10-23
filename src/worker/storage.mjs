import { open, mkdir, rename, unlink, readdir, stat, statfs } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const GiB = 1024 ** 3;
export function failure(code) { return Object.assign(new Error(code), { code }); }
export async function readDocument(path, limit = 64 * 1024 ** 2) {
  let file;
  try {
    file = await open(path, 'r');
    if ((await file.stat()).size > limit) throw failure('STATE_TOO_LARGE');
    const data = JSON.parse(await file.readFile('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('INVALID_STATE');
    return data;
  } catch (error) { if (error.code === 'ENOENT') return null; throw failure(error.code === 'STATE_TOO_LARGE' ? error.code : 'INVALID_STATE'); }
  finally { await file?.close(); }
}
export function encodeJson(value, limit = 64 * 1024 ** 2) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > limit) throw failure('STATE_TOO_LARGE');
  return bytes;
}
export async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  let file; let created = false;
  try {
    file = await open(temp, 'wx', 0o600); created = true;
    await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
    await rename(temp, path);
    // Persistir também a alteração do diretório para uma retoma após reboot.
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close();
    if (created) await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
export const atomicDocument = (path, value) => atomicWrite(path, encodeJson(value));
export const gzipDocument = (value) => gzipSync(encodeJson(value, 128 * 1024 ** 2));

// Chamado só sob flock, antes da escrita desta sessão. SIGKILL pode deixar um
// temporário de rename, mas nunca legitima remover locks de outro processo.
export async function removeAbandonedTemps(directory) {
  let removed = 0;
  for (const parent of [directory, join(directory, 'runs')]) {
    const files = await readdir(parent).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of files) {
      if (!/^[a-zA-Z0-9.-]+\.json(\.gz)?\.[0-9a-f-]{36}\.tmp$/.test(name)) continue;
      await unlink(join(parent, name)); removed++;
    }
  }
  return removed;
}

function protectedArchives(state) {
  const files = new Set();
  const protect = (path) => {
    if (typeof path !== 'string' || !/^runs\/[a-zA-Z0-9-]+\.rpc\.json$/.test(path)) return;
    files.add(path.slice(5)); files.add(path.slice(5) + '.gz');
  };
  protect(state.rawEvidenceFile);
  if (typeof state.runId === 'string' && /^[a-zA-Z0-9-]+$/.test(state.runId)) {
    files.add(`${state.runId}.snapshots.json`); files.add(`${state.runId}.snapshots.json.gz`);
  }
  for (const observation of Object.values(state.observations ?? {})) protect(observation.creation?.evidenceFile);
  return files;
}

export async function retainArchives({ directory, state = {}, now = Date.now(), retentionDays = 7,
  maxBytes = 8 * GiB, reserveBytes = 0, minimumFreeBytes = GiB / 2 }) {
  const runs = join(directory, 'runs');
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const protectedNames = protectedArchives(state);
  const files = [];
  for (const name of await readdir(runs)) {
    if (!/^[a-zA-Z0-9-]+\.(rpc|snapshots)\.json(\.gz)?$/.test(name)) continue;
    const info = await stat(join(runs, name));
    if (info.isFile()) files.push({ name, size: info.size, mtime: info.mtimeMs, protected: protectedNames.has(name) });
  }
  let total = files.reduce((n, f) => n + f.size, 0); let deleted = 0;
  for (const file of files.sort((a, b) => a.mtime - b.mtime)) {
    if (file.protected || (file.mtime >= now - retentionDays * 86400000 && total + reserveBytes <= maxBytes)) continue;
    await unlink(join(runs, file.name)); total -= file.size; deleted++;
  }
  if (total + reserveBytes > maxBytes) throw failure('ARCHIVE_BUDGET_EXCEEDED');
  const filesystem = await statfs(directory);
  if (filesystem.bavail * filesystem.bsize < minimumFreeBytes + reserveBytes) throw failure('DISK_SPACE_LOW');
  return { archiveBytes: total, limitBytes: maxBytes, deleted, retentionDays,
    pinnedBytes: files.filter(f => f.protected).reduce((n, f) => n + f.size, 0) };
}
