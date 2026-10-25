import { advanceWalletTemporalSummary, walletTemporalEvidence } from '../../src/mvp/wallet-temporal.mjs';

// Explicit synthetic disposal history for ranking fixtures. Production profiles
// obtain this evidence only from reconciled receipts and the immutable ledger.
export function withSyntheticRealizations(profile, { now = Date.parse(profile.checkedAt), config } = {}) {
  const raw = profile.netRealizedPnlUsd;
  if (typeof raw !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(raw)
    || !Number.isSafeInteger(profile.realizedTradeCount) || profile.realizedTradeCount < 1
    || profile.realizedTradeCount > 128 || !/^0x[0-9a-f]{40}$/i.test(profile.walletAddress)) return profile;
  const negative = raw.startsWith('-'); const [integer, fraction = ''] = raw.replace(/^-/, '').split('.');
  const numerator = BigInt(integer + fraction) * (negative ? -1n : 1n);
  const denominator = 10n ** BigInt(fraction.length);
  const exact = { numerator: numerator.toString(), denominator: denominator.toString() };
  const perDenominator = denominator * BigInt(profile.realizedTradeCount);
  let scaled = numerator * 10n ** 18n / perDenominator;
  if (numerator < 0n && numerator * 10n ** 18n % perDenominator) scaled--;
  const digits = (scaled < 0n ? -scaled : scaled).toString().padStart(19, '0');
  const tail = digits.slice(-18).replace(/0+$/, '');
  const perPnl = (scaled < 0n ? '-' : '') + digits.slice(0, -18) + (tail ? '.' + tail : '');
  const hash = n => '0x' + BigInt(n + 1).toString(16).padStart(64, '0');
  const events = Array.from({ length: profile.realizedTradeCount }, (_, index) => {
    const blockHash = hash(index); const transactionHash = hash(index + 1000);
    return { schemaVersion: 1, accountingVersion: 'fifo-receipt-net-usd/v1',
      id: `4663:${blockHash}:${transactionHash}:1:${profile.walletAddress}`, disposalIndex: index + 1,
      chainId: 4663, walletAddress: profile.walletAddress, tokenAddress: '0x' + 'a'.repeat(40),
      transactionHash, blockHash, blockNumber: index + 1, logIndex: 1,
      timestamp: profile.lastRealizedAt, netRealizedPnlUsd: perPnl,
      netRealizedPnlUsdExact: { numerator: numerator.toString(), denominator: perDenominator.toString() },
      holdingSeconds: profile.avgHoldingSeconds, earlyEntryPct: profile.earlyEntryPct,
      drawdownPct: profile.maxDrawdownPct, source: 'synthetic-fixture-only', evidence: ['fixture:reconciled-disposal'] };
  });
  const value = { ...profile, netRealizedPnlUsdExact: exact };
  const observedAt = Math.max(now, Date.parse(profile.lastRealizedAt));
  const summary = advanceWalletTemporalSummary(null, events, { observedAt, config });
  return { ...value, realizationHistory: walletTemporalEvidence(value, summary, { now, config }) };
}
