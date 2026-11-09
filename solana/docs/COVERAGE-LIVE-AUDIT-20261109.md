# Prova de cobertura em produção — auditoria de leitura apenas (09/11/2026)

## O que prova
Uma execução manual ou por push de `.github/workflows/solana-live-coverage-audit.yml` lê apenas:
- `https://solana-pump-radar-mvp.onrender.com/health` em dois instantes separados por 45 segundos.
- `https://solana-pump-radar-mvp.onrender.com/radar?limit=1` nos mesmos instantes.

Produz `solana-coverage-live-audit.json`, um artefacto GitHub Actions de sete dias e resumo de job. Faz leitura de dashboard apenas, sem credenciais, alteração do Render ou chamadas diretas ao RPC Solana. Não guarda listas de carteiras, mints, assinaturas, nem respostas JSON integrais. As chaves R2 nunca saem do Render.

A auditoria extrai:
- Estado do serviço, ligação WebSocket, último log e qualidade dos backups no processo atual.
- Crescimento das notificações por Pump.fun/PumpSwap, eventos de log descodificados e persistidos, alertas e backlog.
- Indicador de truncagem da amostra do radar (máximo 10 000 eventos retidos) e eventuais reinícios entre amostras.

Contadores são *do processo desde o último arranque*. Se `startedAt` muda, **não calcula diferenças** entre contadores de processos diferentes. `observedCoveragePercent` e `independentExpectedEventCount` são **sempre `null`**. Mesmo se o WebSocket receber eventos durante 45 segundos, isto **não demonstra** cobertura total. Inatividade também não demonstra que a rede esteve inativa. A health pública tem limitações e pode falhar com cold start (Render Free); nesse caso o resultado é `AUDIT_UNAVAILABLE`, não uma falsa conclusão.

## Próximo objetivo: testar fonte independente de transações

A documentação oficial confirma:
- `logsSubscribe` observa logs de transações que mencionam um endereço e não transporta a transação completa: https://solana.com/docs/rpc/websocket/logssubscribe
- `getSignaturesForAddress` devolve assinaturas históricas por endereço com paginação: https://solana.com/docs/rpc/http/getsignaturesforaddress
- Yellowstone gRPC sobre Geyser transmite transações completas, mas requer endpoint de fornecedor RPC e descodificação Protobuf/IDL; não confundir com API gratuita: https://solana.com/docs/payments/accept-payments/indexing

**Critérios para comparação, antes de integrar fornecedor:** permissões de uso comercial; preço e quotas livres realmente documentados; filtros por Pump.fun/PumpSwap; operações e duração de backfill; disponibilidade e latência; capacidade de obter assinaturas e transações completas; autenticação/segurança; formatos e cancelamento; métricas de deduplicação e perdas; ausência de Helius (restrição do projeto). Evitar fornecedores sem licença/termos e qualquer custo surpresa.

Fase de benchmarking proposta: recolher em paralelo dois streams autorizados durante uma janela definida, separar observações por compromisso/slot, deduplicar assinaturas e comparar *conjuntos observados* na mesma janela. Mesmo dois fornecedores em desacordo não definem um denominador global definitivo. Não implementar WebSocket adicional, fornecedor pago nem Geyser sem uma opção concreta, quota verificada e prova inicial.

## Segurança e rollout
Esta branch executa apenas uma prova externa do serviço atual, não modifica a aplicação em produção, `main`, R2, Render ou a newsletter. Não fazer deploy por este PR. Se a auditoria falhar, ler o código de erro e os logs do job; nunca marcar cobertura completa por omissão de dados.
