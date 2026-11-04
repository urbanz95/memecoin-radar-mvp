# Real Mainnet fixtures

These are public Solana RPC responses, captured on 2026-11-03 using `getTransaction` with JSON encoding, finalized commitment and `maxSupportedTransactionVersion:1`. Programme account and Global captures use `getMultipleAccounts` / `getAccountInfo`, base64. No credentials. `MANIFEST.json` records request source, signature, slot, version and SHA256. Fixture replay is deterministic testing, separate from live network validation.

| Fixture | Transaction signature | Slot |
|---|---|---|
| pump-buy-v2-routed-mainnet.json | q1z6bxZDNCsUP5oUrkvzBszWcBoSauYtuVxCW1wQ1gUeSj91ySjVxfcQkhpwYr5fAqhjZFtTmPSi9Y2aZiJG3vr | 465054514 |
| pump-buy-v3-mainnet.json | 4Y7Nn5eMCR9yJqj39mPdSDedQwqz5EcMJfnW3rkkAESwXKx1VuSsrVAK4QsaV4mG6XRcN2e8d88TuzGcqBiEaoin | 465054514 |
| pump-create-v2-mainnet.json | 3AA8zQopS8zdoTycQvFG2FLfND7fGqcMKJj3aJPgU5Ug33z8y19meYqVLxUu9q6WW9hVokeRWeUjdteakFsFJVUk | 465054161 |
| pump-graduation-mainnet.json | 3K91vqn7iW2AgVyUccdd18TLQJzwyxQ6kfRYRtYtp4RpFb37m4hxEjgSJkFDDBxEr9c4Ta6FNM829uAEiPTqRf8V | 465057017 |
| pump-migrate-v2-pumpswap-create-mainnet.json | 4prYVbxEX3SeE93kjHCMRdBxBWcQsR5VcsAEua8kRoV8yrNNwWM8bmfuFpKPoF8UoqjN5agD8FERKDQsaConT2Xq | 465057019 |
| pump-sell-v3-routed-mainnet.json | 3nNC9GvBBfybfWoRkfHTE4kpysMaXznbZTM8cN4d93DXHK25VAjYTeeaBenSim39V8r9xSTbygxtrmZX6yGKkeYR | 465054514 |
| pumpswap-buy-routed-mainnet.json | 4v3b9MHun8Lok351xm4MvEzdss58UcaHrkyhBpTJGTR4RoLDPV86CTAYDvetL1JFBR9ZuC1CMM6p5JmSscfGG6W2 | 465055407 |
| pumpswap-buy-sol-mainnet.json | 2oqvzWNGph5x9GHhJn3bu7Rq9WFK4qEroizzj3QD39huqadhkVy5mTsEJPrAadctpRcLZic1HrpxDmssbVV4iygu | 465055407 |
| pumpswap-sell-routed-mainnet.json | YWsLvTtP5vTd62YRAZZw9kybkvaAUDCzmLgzfzEARFSDWpE3uVjEpy5VPqGQmjButbXF1MKc8qtvKcf2ajUi5Fp | 465055407 |
| raydium-cpmm-create-mainnet.json | 231YHQy5y5fdZZRz5bKDzq9UJAbfW8M3QCUgvvMoHWAFgd5m1smWvnboaTPBs8CeJud74DJD5x6tdPinLqB9ogrA | 465056117 |
| raydium-cpmm-mention-only-mainnet.json | GeoA3Y4hm37c1fdConGFYEWCiVYkEFcVwzCZATFzX18PkGDokkS8P5AhRY4Miwrc8tZwEn1GtoVa6wBpgQQ7KLm | 465054563 |
| raydium-cpmm-swap-mainnet.json | 3wpa9wDyPS3phmoYp81jRPz9LgmDog8YFpfE7DiiixewYqjzUUiF2efNzWQRzyhoCZjoX182GeCUyi3TRLrQNvLq | 465054562 |
| raydium-launchlab-buy-mainnet.json | 5MpcGaRiHvPLbm4fQ2aZP2J1v58SnSxcyppfbAArCDSAXckxzTFQiE6LQjNQ62Kgwpy9AbKPJwW6BQNyGHnU3Kka | 465054459 |
| raydium-launchlab-create-mainnet.json | 2zBbpPcotCmBxGQdVzFmPNYif2yc1nyQbRDCeSETgWmDo7E1MJpXiWc1QN4rrsccXtufyuKWg1aFhxBXhZoE4bvq | 465043700 |

Reproduce: POST a JSON-RPC `getTransaction` request to a Mainnet RPC with params `[SIGNATURE,{"encoding":"json","maxSupportedTransactionVersion":1,"commitment":"finalized"}]`. Provider historical retention can prevent future retrieval.

The Pump graduation and migration captures prove the same mint in adjacent lifecycle stages. They include actual PumpSwap pool creation. The CPMM creation fixture proves successful initialize from the official binary discriminator and accounts; its token creator is unknown. See `RAYDIUM-PROVENANCE.md` and `../docs/PROTOCOL-COVERAGE.md` for semantics, discovery sources, 429 errors and protocol boundaries. Synthetic lifecycle inputs still exist only inside clearly labelled tests.
