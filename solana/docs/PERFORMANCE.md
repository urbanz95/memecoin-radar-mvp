# Desempenho observado

Os números abaixo foram medidos em Solana Mainnet. O caminho HTTP por assinatura não sustentou o fluxo integral dos quatro programas no RPC público. As observações por logs entregaram deteção mais rápida com contexto explicitamente incompleto. São duas métricas e dois conjuntos de dados diferentes.

## Definições e âmbito

- `eventProcessingLatencyMs`: tempo da receção RPC até ao COMMIT dos eventos enriquecidos de uma transação suportada recebida via WebSocket. A fila, o rate limiting e o enriquecimento fazem parte deste tempo.
- `logObservationLatencyMs`: tempo da receção RPC até ao COMMIT das observações suportadas por logs. As amostras são notificações com observações, não uma promessa de contexto completo por evento.
- `transactionEnrichmentLatencyMs`: tempo da chamada de enriquecimento, incluindo espera pelo cliente/orçamento, transporte e retries.
- `onchainToReceiveLatencyMs`: diferença entre blockTime disponível da transação e a receção RPC. O timestamp tem resolução/semântica de bloco e não mede o instante exato de cada instrução. O subconjunto enriquecido pode não representar todas as notificações.
- `recoveryProcessingLatencyMs`: recuperação histórica, separada das amostras de receção live.

Nos relatórios antigos, p50/p95/p99 são calculados sobre até às últimas 4096 amostras por métrica. `count` conta todas as amostras desde o início; `mean` também usa todas. Quando `count > retainedSamples`, o percentil final **não é** o percentil de toda a janela. A versão atual acrescenta 19 buckets cumulativos de memória fixa, limites superiores de quantis para todo o processo e `totalMaxMs`; esses limites são aproximações por bucket e não percentis exatos. Não se recalculam buckets cumulativos retroativamente a partir dos relatórios antigos.

## Medições reais preservadas

| Ensaio e fonte | Duração observada | Medição | Amostras / janela | p50 | p95 | p99 |
|---|---:|---|---|---:|---:|---:|
| [HTTP inicial](../reports/mainnet-initial-60s.json) | 60,438 s, concluído | Eventos enriquecidos | 22, todas | 21.490 ms | 53.671 ms | 53.829 ms |
| [HTTP longo interrompido](../reports/interrupted-http.json) | 952,081 s | Eventos enriquecidos | 316, todas | 113.354 ms | 552.646 ms | 579.701 ms |
| [Smoke de logs](../reports/mainnet-logpath-smoke-23s.json) | 22,849 s, encerrado por SIGTERM | Observações por logs | 1713, todas | 140 ms | 240 ms | 251 ms |
| [Logs interrompidos](../reports/interrupted-logs.json) | 304,226 s | Observações por logs | 4096 recentes, de 21.863 amostras totais | 165 ms | 280 ms | 332 ms |
| Mesmo ensaio de logs | 304,226 s | Eventos enriquecidos | 8, todas | 98.255 ms | 173.401 ms | 173.401 ms |
| Nova versão, janela contínua de 3600 s | **IN_PROGRESS** | Observar separadamente logs, enriquecimento e buckets cumulativos | Sem resultado final aprovado | — | — | — |

O primeiro ensaio inicial recebeu 5.494 notificações em cerca de 15 s antes de pausar a captura por sobrecarga. Ao fim de 60,438 s existiam 25 eventos enriquecidos e 5185 observações pendentes no inbox. Esta amostra inicial não demonstrou p95 <2 s sustentada; a medição integral de eventos desse ensaio falhou o objetivo.

Na tentativa HTTP longa, 702 transações foram enriquecidas e 439 eventos persistidos. A p95 de enriquecimento foi 6595,015 ms, enquanto a p95 de receção até evento persistido chegou a 552.646 ms: a acumulação na fila, além da chamada RPC, dominou a demora. Os 748 pedidos RPC incluíram 14 erros de rate limit. Restavam 242 entradas pendentes e a captura estava pausada no último checkpoint.

Na tentativa por logs foram recebidas 108.927 notificações, descodificadas 28.722 observações e inseridas 27.843 observações idempotentes. O catálogo retinha as últimas 15.000 por causa do limite configurado; o contador de inserções não é a quantidade ainda armazenada. Houve 10 reconexões e 15 registos de lacunas, que não representam 15 intervalos necessariamente independentes. A p95 final de 280 ms corresponde às últimas 4096 amostras, não a todas as 21.863 notificações suportadas medidas. A média de toda essa janela foi 191,274 ms. Os eventos enriquecidos continuaram lentos com o orçamento HTTP reduzido.

As tentativas longas foram interrompidas pelo reinício do ambiente em 2026-11-03 por volta das 22:09 UTC. O relatório HTTP conserva a última amostra às 22:09:12.639Z; o de logs às 22:09:08.900Z. Não completaram uma hora contínua. A interrupção não foi convertida em encerramento normal nem disfarçada como ausência de atividade.

## Latência on-chain separada

| Ensaio | Transações com timestamp utilizável | p50 on-chain → receção | p95 | p99 |
|---|---:|---:|---:|---:|
| HTTP inicial | 34 | 1630 ms | 1753 ms | 1753 ms |
| HTTP interrompido | 702 | 3012 ms | 3615 ms | 3617 ms |
| Logs interrompidos, subconjunto enriquecido | 16 | 3596 ms | 13.171 ms | 13.171 ms |

O último subconjunto é pequeno e selecionado pelo enriquecimento escasso. Não se generalizam estes valores à rede inteira ou aos eventos sem timestamp demonstrável. A latência local rápida de logs não elimina a demora anterior da notificação RPC.

## Gargalo e alternativas

O orçamento HTTP não acompanha centenas de notificações/s quando cada signature exige `getTransaction`. Depois do primeiro ensaio foram introduzidos espaçamento global sem bursts, cooldown partilhado perante 429, filas limitadas e controlo de admissão. O caminho de logs passa a persistir os campos binários demonstráveis sem esperar por uma chamada por transação. Mints, contas, índices, timestamps e decimais ausentes continuam desconhecidos; `/observations` não é somado a `/events` nem alimenta implicitamente `/market`.

Alternativas concretas para aumentar contexto/continuidade: reduzir o universo observado; manter cache de pools com evidência de criação e timestamps; priorizar enriquecimento apenas quando faltarem contas; reservar capacidade para reconciliação/backfill; avaliar uma fonte gratuita adicional autorizada ou capacidade HTTP sustentada compatível com a taxa real de transações únicas. O limite superior ingénuo de ~366 notificações/s no primeiro burst corresponderia a ~22.000 chamadas/min para enriquecimento por notificação, antes de deduplicar erros/rotas e aplicar cache. Isso é uma ordem de grandeza do gargalo, não uma recomendação de compra nem uma capacidade fixa necessária.

## Limites da medição

Os ensaios usaram o RPC público oficial, uma máquina partilhada e versões/configurações sucessivas do código. Alguns testes e instalações correram no mesmo host; os dois ensaios longos sobrepuseram-se durante parte do tempo e partilharam quota/recursos. Não são benchmarks isolados de hardware de produção. Os relatórios não provam estabilidade de 24 h, cobertura integral, ausência de eventos perdidos ou desempenho após upgrades dos programas.

O objetivo de 2 s deve ser avaliado por caminho e âmbito: observação de logs com contexto incompleto, evento enriquecido, ou atraso anterior na fonte. Uma medição favorável num destes caminhos não aprova automaticamente os restantes.
