import { collectFree } from './collector.mjs';
import { runWeeklyReportJob } from '../mvp/weekly-report.mjs';
import { OPERATIONS_CONFIG, runManagedCollection, readOperations, heartbeatPayload, operationError } from './operations.mjs';
import { operationsEnabled as managed, readPublicApi } from './read-api.mjs';

function actor(env, suffix = '') {
  const instance = Object.hasOwn(env, 'COLLECTOR_INSTANCE') ? env.COLLECTOR_INSTANCE : 'main';
  if (typeof instance !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(instance) || instance.length + suffix.length > 64)
    throw new Error('INVALID_COLLECTOR_INSTANCE');
  return env.COLLECTOR.get(env.COLLECTOR.idFromName(instance + suffix));
}

export class Collector {
  constructor(ctx, env) { this.env = env; this.storage = ctx.storage; }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/operations' && managed(this.env))
      return Response.json(await readOperations(this.storage));
    if (request.method === 'GET' && ['/public/health', '/public/latest', '/public/weekly'].includes(path) && managed(this.env))
      return readPublicApi(request, this.env, { getOperations: () => readOperations(this.storage) });
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
      if (managed(env)) return await actor(env).fetch(`https://collector.internal/public${url.pathname}${url.search}`, { method: 'GET' });
      return readPublicApi(request, env);
    } catch (error) { return Response.json({ status: 'ERROR', currentSignalsAvailable: false,
      lastError: operationError(error, { stage: 'health-or-read' }).code }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
  }
};
