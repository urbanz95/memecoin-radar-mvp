import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMarketSignals, mergeIncrementalEvaluationState } from '../src/cloudflare/market-signals.mjs';
import { QUOTE_ASSETS } from '../src/network.mjs';
import config from '../config/market-signals.json' with { type: 'json' };

const NOW = Date.parse('2026-10-23T12:00:00Z');
const token = '0x1111111111111111111111111111111111111111';
const pair = '0x2222222222222222222222222222222222222222';
function entry(pipeline = 'new', now = NOW) {
  const established = pipeline === 'established';
  return { address: token, status: 'REVIEW', pipeline, poolType: 'v2', observedAt: new Date(now).toISOString(), risks: [],
    age: established ? { lowerBoundMinutes: 20000 } : { lowerBoundMinutes: 60, upperBoundMinutes: 120 },
    externalMarket: { source: 'synthetic-market-fixture', trust: 'provider-reported', chain: 'robinhood', chainId: 4663,
      baseTokenAddress: token, quoteTokenAddress: QUOTE_ASSETS.WETH, pairAddress: pair,
      fetchedAt: new Date(now).toISOString(), liquidityUsd: established ? 750000 : 250000,
      fdvUsd: established ? 10000000 : 1000000,
      volumeUsd: established ? { m5: 25000, h1: 200000, h24: 500000 } : { m5: 25000, h1: 100000, h24: 500000 },
      priceChangePct: { m5: 10, h1: 15, h24: 20 },
      txns: { m5: { buys: 100, sells: 20 }, h1: { buys: 300, sells: 100 } } } };
}
const evaluate = (value, state = {}, now = NOW, options = {}) => evaluateMarketSignals([value], state, { now, ...options });
const first = report => report.entries[0].signal;
const series = (pipeline, times, mutate = value => value) => {
  let report; let state = {};
  for (const seconds of times) {
    const now = NOW + seconds * 1000;
    report = evaluate(mutate(entry(pipeline, now), seconds), state, now); state = report.state;
  }
  return report;
};

test('market alert requires original confirmation time and source observations, never approves trades', () => {
  const initial = evaluate(entry());
  assert.equal(first(initial).status, 'CONFIRMING');
  assert.equal(first(initial).score, 100);
  assert.equal(first(initial).tradeApproved, false);
  assert.equal(initial.summary.marketAlerts, 0);
  const confirmed = series('new', [0, 60, 120]);
  assert.equal(first(confirmed).status, 'MARKET_ALERT');
  assert.equal(first(confirmed).kind, 'MARKET_ALERT');
  assert.equal(first(confirmed).label, 'Alerta de mercado · segurança pendente');
  assert.equal(first(confirmed).tradeApproved, false);
  assert.equal(confirmed.summary.marketAlerts, 1);
  assert.equal(confirmed.summary.tradeApproved, false);
  assert.equal(confirmed.summary.pipelines.new.counts.MARKET_ALERT, 1);
  assert.equal(first(confirmed).expiresAt, new Date(NOW + 240000).toISOString());
});

test('established alerts require fifteen minutes, even with more than two observations', () => {
  assert.equal(first(series('established', [0, 300, 600])).status, 'CONFIRMING');
  const confirmed = series('established', [0, 300, 600, 900]);
  assert.equal(first(confirmed).status, 'MARKET_ALERT');
  assert.equal(first(confirmed).confirmation.spanSeconds, 900);
  assert.equal(first(series('established', [0, 900])).status, 'CONFIRMING', 'a fifteen-minute observation gap resets continuity');
});

test('native analysis timestamps do not count as new market observations', () => {
  const report = series('new', [0, 60, 120], value => {
    value.externalMarket.fetchedAt = new Date(NOW).toISOString(); return value;
  });
  assert.equal(first(report).status, 'CONFIRMING');
  assert.equal(first(report).confirmation.observations, 1);
  assert.equal(first(report).confirmation.spanSeconds, 0);
});

test('known risk blocks before market score, including another entry for the same address', () => {
  const unsafe = entry(); unsafe.risks = [{ code: 'KNOWN_HONEYPOT', reason: 'Synthetic positive risk' }];
  const report = evaluateMarketSignals([unsafe, entry()], {}, { now: NOW });
  assert.deepEqual(report.entries.map(value => value.signal.status), ['BLOCKED', 'BLOCKED']);
  assert.ok(report.entries.every(value => value.signal.score === null && value.signal.tradeApproved === false));
  assert.equal(report.summary.counts.BLOCKED, 2);
  const blocked = entry(); blocked.status = 'BLOCKED';
  assert.equal(first(evaluate(blocked)).status, 'BLOCKED');
});

test('stale or future source data never regains freshness from a newer native observation', () => {
  for (const offset of [-121000, 31000]) {
    const value = entry(); value.externalMarket.fetchedAt = new Date(NOW + offset).toISOString();
    assert.equal(first(evaluate(value)).status, 'STALE');
  }
  const value = entry(); value.observedAt = new Date(NOW - 601000).toISOString();
  assert.equal(first(evaluate(value)).status, 'STALE');
});

test('public signal expiry is the earlier of market and native-observation deadlines', () => {
  const value = entry(); value.observedAt = new Date(NOW - 590000).toISOString();
  const signal = first(evaluate(value));
  assert.equal(signal.status, 'CONFIRMING');
  assert.equal(signal.expiresAt, new Date(NOW + 10000).toISOString());
  assert.equal(first(evaluate(value, {}, NOW + 10001)).status, 'STALE');
  const confirmed = series('new', [0, 60, 120], (candidate, seconds) => {
    candidate.observedAt = new Date(NOW + seconds * 1000 - 590000).toISOString(); return candidate;
  });
  assert.equal(first(confirmed).status, 'MARKET_ALERT');
  assert.equal(first(confirmed).expiresAt, new Date(NOW + 130000).toISOString());
});

test('strict source identity rejects other networks, tokens, quote currencies and malformed pairs', () => {
  const mutations = [
    market => { market.chainId = 46630; }, market => { market.chain = 'ethereum'; },
    market => { market.baseTokenAddress = pair; }, market => { market.quoteTokenAddress = pair; },
    market => { market.pairAddress = '0x123'; }, market => { market.source = ''; },
    market => { market.pairAddress = '0x' + 'ab'.repeat(32); },
  ];
  for (const mutate of mutations) {
    const value = entry(); mutate(value.externalMarket);
    const result = first(evaluate(value));
    assert.equal(result.status, 'WAITING_DATA');
    assert.ok(result.missing.includes('marketIdentity'));
    assert.equal(result.tradeApproved, false);
  }
});

test('native ETH is accepted only as explicitly identified v4 currency, distinct from WETH', () => {
  const value = entry();
  Object.assign(value.externalMarket, { quoteAsset: 'ETH', quoteTokenAddress: '0x' + '0'.repeat(40),
    poolType: 'v4', pairAddress: '0x' + 'ab'.repeat(32) });
  value.poolType = 'v4';
  assert.equal(first(evaluate(value)).status, 'CONFIRMING');
  value.poolType = 'v2';
  assert.equal(first(evaluate(value)).status, 'WAITING_DATA');
  value.poolType = 'v4'; value.externalMarket.quoteAsset = 'WETH';
  assert.equal(first(evaluate(value)).status, 'WAITING_DATA');
  value.externalMarket.quoteAsset = 'ETH'; value.externalMarket.quoteTokenAddress = QUOTE_ASSETS.WETH;
  assert.equal(first(evaluate(value)).status, 'WAITING_DATA', 'ETH is not silently mapped to WETH');
});

test('unproven age and out-of-scope ages never enter a confirmation series', () => {
  const unknown = entry(); delete unknown.age;
  assert.equal(first(evaluate(unknown)).status, 'WAITING_DATA');
  const outside = entry(); outside.age = { lowerBoundMinutes: 4000, upperBoundMinutes: 5000 };
  assert.equal(first(evaluate(outside)).status, 'OUT_OF_SCOPE');
  const unclassified = entry(); unclassified.pipeline = 'unclassified';
  assert.equal(first(evaluate(unclassified)).status, 'OUT_OF_SCOPE');
});

test('missing market fields remain absent and prevent alerts instead of becoming fabricated metrics', () => {
  const value = entry();
  delete value.externalMarket.liquidityUsd;
  delete value.externalMarket.txns;
  const result = first(evaluate(value));
  assert.equal(result.status, 'WAITING_DATA');
  assert.ok(result.missing.includes('liquidityUsd'));
  assert.ok(result.missing.includes('txns.m5.buys'));
  assert.equal(result.score, null);
  assert.equal(result.checks.find(check => check.id === 'transactions').value, null);
  assert.equal(Object.hasOwn(value.externalMarket, 'liquidityUsd'), false);
  assert.ok(result.checks.every(check => !String(check.id).includes('uniqueTraders')));
});

test('known market criteria failures give NO_SETUP and reset confirmation', () => {
  const initial = evaluate(entry());
  const value = entry('new', NOW + 60000); value.externalMarket.liquidityUsd = 100;
  const failed = evaluate(value, initial.state, NOW + 60000);
  assert.equal(first(failed).status, 'NO_SETUP');
  assert.deepEqual(failed.state, {});
  assert.equal(first(evaluate(entry('new', NOW + 120000), failed.state, NOW + 120000)).confirmation.observations, 1);
  const sellDominated = entry(); sellDominated.externalMarket.txns.m5 = { buys: 5, sells: 95 };
  assert.equal(first(evaluate(sellDominated)).status, 'NO_SETUP');
});

test('a low market score does not become an alert even if individual floors pass', () => {
  const value = entry();
  Object.assign(value.externalMarket, { liquidityUsd: 50000, priceChangePct: { m5: 1 }, volumeUsd: { m5: 5000, h1: 20000 } });
  const signal = first(evaluate(value));
  assert.equal(signal.status, 'NO_SETUP');
  assert.ok(signal.score < 75);
  assert.equal(signal.checks.find(check => check.id === 'score').passed, false);
});

test('zero or inconsistent acceleration baseline is disclosed rather than inferred', () => {
  for (const total of [25000, 0]) {
    const value = entry(); value.externalMarket.volumeUsd.h1 = total;
    const signal = first(evaluate(value));
    assert.equal(signal.status, 'WAITING_DATA');
    assert.ok(signal.missing.includes('accelerationBaseline'));
  }
});

test('confirmation resets for a changed pair, regressing source time, missing data, expired gap or policy change', () => {
  const second = series('new', [0, 60]);
  const changed = entry('new', NOW + 120000); changed.externalMarket.pairAddress = '0x3333333333333333333333333333333333333333';
  assert.equal(first(evaluate(changed, second.state, NOW + 120000)).confirmation.observations, 1);
  const regressed = entry('new', NOW + 120000); regressed.externalMarket.fetchedAt = new Date(NOW + 30000).toISOString();
  const rewind = evaluate(regressed, second.state, NOW + 120000);
  assert.equal(first(rewind).status, 'WAITING_DATA'); assert.deepEqual(rewind.state, {});
  const missing = entry('new', NOW + 120000); delete missing.externalMarket.fdvUsd;
  assert.deepEqual(evaluate(missing, second.state, NOW + 120000).state, {});
  assert.equal(first(evaluate(entry('new', NOW + 240000), second.state, NOW + 240000)).confirmation.observations, 1);
  const policy = structuredClone(config); policy.version = 'new-version';
  assert.equal(first(evaluate(entry('new', NOW + 120000), second.state, NOW + 120000, { policy })).confirmation.observations, 1);
});

test('malformed retained state and non-integer transaction counts cannot generate an alert', () => {
  const value = entry(); value.externalMarket.txns.m5.buys = 12.5;
  assert.equal(first(evaluate(value)).status, 'WAITING_DATA');
  assert.doesNotThrow(() => evaluate(entry(), { bad: { pipeline: 'constructor' } }));
  assert.deepEqual(evaluateMarketSignals(null, {}, { now: NOW }).entries, []);
});

function engineState(address, observed = NOW, overrides = {}) {
  return { policyHash: 'policy', address, chain: 'robinhood', chainId: 4663, environment: 'mainnet',
    pipeline: 'new', count: 1, lastObservedAtMs: observed, ...overrides };
}
test('incremental collector merge preserves another token while explicit failure, expiry, reorg and policy change reset it', () => {
  const prior = { a: engineState(token) };
  const next = { b: engineState(pair, NOW + 60000) };
  assert.deepEqual(Object.keys(mergeIncrementalEvaluationState(prior, next, { now: NOW + 60000, policyHash: 'policy' })), ['b', 'a']);
  assert.deepEqual(mergeIncrementalEvaluationState(prior, { a: engineState(token, NOW + 60000, { count: 0 }) },
    { now: NOW + 60000, policyHash: 'policy' }), {});
  assert.deepEqual(mergeIncrementalEvaluationState(prior, {}, { now: NOW + 151000, policyHash: 'policy' }), {});
  assert.deepEqual(mergeIncrementalEvaluationState(prior, {}, { now: NOW, policyHash: 'different' }), {});
  assert.deepEqual(mergeIncrementalEvaluationState(prior, {}, { now: NOW, policyHash: 'policy', reorg: true }), {});
  assert.deepEqual(mergeIncrementalEvaluationState({ malformed: { pipeline: 'constructor' } }, {}, { now: NOW, policyHash: 'policy' }), {});
});
