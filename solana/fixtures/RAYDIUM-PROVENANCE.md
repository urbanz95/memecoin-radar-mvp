# Raydium Mainnet evidence

Captured read-only on 2026-11-03 through `https://api.mainnet-beta.solana.com`,
`commitment=finalized`, `encoding=json`, `maxSupportedTransactionVersion=1`.
The JSON files retain the actual RPC envelopes, signatures, balances and logs.
They are real snapshots, not production latency measurements.

| File | Signature / slot | Evidence |
| --- | --- | --- |
| `raydium-launchlab-create-mainnet.json` | `2zBbpPcotCmBxGQdVzFmPNYif2yc1nyQbRDCeSETgWmDo7E1MJpXiWc1QN4rrsccXtufyuKWg1aFhxBXhZoE4bvq` / 465043700 | Routed InitializeV2, PoolCreateEvent, mint creation, creator and first BuyExactIn; two distinct instruction locations |
| `raydium-launchlab-buy-mainnet.json` | `5MpcGaRiHvPLbm4fQ2aZP2J1v58SnSxcyppfbAArCDSAXckxzTFQiE6LQjNQ62Kgwpy9AbKPJwW6BQNyGHnU3Kka` / 465054459 | Routed BuyExactIn, event self CPI and log duplicate |
| `raydium-cpmm-swap-mainnet.json` | `3wpa9wDyPS3phmoYp81jRPz9LgmDog8YFpfE7DiiixewYqjzUUiF2efNzWQRzyhoCZjoX182GeCUyi3TRLrQNvLq` / 465054562 | Routed swap, SwapEvent log, actual mint pair and raw amounts |
| `raydium-cpmm-mention-only-mainnet.json` | `GeoA3Y4hm37c1fdConGFYEWCiVYkEFcVwzCZATFzX18PkGDokkS8P5AhRY4Miwrc8tZwEn1GtoVa6wBpgQQ7KLm` / RPC slot in file | Program address mentioned, but no actual CPMM invocation; must produce no swap |
| `raydium-program-accounts-mainnet.json` | context slot 465055143 | Both declared program IDs are executable, owned by BPFLoaderUpgradeab1e11111111111111111111111 |

Mainnet program IDs:

- LaunchLab: `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`.
- CPMM: `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`.

Pinned IDLs: official [raydium-io/raydium-idl](https://github.com/raydium-io/raydium-idl/tree/e7e0c96fe77bcf6a020b84a44c47a722aac8e359),
metadata version 0.2.0/spec 0.1.0. Exact vendored SHA256:

- `raydium_launchpad.json`: `963189409945069409f32e345d4adf2892e0b3ca1be504372577fe34a23c6cdb`.
- `raydium_cpmm.json`: `1202f6dc8e1c3216598f2ad5c620b9aa8c64ac584563fafed68125c27fb6df81`.

CPMM source checked at [3d69122790e97cd6aff24e8ba95940793773f58c](https://github.com/raydium-io/raydium-cp-swap/tree/3d69122790e97cd6aff24e8ba95940793773f58c),
including `programs/cp-swap/src/lib.rs` and `states/events.rs`: deposit change_type=0,
withdraw change_type=1; swap event amounts exclude transfer fees as documented.
The program executable account proof does not prove reproducible binary equivalence
with this source or prevent a later upgrade. Source pin and live decoder compatibility
are recorded separately.

Reproduce a transaction capture without credentials:

```sh
curl https://api.mainnet-beta.solana.com -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getTransaction","params":["3wpa9wDyPS3phmoYp81jRPz9LgmDog8YFpfE7DiiixewYqjzUUiF2efNzWQRzyhoCZjoX182GeCUyi3TRLrQNvLq",{"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":1}]}'
```

Discovery consumed 14 RPC calls for this research: three program signature lists,
seven transaction fetches (one failed with -32015 because version 1 was initially
not permitted), one executable account read, two pool history lists and one
creation transaction fetch. No 429 was observed in these bounded reads. The
LaunchLab pool list had 493 signatures and reached creation; the CPMM pool list
hit the 1000 limit, so its creation was not recovered. These calls are research
costs, separate from scanner operational metrics.

LaunchLab `real_base_after` is curve accounting for tokens sold, as illustrated
by the first buy: it starts at zero and becomes the amount sold. It is exposed
as `reserves.soldTokenRaw`; `real_quote_after` is `raisedQuoteRaw`. Neither is
asserted to equal current vault inventory. Virtual parameters have meaning that
depends on curve type. Graduation is reported only for the explicit `Migrate`
pool status; migration is a separate successful instruction.

Validated on Mainnet snapshots: LaunchLab InitializeV2/BuyExactIn and CPMM swap.
Implemented but Mainnet UNVERIFIED: LaunchLab sells/other initialize variants,
graduation/migration, CPMM initialize/deposit/withdraw. Deterministic tests for
these branches do not establish live support. CPMM pairs without exactly one
recognised quote (WSOL or USDC) do not get an invented buy/sell direction.

Additional bounded validation by the protocol lead subsequently proved CPMM
`initialize` on Mainnet: fixture `raydium-cpmm-create-mainnet.json`, signature
`231YHQy5y5fdZZRz5bKDzq9UJAbfW8M3QCUgvvMoHWAFgd5m1smWvnboaTPBs8CeJud74DJD5x6tdPinLqB9ogrA`,
slot 465056117. It was discovered through the official mainnet creation-fee
receiver `DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8` from the pinned CPMM source.
Its actual successful initialise discriminator and account roles establish the
new pool and mint pair; token creator and final vault reserves remain unknown.
Thus the earlier UNVERIFIED statement for ordinary CPMM initialize is superseded
by this fixture. Permissioned initialise and liquidity transitions remain
UNVERIFIED Mainnet. Additional RPC consumption and 429 failures are documented
in `../docs/PROTOCOL-COVERAGE.md` separately from the initial Raydium research.
