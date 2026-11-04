# Protocol coverage and evidence

Observed on Solana Mainnet, 2026-11-03. This is partial instruction coverage, not complete protocol support. Runtime subscriptions observe programme mentions; only successful actual invocations with recognised binary events/instructions produce canonical market events. Merely mentioning an address, token name, SPL transfer, or log word never proves a swap.

| Protocol | Official programme ID | Real Mainnet fixtures verified | Implemented but Mainnet UNVERIFIED | Not implemented |
|---|---|---|---|---|
| Pump.fun | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | `create_v2` creation/creator/Token-2022, initial buy, v2 routed buy, v3 buy and routed sell, protocol-reported reserves, `CompleteEvent` graduation, `migrate_v2` / `CompletePumpAmmMigrationEvent` migration | `PostCompleteBuyEvent` | Authority-change instruction monitoring, exact progress denominator unless proven, arbitrary future layouts |
| PumpSwap | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | Routed buy/sell, SOL and non-SOL quotes, pool and user accounts, `CreatePoolEvent` during actual Pump migration | `DepositEvent`, `WithdrawEvent`, negative virtual quote extension semantics | Full multihop route economic attribution, future layouts |
| Raydium LaunchLab | `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` | `initialize_v2` creation/curve/creator/first buy, routed buy, curve reserve/sold-state fields | Sell, graduation status `Migrate`, successful migration to CPMM/AMMv4 | Liquidity locking proof, future layouts |
| Raydium CPMM | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | Routed sell `SwapEvent` exact binary amounts/mints/user; `initialize` pool creation; address-mention negative fixture | Buy, permissioned pool creation `initialize_with_permission`, `LpChangeEvent` | Ambiguous base/quote pairs without a unique recognised WSOL/USDC quote; general other Raydium programmes |

## Sources and deployment drift

Pump IDLs copied unchanged from official [pump-public-docs](https://github.com/pump-fun/pump-public-docs/tree/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/idl), revision `639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22`. Documentation consulted includes `TRADE_V3.md`, `PUMP_SWAP_TRADE_V2.md`, `SYNTHETIC_MIGRATION.md`, `NEGATIVE_VIRTUAL_QUOTE_RESERVES.md`, and the main README. These current sources describe arbitrary pump quote mints and negative signed i128 virtual PumpSwap quote reserves; old SOL-only decoders would be incorrect.

Raydium IDLs are pinned from official [raydium-idl](https://github.com/raydium-io/raydium-idl/tree/e7e0c96fe77bcf6a020b84a44c47a722aac8e359), revision `e7e0c96fe77bcf6a020b84a44c47a722aac8e359`. CPMM source inspected at [raydium-cp-swap](https://github.com/raydium-io/raydium-cp-swap/tree/3d69122790e97cd6aff24e8ba95940793773f58c), including `declare_id!`, `states/events.rs`, swaps and liquidity instructions. See fixture Raydium provenance for source details.

`*-program-accounts-mainnet.json` contains actual `getMultipleAccounts` results: all configured programme accounts exist, are executable and are owned by `BPFLoaderUpgradeab1e11111111111111111111111`. This validates programme addresses, not equivalence between a source commit and the deployed executable binary. Each event records its IDL SHA256. A programme upgrade may invalidate any decoder; unknown/truncated layouts generate diagnostics.

**Observed actual drift:** Pump/PumpSwap trade events contain eight bytes beyond the latest official IDL. The known prefix, amounts, mints, user, reserves, and direction decode reproducibly; those events are conservatively `INCOMPLETE` and produce `EVENT_TRAILING_BYTES`. The extra field is not guessed or used. Pump `CreateEvent` matches the current IDL exactly. `quote_mint` can be the zero key for native SOL in current event data; the canonical quote then uses the explicit instruction `quote_mint` account (WSOL in the real fixtures), preserving the raw protocol field separately.

Mainnet actual fixtures include transaction **version 1**. RPC must request `maxSupportedTransactionVersion: 1`; setting zero was experimentally rejected with RPC `-32015`. The JSON transaction message and resolved `loadedAddresses` decode successfully. There is no transaction signing or submission dependency.

## Decoder boundaries

Binary discriminators, IDL Borsh layouts and actual runtime invocation ownership establish events. Anchor `emit_cpi` self-instructions and `Program data` events are supported, with deduplication between the same binary payloads. Static keys and RPC-loaded writable/readonly keys are combined in Solana account-index order; top and inner instruction indexes are retained. Program-owned event user fields and matching instruction account roles establish wallet attribution. Unknown attribution remains null and incomplete.

`TOKEN_MIGRATED` does not fabricate a historical `TOKEN_GRADUATED` when no graduation event was received. Token identity remains mint across graduation. Successful LaunchLab migration instructions are evidence only for their documented operation, not proof of all earlier lifecycle events. PumpSwap pool creator is not silently treated as the token creator; event `coin_creator` is retained separately from the pool creation actor where present.

Selected raw transaction fixtures are Mainnet captures. Synthetic lifecycle test inputs are constructed inside tests and explicitly labelled. The same mint `BxGdDCJDHr35RwpxFomSnSGXMYyk32c1YNVAdiwjpump` is proven in the final curve buy/`CompleteEvent` at slot 465057017 and `migrate_v2`/PumpSwap pool creation at slot 465057019. These are separate actual Mainnet transactions; initial creation of this specific mint has not been captured. No performance number from fixture replay is a production latency claim.

## Additional lifecycle validation

A bounded second investigation used 11 RPC calls with at least 2.1 seconds between requests, then stopped. Two calls returned explicit RPC `429` errors; no retry loop was used, and the next lookup followed a pause exceeding 60 seconds. These failures are recorded rather than counted as no events. Discovery sources were:

- Pump Global account `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf`, decoded with the pinned official `Global` layout, proves current `withdraw_authority=39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg`. Its signature history yielded the actual migration. The Global RPC account capture is retained.
- The mint history queried with `before` set to the proven migration yielded the immediately preceding final curve purchase and graduation. No full-history completeness is claimed.
- The mainnet `create_pool_fee_reveiver::ID` in the pinned official CPMM source is `DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8`; its signature history yielded an actual CPMM `initialize`. Programme ID, successful invocation, discriminator and instruction mint/pool accounts prove pool creation. Requested initial amounts are not silently represented as final reserves.

No paid provider, transaction submission, wallet signing, or infrastructure change was used.
