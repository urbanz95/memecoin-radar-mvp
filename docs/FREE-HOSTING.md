# Collector gratuito e sem cartão — Workers Free + Durable Object SQLite + D1

## Estado e âmbito

A opção principal é **Cloudflare Workers Free + Durable Object SQLite Free + D1**, com um cron por minuto. O Worker encaminha o pedido para o único objeto `Collector` nomeado `main`; o DO executa a recolha e usa o RPC Pinax e o D1 existentes. O mesmo Worker serve o [dashboard estático na raiz](https://memecoin-radar-collector.radar-605437d4ee90.workers.dev/). O [espelho na Vercel Hobby](https://memecoin-radar-six.vercel.app) está publicado e lê os mesmos dados através de rewrites na mesma origem; ver [configuração](VERCEL.md). Não são necessários VPS, cartão, trial pago ou um repositório público. GitHub Actions continua apenas como CI; não é usado como servidor permanente. A Vercel também tem uma Function Node limitada para o endpoint fixo de mercado; não executa o cron nem guarda dados. As invocações e o tráfego consomem as quotas Hobby existentes.

**Publicado na Cloudflare em 21/10/2026**, após autorização da conta por device flow. O D1 foi criado, migrado e associado ao Worker; `wrangler.json` contém os identificadores reais e a migration `new_sqlite_classes` do DO. O cron por minuto está registado. Ver [estado, dados e operação](OPERATIONS.md). Não foram ativadas subscrições pagas.

O adaptador Free descobre pools nos deployments Uniswap v2/v3/v4 configurados, guarda cursores e pools em D1 e analisa um contrato por sessão. Com `ANALYSIS_ENABLED: "1"`, lê metadados, slots proxy, estado nativo das pools e uma amostra de atividade de até 512 blocos/64 logs; junta provas de idade e indicadores externos opcionais. Mantém listas de novos, estabelecidos e contratos sem idade comprovada. **A amostra não é a recolha completa de reservas e swaps do worker Node**, nem uma aprovação de compra. Não substituir métricas ausentes por zero nem apresentar `INCOMPLETE` como candidato. Ver [metodologia e estados](SCREENING.md).

## Limites gratuitos e cadência

Fontes oficiais consultadas indicam:

| Recurso | Plano gratuito |
|---|---|
| Workers | 100.000 invocações/dia, 10 ms de CPU por invocação |
| Durable Objects SQLite Free | 100.000 pedidos/dia, 13.000 GB-s de duração/dia, 5 GB de armazenamento por conta; 30 s de CPU por pedido |
| Subrequests | Até 50 por invocação |
| D1 | 5 milhões de linhas lidas/dia, 100.000 linhas escritas/dia, 500 MB por base e 5 GB agregados |

Confirmar também o limite por base de dados e o consumo de outros projetos na conta. Índices e eliminações contam para as escritas D1. Estes limites são do fornecedor e podem mudar; permanecer no plano **Free**. Ao esgotar quotas gratuitas, a recolha pode falhar ou parar até ao reset; o código não ativa upgrades.

O cron configura cerca de 1.440 invocações Worker e 1.440 pedidos ao DO por dia, além dos GET públicos. Só se usa o objeto nomeado `main`; não há alarmes nem timers recorrentes de agendamento. A espera de rede no DO também conta para a quota de duração em GB-s. Acompanhar o consumo conjunto de outros objetos e serviços da conta.

Enquanto está aberto, o dashboard consulta `/health` e `/latest` a cada 30 segundos na mesma origem. Esses GET adicionais também consomem quotas; não executam o collector. Fechar o browser termina apenas a atualização da página: o cron continua independente. Uma página JSON aberta diretamente em `/health` ou `/latest` mostra uma resposta fixa até ser recarregada; usar o dashboard para acompanhar alterações automaticamente.

Cada ciclo tem um **orçamento global de quatro eventos**, partilhado entre descoberta recente e backfill/amostra, e enriquece um contrato. Em ciclos alternados reserva-se um evento para a história quando o orçamento permite. `LOG_CHUNK=2048` limita cada intervalo a 2.048 blocos; os intervalos são reduzidos quando necessário. Um bloco denso é paginado por log index; o cursor não passa ao bloco seguinte antes de terminar. `coverage.recentBacklogBlocks` e `recentBlockPartial` expõem atrasos. O limite de eventos pode impedir acompanhar a cabeça da rede: o catálogo é parcial e não há garantia de analisar todos os blocos ou tokens por minuto.

A análise partilha o limite de **32 pedidos HTTP RPC por ciclo**, reservando os dois finais para revalidar a cabeça. A atividade da pool tem um orçamento separado da descoberta: lê até 512 blocos e só publica totais completos quando recebe até 64 logs válidos. Os pedidos externos de GoPlus, DEXScreener e Sourcify têm prazo de três segundos e não fazem retries imediatos. O mercado das até 20 entradas é renovado numa chamada conjunta DEXScreener por minuto. Respostas GoPlus/DEXScreener têm limite de 128 KiB; os metadados de idade Sourcify, 32 KiB, e o artefacto de código, 128 KiB. O estado persistente dos fornecedores tem teto de 32 KiB e cache de 120 segundos para mercado e 300 segundos para GoPlus, preservando a data original e aplicando backoff em falhas ou rate limits. Leituras adiadas ou indisponíveis ficam como lacunas.

A escolha de uma pool estimada entre 20 minutos e 48 horas, em parte da rotação, não comprova a idade do contrato. A classificação usa recibos canónicos ou existência de código em blocos com timestamps reais. Um limite de existência de bytecode não preenche `contractCreatedAt`; Sourcify fornece apenas candidatos até o recibo ser validado. As listas usam GoPlus apenas para riscos positivos e mantêm mercado DEXScreener identificado separadamente da pool on-chain. Flags negativas, zero taxas reportadas ou USD externos não bastam para aprovar o token.

Quando o atraso chega a `LOG_CHUNK`, em ciclos alternados procura-se também até um evento nos últimos 64 blocos, dentro do mesmo orçamento global. Esta descoberta seletiva começa junto da cabeça e preserva o cursor contíguo; não preenche o intervalo em atraso. `latestSampleRequestedRange`, `latestSampleRange`, `latestSampleBlockPartial` e `latestSampleLogOffset` mostram o âmbito e limites da amostra; `latestSampleIsCompleteIndex: false` mantém explícito que não é um índice completo. Descoberta contígua, amostra recente e história têm coberturas distintas.

A recolha direta no Worker mediu cerca de **23–55 ms de CPU**, acima do limite de 10 ms do Workers Free. A recolha foi transferida para o DO, cujo pedido tem um limite próprio de 30 segundos de CPU; o Worker só encaminha o cron, lê a resposta e serve os GET públicos. A espera da chamada ao DO não conta como CPU do Worker. Parse, ABI e avaliação correm dentro do DO. A [documentação de limites do Worker](https://developers.cloudflare.com/workers/platform/limits/#exceeded-cpu) recomenda este encaminhamento de computação para Durable Objects.

**Os testes locais não comprovam a CPU remota.** As primeiras amostras após a mudança para DO registaram p99 de 0,854 ms no cron do Worker e 3,227 ms num GET; são observações limitadas, registadas em [operação](OPERATIONS.md). Medir separadamente a CPU do Worker, erros `exceededCpu`, CPU/duração/pedidos do DO, linhas D1, atraso do cursor e RPC. Ajustar orçamento ou cadência dentro do Free se necessário, mantendo as limitações visíveis. Não aumentar o plano para contornar o orçamento.

## Persistência e segurança operacional

- D1 guarda controlo/lease, catálogo de pools, evidência e relatórios recentes. Não se usa disco temporário como estado persistente.
- O DO SQLite fornece o contexto de execução. O estado do collector mantém-se em D1; não foi migrado para o armazenamento interno do objeto. `POST /collect` existe apenas no binding interno. O Worker público serve o dashboard e os seus assets, além dos endpoints GET `/health` e `/latest`; não oferece um disparo público de recolha.
- Um lease de cinco minutos impede sobreposição. Um CHECK dentro da transação D1 impede publicar depois de perder o lease; snapshots, evidência e cursores são confirmados juntos.
- Falha não avança cursores, mantém o catálogo confirmado e reinicia a confirmação dos candidatos. Reorganizações invalidam catálogo e continuidade antes da nova publicação.
- Há apenas métodos RPC de leitura; a chain 4663 é obrigatória. Código/holders/LP/cotação não provados ficam desconhecidos. Não há carteira nem envio de swaps.
- A descoberta faz backfill contíguo e amostras históricas separadas. A altura da amostra de cerca de 14 dias é estimada por tempo médio de blocos e nunca usada como prova de criação do contrato.
- Evidência de cada sessão tem limite de 256 KiB e retenção de aproximadamente três horas. O catálogo é podado para 50.000 pools a cada 1.440 ciclos concluídos, dentro da mesma transação; entre podas pode crescer até cerca de mais 5.760 entradas. Têm prioridade as pools enriquecidas mais recentemente, incluindo antigas. A poda usa o índice existente e corre uma vez por dia de ciclos, evitando varrer 50.000 linhas a cada minuto. Não existe arquivo de backtest ilimitado. As referências `d1:runs:<id>` só são consultáveis enquanto a linha existir.
- O registo RPC tem teto agregado de 128 KiB e compacta entradas acima de 16 KiB. Guarda cabeçalhos e recibos projetados nos campos usados; bytecode fica como presença, tamanho e hash Keccak-256. Logs acima de 8 KiB e outros resultados acima de 2 KiB usam resumos SHA-256 do JSON, identificados por `evidenceFormat` e `rawRetained: false`; pode existir compactação adicional quando o total se aproxima do teto. `tokenFacts` guarda metadados tipados e referências, sem duplicar respostas brutas de `decimals` e `totalSupply`. O teto de 128 KiB aplica-se ao registo RPC; a evidência total com metadados continua limitada a 256 KiB. Não é um arquivo completo das respostas brutas. As respostas originais continuam a alimentar as validações, e o resumo não permite reconstruir dados omitidos. Ver [formato e limitações](SCREENING.md).
- As listas de acompanhamento têm até 20 contratos, seis horas e 64 KiB no estado de controlo D1 existente. São publicadas com o mesmo lease, fencing e commit, sem migration adicional. Cada entrada tem `observedAt` próprio; o dashboard assinala mais de dez minutos como desatualizado, mesmo que a recolha global continue saudável. A retenção de seis horas não prolonga a validade dos dados.
- O `/health` público devolve estado operacional, hora de sucesso e erro sanitizado. Mais de seis minutos sem sucesso tornam o estado `STALE`; erros e leases abandonados também ficam visíveis.
- O `/latest` público devolve a última observação datada, cabeça observada, cobertura, snapshots parciais e resultados registados dos dois pipelines. `dataStale` assinala uma cabeça com mais de 60 segundos ou um timestamp futuro inválido. `marketSignalsAvailable` assinala alertas de mercado `MARKET_ALERT` frescos, com segurança pendente; `currentSignalsAvailable` assinala apenas candidatos estritos válidos e ainda atuais. As duas flags são calculadas a partir dos resultados e das expirações, sem garantir que existam candidatos. Ambos os endpoints usam `no-store`; os dashboards na Cloudflare e na Vercel consultam-nos automaticamente. O espelho Vercel usa rewrites na mesma origem, com cache desativado; os endpoints Cloudflare não precisam de CORS para esta integração. Ver [integração Vercel](VERCEL.md).

## Arquivo MVP

A migration aditiva `0002_mvp_records.sql` cria um arquivo durável de avistamentos, primeiras decisões, eventos e outcomes. Não usa a retenção de três horas dos relatórios nem implica armazenamento ilimitado. Há limites por feature/fonte e contadores por triggers. Na 3B-1, a seleção de outcomes abrange até quatro tokens e 24 jobs por ciclo: preserva todos os jobs selecionados com janela aberta e limita a quatro apenas os retries de janelas expiradas, mantendo os restantes no backlog. O relatório semanal corre num job separado, uma coorte por invocação e páginas de até 64 KiB. Ainda falta política de arquivo externo/retenção de longo prazo. O ponto de recuperação anterior é D1 Time Travel com janela Free de sete dias; a exportação SQL falhou e não existe cópia SQL offline. Ver [auditoria](MVP-AUDIT.md), [dados](MVP-DATA.md) e [estado 3B](PHASE3B-STATUS.md).

## Preparar e ativar numa conta Free

1. Criar/usar uma conta Cloudflare gratuita, sem subscrever Workers Paid, R2 ou outro recurso pago. Confirmar **Workers Free**, Durable Objects **SQLite Free** e D1 na mesma conta. Usar `new_sqlite_classes` na migration; DO com armazenamento legado KV exige plano pago. Não enviar tokens nem passwords no chat.
2. No computador com este projeto e Node >=22, instalar dependências e autenticar na página oficial pelo código de dispositivo. São pedidos apenas os scopes necessários para a conta, Worker e D1:

```sh
npm ci --ignore-scripts
npx --no-install wrangler login --device --browser=false --scopes account:read user:read workers_scripts:write d1:write
```

Não colocar credenciais na linha de comandos nem enviá-las no chat. O helper não inicia login.

3. Verificar autenticação e conta sem alterar recursos remotos:

```sh
npm run cloudflare:activate -- --check
```

O check devolve apenas `READY`, `AUTH_REQUIRED`, `ACCOUNT_REQUIRED` ou `FREE_PLAN_CONFIRMATION_REQUIRED`. Usa `whoami --json` sem publicar email ou tokens. Se houver mais de uma conta, definir `CLOUDFLARE_ACCOUNT_ID` com o ID da conta escolhida. Uma conta já gravada em `wrangler.json` não é trocada automaticamente. O ID da conta e o ID D1 não são segredos.

4. Aplicar a migration local e validar sem criar deployment remoto:

```sh
npx wrangler d1 migrations apply DB --local
npm test
npm run cloudflare:check
npm run cloudflare:dev
```

O modo dev disponibiliza `/health`, `/latest` e o disparo local `/__scheduled`. Testar localmente com RPC simulado ou com o endpoint público; isso não ativa serviço remoto.

5. Confirmar no painel **Workers Free** na conta escolhida e rever a migration. `whoami` não informa o plano; a variável abaixo regista essa confirmação humana e não a substitui. Depois da confirmação:

```sh
RADAR_CONFIRMED_FREE_PLAN=1 npm run cloudflare:activate -- --check
RADAR_CONFIRMED_FREE_PLAN=1 npm run cloudflare:activate
```

O helper fixa a conta de destino, reutiliza o D1 `memecoin-radar` ou cria-o se necessário, preenche o placeholder, grava conta/ID em `wrangler.json`, aplica as migrations D1 remotas e publica o Worker com a primeira migration DO `v1-collector-do`/`new_sqlite_classes: ["Collector"]`. Um ID já configurado divergente causa erro; não é substituído automaticamente. Falha de migration impede o deploy. A saída é sanitizada.

A primeira publicação do DO e alterações das migrations exigem o deploy normal do helper. Só depois de essa migration estar aplicada, alterações exclusivamente de código podem usar `wrangler versions upload` e `wrangler versions deploy <version-id>@100% --yes`, preservando o agendamento. Não usar `versions upload` para introduzir a primeira classe SQLite.

O cron do deployment é `* * * * *` em UTC. Confirmar o trigger no painel. Não é um minuto exato garantido por token; medir as execuções e o backlog.

6. Abrir o dashboard na raiz do URL `workers.dev` e confirmar que novos timestamps e blocos aparecem sem recarregar manualmente. Consultar também `/health` e `/latest` e confirmar vários sucessos/blocos diferentes, depois observar pelo menos 24h. Usar Workers Metrics, Durable Objects Metrics e D1 Row Metrics para validar CPU, duração, quotas, atrasos e retenção. Não há monitorização externa ou mensagens Telegram nesta entrega.

O perfil Cloudflare usa o RPC público Pinax `https://robinhood.rpc.pinax.network`, listado nos docs Robinhood, através de `ROBINHOOD_RPC_URL` em `wrangler.json`. `ANALYSIS_ENABLED: "1"` ativa a análise e as listas no mesmo cron. Esses valores não contêm chaves. O worker Node mantém o endpoint canónico de `src/network.mjs` por omissão. Para usar um endpoint com credencial, retirar primeiro a variável pública do ficheiro e configurar `npx wrangler secret put ROBINHOOD_RPC_URL`; não colocar API keys em `wrangler.json`. O adaptador Cloudflare usa `fetch` nativo, objetos JSON-RPC para chamadas individuais e batches para várias chamadas, sempre com validação dos IDs; o worker Node usa `undici` para suportar proxies locais.

## O que já foi verificado

Build Wrangler sem deployment e migration D1 local passaram. Os testes executam as queries em SQLite real e verificam RPC → persistência → dois pipelines, lease, fencing, reorg, erro, expiração, batches de leitura e paginação sem perda de logs. Os testes de filesystem/Linux e do motor original continuam separados. O helper de ativação tem testes de autenticação, conta, guarda Free, reuso/criação D1 e falha de migration; o check real sem autenticação devolveu apenas `AUTH_REQUIRED`.

Em **20/10/2026 passaram dois ciclos locais no runtime workerd com D1 e RPC real**. Foram corrigidos o receiver usado para chamar `fetch` e o modo de redirects incompatível com o runtime. A prova local encaminha HTTPS pela ligação proxy deste ambiente; o Worker de produção usa `fetch` nativo. Ambos os ciclos confirmaram cron local, persistência, libertação do lease, `/health` e `/latest`. A última verificação terminou às 21:37:14 UTC, no bloco 93.766.882, com uma observação e os dois pipelines `INCOMPLETE`; o primeiro ciclo confirmou a amostra recente independente do backlog. A cobertura continuava parcial. Não houve candidato aprovado.

A arquitetura com DO passou **153 testes**, build Wrangler, dois ciclos determinísticos no workerd com DO/D1 e dois ciclos locais com DO e RPC real. Estes testes confirmam o encaminhamento e a persistência. Os dois crons naturais das 20:28/20:29 UTC de 21/10/2026 pertencem à verificação inicial anterior ao DO. A versão com DO foi publicada às 20:44 UTC; as primeiras métricas do Worker chamador e uma observação pública posterior estão registadas em [operação](OPERATIONS.md). A CPU/duração do DO e a estabilidade durante 24 horas ainda precisam de acompanhamento.

Em **22/10/2026**, a recolha deixou de confirmar novos relatórios após o sucesso das **14:12 UTC**, com `EVIDENCE_BUDGET_EXCEEDED`. O arquivo acumulava respostas RPC completas, incluindo bytecode repetido e logs de intervalos depois reduzidos, além de respostas brutas duplicadas nos metadados. A correção limita o registo RPC e remove essa duplicação. Um cron natural recuperado está documentado no registo de [operação](OPERATIONS.md). Esta recuperação não transforma os resultados parciais em tokens aprovados; não houve comprovação de 24 horas sem interrupções.

Também existem recolhas reais locais no worker Node; não são prova de cron remoto ativo. A passagem Node mais recente documentada terminou em 19/10/2026 às 23:05:12 de Lisboa, com catálogo de 10.854 pools, 4.121 contratos-alvo, quatro contratos enriquecidos e zero candidatos aprovados. Dados históricos e campos críticos em falta continuam identificados.

Alternativa para uma máquina já existente: [worker Linux completo](LINUX-WORKER.md). Não é necessário obter uma máquina para publicar o adaptador Cloudflare.

Fontes: [Workers: preços](https://developers.cloudflare.com/workers/platform/pricing/), [Workers: limites](https://developers.cloudflare.com/workers/platform/limits/), [Durable Objects: preços](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Durable Objects: limites](https://developers.cloudflare.com/durable-objects/platform/limits/), [D1: preços](https://developers.cloudflare.com/d1/platform/pricing/), [cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/). Quando o site de documentação bloqueou o acesso automatizado, foi consultado o [repositório oficial das mesmas páginas](https://github.com/cloudflare/cloudflare-docs/tree/production/src/content/docs).
