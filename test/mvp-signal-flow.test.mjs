import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateNewToken } from '../src/mvp/pipeline.mjs';
import { prepareDryRunAlerts } from '../src/mvp/alerts.mjs';
import { decisionKey } from '../src/mvp/records.mjs';
import { fixture, DEMO_TIME as NOW } from '../examples/fixtures.mjs';
import { setup, TOKEN } from './helpers/mvp-sqlite.mjs';
import { withSyntheticRealizations } from './helpers/wallet-temporal.mjs';
const outboxSchema = await readFile(new URL('../cloudflare/migrations/0003_mvp_outbox.sql', import.meta.url), 'utf8');
const iso = value => new Date(value).toISOString();
const hash = value => '0x' + value.toString(16).padStart(64, '0');
function inputs() {
  const snapshot = fixture();
  const stamp = { schemaVersion: 1, chainId: 4663, address: snapshot.address, checkedAt: iso(NOW),
    source: 'synthetic-provenance', evidence: ['fixture:typed-history'], complete: true };
  const entry = { address: snapshot.address, poolId: `v2:${TOKEN(99)}`, observedAt: iso(NOW),
    blockNumber: snapshot.chainState.blockNumber, status: 'REVIEW', risks: [], hardFilterEvidence: {
      deployerHistory: { ...stamp, deployerAddress: TOKEN(80), knownMaliciousDeployments: 0 },
      launchActivity: { ...stamp, bundledSupplyPct: 3, sniperManipulationConfirmed: false } } };
  const walletProfiles = [10, 11].map(n => withSyntheticRealizations({ chainId: 4663, walletAddress: TOKEN(n), checkedAt: iso(NOW),
    source: 'synthetic-full-fifo-proof', evidence: ['fixture:full-ledger'], historyComplete: true,
    costsComplete: true, feesComplete: true, attributionComplete: true, clusteringComplete: true,
    realizedTradeCount: 5, netRealizedPnlUsd: '1000', winRatePct: 100, avgHoldingSeconds: 300,
    earlyEntryPct: 70, maxDrawdownPct: 0, lastRealizedAt: iso(NOW),
    riskFlags: { insider: false, bundler: false, washTrading: false } }, { now: NOW }));
  const walletEntries = walletProfiles.map((p, n) => ({ chainId: 4663, tokenAddress: snapshot.address,
    walletAddress: p.walletAddress, observedAt: iso(NOW), source: 'synthetic-receipt-flow', evidence: ['fixture:receipt'],
    attributionVerified: true, entryType: 'buy', firstEntryAt: iso(NOW - 60000), earlyEntry: true,
    clusterId: `fixture-independent-${n}`, clusteringComplete: true, clusterEvidence: ['fixture:cluster-analysis'] }));
  const momentumObservations = [0, 1].map(n => ({ chainId: 4663, address: snapshot.address,
    observedAt: iso(NOW - (1 - n) * 120000), source: 'synthetic-growth', evidence: ['fixture:canonical-growth'],
    canonical: true, holdersCount: n ? 120 : 100, liquidityUsd: n ? 150000 : 100000, holdersComplete: true,
    holdersCheckedAt: iso(NOW - (1 - n) * 120000), liquidityFetchedAt: iso(NOW - (1 - n) * 120000),
    blockNumber: 100 + n, blockHash: hash(100 + n), pairAddress: TOKEN(99) }));
  return { snapshot, entry, options: { now: NOW, walletProfiles, walletEntries, momentumObservations } };
}

test('synthetic complete evidence produces a versioned manual signal and one idempotent Telegram dry-run', async t => {
  const DB = setup(t); DB.sqlite.exec(outboxSchema);
  const { snapshot, entry, options } = inputs();
  const result = evaluateNewToken(snapshot, entry, options);
  assert.equal(result.status, 'PASS'); assert.equal(result.synthetic, true);
  assert.equal(result.score, 100); assert.equal(result.reasons.length, 3);
  assert.equal(result.wallets.independentGroups, 2);
  const alert = { ...result, wallets: result.wallets.wallets,
    decisionId: decisionKey(4663, result.address, result.scoreVersion, result.profile) };
  const prepared = prepareDryRunAlerts(DB, [alert], { runId: 'synthetic-signal', observedAt: NOW });
  assert.equal(prepared.accepted.length, 1);
  await DB.batch(prepared.commands); await DB.batch(prepared.commands);
  const row = DB.sqlite.prepare('SELECT * FROM mvp_alert_outbox').get();
  assert.equal(row.state, 'DRY_RUN'); assert.equal(row.synthetic, 1);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_alert_outbox').get().n, 1);
});

test('missing wallet costs or an unproven funding cluster blocks the same complete synthetic setup', () => {
  for (const mutate of [value => { value.options.walletProfiles[0].costsComplete = false; },
    value => { value.options.walletEntries[0].clusteringComplete = false; }]) {
    const value = inputs(); mutate(value);
    const result = evaluateNewToken(value.snapshot, value.entry, value.options);
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.score, null);
    assert.equal(result.alertEligible, false);
  }
});
