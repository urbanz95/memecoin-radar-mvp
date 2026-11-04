# Contrato de dados — Solana

O contrato canónico enriquecido está em `src/events.mjs`, versão 1. Observações rápidas de logs usam um contrato separado em `src/log-observations.mjs` e nunca substituem eventos canónicos incompletamente. A rede de mercado é Solana Mainnet; o processo verifica o genesis hash HTTP `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`. `chain` é `solana`; a API de saúde identifica `network: mainnet-beta` e `mode: READ_ONLY`.

Tokens são identificados exclusivamente pelo endereço mint base58 case-sensitive. Símbolos, nomes, URIs e nomes de aplicações são metadados não confiáveis e não identificam um token ou programa. Duas moedas com o mesmo símbolo continuam entidades distintas; a capitalização de um endereço nunca é normalizada.

## Observações rápidas de logs — contrato separado

`/observations` devolve eventos binários demonstrados pela notificação RPC, com `dataMode: REAL_RPC_LOG_OBSERVATION`, `evidenceStatus: VERIFIED_RPC_LOG_EVENT`, `completeness: INCOMPLETE` e `contextCompleteness: INCOMPLETE`. Esse modo vem ativado por omissão. O envelope HTTP identifica `context: RPC_LOGS_WITH_INCOMPLETE_TRANSACTION_CONTEXT` e `mergedWithMarket: false`.

Estas observações conservam os campos demonstráveis pelo evento, como mint, reservas, wallet e montantes brutos. Campos que dependem das contas/instruções/balances da transação ficam `null` e são assinalados em `missingFields`. `instructionIndex` e `innerInstructionIndex` são sempre `null`; a ordem `eventOrdinal` não é um índice de instrução Solana. O decoder não transforma a forma temporária necessária à descodificação numa transação RPC fictícia.

A identidade é SHA-256 de JSON com `solana-log-observation-v1`, assinatura, Program ID, `sourceMessageSha256`, ordinal e tipo de evento. O prefixo e os componentes diferem dos IDs canónicos. `sourceMessageSha256` é o hash SHA-256 de `JSON.stringify(notification.logs)` e permite verificar os raw logs retidos em `selected_log_messages`, cuja chave é o par `(signature, source_message_sha256)`. Variantes de logs da mesma assinatura conservam provas distintas. Uma atualização de commitment pode elevar o estado comprovado sem criar uma segunda observação para o mesmo payload nem baixar a confirmação anterior.

Sem transação enriquecida, `contextEnrichmentAvailable` é `false` e `reconciliationStatus` é `UNRECONCILED`; esse estado não entra no domínio de eventos canónicos de mercado. Quando a assinatura tem contexto canónico retido, a leitura junta finalidade e reconciliação sem preencher índices inexistentes ou alterar `contextCompleteness`. `contextSlotMismatch: true` indica que o slot dos logs difere do da transação; nesse caso a observação fica `UNRESOLVED`, sem promoção da finalidade a partir do contexto incompatível. O compromisso mais forte conhecido não recua por uma leitura menos forte.

As observações não incrementam `/events`, o catálogo canónico de tokens/pools ou `/market`. São consultáveis por `mint`, `wallet`, `pool`, `signature` e `limit`. Não somar volumes de `/observations` com `/events`: o mesmo swap pode ter uma observação incompleta e um evento canónico posterior. As duas interfaces representam etapas/evidências distintas, sem deduplicação económica automática entre elas.

Quando o orçamento/backlog impede `getTransaction`, `contextEnrichmentSkipped` aumenta e o caminho rápido pode continuar a publicar apenas os dados contidos nos logs. Isso não prova cobertura de rotas, instruções desconhecidas, swaps sem evento reconhecido ou transações perdidas durante desconexão. A observação retida tem limite de 24 horas por omissão e 25.000 linhas; raw logs sem observações correspondentes são podados. Os valores de latência de observações e de eventos enriquecidos têm métricas separadas.

## Evento canónico

| Campo | Tipo / significado |
| --- | --- |
| `schemaVersion` | Inteiro `1`. |
| `chain` | String `solana`. |
| `protocol` | Identificador do adaptador: `pump_fun`, `pump_swap`, `raydium_launchlab` ou `raydium_cpmm`. |
| `programId` | Program ID associado ao IDL e à instrução efetivamente observada. |
| `eventType` | Um dos tipos definidos abaixo. |
| `tokenMint`, `quoteMint` | Endereços mint; `null` quando não demonstrados. SOL nativo é representado pelo mint WSOL canónico quando o adaptador prova essa semântica. |
| `poolAddress` | Pool/bonding curve identificada pela evidência; `null` quando ausente. |
| `transactionSignature` | Assinatura da transação observada e enriquecida. |
| `slot` | Inteiro seguro não negativo; não representa índice temporal contínuo nem bloco necessariamente disponível. |
| `instructionIndex` | Índice não negativo da instrução de topo. |
| `innerInstructionIndex` | Índice da inner instruction dentro do grupo RPC, ou `null` para topo. |
| `eventIndex` / `eventOrdinal` | Desempate entre eventos emitidos no mesmo contexto de instrução. O decoder atual usa `eventOrdinal`. |
| `wallet` | Ator comprovado pelo evento/layout de contas, ou `null`; não equivale necessariamente ao fee payer, beneficiário económico ou proprietário de todas as contas da rota. |
| `creator` | Criador comprovado pelo evento/layout específico, ou `null`; não inferido pelo símbolo, primeiro comprador ou fee payer. |
| `amountTokenRaw`, `amountQuoteRaw` | Strings decimais inteiras não negativas, ou `null`. Nunca JSON Number para valores brutos financeiros. |
| `tokenDecimals`, `quoteDecimals` | Inteiros 0–255, ou `null`; provenientes do evento ou dos token balances da transação. |
| `eventTimestamp` | UTC ISO 8601 do timestamp do evento ou blockTime RPC, consoante o adaptador, ou `null`. |
| `receivedAt` | UTC da receção da observação live ou da seleção durante recuperação. Não é criação do token. |
| `processedAt` | UTC em que o evento foi normalizado/persistido. |
| `confirmationStatus` | `processed`, `confirmed` ou `finalized`; ver as regras abaixo. |
| `reconciliationStatus` | `ACTIVE`, `UNRESOLVED` ou `REVERTED`. |
| `evidenceSource` | Objeto de proveniência com tipo de evidência, IDL SHA-256 e nome de evento/instrução, quando disponíveis. |
| `completeness` | `COMPLETE` ou `INCOMPLETE`, relativo aos campos demonstrados pelo decoder; não afirma cobertura do protocolo/rede. O valor por omissão é `INCOMPLETE`. |
| `evidenceStatus` | Estatuto da evidência descodificada; `UNVERIFIED` por omissão. |
| `confidence` | Atualmente `null` quando emitido pelo registry; não existe score probabilístico fabricado. |
| `missingFields` | Lista de campos que o adaptador/registry não conseguiu demonstrar. |
| `id` | SHA-256 determinístico da identidade de evento descrita abaixo. |

O schema reconhece `TOKEN_CREATED`, `TOKEN_BOUGHT`, `TOKEN_SOLD`, `POOL_CREATED`, `LIQUIDITY_ADDED`, `LIQUIDITY_REMOVED`, `CURVE_PROGRESS_UPDATED`, `TOKEN_GRADUATED`, `TOKEN_MIGRATED` e `TOKEN_AUTHORITY_CHANGED`. Reconhecer o tipo no schema não significa que exista decoder e cobertura live para todas as variantes. Em particular, não há um watcher global de alterações de autoridade SPL nesta entrega. A cobertura por protocolo está em [VALIDATION.md](VALIDATION.md).

A identidade é o SHA-256 de JSON com estes componentes, na ordem indicada: `chain`, `programId`, `transactionSignature`, `instructionIndex`, `innerInstructionIndex`, `eventIndex ?? eventOrdinal ?? 0`, `eventType`. Assinaturas duplicadas entram uma única vez na inbox. Eventos repetidos com a mesma identidade atualizam a projeção idempotente sem acrescentar uma segunda linha.

Campos financeiros adicionais, como `reserves`, `totalSupplyRaw`, `fees` e `financialSemantics`, dependem do adaptador. Os montantes de um evento Pump.fun podem excluir fees separadas, enquanto um evento PumpSwap pode reportar o quote líquido/bruto do utilizador. Não comparar preços de semânticas diferentes como se fossem a mesma medida. Reservas reportadas por eventos são snapshots do protocolo; a ordem pré/pós-trade deve ser lida no layout/fonte, sem tratar automaticamente a reserva como liquidez imediatamente resgatável.

## Evidência, completude e suporte

`VERIFIED_PROTOCOL_EVENT` indica correspondência do discriminator e layout binário com o IDL versionado, num contexto de execução atribuído ao Program ID. `VERIFIED_INSTRUCTION` indica uma instrução conhecida que terminou com sucesso e os campos demonstrados pelo layout/contas. Estes valores qualificam o registo específico; não certificam o protocolo inteiro, a versão atual do programa ou a validação operacional em Mainnet.

A classificação de uma integração como validada, `UNVERIFIED` ou `NOT_IMPLEMENTED` é separada da classificação do evento. Uma fixture sintética pode provar o algoritmo e passar testes, mas nunca deve ser apresentada como transação real. Fixtures reais devem conservar a assinatura e proveniência documentadas.

O decoder suporta account keys de topo e `meta.loadedAddresses` de transações versionadas, instruções de topo/inner e eventos Anchor emitidos por data/CPI. A atribuição de eventos segue o contexto runtime; subárvores que falharam ou não terminaram são excluídas mesmo quando a transação externa terminou com sucesso. Uma transferência SPL isolada não é classificada como swap. Discriminator desconhecido ou layout inválido gera diagnóstico; dados incompletos mantêm campos `null` e `INCOMPLETE` em vez de montantes inventados.

## Confirmação e reversões

A inbox conserva o nível recebido pela WebSocket, incluindo `processed`. O scanner enriquece transações pelo RPC `confirmed` antes de disponibilizar eventos normalizados; por isso uma observação antecipada não é publicada como um evento finalizado. A biblioteca canónica aceita `processed` para representar o domínio e testar reconciliação, mas isso não promete publicação antecipada do caminho canónico; a publicação antecipada separada de `/observations` continua explicitamente incompleta.

`confirmationStatus` indica a etapa mais forte comprovada. `reconciliationStatus` indica se a evidência continua utilizável: apenas `ACTIVE` entra nos agregados atuais. Uma resposta de status nula depois do período de espera produz `UNRESOLVED`; não prova reversão nem ausência de transação. Um erro comprovado produz `REVERTED`. Uma discrepância de slot é registada explicitamente e não é promovida silenciosamente a finalização.

Os eventos revertidos permanecem consultáveis para investigação. Consumidores de `/events` devem verificar ambos os campos. `/tokens` inclui `confirmationStatus`, `reconciliationStatus` e `creationEvidenceRetained`; só publica `createdAt`/`creator` a partir de evidência de criação retida e ativa. `firstSeenAt` conserva o primeiro avistamento pelo scanner e nunca deve ser usado como data comprovada de criação. A retenção pode remover a prova de criação; nesse caso `createdAt` e `creator` ficam desconhecidos.

## Inteiros, preços e janelas

A parser JSON-RPC converte literais inteiros fora do intervalo exato de JavaScript para strings antes do `JSON.parse`; os decoders Borsh usam inteiros exatos. Valores brutos de tokens, reservas e supply são strings decimais. Frações de preço e variação usam numerador/denominador decimal, sem arredondamento prematuro. Decimais ausentes impedem o preço em unidades humanas, embora a razão bruta ainda possa ser apresentada.

Os agregados agrupam por `(tokenMint, quoteMint, poolAddress)` e calculam janelas de 5s, 30s, 1m, 5m e 15m com `eventTimestamp`. As janelas distinguem:

- Número de compras, vendas, swaps e transações distintas.
- Compradores, vendedores e traders distintos comprovados por `wallet`.
- Montantes observados e quantidade de trades com dados financeiros ausentes.
- Primeiro/último preço observado, variação racional e semântica financeira.
- Frequência de swaps e fração da atividade atribuída à wallet mais ativa.

`walletAttributionComplete` e `volumeCompleteWithinObservedTrades` referem-se à amostra observada. Não afirmam traders únicos em toda a rede, owners completos ou volume global. A API seleciona no máximo 10.000 eventos recebidos nos últimos 15 minutos; dados mais antigos recuperados podem não integrar esse recorte. Eventos sem timestamp não entram em janelas on-chain e são contados como `untimedSwaps`/timestamps ausentes. Eventos no futuro ficam excluídos e identificados.

`quoteVolumeUsd`, `priceUsd` e `usd` ficam `null`; esta versão não implementa uma fonte SOL/USD atualizada. Market cap, graduação percentual, impacto estimado e liquidez disponível não são inferidos de preços/reservas sem as provas necessárias; os respetivos campos podem permanecer `null`.

## Segurança

O relatório de `security.mjs` usa estados `PASS`, `REJECTED`, `INCOMPLETE` e `UNKNOWN` por verificação. Examina owner Token Program/Token-2022, inicialização, supply, mint/freeze authority e extensões reconhecidas, incluindo transfer fees, hook, permanent delegate e pausable. Extensões desconhecidas/sem descodificação suficiente mantêm incompletude.

Um mint sem autoridades não recebe uma conclusão global de segurança: liquidez, distribuição de owners e histórico continuam por comprovar. O relatório conserva `tradeApproved: false` e `securityConclusion: null`. A opção de maiores token accounts, quando chamada pela biblioteca, é uma amostra; não prova número de holders distintos nem distribuição de supply por proprietário. O enriquecimento automático é opt-in e limitado pelo mesmo orçamento RPC, guardando o último relatório por mint.

## Checkpoints, lacunas e leitura

Um checkpoint contém assinatura, slot, timestamp de recuperação, continuidade e âncora anterior. Uma continuação guarda `before`, cabeça original e alvo; um limite de páginas com história ainda disponível conserva o checkpoint antigo até concluir a procura. `RPC_ANCHOR_REACHED` comprova apenas continuidade dos resultados `getSignaturesForAddress` até à âncora, não cobertura de toda a atividade Solana. Limite inicial, história podada, indisponibilidade de transações, backpressure e falhas RPC ficam em `gaps`.

`/observations?mint=...&wallet=...&pool=...&signature=...&limit=...` filtra observações incompletas de logs; `/events?mint=...&wallet=...&signature=...&limit=...` filtra eventos canónicos por identidade; `/tokens`, `/market`, `/gaps`, `/security?mint=...` e `/health` fornecem projeções e contexto operacional. Os endpoints são GET-only, com `cache-control: no-store`; `coverage` permanece `PARTIAL`. Não existem endpoints para modificar políticas, scoring, permissões ou executar transações. Agentes futuros devem consumir estas interfaces e respeitar o estado, timestamps, campos desconhecidos e limites de retenção.

`wallet` representa o ator atribuído pelo evento ou pelo papel da conta da instrução. Não prova o beneficiário económico final de um router/PDA nem propriedade comum entre carteiras. `distinctTraders` conta atores atribuídos distintos dentro do subconjunto observado; não é um censo de pessoas ou de traders globais.

Recuperação com transação indisponível: após oito falhas, a observação fica `UNAVAILABLE` com retry durável e cooldown progressivo (pelo menos 60s). O scanner pode continuar as páginas seguintes depois de persistir a lacuna `HISTORY_TRANSACTION_HOLES`; o checkpoint resultante permanece `PARTIAL`, mesmo tendo encontrado a âncora. Esses jobs não são removidos pela retenção de trabalho concluído. Um retry posterior que obtém a transação resolve a lacuna específica; `recovered` só conta dados efetivamente concluídos, nunca uma simples promessa do callback.

Falhas `confirmed` e revogações não finais continuam a ser reconciliadas. Um erro de estágio mais fraco não finaliza a revogação de evidência mais forte. Se uma falha anterior volta a aparecer com sucesso, os eventos ficam `UNRESOLVED` até enriquecimento fresco. Uma reexecução noutro slot conserva a versão bruta anterior em `raw_transaction_revisions` durante a retenção configurada e atualiza os índices dos eventos atuais.

A deduplicação vale para as identidades ainda retidas. A retenção pode remover um registo e permitir nova inserção se a mesma evidência antiga voltar a ser recebida; contadores acumulados de inserção não são um índice de eventos únicos vitalícios. O scanner não mantém um conjunto ilimitado de todas as signatures da rede.
