import { publicReport } from './public-report.mjs';
import { getMvpStats } from '../mvp/records.mjs';
import { getDryRunAlertStats, getRecentDryRunAlerts } from '../mvp/alerts.mjs';
import { getWalletLedgerStats } from '../mvp/wallet-ledger.mjs';
import { getLatestWeeklyReport, getWeeklyReportPage } from '../mvp/weekly-report.mjs';
import { heartbeatPayload, operationError } from './operations.mjs';

export const operationsEnabled = env => Object.hasOwn(env, 'OPERATIONS_ENABLED') && env.OPERATIONS_ENABLED === '1';
const routes = new Set(['/health', '/latest', '/weekly']);

/** Shared compatibility handler. Managed deployments execute it inside the
 * Collector DO, whose CPU budget fits report construction. The stateless Worker
 * forwards its Response unchanged. getOperations reads that DO's local journal;
 * calling the namespace again here would recurse into the same actor.
 */
export async function readPublicApi(request, env, { getOperations = null } = {}) {
  const url = new URL(request.url);
  const path = url.pathname.startsWith('/public/') ? url.pathname.slice('/public'.length) : url.pathname;
  if (request.method !== 'GET') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  if (!routes.has(path)) return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  try {
    if (path === '/weekly') {
      const page = url.searchParams.get('page') ?? '0';
      if (!/^\d{1,6}$/.test(page)) return Response.json({ error: 'INVALID_PAGE' }, { status: 400 });
      const report = await getWeeklyReportPage(env.DB, { page: Number(page),
        ...Object.fromEntries(['reportKey', 'scoreVersion', 'profile', 'quoteTier'].filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)])) });
      return Response.json(report ?? { status: 'NOT_GENERATED' }, { status: report ? 200 : 404, headers: { 'cache-control': 'no-store' } });
    }
    if (path === '/latest') {
      const row = await env.DB.prepare('SELECT report_json FROM runs ORDER BY completed_at DESC LIMIT 1').first();
      if (!row) return Response.json({ status: 'NOT_STARTED', currentSignalsAvailable: false }, { status: 404, headers: { 'cache-control': 'no-store' } });
      const report = JSON.parse(row.report_json);
      const published = publicReport(report);
      if (report.mvp?.recording) published.mvp = { ...published.mvp, archive: await getMvpStats(env.DB) };
      if (report.mvp?.phase >= 2) published.mvp.outbox = { ...published.mvp.outbox,
        stats: await getDryRunAlertStats(env.DB), recent: await getRecentDryRunAlerts(env.DB) };
      if (report.mvp?.phase >= 3) {
        published.mvp.wallets = await getWalletLedgerStats(env.DB);
        published.mvp.weeklyReport = await getLatestWeeklyReport(env.DB, { paged: operationsEnabled(env) });
      }
      return Response.json(published, { headers: { 'cache-control': 'no-store' } });
    }
    const control = await env.DB.prepare("SELECT status,last_success,lease_until,last_error,json_extract(state_json,'$.signalAvailability') AS signals_json FROM control WHERE id=1").first();
    const stale = !control?.last_success || Date.now() - control.last_success > 360000;
    const abandoned = control?.status === 'RUNNING' && control.lease_until <= Date.now();
    const status = abandoned ? 'ABANDONED' : control?.status === 'ERROR' ? 'ERROR' : stale ? 'STALE' : control.status;
    const availability = control?.signals_json ? JSON.parse(control.signals_json) : {};
    const healthy = !stale && !['ERROR', 'ABANDONED'].includes(status);
    if (operationsEnabled(env) && typeof getOperations !== 'function') throw Error('INVALID_OPERATIONS_RESPONSE');
    const ops = operationsEnabled(env) ? await getOperations() : null;
    return Response.json({ status, stale, lastError: ops?.lastError?.code ?? control?.last_error ?? null,
      lastSuccessAt: control?.last_success ? new Date(control.last_success).toISOString() : null,
      ...(ops ? { operations: ops, heartbeat: heartbeatPayload(ops, { lastSuccessAt: control?.last_success }) } : {}),
      currentSignalsAvailable: healthy && availability.tradeExpiresAt > Date.now(),
      marketSignalsAvailable: healthy && availability.marketExpiresAt > Date.now() },
    { status: healthy ? 200 : 503, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ status: 'ERROR', currentSignalsAvailable: false,
      lastError: operationError(error, { stage: 'health-or-read' }).code }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
