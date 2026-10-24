import { collectFree } from './collector.mjs';
import { publicReport } from './public-report.mjs';
import { getMvpStats } from '../mvp/records.mjs';
import { getDryRunAlertStats, getRecentDryRunAlerts } from '../mvp/alerts.mjs';
import { getWalletLedgerStats } from '../mvp/wallet-ledger.mjs';
import { getLatestWeeklyReport, getWeeklyReportPage, runWeeklyReportJob } from '../mvp/weekly-report.mjs';
import { OPERATIONS_CONFIG, runManagedCollection, readOperations, heartbeatPayload, operationError } from './operations.mjs';

const managed = env => Object.hasOwn(env, 'OPERATIONS_ENABLED') && env.OPERATIONS_ENABLED === '1';
function actor(env, suffix = '') {
  const instance = Object.hasOwn(env, 'COLLECTOR_INSTANCE') ? env.COLLECTOR_INSTANCE : 'main';
  if (typeof instance !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(instance) || instance.length + suffix.length > 64)
    throw new Error('INVALID_COLLECTOR_INSTANCE');
  return env.COLLECTOR.get(env.COLLECTOR.idFromName(instance + suffix));
}
async function operations(env) {
  const response = await actor(env).fetch('https://collector.internal/operations');
  if (!response.ok) throw Error('INVALID_OPERATIONS_RESPONSE');
  return response.json();
}

export class Collector {
  constructor(ctx, env) { this.env = env; this.storage = ctx.storage; }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/operations' && managed(this.env))
      return Response.json(await readOperations(this.storage));
    if (request.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
    if (path === '/weekly' && managed(this.env)) return Response.json(await runWeeklyReportJob(this.env.DB));
    if (path === '/heartbeat' && managed(this.env)) {
      const state = await readOperations(this.storage);
      const payload = heartbeatPayload(state);
      console[payload.alert ? 'warn' : 'log'](JSON.stringify(payload));
      return Response.json(payload);
    }
    if (path !== '/collect') return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    if (!managed(this.env)) return Response.json(await collectFree(this.env));
    return Response.json(await runManagedCollection({ storage: this.storage, collect: () => collectFree(this.env) }));
  }
}

export default {
  async scheduled(event, env) {
    // All cursors, evidence and the lease live in D1. Rotating this routing
    // identity replaces the in-memory actor while preserving that durable state.
    const path = managed(env) && event?.cron === OPERATIONS_CONFIG.weekly.cron ? 'weekly'
      : managed(env) && event?.cron === OPERATIONS_CONFIG.heartbeat.cron ? 'heartbeat' : 'collect';
    const collector = actor(env, path === 'weekly' ? '-weekly' : '');
    try {
      const response = await collector.fetch(`https://collector.internal/${path}`, { method: 'POST' });
      const result = await response.json();
      console.log(JSON.stringify(managed(env) ? { ...result, job: path } : result));
    } catch (error) {
      console.error(JSON.stringify({ event: 'SCHEDULED_JOB_FAILED', job: path, ...operationError(error, { stage: path }) }));
      throw Error(operationError(error, { stage: path }).code);
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
    if (!['/', '/index.html', '/dashboard.js', '/health', '/latest', '/weekly'].includes(url.pathname)) return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    try {
      if (['/', '/index.html', '/dashboard.js'].includes(url.pathname)) {
        const asset = await env.ASSETS.fetch(request);
        const headers = new Headers(asset.headers);
        headers.set('cache-control', 'no-store');
        headers.set('x-content-type-options', 'nosniff');
        headers.set('referrer-policy', 'no-referrer');
        headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
        return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
      }
      if (url.pathname === '/weekly') {
        const page = url.searchParams.get('page') ?? '0';
        if (!/^\d{1,6}$/.test(page)) return Response.json({ error: 'INVALID_PAGE' }, { status: 400 });
        const report = await getWeeklyReportPage(env.DB, { page: Number(page),
          ...Object.fromEntries(['reportKey', 'scoreVersion', 'profile', 'quoteTier'].filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)])) });
        return Response.json(report ?? { status: 'NOT_GENERATED' }, { status: report ? 200 : 404, headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/latest') {
        const row = await env.DB.prepare('SELECT report_json FROM runs ORDER BY completed_at DESC LIMIT 1').first();
        if (!row) return Response.json({ status: 'NOT_STARTED', currentSignalsAvailable: false }, { status: 404, headers: { 'cache-control': 'no-store' } });
        const report = JSON.parse(row.report_json);
        const published = publicReport(report);
        if (report.mvp?.recording) published.mvp = { ...published.mvp, archive: await getMvpStats(env.DB) };
        if (report.mvp?.phase >= 2) published.mvp.outbox = { ...published.mvp.outbox,
          stats: await getDryRunAlertStats(env.DB), recent: await getRecentDryRunAlerts(env.DB) };
        if (report.mvp?.phase >= 3) {
          published.mvp.wallets = await getWalletLedgerStats(env.DB);
          published.mvp.weeklyReport = await getLatestWeeklyReport(env.DB, { paged: managed(env) });
        }
        return Response.json(published,
        { headers: { 'cache-control': 'no-store' } });
      }
      const control = await env.DB.prepare("SELECT status,last_success,lease_until,last_error,json_extract(state_json,'$.signalAvailability') AS signals_json FROM control WHERE id=1").first();
      const stale = !control?.last_success || Date.now() - control.last_success > 360000;
      const abandoned = control?.status === 'RUNNING' && control.lease_until <= Date.now();
      const status = abandoned ? 'ABANDONED' : control?.status === 'ERROR' ? 'ERROR' : stale ? 'STALE' : control.status;
      const availability = control?.signals_json ? JSON.parse(control.signals_json) : {};
      const healthy = !stale && !['ERROR', 'ABANDONED'].includes(status);
      const ops = managed(env) ? await operations(env) : null;
      return Response.json({ status, stale, lastError: ops?.lastError?.code ?? control?.last_error ?? null, lastSuccessAt: control?.last_success ? new Date(control.last_success).toISOString() : null,
        ...(ops ? { operations: ops, heartbeat: heartbeatPayload(ops, { lastSuccessAt: control?.last_success }) } : {}),
        currentSignalsAvailable: healthy && availability.tradeExpiresAt > Date.now(),
        marketSignalsAvailable: healthy && availability.marketExpiresAt > Date.now() },
      { status: healthy ? 200 : 503, headers: { 'cache-control': 'no-store' } });
    } catch (error) { return Response.json({ status: 'ERROR', currentSignalsAvailable: false,
      lastError: operationError(error, { stage: 'health-or-read' }).code }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
  }
};
