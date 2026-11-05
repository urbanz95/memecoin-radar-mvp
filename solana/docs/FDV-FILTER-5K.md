# Experimental $5,000 USD FDV admission filter (Pump.fun)

**Status:** opt-in outside the focused launcher; enabled in `scripts/run-pump-focused.sh`. Read-only; no trades, liquidity or safety verdicts.

## Why this is NOT a market-cap assertion

The user-requested $5,000 USD market-cap cutoff is approximated conservatively using **protocol-reported, SOL-quoted Pump.fun *fully diluted valuation* (FDV)**. Circulating market cap cannot be proven solely from a Pump trade event, and the scanner does not label this as verified MC.

Inputs:

1. A **verified Pump.fun creation log** observed in this process, supplying the token mint and `token_total_supply` in raw units.
2. A **verified Pump.fun creation/trade log** for the same mint with explicit wrapped SOL quote mint and the virtual SOL/token reserve snapshot.
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

The historical 90-second focused smoke report [lives here](../reports/pump-focused-smoke-20261105.json) and **did not use this filter**. We must rerun the same two-protocol 90-second smoke with a real quote feed and compare skip rates and RPC use, with no claim of speed gain until measured. Compare within equivalent sampling scope and budget.

### Protocol / feed sources

- Official Pump.fun bonding curve explanation: https://pump.fun/docs/bonding-curve
- Pump's published protocol / event definitions: https://github.com/pump-fun/pump-public-docs
- CoinGecko public API rate-limit documentation: https://support.coingecko.com/articles/5125303456-what-is-the-rate-limit-for-coingecko-api-public-plan

**Not a trading signal or token safety approval.**
