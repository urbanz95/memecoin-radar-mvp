import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'urbanz95/memecoin-radar-mvp';
export const HEALTH_URL = 'https://memecoin-radar-collector.radar-605437d4ee90.workers.dev/health';
const API = `https://api.github.com/repos/${REPOSITORY}`;
const THRESHOLD_MS = 10 * 60000;
const MARKER = '<!-- memecoin-radar-heartbeat:v1 -->';
const RECOVERY_MARKER = '<!-- memecoin-radar-heartbeat-recovery:v1 -->';
const TITLE = '[Monitor] Collector sem atualização há mais de 10 minutos';
const BOT = 'github-actions[bot]';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : null;
const safePart = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(value) ? value : null;
const whole = value => Number.isSafeInteger(value) && value >= 0;
const fail = code => { throw Error(`HEARTBEAT_${code}`); };
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const valueMs = Date.parse(value);
  return Number.isFinite(valueMs) && new Date(valueMs).toISOString() === value ? valueMs : null;
}
const iso = value => value == null ? null : new Date(value).toISOString();
function clock(now) { if (!whole(now)) fail('CLOCK_INVALID'); return now; }
function cachedState(state, now) {
  if (!object(state) || Object.keys(state).length !== 2 || !Object.hasOwn(state, 'firstFailureAt') || !Object.hasOwn(state, 'lastSuccessAt'))
    return { firstFailureAt: null, lastSuccessAt: null };
  for (const key of ['firstFailureAt', 'lastSuccessAt']) if (state[key] !== null && (timestamp(state[key]) === null || timestamp(state[key]) > now))
    return { firstFailureAt: null, lastSuccessAt: null };
  return { firstFailureAt: state.firstFailureAt, lastSuccessAt: state.lastSuccessAt };
}
function operations(value) {
  const source = object(value) ? value : {};
  const budget = object(source.budget) ? source.budget : {};
  const stability = object(source.stability) ? source.stability : {};
  return {
    lastCycleStartedAt: iso(timestamp(source.lastCycleStartedAt)),
    cadenceSeconds: whole(source.cadenceSeconds) ? source.cadenceSeconds : null,
    budget: {
      dayUtc: typeof budget.dayUtc === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(budget.dayUtc) ? budget.dayUtc : null,
      estimatedRowsWritten: whole(budget.estimatedRowsWritten) ? budget.estimatedRowsWritten : null,
      limit: whole(budget.limit) ? budget.limit : null,
      circuitUntil: iso(timestamp(budget.circuitUntil)),
    },
    stability: {
      stableSince: iso(timestamp(stability.stableSince)),
      requiredHours: whole(stability.requiredHours) ? stability.requiredHours : null,
      qualified: typeof stability.qualified === 'boolean' ? stability.qualified : null,
      completedCycles: whole(stability.completedCycles) ? stability.completedCycles : null,
    },
  };
}

/** Unknown/invalid data is an outage of unknown duration, never a fabricated
 * last-success time. Only the external cache can carry a previously seen time. */
export function inspectHealth(health, { now = Date.now(), httpStatus = null, state, failureCode } = {}) {
  clock(now);
  const prior = cachedState(state, now);
  const validObject = object(health);
  const observedSuccess = validObject ? timestamp(health.lastSuccessAt) : null;
  const futureSuccess = observedSuccess !== null && observedSuccess > now;
  const currentSuccess = futureSuccess ? null : observedSuccess;
  const priorSuccess = timestamp(prior.lastSuccessAt);
  const lastSuccess = currentSuccess === null ? priorSuccess : priorSuccess === null ? currentSuccess : Math.max(currentSuccess, priorSuccess);
  const freshSuccess = currentSuccess !== null && now - currentSuccess <= THRESHOLD_MS;
  const recovered = freshSuccess && httpStatus === 200 && !failureCode && health?.stale === false
    && ['COMPLETED', 'RUNNING'].includes(health?.status);
  const firstFailure = recovered ? null : timestamp(prior.firstFailureAt) ?? now;
  const ageMs = lastSuccess === null ? null : now - lastSuccess;
  const incident = !recovered && (ageMs !== null ? ageMs > THRESHOLD_MS : now - firstFailure > THRESHOLD_MS);
  const opsError = object(health?.operations?.lastError) ? health.operations.lastError : {};
  const error = object(health?.lastError) ? health.lastError : {};
  const cause = {
    code: safeCode(failureCode) ?? (futureSuccess ? 'HEALTH_FUTURE_LAST_SUCCESS' : null)
      ?? safeCode(opsError.code) ?? safeCode(error.code) ?? safeCode(health?.lastError)
      ?? (!validObject ? 'HEALTH_UNAVAILABLE' : 'COLLECTOR_HEARTBEAT_MISSING'),
    module: safePart(opsError.module) ?? safePart(error.module),
    stage: safePart(opsError.stage) ?? safePart(error.stage),
    at: iso(timestamp(opsError.at) ?? timestamp(error.at)),
  };
  return {
    incident, recovered,
    state: { firstFailureAt: iso(firstFailure), lastSuccessAt: iso(lastSuccess) },
    payload: { schemaVersion: 1, observedAt: iso(now), healthUrl: HEALTH_URL,
      healthHttpStatus: Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
      status: safeCode(health?.status), cause, lastSuccessAt: iso(lastSuccess),
      ageSeconds: ageMs === null ? null : Math.floor(ageMs / 1000), firstFailureAt: iso(firstFailure),
      thresholdSeconds: THRESHOLD_MS / 1000, operations: operations(health?.operations) },
  };
}

async function boundedJson(response, limit, errorPrefix) {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > limit) fail(`${errorPrefix}_RESPONSE_LIMIT`);
  if (!response.body) fail(`${errorPrefix}_INVALID_JSON`);
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); fail(`${errorPrefix}_RESPONSE_LIMIT`); }
    chunks.push(value);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(`${errorPrefix}_INVALID_JSON`); }
  return result;
}

export async function probeCollector({ fetchImpl = fetch, now = Date.now(), state } = {}) {
  clock(now);
  let httpStatus = null;
  try {
    const response = await fetchImpl(HEALTH_URL, { method: 'GET', redirect: 'error',
      headers: { accept: 'application/json', 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
    httpStatus = response.status;
    const health = await boundedJson(response, 65536, 'HEALTH');
    return inspectHealth(health, { now, state, httpStatus });
  } catch (error) {
    const code = /^HEARTBEAT_(HEALTH_[A-Z_]+)$/.exec(error?.message ?? '')?.[1] ?? 'HEALTH_UNAVAILABLE';
    return inspectHealth(null, { now, state, httpStatus, failureCode: code });
  }
}

function fingerprint(payload) {
  const value = { code: payload.cause.code, module: payload.cause.module, stage: payload.cause.stage,
    lastSuccessAt: payload.lastSuccessAt, healthHttpStatus: payload.healthHttpStatus, status: payload.status,
    dayUtc: payload.operations.budget.dayUtc, circuitUntil: payload.operations.budget.circuitUntil };
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function lisbon(value) {
  return value === null ? 'desconhecido' : new Intl.DateTimeFormat('pt-PT', {
    timeZone: 'Europe/Lisbon', dateStyle: 'short', timeStyle: 'medium', hour12: false,
  }).format(new Date(value));
}
function issueBody(payload) {
  return [MARKER, `<!-- heartbeat-fingerprint:${fingerprint(payload)} -->`, '',
    '**Collector sem ciclo concluído há mais de 10 minutos.**', '',
    `Último sucesso observado: **${lisbon(payload.lastSuccessAt)}** (Europe/Lisbon).`,
    `Verificação: ${lisbon(payload.observedAt)} (Europe/Lisbon).`,
    `Causa reportada: \`${payload.cause.code}\`. Uma causa desconhecida permanece desconhecida.`, '',
    `[Consultar saúde do collector](${HEALTH_URL})`, '', '```json', JSON.stringify(payload, null, 2), '```', '',
    'Monitor externo em GitHub Actions, nominalmente a cada 5 minutos. O GitHub pode atrasar ou suspender agendamentos; não há SLA.',
    'A duração vem do último sucesso observado ou, quando desconhecido, da primeira falha guardada no cache externo.',
    'Perder esse cache reinicia a contagem de uma falha sem data conhecida e pode atrasar a notificação.',
    'Pré-visualização de sinais e Telegram continuam em dry-run. Este monitor não executa trades.',
  ].join('\n');
}
async function githubRequest(fetchImpl, token, path, { method = 'GET', body } = {}) {
  // Retry safe reads only. A timed-out POST may already have created an issue;
  // the next workflow discovers it rather than replaying an ambiguous write.
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, { method, redirect: 'error',
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28', 'user-agent': 'memecoin-radar-heartbeat', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    } catch {
      if (method !== 'GET' || attempt === 2) fail('GITHUB_UNAVAILABLE');
    }
    const retryable = !response || response.status === 429 || response.status >= 500;
    if (method === 'GET' && retryable && attempt < 2) {
      await response?.body?.cancel();
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250 * 2 ** attempt)); continue;
    }
    if (!response.ok) fail(`GITHUB_HTTP_${Number.isSafeInteger(response.status) ? response.status : 'INVALID'}`);
    return boundedJson(response, 524288, 'GITHUB');
  }
}
async function findMonitorIssue(fetchImpl, token) {
  for (let page = 1; page <= 10; page++) {
    const values = await githubRequest(fetchImpl, token,
      `/issues?state=open&creator=github-actions%5Bbot%5D&sort=created&direction=asc&per_page=100&page=${page}`);
    if (!Array.isArray(values)) fail('GITHUB_INVALID_ISSUES');
    const issue = values.find(value => object(value) && !value.pull_request && value.user?.login === BOT
      && value.title === TITLE && typeof value.body === 'string' && value.body.includes(MARKER)
      && Number.isSafeInteger(value.number) && value.number > 0);
    if (issue) return issue;
    if (values.length < 100) return null;
  }
  fail('ISSUE_SCAN_LIMIT');
}

/** No network runs on import. The only writable external resource is this
 * repository's issue, using the built-in workflow token. Cache has no secrets. */
export async function runHeartbeat({ fetchImpl = fetch, env = process.env, now = Date.now(), state, saveState = async () => {} } = {}) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY) fail('REPOSITORY_INVALID');
  const token = env.GITHUB_TOKEN;
  if (typeof token !== 'string' || !token.trim() || token.length > 4096) fail('TOKEN_INVALID');
  const observation = await probeCollector({ fetchImpl, now, state });
  // Persist observation before GitHub writes: a transient API error must not
  // erase the external clock of a health outage.
  await saveState(observation.state);
  const issue = await findMonitorIssue(fetchImpl, token);
  let action;
  if (observation.incident) {
    const body = issueBody(observation.payload);
    if (!issue) {
      await githubRequest(fetchImpl, token, '/issues', { method: 'POST', body: { title: TITLE, body, assignees: ['urbanz95'] } });
      action = 'OPENED';
    } else if (!issue.body.includes(`<!-- heartbeat-fingerprint:${fingerprint(observation.payload)} -->`)) {
      await githubRequest(fetchImpl, token, `/issues/${issue.number}`, { method: 'PATCH', body: { body } }); action = 'UPDATED';
    } else action = 'UNCHANGED';
  } else if (observation.recovered && issue) {
    const comments = await githubRequest(fetchImpl, token, `/issues/${issue.number}/comments?per_page=100`);
    if (!Array.isArray(comments)) fail('GITHUB_INVALID_COMMENTS');
    if (!comments.some(comment => comment?.user?.login === BOT && typeof comment.body === 'string' && comment.body.includes(RECOVERY_MARKER)))
      await githubRequest(fetchImpl, token, `/issues/${issue.number}/comments`, { method: 'POST', body: {
        body: `${RECOVERY_MARKER}\nCollector recuperado: ciclo concluído em **${lisbon(observation.payload.lastSuccessAt)}** (Europe/Lisbon).\n\n[Saúde](${HEALTH_URL}). Dry-run mantido.`,
      } });
    await githubRequest(fetchImpl, token, `/issues/${issue.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
    action = 'CLOSED';
  } else action = observation.recovered ? 'HEALTHY' : 'WAITING';
  return { ...observation, action };
}

async function main() {
  const file = resolve('.heartbeat/monitor-state.json');
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); } catch { state = undefined; }
  const result = await runHeartbeat({ state, saveState: async value => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(value) + '\n', { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  } });
  console.log(JSON.stringify({ event: 'collector_heartbeat', action: result.action, incident: result.incident, ...result.payload }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    const code = /^HEARTBEAT_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'HEARTBEAT_FAILED';
    console.error(JSON.stringify({ event: 'collector_heartbeat_failed', code })); process.exitCode = 1;
  });
}
