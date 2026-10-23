import { evaluate, policyHash, validateConfig } from './engine.mjs';
import { normalizeAddress } from './network.mjs';

export function runScan(snapshots, config, { now = Date.now(), state = {}, pipelines = Object.keys(config.pipelines) } = {}) {
  validateConfig(config);
  if (!Array.isArray(pipelines) || !pipelines.length || pipelines.some((p) => !Object.hasOwn(config.pipelines, p)) || new Set(pipelines).size !== pipelines.length) throw new Error('Seleção de pipelines inválida');
  if (!Array.isArray(snapshots)) throw new Error('O input deve ser um array de snapshots');
  const seen = new Set();
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Snapshot inválido');
    const key = `${snapshot.chain}:${snapshot.chainId}:${snapshot.environment}:${normalizeAddress(snapshot.address)}`;
    if (seen.has(key)) throw new Error(`Contrato duplicado no mesmo lote: ${key}`);
    seen.add(key);
  }
  const results = [];
  const nextState = {};
  const alerts = [];
  const hash = policyHash(config);
  for (const snapshot of snapshots) {
    for (const pipeline of pipelines) {
      const key = `${pipeline}:${snapshot.chain}:${snapshot.chainId}:${snapshot.environment}:${normalizeAddress(snapshot.address)}`;
      const previous = Object.hasOwn(state, key) ? state[key] : null;
      const evaluation = evaluate(snapshot, pipeline, config, { now, previous });
      const { nextState: next, ...publicResult } = evaluation;
      nextState[key] = next;
      results.push(publicResult);
      if (evaluation.status === 'CANDIDATE' && (previous?.lastStatus !== 'CANDIDATE' || previous?.policyHash !== hash)) {
        alerts.push({ id: `${hash}:${key}:${next.firstObservedAtMs}`, type: 'candidate', ...publicResult });
      }
    }
  }
  return { schemaVersion: 2, evaluatedAt: new Date(now).toISOString(), policyVersion: config.version, policyHash: hash,
    mode: 'observe', source: 'normalized-snapshots', results, alerts, state: nextState };
}
