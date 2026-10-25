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

## Operação no plano gratuito

Fonte validada: [`config/operations.json`](../config/operations.json). Cadência inicial de 180 s, adaptável ao custo medido do ciclo; máximo 900 s. O cron de um minuto só delega: ciclos antes da data permitida saltam sem RPC nem escrita D1. Isto reduz a frequência de enriquecimento; não é ingestão em segundos.

O collector dispõe de um orçamento preventivo de **80.000 escritas estimadas/dia UTC**, deixando 20.000 linhas de margem perante as 100.000 do D1 Free. O custo usa `meta.rows_written` do batch mais dez linhas de overhead; antes da execução reserva pelo menos 2.048 linhas no journal do DO. Uma invocação interrompida ou sem medição conserva a reserva. Um ciclo medido reconcilia-a. Ao esgotar orçamento/quota, espera pelo próximo dia UTC. Retém cursores e dados; não apaga tokens nem baixa filtros.

O orçamento é uma proteção deste collector, **não uma medição global da conta**. Escritas administrativas, migrations, outros clientes e job semanal usam a margem; custos atípicos e quotas de leitura/DO/Workers também precisam de observação. Uma cadência adaptada acima de seis minutos impede qualificar o gate de estabilidade; nesse caso é necessário reduzir lotes ou rever prioridades, não declarar o gate concluído.

Os TTLs financeiros não foram alargados: cabeça com mais de 60 s e mercado com mais de 120 s continuam a caducar. Com recolha mais espaçada, existem intervalos sem sinais frescos, mesmo quando o processo está a respeitar a sua cadência. A solução definitiva pode exigir separar capturas prioritárias e reduzir escritas por ciclo; não é correto ocultar a caducidade para apresentar sinais.

Cron semanal: `2-59/5 * * * *`, ator separado. Heartbeat interno: `4-59/5 * * * *`. O relatório só cobre semanas maduras, duas semanas anteriores; uma coorte vazia agora não significa arquivo vazio. A página `/weekly` e `/latest` leem dados, sem iniciar o scanner.

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

Esse ciclo registou 513 escritas D1 no batch e adaptou a próxima tentativa para 565 s; não foi atribuído esse custo a um módulo sem evidência. A cadência superior a seis minutos impede neste momento qualificar o gate. São necessárias observações adicionais e, se o custo persistir, redução de lotes. Recuperação inicial não equivale a seis horas de estabilidade.
