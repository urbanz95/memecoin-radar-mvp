import { NETWORK, isEvmAddress } from '../network.mjs';

const parsed = value => typeof value === 'string' ? Date.parse(value) : NaN;
const freshUntil = (value, now) => Number.isFinite(parsed(value)) && parsed(value) > now;

export function signalSummary(entries) {
  const summary = { total: entries.length, counts: {}, pipelines: {}, marketAlerts: 0, tradeApproved: false };
  for (const pipeline of ['new', 'established', 'unclassified']) summary.pipelines[pipeline] = { total: 0, counts: {} };
  for (const entry of entries) {
    const status = entry.signal?.status ?? 'WAITING_DATA';
    const pipeline = ['new', 'established'].includes(entry.pipeline) ? entry.pipeline : 'unclassified';
    summary.counts[status] = (summary.counts[status] ?? 0) + 1;
    summary.pipelines[pipeline].total++;
    summary.pipelines[pipeline].counts[status] = (summary.pipelines[pipeline].counts[status] ?? 0) + 1;
    if (status === 'MARKET_ALERT') summary.marketAlerts++;
  }
  return summary;
}

// Expiry is checked again for every read. A completed collection does not keep
// an older alert current during an outage or a supplier cooldown.
export function publicReport(report, now = Date.now()) {
  const headTime = report.observedHead?.timestamp;
  const age = now - headTime * 1000;
  const dataStale = !Number.isFinite(headTime) || age > 60000 || age < -30000;
  const entries = (Array.isArray(report.screening?.entries) ? report.screening.entries : []).map(entry => {
    const signal = entry.signal;
    if (!signal || ['BLOCKED', 'OUT_OF_SCOPE', 'WAITING_DATA'].includes(signal.status)) return entry;
    if (freshUntil(signal.expiresAt, now) && !dataStale) return entry;
    return { ...entry, signal: { ...signal, kind: 'MARKET_OBSERVATION', status: 'STALE',
      label: 'Dados de mercado desatualizados', tradeApproved: false,
      reasons: ['É necessária uma nova observação de mercado antes de avaliar o sinal.'] } };
  });
  const tradeCandidates = dataStale ? [] : (Array.isArray(report.results) ? report.results : []).filter(result =>
    result.status === 'CANDIDATE' && isEvmAddress(result.address)
    && result.chain === NETWORK.chain && result.chainId === NETWORK.chainId && result.environment === NETWORK.environment
    && Number.isFinite(result.score) && Number.isFinite(result.minScore) && result.score >= result.minScore
    && freshUntil(result.evidenceExpiresAt, now) && parsed(result.evaluatedAt) <= now + 30000
    && report.snapshots?.some(snapshot => snapshot.synthetic === false && snapshot.address?.toLowerCase() === result.address.toLowerCase())
    && !entries.some(entry => entry.address?.toLowerCase() === result.address.toLowerCase() && entry.status === 'BLOCKED'));
  const marketAlerts = dataStale ? [] : entries.filter(entry => entry.status !== 'BLOCKED' && !entry.risks?.length
    && isEvmAddress(entry.address) && entry.signal?.status === 'MARKET_ALERT' && entry.signal.kind === 'MARKET_ALERT'
    && entry.signal.tradeApproved === false && freshUntil(entry.signal.expiresAt, now))
    .map(entry => ({ ...entry.signal, address: entry.address, symbol: entry.symbol, pipeline: entry.pipeline }));
  const signals = { asOf: report.completedAt, policy: report.signals?.policy,
    summary: signalSummary(entries), marketAlerts, tradeCandidates };
  return { runId: report.runId, capturedAt: report.completedAt,
    observedHead: report.observedHead, dataStale,
    currentSignalsAvailable: tradeCandidates.length > 0, marketSignalsAvailable: marketAlerts.length > 0,
    dataQuality: report.operationalStatus, coverage: report.coverage,
    observations: report.snapshots, recordedResults: report.results, alerts: report.alerts ?? [], errors: report.errors,
    signals, ...(report.marketData ? { marketData: report.marketData } : {}),
    ...(report.screening ? { screening: { ...report.screening, entries,
      currentSignalsAvailable: tradeCandidates.length > 0, marketSignalsAvailable: marketAlerts.length > 0 } } : {}) };
}
