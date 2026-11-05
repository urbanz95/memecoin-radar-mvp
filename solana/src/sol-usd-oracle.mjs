// Free public SOL/USD feed, opt-in and globally rate-limited by a single process
// timer. No keys and no Solana RPC requests. Failure -> price UNKNOWN, not $0.
const URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_last_updated_at=true';

export class SolUsdOracle {
  constructor({ enabled = false, fetchFn = fetch, now = Date.now,
                refreshMs = 120000, maxAgeMs = 300000 } = {}) {
    this.enabled = enabled;
    this.fetchFn = fetchFn;
    this.now = now;
    this.refreshMs = refreshMs;
    this.maxAgeMs = maxAgeMs;
    this.nextAttempt = 0;
    this.last = null;
    this.failures = 0;
  }
  snapshot() {
    if (!this.enabled || !this.last) return null;
    const delta = this.now() - this.last.at;
    return delta >= -15000 && delta <= this.maxAgeMs ? { ...this.last } : null;
  }
  async refresh() {
    if (!this.enabled || this.now() < this.nextAttempt) return false;
    // Reserve quota before sending; failures must not trigger busy retries.
    this.nextAttempt = this.now() + this.refreshMs;
    try {
      const response = await this.fetchFn(URL, {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw Error('SOL_USD_HTTP_UNAVAILABLE');
      const payload = await response.json();
      const price = payload?.solana?.usd;
      const updated = payload?.solana?.last_updated_at;
      if (typeof price !== 'number' || !Number.isFinite(price) ||
          price <= 0 || price > 1000000 ||
          !Number.isSafeInteger(updated) || updated <= 0)
        throw Error('SOL_USD_INVALID_PAYLOAD');
      const quote = {
        usdCents: Math.ceil(price * 100), // upper bound, never round down
        at: updated * 1000,
        source: 'coingecko_public_simple_price',
      };
      const age = this.now() - quote.at;
      if (age < -15000 || age > this.maxAgeMs)
        throw Error('SOL_USD_STALE');
      this.last = quote;
      return true;
    } catch {
      this.failures++;
      this.last = null;
      return false;
    }
  }
}
