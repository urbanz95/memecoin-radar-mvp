import { recordLabel, recordTime, canonicalDecisionSql, readDecisionCanonicality } from './records.mjs';
import { aggregateWeeklyCohort, weeklyQuoteTierSql, weeklyReportWindow, WEEKLY_SCORE_BANDS } from './weekly-report.mjs';

const MAX_COHORT_BYTES = 65536;
const LEASE_MS = 120000;
const RETRY_BASE_MS = 60000;
const RETRY_MAX_MS = 21600000;
const TIERS = new Set(['T0', 'T1S', 'T1', 'T2', 'UNKNOWN']);
const iso = value => new Date(value).toISOString();
const atTime = now => recordTime(typeof now === 'function' ? now() : now, 'WEEKLY_JOB_TIME');
const emptyBand = definition => ({ ...definition, decisions: 0, uniqueTokens: 0, rejected: 0, dead: 0, passed: 0, otherStatuses: 0,
  horizons: Object.fromEntries(['15m', '1h', '24h', '7d'].map(horizon => [horizon, {
    denominator: 0, due: 0, observed: 0, returnSamples: 0, unknown: 0, returnUnknown: 0, notDue: 0,
    coveragePct: null, matureCoveragePct: null, returnCoveragePct: null, averageReturnPct: null,
    averagePriceUsd: null, averageLiquidityUsd: null, averageSourceLagMs: null, averageCaptureLagMs: null, numericOverflow: false,
  }])) });

function safeError(error) {
  const message = String(error?.message ?? '');
  if (/^MVP_[A-Z0-9_]{3,100}$/.test(message)) return message;
  if (/daily.*(?:write|written)|(?:write|written).*daily/i.test(message)) return 'MVP_WEEKLY_D1_DAILY_WRITE_LIMIT';
  if (/daily.*read|read.*daily/i.test(message)) return 'MVP_WEEKLY_D1_DAILY_READ_LIMIT';
  if (/time.?out|timed out/i.test(message)) return 'MVP_WEEKLY_TIMEOUT';
  return 'MVP_WEEKLY_JOB_FAILED';
}
function identity(job) {
  return { schemaVersion: 2, kind: 'mvp-weekly-observation-report', reportKey: job.report_key,
    weekStart: iso(job.week_start), weekEndExclusive: iso(job.week_end), scheduledFor: iso(job.scheduled_for),
    generatedAt: iso(job.data_cutoff), dataCutoff: iso(job.data_cutoff),
    canonicality: { generation: job.canonical_generation, invalidatedDecisions: job.canonical_invalidations },
    source: { decisions: 'Immutable first decisions; fixed source rowid boundary and canonical block proofs.',
      outcomes: 'mvp_outcomes, captured no later than the fixed cutoff', networkCalls: 0 },
    methodology: { denominator: 'One score-version/profile/quote-tier cohort. Real rejected/dead/unknown decisions remain included.',
      returns: 'Descriptive price returns against the immutable first baseline; not realized wallet PnL or a backtest.',
      unknowns: 'Missing/stale observations remain unknown. Unproved quote tiers are UNKNOWN; orphaned/unproved blocks are excluded.',
      versions: 'Cohorts are paginated separately; there is no pooled cross-version/profile/tier result.',
      schedule: 'Independent job, Monday 00:15 UTC, cohort two UTC weeks earlier; one cohort per invocation.',
      frozenMembership: 'Only decisions present at job creation can enter the report; later backfill never changes existing pages.' },
    noBacktest: true, noModel: true };
}
function pagination(job, page = 0) {
  return { page, totalPages: job.next_page, hasPrevious: page > 0,
    hasNext: page + 1 < job.next_page, complete: job.state === 'COMPLETE', limit: 1 };
}
function validateFilters({ scoreVersion, profile, quoteTier, reportKey, page = 0 }) {
  if (scoreVersion !== undefined) recordLabel(scoreVersion, 'WEEKLY_SCORE_VERSION', 100);
  if (profile !== undefined) recordLabel(profile, 'WEEKLY_PROFILE', 100);
  if (quoteTier !== undefined && !TIERS.has(quoteTier)) throw new Error('MVP_WEEKLY_INVALID_QUOTE_TIER');
  if (reportKey !== undefined) recordLabel(reportKey, 'WEEKLY_REPORT_KEY', 512);
  if (!Number.isSafeInteger(page) || page < 0 || page > 1000000) throw new Error('MVP_WEEKLY_INVALID_PAGE');
}
async function sameCanonicality(DB, job) {
  const canonical = await readDecisionCanonicality(DB);
  return canonical.revalidationComplete !== false && canonical.generation === job.canonical_generation
    && canonical.invalidatedDecisions === job.canonical_invalidations;
}
function epochGuard() {
  return 'EXISTS(SELECT 1 FROM mvp_decision_epoch e WHERE e.id=1 AND e.generation=? AND e.invalidated_decisions=?)';
}

async function nextCohort(DB, job) {
  const cursor = job.cursor_version === null ? '' : `AND (d.score_version>? OR (d.score_version=? AND d.profile>?)
    OR (d.score_version=? AND d.profile=? AND ${weeklyQuoteTierSql()}>?))`;
  const values = [job.week_start, job.week_end, job.source_rowid_limit,
    ...(job.score_version === null ? [] : [job.score_version]),
    ...(job.cursor_version === null ? [] : [job.cursor_version, job.cursor_version, job.cursor_profile,
      job.cursor_version, job.cursor_profile, job.cursor_tier])];
  return DB.prepare(`SELECT d.score_version,d.profile,${weeklyQuoteTierSql()} AS quote_tier
    FROM mvp_decisions d INDEXED BY mvp_decisions_week_time
    WHERE d.first_decision_at>=? AND d.first_decision_at<? AND d.rowid<=?
      ${job.score_version === null ? '' : 'AND d.score_version=?'}
      AND (${canonicalDecisionSql('d', { checkedBefore: job.data_cutoff })}) ${cursor}
    GROUP BY d.score_version,d.profile,quote_tier ORDER BY d.score_version,d.profile,quote_tier LIMIT 1`).bind(...values).first();
}
async function cohortPage(DB, job, cohort, generatedAt) {
  const options = { window: { start: job.week_start, end: job.week_end }, scoreVersion: cohort.score_version,
    cutoff: job.data_cutoff, profile: cohort.profile, quoteTier: cohort.quote_tier, rowidLimit: job.source_rowid_limit,
    canonicalPredicate: canonicalDecisionSql('d', { checkedBefore: job.data_cutoff }) };
  const token = await aggregateWeeklyCohort(DB, options);
  const wallet = await aggregateWeeklyCohort(DB, { ...options, dimension: 'wallet' });
  if (token.cohorts.length > 1 || wallet.cohorts.length > 1
    || token.totals.decisions !== wallet.totals.decisions) throw new Error('MVP_WEEKLY_COHORT_CHANGED');
  const tokenCohort = token.cohorts[0] ?? { scoreVersion: cohort.score_version, profile: cohort.profile,
    quoteTier: cohort.quote_tier, decisions: 0, rejected: 0, dead: 0, passed: 0, otherStatuses: 0,
    bands: WEEKLY_SCORE_BANDS.map(emptyBand), unknownScore: emptyBand({ id: 'UNKNOWN', min: null, maxExclusive: null }) };
  const walletCohort = wallet.cohorts[0];
  const selected = { ...tokenCohort, walletScoreBands: walletCohort?.bands ?? WEEKLY_SCORE_BANDS.map(emptyBand),
    walletUnknownScore: walletCohort?.unknownScore ?? emptyBand({ id: 'UNKNOWN', min: null, maxExclusive: null }) };
  const report = { ...identity(job), scoreVersion: cohort.score_version, profile: cohort.profile, quoteTier: cohort.quote_tier,
    generatedAt: iso(generatedAt),
    totals: { sourceDecisions: token.totals.decisions, uniqueSourceTokens: token.totals.unique_tokens,
      uniqueRealTokens: token.totals.real_unique_tokens, realDecisions: token.totals.real_decisions,
      syntheticExcluded: token.totals.synthetic_excluded, provenanceUnknownExcluded: token.totals.provenance_unknown,
      unknownScoreDecisions: token.totals.unknown_scores, unknownWalletScoreDecisions: wallet.totals.unknown_scores,
      rejected: token.totals.rejected, dead: token.totals.dead, passed: token.totals.passed },
    bands: selected.bands, unknownScore: selected.unknownScore, walletScoreBands: selected.walletScoreBands,
    walletUnknownScore: selected.walletUnknownScore, cohorts: [selected],
    walletScoreReport: { schemaVersion: 1, status: 'READY', generatedAt: iso(generatedAt), dataCutoff: iso(job.data_cutoff),
      source: 'Immutable decision-time wallet score; only numeric READY values, never current wallet performance.' } };
  const serialized = JSON.stringify(report);
  if (new TextEncoder().encode(serialized).length > MAX_COHORT_BYTES) throw new Error('MVP_WEEKLY_COHORT_PAGE_TOO_LARGE');
  return serialized;
}

/** Dedicated descriptive job. It owns its small batches; it never joins the ingestion transaction. */
export async function runWeeklyReportJob(DB, { now = Date.now, scoreVersion, weekStart } = {}) {
  const at = atTime(now); validateFilters({ scoreVersion });
  const window = weeklyReportWindow(at, weekStart);
  if (at < window.scheduledFor) return { status: 'NOT_DUE', pagesWritten: 0 };
  const canonical = await readDecisionCanonicality(DB);
  // Do not freeze an empty/partial week while old baseline headers are still
  // quarantined. A later successful revalidation must be able to build it.
  if (canonical.revalidationComplete === false) return { status: 'WAITING_CANONICALITY', pagesWritten: 0 };
  const key = JSON.stringify(['weekly-v2', window.start, scoreVersion ?? null, canonical.generation, canonical.invalidatedDecisions]);
  let job;
  // Resume unfinished older weeks before starting a new one. Each invocation is
  // still bounded to a single cohort, and the original snapshot stays frozen.
  if (weekStart === undefined) job = await DB.prepare(`SELECT * FROM mvp_weekly_jobs WHERE state IN ('PENDING','RETRY')
    AND canonical_generation=? AND canonical_invalidations=? AND next_attempt_at<=? ${scoreVersion === undefined ? 'AND score_version IS NULL' : 'AND score_version=?'}
    ORDER BY week_start,data_cutoff LIMIT 1`).bind(canonical.generation, canonical.invalidatedDecisions, at,
      ...(scoreVersion === undefined ? [] : [scoreVersion])).first();
  job ??= await DB.prepare('SELECT * FROM mvp_weekly_jobs WHERE report_key=?').bind(key).first();
  if (!job) {
    const boundary = await DB.prepare('SELECT coalesce(max(rowid),0) AS last_rowid FROM mvp_decisions').first();
    await DB.prepare(`INSERT OR IGNORE INTO mvp_weekly_jobs
      (report_key,score_version,week_start,week_end,scheduled_for,data_cutoff,source_rowid_limit,canonical_generation,canonical_invalidations,next_attempt_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(key, scoreVersion ?? null, window.start, window.end, window.scheduledFor,
        at, boundary.last_rowid, canonical.generation, canonical.invalidatedDecisions, at, at).run();
    job = await DB.prepare('SELECT * FROM mvp_weekly_jobs WHERE report_key=?').bind(key).first();
  }
  if (job.state === 'COMPLETE') return { status: 'COMPLETE', pagesWritten: 0, reportKey: job.report_key };
  if (job.next_attempt_at > at || job.lease_until > at) return { status: job.state, pagesWritten: 0, reportKey: job.report_key };
  const owner = crypto.randomUUID();
  const claimed = await DB.prepare(`UPDATE mvp_weekly_jobs SET lease_owner=?,lease_until=? WHERE report_key=? AND lease_until<=?
    AND state IN ('PENDING','RETRY') AND ${epochGuard()}`)
    .bind(owner, at + LEASE_MS, job.report_key, at, canonical.generation, canonical.invalidatedDecisions).run();
  if (!claimed.meta?.changes) return { status: 'BUSY', pagesWritten: 0, reportKey: job.report_key };
  try {
    const cohort = await nextCohort(DB, job);
    if (!cohort) {
      await DB.prepare(`UPDATE mvp_weekly_jobs SET state='COMPLETE',lease_owner=NULL,lease_until=0,last_error=NULL,updated_at=?
        WHERE report_key=? AND lease_owner=? AND ${epochGuard()}`)
        .bind(at, job.report_key, owner, job.canonical_generation, job.canonical_invalidations).run();
      return { status: 'COMPLETE', pagesWritten: 0, reportKey: job.report_key };
    }
    const serialized = await cohortPage(DB, job, cohort, at);
    if (!await sameCanonicality(DB, job)) {
      await DB.prepare("UPDATE mvp_weekly_jobs SET state='QUARANTINED',lease_owner=NULL,lease_until=0,updated_at=? WHERE report_key=? AND lease_owner=?")
        .bind(at, job.report_key, owner).run();
      return { status: 'QUARANTINED', pagesWritten: 0, reportKey: job.report_key };
    }
    const guard = `EXISTS(SELECT 1 FROM mvp_weekly_jobs j WHERE j.report_key=? AND j.lease_owner=? AND j.next_page=?) AND ${epochGuard()}`;
    await DB.batch([
      DB.prepare(`INSERT OR IGNORE INTO mvp_weekly_cohort_pages
        (report_key,page_index,score_version,profile,quote_tier,generated_at,data_cutoff,report_json)
        SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`)
        .bind(job.report_key, job.next_page, cohort.score_version, cohort.profile, cohort.quote_tier, at, job.data_cutoff, serialized,
          job.report_key, owner, job.next_page, job.canonical_generation, job.canonical_invalidations),
      DB.prepare(`UPDATE mvp_weekly_jobs SET next_page=next_page+1,cursor_version=?,cursor_profile=?,cursor_tier=?,
        state='PENDING',last_error=NULL,lease_owner=NULL,lease_until=0,next_attempt_at=?,updated_at=?
        WHERE report_key=? AND lease_owner=? AND next_page=? AND ${epochGuard()}`)
        .bind(cohort.score_version, cohort.profile, cohort.quote_tier, at, at, job.report_key, owner, job.next_page,
          job.canonical_generation, job.canonical_invalidations),
    ]);
    return { status: 'PENDING', pagesWritten: 1, reportKey: job.report_key, page: job.next_page };
  } catch (error) {
    const code = safeError(error);
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(12, job.attempt_count));
    // Quota failures can prevent even this diagnostic write. The caller still
    // receives a safe cause; heartbeat logging must not depend on D1 writes.
    try {
      await DB.prepare(`UPDATE mvp_weekly_jobs SET state='RETRY',attempt_count=attempt_count+1,next_attempt_at=?,
        last_error=?,lease_owner=NULL,lease_until=0,updated_at=? WHERE report_key=? AND lease_owner=?`)
        .bind(at + delay, code, at, job.report_key, owner).run();
    } catch { /* Cause is retained in the return payload even if storage is unavailable. */ }
    return { status: 'RETRY', pagesWritten: 0, reportKey: job.report_key, error: code, nextAttemptAt: iso(at + delay) };
  }
}

/** One indexed bounded cohort page, never a pooled report or an aggregate query. */
export async function getWeeklyReportPage(DB, { reportKey, page = 0, scoreVersion, profile, quoteTier } = {}) {
  validateFilters({ reportKey, page, scoreVersion, profile, quoteTier });
  const job = reportKey === undefined
    ? await DB.prepare(`SELECT * FROM mvp_weekly_jobs WHERE state IN ('PENDING','RETRY','COMPLETE')
        ${scoreVersion === undefined ? '' : 'AND (score_version=? OR score_version IS NULL)'}
        ORDER BY week_start DESC,data_cutoff DESC LIMIT 1`).bind(...(scoreVersion === undefined ? [] : [scoreVersion])).first()
    : await DB.prepare('SELECT * FROM mvp_weekly_jobs WHERE report_key=?').bind(reportKey).first();
  if (!job) return null;
  if (job.state === 'QUARANTINED' || !await sameCanonicality(DB, job)) return { ...identity(job), quarantined: true,
    quarantineReason: 'CANONICALITY_CHANGED', cohorts: [], bands: null, walletScoreBands: null,
    pagination: pagination(job, page) };
  if (!job.next_page && job.state === 'COMPLETE') return { ...identity(job), scoreVersion: job.score_version,
    profile: null, quoteTier: 'UNKNOWN', cohorts: [], bands: [], walletScoreBands: [],
    totals: { sourceDecisions: 0, realDecisions: 0, uniqueSourceTokens: 0, uniqueRealTokens: 0,
      syntheticExcluded: 0, provenanceUnknownExcluded: 0, unknownScoreDecisions: 0,
      unknownWalletScoreDecisions: 0, rejected: 0, dead: 0, passed: 0 }, pagination: pagination(job, 0) };
  const filtered = scoreVersion !== undefined || profile !== undefined || quoteTier !== undefined;
  const row = await DB.prepare(`SELECT page_index,report_json FROM mvp_weekly_cohort_pages WHERE report_key=?
      ${filtered ? `${scoreVersion === undefined ? '' : 'AND score_version=?'} ${profile === undefined ? '' : 'AND profile=?'}
        ${quoteTier === undefined ? '' : 'AND quote_tier=?'} ORDER BY page_index LIMIT 1` : 'AND page_index=?'}`)
    .bind(job.report_key, ...(filtered ? [...(scoreVersion === undefined ? [] : [scoreVersion]),
      ...(profile === undefined ? [] : [profile]), ...(quoteTier === undefined ? [] : [quoteTier])] : [page])).first();
  if (!row) return null;
  return { ...JSON.parse(row.report_json), pagination: pagination(job, row.page_index) };
}
