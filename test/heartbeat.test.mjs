import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HEALTH_URL, REPOSITORY, inspectHealth, probeCollector, runHeartbeat } from '../scripts/heartbeat.mjs';

const now = Date.parse('2026-10-25T12:00:00.000Z');
const iso = value => new Date(value).toISOString();
const health = (changes = {}) => ({ status: 'STALE', stale: true, lastSuccessAt: iso(now - 601000), lastError: null, ...changes });
const env = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_TOKEN: 'synthetic-test-only' };

function githubFixture(payload = health(), status = 503) {
  const calls = []; const issues = []; const comments = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (url === HEALTH_URL) return Response.json(payload, { status });
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com');
    assert.equal(options.headers.authorization, 'Bearer synthetic-test-only');
    if (parsed.pathname.endsWith('/issues') && options.method === 'POST') {
      const input = JSON.parse(options.body);
      const issue = { number: issues.length + 1, state: 'open', user: { login: 'github-actions[bot]' }, ...input };
      issues.push(issue); return Response.json(issue, { status: 201 });
    }
    const match = /\/issues\/(\d+)(\/comments)?$/.exec(parsed.pathname);
    if (match) {
      const issue = issues.find(value => value.number === Number(match[1]));
      assert.ok(issue);
      if (match[2] && options.method === 'GET') return Response.json(comments);
      const input = JSON.parse(options.body);
      if (match[2]) { comments.push({ ...input, user: { login: 'github-actions[bot]' } }); return Response.json({ id: comments.length }, { status: 201 }); }
      assert.equal(options.method, 'PATCH'); Object.assign(issue, input); return Response.json(issue);
    }
    assert.match(parsed.pathname, /\/issues$/);
    return Response.json(issues.filter(issue => issue.state === 'open'));
  };
  return { calls, issues, comments, fetchImpl };
}

test('six-minute health staleness is not the ten-minute heartbeat threshold; exact ten minutes still waits', () => {
  for (const age of [360001, 600000]) {
    const value = inspectHealth(health({ lastSuccessAt: iso(now - age) }), { now, httpStatus: 503 });
    assert.equal(value.incident, false);
  }
  assert.equal(inspectHealth(health({ lastSuccessAt: iso(now - 600001) }), { now, httpStatus: 503 }).incident, true);
});

test('health operations preserve a whitelisted D1 quota cause and discard arbitrary provider text', () => {
  const secret = 'FAKE_TOKEN_MUST_NEVER_APPEAR';
  const value = inspectHealth(health({ lastError: secret, operations: {
    lastError: { code: 'D1_DAILY_WRITE_LIMIT', module: 'd1', stage: 'commit', at: iso(now - 600000), raw: secret },
    lastCycleStartedAt: iso(now - 650000), cadenceSeconds: 180,
    budget: { dayUtc: '2026-10-25', limit: 80000, estimatedRowsWritten: 80000, circuitUntil: iso(now + 43200000), token: secret },
    stability: { stableSince: null, requiredHours: 6, qualified: false, completedCycles: 0 }, authorization: secret,
  } }), { now, httpStatus: 503 });
  assert.equal(value.incident, true);
  assert.equal(value.payload.cause.code, 'D1_DAILY_WRITE_LIMIT');
  assert.equal(value.payload.operations.budget.limit, 80000);
  assert.equal(JSON.stringify(value).includes(secret), false);
});

test('unknown endpoint outages persist an external first-failure timestamp and alert only after ten minutes', async () => {
  const fetchImpl = async () => { throw Error('private provider text'); };
  const first = await probeCollector({ fetchImpl, now });
  assert.equal(first.incident, false);
  assert.equal(first.state.firstFailureAt, iso(now));
  const later = await probeCollector({ fetchImpl, now: now + 600001, state: first.state });
  assert.equal(later.incident, true);
  assert.equal(later.payload.cause.code, 'HEALTH_UNAVAILABLE');
  assert.equal(JSON.stringify(later).includes('private provider text'), false);
});

test('cached last success makes a quota outage detectable even when health cannot return D1 data', async () => {
  const value = await probeCollector({ fetchImpl: async () => Response.json({ status: 'ERROR' }, { status: 503 }),
    now, state: { firstFailureAt: iso(now - 700000), lastSuccessAt: iso(now - 800000) } });
  assert.equal(value.incident, true);
  assert.equal(value.payload.lastSuccessAt, iso(now - 800000));
});

test('malformed, unknown and future cached state cannot manufacture an old failure or fake a recovery', () => {
  for (const state of [{ firstFailureAt: 'bad', lastSuccessAt: null }, { firstFailureAt: iso(now - 700000), lastSuccessAt: null, token: 'bad' },
    { firstFailureAt: iso(now + 1), lastSuccessAt: null }, null, []]) {
    const value = inspectHealth(null, { now, httpStatus: 503, state });
    assert.equal(value.incident, false);
    assert.equal(value.recovered, false);
    assert.equal(value.state.firstFailureAt, iso(now));
  }
  const future = inspectHealth(health({ lastSuccessAt: iso(now + 1) }), { now, httpStatus: 200 });
  assert.equal(future.incident, false); assert.equal(future.recovered, false);
});

test('stale collector opens one assigned issue and repeated failures do not flood comments or new issues', async () => {
  const fixture = githubFixture();
  let persisted;
  const first = await runHeartbeat({ ...fixture, env, now, saveState: async value => { persisted = value; } });
  assert.equal(first.action, 'OPENED'); assert.ok(persisted.lastSuccessAt);
  assert.equal(fixture.issues.length, 1);
  assert.deepEqual(fixture.issues[0].assignees, ['urbanz95']);
  assert.match(fixture.issues[0].body, /Europe\/Lisbon/);
  const repeated = await runHeartbeat({ ...fixture, env, now: now + 60000, state: persisted });
  assert.equal(repeated.action, 'UNCHANGED');
  assert.equal(fixture.issues.length, 1); assert.equal(fixture.comments.length, 0);
  assert.equal(fixture.calls.find(call => call.url === HEALTH_URL).headers.authorization, undefined);
});

test('a changed safe cause updates the same issue and a fresh healthy cycle comments and closes it only once', async () => {
  const fixture = githubFixture();
  await runHeartbeat({ ...fixture, env, now });
  const quotaFetch = async (url, options) => url === HEALTH_URL
    ? Response.json(health({ operations: { lastError: { code: 'D1_DAILY_WRITE_LIMIT', module: 'd1', stage: 'batch', at: iso(now) } } }), { status: 503 })
    : fixture.fetchImpl(url, options);
  assert.equal((await runHeartbeat({ fetchImpl: quotaFetch, env, now: now + 60000 })).action, 'UPDATED');
  assert.equal(fixture.issues.length, 1); assert.match(fixture.issues[0].body, /D1_DAILY_WRITE_LIMIT/);
  const recoveredFetch = async (url, options) => url === HEALTH_URL
    ? Response.json(health({ status: 'COMPLETED', stale: false, lastSuccessAt: iso(now + 120000) }))
    : fixture.fetchImpl(url, options);
  assert.equal((await runHeartbeat({ fetchImpl: recoveredFetch, env, now: now + 130000 })).action, 'CLOSED');
  assert.equal(fixture.issues[0].state, 'closed'); assert.equal(fixture.comments.length, 1);
  assert.equal((await runHeartbeat({ fetchImpl: recoveredFetch, env, now: now + 140000 })).action, 'HEALTHY');
  assert.equal(fixture.comments.length, 1);
});

test('an unreachable health endpoint cannot close an open incident just because cached data looks fresh', async () => {
  const fixture = githubFixture(); await runHeartbeat({ ...fixture, env, now });
  const fetchImpl = async (url, options) => {
    if (url === HEALTH_URL) throw Error('unavailable');
    return fixture.fetchImpl(url, options);
  };
  const value = await runHeartbeat({ fetchImpl, env, now, state: { firstFailureAt: null, lastSuccessAt: iso(now - 1000) } });
  assert.equal(value.action, 'WAITING'); assert.equal(fixture.issues[0].state, 'open');
});

test('HTTP 200 with a recent timestamp never closes an incident unless status and non-staleness prove recovery', async () => {
  const fixture = githubFixture(); await runHeartbeat({ ...fixture, env, now });
  for (const fields of [{ status: 'ERROR', stale: false }, { status: 'STALE', stale: false },
    { status: 'UNRECOGNIZED', stale: false }, { status: 'COMPLETED', stale: true },
    { status: 'COMPLETED', stale: undefined }, { status: 'COMPLETED', stale: 'false' }]) {
    const fetchImpl = async (url, options) => url === HEALTH_URL
      ? Response.json(health({ ...fields, lastSuccessAt: iso(now) }))
      : fixture.fetchImpl(url, options);
    const value = await runHeartbeat({ fetchImpl, env, now });
    assert.equal(value.recovered, false);
    assert.equal(value.action, 'WAITING');
    assert.equal(fixture.issues[0].state, 'open');
    assert.equal(fixture.comments.length, 0);
  }
  for (const status of ['COMPLETED', 'RUNNING'])
    assert.equal(inspectHealth(health({ status, stale: false, lastSuccessAt: iso(now) }), { now, httpStatus: 200 }).recovered, true);
});

test('a recovery comment is idempotent if closing the incident fails after the comment was saved', async () => {
  const fixture = githubFixture(); await runHeartbeat({ ...fixture, env, now });
  let closeFailures = 1;
  const fetchImpl = async (url, options = {}) => {
    if (url === HEALTH_URL) return Response.json(health({ status: 'COMPLETED', stale: false, lastSuccessAt: iso(now) }));
    if (options.method === 'PATCH' && JSON.parse(options.body).state === 'closed' && closeFailures-- > 0)
      return Response.json({ message: 'private provider error' }, { status: 503 });
    return fixture.fetchImpl(url, options);
  };
  await assert.rejects(runHeartbeat({ fetchImpl, env, now }), /HEARTBEAT_GITHUB_HTTP_503/);
  assert.equal(fixture.comments.length, 1); assert.equal(fixture.issues[0].state, 'open');
  assert.equal((await runHeartbeat({ fetchImpl, env, now: now + 1000 })).action, 'CLOSED');
  assert.equal(fixture.comments.length, 1);
});

test('unrelated issues are never edited and transient read failures retry before opening an incident', async () => {
  const fixture = githubFixture();
  fixture.issues.push({ number: 99, title: '[Monitor] Collector sem atualização há mais de 10 minutos',
    body: '<!-- memecoin-radar-heartbeat:v1 -->', state: 'open', user: { login: 'another-user' } });
  let failures = 1;
  const fetchImpl = async (url, options = {}) => {
    if (url !== HEALTH_URL && options.method === 'GET' && failures-- > 0) return Response.json({ message: 'transient' }, { status: 503 });
    return fixture.fetchImpl(url, options);
  };
  assert.equal((await runHeartbeat({ fetchImpl, env, now })).action, 'OPENED');
  assert.equal(fixture.issues[0].number, 99); assert.equal(fixture.issues[0].body, '<!-- memecoin-radar-heartbeat:v1 -->');
  assert.equal(fixture.issues.length, 2);
});

test('only this repository is allowed and missing credentials fail before any network request', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; throw Error('unexpected'); };
  for (const badEnv of [{ GITHUB_REPOSITORY: 'other/repo', GITHUB_TOKEN: 'test' }, { GITHUB_REPOSITORY: REPOSITORY }])
    await assert.rejects(runHeartbeat({ env: badEnv, fetchImpl, now }), /HEARTBEAT_(?:REPOSITORY|TOKEN)_INVALID/);
  assert.equal(calls, 0);
});

test('oversized or malformed health responses retain an unknown outage and never expose raw bodies', async () => {
  for (const fetchImpl of [async () => new Response('x'.repeat(65537)), async () => new Response('{private')]) {
    const value = await probeCollector({ fetchImpl, now });
    assert.equal(value.incident, false); assert.equal(value.recovered, false);
    assert.match(value.payload.cause.code, /HEALTH_(?:RESPONSE_LIMIT|INVALID_JSON)/);
  }
});

test('workflow runs only trusted main code and needs no Telegram credential or paid service', async () => {
  const source = await readFile(new URL('../.github/workflows/heartbeat.yml', import.meta.url), 'utf8');
  assert.match(source, /cron: ['"]\*\/5 \* \* \* \*['"]/);
  assert.match(source, /github\.ref == 'refs\/heads\/main'/);
  assert.match(source, /issues: write/); assert.match(source, /contents: read/);
  assert.match(source, /persist-credentials: false/); assert.match(source, /ref: refs\/heads\/main/);
  assert.match(source, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(source, /pull_request|TELEGRAM_|secrets\./);
});
