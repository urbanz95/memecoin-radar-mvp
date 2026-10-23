# Progresso do MVP

Âmbito autorizado: concluir as fases **1, 2 e 3** e parar para apresentar o estado. O projeto mantém `dryRun: true`, sem carteira, ordens ou operações financeiras. Fases posteriores exigem nova confirmação.

| Fase | Entrega | Estado |
|---|---|---|
| 1 | Auditoria, testes de compatibilidade e arquivo de dados/outcomes | Concluída: código, migration e gravação remota confirmados; atualização do mercado ainda em investigação (`STALE_SOURCE`) |
| 2 | Filtros duros e alertas Telegram em dry-run, modo A <24h | Por implementar |
| 3 | Score de wallets e relatório semanal por faixa de score | Por implementar; parar e apresentar estado após concluir |
| 4 | Integração X | Fora desta execução; exige confirmação |
| 5 | Novo modo B ≥2.880h, com ENTRY/EXIT | Fora desta execução; exige confirmação |
| 6 | Backtest e modelo | Fora desta execução; exige confirmação e pelo menos 300 lançamentos completos elegíveis |

## Fase 1

Foram acrescentados YAML validado e compilado, tabelas `mvp_*` aditivas, avistamentos, decisões iniciais imutáveis, eventos posteriores e jobs de outcomes em 15m, 1h, 24h e 7d. A gravação conserva resultados rejeitados ou sem mercado; não seleciona apenas sobreviventes ou aprovados. O limite de evidência continua explícito e uma falha não é preenchida com zero.

A versão Cloudflare `755f82fe-6322-4c30-a549-6483549bbcd6` foi publicada com 100% do tráfego. O cron natural de **23/10/2026 às 13:58:25 UTC**, run `e2ad96cb-13e5-4ba6-aec7-90fa376940ef`, confirmou `mvp.recording: true`: 12 tokens, 17 avistamentos, duas decisões, seis eventos, oito jobs pendentes e zero outcomes completos.

O gateway `/api/market` está publicado na Vercel Hobby e respondeu HTTP 200. Isto não demonstra mercado recuperado no collector: a origem ainda foi assinalada como `STALE_SOURCE`, em investigação. A gravação remota está comprovada; a atualização das métricas é uma verificação separada em [OPERATIONS.md](OPERATIONS.md). Ver [auditoria e proteção dos dados](MVP-AUDIT.md) e [contrato de dados](MVP-DATA.md).

## Configuração preparada

[`config/profiles.yaml`](../config/profiles.yaml) separa os perfis novos das políticas antigas:

| Perfil | Estado | Idade | Pesos | Outros limites |
|---|---|---|---|---|
| `profile_new` | Habilitado na configuração; implementação das fases 2/3 pendente | 0h ≤ idade <24h | wallets 50%, segurança 30%, momentum 20% | ≥5 trades por wallet; score ≥75 |
| `profile_existing` | Desativado | ≥2.880 **horas**, ou 120 dias | wallet flow 40%, trend 30%, liquidez/segurança 20%, X 10% | Reservado às fases futuras |

Editar o YAML exige `npm run profiles:compile`; `npm run profiles:check` deteta JSON compilado desatualizado. A validação rejeita chaves desconhecidas, pesos inválidos, aliases e alterações que ativem fases futuras.

## Dados ainda necessários para wallets

A fase 3 terá de provar PnL realizado, win rate, pelo menos cinco trades, tempo médio de posição, entradas cedo/tarde, drawdown e decaimento temporal. Excluir insiders, bundlers ou wash trading exige prova; clusters coordenados devem contar como uma unidade. Histórico insuficiente ou PnL desconhecido não pode receber um valor favorável por omissão. A fase 1 ainda não fornece estas métricas.

Outcomes de sete dias não podem estar completos no primeiro dia de recolha. A regra de 300 lançamentos é apenas uma condição de dados para avaliação futura; não ativa backtest, modelo, novo modo B ou operações.
