# Consumo RPC e custo observado

Foram usados endpoints públicos Solana Mainnet, sem API paga ou credenciais de carteira. Não foi contratado qualquer serviço, efetuado upgrade, deploy ou operação financeira. O custo monetário adicional contratado nesta execução foi zero; os relatórios não medem o custo de disponibilizar uma máquina com disco persistente.

## Contadores reais

`rpc_requests` conta tentativas de pedidos HTTP, incluindo retries. Não é a quantidade de notificações WebSocket nem de transações únicas. `rpcRequestsPerMinute` é a janela móvel de 60 s do processo; a média abaixo é apenas `pedidos × 60 / duração observada`. Os limites configurados pertencem a cada processo, enquanto a quota do fornecedor pode ser partilhada por IP/host e por outros utilizadores.

| Fonte | Duração observada | Pedidos HTTP | Métodos contados | Erros de rate limit | Média derivada |
|---|---:|---:|---|---:|---:|
| [Ensaio inicial](../reports/mainnet-initial-60s.json) | 60,438 s | 48 | 1 genesis, 46 `getTransaction`, 1 `getSignatureStatuses` | 12 | 47,65/min |
| [HTTP interrompido](../reports/interrupted-http.json) | 952,081 s | 748 | 1 genesis, 716 `getTransaction`, 31 `getSignatureStatuses` | 14 | 47,14/min |
| [Smoke de logs](../reports/mainnet-logpath-smoke-23s.json) | 22,849 s | 3 | 1 genesis, 2 `getTransaction` | 0 no contador | Janela curta, inclui arranque |
| [Logs interrompidos](../reports/interrupted-logs.json) | 304,226 s | 31 | 1 genesis, 21 `getTransaction`, 5 `getSignaturesForAddress`, 4 `getSignatureStatuses` | 1 | 6,11/min |
| [Probe de programas](../reports/mainnet-program-probe.json) | 26,762 s entre início/fim | 10 | 1 genesis, 1 `getSlot`, 4 `getAccountInfo`, 4 `getSignaturesForAddress` | 0 no contador | Diagnóstico pontual |
| Nova janela de 3600 s | **IN_PROGRESS** | A preencher a partir do relatório real final | Orçamento HTTP configurado de 6/min, quatro programas e logs separados | Sem resultado aprovado | — |

A investigação adicional de graduação/migração e criação CPMM fez 11 chamadas RPC documentadas em [PROTOCOL-COVERAGE.md](PROTOCOL-COVERAGE.md), com duas respostas RPC `429`, intervalos de pelo menos 2,1 s e pausa superior a 60 s. Estes pedidos de investigação não são os contadores do serviço. Não existe um contador único comprovado de todas as consultas ad hoc realizadas para obter as primeiras fixtures; não se inventa esse total.

Os ensaios HTTP e logs interrompidos sobrepuseram-se parcialmente no mesmo host. As médias/erros não devem ser somados e apresentados como uma única janela independente. Os counters de erro RPC e de rate limit também não são quantidades aditivas: o rate limit é uma categoria de erro.

## Relação entre RPC e cobertura

A tentativa por logs recebeu 108.927 notificações e persistiu 27.843 observações com apenas 31 tentativas HTTP. Isso demonstra que a deteção por logs não exige uma chamada por notificação; não demonstra contexto completo para todas. O serviço deixou de admitir 108.847 notificações para enriquecimento devido ao limite de capacidade, enquanto continuou o fluxo de observações suportadas. Só 19 transações foram enriquecidas nessa janela, com 15 eventos normalizados em `/events`.

O número de notificações não equivale a transações únicas: subscrições de programas podem observar a mesma signature e notificações com erro não fornecem swaps válidos. O número de observações também não é o de traders; uma transação pode emitir vários tipos de evento, incluindo atualização de curva. Os conjuntos de observações e eventos enriquecidos não devem ser somados para obter volume ou quantidade de swaps.

A captura HTTP inicial acumulou 5185 entradas pendentes. A tentativa longa HTTP ainda tinha 242 pendentes no último checkpoint; a captura tinha sido pausada por backpressure. O facto de o orçamento respeitar um máximo por minuto não significa que suporte a carga ou garanta um SLA. Foram observados 429 mesmo com pedidos espaçados, e o RPC público não ofereceu capacidade suficiente para enriquecimento integral.

## Política de controlo de custo

O cliente aplica uma allowlist de métodos read-only, limite global por processo, espaçamento sem burst, concorrência limitada, retries limitados e cooldown partilhado para 429/Retry-After. Histórico, confirmação e segurança consomem o mesmo orçamento. O serviço não executa polling agressivo de todos os tokens nem tenta contornar quotas com rotações de identidades/endpoints.

O armazenamento é SQLite local com WAL, lotes, índices, retenção temporal e limite por quantidade para observações. Não há uma escrita D1 por transação e não foram alteradas bases Cloudflare de produção. O limite de 15.000 observações usado na tentativa interrompida de logs foi atingido; havia 132.100.824 bytes contabilizados no último checkpoint, incluindo base e ficheiros auxiliares. O valor é uma medição desse ensaio, não um custo ou limite universal.

O próximo incremento de capacidade deve ser escolhido a partir de taxa real de transações únicas relevantes, cache, percentual de eventos que exigem contas e orçamento de histórico/finalização. As necessidades concretas são transporte WebSocket estável, capacidade HTTP sustentada e retenção histórica suficiente para a janela de desconexão; não se pressupõe Helius, Yellowstone pago ou infraestrutura enterprise.
