# Verificação dos dados e outcomes — 24/10/2026

Esta entrega conclui a verificação que antecede a continuação da fase 3. As alterações seguintes de wallet scoring ficaram em espera a pedido do utilizador. A auditoria e os pipelines existentes foram preservados; não foram implementadas fases posteriores.

## Testes e execução

- Branch criado a partir de `5386059`: `feat/phase3-wallet-outcome-quality`.
- Baseline existente: **471 testes passaram**, sem falhas.
- Após as correções: **480 testes passaram**, sem falhas.
- Integração de outcomes/collector: 56 testes passaram antes da observabilidade adicional; a suite final inclui os testes do provider.
- Três ciclos no runtime workerd concluíram com 15/14/14 pedidos RPC e HTTP 200 em `/latest`.
- Collector publicado: `de1b4cdf-1c3b-4555-9805-33efae951a45`, cron `* * * * *`, dry-run mantido.
- O primeiro push foi verificado em [urbanz95/memecoin-radar-mvp](https://github.com/urbanz95/memecoin-radar-mvp): `main` conserva `5386059` e as correções seguem no branch de continuação. A visibilidade consultada após o push era pública; não foi alterada pelo agente.

## Gravação real confirmada

Consulta D1 após a recolha das **00:25:30 UTC**:

| Medida | Resultado |
|---|---:|
| Tokens distintos guardados | 1.743 |
| Tokens distintos avaliados | 62 |
| Tokens distintos com primeira decisão rejeitada/bloqueada | 54 |
| Tokens explicitamente classificados como `DEAD` | 0 |
| Outcomes +15m com preço e liquidez | 24 |
| Outcomes +1h com preço e liquidez | 7 |
| Outcomes +24h | 0 — ainda não devidos nesta data/hora |
| Outcomes +7d | 0 — ainda não devidos nesta data/hora |
| Novas observações de mercado arquivadas | 2 |

Estas contagens são um snapshot, não valores fixos. Zero classificações `DEAD` não demonstra ausência de tokens mortos: tokens sem mercado continuam guardados e os valores ausentes continuam desconhecidos. Versões e perfis diferentes podem ter outcomes do mesmo token; **31 outcomes não significam 31 lançamentos rotulados**.

A execução `abc99362-ee43-4882-87f0-94681913f5c5` completou três jobs de +15m do token `0xb141e93aae58b309b5510d478067b21991610deb`, um por perfil/versão compatível. A consulta às linhas imutáveis confirmou preço **0,0001944 USD**, liquidez **97.029,03 USD**, timestamp de fonte **00:25:30.192 UTC**, recolha **00:25:30.458 UTC** e atraso face ao horizonte de **64.358 ms**. O total aumentou de 28 para 31. Não se usou preço atual para preencher uma data histórica.

O browser confirmou depois duas recolhas automáticas, sem reload ou clique: 1.747 → 1.748 tokens, 197 decisões e 31 outcomes. Os contadores apresentados coincidiram com a resposta da mesma recolha; `/health` e `/latest` responderam HTTP 200 com `no-store`, o JavaScript público correspondeu ao local, e seis tokens bloqueados ficaram ocultos. Quatro wallets acompanhadas continuaram com zero elegíveis e PnL por comprovar. Não houve erros de página/API; o pedido implícito a `/favicon.ico` recebeu 404, sem impacto no fluxo de dados.

## Correções

1. A fila deixa de colocar janelas expiradas à frente de capturas ainda possíveis. Seleciona até quatro tokens distintos, com fanout até 24 jobs das suas versões/perfis.
2. Jobs expirados procuram observações históricas reais; não consomem pedidos de preços atuais. Pontos com timestamp fora da janela não completam o job.
3. Observações novas e válidas são arquivadas de forma imutável, com identidade, fonte e timestamp originais, na mesma transação protegida pelo lease.
4. Retries permanecem até um minuto enquanto a janela está aberta; após expirar, o backoff chega efetivamente a 24h. Não se apagam jobs nem tokens.
5. O diagnóstico de mercado distingue fonte futura, expirada e válida, incluindo a diferença temporal. A validação temporal estrita foi mantida. Houve respostas `STALE_SOURCE` durante a verificação; a execução comprovada recebeu `FRESH`, com idade de fonte de 95 ms.

## Proteção da base de dados

Migration incremental `0006_mvp_outcome_capture.sql`, aplicada após registar o ponto integral D1 Time Travel `0000001c-0000020c-0000510e-8caabb5f496a3c93edbf2b78620c8713`.

SHA256 da migration aplicada: `d1e4ad743c92acc0e479b59cdc253a40623fafc20dc4b3dba9a13caac0349d14`. A existência da tabela e dos índices foi confirmada remotamente. O ponto de recuperação tem retenção de sete dias; não equivale a um export SQL offline.

## Pendente para continuar a fase 3

- Ligar provas verificadas de histórico, inventário/custo inicial, preços históricos em USD, todas as taxas e atribuição económica ao runtime de wallets. O adaptador atual conserva explicitamente os valores desconhecidos.
- Ponderar a performance por realização, com acumulação temporal incremental. O método atual aplica decaimento ao agregado de vida pela última realização; uma venda recente não deve renovar lucros antigos.
- Preservar a primeira entrada quando a carteira volta a comprar o mesmo token.
- Acrescentar faixas de **wallet score no momento da decisão** ao relatório semanal, mantendo os relatórios e cortes temporais anteriores imutáveis.
- Para drawdown e entrada precoce fiáveis faltam, respetivamente, património inicial comprovado e prova de lançamento. Para elegibilidade faltam também provas de insiders, wash trading e financiamento/clustering; desconhecido não conta como independente.

Não há PnL real comprovado, wallets elegíveis ou alertas acionáveis demonstrados por esta verificação. O Telegram continua exclusivamente em dry-run.

## Riscos conhecidos

- Uma janela perdida sem observação histórica válida continua desconhecida/retry; o arquivo novo não recupera preços nunca recolhidos.
- Um cron com intervalo nominal de um minuto pode chegar antes do fim do cooldown e saltar um pedido ao provider. Os timestamps originais e a cobertura efetiva ficam visíveis; não há garantia de ingestão em segundos.
- A leitura de candidatos cresce com o backlog, embora os pedidos externos e as escritas por execução estejam limitados. Armazenamento e APIs gratuitos mantêm quotas finitas.
- A cobertura continua limitada às venues e aos eventos que o scanner existente consegue observar; não é um índice completo da chain nem do histórico de cada carteira.

As provas detalhadas, sem credenciais, estão em `runtime/phase3-continuation/` no workspace. Essa pasta não é versionada.
