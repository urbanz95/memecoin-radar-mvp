import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDecisionRecords, prepareDecisionCanonicality, queryDecisionCanonicalBlocks,
  readDecisionCanonicality, canonicalDecisionSql } from '../src/mvp/records.mjs';
import { queryDueOutcomes, prepareOutcomeUpdates, outcomeEligibility } from '../src/mvp/outcomes.mjs';
import { setup, decision, TOKEN, time, version, profile, mvpSchema, canonicalitySchema } from './helpers/mvp-sqlite.mjs';

const HASH = char => '0x' + char.repeat(64);
const head = (number, char, at = time) => ({ number, hash: HASH(char), timestamp: Math.floor(at / 1000) });
const source = (number, char) => ({ collector: 'canonical-readonly-test', blockNumber: number, blockHash: HASH(char) });
async function seed(DB, { address = TOKEN(1), number = 100, char = 'a', runId = 'first', at = time } = {}) {
  await DB.batch(prepareDecisionRecords(DB, { runId, observedAt: at,
    source: source(number, char), decisions: [decision(address)] }).commands);
}
const validCount = DB => DB.sqlite.prepare(`SELECT count(*) n FROM mvp_decisions d WHERE ${canonicalDecisionSql('d')}`).get().n;

test('incremental migration preserves old decisions and backfills only their immutable first block references', async t => {
  const DB = setup(t, { migrate: false }); DB.sqlite.exec(mvpSchema);
  await seed(DB);
  await DB.batch(prepareDecisionRecords(DB, { runId: 'unknown-old', observedAt: time, source: 'unknown',
    decisions: [decision(TOKEN(2), { features: { externalMarket: { priceUsd: 2, liquidityUsd: 100 } } })] }).commands);
  const before = DB.sqlite.prepare('SELECT * FROM mvp_decisions ORDER BY decision_key').all();
  DB.sqlite.exec(canonicalitySchema); DB.sqlite.exec(canonicalitySchema);
  assert.deepEqual(DB.sqlite.prepare('SELECT * FROM mvp_decisions ORDER BY decision_key').all(), before);
  assert.equal(DB.sqlite.prepare('SELECT count(*) n FROM mvp_decision_chain_refs').get().n, 1);
  assert.equal(validCount(DB), 1);
  assert.equal((await readDecisionCanonicality(DB)).generation, 0, 'an ordinary deployment does not invent a reorg');
  assert.equal((await readDecisionCanonicality(DB)).revalidationComplete, true);
});

test('orphaned immutable baseline and completed outcomes are excluded from the launch gate without deletion', async t => {
  const DB = setup(t); await seed(DB);
  for (const job of await queryDueOutcomes(DB, { now: time + 604800000, limit: 100 })) {
    await DB.batch(prepareOutcomeUpdates(DB, [{ job, observation: { sourceTimestamp: job.dueAt,
      priceUsd: 20, liquidityUsd: 100, source: { provider: 'canonical-test' } } }],
    { runId: 'point-' + job.horizon, now: time + 604800100 }).commands);
  }
  assert.equal((await outcomeEligibility(DB, { scoreVersion: version, profile, now: time + 604800100 })).uniqueLaunchesWithCompleteOutcomes, 1);
  const reorg = prepareDecisionCanonicality(DB, { runId: 'reorg', observedAt: time + 604800200,
    reorgDetected: true, priorHead: head(100, 'a'), canonicalPriorHead: head(100, 'b') });
  await DB.batch(reorg.commands); await DB.batch(reorg.commands);
  await seed(DB, { char: 'b', runId: 'replacement', at: time + 604800300 });
  assert.equal((await outcomeEligibility(DB, { scoreVersion: version, profile, now: time + 604800400 })).uniqueLaunchesWithCompleteOutcomes, 0);
  assert.equal(validCount(DB), 0);
  assert.equal(DB.sqlite.prepare('SELECT baseline_price_usd FROM mvp_decisions').get().baseline_price_usd, 2);
  assert.equal(DB.sqlite.prepare('SELECT count(*) n FROM mvp_outcomes').get().n, 4, 'orphaned historical evidence remains archived');
  assert.equal(DB.sqlite.prepare('SELECT count(*) n FROM mvp_decision_events').get().n, 2);
  assert.equal((await readDecisionCanonicality(DB)).generation, 1, 'replaying one reorg is idempotent');
  assert.throws(() => DB.sqlite.exec('DELETE FROM mvp_decision_invalidations'), /APPEND_ONLY/);
});

test('a stale outcome job prepared before a reorg cannot publish a completed label after the epoch changes', async t => {
  const DB = setup(t); await seed(DB);
  const [job] = await queryDueOutcomes(DB, { now: time + 900000 });
  const outcome = prepareOutcomeUpdates(DB, [{ job, observation: { sourceTimestamp: job.dueAt,
    priceUsd: 20, liquidityUsd: 100, source: 'canonical-test' } }], { runId: 'stale-job', now: time + 900000 });
  const canonicality = prepareDecisionCanonicality(DB, { runId: 'reorg', observedAt: time + 900000,
    reorgDetected: true, priorHead: head(100, 'a'), canonicalPriorHead: head(100, 'b') });
  await DB.batch([...canonicality.commands, ...outcome.commands]);
  assert.equal(DB.sqlite.prepare('SELECT count(*) n FROM mvp_outcomes').get().n, 0);
  assert.equal(DB.sqlite.prepare('SELECT state FROM mvp_outcome_jobs WHERE horizon=\'15m\'').get().state, 'RETRY');
  assert.deepEqual(await queryDueOutcomes(DB, { now: time + 604800000 }), []);
});

test('a known conflicting canonical block overrides even a newly inserted current-generation baseline', async t => {
  const DB = setup(t);
  await DB.batch(prepareDecisionCanonicality(DB, { runId: 'canonical-head', observedAt: time,
    canonicalBlocks: [head(100, 'a')] }).commands);
  await seed(DB, { char: 'b' });
  assert.equal(validCount(DB), 0);
  assert.deepEqual(await queryDueOutcomes(DB, { now: time + 604800000 }), []);
});

test('unknown fork ancestor quarantines older decisions until exact canonical block revalidation', async t => {
  const DB = setup(t); await seed(DB, { number: 90 });
  await seed(DB, { address: TOKEN(2), number: 80, char: 'c', runId: 'older' });
  await DB.batch(prepareDecisionCanonicality(DB, { runId: 'reorg', observedAt: time + 60000,
    reorgDetected: true, priorHead: head(100, 'd'), canonicalPriorHead: head(100, 'b') }).commands);
  assert.equal(validCount(DB), 0, 'do not assume the unknown ancestor is at the last saved head');
  assert.equal((await readDecisionCanonicality(DB)).revalidationComplete, false);
  await DB.batch(prepareDecisionCanonicality(DB, { runId: 'premature', observedAt: time + 70000,
    revalidationComplete: true, expectedGeneration: 1 }).commands);
  assert.equal((await readDecisionCanonicality(DB)).revalidationComplete, false, 'an unresolved header prevents premature completion');
  const pending = await queryDecisionCanonicalBlocks(DB, { limit: 2 });
  assert.equal(pending.length, 2);
  assert.deepEqual(new Set(pending.map(block => block.blockNumber)), new Set([90, 80]));
  await DB.batch(prepareDecisionCanonicality(DB, { runId: 'proof', observedAt: time + 120000,
    canonicalBlocks: [head(90, 'a'), head(80, 'e')] }).commands);
  assert.equal(validCount(DB), 1);
  assert.equal(DB.sqlite.prepare(`SELECT count(*) n FROM mvp_decisions d WHERE ${canonicalDecisionSql('d', { checkedBefore: time + 60000 })}`).get().n,
    0, 'a paged report can freeze the canonicality proof snapshot independently of the immutable financial features');
  const jobs = await queryDueOutcomes(DB, { now: time + 900000 });
  assert.equal(jobs.length, 1); assert.equal(jobs[0].address, TOKEN(1));
  assert.deepEqual(await queryDecisionCanonicalBlocks(DB, { limit: 2 }), []);
  await DB.batch(prepareDecisionCanonicality(DB, { runId: 'wrong-generation', observedAt: time + 130000,
    revalidationComplete: true, expectedGeneration: 0 }).commands);
  assert.equal((await readDecisionCanonicality(DB)).revalidationComplete, false);
  await DB.batch(prepareDecisionCanonicality(DB, { runId: 'complete', observedAt: time + 140000,
    revalidationComplete: true, expectedGeneration: 1 }).commands);
  assert.equal((await readDecisionCanonicality(DB)).revalidationComplete, true);
  assert.deepEqual(await queryDecisionCanonicalBlocks(DB, { limit: 2 }), []);
});

test('no block proof means no outcomes or labels, and malformed or future header proofs fail closed', async t => {
  const DB = setup(t);
  const raw = decision(); delete raw.features.chainState;
  await DB.batch(prepareDecisionRecords(DB, { runId: 'unbound', observedAt: time, source: 'no-block', decisions: [raw] }).commands);
  assert.equal(validCount(DB), 0);
  assert.deepEqual(await queryDueOutcomes(DB, { now: time + 604800000 }), []);
  assert.throws(() => prepareDecisionCanonicality(DB, { runId: 'bad', observedAt: time, canonicalBlocks: [head(100, 'z')] }), /MVP_INVALID_CANONICAL_BLOCK/);
  assert.throws(() => prepareDecisionCanonicality(DB, { runId: 'future', observedAt: time, canonicalBlocks: [head(100, 'a', time + 1000)] }), /MVP_FUTURE_CANONICAL_BLOCK/);
  await assert.rejects(queryDecisionCanonicalBlocks(DB, { limit: 3 }), /MVP_INVALID_CANONICAL_BLOCK_LIMIT/);
});
