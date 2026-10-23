# Alterações

## MVP — fase 1, 23/10/2026

- Preservada a base `d8e8c0d`; alterações isoladas em `feat/mvp-wallet-signals` e interfaces antigas mantidas.
- Acrescentados perfis YAML validados, arquivo D1 aditivo de avistamentos/decisões/features e outcomes de 15m, 1h, 24h e 7d. Pontos em falta ficam em retry; features iniciais não são substituídas.
- Publicado gateway fixo de mercado na Vercel Hobby, sem cron ou storage Vercel, preservando a hora original e limitando pedidos/respostas.
- Verificação local: 342 testes passaram (298 na base), três ciclos workerd com fixtures e um ciclo local com RPC real. Migration remota aplicada após registar recuperação D1 Time Travel; não foi obtido export SQL offline.
- Collector publicado e gravação MVP comprovada pelo cron natural das 13:58:25 UTC: 12 tokens, duas decisões e oito jobs pendentes. A atualização do mercado ainda reportou `STALE_SOURCE`, em investigação; o gateway HTTP 200 não prova recuperação integrada. Ver [operação](docs/OPERATIONS.md).
- Fases 2/3 ainda pendentes; X, novo modo B, backtest/modelo e operações não ativados.

Âmbito e estado: [MVP-PROGRESS.md](docs/MVP-PROGRESS.md). Limites e dados: [MVP-DATA.md](docs/MVP-DATA.md).
