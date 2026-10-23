# Parâmetros iniciais — Robinhood Chain, modo de observação

A política estrita executável é a fonte de verdade para candidatos `CANDIDATE`: [`../config/policies.json`](../config/policies.json). Os alertas de mercado `MARKET_ALERT` têm configuração separada em [`../config/market-signals.json`](../config/market-signals.json), descrita no fim deste documento; não relaxam os requisitos estritos. Todas as percentagens usam unidades 0–100: `5` significa 5%, não 0,05. Todos os montantes estão em USD. FDV não é capitalização circulante; é uma aproximação por supply total e preço que pode estar distorcida.

## Ordem dos pipelines

1. Validar a mainnet 4663, identidade e idade do contrato ERC-20. Um contrato antigo com pool nova continua antigo.
2. Exigir atualidade, proveniência e domínios válidos dos dados.
3. Aplicar exclusões de segurança. Nenhum score ultrapassa um bloqueio.
4. Aplicar filtros de liquidez, dimensão, atividade e preço.
5. Calcular o score apenas quando os filtros anteriores passam.
6. Exigir continuidade do sinal antes de emitir um evento local.

Entre 48h e 7 dias o token fica fora dos dois universos. É uma exclusão intencional nesta política inicial. A partir de 7 dias não existe idade máxima. Tokens estabelecidos exigem também pool com ≥24h. Idade usa o deployment on-chain do contrato do token, não o primeiro anúncio, listing, implementação partilhada ou par visto pelo fornecedor. Uma migração para outro contrato exige ligação explícita ao histórico, não deve ser assumida como continuidade do token.

## Segurança obrigatória

| Filtro | Novos | Estabelecidos |
|---|---:|---:|
| Rede / padrão | Robinhood Chain mainnet 4663 / ERC-20 | Igual |
| Testnet 46630 / outras redes | Excluídas do universo de mercado | Igual |
| Bytecode e código/implementação | Existentes e verificados | Igual |
| Emissão adicional, pause e blacklist | Não permitidos | Igual |
| Whitelist restritiva / confisco de saldos | Não permitidos | Igual |
| Taxas alteráveis / proxy atualizável | Não permitidos | Igual |
| Privilégios ocultos / chamadas externas não verificadas | Não permitidos | Igual |
| Honeypot detetado | Não permitido | Igual |
| DEX, factory, router e pool | Verificados pelo adaptador | Igual |
| Hooks de pools sem análise | Não permitidos | Igual |
| Regras de transferência alteráveis | Não permitidas | Igual |
| Alertas maliciosos conhecidos | Nenhum nos checks consultados | Igual |
| Liquidez removível pelo criador | Não permitida | Igual |
| Taxa adicional de compra / venda do token | 0% / 0% | Igual |
| Volume estimado suspeito | ≤20% | Igual |
| Quote asset | WETH ou USDG, endereços oficiais da mainnet | Igual |
| Sequenciador / reorganização detetada | Saudável / nenhuma na análise | Igual |
| Cabeça da rede | ≤60s de atraso, bloco/hash identificados | Igual |
| Liquidez protegida | ≥95%, evidência on-chain | Igual |
| Proteção admitida | LP queimado ou bloqueio verificável | Igual |
| Prazo restante do bloqueio | ≥7 dias | ≥30 dias |
| Top 1 / top 10 holders | ≤5% / ≤25% | ≤8% / ≤35% |
| Supply do deployer | ≤2% | ≤3% |
| Supply de insiders ligados, incluindo deployer | ≤10% | ≤15% |
| Supply adquirido em bundles | ≤10% | ≤15% |
| Variação de liquidez | ≥−10% em 5m | ≥−10% em 1h |
| Simulação de ida e volta | Compra e venda bem sucedidas | Igual |
| Valor da simulação | US$100 | Igual |
| Impacto de preço por lado | ≤2% compra e ≤2% venda | Igual |
| Perda total da ida e volta | ≤8%, com custos | Igual |

O limite de taxas do token não elimina taxas da pool, custos de gas em ETH ou slippage; estes entram no custo da ida e volta. O simulador tem de testar a saída da quantidade obtida na entrada. Uma cotação ou uma venda antiga por outra carteira não prova a vendabilidade atual. A cobertura do LP deve considerar as pools relevantes e o tipo de AMM; um selo de fornecedor não basta. LP queimado satisfaz o requisito de prazo sem timestamp de desbloqueio. Bloqueio parcial, desconhecido ou de mecanismo não suportado não passa.

Renunciar ao `owner` não demonstra ausência de roles, proxy admin, módulos externos ou backdoors. A análise exige seguir a implementação, permissões indiretas e lógica de transferências. Código verificado significa correspondência entre código e bytecode; não significa auditoria ou segurança garantida. CLMM, NFTs de posições e pools com hooks exigem métodos específicos de prova de liquidez e executabilidade.

Os endereços canónicos estão em `src/network.mjs`, com referências à [configuração da rede](https://docs.robinhood.com/chain/connecting/) e aos [contratos oficiais](https://docs.robinhood.com/chain/contracts/). USDC/USDT, endereços de Ethereum/Arbitrum ou tokens com o mesmo símbolo não são automaticamente aceites na Robinhood Chain. Os limiares de liquidez, concentração e momentum continuam hipóteses de triagem: ainda não foram calibrados nesta rede.

As concentrações excluem apenas carteiras de pools e burn verificadas. Carteiras de equipa, vesting, tesouraria e endereços ligados contam como concentração. A exclusão de carteiras de exchanges exige análise adicional; nesta versão não deve ser usada para melhorar artificialmente o score. Não é possível identificar todos os insiders ou todo o wash trading: as métricas são estimativas, com metodologia e cobertura registadas na proveniência.

## Qualidade dos dados

| Grupo | Idade máxima do dado |
|---|---:|
| Estado da rede e timestamp da cabeça | 60s |
| Mercado e atividade | 120s |
| Holders | 300s |
| Segurança e proteção da liquidez | 600s |
| Simulação de compra/venda | 60s |

São limites de idade da **observação efetiva**, não da última chamada HTTP. Uma API que devolve um valor antigo não o torna recente. Tolerância a relógio futuro: 30s. Cada grupo exige timestamp UTC, fonte e referências de evidência. Reavaliações críticas devem ser atómicas por snapshot; o adaptador deve usar o mesmo universo de pools, quote asset, janela e preço USD. Campos desconhecidos não viram zero nem `false`.

Falhas conhecidas de segurança têm precedência e produzem `BLOCKED`, mesmo que também faltem dados. Sem falha de segurança conhecida, dados ausentes, inválidos, expirados ou incoerentes produzem `INCOMPLETE`. Não se calcula score nestes casos.

## Filtros de potencial

| Métrica | Novos | Estabelecidos |
|---|---:|---:|
| Liquidez mínima | US$50 mil | US$150 mil |
| FDV mínimo–máximo | US$100 mil–10 milhões | US$500 mil–100 milhões |
| FDV / liquidez | ≤80 | ≤100 |
| Holders | ≥200 | ≥1000 |
| Volume mínimo | ≥US$5 mil em 5m | ≥US$100 mil em 24h |
| Traders únicos | ≥30 em 5m | ≥150 em 1h |
| Participação orgânica estimada | ≥70% | ≥75% |
| Crescimento líquido de holders | ≥1% em 5m | ≥3% em 24h |
| Aceleração de volume | ≥1,2x, 5m / 5m anteriores | ≥1,5x, 1h / média horária das 23h anteriores |
| Fluxo líquido comprador / liquidez | ≥1% em 5m | ≥2% em 1h |
| Volume / liquidez | ≤3x em 5m | ≤5x em 1h |
| Variação de preço curta | −5% a +20% em 5m | −5% a +25% em 1h |
| Variação de preço em 24h | Não usada | −15% a +60% |
| Distância ao VWAP de 1h | Não usada | −3% a +12% |
| Queda face ao máximo de 7 dias | Não usada | ≤70% |

Os limites de subida evitam selecionar apenas uma vela já muito esticada; os de queda evitam classificar uma queda contínua como recuperação sem confirmação. Volume alto sem traders, holders ou fluxo líquido não basta. Publicidade paga, trending, boosts e seguidores não entram no score inicial, por serem facilmente manipuláveis.

Fórmulas derivadas:

```text
FDV/liquidez = fdvUsd / liquidityUsd
aceleração5m = volume5m / volume5m_anterior
aceleração1h = volume1h / ((volume24h - volume1h) / 23)
fluxoLíquido% = 100 × (volumeCompras - volumeVendas) / liquidityUsd
rotação = volumeDaJanela / liquidityUsd
```

As janelas são completas e contíguas. Baseline nulo ou sem histórico dá `INCOMPLETE`, não aceleração infinita. Compras e vendas devem somar o volume da mesma janela, com tolerância de arredondamento de 1% ou US$1. Uma rota multi-hop conta uma vez por trade do token, evitando duplicar volume entre hops.

## Score de 0 a 100

Cada métrica contribui `peso × clamp((valor − piso)/(alvo − piso), 0, 1)`. A contribuição satura no alvo. O score é calculado após todos os filtros; os valores dos filtros não são um score mínimo garantido. A comparação com 75 usa o valor sem arredondamento.

| Novos | Peso | Piso → alvo |
|---|---:|---|
| Liquidez | 15 | US$50 mil → US$250 mil |
| Crescimento de holders em 5m | 20 | 1% → 8% |
| Traders únicos em 5m | 20 | 30 → 200 |
| Aceleração de volume de 5m | 15 | 1,2x → 3x |
| Fluxo líquido / liquidez de 5m | 20 | 1% → 8% |
| Variação de preço em 5m | 10 | 0% → 10% |

| Estabelecidos | Peso | Piso → alvo |
|---|---:|---|
| Liquidez | 20 | US$150 mil → US$1 milhão |
| Crescimento de holders em 24h | 20 | 3% → 15% |
| Traders únicos em 1h | 15 | 150 → 1000 |
| Aceleração de volume de 1h | 20 | 1,5x → 4x |
| Fluxo líquido / liquidez de 1h | 15 | 2% → 12% |
| Variação de preço em 1h | 10 | 0% → 15% |

São pesos heurísticos. Liquidez, volume e traders estão correlacionados, pelo que o score não deve ser interpretado como seis evidências independentes. Antes de aprovar nova política, comparar a melhoria com filtros simples de liquidez/idade e com a política anterior.

## Confirmação e estados

| Estado | Significado |
|---|---|
| `OUT_OF_SCOPE` | Idade fora do universo do pipeline |
| `BLOCKED` | Pelo menos uma exclusão de segurança conhecida |
| `INCOMPLETE` | Falta evidência válida, consistente ou recente |
| `WATCH` | Segurança sem bloqueio conhecido, mas filtros ou score insuficientes |
| `CONFIRMING` | Score ≥75 e filtros válidos; falta continuidade |
| `CANDIDATE` | Requisitos e confirmação satisfeitos; candidato a análise |

Novos: pelo menos 3 observações distintas ao longo de 120s, intervalo máximo de 180s entre observações novas. Estabelecidos: pelo menos 2 ao longo de 900s, intervalo máximo de 660s; à cadência de 300s serão normalmente necessárias 4 observações (0, 5, 10 e 15 minutos). O timestamp do mercado e o número do bloco observado têm de avançar para incrementar a contagem. Repetir o mesmo JSON ou trocar apenas o timestamp sem avanço da cadeia não confirma. Recuo de bloco ou hash diferente para a mesma altura invalida a sequência. `checkedAt` só pode avançar quando existe uma observação efetivamente nova.

A continuidade do sinal é diferente da finalização da rede. `chainState.finalityStage` usa `sequencer`, `posted` ou `finalized`, correspondendo às etapas descritas na [documentação oficial](https://docs.robinhood.com/chain/transaction-finality/). O modo de observação admite soft confirmations do sequenciador e publica a etapa na avaliação. Dois minutos de confirmação de um sinal não provam publicação ou finalização em Ethereum. Nenhuma etapa autoriza ordens nesta base.

Qualquer falha de qualidade, segurança, elegibilidade ou score reinicia a sequência. Uma alteração na configuração também reinicia, através do hash da política. No scanner CLI, a ausência do token no lote seguinte remove o seu estado. O collector incremental conserva, durante a rotação, confirmações de outros contratos ainda dentro do prazo e do mesmo hash de política, com limite de 128 estados; uma reorganização reinicia essa continuidade. Um evento de candidato é emitido na transição para `CANDIDATE`, não em todas as reavaliações. Após perder e recuperar os critérios pode existir novo evento. Antispam por utilizador e cooldown do Telegram serão uma camada posterior.

Cada análise inclui os valores usados, filtros, motivos, score por métrica, versão/hash da política e hora de avaliação. Se a recolha parar, nenhum relatório anterior deve ser tratado como sinal atual: revalidar TTLs e estado do worker antes de o apresentar ou notificar.

## Parâmetros dos alertas de mercado

Esta avaliação usa `config/market-signals.json` (`market-alerts-v1`) e produz **`MARKET_ALERT` com `tradeApproved: false`**. É um pré-sinal de atividade para revisão, separado do score e das exclusões obrigatórias de `CANDIDATE`. Os valores são hipóteses iniciais sem backtest. Auditoria de código, insiders, proteção de posições e simulação continuam por comprovar quando a respetiva evidência falta; não são aprovados por um alerta de mercado.

| Critério do alerta | Novos | Estabelecidos |
|---|---:|---:|
| Idade comprovada | 15 minutos–48 horas | ≥7 dias |
| Liquidez mínima reportada | US$50 mil | US$150 mil |
| FDV reportado | US$100 mil–10 milhões | US$500 mil–100 milhões |
| Volume mínimo reportado | US$5 mil em 5m | US$100 mil em 24h |
| Transações reportadas | ≥30 em 5m | ≥150 em 1h |
| Compras / total de transações | ≥60% em 5m | ≥60% em 1h |
| Aceleração de volume | ≥1,2x, 5m / média de 5m nos 55m anteriores | ≥1,5x, 1h / média horária das 23h anteriores |
| Variação de preço | −5% a +20% em 5m | −5% a +25% em 1h |
| Score mínimo do alerta | 75/100 | 75/100 |
| Confirmação mínima | 3 observações em ≥120s | 2 observações em ≥900s |
| Intervalo máximo entre observações | 150s | 660s |

As contagens `txns.buys` e `txns.sells` representam **transações reportadas, não traders únicos**, holders ou atividade orgânica. Aceleração dos novos usa `(volume1h − volume5m) / 11` como baseline; difere da comparação com os cinco minutos imediatamente anteriores da política estrita. Baseline ausente, nulo ou incoerente mantém `WAITING_DATA`.

O score do alerta soma `35 × clamp(liquidez/alvo, 0, 1) + 40 × clamp(volume/alvo, 0, 1) + 25 × clamp(variação/alvo, 0, 1)`, arredondado a uma casa decimal. Os alvos são US$250 mil de liquidez, US$25 mil de volume 5m e +10% em 5m para novos; US$750 mil, US$500 mil de volume 24h e +15% em 1h para estabelecidos. Este score é independente do score estrito e não mede a probabilidade de subida.

A idade pode usar criação exata ou limites de existência de bytecode que comprovem todo o intervalo exigido, conservando a origem da prova. A identidade exige mainnet 4663, token base exato e par/quote identificados. WETH e USDG usam os endereços oficiais; ETH nativo só é admitido no contexto v4, pela moeda zero e ID de pool de 32 bytes. Não se trata essa moeda como ERC-20 nem se altera a allowlist da política estrita.

O mercado expira após **120 segundos**; a observação nativa do contrato, após **600 segundos**; a tolerância futura é de 30 segundos. Novas leituras do mesmo cache não incrementam a confirmação: a data da fonte deve avançar, com a mesma origem, par e moeda de cotação. Mudança de política, interrupção excessiva ou falha dos critérios reinicia o alerta. O estado é limitado a 128 confirmações.

| Estado do alerta | Significado |
|---|---|
| `WAITING_DATA` | Falta identidade ou métrica necessária válida |
| `OUT_OF_SCOPE` | A idade comprovada não pertence aos grupos |
| `NO_SETUP` | Os dados existem mas filtros ou score não passam |
| `CONFIRMING` | Filtros e score passam; falta continuidade |
| `MARKET_ALERT` | Atividade confirmada; segurança pendente, sem aprovação de operação |
| `STALE` | Mercado, observação ou cabeça perdeu atualidade |
| `BLOCKED` | Existe risco observado; o painel oculta o token |

`/latest` publica estes alertas em `signals.marketAlerts` e os candidatos estritos em `signals.tradeCandidates`. `marketSignalsAvailable` e `currentSignalsAvailable` indicam respetivamente a existência de resultados atuais em cada lista. A cada leitura a API volta a verificar expirações e cabeça nativa (máximo 60 segundos); uma recolha bem-sucedida não mantém um alerta antigo válido. Ambas as listas podem estar vazias sem alterar os limiares para produzir resultados.
