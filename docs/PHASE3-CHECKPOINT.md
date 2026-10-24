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

## Segundo checkpoint — implementação concluída

Runtime/accounting, ledger temporal e score por realização concluídos, incluindo frescura da compra canónica e proteção contra replay. A integração real de recibos → D1 → reinício → score foi testada. Suite completa: **511 testes passaram**; UI semanal: **5 cenários DOM passaram**. Configuração e build Cloudflare válidos. As provas locais estão em `runtime/phase3-wallet-completion/`.

As migrations continuam por aplicar até fechar os ensaios workerd e registar novo backup. Hash de `0008`: `f3a79d08482c417c05da3e8e349658d6fce0d6dbcbc9661e65c392d60ce3ad10`; hash de `0007` preservado. Parâmetros, interfaces e limitações: [WALLET-SCORING.md](WALLET-SCORING.md).

## Checkpoint final — fase 3 publicada

Código `3f6a199` publicado e guardado no GitHub. Verificação concluída com 511 testes, cinco cenários DOM, três ciclos workerd e RPC real. As migrations `0007`/`0008` foram aplicadas após o bookmark integral `00000020-000002bf-0000510e-36cd217d2dde7ce9fd6e4dbc70b3c641`; hashes preservados. Time Travel tem retenção de sete dias, sem export SQL offline.

- Cloudflare: `a38fe3b8-143b-4838-bf81-13295a4242a3`, cron a cada minuto.
- Vercel Hobby: `dpl_93GrwTCGXChKNNJoFnAaYXwXBY5Z`, alias `memecoin-radar-six.vercel.app`, estado `READY`.
- Método/versão ativos: `wallet-manual-v2` / `mvp-new-v3:45d248bff4b9a3ee`.
- Duas recolhas naturais no browser: 3.432 → 3.434 tokens, 400 → 401 decisões, 194 outcomes, 111 wallets acompanhadas e zero elegíveis. PnL desconhecido identificado e bloqueados ocultos. O único aviso de asset é o pedido implícito ao favicon (404), sem erro de página ou API.
- Nenhum envio Telegram, trade, X, modo B ou backtest/modelo foi executado/ativado.

O trabalho autorizado da fase 3 termina aqui. A recolha continua mesmo sem sessão do chat. Para uma retoma, ler este checkpoint e o [estado](MVP-PROGRESS.md); fontes de PnL fiável continuam pendentes e não se deve avançar para a fase 4 sem confirmação.
