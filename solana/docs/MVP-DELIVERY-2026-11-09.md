# Solana Radar MVP — plano fechado até segunda-feira, 9 de novembro de 2026

**Objetivo único:** entregar um radar utilizável, com dados reais de Pump.fun/PumpSwap, sem apostar em lucros, cobertura total ou serviço público 24/7.
**Implementação de referência:** branch `feat/solana-mvp-20261109`, base PR #22, mais o plano central [issue #17](https://github.com/urbanz95/memecoin-radar-mvp/issues/17).

## Definição de entregue — critérios verificáveis

1. Abrir `http://127.0.0.1:8791/dashboard` no computador que executa o scanner: tabela de mints, atividade recente, estimativa FDV apenas quando há provas, e aviso de cobertura parcial; refresh do JSON a cada 15 segundos.
2. `GET /radar?limit=50` é endpoint JSON read-only, com mints distintos, contagens de compras/vendas em janelas 15/60/300 segundos, origem das observações, desconhecidos explicitamente marcados.
3. GitHub Actions executa prova Mainnet de 90 segundos e guarda `dashboard.html`, `radar.json`, `smoke.json`, `health.json` e `scanner.log`. O HTML pode abrir-se sem servidor após download.
4. Os testes Solana passam em Node 22 e 24; a prova real mostra pelo menos um mint observado e um evento de log confirmado, sem ultrapassar a quota definida do RPC público.
5. Candidatos com FDV verificável inferior a 95% de 5.000 USD ficam fora da tabela; o valor próximo do limiar ou desconhecido permanece. FDV é proxy das reservas Pump.fun e **não** market cap circulante.
6. Nunca apresentar observações como todas as transações de mercado. A amostra lê até 10.000 eventos retidos e pode conter menos de cinco minutos quando há muita atividade. Mostrar esta limitação.
7. Sem compras, auto-alertas, chaves privadas, APIs pagas, Codex, deploy ou merge automático.

## Calendário fixo

**Sexta, 6/11:** concluir dashboard, API, testes, workflow e primeiro relatório Mainnet. Corrigir apenas defeitos que impeçam a entrega.
**Sábado, 7/11:** testar robustez de deduplicação, dados incompletos, arranque/reinício e leitura em SQLite, sem novos módulos de análise ou scoring.
**Domingo, 8/11:** ensaio Mainnet curto final, verificar artefacto HTML/JSON, instruções e congelar funcionalidades.
**Segunda, 9/11:** fazer validação final e entregar links concretos, execução/CI, comandos e limitações. Se alguma prova falhar, não declarar sucesso: explicar exatamente o bloqueio.

## Utilização

Requisitos locais: Node >=22.13, acesso Internet e acesso ao RPC gratuito da Solana.

```bash
cd solana
npm ci --ignore-scripts
npm test
bash scripts/run-pump-focused.sh
```

Depois abrir `http://127.0.0.1:8791/dashboard` ou `http://127.0.0.1:8791/radar?limit=50`.
Sem instalação local: GitHub Actions > workflow **Solana MVP — live radar proof** > última execução válida > artefacto **solana-mvp-dashboard-evidence** > abrir `dashboard.html` descarregado. Trata-se de uma fotografia da execução; não é streaming 24/7.

## Fora do MVP — não alterar até segunda-feira

Copytrading, Telegram, score de lucro, novos fornecedores de RPC, análise completa de holders, bots, integração EVM/Robinhood, deploy público contínuo e automações de trading.
Não tocar em `main`, Fase3B, newsletter ou automação EVM. Não aumentar quota RPC para disfarçar o gargalo.

## Organização do trabalho

- O issue #17 é a fonte comum. O PR do MVP será draft, empilhado sobre #22; os antigos ficam intactos.
- Automação horária: só validar e melhorar esta entrega. Antes de qualquer alteração, verificar PR, CI e HEAD, não sobrepor branches. Não criar PRs por mera manutenção de métricas.
- Se estiver tudo verde, parar o alargamento do âmbito e reportar **MVP demonstrado**.
- Sinais continuam parciais: sem alegações de segurança, liquidez, volume global, vantagem comercial ou rentabilidade.
