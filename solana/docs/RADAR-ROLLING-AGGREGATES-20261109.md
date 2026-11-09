# Scanner Solana — agregados temporais de logs (09/11/2026)

**Motivação confirmada por leitura real:** O scanner Pump.fun/PumpSwap recebe milhares de notificações por minuto, mas o perfil Render Free retém só 3 000 linhas de `event_observations`. Em produção o radar mostrava apenas 28–61 segundos dos 300 nominais, com `possibleTruncation=true` ([auditoria](https://github.com/urbanz95/memecoin-radar-mvp/issues/17#issuecomment-6730162550)). A correção não cria nenhuma nova fonte on-chain nem prova cobertura de toda a Solana.

## Implementação

- `radar_second_buckets`: SQLite, chaves `(second_start,mint,protocol)`, contagens observadas de eventos, compras, vendas e lifecycle; `first_at,last_at`.
- `radar_seen_ids`: ID verificado do log, chave única, guardada ~360 s; evita incrementar novamente mesmo quando o log bruto já foi removido devido ao limite de retenção.
- `radar_rollup_state`: primeiro evento observado após migração, para classificar a primeira janela de 15/60/300 s como aquecimento.
- `Store.persistLogBatch`: novos agregados, raw logs e deduplicação inseridos na mesma transação `BEGIN IMMEDIATE/COMMIT`; erro de qualquer tabela provoca `ROLLBACK` total. As tabelas existentes não são substituídas.
- Limpeza por tempo após cada batch: bins >300 s e IDs >360 s. Não há crescimento indefinido se a ingestão continuar; em inatividade, as consultas ignoram linhas antigas mesmo antes da limpeza.
- `Store.radarRollups`: SELECT agregado por mint, com buckets de 1 s e janelas 15/60/300 s. O limite é de **15 000 grupos por snapshot**, explicitamente marcado se atingido. Não altera o limite bruto de 3 000 nem a quota HTTP de 12/min.
- `Scanner.radar`: usa agregados para atividade, conserva evidência FDV apenas dos logs brutos disponíveis. Onde há FDV conhecido `BELOW_FLOOR`, mantém a exclusão; onde não há evidência suficiente mantém `FDV_UNKNOWN`. Nunca inventa contagens únicas de transações ou carteiras — permanecem `null`.
- `/dashboard`: mostra a origem dos agregados, o período desde a primeira observação e avisos de aquecimento/cap. A cobertura continua `PARTIAL`. Sem criação de sinais de compra/venda.

## Limites honestos

1. **Até 1 segundo pode ficar de fora** no início de cada janela, porque a fronteira inferior é arredondada ao próximo segundo inteiro. É uma contagem conservadora dos logs observados, não a contagem exata de todos os logs da rede.
2. Novas tabelas ficam vazias quando um backup SQLite anterior é restaurado. Os agregados precisam de **até 5 min** de ingestão para aquecer as janelas; não pressupor que os 3 000 logs brutos históricos cobrem cinco minutos, nem preencher buracos com zeros.
3. Se existiram lacunas WS, perdas por fornecedor, falhas de descodificação ou contexto RPC indisponível, as contagens agregadas continuam parciais. **Não demonstram cobertura global nem RPO=0.**
4. Reinícios recuperam as tabelas adicionadas quando o backup R2 contém essas alterações. Eventos depois do último snapshot R2 podem perder-se no Render Free, mesmo com esta correção. Primeira publicação exige migração aditiva; não apagar a SQLite. A nova versão só opera após *deploy*, não depois de fazer apenas merge.
5. Retenção de IDs por ~6 min não é uma deduplicação global permanente; uma replay extraordinária após esse prazo pode ser vista como nova observação. Contagens de carteiras/tx únicas, volume global, segurança e FDV histórico continuam desconhecidos/limitados.
6. O limite de grupos (15 000) protege RAM; ao atingir-se, `sample.possibleTruncation=true` e os totais tornam-se subconjuntos. O relógio e o tempo de receção são locais (não são tempo on-chain).

## Plano de testes e rollout

- `npm ci --prefix solana --ignore-scripts` (igual ao Render).
- `npm test --prefix solana` Node22 e Node24: integrações, deduplicação após poda, fronteiras, WAL/close/reopen, erro de SQLite com rollback e filtragem FDV.
- Suites offline R2 com o SDK fixado (Node22 e Node24).
- Verificar via Render **último `R2_BACKUP_OK` recente antes de publicar**. Não é possível forçar novo backup completo sem reiniciar a instância Free (sem Shell). Não fazer deploy a partir de uma cópia antiga sem aceitar o risco de perder os últimos eventos.
- Após deploy: verificar `RESTORED_LATEST`, LIVE, `R2_BACKUP_OK`, `/radar.sample.aggregationSource=DURABLE_SQLITE_1S_BUCKETS`; primeiro 15/60/300s serão `windowXXsPotentiallyTruncated=true` até aquecimento. Comparar `rawSamplePotentiallyTruncated` com `possibleTruncation` (agregados); só esta diferença demonstra que corrigimos o limite do dashboard.
- Confirmar CPU/RAM e tamanho da SQLite/R2 em produção, e usar um benchmark independente para qualquer estimativa de cobertura.

**Não tocar** no repositório `urbanz95/memecoin-intelligence`, `main`, EVM, Cloudflare Worker/D1, segredos, plano de Render, Helius, trading ou compras automáticas.
