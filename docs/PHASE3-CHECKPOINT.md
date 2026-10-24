# Checkpoint da fase 3

Branch: `feat/phase3-wallet-scoring`, a partir de `b888ae5`.

Autorizado: terminar apenas a fase 3, manter dry-run, preservar o scanner e interfaces, fazer backup antes das migrations e parar antes da fase 4. A recolha publicada continua independente da sessão do chat.

## Primeiro checkpoint — 24/10/2026

- Verificação anterior concluída: 480 testes, outcomes reais e duas recolhas naturais no dashboard. Relatório: [verificação](MVP-VERIFICATION-2026-10-24.md).
- Relatório semanal por wallet score concluído, com 18 testes. Migration `0007` ainda não aplicada; SHA256 `b1cef39361d2e153b792cd53247e22975b9956e8cb17ee873c2a68699c84a779`.
- Configuração local preparada para `wallet-manual-v2`, pesos 50/30/20 e pelo menos cinco trades realizados; configuração anterior continua legível. Dez testes de configuração passaram.
- Em implementação: provas tipadas no runtime, primeira compra preservada, eventos de realização exatos e acumulação temporal por realização (`0008`). Os ficheiros parciais ainda precisam da validação integrada.
- Em implementação: apresentação das duas dimensões do relatório semanal no painel.
- A produção mantém a versão anteriormente verificada. Não aplicar `0007`/`0008` nem publicar esta continuação antes de concluir os testes e registar um novo backup.

## Próximos passos de retoma

1. Concluir runtime/accounting e temporal/scoring/ledger, preservando desconhecidos e replay explícito.
2. Validar collector, filtros, alertas dry-run, relatório semanal e UI; correr a suite completa e workerd.
3. Guardar novo ponto integral D1 Time Travel e hashes das migrations finais; aplicar apenas as migrations incrementais.
4. Publicar, verificar o cron e o painel com dados reais, guardar provas e fazer push do branch.
5. Atualizar este checkpoint e o changelog com o estado final e dados ainda em falta. Não avançar para X, modo B, backtest ou modelo.

Sem provas fiáveis de histórico, custo inicial, preços históricos, taxas e atribuição, o PnL continua `null`. Provas de lançamento, património inicial e financiamento/clusters são necessárias para entrada precoce, drawdown e independência das carteiras. Nenhum valor favorável pode ser assumido para gerar sinais.
