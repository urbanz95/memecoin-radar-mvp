import { collectFree } from './collector.mjs';
import { publicReport } from './public-report.mjs';
import { getMvpStats } from '../mvp/records.mjs';
import { getDryRunAlertStats, getRecentDryRunAlerts } from '../mvp/alerts.mjs';
import { getWalletLedgerStats } from '../mvp/wallet-ledger.mjs';
import { getLatestWeeklyReport } from '../mvp/weekly-report.mjs';

export class Collector {
  constructor(_ctx, env) { this.env = env; }
  async fetch(request) {
    if (request.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
    if (new URL(request.url).pathname !== '/collect') return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    return Response.json(await collectFree(this.env));
  }
}

export default {
  async scheduled(_event, env) {
    const collector = env.COLLECTOR.get(env.COLLECTOR.idFromName('main'));
    const response = await collector.fetch('https://collector.internal/collect', { method: 'POST' });
    console.log(JSON.stringify(await response.json()));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
    if (!['/', '/index.html', '/dashboard.js', '/health', '/latest'].includes(url.pathname)) return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
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
          published.mvp.weeklyReport = await getLatestWeeklyReport(env.DB);
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
      return Response.json({ status, stale, lastError: control?.last_error ?? null, lastSuccessAt: control?.last_success ? new Date(control.last_success).toISOString() : null,
        currentSignalsAvailable: healthy && availability.tradeExpiresAt > Date.now(),
        marketSignalsAvailable: healthy && availability.marketExpiresAt > Date.now() },
      { status: healthy ? 200 : 503, headers: { 'cache-control': 'no-store' } });
    } catch { return Response.json({ status: 'ERROR' }, { status: 503 }); }
  }
};
