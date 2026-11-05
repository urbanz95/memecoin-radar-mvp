import { SOL_MINT } from './protocols/pump.mjs';

// Conservative upper-bound FDV proxy. Both token supply and token reserve use
// raw units, so token decimals cancel. SOL reserves are native lamports.
// This is NOT verified circulating market cap, liquidity or sellable value.
const U64_MAX = (1n << 64n) - 1n;
const LAMPORTS = 1_000_000_000n;
function rawUnsigned(value) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return null;
  const n = BigInt(value);
  return n <= U64_MAX ? n : null;
}
export function estimatedFdvUsdCents({ virtualTokenRaw, virtualQuoteRaw, totalSupplyRaw, solUsdCents }) {
  const tokens = rawUnsigned(virtualTokenRaw);
  const quote = rawUnsigned(virtualQuoteRaw);
  const supply = rawUnsigned(totalSupplyRaw);
  if (tokens === null || !tokens || quote === null || !quote || supply === null || !supply ||
      !Number.isSafeInteger(solUsdCents) || solUsdCents <= 0) return null;
  // Ceil to avoid classifying a token as cheap due to rounding down.
  const numerator = quote * supply * BigInt(solUsdCents);
  const denominator = tokens * LAMPORTS;
  return (numerator + denominator - 1n) / denominator;
}

const ORDINARY = new Set([
  'TOKEN_CREATED', 'TOKEN_BOUGHT', 'TOKEN_SOLD', 'CURVE_PROGRESS_UPDATED',
]);

/**
 * Opt-in HTTP enrichment admission. Always persist the decoded log observations
 * independently. A below-limit verdict requires a verified Pump.fun SOL quote,
 * supply observed in a creation log during this process and a fresh oracle.
 * Missing any evidence means UNKNOWN -> do not suppress enrichment.
 */
export class FdvEnrichmentGate {
  constructor({ minimumUsd = 0, oracle, now = Date.now, maxMints = 20000 } = {}) {
    if (!Number.isSafeInteger(minimumUsd) || minimumUsd < 0 || minimumUsd > 1_000_000_000)
      throw Error('INVALID_FDV_MINIMUM');
    this.minimumUsd = minimumUsd;
    this.oracle = oracle;
    this.now = now;
    this.maxMints = maxMints;
    this.supplies = new Map();
    this.cacheEvictions = 0;
  }
  evaluate(observations) {
    if (!this.minimumUsd) return { action: 'DISABLED' };
    if (!Array.isArray(observations) || !observations.length)
      return { action: 'UNKNOWN', reason: 'NO_DECODED_LOG_EVENT' };
    const snapshot = this.oracle?.snapshot();
    let sawNonLow = false;
    let sawUnknown = false;
    let maxEstimated = null;
    let reason = null;
    for (const o of observations) {
      const fresh = o && Number.isFinite(Date.parse(o.eventTimestamp)) &&
        Math.abs(this.now() - Date.parse(o.eventTimestamp)) <= 60000;
      const knownProtocol = o?.protocol === 'pump_fun' && o.quoteMint === SOL_MINT;
      if (knownProtocol && o.eventType === 'TOKEN_CREATED' &&
          typeof o.tokenMint === 'string' && o.tokenMint) {
        const supply = rawUnsigned(o.totalSupplyRaw);
        if (supply && supply > 0n) {
          // Supply is evidence from the actual creation log, not an assumed default.
          if (this.supplies.has(o.tokenMint)) this.supplies.delete(o.tokenMint);
          this.supplies.set(o.tokenMint, o.totalSupplyRaw);
          if (this.supplies.size > this.maxMints) {
            this.supplies.delete(this.supplies.keys().next().value);
            this.cacheEvictions++;
          }
        }
      }
      if (!knownProtocol || !ORDINARY.has(o.eventType) || !fresh || !snapshot ||
          !Number.isFinite(snapshot.at) || this.now() - snapshot.at > 300000 ||
          snapshot.at > this.now() + 15000) {
        sawUnknown = true;
        reason = !snapshot ? 'SOL_USD_PRICE_MISSING_OR_STALE' : 'EVENT_CONTEXT_INCOMPLETE';
        continue;
      }
      const supply = this.supplies.get(o.tokenMint);
      const est = estimatedFdvUsdCents({
        virtualTokenRaw: o.reserves?.virtualTokenRaw,
        virtualQuoteRaw: o.reserves?.virtualQuoteRaw,
        totalSupplyRaw: supply,
        solUsdCents: snapshot.usdCents,
      });
      if (est === null) {
        sawUnknown = true;
        reason = 'SUPPLY_OR_RESERVES_UNKNOWN';
        continue;
      }
      // The price is a proxy and may move quickly. Keep a 5% guard band.
      // Tokens in the guard band remain eligible for full context.
      if (est * 100n >= BigInt(this.minimumUsd) * 100n * 95n) {
        sawNonLow = true;
      }
      if (maxEstimated === null || est > maxEstimated) maxEstimated = est;
    }
    if (sawUnknown) return { action: 'UNKNOWN', reason: reason ?? 'INSUFFICIENT_EVIDENCE' };
    if (sawNonLow) return { action: 'ENRICH', reason: 'FDV_AT_OR_ABOVE_GUARDED_LIMIT' };
    if (maxEstimated === null) return { action: 'UNKNOWN', reason: 'NO_VALUATION' };
    return {
      action: 'SKIP_LOW_FDV',
      reason: 'PUMP_FUN_SOL_VIRTUAL_RESERVE_FDV_BELOW_95_PERCENT_OF_LIMIT',
      estimatedFdvUsdCents: maxEstimated.toString(),
      evidenceType: 'VERIFIED_PUMP_FUN_LOG_PLUS_EXTERNAL_SOL_USD',
    };
  }
}
