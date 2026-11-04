# Segurança SPL/Token-2022 e proveniência

`src/security.mjs` lê contas mint por `getAccountInfo`, com `encoding: base64` e compromisso `confirmed`. É uma inspeção do estado atual observado; não é uma auditoria do token, uma autorização de trade ou prova de que a liquidez não pode ser retirada. O módulo não lê chaves, não assina e não envia transações.

O decoder verifica o proprietário da conta pelos Program IDs exatos:

| Programa | Program ID |
| --- | --- |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |

A base mint de 82 bytes inclui `COption<Pubkey>` para mint/freeze authority, supply `u64` little endian, decimals e initialized. Supply é descodificado diretamente do buffer para BigInt e serializado como string decimal. Não é reconstruído a partir de `uiAmount`, símbolos, saldos lamport ou números JSON arredondados. Nas mints Token-2022 extensíveis, os bytes 82–164 são padding zero, byte 165 é `AccountType::Mint = 1`, e TLVs começam em 166. Contas de tamanho multisig, proprietários desconhecidos, opções inválidas, TLVs duplicados/truncados e extensões exclusivas de contas SPL são rejeitados como layouts inválidos.

As decisões usam `SOLANA_BASELINE_CONSERVATIVE_V1`. `REJECTED` significa que uma capacidade/restrição conhecida viola esta política inicial, não prova de fraude. Mint/freeze authority presentes, transfer fees ativos ou alteráveis, transfer hook ativo/alterável, permanent delegate, non-transferable, default frozen, pausable e permissioned burn com autoridade geram rejeição conservadora. A configuração das duas épocas de transfer fees é reportada integralmente; não se assume qual é a época atual nem se calcula uma taxa efetiva sem essa informação.

`PASS` num controlo individual significa apenas que a condição observada passou esse controlo. O resultado global permanece `INCOMPLETE` quando não há risco conhecido: distribuição por proprietário, histórico de autoridades e proteção/liquidez continuam sem prova suficiente. `UNKNOWN` representa conta ou leitura ausente/inválida. Extensões desconhecidas, confidential transfer/mint/fees, interest-bearing, scaled UI e layouts não interpretados ficam `INCOMPLETE`; a falta de interpretação nunca se torna ausência de risco. `securityConclusion` permanece `null` e `tradeApproved` é sempre `false`.

`getTokenLargestAccounts` é opcional. Devolve uma amostra de até vinte **contas de token**, não vinte proprietários distintos nem um censo de holders. Conta supply e amostra podem vir de slots diferentes; ambos os contextos ficam reportados. Não são publicados percentuais de concentração por holder com este dado parcial. O scanner não infere insiders, bundles, wash trading ou independência de carteiras.

## Fontes oficiais verificadas

Layouts e discriminantes foram consultados no repositório oficial [solana-program/token-2022](https://github.com/solana-program/token-2022/tree/c5d2c28cf997ac880b43ad091c92a794186c4a11), revisão fixa `c5d2c28cf997ac880b43ad091c92a794186c4a11`, em 2026-11-03. Não se presume que qualquer extensão futura já seja interpretada. Os nomes/tipos conhecidos incluem `TransferFeeConfig=1`, `PermanentDelegate=12`, `TransferHook=14`, `Pausable=26`, `PermissionedBurn=28`.

SHA-256 dos ficheiros oficiais consultados:

| Caminho nessa revisão | SHA-256 |
| --- | --- |
| `interface/src/state.rs` | `4566daf8b06ff2e7b975bed3e631ef4ab9591a95ddabd4117300ca1f639a59d2` |
| `interface/src/extension/mod.rs` | `d273a87617b06f4a813a2c3c3bbab8180a0a4c657d836a95475259eca9e40f5a` |
| `interface/src/extension/transfer_fee/mod.rs` | `2f51ac04733271b7578f0fb8c05805aac237f1521ffa1505b4055c03b6cbda5c` |
| `interface/src/extension/transfer_hook/mod.rs` | `23245c8a47f09adaf4803a6ffca8d6dfc9da1e4c87741b33338efedd07d90e3e` |
| `interface/src/extension/permanent_delegate.rs` | `2b6e8554448539d2c8bdb456080f24455e6011b50938612f26470afe59a49ee0` |
| `interface/src/extension/pausable/mod.rs` | `ec2d0b938dc296c73c27bbf98b9b1ca7c71124c76cc3a2e9740cdf7093c2d708` |
| `interface/src/extension/permissioned_burn/mod.rs` | `7ecbf5d694e90d48c4e3c1f1eeb0bf31081cf9a12fb43e5f8186177ca5b58f62` |

## Snapshot real Mainnet

[`../fixtures/security-mainnet-sol.json`](../fixtures/security-mainnet-sol.json) contém os bytes originais da resposta RPC pública `https://api.mainnet-beta.solana.com` a:

```json
{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["So11111111111111111111111111111111111111112",{"encoding":"base64","commitment":"confirmed"}]}
```

Foi capturada em 2026-11-03 às 21:48:14 UTC, depois de verificar o genesis Mainnet `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`. A resposta apresenta slot `465055449` e versão RPC `4.4.0`. SHA-256 do ficheiro, sem reformatação: `b2bf5c0cbc4d30ca305f358b2faddae24d31e67d2e65a6c77d7937387f79684a`.

A conta descodificou com proprietário SPL Token, decimals 9, initialized true, mint/freeze authority null e supply bruto `0`. O hash SHA-256 dos 82 bytes base64 descodificados é `b0f919425a529f4971ef8dabd535aec34947d5c8c4885df80dae91635b98c5f3`. Trata-se da mint nativa especial de wrapped SOL; esse supply não mede o SOL existente nem serve como exemplo de distribuição de um token comum. O `rentEpoch` numérico no envelope excede a precisão de Number: o teste preserva o ficheiro original por hash e ignora esse metadado financeiro irrelevante para o unpack da mint.

Esta prova é um snapshot de conta, não uma fixture de transação e por isso não tem transaction signature. Não comprova criação, ausência de risco, alterações históricas de autoridades ou comportamento real de extensões Token-2022.

## Testes e limites

`node --test test/security-market.test.mjs test/api.test.mjs` executa replay offline do snapshot real e cenários determinísticos claramente sintéticos: `u64` máximo, mint/freeze authority, fees/hook/delegate/pausable/permissioned burn, TLVs desconhecidos/inválidos, amostra incompleta de holders, somas e preços racionais exatos, cinco janelas, deduplicação, reversões, timestamps ausentes/futuros e identidade por mint apesar de símbolos duplicados.

Os testes das extensões de risco usam buffers construídos a partir dos layouts oficiais; não foram obtidas mints reais com cada extensão de risco nesta entrega. Os testes HTTP da API usam apenas loopback e dados sintéticos. Nenhum destes ensaios determina latência de produção. Histórico de alterações de autoridade, auditoria de transfer hooks, censo de proprietários, lock/proteção da liquidez e prova de completude financeira permanecem pendentes.
