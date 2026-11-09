# Cobertura observável e recuperação justa — 9 novembro 2026

**Âmbito:** scanner Solana Pump.fun/PumpSwap, alteração de código isolada até à revisão. Não altera R2, serviços cloud, rate limits, chaves nem trading.

## Diagnóstico aditivo de leitura segura

`GET /health` mantém `coverage: "PARTIAL"` e acrescenta `coverageDiagnostics`:
- Por protocolo configurado: contagem local de notificações RPC válidas (desde o arranque), eventos de logs descodificados, alertas do descodificador, primeira/última notificação, slot, existência e tipo de checkpoint, cursor de recuperação pendente e resumo da última tentativa histórica.
- Global: número de observações descodificadas/persistidas, falhas do descodificador, contextos ignorados pelo orçamento, limites e erros RPC, falhas SQLite, backlog pendente, latências P95 onde medidas.
- `networkWideCompletenessPercent` e `independentExpectedEventCount` são sempre `null`: não existe stream independente que forneça denominador para estimar percentagem.
- Não expõe assinaturas de transações do estado de recuperação, cursores, tokens, nomes, endpoints, credenciais nem chaves. Id de programa é público e fixo.
- Contadores são do processo em execução e reiniciam com o Render; checkpoints e cursores persistidos em SQLite/R2 são lidos sem os expor.

## Justiça no orçamento de recuperação

`Scanner.tickRecovery()` alterna o primeiro protocolo consultado a cada ciclo:
- ciclo 1: Pump.fun, PumpSwap;
- ciclo 2: PumpSwap, Pump.fun.

A política existente permanece: `SOLANA_RECOVERY_PAGE_SIZE=2`, `SOLANA_RECOVERY_MAX_PAGES=1`, 12 pedidos HTTP RPC/min no perfil Pump-focused. A continuação de páginas históricas continua persistida em `recovery_state`, e o checkpoint não avança quando há transações por resolver. Esta alteração **não** aumenta cobertura garantida nem promete recuperar todas as mensagens.

## Validação

- `npm ci --prefix solana --ignore-scripts`
- `npm test --prefix solana`
- Teste novo `test/coverage-diagnostics.test.mjs`: contagens por protocolo, ausência de percentagem fabricada, ocultação de assinaturas/cursores, informação de backlog e alternância de prioridade entre protocolos.
- Workflow `.github/workflows/solana-coverage-ci.yml` testa Node 22 e Node 24 e regressões R2 separadamente.

## Próximo passo

Validar CI antes de qualquer merge. Se aprovada, analisar métricas observadas de `/health` durante janela real e escolher um fornecedor/dado de referência independente para medir a proporção de eventos não recebidos. Sem isso, não declarar cobertura integral ou uma percentagem de perdas. **Não fazer deploy sem revisão explícita do impacto sobre base SQLite R2 e disponibilidade do serviço.**
