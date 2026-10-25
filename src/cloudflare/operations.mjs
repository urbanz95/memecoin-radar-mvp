import settings from '../../config/operations.json' with { type: 'json' };

const positive = value => Number.isSafeInteger(value) && value > 0;
const keysAre = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));

export function validateOperationsConfig(value) {
  const c = value?.collector, h = value?.heartbeat, w = value?.weekly;
  if (
    !keysAre(value, ['schemaVersion', 'collector', 'weekly', 'heartbeat']) || value?.schemaVersion !== 1
    || !keysAre(c, [
      'minimumCadenceSeconds', 'maximumCadenceSeconds', 'dailyD1WriteBudget', 'estimatedWriteOverhead',
      'unknownCycleWriteEstimate', 'unfinishedCycleWriteReservation', 'maximumExpiredOutcomeJobs',
      'cadenceCostWindow', 'retryBackoffSeconds', 'stabilityHours', 'maximumContinuityGapSeconds',
    ])
    || !keysAre(h, ['cron', 'staleAfterSeconds', 'notificationChannel'])
    || !keysAre(w, ['cron', 'cohortsPerInvocation'])
    || ![
      'minimumCadenceSeconds', 'maximumCadenceSeconds', 'dailyD1WriteBudget', 'estimatedWriteOverhead',
      'unknownCycleWriteEstimate', 'unfinishedCycleWriteReservation', 'maximumExpiredOutcomeJobs',
      'cadenceCostWindow', 'stabilityHours', 'maximumContinuityGapSeconds',
    ].every(key => positive(c[key]))
    || c.maximumExpiredOutcomeJobs > 24 || c.cadenceCostWindow > 64
    || c.unfinishedCycleWriteReservation < c.unknownCycleWriteEstimate + c.estimatedWriteOverhead
    || c.unfinishedCycleWriteReservation > c.dailyD1WriteBudget
    || c.minimumCadenceSeconds < 60 || c.maximumCadenceSeconds < c.minimumCadenceSeconds
    || c.maximumCadenceSeconds > 3600 || c.dailyD1WriteBudget > 80000
    || c.maximumContinuityGapSeconds > 600 || c.stabilityHours < 6
    || !Array.isArray(c.retryBackoffSeconds) || !c.retryBackoffSeconds.length || c.retryBackoffSeconds.length > 8
    || !c.retryBackoffSeconds.every((value, index, values) => positive(value)
      && value >= c.minimumCadenceSeconds && value <= c.maximumCadenceSeconds
      && (index === 0 || value >= values[index - 1]))
    || h.staleAfterSeconds !== 600 || h.notificationChannel !== 'GITHUB_ISSUE'
    || w.cohortsPerInvocation !== 1 || w.cron !== '2-59/5 * * * *' || h.cron !== '4-59/5 * * * *'
  ) throw Error('INVALID_OPERATIONS_CONFIG');
  return value;
}

export const OPERATIONS_CONFIG = validateOperationsConfig(settings);

/** Defer only historical retries. Every selected open capture window retains
 * its ordering and full version/profile fanout; no persisted job is modified. */
export function limitOutcomeRetries(jobs, { config = OPERATIONS_CONFIG } = {}) {
  const maximum = config?.collector?.maximumExpiredOutcomeJobs;
  if (!Array.isArray(jobs) || !positive(maximum) || maximum > 24) throw Error('INVALID_OUTCOME_RETRY_BUDGET');
  let expired = 0;
  return jobs.filter(job => {
    if (job?.captureState === 'LIVE') return true;
    if (job?.captureState !== 'EXPIRED') throw Error('INVALID_OUTCOME_CAPTURE_STATE');
    return expired++ < maximum;
  });
}

const KEY = 'operations.v1';
const day = at => new Date(at).toISOString().slice(0, 10);
const iso = at => at === null || at === undefined ? null : new Date(at).toISOString();
const nextDay = at => Date.parse(day(at) + 'T00:00:00Z') + 86400000;
const timestamp = value => typeof value === 'string' ? Date.parse(value) : Number.isSafeInteger(value) ? value : NaN;

export function operationError(error, { stage = 'collection', at = Date.now() } = {}) {
  const text = typeof error === 'string' ? error : error?.message ?? '';
  let code;
  if (/exceeded D1.*daily row write limit/i.test(text) || text === 'D1_DAILY_WRITE_LIMIT') code = 'D1_DAILY_WRITE_LIMIT';
  else if (/exceeded D1.*daily row read limit/i.test(text) || text === 'D1_DAILY_READ_LIMIT') code = 'D1_DAILY_READ_LIMIT';
  else if (/D1.*(?:storage|database).*limit/i.test(text)) code = 'D1_STORAGE_LIMIT';
  else if (/D1_ERROR.*(?:overload|rate limit|too many)/i.test(text)) code = 'D1_RATE_LIMIT';
  else if (/^(?:MVP|ACCOUNTING|WALLET|RPC|INVALID|WRONG|STALE|REORG|EVIDENCE|RANGE|D1|CPU)_[A-Z0-9_]{1,100}$/.test(text)) code = text;
  else if (/CPU time limit|exceeded.*CPU/i.test(text)) code = 'CPU_LIMIT';
  else code = 'COLLECTION_FAILED';
  const module = code.startsWith('D1_') ? 'd1'
    : code.includes('WEEKLY') ? 'weekly'
    : /WALLET|ACCOUNTING/.test(code) ? 'wallet'
    : code.startsWith('RPC_') ? 'rpc'
    : code.startsWith('CPU_') ? 'cpu' : 'collector';
  return { code, module, stage, at: iso(at) };
}

async function stateOf(storage) {
  const value = await storage.get(KEY);
  return value?.schemaVersion === 1 ? value : {
    schemaVersion: 1,
    lastSuccessAt: null,
    lastError: null,
    completedCycles: 0,
    stableSince: null,
    nextEligibleAt: 0,
    failures: 0,
  };
}

export async function readOperations(storage, { now = Date.now(), config = OPERATIONS_CONFIG } = {}) {
  const state = await stateOf(storage), last = timestamp(state.lastSuccessAt), since = timestamp(state.stableSince);
  const maximumGap = config.collector.maximumContinuityGapSeconds * 1000;
  const inProgress = timestamp(state.lastCycleStartedAt) > timestamp(state.lastCycleCompletedAt)
    || Boolean(state.lastCycleStartedAt && !state.lastCycleCompletedAt);
  return {
    ...state,
    cadenceSeconds: state.cadenceSeconds ?? config.collector.minimumCadenceSeconds,
    budget: {
      dayUtc: day(now),
      estimatedRowsWritten: state.budget?.dayUtc === day(now) ? state.budget.estimatedRowsWritten : 0,
      limit: config.collector.dailyD1WriteBudget,
      circuitUntil: state.circuitUntil > now ? iso(state.circuitUntil) : null,
      scope: 'collector-estimate-plus-overhead; excludes administrative writes and weekly job; 20000-row account reserve',
    },
    stability: {
      stableSince: iso(state.stableSince),
      requiredHours: config.collector.stabilityHours,
      completedCycles: state.completedCycles,
      qualified: Number.isFinite(last) && Number.isFinite(since) && !inProgress
        && now - last <= maximumGap && last - since >= config.collector.stabilityHours * 3600000
        && !state.lastError,
    },
  };
}

export function heartbeatPayload(operations, { now = Date.now(), lastSuccessAt = null, config = OPERATIONS_CONFIG } = {}) {
  const effective = timestamp(operations.lastSuccessAt ?? lastSuccessAt);
  const age = Number.isFinite(effective) ? Math.max(0, now - effective) / 1000 : null;
  const incomplete = timestamp(operations.lastCycleStartedAt) > timestamp(operations.lastCycleCompletedAt)
    || Boolean(operations.lastCycleStartedAt && !operations.lastCycleCompletedAt);
  return {
    event: 'COLLECTOR_HEARTBEAT',
    checkedAt: iso(now),
    lastSuccessAt: Number.isFinite(effective) ? iso(effective) : null,
    ageSeconds: age,
    alert: age === null || age > config.heartbeat.staleAfterSeconds,
    thresholdSeconds: config.heartbeat.staleAfterSeconds,
    cause: operations.lastError ?? (
      incomplete && now - timestamp(operations.lastCycleStartedAt) > config.heartbeat.staleAfterSeconds * 1000
        ? { code: 'CYCLE_INCOMPLETE_OR_INTERRUPTED', module: 'collector', stage: 'heartbeat' }
        : age === null
          ? { code: 'NO_SUCCESS_RECORDED', module: 'collector', stage: 'heartbeat' }
          : age > config.heartbeat.staleAfterSeconds
            ? { code: 'NO_RECENT_COMPLETED_CYCLE', module: 'collector', stage: 'heartbeat' }
            : null
    ),
    notificationChannel: config.heartbeat.notificationChannel,
    telegramDelivery: false,
  };
}

/** Pace using bounded, observed charges rather than assuming the last burst
 * repeats all day. Every charge still enters the hard daily budget in full.
 * Legacy journals start with one real sample; unknown work costs its reserve.
 */
function recordWriteCharge(state, charge, finished, config) {
  const previous = state.writePacing;
  const valid = previous?.dayUtc === day(finished) && Array.isArray(previous.samples)
    && previous.samples.length <= 64 && previous.samples.every(positive);
  const samples = [...(valid ? previous.samples : []), charge].slice(-config.cadenceCostWindow);
  const meanRowsPerCycle = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  state.writePacing = {
    dayUtc: day(finished),
    samples,
    meanRowsPerCycle,
    windowSize: config.cadenceCostWindow,
  };
  state.cadenceSeconds = Math.min(config.maximumCadenceSeconds,
    Math.max(config.minimumCadenceSeconds, Math.ceil(meanRowsPerCycle * 86400 / config.dailyD1WriteBudget)));
}

/** The DO journal remains writable when D1 daily writes are exhausted. No D1 call on cadence/circuit skips. */
export async function runManagedCollection({ storage, collect, now = Date.now, config = OPERATIONS_CONFIG }) {
  const started = now(), state = await stateOf(storage), c = config.collector;
  if (state.circuitUntil > started) return { status: 'SKIPPED', reason: 'D1_QUOTA_COOLDOWN', retryAt: iso(state.circuitUntil) };
  if (state.nextEligibleAt > started) return { status: 'SKIPPED', reason: 'COLLECTION_CADENCE', retryAt: iso(state.nextEligibleAt) };
  let budget = state.budget?.dayUtc === day(started) ? state.budget : { dayUtc: day(started), estimatedRowsWritten: 0 };
  const estimate = Math.max(c.unknownCycleWriteEstimate, state.lastCycleRowsWritten ?? 0);
  const reservation = Math.max(c.unfinishedCycleWriteReservation, estimate + c.estimatedWriteOverhead);
  if (budget.estimatedRowsWritten + reservation > c.dailyD1WriteBudget) {
    Object.assign(state, {
      budget,
      circuitUntil: nextDay(started),
      lastError: operationError('D1_DAILY_WRITE_BUDGET', { stage: 'budget', at: started }),
      stableSince: null,
      nextEligibleAt: nextDay(started),
    });
    await storage.put(KEY, state);
    return { status: 'SKIPPED', reason: 'D1_DAILY_WRITE_BUDGET', retryAt: iso(state.circuitUntil) };
  }
  // Durable preflight also prevents an invocation killed by a platform limit from silently preserving stability.
  if (state.lastCycleStartedAt && !state.lastCycleCompletedAt
    || timestamp(state.lastCycleStartedAt) > timestamp(state.lastCycleCompletedAt)) {
    state.lastError = operationError('INVALID_PREVIOUS_CYCLE_COMPLETION', { stage: 'recovery', at: started });
    state.stableSince = null;
  }
  state.lastCycleStartedAt = iso(started);
  state.nextEligibleAt = started + c.minimumCadenceSeconds * 1000;
  state.budget = budget;
  // Reserve before any D1 call. A CPU kill or ambiguous commit retains the
  // conservative reservation; a completed measured invocation reconciles it.
  budget.estimatedRowsWritten += reservation;
  await storage.put(KEY, state);
  let result;
  try {
    result = await collect();
  } catch (error) {
    result = { status: 'ERROR', reason: operationError(error, { at: now() }).code };
  }
  const finished = now();
  state.lastCycleCompletedAt = iso(finished);
  if (result.status === 'SKIPPED') {
    budget.estimatedRowsWritten -= reservation - c.estimatedWriteOverhead;
    await storage.put(KEY, state);
    return result;
  }
  const measured = Number.isSafeInteger(result.d1RowsWritten) && result.d1RowsWritten >= 0;
  const cycleWrites = measured ? result.d1RowsWritten : estimate;
  const charge = measured ? cycleWrites + c.estimatedWriteOverhead : reservation;
  if (day(finished) !== budget.dayUtc) {
    budget = { dayUtc: day(finished), estimatedRowsWritten: 0 };
    state.budget = budget;
  } else budget.estimatedRowsWritten -= reservation;
  budget.estimatedRowsWritten += charge;
  state.lastCycleRowsWritten = cycleWrites;
  recordWriteCharge(state, charge, finished, c);
  if (result.status === 'COMPLETED') {
    const prior = timestamp(state.lastSuccessAt);
    if (state.lastError || !Number.isFinite(prior) || finished - prior > c.maximumContinuityGapSeconds * 1000)
      state.stableSince = finished;
    state.lastSuccessAt = iso(finished);
    state.lastError = null;
    state.failures = 0;
    state.completedCycles++;
    state.circuitUntil = 0;
    state.nextEligibleAt = finished + state.cadenceSeconds * 1000;
  } else {
    state.failures = (state.failures ?? 0) + 1;
    state.lastError = operationError(result.reason, { at: finished });
    state.stableSince = null;
    state.nextEligibleAt = finished
      + c.retryBackoffSeconds[Math.min(state.failures - 1, c.retryBackoffSeconds.length - 1)] * 1000;
    if (['D1_DAILY_WRITE_LIMIT', 'D1_DAILY_READ_LIMIT'].includes(state.lastError.code)) state.circuitUntil = nextDay(finished);
  }
  await storage.put(KEY, state);
  return {
    ...result,
    operations: {
      cadenceSeconds: state.cadenceSeconds,
      estimatedRowsWritten: budget.estimatedRowsWritten,
      dayUtc: budget.dayUtc,
      lastError: state.lastError,
    },
  };
}
