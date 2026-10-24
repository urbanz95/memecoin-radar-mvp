# Progresso do MVP

## Atualização 25/10/2026 — Fase 3B em curso

O estado operacional correto é **MVP parcial**, conforme a [auditoria](AUDIT-2026-10-24.md). A consolidação atual trata A01/A02/A05–A09; o [relatório 3B](PHASE3B-STATUS.md) distingue código, publicação e provas reais. A01 foi diagnosticado por logs e analytics: quota diária de escritas D1 esgotada, com o cron ainda ativo. O monitor externo já foi publicado isoladamente em `main` pelo [PR #1](https://github.com/urbanz95/memecoin-radar-mvp/pull/1) e abriu a [issue #2](https://github.com/urbanz95/memecoin-radar-mvp/issues/2).

Provas reais (3B-2) e novos pares/cotações (3B-3) só começam depois de testes aprovados e seis horas de estabilidade observada. A janela de 30 dias, ETH nativo reconciliado, censo/registry e shadow de novos tiers ainda faltam. O [pedido completo](PHASE3B-SPEC.md) fica registado para continuidade. Fases 4–6 apenas com `AVANÇA FASE N`.

Âmbito autorizado: concluir as fases **1, 2 e 3** e parar para apresentar o estado. O projeto mantém `dryRun: true`, sem carteira, ordens ou operações financeiras. Fases posteriores exigem nova confirmação.

| Fase | Entrega | Estado |
|---|---|---|
| 1 | Auditoria, testes de compatibilidade e arquivo de dados/outcomes | Concluída: código, migration e gravação remota confirmados; mercado recuperado e verificado na fase 2 |
| 2 | Filtros duros e alertas Telegram em dry-run, modo A <24h | Concluída e verificada em produção; outbox vazia, sem inventar score de wallets |
| 3 | Score de wallets e relatório semanal por faixa de score | Implementação e publicação concluídas em 24/10: ponderação por realização, provas/replay e duas dimensões do relatório. PnL real ainda desconhecido sem as fontes necessárias |
| 4 | Integração X | Fora desta execução; exige confirmação |
| 5 | Novo modo B ≥2.880h, com ENTRY/EXIT | Fora desta execução; exige confirmação |
| 6 | Backtest e modelo | Fora desta execução; exige confirmação e pelo menos 300 lançamentos completos elegíveis |

## Fase 1

Foram acrescentados YAML validado e compilado, tabelas `mvp_*` aditivas, avistamentos, decisões iniciais imutáveis, eventos posteriores e jobs de outcomes em 15m, 1h, 24h e 7d. A gravação conserva resultados rejeitados ou sem mercado; não seleciona apenas sobreviventes ou aprovados. O limite de evidência continua explícito e uma falha não é preenchida com zero.

A versão Cloudflare `755f82fe-6322-4c30-a549-6483549bbcd6` foi publicada com 100% do tráfego. O cron natural de **23/10/2026 às 13:58:25 UTC**, run `e2ad96cb-13e5-4ba6-aec7-90fa376940ef`, confirmou `mvp.recording: true`: 12 tokens, 17 avistamentos, duas decisões, seis eventos, oito jobs pendentes e zero outcomes completos.

O gateway `/api/market` está publicado na Vercel Hobby e respondeu HTTP 200. Isto não demonstra mercado recuperado no collector: a origem ainda foi assinalada como `STALE_SOURCE`, em investigação. A causa foi corrigida no commit `5c877b0`, comparando a data da fonte com o relógio após receber a resposta. A recuperação do mercado ficou comprovada na fase 2 abaixo; detalhes em [OPERATIONS.md](OPERATIONS.md). Ver [auditoria e proteção dos dados](MVP-AUDIT.md) e [contrato de dados](MVP-DATA.md).

## Fase 2

O commit `b5b255d` acrescenta filtros duros do modo A **0h ≤ idade <24h**, sem alterar as janelas das políticas antigas, e uma outbox Telegram exclusivamente `DRY_RUN`. Um risco conhecido produz `REJECTED`; prova ausente, parcial ou expirada produz `INCOMPLETE`. O filtro duro só produz `PASS` com a evidência completa. Isso, isoladamente, não completa o score de wallets nem autoriza um alerta.

A outbox exige decisão global `PASS`, score ≥75, flags de completude de score/segurança/wallets e wallets elegíveis com pelo menos cinco trades realizados. A mensagem inclui três motivos, carteiras, flags e gráfico validado. Deduplica por decisão/versão/episódio/destino e guarda pré-visualizações imutáveis, sem token, chat ID, leitura de ambiente ou código de envio Telegram. Histórico de wallets em falta mantém `score: null`, `walletsComplete: false` e nenhum alerta.

Verificação: **397 testes passaram**, mais um ensaio final focado de 33 testes de filtros/pipeline; validação de configuração, profiles e build passaram. `0003_mvp_outbox.sql` foi aplicada após um novo ponto D1 Time Travel, registado em `runtime/backups/pre-phase2-manifest.json`; continua sem export SQL offline.

A versão Cloudflare `181f2942-ec57-4a7b-b1a2-c9aeaa876810` foi comprovada pelo cron natural das **17:59:23 UTC de 23/10/2026**, run `feb162b4-7cb7-4910-abf4-87928c9f05a9`: `mvp.phase: 2`, 695 tokens, 1.221 avistamentos, 85 decisões, 702 eventos de decisão, 27 outcomes completos, 197 jobs pendentes e 116 em retry. O mercado devolveu HTTP 200, `REFRESHED`, três contratos atualizados entre nove pedidos. A outbox ficou em zero, coerente com o histórico de wallets ainda em falta. A evidência está em `runtime/mvp-phase2/production.json`; não comprova disponibilidade contínua nem sinais de compra.

## Configuração preparada

[`config/profiles.yaml`](../config/profiles.yaml) separa os perfis novos das políticas antigas:

| Perfil | Estado | Idade | Pesos | Outros limites |
|---|---|---|---|---|
| `profile_new` | Filtros, outbox e score manual implementados e publicados | 0h ≤ idade <24h | wallets 50%, segurança 30%, momentum 20% | ≥5 vendas realizadas por wallet; wallet score ≥70; ≥2 grupos independentes; score global ≥75 |
| `profile_existing` | Desativado | ≥2.880 **horas**, ou 120 dias | wallet flow 40%, trend 30%, liquidez/segurança 20%, X 10% | Reservado às fases futuras |

Editar o YAML exige `npm run profiles:compile`; `npm run profiles:check` deteta JSON compilado desatualizado. A validação rejeita chaves desconhecidas, pesos inválidos, aliases e alterações que ativem fases futuras.

## Fase 3 — implementação e verificação final

O código acrescenta ledger de eventos/intervalos/recibos, contabilidade FIFO incremental, score manual de wallets, momentum com duas observações e relatório semanal por score band. As migrations `0004_mvp_wallets.sql` e `0005_mvp_weekly.sql` foram aplicadas após backup Time Travel. A suite completa passou 470 testes; após as correções finais passaram os 17 testes de codec/records, cinco verificações do codec no workerd e 40 testes do collector. A publicação foi comprovada com duas recolhas naturais no browser. Evidência em [OPERATIONS.md](OPERATIONS.md); implementação disponível não equivale a dados reais completos.

No segundo run, às **23:33:25 UTC de 23/10/2026**, havia 1.577 tokens arquivados, 174 decisões e 28 outcomes completos. O mercado estava `REFRESHED` HTTP 200; a outbox e as wallets elegíveis ficaram em zero. O relatório semanal foi gerado com zero decisões na coorte histórica já maturada, sem fabricar resultados. Os tokens visíveis passaram de um para zero quando o último foi bloqueado, e a página ocultou os seis bloqueados automaticamente.

A contabilidade usa montantes decimais/racionais exatos, custos FIFO e taxas comprovadas; guarda estado incremental limitado a 16 KiB e indica necessidade de replay quando não pode continuar de forma fiável. Uma venda atribuída por transação/token conta como um trade realizado; compras, transferências e swaps repetidos não substituem cinco vendas realizadas e atribuídas.

O score de wallet exige PnL realizado líquido positivo, histórico/custos/taxas/atribuição/clusters completos, ≥5 trades realizados e score manual ≥70. Componentes: lucro 30%, win rate 25%, entrada cedo 20%, drawdown 15%, tempo de posição 10%, com meia-vida temporal de 30 dias. Grupos coordenados contam uma vez e são necessários dois grupos comprovadamente independentes. Insider, bundler ou wash trading comprovados excluem a wallet; falta de prova continua `INCOMPLETE`.

O score do token mantém wallets 50%, segurança 30% e momentum 20%, sem redistribuir pesos de componentes desconhecidos. Momentum exige crescimento real de holders e liquidez, na mesma pool, com blocos e datas de fonte que avancem; reler cache não fabrica crescimento. Um cenário sintético completo pode chegar a `PASS` e gerar uma única pré-visualização dry-run; isso é teste de fluxo, não sinal real.

O relatório semanal é descritivo: bandas 0–49, 50–64, 65–74, 75–84 e 85–100, mais `UNKNOWN`, com retornos de preço armazenados e cobertura por horizonte. Corre segunda-feira às 00:15 UTC sobre a coorte que começou duas semanas antes, com catch-up na mesma semana. Conserva rejeitados/mortos, separa versões/perfis e não converte outcomes ausentes em zero. Não é backtest, PnL executado ou modelo.

## Dados reais ainda em falta

A recolha limitada de pools e transfers não comprova o histórico integral, custos e taxas em USD, atribuição económica ou financiamento/clustering de cada wallet. Por isso, o adaptador de produção conserva PnL desconhecido e perfis inelegíveis até haver prova suficiente; não cria aliases de cluster ou métricas favoráveis para produzir alertas. O cron continua de **60 em 60 segundos**, não em segundos individuais, reutilizando os módulos de pool/holders existentes.

Outcomes de sete dias não podem estar completos no primeiro dia de recolha. O gate de 300 exige lançamentos únicos com baseline positivo e os quatro outcomes completos, na mesma versão/perfil; não é a contagem de tokens vistos. X, novo modo B, backtest/modelo e operações continuam desativados. Em 24/10 o utilizador criou [memecoin-radar-mvp](https://github.com/urbanz95/memecoin-radar-mvp), e o primeiro push foi concluído.

## Continuação — verificação de 24/10/2026

Foi corrigida e validada a prioridade das capturas de outcomes, acrescentando arquivo imutável de observações e recuperação por timestamps originais. Passaram 480 testes; a base real confirmou 31 outcomes completos, incluindo três novos de +15m. Os horizontes +24h/+7d ainda não eram devidos. As alterações seguintes da fase 3 ficaram em espera até fechar esta verificação, conforme o pedido mais recente. Estado detalhado, pendências e riscos: [relatório da verificação](MVP-VERIFICATION-2026-10-24.md).

## Fase 3 — continuação concluída em 24/10/2026

No branch `feat/phase3-wallet-scoring`, o commit `3f6a199` conclui a contabilidade/runtime com provas tipadas, realizações exatas, score por realização e preservação da compra original. A frescura do sinal usa a última compra canónica, não a hora de reingerir o recibo. A meia-vida continua em 30 dias, com pelo menos cinco realizações, wallet score ≥70, dois grupos independentes e score global ≥75 nos pesos 50/30/20. Interfaces anteriores e outbox dry-run preservadas.

O relatório semanal ganhou faixas de wallet score à data da primeira decisão, além das faixas de token score, preservando versões, cutoff e desconhecidos. O painel apresenta os quatro horizontes e a cobertura. Passaram **511 testes**, cinco cenários DOM, três ciclos workerd com **15/14/14 RPC** e um ensaio com RPC real usando **28 pedidos**.

As migrations incrementais `0007`/`0008` foram aplicadas após novo ponto integral D1 Time Travel. Cloudflare `a38fe3b8-143b-4838-bf81-13295a4242a3` e Vercel Hobby `dpl_93GrwTCGXChKNNJoFnAaYXwXBY5Z` publicados. Duas recolhas naturais verificaram 3.432 → 3.434 tokens, 400 → 401 decisões e 194 outcomes; contadores, relatório e bloqueados coincidiram entre API e painel, sem reload ou clique.

A consulta D1 confirmou 130 tokens distintos avaliados, incluindo 108 com primeira decisão rejeitada/bloqueada; zero classificações explícitas `DEAD` não prova ausência de mortos. Os 194 outcomes repartiam-se por 111 de +15m e 83 de +1h. +24h/+7d ainda não tinham chegado à primeira data devida. A extensão semanal tem uma linha e conserva a coorte histórica ainda vazia.

Continuam **111 carteiras acompanhadas e zero elegíveis/PnL comprovado**. As lacunas reais guardadas incluem 107 liquidações em moeda nativa por reconciliar e quatro casos sem fluxos económicos opostos comprovados. O collector atual não fornece histórico integral, todos os preços/taxas históricos e provas de funding/clusters; o adaptador aceita essas provas sem as assumir. As tabelas de realizações reconciliadas e resumos temporais continuam vazias em produção, conforme esperado na ausência desses dados. Não se fabricaram perfis para gerar alertas.

Parâmetros, interfaces, limites de replay e riscos: [WALLET-SCORING.md](WALLET-SCORING.md). Esta entrega para na fase 3; fases 4–6 não foram iniciadas.
