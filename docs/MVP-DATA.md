# Arquivo de dados e outcomes do MVP

A migration [`0002_mvp_records.sql`](../cloudflare/migrations/0002_mvp_records.sql) acrescenta tabelas no D1 existente. As tabelas legadas, os endpoints e a retenção anterior permanecem compatíveis. O collector só grava quando `MVP_RECORDING_ENABLED=1` e confirma os registos no mesmo batch protegido por lease/fencing.

## Registos e identidade

| Tabela | Conteúdo | Regra |
|---|---|---|
| `mvp_tokens` | Primeiro avistamento, fonte, pool e run | Um por chain ID + endereço normalizado; imutável |
| `mvp_token_seen_events` | Avistamentos posteriores | Append-only, deduplicado por token/run/pool |
| `mvp_decisions` | Primeira decisão, features, baseline, fonte, versão e perfil | Um registo canónico por token/score version/perfil; imutável |
| `mvp_decision_events` | Decisões posteriores com as suas features | Append-only; não substituem a primeira decisão |
| `mvp_outcome_jobs` | Horizonte, vencimento, estado e próximo retry | Identidade/vencimento imutáveis; progresso atualizável |
| `mvp_outcome_attempts` | Tentativa, data, motivo e fonte | Append-only, incluindo `MISSING` e `INVALID` |
| `mvp_outcomes` | Primeiro ponto válido de cada horizonte | Imutável; inclui atraso e retorno quando calculável |
| `mvp_stats` | Contadores operacionais mantidos por triggers | Atualizáveis, sem varrer todo o arquivo a cada leitura |

Timestamps usam epoch em milissegundos na base e UTC nas interfaces. O endereço é normalizado para minúsculas. A chave de decisão inclui chain ID, contrato, versão do score e perfil; alterar a versão cria uma coorte distinta. Primeiro avistamento e criação da pool não são a data de criação do token.

As features incluem versão de schema, identidade, hora efetiva, hash da política, proveniência e os valores observados nesse momento. Dados futuros são rejeitados; registos excedentes falham explicitamente, sem truncar: até 64 KiB de features e 8 KiB de fonte. Repetir um run não substitui evidência já gravada. O arquivo aceita estados rejeitados, bloqueados, mortos ou incompletos sem os transformar em candidatos; só pode conservar tokens que a descoberta efetivamente encontrou.

A fase 1 regista os perfis `legacy_new` e `legacy_established`. A fase 2 conserva estes registos e acrescenta decisões `profile_new` com versão/hash próprios, resultado dos filtros duros e score global nulo enquanto faltar histórico de wallets. Cada versão/perfil mantém a sua coorte independente; a presença de `profile_new` não comprova PnL ou score de wallets calculado.

Após um relatório com gravação MVP, `/latest` acrescenta `mvp.archive` com contadores de tokens vistos, decisões, eventos, jobs pendentes/retry/completos e outcomes completos. Os contadores não provam cobertura integral nem qualidade financeira das observações.

## Outbox Telegram dry-run

A migration aditiva [`0003_mvp_outbox.sql`](../cloudflare/migrations/0003_mvp_outbox.sql) cria `mvp_alert_outbox` e `mvp_outbox_stats`. Cada pré-visualização é deduplicada por decisão, versão, episódio e alias de destino; SQL e formatter só aceitam estado `DRY_RUN`, modo A `profile_new`, direção `ENTRY` e mainnet 4663. UPDATE/DELETE das mensagens são rejeitados por triggers.

Só entram decisões globais `PASS`, score ≥75, score/segurança/wallets completos e pelo menos cinco trades realizados em cada wallet elegível. Clusters repetidos não contam como wallets independentes. Conteúdo sintético fica identificado como tal. Texto, links e tamanho são validados; credenciais e destinos reais não integram o envelope. O módulo não lê ambiente nem faz pedidos Telegram.

`/latest` acrescenta `mvp.outbox` com diagnósticos, contadores e pré-visualizações recentes. Filtros `REJECTED`/`OUT_OF_SCOPE` são arquivados, mas ficam fora das decisões MVP visíveis. A fase 2 não calcula PnL: dados de wallets ausentes mantêm score nulo e outbox vazia. Não existe estado de entrega nem envio externo implementado.

## Outcomes

Cada primeira decisão cria jobs **15m, 1h, 24h e 7d**, vencidos relativamente à sua hora inicial. O collector consulta até quatro jobs devidos por ciclo e pode pedir mercado para tokens que já saíram da lista visível.

Um ponto completo exige preço, liquidez, fonte e timestamp efetivo entre o vencimento e **cinco minutos depois**. A captura pode chegar mais tarde apenas se a fonte histórica comprovar um ponto dentro dessa janela. O timestamp original do gateway é preservado através de `x-radar-fetched-at`; servir cache não cria uma observação nova.

Falha HTTP, token ausente, falta de preço/liquidez ou ponto fora da janela gera uma tentativa com motivo e estado `RETRY`, com backoff. Não elimina o job nem inventa preço zero. Um zero realmente observado e identificado é diferente de um campo ausente. Sem fonte histórica adequada, um ponto perdido pode nunca ficar completo; voltar a tentar não garante recuperá-lo.

`return_pct = (preço do outcome / baseline inicial − 1) × 100`, apenas com baseline inicial positivo. É retorno de preço reportado, **não PnL realizado**: não inclui tamanho da posição, taxas, gas, slippage ou capacidade de vender. Baseline ausente/zero deixa o retorno desconhecido; uma leitura posterior não reescreve o baseline inicial.

## Regra para avaliação futura

`outcomeEligibility` conta **lançamentos únicos**, dentro da mesma versão/perfil, com baseline positivo e os quatro outcomes completos com retorno calculável. O mínimo é 300; não são 300 observações nem 300 linhas do mesmo token. Esta verificação apenas indica disponibilidade dos dados: não executa backtest, treino ou operações.

Os registos MVP não são apagados pela retenção de três horas dos relatórios antigos. O Free continua a ter armazenamento e escritas limitados; a política de arquivo/retenção de longo prazo ainda falta. Triggers append-only impedem uma limpeza automática informal. Acompanhar tamanho, filas pendentes e quotas antes de acumular histórico prolongado.

Ver [MVP-AUDIT.md](MVP-AUDIT.md) para o ponto Time Travel e a inexistência de export SQL offline; [MVP-PROGRESS.md](MVP-PROGRESS.md) para as fases ainda pendentes.
