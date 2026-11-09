// Read-only public /health and /radar audit. Does not call Solana RPC or R2,
// require secrets, store signatures/mints, or modify any cloud service.
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://solana-pump-radar-mvp.onrender.com';
const TARGET_PROTOCOLS = ['pump_fun', 'pump_swap'];
const integer = x => Number.isSafeInteger(x) && x >= 0 ? x : null;
const date = x => typeof x === 'string' && Number.isFinite(Date.parse(x))
  ? x : null;
const record = x => x !== null && typeof x === 'object' &&
  !Array.isArray(x) ? x : {};

export function summarizeHealth(data, observedAt = new Date().toISOString()) {
  if (!data || typeof data !== 'object' ||
      data.chain !== 'solana' || data.mode !== 'READ_ONLY' ||
      data.coverage !== 'PARTIAL' ||
      data.coverageDiagnostics?.status !== 'PARTIAL_UNQUANTIFIED' ||
      data.coverageDiagnostics?.networkWideCompletenessPercent !== null ||
      !Array.isArray(data.coverageDiagnostics?.programs))
    throw Error('INVALID_COVERAGE_HEALTH_SCHEMA');

  const diag = data.coverageDiagnostics;
  const byProtocol = new Map(diag.programs.map(x => [x.protocol, x]));
  if (TARGET_PROTOCOLS.some(name => !byProtocol.has(name)))
    throw Error('EXPECTED_PROTOCOL_MISSING');
  const gauges = record(data.metrics?.gauges);
  const counters = record(data.metrics?.counters);
  const backup = record(data.backup);
  const storage = record(data.storage);
  return {
    observedAt,
    status: typeof data.status === 'string' ? data.status : 'UNKNOWN',
    startedAt: date(data.startedAt),
    uptimeMs: integer(data.metrics?.uptimeMs),
    coverage: 'PARTIAL_UNQUANTIFIED',
    // Counts in the current process, not an estimate of network-wide events.
    notifications: integer(diag.totalNotificationsSeen),
    logEventsDecoded: integer(diag.decodedLogEvents),
    logEventsPersisted: integer(diag.persistedLogEvents),
    decoderFailures: integer(diag.decoderFailures),
    contextEnrichmentSkipped: integer(diag.contextEnrichmentSkipped),
    rpcRateLimitErrors: integer(diag.rpcRateLimitErrors),
    recoveryGapsReported: integer(diag.recoveryGapsReported),
    persistenceFailures: integer(diag.persistenceFailures),
    contextPending: integer(diag.pendingContextTransactions),
    websocketConnected: typeof gauges.websocket_connected === 'boolean'
      ? gauges.websocket_connected : null,
    websocketDisconnects: integer(counters.websocket_disconnects),
    logStreamNoRecentLogs: data.logStream?.noRecentLogs === true,
    lastLogObservedAt: date(data.logStream?.lastObservedAt),
    backup: {
      enabled: backup.enabled === true,
      operational: backup.operational === true,
      lastSuccessfulAt: date(backup.lastSuccessfulAt),
      attempts: integer(backup.attempts),
      successes: integer(backup.successes),
      lastErrorCode: typeof backup.lastErrorCode === 'string'
        && /^[A-Z][A-Z0-9_]{1,63}$/.test(backup.lastErrorCode)
        ? backup.lastErrorCode : null,
    },
    programs: TARGET_PROTOCOLS.map(protocol => {
      const p = record(byProtocol.get(protocol));
      const lastRecovery = record(p.lastRecovery);
      return {
        protocol,
        notifications: integer(p.logNotificationsSeen),
        decodedEvents: integer(p.logEventsDecoded),
        decoderAlerts: integer(p.decoderAlerts),
        lastLogAt: date(p.lastLogAt),
        secondsSinceLastLog: integer(p.secondsSinceLastLog),
        checkpointPresent: p.checkpointPresent === true,
        checkpointContinuity: [
          'PARTIAL', 'RPC_ANCHOR_REACHED', 'RECOVERED'
        ].includes(p.checkpointContinuity) ? p.checkpointContinuity : null,
        recoveryCursorPending: p.recoveryCursorPending === true,
        recoveryComplete: lastRecovery.complete === true,
        recoveryGap: typeof lastRecovery.gap === 'string'
          && /^[A-Z][A-Z0-9_]{1,63}$/.test(lastRecovery.gap)
          ? lastRecovery.gap : null,
        recoveryPages: integer(lastRecovery.pagesRequested),
      };
    }),
  };
}

export function summarizeRadar(data) {
  if (!data || data.kind !== 'SOLANA_PUMP_RADAR_MVP' ||
      data.coverage !== 'PARTIAL' || !data.sample)
    throw Error('INVALID_RADAR_SCHEMA');
  return {
    coverage: 'PARTIAL',
    timeWindowSeconds: integer(data.sample.timeWindowSeconds),
    rowsInspected: integer(data.sample.rowsInspected),
    verifiedUniqueEvents: integer(data.sample.verifiedUniqueEvents),
    possibleTruncation: data.sample.possibleTruncation === true,
    maxRowsRead: integer(data.sample.maxRowsRead),
    oldestSampleAt: date(data.sample.oldestRetainedObservationInWindow),
    observedWindowSeconds: date(data.generatedAt) &&
      date(data.sample.oldestRetainedObservationInWindow)
      ? Math.max(0, Math.round((Date.parse(data.generatedAt) -
          Date.parse(data.sample.oldestRetainedObservationInWindow)) / 1000))
      : null,
    observedDistinctMints: integer(data.totals?.observedDistinctMints),
    // Intentionally omit candidate token IDs, signatures, wallets and prices.
  };
}

const difference = (after, before) => integer(after) !== null &&
  integer(before) !== null && after >= before ? after - before : null;

export function analyzeSnapshots(first, second, firstRadar, secondRadar) {
  const sameProcess = first.startedAt !== null &&
    first.startedAt === second.startedAt;
  const delta = sameProcess ? {
    notifications: difference(second.notifications, first.notifications),
    decodedEvents: difference(second.logEventsDecoded, first.logEventsDecoded),
    persistedEvents: difference(second.logEventsPersisted, first.logEventsPersisted),
    decoderFailures: difference(second.decoderFailures, first.decoderFailures),
    skippedContext: difference(second.contextEnrichmentSkipped, first.contextEnrichmentSkipped),
    rpc429: difference(second.rpcRateLimitErrors, first.rpcRateLimitErrors),
    recoveryGaps: difference(second.recoveryGapsReported, first.recoveryGapsReported),
    programs: second.programs.map(p => {
      const prior = first.programs.find(x => x.protocol === p.protocol);
      return {
        protocol: p.protocol,
        notifications: difference(p.notifications, prior?.notifications),
        decodedEvents: difference(p.decodedEvents, prior?.decodedEvents),
      };
    }),
  } : null;
  const observationsGrowing = delta?.notifications !== null &&
    delta?.notifications > 0;
  const warnings = [];
  if (!sameProcess) warnings.push('SCANNER_RESTART_BETWEEN_SAMPLES');
  if (second.websocketConnected !== true) warnings.push('WEBSOCKET_NOT_CONFIRMED');
  if (second.logStreamNoRecentLogs) warnings.push('NO_RECENT_LOGS');
  if (secondRadar.possibleTruncation) warnings.push('RADAR_WINDOW_MAY_BE_TRUNCATED');
  if (secondRadar.possibleTruncation &&
      secondRadar.observedWindowSeconds !== null &&
      secondRadar.observedWindowSeconds < 300)
    warnings.push('OBSERVED_RADAR_WINDOW_SHORTER_THAN_300_SECONDS');
  if (sameProcess && !observationsGrowing) warnings.push('NO_NEW_LOG_NOTIFICATIONS_IN_SAMPLE');
  if (second.backup.enabled !== true || second.backup.operational !== true)
    warnings.push('R2_BACKUP_NOT_CONFIRMED_RUNNING');
  if (second.backup.lastErrorCode) warnings.push('R2_LAST_ERROR_REPORTED');
  return {
    result: 'PARTIAL_UNQUANTIFIED',
    observedCoveragePercent: null,
    independentExpectedEventCount: null,
    sameProcess,
    observationsGrowing,
    first, second, firstRadar, secondRadar,
    delta,
    warnings,
    interpretation: 'Only scanner process counters and bounded live radar samples; no independent Solana transaction denominator and no proof of complete coverage.',
  };
}

async function getJson(path) {
  let lastError = 'REQUEST_FAILED';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(ORIGIN + path, {
        method: 'GET', redirect: 'error',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(70000),
      });
      if (!response.ok) throw Error('HTTP_' + response.status);
      const length = response.headers.get('content-length');
      if (length !== null && Number(length) > 3_000_000)
        throw Error('RESPONSE_TOO_LARGE');
      const body = await response.text();
      if (body.length > 3_000_000) throw Error('RESPONSE_TOO_LARGE');
      return JSON.parse(body);
    } catch (e) {
      lastError = /^HTTP_\d+$/.test(e?.message) ? e.message :
        e?.message === 'RESPONSE_TOO_LARGE' ? 'RESPONSE_TOO_LARGE' :
        'NETWORK_OR_INVALID_JSON';
      if (attempt < 2) await sleep(8000);
    }
  }
  throw Error(lastError);
}

async function probe() {
  const health = summarizeHealth(await getJson('/health'));
  const radar = summarizeRadar(await getJson('/radar?limit=1'));
  return { health, radar };
}

export async function run() {
  let report;
  try {
    const first = await probe();
    await sleep(45000);
    const second = await probe();
    report = analyzeSnapshots(first.health, second.health, first.radar, second.radar);
  } catch (e) {
    report = {
      result: 'AUDIT_UNAVAILABLE',
      errorCode: [
        'INVALID_COVERAGE_HEALTH_SCHEMA', 'EXPECTED_PROTOCOL_MISSING',
        'INVALID_RADAR_SCHEMA', 'HTTP_429', 'HTTP_503',
        'HTTP_500', 'RESPONSE_TOO_LARGE', 'NETWORK_OR_INVALID_JSON'
      ].includes(e?.message) ? e.message : 'AUDIT_FAILED',
      observedCoveragePercent: null,
      interpretation: 'Unable to verify live scanner; no coverage estimate can be made.',
    };
    process.exitCode = 1;
  }
  const output = JSON.stringify(report, null, 2) + '\n';
  await writeFile('solana-coverage-live-audit.json', output, { mode: 0o600 });
  const md = [
    '## Solana live coverage — read-only audit',
    '',
    '- Result: **' + report.result + '**',
    '- Network-wide coverage: **unknown, not 100%**',
    report.second ? '- Latest status: **' + report.second.status + '**' : '',
    report.second ? '- WebSocket connected: **' + report.second.websocketConnected + '**' : '',
    report.delta ? '- New log notifications: **' + report.delta.notifications + '**' : '',
    report.delta ? '- New decoded log events: **' + report.delta.decodedEvents + '**' : '',
    report.delta ? '- New persisted log events: **' + report.delta.persistedEvents + '**' : '',
    report.second ? '- R2 latest success in this process: **' + (report.second.backup.lastSuccessfulAt ?? 'unknown') + '**' : '',
    report.secondRadar ? '- Radar rows inspected / row cap: **' + report.secondRadar.rowsInspected + ' / ' + report.secondRadar.maxRowsRead + '**' : '',
    report.secondRadar ? '- Oldest observed event age: **' + (report.secondRadar.observedWindowSeconds ?? 'unknown') + ' seconds**' : '',
    '- Flags: ' + ((report.warnings ?? [report.errorCode]).join(', ') || 'none'),
    '',
    'Counters are process-local; no independent denominator, no proof of global completeness.',
  ].filter(Boolean).join('\n') + '\n';
  await writeFile('solana-coverage-live-summary.md', md, { mode: 0o600 });
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await run();
