# Phase 3B registry research

Research checkpoint: 2026-10-25 13:47 UTC. Read-only preparatory research; this document does not mark Phase 3B.3 implemented or released. No database writes, transactions, paid services, or complete historical log scan were performed.

## Result and evidence boundary

The stock-token factory and its UID-to-token lookup were located and read successfully over RPC:

| Item | Robinhood Chain mainnet, chain ID 4663 |
| --- | --- |
| StockFactory proxy | `0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046` |
| StockFactory implementation at the pinned block | `0xEe351E53BCe6AAF106428358838197C91e36EE0E` |
| Shared beacon / AccessControlsRegistry | `0xe10b6f6B275de231345c20D14Ab812db62151b00` |
| Stock implementation at the pinned block | `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2` |
| Stock discovery event | `Deployed(bytes32 indexed uid, address stock, string name, string symbol)` |
| Current canonical-address lookup | `tokenAddress(bytes32 uid) returns (address)` |

The factory exposes a mapping lookup, not an enumerable `count`/`at`/`list` interface. Its deployment-event stream is the identified onchain enumeration path. A separately named, enumerable Robinhood **asset registry** contract remains unlocated; do not invent an address or call the access-controls contract an asset list. A complete factory deployment list and its reconciliation with the official API remain unverified in this checkpoint.

The [official token-contract page](https://docs.robinhood.com/chain/contracts/) describes its table as generated from an onchain registry. Its actual [AssetsTable JavaScript](https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/assets/index-30dX27Ax.js) fetches `https://api.robinhood.com/rhj/assets`, with a 10-second timeout. It does not directly call RPC. Therefore the existing 195-asset snapshot is **official Robinhood REST metadata**, not proof of enumerating an onchain registry. All 195 snapshot entries contain a deployment for chain 4663; this is an API snapshot count, not an onchain total.

## Pinned RPC proof

Provider: `https://robinhood.rpc.pinax.network`, listed in [Robinhood's connection documentation](https://docs.robinhood.com/chain/connecting/).

The existing AMC proof pins block `0x5d1165e` (decimal 97,588,830), hash `0x7b315feda7a037539dc71b4a16b86e60f9588d63bf78666905dba188d0feb7f7`. Follow-up calls below used that same block number. The existing raw block evidence is in `runtime/phase3b-registry/amc-rpc-proof.json`.

| Read | Result |
| --- | --- |
| `eth_chainId` | `0x1237` / 4663 |
| Factory EIP-1967 implementation slot | `0xEe351E53BCe6AAF106428358838197C91e36EE0E` |
| Factory `tokenAddress(AMC_UID)` | `0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B` |
| Factory `beacon()` | `0xe10b6f6B275de231345c20D14Ab812db62151b00` |
| Factory `ACCESS_CONTROLLED_REGISTRY()` | Same shared beacon address |
| AMC `ACCESS_CONTROLLED_REGISTRY()` | Same shared beacon address |
| Beacon `implementation()` | `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2` |
| AMC `uid()` | `0x00000000000000000000000000000000c40c1aabe3514588ae86defffe868021` |
| AMC `decimals()` | 18 |
| AMC `uiMultiplier()` | `1000000000000000000` / 1.0 |
| AMC `paused()` | false |

AMC's symbol/name alone is not an identity check. Its official deployment address, onchain UID, and factory UID lookup agree. This is a verified sample; it does not prove every API row.

The factory implementation runtime is 4,926 bytes, with Keccak-256:

```text
0x3bfd5841605b9931c9dbb0f9f54a28b4038918ceb74d6d1081bc7f963fe528b4
```

The EIP-1967 implementation slot used was:

```text
0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
```

Minimal read ABI:

```solidity
function tokenAddress(bytes32 uid_) external view returns (address);
function beacon() external view returns (address);
function ACCESS_CONTROLLED_REGISTRY() external view returns (address);
event Deployed(bytes32 indexed uid, address stock, string name, string symbol);
```

`tokenAddress` selector is `0x97bb3ce9`; `beacon` is `0x59659e90`; `ACCESS_CONTROLLED_REGISTRY` is `0x50c09be3`. Deployment event topic 0 is:

```text
0xd9b0c6a1c0de228715ad0fa09f3259686ee84f8cc675e03ef7e47a9cdafa76d6
```

For the AMC lookup, calldata is selector `0x97bb3ce9` followed by the 32-byte AMC UID above. The raw result was `0x00000000000000000000000005a3d1cd21d0c88145e82600e62e7e496e0f222b`.

## Source provenance

1. [Envio's stock-indexing guide](https://docs.envio.dev/blog/index-robinhood-chain-data) and its [pinned indexer configuration](https://github.com/enviodev/robinhood-stock-indexer/blob/d4f559ee10a9af98bf2377530dc37ac8f993e7fd/config.yaml) identify this factory and the exact deployment-event ABI. This is Envio's own integration documentation, not an official Robinhood address publication.
2. [Sourcify factory-proxy response](https://sourcify.dev/server/v2/contract/4663/0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046?fields=deployment,compilation,proxyResolution) identifies `contracts/ERC1967Proxy.sol:ERC1967Proxy`, deployment block 7791, transaction `0x13c99b3177ebea63ef48938315adb1159f4dbec804b19ae94c3a2d33f79e131c`, deployer `0x074377a78A9710A1D47244f89797718b4f491279`, and the implementation above. Sourcify's match classification is `match`, rather than `exact_match`. RPC independently confirms the implementation slot.
3. The [pinned StockFactory source mirror](https://github.com/imDev2023/robinhood-chain-resources/blob/85fc4feedd4b17ed17d180795bf253ef9731a5e4/launchpads/hood-fun/contracts/StockFactory-Implementation-RobinhoodStocks-0xEe351E53BCe6AAF106428358838197C91e36EE0E/sources/src/StockFactory.sol) and [mirrored Blockscout source/ABI response](https://raw.githubusercontent.com/imDev2023/robinhood-chain-resources/85fc4feedd4b17ed17d180795bf253ef9731a5e4/launchpads/hood-fun/_raw/blockscout-sc-0xEe351E53BCe6AAF106428358838197C91e36EE0E.json) contain the mapping, getter, event, and full ABI. The mirrored response says `StockFactory`, fully verified, compiler `v0.8.33+commit.64118f21`, verified at `2026-06-15T23:45:17.517256Z`. Its deployed-runtime Keccak-256 **exactly matches the pinned RPC runtime hash** above. This establishes a runtime match to the mirror; direct retrieval of the current Blockscout verification record was blocked, and source recompilation was not performed.
4. [Sourcify AccessControlsRegistry](https://sourcify.dev/server/v2/contract/4663/0xe10b6f6b275de231345c20d14ab812db62151b00?fields=deployment,compilation,sources,abi) returns `exact_match` for `src/AccessControlsRegistry.sol:AccessControlsRegistry`. Deployment block 7662; same deployer. The source implements beacon upgrades, role checks, pause state, and account blocking. It has no token list. This prevents confusion between an access-controls registry and the asset mapping.
5. [Sourcify Stock implementation](https://sourcify.dev/server/v2/contract/4663/0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2?fields=deployment,compilation,sources,abi) returns `exact_match` for `src/Stock.sol:Stock`, deployment block 7784, same deployer. It confirms the 18-decimal ERC-20/scaled-UI contract, `uid()`, and `ACCESS_CONTROLLED_REGISTRY()`. Earlier `registry()`/`assetRegistry()` calls reverted because those getter names are not in this ABI.

## Bounded enumeration check and remaining work

One address-and-topic-filtered `eth_getLogs` sample was executed:

```json
{
  "address": "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046",
  "fromBlock": "0x1e6f",
  "toBlock": "0x457e",
  "topics": ["0xd9b0c6a1c0de228715ad0fa09f3259686ee84f8cc675e03ef7e47a9cdafa76d6"]
}
```

This covers blocks 7791 through 17790 inclusive: exactly 10,000 blocks. Pinax returned HTTP 200 and an empty log array. It demonstrates that this bounded historical request was accepted; it proves neither the absence of later deployments nor a provider-wide range ceiling. No adaptive scan or replay of the remaining history was run.

The concrete onchain discovery design is to replay this factory's `Deployed` events from deployment block 7791 to a pinned finalized block, then maintain a persistent block cursor. Deduplicate by chain, transaction hash, and log index; retain block hashes for reorg handling. Decode UID/address/name/symbol, and verify `tokenAddress(uid)` at the same pinned state before treating the result as canonical. Daily resync should consume new factory events and refresh token metadata/multiplier state; a factory implementation change requires ABI/source review. Event-time names/symbols can become stale because the Stock implementation exposes metadata updates.

Before claiming the Phase 3B.3 registry requirement is complete, implement and verify a complete bounded replay or obtain an appropriately authenticated indexed-history source, reconcile every official API deployment with the factory mapping, and pin/surface the chain block used. The implementation choice and any additional resources belong to the parent task; this report authorizes none.

## Provider limits and access failures

| Surface | Observed/documented constraint |
| --- | --- |
| Robinhood public RPC | Official connection docs say rate limited and unsuitable for production, without a numeric limit on that page. |
| Pinax public RPC used here | Small sequential read calls succeeded, including one 10,000-block filtered log request. Numeric rate/result/history ceilings were not established; no load or maximum-range probe was performed. |
| Robinhood REST APIs | [Official API documentation](https://docs.robinhood.com/chain/stock-token-apis/) specifies 60 requests/second; `/prices/{symbol}` cache 15 seconds, corporate actions cache one hour. No `/assets` cache duration was established here. |
| Blockscout API | The direct smart-contract route returned a Cloudflare challenge page instead of JSON. Do not parse that response as contract metadata. |
| Sourcify | AMC proxy returned no match; factory implementation address returned HTTP 404. Factory proxy, AccessControlsRegistry, and Stock implementation succeeded as described above. |
| IPFS metadata | The factory implementation's runtime embeds CID `QmS42NKFQyfJFc4jPTtRfcxrXt2TSKNmsBwKPJYLFVAPxg`; both `ipfs.io/ipfs/{CID}` and `dweb.link/ipfs/{CID}` returned HTTP 403. CID contents were not recovered directly. |

## Price and canonical-consumer implications

The [official stock-token API documentation](https://docs.robinhood.com/chain/stock-token-apis/) says REST prices are raw underlying-equity bid/ask. Multiply those values by the asset's effective `currentMultiplier` to compare with raw-token-denominated pool prices. The [official building guide](https://docs.robinhood.com/chain/building-with-stock-tokens/) says the onchain Chainlink feed already includes the corporate-action multiplier: **do not apply it again**. `uiMultiplier()` uses 18 fixed-point decimals, and pending multiplier changes have effective times; persist source and timing information rather than treating all price surfaces alike.

The parent implementation should centralize canonical identities used by the eight production quote consumers already identified: engine, onchain pools, Cloudflare collector, providers, market signals, pool analysis, trade simulation, and outcomes. Stock tokens are quote assets, never signal targets; a matching ticker at another address must not become canonical. This research changes no consumer.
