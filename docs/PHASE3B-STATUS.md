# Fase 3B — consolidação

Branch: `fix/phase3b-consolidation-20261025`, criado a partir de `b888ae5` e atualizado por fast-forward com os commits já publicados da Fase 3 e da auditoria. Preservam-se funcionalidades, migrations aplicadas e interfaces anteriores.

## Estado e gates

**Bloco 3B-1 publicado e em observação. Os blocos 3B-2 e 3B-3 ainda não começaram.** A autorização para os iniciar está condicionada a testes aprovados e pelo menos seis horas de ciclos concluídos em produção, com continuidade comprovada. Tempo de relógio ou um endpoint HTTP 200 não substituem essa prova.

`/health.operations.stability` publica início, número de ciclos concluídos e `qualified`. O contador reinicia após falha ou intervalo superior a seis minutos. A qualificação exige um intervalo real de seis horas entre o primeiro e o último ciclo concluídos, dados recentes e ausência de ciclo interrompido.

As Fases 4, 5 e 6 continuam desativadas. Só começam com a instrução explícita `AVANÇA FASE N`. Sem trades nem envio Telegram; a outbox mantém pré-visualizações.

## Changelog por achado

| Achado | Alteração | Validação / limite |
|---|---|---|
| A01 | Logs e analytics confirmam esgotamento da quota diária de escritas D1. Cadência gerida no DO, orçamento preventivo, circuit breaker até ao reset UTC e causas estruturadas independentes de D1 | Causa real: 101.064 linhas escritas em 24/10. Cron ativo; exceções específicas de quota, não prova de CPU esgotada |
| A02 | Job semanal em cron e ator próprios, separado da transação de ingestão; uma coorte por invocação, páginas até 64 KiB, checkpoint, cutoff, lease e backoff | Regressão SQLite com 15 coortes e falha deliberada do job; ingestão continua |
| A05 | Formatter aceita vários membros do mesmo cluster e conta grupos distintos; preview preserva representantes antes de limitar os membros | Três wallets em dois grupos aceites; um grupo continua a falhar; mínimo de trades e restantes filtros preservados |
| A06 | Ledger aditivo de referências, reorgs, verificações e invalidações de baselines; validação no commit, fila, relatórios e gate de labels | Blocos órfãos preservados no arquivo e excluídos; geração em quarentena até revalidação, até dois blocos por ciclo |
| A07 | Elegibilidade atual calculada pela geração e TTL, com índice de cobertura | 601 s expira para TTL 600 s; futuro não conta. Contador histórico fica explicitamente separado |
| A08 | Componentes racionais por posição persistidos no JSON existente, com adaptação de checkpoints antigos; limites aritméticos separados da memória | 24 posições com denominadores primos, reinício e resumo temporal exatos. Orçamentos: 4.096 bits, 128 componentes/lotes, estado 16 KiB |
| A09 | Backend e painel apresentam uma coorte por versão/perfil/tier, com paginação | Sem média global misturada. Tier antigo não comprovado fica `UNKNOWN`, sem inventar T0 |

Os achados A03 e A04 continuam em aberto até ao bloco 3B-2. Não foram construídos produtores de prova, backfill de 30 dias, nova reconciliação de ETH nativo ou clustering de financiamento nesta entrega de estabilidade.

Validação anterior à publicação inicial: baseline de 511 testes; suite de **583 testes sem falhas**, `validate`, `profiles:check`, build Cloudflare e três fases consecutivas em workerd com **15/14/14 pedidos RPC**. O ensaio também verifica separadamente o ator gerido, um ciclo saltado sem RPC e os jobs semanal/heartbeat. As fases consecutivas usam cadência desativada apenas no ambiente local de ensaio, sem alterar produção; não comprovam seis horas de continuidade ou limites de CPU em produção. A verificação no Chromium encontrou ainda duas promessas incorretas de recolha por minuto; foram corrigidas para intervalo variável, com regressão própria.

A revisão A08 também corrigiu a compatibilidade do fingerprint económico ao acrescentar componentes opcionais e o excesso de 16 KiB de evidência por realização. Eventos inválidos ficam isolados; a ingestão persiste apenas as realizações validadas, sem converter falhas em carteiras completas.

Após o ensaio com Chromium e a medição real de CPU, a suite passou a **589 testes sem falhas**; `validate`, `profiles:check`, build e ensaio workerd voltaram a passar. As leituras públicas foram extraídas para um handler compatível no DO: o Worker gerido encaminha `/health`, `/latest` e `/weekly` sem ler D1 ou construir o JSON. Mantêm-se contratos, cache, GET-only e rotas públicas.

O ajuste final dos lotes de outcomes elevou a suite a **593 testes aprovados**, novamente com validate/profiles:check/build/workerd. Mantém todos os jobs LIVE selecionados, incluindo fanout de 24, e limita a quatro os retries EXPIRED por ciclo. A regressão SQLite comprovou que os restantes jobs ficam integralmente inalterados, sem perda de prazos, estado ou provas.

## Operação no plano gratuito

Fonte validada: [`config/operations.json`](../config/operations.json). Cadência inicial de 180 s, adaptável ao custo medido do ciclo; máximo 900 s. O cron de um minuto só delega: ciclos antes da data permitida saltam sem RPC nem escrita D1. Isto reduz a frequência de enriquecimento; não é ingestão em segundos.

O collector dispõe de um orçamento preventivo de **80.000 escritas estimadas/dia UTC**, deixando 20.000 linhas de margem perante as 100.000 do D1 Free. O custo usa `meta.rows_written` do batch mais dez linhas de overhead; antes da execução reserva pelo menos 2.048 linhas no journal do DO. Uma invocação interrompida ou sem medição conserva a reserva. Um ciclo medido reconcilia-a. Ao esgotar orçamento/quota, espera pelo próximo dia UTC. Retém cursores e dados; não apaga tokens nem baixa filtros.

O orçamento é uma proteção deste collector, **não uma medição global da conta**. Escritas administrativas, migrations, outros clientes e job semanal usam a margem; custos atípicos e quotas de leitura/DO/Workers também precisam de observação. Uma cadência adaptada acima de seis minutos impede qualificar o gate de estabilidade; nesse caso é necessário reduzir lotes ou rever prioridades, não declarar o gate concluído.

Os TTLs financeiros não foram alargados: cabeça com mais de 60 s e mercado com mais de 120 s continuam a caducar. Com recolha mais espaçada, existem intervalos sem sinais frescos, mesmo quando o processo está a respeitar a sua cadência. A solução definitiva pode exigir separar capturas prioritárias e reduzir escritas por ciclo; não é correto ocultar a caducidade para apresentar sinais.

Cron semanal: `2-59/5 * * * *`, ator separado. Heartbeat interno: `4-59/5 * * * *`. O relatório só cobre semanas maduras, duas semanas anteriores; uma coorte vazia agora não significa arquivo vazio. A página `/weekly` e `/latest` leem dados, sem iniciar o scanner.

`collector.maximumExpiredOutcomeJobs=4` limita apenas tentativas históricas que já perderam a janela. A seleção de até 24 jobs continua a dar prioridade a janelas abertas; nenhuma captura LIVE é removida por esse limite. O backlog preserva-se para recuperação histórica. `outcomeCollection.selectedJobs`, `expiredDeferred` e `maxExpiredPerCycle` mostram o que foi adiado. Isto reduz escritas de retries sem converter falta de preço em zero ou eliminar tokens mortos.

Monitor externo: [workflow heartbeat](../.github/workflows/heartbeat.yml), nominalmente a cada cinco minutos, executa fora da Cloudflare. Após mais de dez minutos sem ciclo concluído, cria uma única issue atribuída a `urbanz95`, com causa sanitizada. Mudança de causa atualiza essa issue; recuperação comprovada comenta e fecha. Usa o token automático da execução, sem novas chaves ou Telegram. Agendamentos GitHub podem atrasar ou ser suspensos; não há garantia de notificação exatamente ao décimo minuto. Notificações pessoais dependem das definições da conta GitHub. Cache externo guarda apenas timestamps; perda do cache pode atrasar a deteção se a última recolha também for desconhecida.

## Migrations e recuperação

Preparadas migrations aditivas `0009` (canonicalidade), `0010` (job semanal) e `0012` (índice TTL). O número `0011` ficou reservado e não foi necessário; não existe migration aplicada em falta. Antes de aplicar, registar novo bookmark D1 Time Travel, manifest de hashes e lista de migrations já aplicadas. Não reescrever SQL previamente aplicado. Time Travel no Free tem retenção finita; não equivale a export offline ou a ensaio de restauro.

O limite A08 já não é o antigo teto de 180 dígitos nem um replay idêntico repetido. Se exceder os novos limites de precisão/componentes/memória, a wallet permanece incompleta e pede `SEGMENTED_EXACT_CHECKPOINT_REQUIRED`. O serviço externo de checkpoints segmentados não foi implementado. PnL desconhecido permanece `null`; a correção não cria histórico/provas inexistentes.

## Próximos passos autorizados, após o gate

1. Confirmar seis horas reais de estabilidade e manter a suite completa aprovada.
2. Bloco 3B-2: provas tipadas de deployer e atividade de lançamento; janela declarada de 30 dias, custos/atribuição/riscos comprovados, clustering e ETH nativo. Documentar requisitos ainda não demonstráveis, sem os contornar.
3. Bloco 3B-3: objeto de par canónico, censo sem filtro de cotação, registry comprovado, rotas e segurança por tier, gravação e shadow de pelo menos três dias. A nova pontuação continua desligada durante o shadow.
4. Parar no fim da etapa 1 do shadow e apresentar contagens, cobertura, crescimento/quotas, cotações aceites/rejeitadas e riscos. Não ativar etapa 2 ou fases seguintes automaticamente.

Até esses blocos, a descoberta continua limitada às cotações antigas ETH nativo/WETH/USDG. Não foi ativada cotação AMC, stock token, stablecoin adicional ou memecoin como quote.

## Primeira recuperação real

Após o reset UTC, foram aplicadas `0009`, `0010` e `0012` às 01:00 de Lisboa, com o [bookmark e hashes registados](PHASE3B-BACKUP-2026-10-25.json). Confirmados onze migrations e 456 referências de baseline; nenhum SQL anteriormente aplicado foi reescrito.

A primeira recolha natural da versão 3B terminou em **25/10 às 01:04 de Lisboa** (`2026-10-25T00:04:26.987Z`), run `491e2b00-59c7-4e33-a9ed-41d068f4712d`. O endpoint direto e a Vercel passaram a HTTP 200/COMPLETED. O arquivo avançou para 3.918 tokens, 459 decisões versionadas e 4.335 eventos de decisão. Permaneciam 222 outcomes completos, 145 wallets e zero elegíveis, sem alertas fabricados.

Esse ciclo registou 513 escritas D1 no batch e adaptou a próxima tentativa para 565 s; não foi atribuído esse custo a um módulo sem evidência. O ciclo seguinte terminou às **01:14 de Lisboa**, com 215 escritas e cadência adaptada de 243 s. O intervalo anterior de dez minutos reiniciou corretamente o contador de continuidade às `2026-10-25T00:14:30.149Z`. Recuperação inicial não equivale a seis horas de estabilidade.

O cron semanal separado produziu o primeiro relatório v2 às 01:12 de Lisboa, sem coortes maduras; `/weekly` respondeu HTTP 200. O heartbeat interno executou separadamente. O monitor GitHub comprovou abertura e recuperação: a issue #2 foi fechada pelo bot às 01:08 de Lisboa, com comentário do ciclo recuperado. Os dois ensaios externos foram `workflow_dispatch`; o workflow periódico está ativo, com a ressalva de atraso do agendamento gratuito.

Nas amostras anteriores à extração do handler, `/latest` usou até 17 ms de CPU no Worker, com outcome `ok`; o DO usou até 85 ms de CPU. Não foi atribuída a paragem original a CPU: o erro D1 de quota é a causa comprovada. A extração reduz trabalho no Worker, cujo referencial Free é 10 ms, usando o orçamento de 30 s de CPU do DO. Tempo de parede em I/O não é tempo de CPU; é necessário medir novamente depois da publicação.

Primeira amostra depois da extração: **16 eventos stateless, máximo 1 ms de CPU; 14 eventos DO, máximo 11 ms**, sem erros. Esta amostra não garante todos os pedidos futuros. Em Chromium, duas consultas automáticas consecutivas tiveram `/health` e `/latest` HTTP 200, sem cliques ou erros JS; a hora da vista avançou, enquanto o `runId` e a hora de recolha permaneceram corretamente iguais porque não havia nova recolha nesse intervalo.

Os custos seguintes variaram de 215 a 320 escritas; não se extrapolou consumo diário a partir de um único ciclo. Como intervalos longos reiniciam o gate, foi aplicado o limite dos retries históricos referido acima. A continuidade tem de ser medida novamente após este ajuste.

Está criada uma continuação condicional em Europe/Lisbon, a partir de **25/10 às 06:15**, de hora a hora. Só inicia 3B-2/3 com o gate comprovado e testes aprovados; caso contrário continua a estabilização. O pedido completo e o estado ficam no repositório para retoma. A automação deve parar no fim da etapa 1 do shadow; não autoriza etapas ou fases seguintes.

## Decisões de implementação

- Reservar 20.000 escritas/dia da conta e começar com 180 s entre ciclos, ajustando pelo custo, para evitar novo esgotamento do Free.
- Priorizar outcomes ainda capturáveis e adiar retries fora da janela, sem reescrever ou apagar o arquivo.
- Marcar tiers históricos como UNKNOWN e preservar a primeira decisão imutável: não atribuir T0 ou um score posterior retroativamente. Uma primeira decisão incompleta continua na faixa UNKNOWN; uma coorte acionável própria ainda não foi acrescentada.
- Persistir componentes exatos no JSON existente, sem migration adicional, com limites explícitos de 4.096 bits e 16 KiB; não prometer replay recuperável quando o limite exige checkpoint segmentado.
- Usar o mesmo DO para construção das respostas públicas, evitando custo de serialização no Worker e mantendo as interfaces.
