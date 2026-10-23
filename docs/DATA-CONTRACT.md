# Contrato de entrada v2 — Robinhood Chain

O input da CLI é um array JSON de snapshots. Ver [`../examples/snapshots.json`](../examples/snapshots.json) e o construtor [`../examples/fixtures.mjs`](../examples/fixtures.mjs). Os exemplos são sintéticos, com relógio fixo: a CLI real rejeita-os por expiração. Usar `npm run demo` para reproduzir a demonstração.

`npm run collect` produz snapshots reais parciais e avalia-os diretamente. Estes não satisfazem necessariamente todos os campos abaixo: lacunas são registadas em `collection.gaps` e impedem a aprovação. O bundle atual é `runtime/onchain/latest.json`; o array de entrada separado encontra-se em `runs/<runId>.snapshots.json`. Ver [o collector e a evidência RPC](ONCHAIN.md).

O motor verifica tipos e coerência dos campos usados por cada pipeline. Não autentica fontes nem consulta a cadeia. Só um produtor controlado deve escrever o input e o estado. Não expor a CLI como uma API pública que confia em números enviados pelo visitante.

## Envelope

| Campo | Tipo / definição |
|---|---|
| `schemaVersion` | Número inteiro, exatamente `2`; v1 é rejeitada |
| `synthetic` | Booleano obrigatório; `true` em fixtures/demos |
| `chain` | Exatamente `robinhood` |
| `chainId` | Número inteiro, exatamente `4663` |
| `environment` | Exatamente `mainnet`; testnet `46630` não é admitida nesta política |
| `address` | Endereço EVM de 20 bytes (`0x` + 40 hex), diferente de zero; normalizado para minúsculas |
| `symbol` | Texto de apresentação opcional, não usado nos filtros |
| `contractCreatedAt` | Timestamp real do deployment do token, UTC ISO 8601; também cobrir deployments internos por factories |
| `chainState`, `security`, `holders`, `market`, `activity`, `liquidityProtection`, `quote` | Grupos descritos abaixo |

A identidade inclui chain ID, ambiente e endereço normalizado. Diferentes capitalizações do mesmo endereço não são tokens distintos. O motor valida o formato e não o checksum EIP-55; a existência do contrato é uma evidência separada de bytecode. Um endereço da Ethereum mainnet não identifica automaticamente o mesmo ativo na Robinhood Chain.

Todos os grupos exigem `checkedAt`, `source` e `evidence`:

```json
{
  "checkedAt": "2026-10-19T12:00:00.000Z",
  "source": "nome-do-fornecedor/metodo-versao",
  "evidence": ["referencia-para-payload-arquivado-ou-transacao-ou-slot"]
}
```

`checkedAt` é a hora efetiva dos dados. `source` identifica o fornecedor e método de obtenção; `evidence` é um array não vazio de referências para permitir auditoria. A versão atual verifica a presença destas referências; resolver e verificar a autenticidade é responsabilidade do adaptador. Nunca pôr API keys, tokens ou URLs com credenciais nestes campos.

Todos os números devem ser finitos, sem strings numéricas. Valores negativos só são admitidos para variações; contagens de holders/traders são inteiros não negativos. Percentagens de concentração, taxas, cobertura, organicidade, volume suspeito, impacto, perda e drawdown pertencem ao intervalo 0–100. Crescimento e variações de preço/liquidez podem exceder 100%, mas não ser inferiores a −100%. Não usar `null`, `0`, `false` ou timestamp atual como substituto de um dado desconhecido.

## Estado da cadeia

`chainState` exige também metadados de fonte, referências e `checkedAt`, com TTL de 60s. Campos:

- `rpcChainId`: resultado de `eth_chainId`, convertido de hex para inteiro pelo adaptador; tem de ser `4663`.
- `sequencerHealthy`: booleano, sustentado por observações da rede; não pode ser inferido apenas por uma resposta HTTP 200.
- `reorgDetected`: booleano sobre os blocos/pools observados. Em caso de reorganização, descartar avaliações dependentes, reconstruir o histórico canónico e reiniciar continuidade.
- `headTimestamp`: timestamp UTC da cabeça efetivamente observada da cadeia; atraso máximo de 60s. Não substituir pela hora em que uma chamada HTTP terminou.
- `blockNumber`, `blockHash`: altura inteira não negativa e hash não nulo de 32 bytes do bloco observado, obtidos por RPC. Referências para a coerência de mercado/simulações e para a continuidade.
- `finalityStage`: `sequencer`, `posted` ou `finalized`. Identifica a confirmação pelo sequenciador, publicação do batch em Ethereum ou finalização em Ethereum. A etapa tem de ser apurada para o bloco em causa; um receipt isolado não demonstra finalização em L1.

A política de observação admite as três etapas e inclui a etapa na saída. A confirmação do score ao longo do tempo não converte uma soft confirmation em finalização. O motor não consulta RPC nem verifica estas declarações por si mesmo; essa verificação cabe ao adaptador de confiança. [Rede](https://docs.robinhood.com/chain/connecting/) e [finalização](https://docs.robinhood.com/chain/transaction-finality/) na documentação oficial.

## Segurança ERC-20

Campos de `security`:

- `tokenStandard`: `erc20`, após analisar interface e comportamento; o nome/símbolo não bastam.
- `hasBytecode`, `contractVerified`: booleanos que têm de ser `true`. Verificar correspondência de código/bytecode do token e de implementações delegadas relevantes. “Verificado” não é sinónimo de auditado.
- `canMint`, `canPause`, `canBlacklist`, `whitelistOnly`, `canChangeFees`, `canConfiscate`: booleanos que têm de ser `false`. Analisar permissões de todas as roles e caminhos indiretos, não apenas o `owner`.
- `proxyUpgradeable`, `hiddenPrivileges`, `untrustedTransferCalls`, `honeypotDetected`, `mutableTransferRules`: booleanos que têm de ser `false`. Excluir upgrades por proxy/beacon/admin, privilégios indiretos e dependências de transferências não verificadas. Clones imutáveis exigem seguir a implementação e provar que é imutável e verificável.
- `knownMalicious`: booleano. `false` significa que os checks configurados não encontraram um alerta conhecido; não significa prova de ausência de fraude. Fonte indisponível produz dado em falta.
- `liquidityRemovableByCreator`: booleano resultante da análise das posições LP, contratos de lock, permissões e mecanismos de retirada.
- `buyTaxPct`, `sellTaxPct`: taxas adicionais do token, distintas das taxas da pool/gas. Não inferir 0 pela ausência de um campo, por uma lista de “renounced tokens” ou por uma simulação de outro endereço.
- `suspiciousVolumePct`: percentagem do volume classificado como suspeito, na janela de 5m para novos e 1h para estabelecidos. A metodologia e a cobertura têm de estar registadas em `source`/`evidence`.

## Holders

Campos de `holders`: `count`, `top1Pct`, `top10Pct`, `deployerPct`, `linkedInsidersPct`, `bundledSupplyPct`.

Percentagens relativas à supply efetiva: `totalSupply()` atual menos saldos de endereços comprovadamente irrecuperáveis ainda incluídos nesse total. Burns que já reduziram `totalSupply()` não são subtraídos novamente. Não usar FDV, número de transações ou percentagem de LP como denominador. Excluir apenas contas de pools e burn verificadas da classificação de holders. A metodologia de denominador tem de ser constante ao longo do histórico. `top10Pct` é a soma dos 10 maiores holders elegíveis; `top1Pct ≤ top10Pct`. `linkedInsidersPct` inclui o deployer e as suas carteiras relacionadas: `deployerPct ≤ linkedInsidersPct`. Percentagens de bundles e insiders podem sobrepor-se; não somar automaticamente.

Descobrir ligações exige histórico de funding, transferências e comportamento, com heurísticas versionadas. Carteiras separadas não são prova de independência. `bundledSupplyPct` mede supply adquirido por grupos coordenados no lançamento, de acordo com um método EVM documentado; não copiar uma métrica de bundles de outra rede sem método equivalente. Transações próximas no mesmo bloco, isoladamente, não provam coordenação. Se o fornecedor não disponibilizar a métrica ou a análise for inconclusiva, o token fica `INCOMPLETE`; não atribuir 0%.

## Mercado

Campos partilhados de `market`:

- `quoteAsset`: `WETH` ou `USDG`. `quoteAssetAddress` é obrigatório e tem de corresponder ao endereço canónico da Robinhood Chain registado em `src/network.mjs`, a partir dos [contratos oficiais](https://docs.robinhood.com/chain/contracts/). Não usar endereços homónimos de outras redes.
- `dexVerified`: booleano que tem de ser `true`, com prova da identidade e bytecode de factory, router, pool e posições LP. O motor exige a declaração; não mantém ainda um registry de DEX on-chain.
- `hasUnreviewedHooks`: booleano que tem de ser `false`. Hooks de transferências/pools e fees dinâmicas exigem análise específica. Não assumir que todas as pools de uma DEX partilham o mesmo risco.
- `liquidityUsd`: TVL verificável das pools relevantes, sem duplicação e com conversão USD consistente. Não confundir FDV com liquidez. A profundidade executável é testada adicionalmente na simulação de US$100.
- `fdvUsd`: supply total × preço USD. Evitar preços de pools irrelevantes/manipuladas.
- `oldestPoolCreatedAt`: criação da pool mais antiga conhecida do token, com cobertura descrita; pool selecionada ou primeiro listing não é equivalente.

O preço de WETH deve ser convertido para USD por fonte verificável e atual. USDG também precisa de preço observado: não assumir que vale sempre US$1. Identidade canónica não elimina depeg, risco de bridge ou privilégios do emissor do quote asset. Os controlos `canMint`/`canBlacklist` do alvo são controlos sobre a memecoin, não uma declaração de que os quote assets não têm privilégios. A integração real deve monitorizar estes riscos antes de publicar sinais.

Para novos: `liquidityChange5mPct`, `priceChange5mPct`.

Para estabelecidos: `liquidityChange1hPct`, `priceChange1hPct`, `priceChange24hPct`, `distanceToVwap1hPct`, `drawdownFrom7dHighPct`.

`distanceToVwap1hPct = 100 × (preçoAtual / VWAP1h − 1)`. `drawdownFrom7dHighPct = 100 × (1 − preçoAtual / máximo7d)`; requer 7 dias completos de histórico, com máximo e preço do mesmo universo de pools e unidade. O adaptador não deve misturar quote USD e SOL sem conversão de cada observação.

## Atividade

Partilhado: `organicTraderPct`, estimativa de percentagem de participantes não sinalizados como bots/wash trading, com modelo identificado.

Para novos:

- `volume5mUsd`, `previous5mVolumeUsd`: últimos 5m completos e os 5m imediatamente anteriores, sem sobreposição.
- `uniqueTraders5m`: participantes únicos; preferir agrupamento por entidade quando disponível. Nunca substituir por contagem de buys/sells.
- `holderGrowth5mPct`: `100 × (holdersAgora / holdersHá5m − 1)`, baseline positivo e mesma definição de holder.
- `buyVolume5mUsd`, `sellVolume5mUsd`: volume comprador e vendedor da mesma janela/pools de `volume5mUsd`.

Para estabelecidos:

- `volume1hUsd`, `volume24hUsd`: última hora completa e últimas 24h; a hora está incluída nas 24h. Exige histórico integral; o baseline das 23h anteriores tem de ser positivo.
- `uniqueTraders1h`, `holderGrowth24hPct`, `buyVolume1hUsd`, `sellVolume1hUsd`: definições análogas nas respetivas janelas.

Volume deve ser contabilizado do ponto de vista do token alvo. Uma compra tem um comprador e vendedor económicos, mas não pode contar simultaneamente como buy e sell do token na soma de volume. Uma rota com várias pools não duplica o mesmo trade.

## Proteção da liquidez

`liquidityProtection`: `verified` (booleano), `mechanism` (`burned` ou `locked`), `coveragePct` e `unlockAt` (obrigatório para `locked`, UTC ISO 8601, data futura permitida).

`coveragePct` representa a percentagem da liquidez relevante efetivamente protegida, valorizada pelo mesmo método de `market.liquidityUsd`. Não aceitar a percentagem anunciada pelo criador, nem a percentagem de um único LP que representa uma fração pequena do mercado. O adaptador tem de verificar propriedade, contratos/programas de lock, prazos, beneficiários, caminhos de retirada e cobertura de todas as pools relevantes.

Em CLMM, posições NFT e liquidez fora do intervalo exigem análise específica. Em pools com hooks, a análise inclui o hook e as suas permissões. Se o adaptador não conseguir provar a proteção no tipo de pool utilizado, não normalizar como `verified: true`. O motor não interpreta contratos LP; confia na evidência produzida pelo adaptador.

## Simulação

`quote`: `amountUsd`, `buySucceeded`, `sellSucceeded`, `buyImpactPct`, `sellImpactPct`, `roundTripLossPct`.

Os US$100 são um **montante de teste**, não uma recomendação de posição. Simular compra e venda da quantidade recebida na mesma sessão e com alterações de estado encadeadas, incluindo taxas da pool, slippage, gas em ETH convertido para USD e custos adicionais aplicáveis. Duas chamadas `eth_call` isoladas não demonstram uma ida e volta: a venda tem de receber o saldo e allowances resultantes da compra. Usar simulação com estado/fork e rotas verificadas na Robinhood Chain. Testar transferências e venda com identidades não privilegiadas; não usar uma carteira incluída numa whitelist do criador. Não assinar nem transmitir swaps para este projeto.

## Saída e estado

`results` contém avaliações independentes por contrato/pipeline, com rede/chain ID/ambiente, etapa de finalização, estado, score, filtros e motivos. `score=null` quando segurança/dados/elegibilidade impedem o cálculo. `dataMode=synthetic` identifica exemplos; qualquer outro input é `unverified-input`, nunca automaticamente “live verificado”.

`evidenceExpiresAt` é a primeira expiração entre os grupos de dados e o timestamp da cabeça da cadeia. É um teto para a validade da evidência, não garantia de que as condições se mantêm até lá. O consumidor deve reavaliar a política e locks e verificar saúde do worker. O relatório de erro tem `operationalStatus=ERROR`, `results=[]`, `alerts=[]` e estado vazio.

`state` guarda continuidade por `pipeline:chain:chainId:environment:addressNormalizado` e hash da política, com timestamp de mercado e último bloco/hash contados. A contagem exige avanço de mercado e de bloco; recuos e mudanças de hash na mesma altura invalidam a sequência. É estado interno de confiança, não um campo aceite de um cliente público. Os eventos `alerts` têm ID estável para a transição atual; serão usados para deduplicação e uma outbox persistente quando existir envio para Telegram. Alterações à rede, aos quote assets canónicos ou à política alteram o hash e reiniciam continuidade.
