# Alterações

## Verificação dos outcomes antes da continuação da fase 3 — 24/10/2026

- Corrigida a prioridade da fila: janelas abertas, quatro tokens distintos e fanout limitado a 24 jobs; os expirados procuram apenas dados históricos reais. Retries até um minuto durante a janela e backoff posterior limitado a 24h.
- Acrescentados arquivo imutável de observações, recuperação dentro da janela original e diagnóstico temporal do provider. Migration incremental `0006` aplicada após ponto integral D1 Time Travel; schema e hash verificados.
- Baseline de 471 testes; suite final de 480 testes sem falhas e três ciclos workerd com 15/14/14 RPC. Em produção, duas observações novas e três outcomes +15m elevaram o total de 28 para 31, com preço, liquidez e timestamps confirmados em D1.
- Primeiro push concluído em `urbanz95/memecoin-radar-mvp`, com branch novo para a continuação. Alterações seguintes de wallets mantidas em espera a pedido do utilizador. Pendências e riscos no [relatório](docs/MVP-VERIFICATION-2026-10-24.md).

## MVP — fase 3, 23/10/2026

- Ledger aditivo de swaps/transfers, intervalos, recibos e perfis por geração, reutilizando evidência dos módulos existentes. Contabilidade FIFO incremental, montantes racionais/decimais exatos, taxas e replay explícito dentro de 16 KiB de estado.
- Score manual de wallets com ≥5 trades realizados, PnL positivo, mínimo 70, meia-vida de 30 dias e ≥2 grupos independentes comprovados. Composição do token 50% wallets/30% segurança/20% momentum, sem preencher componentes desconhecidos.
- Momentum com dois pontos canónicos da mesma pool e datas originais de holders/liquidez; relatório semanal por score band, cobertura e retornos observados. Segunda-feira 00:15 UTC, coorte de duas semanas antes; não é backtest/modelo.
- Compressão gzip apenas das novas features de eventos, com decoder compatível com JSON antigo; primeiras features canónicas e histórico anterior preservados. Free continua limitado, sem promessa de arquivo indefinido.
- Verificação: 470 testes passaram; após as correções finais passaram 17 testes de codec/records, cinco verificações do codec no workerd e 40 testes do collector. Três ciclos workerd usaram 15/14/14 RPC; o ensaio local com RPC real usou 22.
- Migrations `0004`/`0005` aplicadas após novo ponto D1 Time Travel. Cloudflare `3067cd8d-5b70-4e81-89ba-198e4a36fd5b` e Vercel `dpl_9NjeLxKBV6VDrpq6KoPEgy5WGpjS` publicados. Duas recolhas naturais verificadas no browser, sem reload, com dados de mercado reais e bloqueados ocultos.
- Perfis reais permanecem inelegíveis quando falta histórico/custos/clustering; fixtures sintéticas aprovadas não são sinais reais. X, novo modo B e backtest/modelo não ativados. Criação/push do novo repositório bloqueados pela permissão GitHub `createRepository`.

## MVP — fase 2, 23/10/2026

- Filtros duros do modo A <24h, com provas de idade e estados `PASS`/`REJECTED`/`INCOMPLETE`/`OUT_OF_SCOPE`, preservando os pipelines antigos. Inclui histórico tipado do criador, bundles e manipulação de lançamento; desconhecido não passa.
- Outbox Telegram append-only e deduplicada, exclusivamente dry-run, com score ≥75 e evidência de wallets completa. Não há envio, credenciais ou pontuação inventada: histórico insuficiente mantém score nulo e zero alertas.
- Migration aditiva `0003_mvp_outbox.sql` aplicada após novo bookmark D1 Time Travel. Verificação: 397 testes passaram, ensaio final de 33 testes de filtros/pipeline e configuração/build válidos. Commit `b5b255d`.
- Corrigido `STALE_SOURCE` por comparação do relógio após o fetch (`5c877b0`). Cron natural das 17:59:23 UTC confirmou fase 2 em produção, mercado `REFRESHED` HTTP 200, 695 tokens, 85 decisões, 27 outcomes completos e outbox vazia. Detalhes em [operação](docs/OPERATIONS.md).
- Fase 3 em implementação; X, novo modo B, backtest/modelo e operações continuam desativados.

## MVP — fase 1, 23/10/2026

- Preservada a base `d8e8c0d`; alterações isoladas em `feat/mvp-wallet-signals` e interfaces antigas mantidas.
- Acrescentados perfis YAML validados, arquivo D1 aditivo de avistamentos/decisões/features e outcomes de 15m, 1h, 24h e 7d. Pontos em falta ficam em retry; features iniciais não são substituídas.
- Publicado gateway fixo de mercado na Vercel Hobby, sem cron ou storage Vercel, preservando a hora original e limitando pedidos/respostas.
- Verificação local: 342 testes passaram (298 na base), três ciclos workerd com fixtures e um ciclo local com RPC real. Migration remota aplicada após registar recuperação D1 Time Travel; não foi obtido export SQL offline.
- Collector publicado e gravação MVP comprovada pelo cron natural das 13:58:25 UTC: 12 tokens, duas decisões e oito jobs pendentes. A atualização do mercado ainda reportou `STALE_SOURCE`, em investigação; o gateway HTTP 200 não prova recuperação integrada. Ver [operação](docs/OPERATIONS.md).
- No fecho da fase 1, fases 2/3 ainda pendentes; X, novo modo B, backtest/modelo e operações não ativados.

Âmbito e estado: [MVP-PROGRESS.md](docs/MVP-PROGRESS.md). Limites e dados: [MVP-DATA.md](docs/MVP-DATA.md).
