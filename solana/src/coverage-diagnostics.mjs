// Read-only coverage evidence derived from *observed* program notifications and
// durable recovery checkpoints. Never turns local counters into a network-wide
// completeness percentage, because no independent denominator exists.
const safeGap = value => typeof value === 'string' &&
  /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : null;

export function buildCoverageDiagnostics({
  programs, streams, metrics, store, storage, config,
  now = Date.now(),
} = {}) {
  const counters = metrics?.counters ?? {};
  const gauges = metrics?.gauges ?? {};
  const observed = (programs ?? []).map(program => {
    const s = streams?.get(program.protocol) ?? {};
    const recovery = gauges['recovery.' + program.protocol] ?? null;
    const checkpoint = store?.checkpoint?.(program.programId) ?? null;
    const continuation = store?.recoveryState?.(program.programId) ?? null;
    const age = Date.parse(s.lastLogAt ?? '');
    return {
      protocol: program.protocol,
      programId: program.programId,
      logNotificationsSeen: s.notifications ?? 0,
      logEventsDecoded: s.decodedEvents ?? 0,
      decoderAlerts: s.decoderAlerts ?? 0,
      firstLogAt: s.firstLogAt ?? null,
      lastLogAt: s.lastLogAt ?? null,
      secondsSinceLastLog: Number.isFinite(age)
        ? Math.max(0, Math.floor((now - age) / 1000)) : null,
      lastObservedSlot: s.lastSlot ?? null,
      checkpointPresent: checkpoint !== null,
      checkpointContinuity: checkpoint?.continuity ?? null,
      recoveryCursorPending: continuation !== null,
      lastRecovery: recovery ? {
        complete: recovery.complete === true,
        checkpointAdvanced: recovery.checkpointAdvanced === true,
        continuation: recovery.continuation === true,
        pagesRequested: Number.isSafeInteger(recovery.pages) ? recovery.pages : 0,
        signaturesSelected: Number.isSafeInteger(recovery.selected) ? recovery.selected : 0,
        transactionHoles: Number.isSafeInteger(recovery.transactionHoles)
          ? recovery.transactionHoles : 0,
        gap: safeGap(recovery.gap),
      } : null,
    };
  });
  return {
    status: 'PARTIAL_UNQUANTIFIED',
    scope: 'configured_programs_rpc_log_notifications_and_bounded_http_recovery',
    networkWideCompletenessPercent: null,
    independentExpectedEventCount: null,
    rpcRequestsPerMinuteBudget: config?.requestsPerMinute ?? null,
    maxHttpContextPriority: config?.contextMaxPriority ?? null,
    totalNotificationsSeen: counters.notificationsReceived ?? 0,
    decodedLogEvents: counters.logObservationsDecoded ?? 0,
    persistedLogEvents: counters.logObservationsPersisted ?? 0,
    decoderFailures: counters.logDecoderFailures ?? 0,
    contextEnrichmentSkipped: counters.contextEnrichmentSkipped ?? 0,
    recoveryGapsReported: counters.recoveryGaps ?? 0,
    rpcRateLimitErrors: counters.rate_limit_errors ?? 0,
    persistenceFailures: counters.persistenceFailures ?? 0,
    pendingContextTransactions: storage?.pending ?? null,
    processingLatencyP95Ms: metrics?.histograms?.eventProcessingLatencyMs?.p95 ?? null,
    logPersistenceLatencyP95Ms: metrics?.histograms?.logObservationLatencyMs?.p95 ?? null,
    programs: observed,
    limitations: [
      'Counts describe this process since its latest start, not all Solana network transactions.',
      'A subscription acknowledgement and a live socket do not prove that the RPC provider delivered every log.',
      'Program-level log observations may be incomplete; historical HTTP enrichment is bounded and selective.',
      'Recovery gaps and missing transaction context are not a numerical estimate of lost trades.',
    ],
  };
}
