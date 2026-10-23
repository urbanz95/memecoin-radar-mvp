# Recolha real inicial — 19 de outubro de 2026

Última passagem: `2026-10-19T20-29-32-963Z-97860e4e`, concluída às **2026-10-19T20:31:00.681Z**. Snapshot histórico; não é um sinal atual.

| Observação | Resultado |
|---|---:|
| Chain ID | 4663 (mainnet) |
| Bloco fixado | 92898135 |
| Pools no catálogo após duas passagens | 7906 |
| Endereços de tokens candidatos com pares WETH/USDG | 2984 |
| Contratos enriquecidos nesta passagem | 4 |
| Pedidos RPC nesta passagem | 244 |
| Duração | 87.7s |
| Avaliações dos dois pipelines | 8 |
| Candidatos aprovados / alertas | 0 |

O catálogo passou de 5.032 para 7.906 pools, confirmando a retoma do cursor e o alargamento do histórico. A cobertura inclui Uniswap v2/v3/v4 nos deployments configurados, uma janela recente, backfill contíguo parcial e amostras históricas. Não é toda a Robinhood Chain e não prova que todos os tokens sejam memecoins.

Todas as avaliações desta passagem ficaram `INCOMPLETE`. O RPC respondeu às leituras de estado/eventos, mas recusou a leitura histórica de bytecode (`-32000`) e não disponibilizou `debug_traceTransaction` (`-32601`). Não se inferiu a data do contrato a partir da pool. O explorador tinha devolvido HTTP 403 na verificação inicial.

Foram arquivados bytecode/hash, metadados, slots de proxy, estado de pools e volumes/preços em quote currency. Não se converteram valores WETH/USDG em USD sem preço verificado, nem se inventaram holders, insiders, organicidade, locks ou simulações de venda.

Os testes do motor, scanner e collector passaram. As respostas RPC e snapshots reais estão em `runtime/onchain/runs/`; o estado atual fica em `runtime/onchain/latest.json`. Estes dados estão excluídos do Git e do ZIP do código. O pacote separado de evidência inclui as duas sessões concluídas e o bundle atual.

Para continuar a recolha: `npm run collect:watch`. Para completar sinais aprovados, seguir as limitações e integrações descritas em [ONCHAIN.md](ONCHAIN.md).
