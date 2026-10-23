# Auditoria do MVP — fases 1 a 3

Esta é uma auditoria técnica do repositório e da recolha existente, não uma auditoria de segurança dos tokens. A base foi preservada no commit `d8e8c0d` (`main`); o trabalho do MVP está isolado em `feat/mvp-wallet-signals`.

## Base preservada

| Área | Comportamento existente | Alteração na fase 1 |
|---|---|---|
| Rede | Robinhood Chain mainnet 4663; RPC apenas de leitura | Sem mudança de rede ou envio de transações |
| Recolha | Cron Cloudflare por minuto, DO `Collector/main`, D1, lease e fencing | Registos MVP entram no mesmo commit transacional |
| Descoberta | Pools configuradas v2/v3/v4, catálogo parcial e backfill | Novos avistamentos ficam também no arquivo MVP |
| Avaliação | Políticas estritas e alertas de mercado separados | Interfaces e parâmetros existentes preservados |
| Painel | Vercel Hobby, polling 30s, bloqueados ocultos, TTLs | `/latest` pode acrescentar metadados `mvp`; campos existentes mantidos |
| Dados anteriores | `pools`, `runs`, `control`, migrations existentes | Migration `0002_mvp_records.sql` apenas aditiva |
| Histórico | Relatórios detalhados com retenção de três horas | Arquivo MVP independente, com decisões iniciais e outcomes duráveis |

Os dois pipelines antigos continuam disponíveis por compatibilidade. O pipeline antigo de estabelecidos ≥7 dias não equivale ao novo modo B, reservado a tokens com pelo menos 2.880 horas. A fase 1 regista decisões `legacy_new`/`legacy_established`; não apresenta estes resultados como execução do novo score de wallets.

## Verificação da fase 1

- Baseline: 298 testes. Após a implementação: **342 passaram, zero falhas**, incluindo compatibilidade, YAML, imutabilidade, idempotência, ausência de dados futuros e outcomes.
- Três ciclos locais no workerd com fixtures: 15/14/14 pedidos RPC. Um ciclo local com RPC real: 23 pedidos. São provas locais, sem demonstração de estabilidade remota contínua.
- Gateway Vercel publicado no Hobby: pedido válido HTTP 200 e entrada inválida HTTP 400, com timestamp próprio.
- Collector Cloudflare `755f82fe-6322-4c30-a549-6483549bbcd6`, com 100% do tráfego: o cron natural das 13:58:25 UTC confirmou gravação MVP, 12 tokens, duas decisões e oito jobs pendentes. O mercado ainda reportou `STALE_SOURCE`; a prova de persistência não demonstra recuperação das métricas. Ver [OPERATIONS.md](OPERATIONS.md).

Os artefactos locais de verificação estão em `runtime/mvp-phase1/`; não fazem parte do upload público nem do Git.

## Proteção dos dados antes da migration

Antes da alteração foi registado um ponto de recuperação **D1 Time Travel da base completa**, às **13:31 UTC de 23/10/2026**. O bookmark, hashes e resultado da migration estão em `runtime/backups/pre-mvp-manifest.json`. A migration aditiva foi aplicada e verificada remotamente, com 35 instruções.

**Não existe export SQL offline:** a API de exportação respondeu com erro de autenticação `10000` e não criou ficheiro. O mecanismo de recuperação disponível é o Time Travel, sujeito à janela de **sete dias do D1 Free**; não é um backup externo permanente. Restaurar a base altera também dados posteriores ao ponto escolhido e exige uma operação própria, não é parte da migration.

## Limites e riscos conhecidos

O catálogo não cobre todos os tokens e o mercado externo pode falhar ou limitar pedidos. O gateway resolve o transporte por uma origem permitida, sem garantir disponibilidade do fornecedor. Não há prova atual de PnL realizado, win rate ou qualidade de wallets: faltam histórias completas, custos, posições e ligação entre compras e vendas. Dados ausentes continuam desconhecidos.

O arquivo MVP não usa a poda de três horas dos relatórios antigos. O armazenamento e as escritas do plano Free são finitos; ainda não existe política de arquivo externo ou retenção para as tabelas MVP. Os limites por registo e os lotes pequenos controlam uma execução, não garantem crescimento ilimitado. Sem fontes históricas, uma janela de outcome perdida pode continuar pendente indefinidamente.

O âmbito e as pendências estão em [MVP-PROGRESS.md](MVP-PROGRESS.md); o contrato do arquivo, em [MVP-DATA.md](MVP-DATA.md).
