#!/usr/bin/env node
/** Read-only local health sampler: no additional Solana RPC calls. */
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseArgs(args) {
  const settings = {
    seconds: 180, interval: 10,
    url: 'http://127.0.0.1:8791/health',
    output: 'runtime/pump-focused-smoke.json',
  };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--seconds', '--interval', '--output', '--url'].includes(key))
      throw Error(`UNKNOWN_ARGUMENT_${key}`);
    if (++i >= args.length) throw Error(`MISSING_VALUE_${key.slice(2).toUpperCase()}`);
    settings[key.slice(2)] = args[i];
  }
  for (const [name, min, max] of [['seconds', 30, 600], ['interval', 2, 60]]) {
    const n = Number(settings[name]);
    if (!Number.isSafeInteger(n) || n < min || n > max)
      throw Error(`INVALID_${name.toUpperCase()}`);
    settings[name] = n;
  }
  if (settings.interval > settings.seconds) throw Error('INTERVAL_EXCEEDS_DURATION');
  let u;
  try { u = new URL(settings.url); } catch { throw Error('INVALID_HEALTH_URL'); }
  if (u.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
      u.pathname !== '/health' || u.search || u.hash || u.username || u.password)
    throw Error('HEALTH_URL_MUST_BE_LOOPBACK');
  if (typeof settings.output !== 'string' || !settings.output.trim())
    throw Error('INVALID_OUTPUT_PATH');
  return settings;
}

export function summarizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length < 2)
    throw Error('INSUFFICIENT_HEALTH_SAMPLES');
  const first = samples[0], last = samples.at(-1);
  for (const s of samples) {
    if (s?.chain !== 'solana' || s.mode !== 'READ_ONLY' ||
        !s?.metrics?.counters || !s?.metrics?.gauges || !s?.storage ||
        !Number.isFinite(Date.parse(s.metrics.measuredAt)))
      throw Error('INVALID_HEALTH_SNAPSHOT');
    if (s.metrics.startedAt !== first.metrics.startedAt ||
        s.startedAt !== first.startedAt)
      throw Error('SCANNER_RESTARTED_DURING_SMOKE');
  }
  const elapsedSeconds =
    (Date.parse(last.metrics.measuredAt) - Date.parse(first.metrics.measuredAt)) / 1000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0)
    throw Error('INVALID_SAMPLE_TIMING');
  const keys = new Set(samples.flatMap(s => Object.keys(s.metrics.counters)));
  const counterDeltas = {};
  for (const key of [...keys].sort()) {
    let previous = -Infinity;
    for (const s of samples) {
      const v = s.metrics.counters[key] ?? 0;
      if (!Number.isSafeInteger(v) || v < 0 || v < previous)
        throw Error('COUNTER_RESET_DURING_SMOKE');
      previous = v;
    }
    counterDeltas[key] =
      (last.metrics.counters[key] ?? 0) - (first.metrics.counters[key] ?? 0);
  }
  const count = name => counterDeltas[name] ?? 0;
  const requests = count('rpc_requests');
  const processed = count('transactionsProcessed');
  const latencyAtEnd = Object.fromEntries(
    ['logObservationLatencyMs', 'eventProcessingLatencyMs',
     'transactionEnrichmentLatencyMs'].map(name => {
      const h = last.metrics.histograms?.[name];
      return [name, h ? {
        p50Ms: h.p50 ?? null, p95Ms: h.p95 ?? null, p99Ms: h.p99 ?? null,
        sampleCountSinceProcessStart: h.count, retainedSamples: h.retainedSamples,
        scope: 'end-of-window process reservoir; NOT a per-window latency percentile',
      } : null];
    })
  );
  return {
    schemaVersion: 1,
    mode: 'LOCAL_READ_ONLY_HEALTH_SAMPLING',
    startedAt: first.metrics.measuredAt,
    endedAt: last.metrics.measuredAt,
    elapsedSeconds,
    sampleCount: samples.length,
    programs: last.programs?.map(p => p.protocol) ?? [],
    statuses: Object.fromEntries(
      [...new Set(samples.map(s => s.status))]
        .map(status => [status, samples.filter(s => s.status === status).length])
    ),
    coverage: 'PARTIAL',
    counterDeltas,
    windowRates: {
      notificationsPerSecond: count('notificationsReceived') / elapsedSeconds,
      logObservationsPersistedPerSecond: count('logObservationsPersisted') / elapsedSeconds,
      enrichedTransactionsPerMinute: 60 * processed / elapsedSeconds,
      rpcRequestsPerMinute: 60 * requests / elapsedSeconds,
      rpcRequestsPerEnrichedTransaction: processed ? requests / processed : null,
    },
    lastGauges: {
      websocket_connected: last.metrics.gauges.websocket_connected ?? null,
      durableBacklog: last.metrics.gauges.durableBacklog ?? null,
      coverageOverloaded: last.metrics.gauges.coverageOverloaded ?? null,
    },
    reliability: {
      degradedSamples: samples.filter(s => s.status === 'DEGRADED').length,
      overloadedSamples: samples.filter(s => s.metrics.gauges.coverageOverloaded === true).length,
      disconnectedSamples: samples.filter(s => s.metrics.gauges.websocket_connected === false).length,
      recoveryGapDelta: count('recoveryGaps'),
      decoderFailureDelta: count('decoderFailures') + count('logDecoderFailures'),
      interpretation: 'Diagnostic counts only; neither complete coverage nor a trading readiness verdict.',
    },
    lastStorage: {
      pending: last.storage.pending ?? null,
      deferred: last.storage.deferred ?? null,
      eventsRetained: last.storage.events ?? null,
      logObservationsRetained: last.storage.event_observations ?? null,
      gapsRetained: last.storage.gaps ?? null,
      storageBytes: last.storage.storageBytes ?? null,
    },
    latencyAtEnd,
    warnings: [
      'Notification counts, retained observations, and enriched event counts have different units. They cannot form a coverage fraction.',
      'Storage row counts reflect retention and are not interval event counts.',
      'Latency percentiles reflect the process reservoir, not just this sampling window.',
      'RPC requests include recovery and reconciliation, so RPC calls per enriched transaction are not direct marginal costs.',
      'Partial observations and unknown fields are not token safety guarantees.',
    ],
  };
}

async function fetchSnapshot(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (!response.ok) throw Error(`LOCAL_HEALTH_HTTP_${response.status}`);
  return response.json();
}

async function run(args = process.argv.slice(2)) {
  const cfg = parseArgs(args);
  const samples = [await fetchSnapshot(cfg.url)];
  const deadline = Date.now() + cfg.seconds * 1000;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(cfg.interval * 1000, remaining));
    samples.push(await fetchSnapshot(cfg.url));
  }
  const result = summarizeSamples(samples);
  const output = resolve(cfg.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n',
    { flag: 'w', mode: 0o600 });
  console.log(JSON.stringify({
    output, elapsedSeconds: result.elapsedSeconds,
    windowRates: result.windowRates, statuses: result.statuses,
    lastStorage: result.lastStorage, lastGauges: result.lastGauges,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  run().catch(e => {
    console.error(`pump-focused-smoke: ${e.message}`);
    process.exitCode = 1;
  });
