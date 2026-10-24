# Wallet scoring — fase 3

O modo A conserva os filtros e o scanner existentes. O score é manual, determinístico e exclusivamente dry-run. Não representa uma probabilidade de lucro.

## Parâmetros ativos

Fonte: [`config/profiles.yaml`](../config/profiles.yaml), perfil `profile_new`.

| Parâmetro | Valor inicial |
|---|---:|
| Idade do token | 0h ≤ idade <24h |
| Peso das carteiras / segurança / momentum | 50% / 30% / 20% |
| Trades realizados por carteira | Pelo menos 5 |
| PnL líquido realizado | Comprovado e positivo |
| Wallet score mínimo | 70/100 |
| Grupos de compradores independentes | Pelo menos 2 |
| Score final mínimo para alerta dry-run | 75/100 |
| Meia-vida da performance | 30 dias |
| Idade máxima do perfil / compra | 600s / 600s |
| Componentes da carteira: lucro / win rate / entrada precoce / drawdown / holding | 30% / 25% / 20% / 15% / 10% |

Os alvos de escala são 1.000 USD de PnL, win rate 70%, entradas precoces 70%, teto de drawdown 50% e holding de 300 segundos. São hipóteses iniciais para afinação; o relatório não os transforma em parâmetros calibrados.

## Contabilidade e tempo

Uma venda economicamente atribuída por transação/token conta como realização. Compras, transfers e vários logs do mesmo swap não substituem cinco realizações. PnL líquido e custo FIFO usam racionais exatos; a projeção decimal e os valores exatos ficam preservados. Taxas de gas e todos os componentes adicionais têm de estar comprovados.

Cada realização recebe peso `2^(-idade / meia-vida)`. O acumulador avança com `soma_nova = soma_anterior × 2^(-intervalo / meia-vida) + valor_novo`, mantendo somas de PnL, vitórias, holding, entrada precoce e drawdown. O score combina as médias ponderadas e a média dos pesos temporais. Uma venda recente não renova o peso dos lucros antigos. Perdas recentes podem tornar a performance ponderada negativa, mesmo com PnL de vida positivo; nesse caso a carteira não é elegível.

Somente as features de ranking usam floating point, com margem conservadora para erro numérico; o PnL contabilístico mantém-se exato. O drawdown mede a trajetória do património inicial comprovado mais realizações líquidas. Não mede desvalorização de posições abertas. Uma trajetória que não sustenta um drawdown válido permanece desconhecida.

Insider, bundler ou wash trading comprovados excluem a carteira. Risco ou financiamento desconhecidos não equivalem a ausência de risco. Clusters coordenados ligados entre si contam como um grupo, incluindo ligações transitivas. O agregado exige dois grupos comprovadamente independentes.

`firstEntryAt` preserva a primeira compra. `lastEntryAt` identifica a compra canónica mais recente; a validade temporal usa essa data real. Reingerir um recibo antigo não cria uma entrada recente. Dados antigos sem `lastEntryAt` usam conservadoramente `firstEntryAt`.

## Interfaces e persistência

`projectObservedWallets(DB, receipts, options)` conserva a interface anterior e aceita adicionalmente `receiptEvidence`, `walletEvidence` e `replayEvidence`. Retorna `profiles`, `diagnostics` e `realizedEvents`. O collector passa estas provas através da opção interna `walletProofs`; não existe uma rota pública de importação ou de execução de trades.

As provas ligam chain, carteira, recibo, bloco canónico, data e referências. Precisam de cobrir preços históricos, componentes de taxas, histórico contíguo desde o início e inventário inicial. Provas de lançamento, património inicial, risco e clusters suportam as restantes métricas. Um booleano favorável sem o contexto exigido não completa o perfil.

`prepareWalletTemporalUpdates` prepara a projeção temporal; `prepareWalletLedger` persiste eventos e projeções dentro da transação existente, protegida pelo lease. `attachWalletTemporalEvidence` liga a evidência guardada aos perfis antes do score. A migration aditiva `0008` conserva o ledger anterior e acrescenta realizações imutáveis e acumuladores por carteira, geração, método e meia-vida.

Continuidade de `disposalIndex`, PnL cumulativo exato, identidade e geração são verificados. Escritas concorrentes ou sem as realizações correspondentes abortam a transação. Replays idempotentes não duplicam contagens ou PnL. Reorgs abrem uma geração nova e preservam o histórico antigo.

O acumulador não tem teto de trades ao longo da vida; cada lote aceita até 128 realizações novas. Um replay integral aceita até 512 trades e 128 realizações novas. Se ultrapassar o orçamento ou falhar, mantém o estado anterior e exige replay adequado. Backfills maiores precisam de paginação verificada, ainda não fornecida pelo collector atual. Mudar a meia-vida ou o método exige reconstruir a evidência a partir de dados fiáveis; agregados antigos não são promovidos automaticamente.

## Relatório e alertas

A migration `0007` acrescenta faixas de wallet score ao relatório semanal sem substituir o relatório original. Usa o score `READY` guardado na primeira decisão, com bandas 0–49, 50–64, 65–74, 75–84, 85–100 e `UNKNOWN`. Perfis atuais não alteram decisões históricas. O cutoff original é preservado; backfill que altera a coorte é assinalado como `COHORT_CHANGED`.

O painel permite escolher +15m, +1h, +24h ou +7d, mostrando retorno médio de preço e cobertura por token score e wallet score. Zero real e dado ausente são distintos. O relatório inclui rejeitados/mortos e é descritivo: não é PnL executado, backtest ou modelo.

Alertas continuam `[NOVO]`, com contrato, score, três razões, carteiras, flags e gráfico. A outbox apenas guarda a mensagem; não envia Telegram nem executa ordens.

## Dados reais ainda necessários

O collector atual observa pools, transfers e recibos limitados. Não comprova sozinho o histórico integral de cada carteira. Para PnL fiável faltam cobertura contígua, inventário/custo inicial, preços USD históricos ligados ao bloco, todas as taxas e atribuição económica inequívoca. Swaps com ETH nativo ou fluxos ambíguos precisam de prova dos pagamentos líquidos, incluindo `transaction.value`, refunds e traces quando necessários.

Entrada precoce requer lançamento comprovado; drawdown requer património inicial comprovado; elegibilidade requer análise de insiders, wash trading e financiamento/clusters. Sem estas fontes, as métricas continuam `null` e não há qualificação artificial para produzir sinais.

As quotas gratuitas são finitas. O relatório tem limite de 256 KiB e muitas coortes podem excedê-lo; esse limite e backfills maiores devem ser tratados antes de ampliar o universo. X, modo B, backtest/modelo continuam fora desta fase.
