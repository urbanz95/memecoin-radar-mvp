# Experimental $5,000 USD FDV admission filter (Pump.fun)

**Status:** opt-in outside the focused launcher; enabled in `scripts/run-pump-focused.sh`. Read-only; no trades, liquidity or safety verdicts.

## Why this is NOT a market-cap assertion

The user-requested $5,000 USD market-cap cutoff is approximated conservatively using **protocol-reported, SOL-quoted Pump.fun *fully diluted valuation* (FDV)**. Circulating market cap cannot be proven solely from a Pump trade event, and the scanner does not label this as verified MC.

Inputs:

1. A **verified Pump.fun creation log** observed in this process, supplying the token mint and `token_total_supply` in raw units.
2. A **verified Pump.fun creation/trade log** for the same mint with wrapped SOL quote mint, or the Pump protocol's explicit **native-SOL sentinel** (`11111111111111111111111111111111`) and a virtual SOL/token reserve snapshot. The sentinel is documented by Pump as its `Pubkey::default()` SOL quote, and does **not** change the canonical log observation's unknown `quoteMint` into a fabricated mint.
3. A fresh external SOL/USD quote from CoinGecko's **public** simple-price API. It is fetched *at most once every two minutes*; the provider may refuse or rate-limit requests. It is **not** a Solana RPC request.

The FDV proxy formula (using exact integers) is:

`FDV_USD_cents ≈ ceil(virtual_quote_lamports / virtual_token_raw * total_supply_raw * SOL_USD_cents / 1e9)`

Raw token units cancel, so **no token-decimal assumption is needed**. This is a spot virtual-reserve proxy, not sale proceeds, guaranteed liquidity or circulating cap.

The maximum of estimates present in the same notification is used; only when **all supported observations have valid data** may the scanner skip HTTP enrichment. The actual skip level has a 5% guard band: with a configured `$5,000` minimum, only verified FDV estimates **below $4,750** are suppressed. Observations in the `$4,750–$5,000` band remain eligible, to mitigate rounding and stale pricing. An event timestamp must be within 60 seconds and the quote within 5 minutes.

This policy does **not** suppress PumpSwap events using stale Pump.fun valuations, graduation/migration, unknown supply, unknown quote mint, stale price, decode failures or missing evidence. Unknown observations follow the existing HTTP-inbox policy; due to public RPC limits they may still be skipped later for backlog reasons. There is no claim of complete indexing or production safety.

## Persistence / restart

Every decodable real RPC log is stored in `event_observations` before the HTTP decision. Only admission into the HTTP context-enrichment inbox is filtered. `fdvGateSkippedLow`, `fdvGateEligible` and `fdvGateUnknown` are exposed in the /health counter series; the read-only /health response also includes source, cache size/evictions, threshold and oracle failure count.

The bounded creation-supply cache holds **up to 20,000 observed mints**, process-local only. After process restart, mints without an observed creation event are **UNKNOWN**, not low. Historical or cross-pool price attribution is intentionally not inferred. This prioritizes avoiding false negatives over suppressing maximum traffic.

## How to enable or disable

Focused launcher (new default for this experimental branch):

```bash
cd solana
npm ci --ignore-scripts
npm test
bash scripts/run-pump-focused.sh
```

It sets `SOLANA_FDV_MINIMUM_USD=5000` and `SOLANA_SOL_USD_FEED=coingecko`. External requests are independent of the Solana HTTP-RPC budget; no API key, subscription, or paid provider is required.

To disable **all** market-cap gating and return to the previous behavior:

```bash
SOLANA_FDV_MINIMUM_USD=0 bash scripts/run-pump-focused.sh
```

To disable external SOL/USD access, causing the filter to **fail open** (unknown, not excluded):

```bash
SOLANA_SOL_USD_FEED=off bash scripts/run-pump-focused.sh
```

Global `npm start` defaults to `SOLANA_FDV_MINIMUM_USD=0` and `SOLANA_SOL_USD_FEED=off`. Avoid raising the HTTP budget merely to test a filter.

## Tests and evidence

```bash
cd solana
node --test test/fdv-filter.test.mjs
npm test
```

These test exact integer arithmetic, fallback on unknown/stale supply/quotes, the 5% margin, bounded cache, quote refresh interval, isolated configuration and persistence of decoded logs when HTTP enrichment is skipped.

### Real Mainnet evidence: 5 November 2026

The [pre-filter focused 90s smoke](../reports/pump-focused-smoke-20261105.json) monitored the same two programs at 12 HTTP RPC requests/minute, but the activity interval was different.

A first **filtered** 90s smoke showed all observations UNKNOWN and **zero** filters. Its [GitHub Actions run](https://github.com/urbanz95/memecoin-radar-mvp/actions/runs/42116245455) confirmed the SOL/USD public price was available but the supply cache was empty. We fixed two evidence-handling problems: creation supply can be cached independently of the quote mint; Pump's officially documented native SOL sentinel is recognized for valuation only (without changing the canonical quote field).

The [corrected filtered 90s run](https://github.com/urbanz95/memecoin-radar-mvp/actions/runs/42117292875) succeeded and its raw counters and final oracle/cache health are preserved in [this JSON report](../reports/fdv-filter-5k-mainnet-90s-20261105.json):

| Counter / measurement | Corrected filtered run (90.007s) |
|---|---:|
| Received notifications | 55,925 |
| Below-FDV notifications not sent to HTTP inbox | **1,117** (about 2% of received notifications) |
| Evidence-backed eligible notifications | 277 |
| Unknown notifications | 54,531 |
| RPC HTTP requests | 18 (~12/min, configured maximum) |
| Transactions enriched | 16 |
| Canonical enriched events | 11 |
| Persistent inbox backlog at end | 65 |
| Degraded health snapshots | 19/19 |
| SOL/USD public quote failures | 0 |
| Verified creation supplies in process cache at end | 67 |
| Log observation latency p95 (process reservoir) | 270ms |
| Enriched event latency p95 (10 samples) | 89,514ms |

This proves the policy can avoid some HTTP admissions. **It does not demonstrate improved throughput or latency:** the pre-filter 90s run also used 18 HTTP RPC requests and enriched 16 transactions. The 90s intervals had different market activity, and the filter did not eliminate the durable backlog. `fdvGateUnknown` includes a mix of missing protocol context, unsupported events and failed logs; it must not be interpreted as a count of coins under or over $5k. No long-lived production reliability is claimed.

**Next:** prioritize a small set of high-value, adequately evidenced creations and migrations within the fixed RPC budget, with starvation and missing-context accounting, then rerun comparable measurements.

### Protocol / feed sources

- Official Pump.fun bonding curve explanation: https://pump.fun/docs/bonding-curve
- Official native-SOL sentinel semantics: https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md
- Pump's published protocol / event definitions: https://github.com/pump-fun/pump-public-docs
- CoinGecko public API rate-limit documentation: https://support.coingecko.com/articles/5125303456-what-is-the-rate-limit-for-coingecko-api-public-plan

**Not a trading signal or token safety approval.**
