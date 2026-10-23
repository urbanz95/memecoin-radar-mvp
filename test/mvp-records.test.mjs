import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDecisionRecords, decisionKey, projectDecisionFeatures } from '../src/mvp/records.mjs';
import { setup, decision, TOKEN, time, version, profile, policyHash, mvpSchema } from './helpers/mvp-sqlite.mjs';

const count = (DB, table) => DB.sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;

test('MVP migration is additive and repeatable while preserving every legacy table and row', t => {
  const DB = setup(t, { migrate: false });
  DB.sqlite.prepare('INSERT INTO pools VALUES(?,?,?,?,?)').run('legacy-pool', TOKEN(1), 10, 123, '{"legacy":true}');
  DB.sqlite.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run('legacy-run', 123, 12, '{"report":true}', '{"rpc":[]}');
  DB.sqlite.prepare('UPDATE control SET state_json=?,status=? WHERE id=1').run('{"sequence":73}', 'COMPLETED');
  const before = Object.fromEntries(['control', 'pools', 'runs'].map(table => [table,
    DB.sqlite.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }))]));
  const columns = DB.sqlite.prepare('PRAGMA table_info(runs)').all();
  DB.sqlite.exec(mvpSchema); DB.sqlite.exec(mvpSchema);
  for (const [table, rows] of Object.entries(before)) assert.deepEqual(DB.sqlite.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row })), rows);
  assert.deepEqual(DB.sqlite.prepare('PRAGMA table_info(runs)').all(), columns);
  assert.equal(count(DB, 'mvp_tokens'), 0);
  // Existing retention is still valid only for the old report table.
  DB.sqlite.exec('DELETE FROM runs'); assert.equal(count(DB, 'runs'), 0);
});

test('discoveries without evaluation, rejected tokens and dead tokens are all durably recorded', async t => {
  const DB = setup(t);
  const records = prepareDecisionRecords(DB, { runId: 'seen-1', observedAt: time,
    seenTokens: [1, 2, 3].map(n => ({ address: TOKEN(n), poolId: `pool-${n}`, poolCreatedAt: time - 60000, source: 'canonical-pool-log' })),
    decisions: [decision(TOKEN(2)), decision(TOKEN(3), { status: 'DEAD', features: { status: 'DEAD', priceUsd: null, liquidityUsd: 0 } })] });
  assert.equal(count(DB, 'mvp_tokens'), 0, 'helper only prepares statements');
  await DB.batch(records.commands);
  assert.equal(count(DB, 'mvp_tokens'), 3);
  assert.equal(count(DB, 'mvp_decisions'), 2);
  assert.equal(count(DB, 'mvp_outcome_jobs'), 8);
  const statuses = DB.sqlite.prepare('SELECT first_status FROM mvp_decisions ORDER BY address').all().map(row => row.first_status);
  assert.deepEqual(statuses, ['REJECTED', 'DEAD']);
  const seen = DB.sqlite.prepare('SELECT * FROM mvp_tokens WHERE address=?').get(TOKEN(1));
  assert.equal(seen.first_seen_at, time);
  assert.equal(seen.first_pool_created_at, time - 60000);
  assert.equal(seen.first_seen_pool_id, 'pool-1');
  assert.equal(Object.hasOwn(seen, 'token_created_at'), false, 'pool age never becomes token age');
  assert.equal(JSON.parse(seen.source_json).provenance, 'canonical-pool-log');
  const dead = DB.sqlite.prepare('SELECT baseline_price_usd FROM mvp_decisions WHERE address=?').get(TOKEN(3));
  assert.equal(dead.baseline_price_usd, null, 'missing dead-token price is not manufactured as zero');
});

test('canonical first-decision features are immutable and per-run observations are append-only and idempotent', async t => {
  const DB = setup(t);
  const first = prepareDecisionRecords(DB, { runId: 'first', observedAt: time, decisions: [decision()] });
  await DB.batch(first.commands); await DB.batch(first.commands);
  const before = { ...DB.sqlite.prepare('SELECT * FROM mvp_decisions').get() };
  const later = prepareDecisionRecords(DB, { runId: 'later', observedAt: time + 600000,
    decisions: [decision(TOKEN(1), { status: 'DEAD', features: { market: { priceUsd: 0, liquidityUsd: 0,
      fetchedAt: new Date(time + 600000).toISOString() } } })] });
  await DB.batch(later.commands); await DB.batch(later.commands);
  assert.deepEqual({ ...DB.sqlite.prepare('SELECT * FROM mvp_decisions').get() }, before);
  assert.equal(count(DB, 'mvp_decisions'), 1);
  assert.equal(count(DB, 'mvp_decision_events'), 2);
  assert.equal(count(DB, 'mvp_outcome_jobs'), 4);
  assert.equal(DB.sqlite.prepare("SELECT due_at FROM mvp_outcome_jobs WHERE horizon='15m'").get().due_at, time + 900000);
  assert.throws(() => DB.sqlite.exec("UPDATE mvp_decisions SET features_json='{}'"), /MVP_DECISION_IMMUTABLE/);
  assert.throws(() => DB.sqlite.exec('DELETE FROM mvp_decisions'), /MVP_DECISION_APPEND_ONLY/);
  assert.throws(() => DB.sqlite.exec('DELETE FROM mvp_token_seen_events'), /MVP_SEEN_APPEND_ONLY/);
  assert.throws(() => DB.sqlite.exec('DELETE FROM mvp_decision_events'), /MVP_EVENT_APPEND_ONLY/);
});

test('canonical identity is one normalized token/version/profile with distinct versions and profiles', async t => {
  const DB = setup(t);
  const alpha = '0x' + 'ab'.repeat(20);
  assert.equal(decisionKey(4663, alpha, version, profile), decisionKey(4663, alpha.toUpperCase().replace('0X', '0x'), version, profile));
  assert.notEqual(decisionKey(4663, TOKEN(1), 'a:b', 'c'), decisionKey(4663, TOKEN(1), 'a', 'b:c'));
  await DB.batch(prepareDecisionRecords(DB, { runId: 'profiles', observedAt: time, decisions: [
    decision(alpha), decision(alpha, { profile: 'SCOUT' }), decision(alpha, { scoreVersion: 'mvp-score-v2' }),
  ] }).commands);
  assert.equal(count(DB, 'mvp_tokens'), 1);
  assert.equal(count(DB, 'mvp_decisions'), 3);
  assert.equal(count(DB, 'mvp_outcome_jobs'), 12);
});

test('feature snapshots retain schema, provenance, policy hash and explicit unknowns without lookahead', () => {
  const context = { observedAt: time, chainId: 4663, address: TOKEN(1), scoreVersion: version, profile, policyHash,
    source: { provider: 'readonly-rpc', observedAt: new Date(time - 1000).toISOString() } };
  const projection = JSON.parse(projectDecisionFeatures({ checkedAt: new Date(time).toISOString(), unknown: undefined, risks: [] }, context));
  assert.equal(projection.schemaVersion, 1);
  assert.equal(projection.policyHash, policyHash);
  assert.equal(projection.profile, profile);
  assert.equal(projection.values.unknown, null);
  assert.deepEqual(projection.provenance, context.source);
  assert.throws(() => projectDecisionFeatures({ market: { fetchedAt: new Date(time + 1).toISOString() } }, context), /MVP_FUTURE_FEATURE/);
  assert.throws(() => projectDecisionFeatures({ head: { timestamp: time / 1000 + 1 } }, context), /MVP_FUTURE_FEATURE/);
  assert.throws(() => projectDecisionFeatures({ market: {} }, { ...context, source: { fetchedAt: new Date(time + 1).toISOString() } }), /MVP_FUTURE_FEATURE/);
  assert.throws(() => projectDecisionFeatures({ metric: NaN }, context), /MVP_INVALID_JSON_VALUE/);
  assert.throws(() => projectDecisionFeatures({ raw: 'x'.repeat(70000) }, context), /MVP_FEATURE_LIMIT_EXCEEDED/);
});

test('fence failure rolls back MVP records and outcome registration with the existing transaction', async t => {
  const DB = setup(t);
  const records = prepareDecisionRecords(DB, { runId: 'failed-fence', observedAt: time, decisions: [decision()] });
  await assert.rejects(DB.batch([...records.commands, DB.prepare('INSERT OR REPLACE INTO commit_fence(id,ok) VALUES(1,0)')]), /CHECK constraint failed/);
  for (const table of ['mvp_tokens', 'mvp_decisions', 'mvp_decision_events', 'mvp_outcome_jobs']) assert.equal(count(DB, table), 0);
});

test('record preparation rejects malformed or oversized inputs explicitly instead of silently dropping tokens or features', t => {
  const DB = setup(t);
  assert.throws(() => prepareDecisionRecords(DB, { runId: 'bad', observedAt: time, seenTokens: [TOKEN(1), 'invalid'] }), /MVP_INVALID_TOKEN_IDENTITY/);
  assert.throws(() => prepareDecisionRecords(DB, { runId: 'future', observedAt: time, seenTokens: [{ address: TOKEN(1), poolCreatedAt: time + 1 }] }), /MVP_FUTURE_POOL/);
  assert.throws(() => prepareDecisionRecords(DB, { runId: 'large', observedAt: time, decisions: [decision(TOKEN(1), { features: { huge: 'x'.repeat(70000) } })] }), /MVP_FEATURE_LIMIT_EXCEEDED/);
  assert.throws(() => prepareDecisionRecords(DB, { runId: 'duplicates', observedAt: time, decisions: [decision(), decision()] }), /MVP_DUPLICATE_DECISION_IN_RUN/);
  assert.equal(count(DB, 'mvp_tokens'), 0);
});
