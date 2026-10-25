# Arquivo de dados e outcomes do MVP

A migration [`0002_mvp_records.sql`](../cloudflare/migrations/0002_mvp_records.sql) acrescenta tabelas no D1 existente. As tabelas legadas, os endpoints e a retenção anterior permanecem compatíveis. O collector só grava quando `MVP_RECORDING_ENABLED=1` e confirma os registos no mesmo batch protegido por lease/fencing.

## Registos e identidade

| Tabela | Conteúdo | Regra |
|---|---|---|
| `mvp_tokens` | Primeiro avistamento, fonte, pool e run | Um por chain ID + endereço normalizado; imutável |
| `mvp_token_seen_events` | Avistamentos posteriores | Append-only, deduplicado por token/run/pool |
| `mvp_decisions` | Primeira decisão, features, baseline, fonte, versão e perfil | Um baseline imutável por token/score version/perfil; elegibilidade canónica verificada no ledger 0009 |
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

`/latest` acrescenta `mvp.outbox` com diagnósticos, contadores e pré-visualizações recentes. Filtros `REJECTED`/`OUT_OF_SCOPE` são arquivados, mas ficam fora das decisões MVP visíveis. A fase 2 não calculava PnL; a fase 3 acrescenta contabilidade e scoring para evidência completa. No adaptador real atual, dados de wallets ainda ausentes mantêm score nulo e outbox vazia. Não existe estado de entrega nem envio externo implementado.

## Ledger e contabilidade de wallets

A migration [`0004_mvp_wallets.sql`](../cloudflare/migrations/0004_mvp_wallets.sql) acrescenta:

- Eventos SWAP/TRANSFER e intervalos observados (`mvp_wallet_events`, `mvp_wallet_ranges`), com identidade canónica e deduplicação por chain/bloco/log. Conflitos de conteúdo falham explicitamente.
- Recibos, jobs e membros token/wallet (`mvp_wallet_receipts`, `mvp_wallet_receipt_jobs`, `mvp_wallet_token_members`). Recibos e eventos são preservados; jobs de enriquecimento têm retry dentro do orçamento.
- Eventos de perfil imutáveis, projeção atual e contadores (`mvp_wallet_profile_events`, `mvp_wallet_profiles`, `mvp_wallet_stats`). A geração/epoch e os registos de reorg invalidam a elegibilidade anterior sem apagar evidência histórica.

Os hooks reutilizam os logs já validados pelos módulos de pool/holders. O enriquecimento é limitado, sem um segundo scanner da rede. Uma lista de recibos observados não prova cobertura de toda a vida da wallet.

A contabilidade [`wallet-accounting.mjs`](../src/mvp/wallet-accounting.mjs) concilia fluxos líquidos do recibo e custos **FIFO**, com aritmética racional/BigInt. Conserva o PnL exato como numerador/denominador e a representação USD de 18 casas; não usa ponto flutuante para somar dinheiro. Taxas de compra entram no custo; taxas de venda reduzem o produto realizado. Uma transferência recebida sem custo conhecido impede assumir custo zero.

As métricas só ficam completas com prova do histórico desde o início, saldo inicial, custos USD, taxas e atribuição. Uma realização corresponde a uma venda atribuída por transação/token, não ao número de logs ou às compras. Tempo de posição usa lotes FIFO; entrada cedo exige criação comprovada e janela de 300s. Drawdown usa capital inicial comprovado mais PnL líquido realizado, sem inferir preços de posições não realizadas. O estado incremental tem teto de 16 KiB/128 lotes; falta de capacidade ou reordenação exige replay, sem truncar contabilidade para aprovar o perfil.

O scorer [`wallet-scoring.mjs`](../src/mvp/wallet-scoring.mjs) exige ≥5 trades realizados, PnL positivo e score ≥70 após decaimento com meia-vida de 30 dias. Os pesos e alvos manuais são configurados no YAML, sem backtest. Compradores coordenados são agregados num grupo e são necessários ≥2 grupos com independência comprovada. Flags positivas de insider/bundler/wash trading excluem; risco ou clustering desconhecidos não passam.

**Limite do adaptador atual:** amostras de pools/recibos não fornecem histórico vitalício, custos/taxas USD e clustering completos. Os perfis reais mantêm as respetivas flags falsas, PnL nulo e `eligible: false`; o motor disponível para dados completos não implica PnL real já comprovado. `/latest` acrescenta `mvp.wallets` com contadores do ledger quando a fase 3 está ativa.

## Compressão dos eventos de decisão

Novos `mvp_decision_events.features_json` usam envelope JSON `gzip-base64/v1`, com SHA-256 e tamanho descomprimido verificados, limitado a 64 KiB de conteúdo original. `decodeEventFeatures` aceita envelopes novos e JSON antigo sem alterar os bytes originais. As primeiras features canónicas em `mvp_decisions.features_json` continuam em JSON simples; relatórios SQL e coortes não dependem de descomprimir eventos. Não há reescrita destrutiva do histórico anterior.

O benchmark local observou cerca de 46–54% de poupança nos dados ensaiados; a taxa varia. A amostra da base antes da publicação da fase 3 era de cerca de **42,8 MB**, perante o limite Free de **500 MB por base**. Compressão e limites por registo não garantem retenção indefinida; ainda falta arquivo externo/retenção de longo prazo, sem apagar informalmente a evidência append-only.

## Relatório semanal

**Atualização 3B-1:** a geração saiu da transação de ingestão. O job próprio, agendado a cada cinco minutos, verifica o vencimento semanal das 00:15 UTC e produz uma coorte por invocação. As páginas imutáveis de até 64 KiB separam versão, perfil e tier, sem relatório global misturado. Tiers antigos sem prova são `UNKNOWN`. O painel consulta `/weekly?reportKey=...&page=N`; `/latest` inclui uma página. As tabelas antigas permanecem como arquivo compatível. Ver [estado 3B](PHASE3B-STATUS.md).

A migration [`0005_mvp_weekly.sql`](../cloudflare/migrations/0005_mvp_weekly.sql) acrescentou índices e `mvp_weekly_reports`, com relatórios imutáveis e idempotentes. Essa implementação anterior gerava o relatório dentro do cron de ingestão. O job independente da 3B-1 conserva o vencimento à segunda-feira às **00:15 UTC**, para a semana que começou duas semanas antes, permitindo maturação do último horizonte de 7d. Se regressar mais tarde na mesma semana, pode fazer catch-up; não cria outcomes ausentes.

A fonte é a primeira decisão/score congelados, com outcomes armazenados até ao cutoff. As bandas são 0–49, 50–64, 65–74, 75–84 e 85–100, mais `UNKNOWN`. Cada versão/perfil mantém a sua coorte. Sintéticos e proveniência desconhecida ficam excluídos e contabilizados separadamente; decisões reais rejeitadas, mortas e incompletas permanecem no denominador. Somar coortes pode repetir um token, pelo que membros de coorte não são apresentados como tokens únicos globais.

Por horizonte, publica amostras, outcomes desconhecidos, cobertura e retorno médio bruto de preço contra o baseline inicial. Não mede execução, gas/slippage ou PnL de estratégia; não é backtest nem modelo. Um token morto sem observação de preço continua desconhecido, sem fabricar −100%. `/latest` disponibiliza `mvp.weeklyReport` ou `null` quando ainda não há relatório gerado.

## Outcomes

Cada primeira decisão cria jobs **15m, 1h, 24h e 7d**, vencidos relativamente à sua hora inicial. O collector seleciona até quatro tokens distintos e até 24 jobs devidos por ciclo, incluindo as suas versões/perfis. As janelas ainda abertas (`LIVE`) têm prioridade e todos os jobs LIVE selecionados são preservados. O limite de quatro em `collector.maximumExpiredOutcomeJobs` aplica-se apenas aos retries históricos com janela expirada (`EXPIRED`); os restantes ficam adiados sem alterar os jobs guardados. Pode pedir mercado para tokens que já saíram da lista visível; para jobs expirados procura pontos históricos arquivados, sem usar o preço atual como substituto.

Um ponto completo exige preço, liquidez, fonte e timestamp efetivo entre o vencimento e **cinco minutos depois**. A captura pode chegar mais tarde apenas se a fonte histórica comprovar um ponto dentro dessa janela. O timestamp original do gateway é preservado através de `x-radar-fetched-at`; servir cache não cria uma observação nova.

Falha HTTP, token ausente, falta de preço/liquidez ou ponto fora da janela gera uma tentativa com motivo e estado `RETRY`, com backoff. Não elimina o job nem inventa preço zero. Um zero realmente observado e identificado é diferente de um campo ausente. Sem fonte histórica adequada, um ponto perdido pode nunca ficar completo; voltar a tentar não garante recuperá-lo.

`return_pct = (preço do outcome / baseline inicial − 1) × 100`, apenas com baseline inicial positivo. É retorno de preço reportado, **não PnL realizado**: não inclui tamanho da posição, taxas, gas, slippage ou capacidade de vender. Baseline ausente/zero deixa o retorno desconhecido; uma leitura posterior não reescreve o baseline inicial.

## Regra para avaliação futura

`outcomeEligibility` conta **lançamentos únicos**, dentro da mesma versão/perfil, com baseline positivo e os quatro outcomes completos com retorno calculável. O mínimo é 300; não são 300 observações nem 300 linhas do mesmo token. Esta verificação apenas indica disponibilidade dos dados: não executa backtest, treino ou operações.

Os registos MVP não são apagados pela retenção de três horas dos relatórios antigos. O Free continua a ter armazenamento e escritas limitados; a política de arquivo/retenção de longo prazo ainda falta. Triggers append-only impedem uma limpeza automática informal. Acompanhar tamanho, filas pendentes e quotas antes de acumular histórico prolongado.

Ver [MVP-AUDIT.md](MVP-AUDIT.md) para o ponto Time Travel e a inexistência de export SQL offline; [MVP-PROGRESS.md](MVP-PROGRESS.md) para as fases ainda pendentes.

## Canonicalidade e componentes exatos — 3B-1

A migration aditiva `0009` liga cada baseline ao bloco da primeira decisão, conserva reorgs e invalidações e coloca as gerações anteriores em quarentena até revalidar os hashes. Filas, commits de outcomes, relatórios e gate de 300 lançamentos excluem baselines órfãos ou sem referência comprovável; os registos originais não são apagados nem substituídos por preços posteriores. Um relatório já congelado fica em quarentena se a geração/validação mudar. Headers indisponíveis deixam a prova pendente e não interrompem a ingestão.

`accountingState.pnlComponents` e os resumos temporais passam a persistir componentes exatos por posição, conservando os campos cumulativos anteriores. O ficheiro validado `config/wallet-accounting.json` separa 16 KiB de estado, 128 lotes/componentes e 4.096 bits de orçamento aritmético. O limite de precisão antigo de 180 dígitos foi removido; não há arredondamento monetário para aprovar wallets. Excesso de recursos preserva checkpoints e mantém métricas incompletas, com recuperação explícita; o serviço de checkpoints segmentados ainda falta.

O TTL do contador atual de carteiras usa a configuração (600 s) e a geração corrente; `historicalEligible` identifica a projeção antiga. Nada desta alteração acrescenta as provas em falta de histórico, preços, taxas ou ETH nativo. A janela de 30 dias pertence ao bloco 3B-2 e ainda não foi implementada.
