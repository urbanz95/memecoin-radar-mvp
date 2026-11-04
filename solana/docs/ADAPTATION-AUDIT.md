# Auditoria de adaptação — scanner Solana

Data: 2026-11-03. Base auditada: `b3827920450ba93eca066fa30bba3d2d1badcfeb`, branch de referência `fix/phase3b-consolidation-20261025`. Implementação autorizada numa nova branch `feat/solana-realtime-scanner`, worktree independente `/workspace/solana-realtime-scanner`; clone de origem separado em `/workspace/memecoin-radar-source`. Não existe `AGENTS.md` neste repositório.

Esta auditoria precede a implementação Solana. Foram examinados `README.md`, `docs/ARCHITECTURE.md`, `docs/MVP-DATA.md`, `docs/MVP-PROGRESS.md`, `docs/PHASE3B-STATUS.md`, `docs/PHASE3B-CHECKPOINT.json`, `src/engine.mjs`, os módulos de `src/mvp/`, `src/onchain/`, `src/cloudflare/` e a configuração em `config/` (incluindo profiles YAML e JSON compilado). A classificação abaixo distingue código realmente independente de padrões que exigem uma nova implementação.

## Proteção do trabalho existente

O checkpoint 3B indica `3B2_PUBLISHED_3B3_NEXT`, lock `IN_PROGRESS` do proprietário `phase3b-real-proofs-20261025` e produção `7aaa6e1f-fadc-4945-832f-461389805fc4`. SHA-256 original de `docs/PHASE3B-CHECKPOINT.json`: `55e9b0f7a34677ee444ca40dd281e8b8f2f5a470a5e42ea9150062260670e05e`.

A instrução de adquirir `runtime/phase3b-execution.lock` aplica-se à retoma da Fase 3B; esta missão é outro scanner, expressamente isolado. O lock não foi adquirido, removido, atualizado ou usado pelo scanner Solana. Nenhuma migration, binding, base D1, configuração de produção, automação, deploy ou processo Robinhood integra esta alteração. A nova implementação deve permanecer sob `solana/` e não importar o pipeline legado em runtime. A referência e o histórico anteriores são preservados; não haverá merge automático.

## A — Reutilizável sem alterações

| Ficheiro | Comprovação | Decisão |
| --- | --- | --- |
| `src/mvp/feature-codec.mjs` | Só depende de `node:crypto` e `node:zlib`; gzip/base64 com hash, validação UTF-8 e limites de 64 KiB não conhecem rede, token ou carteira. | Elegível para reutilização explícita se forem necessários envelopes comprimidos. A elegibilidade não obriga a importá-lo; JSON/SQLite locais podem dispensá-lo. |

Não se encontrou um motor de scoring, adaptador de carteira ou camada on-chain integralmente agnóstica de EVM. Pequenas funções numéricas e utilitários não justificam importar ficheiros com dependências transitivas da Robinhood.

## B — Reutilizável mediante adaptação explícita

| Origem | Parte aproveitável | Adaptação necessária |
| --- | --- | --- |
| `src/mvp/wallet-exact.mjs`, `wallet-accounting-config.mjs` | Frações BigInt, cancelamento de denominadores e orçamento de precisão. | Extrair/copiar apenas aritmética para `solana/`, com configuração própria; não importar o config de contabilidade do legado. Não implica implementar FIFO/PnL nesta fase. |
| `src/engine.mjs`, `src/mvp/hard-filters.mjs` | Relógio injetável, proveniência, frescura, razões explícitas e evidência ausente mantendo incompletude. | Novo contrato Solana e estados `PASS/REJECTED/INCOMPLETE/UNKNOWN`. Não reutilizar limiares USD, pesos ou aprovação de compra. |
| `src/mvp/records.mjs`, `outcomes.mjs`, `weekly-report.mjs`, `weekly-job.mjs` | Identidades idempotentes, primeiro avistamento distinto de criação, histórico de decisões e tentativas, coortes e cutoff. | Esquema local independente; identidade por mint case-sensitive e signature/instruction/inner index; D1 SQL, chain ID e canonicalidade EVM devem ser substituídos. Outcomes futuros são interface de leitura, não promessa de backtest. |
| `src/onchain/rpc.mjs`, `src/cloudflare/rpc.mjs` | Allowlist read-only, timeouts, limites de resposta, erros sanitizados, orçamento e auditoria. | Novos métodos Solana, envelope/precisão adequados, HTTP e WebSocket, 429 com recuo, concorrência limitada; retirar `eth_*`, hex quantity e block hash EVM. |
| `src/onchain/discovery.mjs` | Cursores só avançam após sucesso, persistência das lacunas e distinção de amostra/histórico completo. | Subscrições por Program ID, recuperação paginada de signatures e checkpoints duráveis por programa; não transplantar `eth_getLogs`/intervalos de blocos. |
| `src/worker/storage.mjs`, `src/worker/service.mjs` | Isolamento do runtime, retenção, persistência transacional/atómica e arranque independente do navegador. | SQLite WAL e lotes com checkpoint na mesma transação, diretório e controlo de escritor próprios. Não partilhar lock nem runtime Robinhood. |
| `src/cloudflare/operations.mjs`, `write-cost.mjs` | Orçamentos conservadores, métricas, erros estruturados, não confundir clock com cobertura. | Contabilizar pedidos RPC, fila, disco e latência do processo Node; quotas de linhas D1/cron não são a métrica Solana. |
| `src/cloudflare/providers.mjs`, `public-report.mjs`, `read-api.mjs`; `public/dashboard.js` | Separação de fonte/data, cache sem renovar artificialmente timestamps, GET de leitura, apresentação de desconhecidos. | Novos mints, endpoints e contrato; não reutilizar URL fixa Robinhood, rewrites de produção nem payload legado. Dashboard legado não é alterado. |
| `src/mvp/wallet-ledger.mjs`, `wallet-runtime.mjs`, `wallet-temporal.mjs`, `wallet-clusters.mjs` | Separar evidência observada de cobertura completa, preservar reversões, interfaces para investigação. | Novo ledger de contas/instruções SPL; remover assumptions ERC-20, aliases de cluster, cadeia 4663 e prova de independência. Apenas interface futura; scoring não ativado. |

A reutilização é de princípios e de algoritmos identificados, não uma declaração de compatibilidade de código EVM. Cada cópia/extracção efetiva deve conservar atribuição no novo módulo e testes próprios.

## C — Específico da EVM: substituir

- `src/network.mjs`, `config/collector.json`: Robinhood 4663/46630, WETH/USDG, factories Uniswap v2/v3/v4 e state view; substituir por genesis Mainnet Solana, Program IDs documentados e mints.
- `src/onchain/abi.mjs`, `decode-pool.mjs`, `pools.mjs`, `reader.mjs`, `collect.mjs`: ABI, keccak topics, ordenação token0/token1, pool key v4, bytecode, `eth_call`, EIP-1967, receipt/contract creation. Solana exige discriminators/IDL, accounts, PDAs, Token Program/Token-2022 e transações versionadas.
- `src/cloudflare/contract-security.mjs`, `holder-analysis.mjs`, `liquidity-protection.mjs`, `age-evidence.mjs`, `pool-analysis.mjs`, `trade-simulation.mjs`, `screening.mjs`: bytecode/Sourcify, storage slots, logs `Transfer`, LP Uniswap, probes Solidity, simulações EVM e finalização sequencer/L1. Nenhuma dessas verificações prova segurança Solana.
- `src/mvp/launch-proofs.mjs`, `wallet-backfill.mjs`, `wallet-evidence.mjs`, `wallet-native-provider.mjs`, `wallet-native-settlement.mjs`: comprovativos ERC-20, `debug_traceTransaction`, ETH nativo/zero address, gas posting Nitro, recibos de 256 bits e transação/bloco EVM. Substituir por dados de execução Solana verificáveis; transferências SPL isoladas não são swaps.
- `src/cloudflare/collector.mjs`, `worker.mjs`: cron/DO/bindings D1 e seleção periódica Robinhood não executam um subscritor persistente Node. Criar serviço próprio.

## D — Dependências e pressupostos incompatíveis

1. `isEvmAddress`, regex `0x`/20 bytes e `.toLowerCase()` aparecem no engine, records, wallet ledger/scoring, gateway e providers. Solana base58 é case-sensitive; normalizar para minúsculas corrompe a identidade. Símbolo nunca é chave.
2. `viem` descodifica ABI EVM e não é um decoder Solana. Não usar nomes de aplicação/token como identificação do programa. Documentação/IDL são referências versionadas, não prova automática do binário ativo.
3. `eth_chainId`, `eth_getLogs`, block number/hash, log index e gas fee/L1 não são equivalentes diretos a genesis hash, slot, signature, instruction indices e `processed/confirmed/finalized`. Um slot pode não ter bloco; históricos RPC podem ser podados.
4. `config/policies.json`, `profiles.yaml` e `profiles.generated.json` exigem explicitamente Robinhood/ERC-20, probes de 100 USD e regras especulativas calibradas manualmente. Importá-los contaminaria Solana com falsos rejeitados/aprovados. Não editar ou recompilar esses profiles.
5. D1 Free já esgotou 100.000 linhas/dia segundo `PHASE3B-STATUS.md`. As atuais cadências de 180–900 s, budgets de 80.000 linhas e cron por minuto são deliberadas para o legado; não podem sustentar um write por transação Solana nem demonstrar baixa latência.
6. Balanços e supply brutos Solana devem permanecer inteiros exatos/string decimal. JSON RPC pode conter números lamport acima de `Number.MAX_SAFE_INTEGER`; converter antes da validação perde prova financeira. Preço USD ausente/expirado fica desconhecido; market cap não é liquidez.
7. `wallet-exact` é genérico na matemática, mas o seu import transitivo lê `config/wallet-accounting.json`. A contabilidade restante requer USD, custos/histórico completos, fees e atribuição que não são fornecidos pela presença de um swap.
8. O dashboard e gateway atuais servem apenas a Robinhood e infraestrutura publicada. A nova API de leitura deve ser separada e não expor métodos para agentes mudarem filtros/permissões.
9. `package.json` legado aceita Node >=22. SQLite nativo de Node tem disponibilidade/flags dependentes da versão; a nova pasta deve declarar/testar o mínimo efetivamente usado e dependências próprias, sem alterar o lockfile legado.

## E — Manter desativado / fora da nova implementação

- Todas as recolhas Robinhood, processos/locks da Fase 3B, migrations e jobs D1, deploy helpers Cloudflare/Vercel e alterações de produção.
- Engine/scoring, perfis e filtros EVM; scores de insiders, bundles, wash trading, PnL, clusters independentes e oportunidades sem cobertura/provas suficientes.
- Telegram (incluindo nova outbox), X, LLMs, estratégias, execução automática, wallets financiadas, private keys, assinatura, transações e operações financeiras.
- Fases 4–6 do legado, shadow/registry da Fase 3B e qualquer merge automático.
- APIs pagas, planos enterprise, upgrades e dependência obrigatória de indexers privados.
- Alegações de suporte completo, segurança total, cobertura integral ou latência garantida. Protocolos sem documentação e transações reais corroboradas conservam `UNVERIFIED`/`NOT_IMPLEMENTED`; mocks de CI não são evidência Mainnet.

## Decisão de implementação

Construir pacote ESM próprio em `solana/`, read-only/Mainnet, com allowlist RPC, subscrições independentes por programa, fila limitada, reconexão, recuperação paginada, SQLite WAL, checkpoints transacionais e API GET. Acrescentar adaptadores por protocolo apenas até onde a evidência de IDL/instrução/contas o permite. Conservar raw amounts e lacunas, distinguir observação de finalização e separar validação determinística de ensaio real. Nenhum módulo legado on-chain, scoring ou operação é importado implicitamente.
