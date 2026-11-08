// Public opt-in SOL/USD quotes. No keys and no Solana RPC requests.
// CoinGecko is primary. Kraken market last-trade is an optional free fallback.
// The timestamp for Kraken represents *fetch time*, NOT on-chain or exchange
// transaction time. Never infer a price when both responses are unavailable.
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_last_updated_at=true";
const KRAKEN_URL = "https://api.kraken.com/0/public/Ticker?pair=SOLUSD";

function positiveCents(price) {
  const value = typeof price === "string" && /^\d+(?:\.\d+)?$/.test(price)
    ? Number(price) : price;
  if (typeof value !== "number" || !Number.isFinite(value) ||
      value <= 0 || value > 1000000)
    throw Error("SOL_USD_INVALID_PRICE");
  return Math.ceil(value * 100);
}

export class SolUsdOracle {
  constructor({
    enabled = false, fallbackEnabled = false,
    fetchFn = fetch, now = Date.now, refreshMs = 120000, maxAgeMs = 300000,
  } = {}) {
    this.enabled = enabled;
    this.fallbackEnabled = fallbackEnabled;
    this.fetchFn = fetchFn;
    this.now = now;
    this.refreshMs = refreshMs;
    this.maxAgeMs = maxAgeMs;
    this.nextAttempt = 0;
    this.last = null;
    this.failures = 0;
    this.fallbackSuccesses = 0;
  }
  snapshot() {
    if (!this.enabled || !this.last) return null;
    const delta = this.now() - this.last.at;
    return delta >= -15000 && delta <= this.maxAgeMs ? { ...this.last } : null;
  }
  async request(url) {
    const response = await this.fetchFn(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw Error("SOL_USD_HTTP_UNAVAILABLE");
    return response.json();
  }
  async coingecko() {
    const payload = await this.request(COINGECKO_URL);
    const updated = payload?.solana?.last_updated_at;
    if (!Number.isSafeInteger(updated) || updated <= 0)
      throw Error("SOL_USD_INVALID_PAYLOAD");
    return {
      usdCents: positiveCents(payload?.solana?.usd),
      at: updated * 1000,
      source: "coingecko_public_simple_price",
    };
  }
  async kraken() {
    const payload = await this.request(KRAKEN_URL);
    if (!Array.isArray(payload?.error) || payload.error.length !== 0 ||
        !payload.result || typeof payload.result !== "object")
      throw Error("SOL_USD_KRAKEN_INVALID_PAYLOAD");
    const entries = Object.entries(payload.result);
    if (entries.length !== 1 ||
        !["SOLUSD", "SOLZUSD"].includes(entries[0][0]) ||
        !Array.isArray(entries[0][1]?.c))
      throw Error("SOL_USD_KRAKEN_PAIR_MISMATCH");
    return {
      usdCents: positiveCents(entries[0][1].c[0]),
      // Kraken Ticker does not provide an execution timestamp for last trade.
      // This is only the time the last-traded price was fetched.
      at: this.now(),
      source: "kraken_SOLUSD_last_trade_fetched_not_trade_timestamp",
    };
  }
  accept(quote) {
    const age = this.now() - quote.at;
    if (age < -15000 || age > this.maxAgeMs)
      throw Error("SOL_USD_STALE");
    this.last = quote;
    return true;
  }
  async refresh() {
    if (!this.enabled || this.now() < this.nextAttempt) return false;
    // Only one scheduled refresh attempt per interval, even when both
    // independent public quote APIs fail. No busy loops and no hidden RPC.
    this.nextAttempt = this.now() + this.refreshMs;
    try {
      return this.accept(await this.coingecko());
    } catch {
      if (this.fallbackEnabled) {
        try {
          const accepted = this.accept(await this.kraken());
          if (accepted) this.fallbackSuccesses++;
          return accepted;
        } catch {
          // Fail closed to UNKNOWN; never synthesize an exchange quote.
        }
      }
      this.failures++;
      this.last = null;
      return false;
    }
  }
}
