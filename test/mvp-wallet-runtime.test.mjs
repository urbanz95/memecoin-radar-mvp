import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectObservedWallets } from '../src/mvp/wallet-runtime.mjs';
import { prepareWalletProjection, readWalletProfile, getWalletLedgerStats } from '../src/mvp/wallet-ledger.mjs';
import { setup, TOKEN, time } from './helpers/mvp-sqlite.mjs';
const schema = await readFile(new URL('../cloudflare/migrations/0004_mvp_wallets.sql', import.meta.url), 'utf8');
const hash = n => '0x' + n.toString(16).padStart(64, '0');

test('a transaction sender without settlement history remains tracked with unknown PnL and unknown lifetime trade count', async t => {
  const DB = setup(t); DB.sqlite.exec(schema);
  const input = [{ receipt: { from: TOKEN(10), logs: [], transactionHash: hash(4), status: '0x1',
    blockNumber: '0x64', blockHash: hash(100) }, block: { number: 100, hash: hash(100), timestamp: time / 1000 },
    tokenAddress: TOKEN(1), pool: null, events: [], source: 'canonical-readonly-receipt/v1' }];
  const projected = await projectObservedWallets(DB, input, { now: time });
  assert.equal(projected.profiles.length, 1);
  const value = projected.profiles[0];
  assert.equal(value.realizedTradeCount, null);
  assert.equal(value.netRealizedPnlUsd, null);
  assert.equal(value.eligible, false);
  assert.equal(value.historyComplete, false);
  assert.equal(value.attributionComplete, false);
  assert.equal(value.riskFlags, null);
  await DB.batch(prepareWalletProjection(DB, { runId: 'actual-unknown', observedAt: time, profiles: projected.profiles }).commands);
  assert.equal((await readWalletProfile(DB, TOKEN(10))).netRealizedPnlUsd, null);
  const stats = await getWalletLedgerStats(DB);
  assert.equal(stats.tracked, 1); assert.equal(stats.eligible, 0);
  const retry = await projectObservedWallets(DB, input, { now: time + 1 });
  assert.deepEqual(retry.profiles[0].observedCounts, value.observedCounts);
});

test('missing sender and invalid runtime input cannot invent a tracked smart wallet', async t => {
  const DB = setup(t); DB.sqlite.exec(schema);
  const result = await projectObservedWallets(DB, [{ receipt: { from: null } }], { now: time });
  assert.deepEqual(result.profiles, []);
  assert.deepEqual(result.diagnostics, ['WALLET_SENDER_UNAVAILABLE']);
  await assert.rejects(projectObservedWallets(DB, [], { now: NaN }), /RUNTIME_INPUT/);
});
