import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readDocument, atomicDocument, atomicWrite, encodeJson, gzipDocument, retainArchives, removeAbandonedTemps, failure, GiB } from './storage.mjs';

export const STALE_MS = 360000;
export function healthView(metadata, now = Date.now()) {
  if (!metadata) return { status: 'NOT_STARTED', stale: true, currentSignalsAvailable: false };
  const age = now - Date.parse(metadata.lastSuccessAt ?? '');
  const stale = !Number.isFinite(age) || age < 0 || age > STALE_MS;
  const abandoned = metadata.status === 'RUNNING' && now - Date.parse(metadata.startedAt) > 300000;
  return { ...metadata, status: abandoned ? 'ABANDONED' : metadata.status === 'ERROR' ? 'ERROR' : stale ? 'STALE' : metadata.status,
    stale, dataAgeSeconds: Number.isFinite(age) ? Math.max(0, Math.floor(age / 1000)) : null,
    currentSignalsAvailable: false }; // Saúde/resumo; nenhum snapshot é apresentado como sinal atual.
}

export class Worker {
  constructor({ directory, collect, now = Date.now, retentionDays = 7, maxArchiveBytes = 8 * GiB,
    minimumFreeBytes = GiB / 2, cycleTimeoutMs = 240000 }) {
    Object.assign(this, { directory, collect, now, retentionDays, maxArchiveBytes, minimumFreeBytes, cycleTimeoutMs });
    this.running = false;
  }
  async health() { return healthView(await readDocument(join(this.directory, 'worker-status.json'), 65536), this.now()); }
  retain(state, reserveBytes = 0) {
    return retainArchives({ directory: this.directory, state, now: this.now(), retentionDays: this.retentionDays,
      maxBytes: this.maxArchiveBytes, minimumFreeBytes: this.minimumFreeBytes, reserveBytes });
  }
  async runOnce({ signal: stopSignal } = {}) {
    if (this.running) return { status: 'SKIPPED', reason: 'ALREADY_RUNNING' };
    this.running = true;
    const latest = join(this.directory, 'latest.json');
    const healthFile = join(this.directory, 'worker-status.json');
    let previous; let old; let attempt;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await removeAbandonedTemps(this.directory);
      previous = await readDocument(latest) ?? {};
      old = await readDocument(healthFile, 65536) ?? {};
      attempt = { status: 'RUNNING', attemptId: randomUUID(), startedAt: new Date(this.now()).toISOString(),
        lastSuccessAt: old.lastSuccessAt ?? null, lastRun: old.lastRun ?? null };
      await atomicDocument(healthFile, attempt);
      const continuous = old.status === 'COMPLETED' && old.runId === previous.runId;
      const resumed = continuous ? previous : { ...previous, evaluationState: {} };
      await this.retain(previous);
      const signal = AbortSignal.any([AbortSignal.timeout(this.cycleTimeoutMs), ...[stopSignal].filter(Boolean)]);
      const { payload, evidence } = await this.collect({ previous: resumed, signal });
      signal.throwIfAborted();
      const id = payload.runId;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id) || payload.rawEvidenceFile !== `runs/${id}.rpc.json`) throw failure('INVALID_RUN_ID');
      const raw = gzipDocument(evidence); const snapshots = gzipDocument(payload.snapshots);
      const stateBytes = encodeJson(payload);
      await this.retain(previous, raw.length + snapshots.length + stateBytes.length);
      // Não usar disco efémero nem publicar apontadores antes da evidência.
      await atomicWrite(join(this.directory, payload.rawEvidenceFile + '.gz'), raw);
      await atomicWrite(join(this.directory, 'runs', `${id}.snapshots.json.gz`), snapshots);
      signal.throwIfAborted();
      await atomicWrite(latest, stateBytes);
      const retention = await this.retain(payload).catch(() => ({ error: 'CLEANUP_FAILED' }));
      const lastRun = { runId: id, operationalStatus: payload.operationalStatus, observedHead: payload.observedHead,
        catalogPools: payload.coverage.catalogPools, targetContracts: payload.coverage.discoveredTargetContracts,
        enrichedContracts: payload.snapshots.length, rpcRequests: payload.rpcRequestCount,
        results: payload.results.reduce((all, r) => ({ ...all, [r.status]: (all[r.status] ?? 0) + 1 }), {}), alerts: payload.alerts.length };
      await atomicDocument(healthFile, { ...attempt, status: 'COMPLETED', runId: id,
        completedAt: new Date(this.now()).toISOString(), lastSuccessAt: new Date(this.now()).toISOString(), lastRun, retention });
      return { status: 'COMPLETED', ...lastRun };
    } catch (error) {
      const code = ['ARCHIVE_BUDGET_EXCEEDED', 'DISK_SPACE_LOW', 'STATE_TOO_LARGE', 'INVALID_STATE', 'DEADLINE_EXCEEDED'].includes(error.code)
        ? error.code : stopSignal?.aborted ? 'STOPPED' : 'COLLECTION_FAILED';
      if (previous) {
        // Guardar apenas o catálogo confirmado. Não manter resultados positivos antigos.
        await atomicDocument(latest, { schemaVersion: 1, collectorHash: previous.collectorHash,
          runId: previous.runId, rawEvidenceFile: previous.rawEvidenceFile,
          completedAt: new Date(this.now()).toISOString(), operationalStatus: 'ERROR', error: code,
          snapshots: [], results: [], alerts: [], evaluationState: {},
          discovery: previous.discovery, observations: previous.observations });
      }
      await atomicDocument(healthFile, { ...(attempt ?? {}), status: 'ERROR', completedAt: new Date(this.now()).toISOString(),
        lastSuccessAt: old?.lastSuccessAt ?? null, error: code });
      if (!previous) throw failure(code); // Estado ilegível exige intervenção; nunca o substituir por {}.
      return { status: 'ERROR', reason: code };
    } finally { this.running = false; }
  }
}
