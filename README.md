# Memecoin Radar

Dois pipelines configuráveis para triagem de memecoins **Robinhood Chain mainnet (EVM, chain ID 4663)**, com recolha automática no Cloudflare Free e listas de acompanhamento no dashboard. Os parâmetros e a evidência explicam cada decisão. O painel distingue alertas de atividade `MARKET_ALERT`, com segurança pendente, de candidatos `CANDIDATE` que passam a política estrita. Sem ordens, carteira, compras automáticas ou promessas de valorização.

| | Novos lançamentos | Tokens estabelecidos |
|---|---|---|
| Idade do contrato | 15 minutos–48 horas | ≥7 dias |
| Liquidez mínima | US$50 mil | US$150 mil |
| FDV | US$100 mil–10 milhões | US$500 mil–100 milhões |
| Maior holder / top 10 | ≤5% / ≤25% | ≤8% / ≤35% |
| Criador / insiders ligados | ≤2% / ≤10% | ≤3% / ≤15% |
| Holders mínimos | 200 | 1000 |
| Sinal de atividade | Volume e crescimento em 5m | Reaceleração em 1h e crescimento em 24h |
| Score mínimo | 75/100 | 75/100 |
| Confirmação | ≥3 observações ao longo de ≥2m | ≥2 observações ao longo de ≥15m |
| Cadência proposta | 60s | 300s |

Estes valores são **hipóteses iniciais conservadoras a calibrar**, sem backtest realizado. Segurança é uma condição obrigatória anterior ao score. O score não é uma probabilidade de lucro. Bloqueios, simulações e análises de carteiras reduzem alguns riscos, mas não garantem a venda nem impedem perdas ou rug pulls.

Esta rede é EVM e usa ETH para gas. Mainnet 4663 e testnet 46630 são ambientes distintos; a política de mercado rejeita a testnet. A política estrita aceita **WETH e USDG**, por contrato oficial, não apenas por símbolo. A descoberta e a análise de pools v4 também reconhecem **ETH nativo**, identificado pela moeda zero do protocolo; não o confundem com WETH nem alteram a política estrita. [Configuração oficial](https://docs.robinhood.com/chain/connecting/) e [contratos oficiais](https://docs.robinhood.com/chain/contracts/).

## O que está implementado

- Políticas versionadas em [`config/policies.json`](config/policies.json), motor dos dois pipelines, explicação dos filtros e decomposição do score.
- Alertas de mercado independentes em [`config/market-signals.json`](config/market-signals.json): filtros de idade, liquidez, FDV, volume, transações, compras, aceleração, preço e confirmação. Têm score próprio e `tradeApproved: false`. Os parâmetros ainda não têm backtest; um alerta não aprova compras.
- Atualização conjunta do mercado das até 20 entradas numa chamada DEXScreener por minuto, com timestamps próprios, cache persistente limitado e recuo automático perante falhas ou limites do fornecedor. Os dados USD externos alimentam estes alertas e continuam separados dos snapshots estritos.
- Controlos EVM de bytecode/código verificado, mint adicional, pause/blacklist, taxas alteráveis, confisco, proxies atualizáveis, privilégios ocultos, chamadas externas, honeypots e hooks de pools. Um `owner` renunciado não substitui esta análise.
- Verificação declarativa de chain ID, saúde do sequenciador, cabeça da rede e reorganizações; identidade de contratos normalizada sem duplicações por capitalização. A confirmação do sinal exige também avanço de blocos.
- Rejeição de dados críticos em falta, inválidos ou expirados; confirmação com observações distintas; reinício da confirmação após falha, intervalo excessivo ou alteração da política.
- Scanner de ficheiros JSON, modo contínuo, estado persistente, relatório atómico e eventos locais de candidato sem duplicação durante a mesma sequência válida.
- Collector on-chain de leitura para o RPC da mainnet: descoberta de pools Uniswap v2/v3/v4, catálogo persistente, backfill, amostras históricas, metadados/bytecode/storage dos tokens, reservas/estado das pools e swaps em quote currency. Cada execução alimenta os dois pipelines e arquiva a evidência RPC.
- Opção principal sem cartão: cron leve em Cloudflare Workers Free → um Durable Object SQLite Free `Collector` → RPC Pinax + D1, publicado em 21/10/2026. O cron encaminha uma chamada por minuto; a recolha corre no DO, com limite de CPU de 30 segundos por pedido. Cada ciclo aceita quatro eventos, intervalos de até 2.048 blocos e metadados de um contrato. A descoberta combina cursores contíguos e amostras recentes/históricas. Evidência de três horas e catálogo com poda diária para 50.000 pools limitam o armazenamento. O catálogo é parcial e pode acumular atraso. Estado e resultados estão nos [endpoints de operação](docs/OPERATIONS.md); ver também [limites gratuitos](docs/FREE-HOSTING.md). O [painel na Vercel Hobby](https://memecoin-radar-six.vercel.app) consulta os dados da Cloudflare a cada 30 segundos, através de rewrites na mesma origem. A página também permanece disponível no Worker.
- Análise por contrato com `ANALYSIS_ENABLED=1`: estado nativo das pools v2/v3/v4, preço em quote currency, amostra de atividade de até 512 blocos/64 logs, metadados e slots proxy. Recibos canónicos podem provar a criação exata; bytecode histórico permite classificar faixas etárias sem inventar uma data. GoPlus e DEXScreener acrescentam indicadores externos identificados; Sourcify é opcional. As listas de novos, estabelecidos e sem classificação mantêm riscos, lacunas, prioridade de revisão e timestamps próprios. [Âmbito e metodologia](docs/SCREENING.md).
- Quatro verificações adicionais com datas próprias: artefacto de código recompilado comparado ao runtime, histórico de holders conciliado com emissão e saldos on-chain, queima de LP v2 sem contar a liquidez mínima e compra/venda v2 em WETH por simulação efémera. A análise mantém o contrato por três ciclos para distribuir essas leituras dentro do orçamento gratuito, guardando progresso e distinguindo provas parciais de completas.
- Worker Linux completo opcional, com reservas/swaps, disco persistente, lock do kernel, systemd, saúde e retenção limitada. Usar apenas se já existir máquina adequada; não é necessário para o adaptador Cloudflare.
- Demonstração sintética e testes automatizados, incluindo RPC simulado, idade, fontes externas, análises de pools, verificações de segurança e limites de evidência acumulada. `viem` descodifica ABI e `undici` suporta HTTP com o proxy do ambiente. As provas locais e a validação das versões publicadas estão registadas em [operação](docs/OPERATIONS.md).

**Continuam pendentes para aprovação estrita:** auditoria conclusiva de código e roles, financiamento de insiders/bundles, proteção de todas as pools relevantes e de posições v3/v4, lockers e datas de desbloqueio, simulação do montante configurado de 100 USD, preços USD reconciliados on-chain, organicidade e backtest. A simulação implementada prova uma execução de 0,001 WETH numa pool v2; não substitui a prova de 100 USD. Mercado externo e flags negativas de fornecedores não substituem evidência ausente. Um risco conhecido produz `BLOCKED` mesmo quando falta a idade exata; as demais lacunas continuam visíveis. As listas de acompanhamento podem ter métricas e classificação etária enquanto a aprovação estrita permanece `INCOMPLETE`. A descoberta cobre os deployments configurados e está em backfill; não é um índice completo da rede nem classifica automaticamente tokens como memecoins. Alterar `synthetic` para `false` não verifica a origem de um ficheiro. Telegram e execução de operações são etapas posteriores.

## Executar

Node.js 22 ou superior. Instalar as dependências fixadas no lockfile:

```sh
npm ci --ignore-scripts
npm test
npm run validate
npm run demo
```

Para preparar a ativação Cloudflare, autenticar através da página oficial e verificar os requisitos:

```sh
npx --no-install wrangler login --device --browser=false --scopes account:read user:read workers_scripts:write d1:write
npm run cloudflare:activate -- --check
```

O check não altera recursos remotos. Exige uma conta inequívoca; se existirem várias, definir `CLOUDFLARE_ACCOUNT_ID`. Depois de confirmar **Workers Free** nessa conta, executar `RADAR_CONFIRMED_FREE_PLAN=1 npm run cloudflare:activate`. O helper reutiliza/cria o D1 `memecoin-radar`, grava conta/ID, aplica as migrations D1 e publica o cron e a primeira migration do DO SQLite (`new_sqlite_classes`). A variável regista a confirmação humana; `whoami` não verifica o plano. Não enviar tokens no chat. Ver o [fluxo completo de ativação](docs/FREE-HOSTING.md).

O [painel com atualização automática na Vercel Hobby](https://memecoin-radar-six.vercel.app) consulta os dados a cada 30 segundos enquanto está visível. Mostra separadamente a última consulta e a última recolha. O cron Cloudflare continua a recolher quando o browser está fechado. Os endpoints JSON são respostas únicas, sem atualização automática de um separador aberto. A Vercel encaminha `/health` e `/latest` para o worker, que serve [estado operacional](https://memecoin-radar-collector.radar-605437d4ee90.workers.dev/health) e [observações datadas](https://memecoin-radar-collector.radar-605437d4ee90.workers.dev/latest), com cobertura e resultados registados. `/latest` calcula `marketSignalsAvailable` para alertas de mercado frescos e `currentSignalsAvailable` para candidatos estritos válidos. Ambos podem permanecer `false` quando não há resultados que cumpram os respetivos critérios. A resposta revalida as expirações e a cabeça da rede em cada leitura; `MARKET_ALERT` mantém segurança pendente e não autoriza uma operação. Ver a [configuração publicada na Vercel](docs/VERCEL.md).

O mesmo cron analisa um contrato por vez e mantém a pool durante três ciclos para holders, LP e simulação; a descoberta continua a cada ciclo. A seleção aproximada de pools entre 20 minutos e 48 horas apenas escolhe o que ler; a classificação exige provas reais de idade. Até 20 entradas ficam retidas durante seis horas, com limite de 64 KiB no estado D1 existente e sem nova migration. O progresso de segurança tem limite separado de 512 KiB. Cada contrato e cada módulo conservam a sua hora de análise; observações com mais de dez minutos ficam desatualizadas. As métricas externas usadas pelos alertas expiram após 120 segundos, independentemente da atualização do resto da página. A prioridade de análise não equivale a aprovação de compra. Ver [listas e critérios](docs/SCREENING.md).

A recolha direta no Worker mediu cerca de 23–55 ms de CPU, acima dos 10 ms do Workers Free, e foi movida para o DO. O Worker conserva o cron leve e os GET públicos `/health` e `/latest`. A nova arquitetura passou testes locais, incluindo dois ciclos com DO e RPC real. As primeiras métricas remotas do Worker após a mudança registaram p99 de 0,854 ms no cron e 3,227 ms num GET. Estas amostras não comprovam estabilidade durante 24 horas nem medem a CPU e duração do DO. Um único objeto nomeado `main` recebe cerca de 1.440 chamadas/dia, sem alarmes ou timers recorrentes. Workers, DO e D1 têm quotas gratuitas; esgotá-las causa erros ou suspensão até ao reset, sem upgrade automático.

Para recolher dados reais e avaliar ambos os pipelines:

```sh
npm run collect
npm run collect -- --max-tokens 4
npm run collect:watch
```

O collector usa o RPC público oficial, apenas com métodos de leitura. Para um fornecedor dedicado, configurar `ROBINHOOD_RPC_URL` no ambiente do servidor; não usar uma chave de carteira. O bundle atual fica em `runtime/onchain/latest.json`, com cobertura, lacunas, snapshots, avaliações e estado. A evidência fica em `runtime/onchain/runs/`. `PARTIAL` significa recolha executada com métricas críticas ainda por comprovar, não “todos os tokens seguros”. Ver [recolha on-chain](docs/ONCHAIN.md).

Para o novo worker Linux com arquivos comprimidos e recuperação após falhas:

```sh
npm run worker -- --once
npm run worker
npm run worker:health
```

O worker usa `runtime/worker/` por omissão, separado da CLI manual. Num servidor permanente, o instalador systemd em `deploy/install-worker.sh` configura `/var/lib/memecoin-radar`, arranque no boot e reinício automático. Não correr a CLI manual no mesmo diretório. Esse modo precisa de uma máquina disponível. A opção principal sem cartão usa [Workers Free + DO SQLite Free + D1](docs/FREE-HOSTING.md), com âmbito de recolha menor e limites de CPU/quotas a validar remotamente.

A demo usa um relógio fixo e dados fabricados, mostra os dois pipelines a chegar a `CANDIDATE` e um token inseguro a ser bloqueado. O relatório fica em `runtime/demo-report.json`. **Não contém oportunidades reais.**

Esta versão usa o contrato de dados **v2**, com `contractCreatedAt`, `chainId`, `environment` e `chainState`. Snapshots v1 são rejeitados e a continuidade anterior é reiniciada pelo hash da política. Os endereços canónicos e referências da rede estão em [`src/network.mjs`](src/network.mjs); o ficheiro contém metadados, não um adaptador RPC.

Para avaliar um array de snapshots normalizados de forma independente, incluindo um ficheiro `.snapshots.json` arquivado pelo collector:

```sh
npm run scan -- --input /caminho/snapshots.json
npm run watch -- --pipeline new --input /caminho/novos.json --output runtime/new.json
npm run watch -- --pipeline established --input /caminho/estabelecidos.json --output runtime/established.json
```

Cada processo tem o seu relatório e estado. O produtor atualiza o input por rename atómico. Uma execução termina com erro se o JSON estiver inválido; o relatório de erro não mantém candidatos antigos. Um input vazio remove os candidatos e o estado anteriores. Snapshots repetidos não contam como novas observações. O modo `all` avalia ambos os pipelines a cada 60s e exige dados frescos para ambos; para recolha em cadências distintas, usar os dois processos acima. `npm run scan -- --help` mostra as opções.

Os alertas são **eventos locais**, não mensagens enviadas. O relatório do scanner contém `results`, `alerts` e `state`; o bundle do collector guarda continuidade em `evaluationState`. `CANDIDATE` significa apenas que passou a política com os dados fornecidos; o consumidor tem de revalidar a atualidade dos dados antes de o apresentar como atual. O collector já avalia os dois pipelines, sem ser preciso arrancar outro scanner sobre o mesmo output.

O campo `finalityStage` distingue confirmação pelo sequenciador, publicação em Ethereum e finalização em Ethereum. A confirmação temporal de um candidato não equivale a finalização da rede. Esta política de observação admite dados do sequenciador e não autoriza liquidação ou execução financeira. [Etapas oficiais de finalização](https://docs.robinhood.com/chain/transaction-finality/).

## Documentação

- [Parâmetros, score e estados](docs/PARAMETERS.md)
- [Análise automática, idade e listas de acompanhamento](docs/SCREENING.md)
- [Contrato dos dados e regras de normalização](docs/DATA-CONTRACT.md)
- [Recolha RPC, cobertura, execução e limitações](docs/ONCHAIN.md)
- [Resultados da recolha real inicial e limitações observadas](docs/LIVE-COLLECTION.md)
- [Integrações e preparação para GitHub, Vercel e Telegram](docs/ARCHITECTURE.md)
- [Cloudflare: recolha gratuita e sem cartão](docs/FREE-HOSTING.md)
- [Operação do collector publicado](docs/OPERATIONS.md)
- [Worker Linux completo opcional](docs/LINUX-WORKER.md)
- [Página gratuita na Vercel Hobby](docs/VERCEL.md)
- [Validação histórica e critérios para revisão dos limiares](docs/VALIDATION.md)

A pasta é independente do projeto que já existia no ambiente. O collector está publicado na Cloudflare e o dashboard na Vercel Hobby. O repositório GitHub e o bot Telegram são etapas posteriores; a publicação atual na Vercel não tem integração Git.
