# Additional real Mainnet fixtures — 2026-11-04

These four finalized transactions were selected from logs already observed by the guarded real-time scanner. They are additional decoder evidence, not a latency benchmark or a claim of complete protocol coverage. No runtime source was changed during capture.

The separate `LIVE-VALIDATION-MANIFEST.json` records signatures, slots, exact RPC parameters, SHA256 hashes, decoder results, diagnostics, and the corresponding persisted log notification and observation snapshots. Transaction files preserve the actual unmodified HTTP JSON-RPC response body. Notification and observation JSON files are serialized snapshots of stored scanner payloads; the evidence hash covers the original log array using `JSON.stringify(logs)`.

| Fixture | Verified operation | Limits |
|---|---|---|
| `raydium-cpmm-buy-live-mainnet.json` | CPMM `SwapEvent` buy; exact mints, wallet, amounts, wallet token credit, SPL transfers | This specific supported transaction, not every route |
| `raydium-cpmm-deposit-live-mainnet.json` | CPMM `LpChangeEvent` deposit; exact mints, wallet, amounts, wallet debit, SPL transfers | Does not validate withdrawals or permissioned initialization |
| `raydium-launchlab-sell-live-mainnet.json` | Routed LaunchLab sell, version 1, Token-2022; exact event amounts and matching vault delta | Protocol amount is net into the vault, not gross wallet debit; mint extension configuration was not queried |
| `pumpswap-withdraw-live-mainnet.json` | PumpSwap `WithdrawEvent`; exact pool/base/quote/user amounts match transfers | Eight trailing bytes beyond official pinned IDL remain unknown; event is `INCOMPLETE` |

LaunchLab transaction `5zxj2nBxmoJNw5Tm9A8MuBTU4tFRHrnpP27s1iAs9sjPB7Ug9no7JYgZqnb5sVNeUycaXJ65rCALPiJrU8m17YJa` proves a protocol-reported token input and vault credit of `1461251792189`, a wallet debit/Token-2022 `TransferChecked` amount of `1506445146587`, and a difference of `45193354398` raw. The difference is proven by transaction balances; a particular fee-extension configuration or schedule is not inferred. `amountTokenRaw` retains the protocol event amount. Future agent consumers must not silently call this the wallet's gross volume.

PumpSwap uses its protocol base/quote orientation. In this particular withdrawal the base mint is WSOL and quote mint is `63D1CM1w82so55yRNYciyez79RtzAmCXiekraEDL5UeQ`; the decoder does not flip mints based on symbols or a presumed SOL quote.

The separate `../reports/live-fixture-probe.json` records exactly four `getTransaction` HTTP requests to the public Solana Mainnet RPC, paced at four requests/minute, zero retries, zero errors, and no other RPC methods. Each candidate was older than 60 seconds before its request. This budget is additional to the scanner's independent 12/minute budget. No history completeness is claimed. PumpSwap deposits, LaunchLab graduations/migrations and CPMM withdrawals remain without new finalized fixture evidence from this probe.

Run deterministic replay with `node --test solana/test/live-fixtures.test.mjs` from the repository root. Replay timing is not production latency.
