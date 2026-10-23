# Progresso do MVP

Âmbito autorizado: concluir as fases **1, 2 e 3** e parar para apresentar o estado. O projeto mantém `dryRun: true`, sem carteira, ordens ou operações financeiras. Fases posteriores exigem nova confirmação.

| Fase | Entrega | Estado |
|---|---|---|
| 1 | Auditoria, testes de compatibilidade e arquivo de dados/outcomes | Concluída: código, migration e gravação remota confirmados; mercado recuperado e verificado na fase 2 |
| 2 | Filtros duros e alertas Telegram em dry-run, modo A <24h | Concluída e verificada em produção; outbox vazia, sem inventar score de wallets |
| 3 | Score de wallets e relatório semanal por faixa de score | Em implementação; ainda sem validação de conclusão. Parar e apresentar estado após concluir |
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
| `profile_new` | Filtros duros e outbox implementados; score de wallets da fase 3 pendente | 0h ≤ idade <24h | wallets 50%, segurança 30%, momentum 20% | ≥5 trades por wallet; score ≥75 |
| `profile_existing` | Desativado | ≥2.880 **horas**, ou 120 dias | wallet flow 40%, trend 30%, liquidez/segurança 20%, X 10% | Reservado às fases futuras |

Editar o YAML exige `npm run profiles:compile`; `npm run profiles:check` deteta JSON compilado desatualizado. A validação rejeita chaves desconhecidas, pesos inválidos, aliases e alterações que ativem fases futuras.

## Dados ainda necessários para wallets

A fase 3 terá de provar PnL realizado, win rate, pelo menos cinco trades, tempo médio de posição, entradas cedo/tarde, drawdown e decaimento temporal. Excluir insiders, bundlers ou wash trading exige prova; clusters coordenados devem contar como uma unidade. Histórico insuficiente ou PnL desconhecido não pode receber um valor favorável por omissão. A fase 2 ainda não fornece estas métricas; não as substitui por zero ou por contagens de transações do fornecedor.

Outcomes de sete dias não podem estar completos no primeiro dia de recolha. A regra de 300 lançamentos é apenas uma condição de dados para avaliação futura; não ativa backtest, modelo, novo modo B ou operações.
