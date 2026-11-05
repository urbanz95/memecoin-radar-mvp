import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FdvEnrichmentGate, estimatedFdvUsdCents } from '../src/market-cap-gate.mjs';
import { SolUsdOracle } from '../src/sol-usd-oracle.mjs';
import { loadConfig } from '../src/config.mjs';
import { Scanner } from '../src/scanner.mjs';
import { Store } from '../src/store.mjs';
import { PROGRAMS } from '../src/protocols/index.mjs';
import { SOL_MINT } from '../src/protocols/pump.mjs';

const clock = Date.parse('2026-11-05T20:00:00.000Z');
const create = (patch = {}) => ({
  protocol: 'pump_fun', eventType: 'TOKEN_CREATED',
  tokenMint: 'pump-mint-fixture',
  quoteMint: SOL_MINT, eventTimestamp: new Date(clock).toISOString(),
  totalSupplyRaw: '1000000000000000',
  reserves: {
    virtualTokenRaw: '1073000000000000',
    virtualQuoteRaw: '30000000000',
  },
  ...patch,
});
const trade = (patch = {}) => ({
  protocol: 'pump_fun', eventType: 'TOKEN_BOUGHT',
  tokenMint: 'pump-mint-fixture', quoteMint: SOL_MINT,
  eventTimestamp: new Date(clock).toISOString(),
  reserves: {
    virtualTokenRaw: '850000000000000',
    virtualQuoteRaw: '40000000000',
  },
  ...patch,
});
const oracle = {
  snapshot: () => ({ usdCents: 16000, at: clock, source: 'test_quote' }),
  async refresh() { return true; },
};
const gate = () => new FdvEnrichmentGate({
  minimumUsd: 5000, oracle, now: () => clock,
});

test('FDV estimate uses exact raw integer arithmetic without token-decimal guesses', () => {
  // 30 SOL / 1.073B tokens * 1B supply * $160 =~ $4473.44 FDV.
  const cents = estimatedFdvUsdCents({
    virtualTokenRaw: '1073000000000000',
    virtualQuoteRaw: '30000000000',
    totalSupplyRaw: '1000000000000000',
    solUsdCents: 16000,
  });
  assert.ok(cents > 447000n && cents < 448000n);
  assert.equal(estimatedFdvUsdCents({
    virtualTokenRaw: '0', virtualQuoteRaw: '2',
    totalSupplyRaw: '10', solUsdCents: 16000,
  }), null);
  assert.equal(estimatedFdvUsdCents({
    virtualTokenRaw: '100', virtualQuoteRaw: 'invalid',
    totalSupplyRaw: '10', solUsdCents: 16000,
  }), null);
});

test('skip only when pump creation proves supply and fresh SOL quote proves low FDV', () => {
  const g = gate();
  const low = g.evaluate([create()]);
  assert.equal(low.action, 'SKIP_LOW_FDV');
  assert.ok(BigInt(low.estimatedFdvUsdCents) < 500000n);
  assert.equal(g.supplies.size, 1);
  assert.equal(g.evaluate([trade()]).action, 'ENRICH');
});

test('unknown mint, quote, data age, mixed event and pump swap cannot be suppressed', () => {
  assert.equal(gate().evaluate([trade()]).action, 'UNKNOWN');
  const g = gate();
  assert.equal(g.evaluate([create({ totalSupplyRaw: null })]).action, 'UNKNOWN');
  assert.equal(g.evaluate([create({ quoteMint: 'USDC' })]).action, 'UNKNOWN');
  assert.equal(g.evaluate([create({
    eventTimestamp: new Date(clock - 61000).toISOString(),
  })]).action, 'UNKNOWN');
  assert.equal(g.evaluate([create({ reserves: {} })]).action, 'UNKNOWN');
  assert.equal(g.evaluate([create(), { ...trade(), eventType: 'TOKEN_MIGRATED' }]).action, 'UNKNOWN');
  assert.equal(g.evaluate([create(), {
    ...trade(), protocol: 'pump_swap', eventType: 'TOKEN_BOUGHT',
  }]).action, 'UNKNOWN');
  assert.equal(g.evaluate([]).action, 'UNKNOWN');
});

test('oracle staleness and guarded near-boundary FDV do not suppress context', () => {
  const stale = new FdvEnrichmentGate({
    minimumUsd: 5000,
    now: () => clock,
    oracle: { snapshot: () => null },
  });
  assert.equal(stale.evaluate([create()]).action, 'UNKNOWN');
  // About $4860 (above safe admission guard at $4750).
  const g = gate();
  assert.equal(g.evaluate([create({ reserves: {
    virtualTokenRaw: '1000000000000000',
    virtualQuoteRaw: '30375000000',
  } })]).action, 'ENRICH');
});

test('bounded creation cache evicts old evidence instead of growing indefinitely', () => {
  const g = new FdvEnrichmentGate({
    minimumUsd: 5000, now: () => clock, oracle, maxMints: 1,
  });
  g.evaluate([create({ tokenMint: 'mintA' })]);
  g.evaluate([create({ tokenMint: 'mintB' })]);
  assert.equal(g.supplies.size, 1);
  assert.equal(g.cacheEvictions, 1);
  assert.equal(g.evaluate([trade({ tokenMint: 'mintA' })]).action, 'UNKNOWN');
});

test('free SOL/USD source obeys refresh interval and fails closed to UNKNOWN', async () => {
  let calls = 0, now = clock;
  const feed = new SolUsdOracle({
    enabled: true, now: () => now, refreshMs: 120000,
    fetchFn: async () => {
      calls++;
      if (calls === 2) return { ok: false };
      return { ok: true, json: async () => ({
        solana: { usd: 160.123, last_updated_at: Math.floor(now / 1000) },
      }) };
    },
  });
  assert.equal(await feed.refresh(), true);
  assert.equal(feed.snapshot().usdCents, 16013);
  assert.equal(await feed.refresh(), false);
  assert.equal(calls, 1);
  now += 120001;
  assert.equal(await feed.refresh(), false);
  assert.equal(feed.snapshot(), null);
  assert.equal(feed.failures, 1);
  assert.equal(calls, 2);
  now += 120001;
  assert.equal(await feed.refresh(), true);
  assert.equal(calls, 3);
});

test('configuration is opt-in globally, enabled in focused env and rejects nonsense', () => {
  assert.equal(loadConfig({ SOLANA_PROGRAMS: 'pump_fun' }).fdvMinimumUsd, 0);
  const focused = loadConfig({
    SOLANA_PROGRAMS: 'pump_fun,pump_swap',
    SOLANA_FDV_MINIMUM_USD: '5000',
    SOLANA_SOL_USD_FEED: 'coingecko',
  });
  assert.equal(focused.fdvMinimumUsd, 5000);
  assert.equal(focused.solUsdFeedEnabled, true);
  assert.throws(() => loadConfig({ SOLANA_FDV_MINIMUM_USD: '-1' }), /INVALID_CONFIG/);
  assert.throws(() => loadConfig({ SOLANA_SOL_USD_FEED: 'paid' }), /INVALID_SOLANA/);
});

test('scanner retains raw log observations while skipping known-low HTTP inbox', async (t) => {
  const tx = JSON.parse(readFileSync(new URL('../fixtures/pump-create-v2-mainnet.json', import.meta.url))).result;
  const store = new Store(':memory:');
  let socket;
  const scanner = new Scanner({
    ...loadConfig({ SOLANA_PROGRAMS: 'pump_fun' }),
    fdvMinimumUsd: 5000,
    solUsdFeedEnabled: false,
  }, {
    store,
    oracle,
    rpc: {
      async assertMainnet() {},
      async close() {},
      async request() { throw Error('HTTP_NOT_EXPECTED'); },
    },
    socketFactory: () => {
      socket = {
        start() {}, stop() {}, reconnect() {},
      };
      return socket;
    },
  });
  await scanner.start();
  t.after(() => scanner.stop());
  // Force the test admission decision while keeping real Mainnet log decoding.
  // Gate decision math, unknown handling and source checks are tested above.
  scanner.fdvGate.evaluate = () => ({ action: 'SKIP_LOW_FDV' });
  scanner.receive({
    signature: tx.transaction.signatures[0],
    slot: tx.slot,
    logs: tx.meta.logMessages,
    err: tx.meta.err,
    receivedAt: new Date().toISOString(),
    confirmationStatus: 'confirmed',
    programId: PROGRAMS.find(p => p.protocol === 'pump_fun').programId,
  });
  scanner.flush();
  assert.equal(store.stats().inbox, 0);
  assert.ok(store.observations({ signature: tx.transaction.signatures[0] }).length > 0);
  assert.equal(scanner.health().metrics.counters.fdvGateSkippedLow, 1);
  assert.equal(scanner.health().fdvFilter.minimumUsd, 5000);
});
