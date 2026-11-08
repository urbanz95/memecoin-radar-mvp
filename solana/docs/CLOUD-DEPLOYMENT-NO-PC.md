# Radar Solana sem computador ligado — implantação cloud do MVP

## 8 novembro — perfil para RPC público sobrecarregado

Na amostra real do Render às 00:47 UTC, os logs estavam ativos, mas o contexto HTTP tinha backlog 64/64 e apenas 12 pedidos/min. O perfil **apenas cloud** passa a aplicar:

- `SOLANA_CONTEXT_MAX_PRIORITY=0`: só eventos P0 de ciclo de vida (criação, pool, migração) entram na fila de `getTransaction`; P1/P2/P3 continuam nas observações de logs verificadas e NÃO são transações enriquecidas. Isto reduz trabalho fútil, não aumenta cobertura global.
- `SOLANA_CONTEXT_MAX_AGE_MS=90000`: fechar pedidos de enriquecimento de logs **ainda não processados** quando passam 90 segundos. A linha do inbox fica como `EXPIRED`; eventos observados e entradas de recuperação independentes NÃO são apagados nem convertidos em trades.
- `SOLANA_SOL_USD_FALLBACK=true`: se o CoinGecko falhar, tentar uma única consulta ao endpoint público Kraken `SOLUSD` na mesma janela de refrescamento de 120 segundos. O ticker Kraken devolve o **preço do último negócio**, sem timestamp da negociação. O valor fica identificado como `kraken_SOLUSD_last_trade_fetched_not_trade_timestamp` e a data é a hora da consulta, não a hora da transação. Se ambas as fontes falharem, FDV permanece UNKNOWN.
- No dashboard, `WebSocket ligado` com `scanner degradado` distingue-se claramente de `SEM WEBSOCKET`. O dashboard continua a apresentar amostras limitadas, não sinais de trading.

Estas opções não alteram a configuração local padrão (`maxPriority=3`, TTL desativado e fallback desativado). O orçamento HTTP continua **12/min**, o limite de retenção cloud continua **3000 observações** e a classificação de FDV continua a exigir evidência de criação, reservas e cotação válida. É esperado que a saturação das observações seja visível; o perfil reduz especificamente a sobrecarga do **enriquecimento HTTP**, não promete guardar toda a atividade.

**Não fazer deploy apenas por passar CI**: validar no Render a transição dos contadores, as amostras e a cotação após o deploy. A alteração não melhora a persistência da SQLite efémera no Render Free.



**Objetivo obrigatório:** dashboard remoto e o scanner Node.js existentes em servidores externos. O HTML guardado pelo GitHub Actions é apenas um snapshot; não substitui o serviço remoto.

## Arquitetura gratuita — uma só linha de produto

- **Render Free Web Service:** executa o scanner Node.js real (WebSocket Pump.fun/PumpSwap, SQLite transitório, filtro FDV e API `/dashboard`, `/radar` e `/health`). A aplicação passa a ouvir em `0.0.0.0:$PORT` através de `solana/scripts/run-cloud.sh` e mantém o limite de 12 HTTP RPC/min.
- **Cloudflare Worker gratuito:** Cron Trigger de **5 em 5 minutos** envia um `GET` exclusivamente para o `/health` do Render. O código valida que o destino é `https://<nome>.onrender.com/health`, impedindo que a variável seja transformada num proxy genérico.
- **Sem computador ligado:** depois de as duas ligações serem concluídas, ambos os processos são executados por terceiros. Nenhum usa o PC local. O Cloudflare não recebe os logs Solana nem guarda chaves de carteira.
- **Sem memória histórica garantida:** Render Free tem disco efémero. Reiniciar/suspender/reimplantar perde a SQLite, e o radar começa uma nova amostra de cinco minutos. Isto é aceitável para um MVP de observação, **não** para backtests ou estatísticas acumuladas.

**Não prometer disponibilidade 24/7.** Render Free pode adormecer após 15 minutos sem tráfego HTTP de entrada, reiniciar por manutenção, suspender por esgotamento de horas/banda ou por tráfego externo elevado. O heartbeat a cada 5 minutos reduz o risco normal de suspensão, mas não é um SLA e a execução depende da quota existente na conta Render e no Cloudflare. O RPC público Solana também pode limitar/bloquear endereços de datacenters. Este modo não está validado até existir deploy verdadeiro e observação contínua de health.

## 1. Ligar o Render — uma ação do utilizador

Pode instalar a integração **Render** do ChatGPT e autorizar o acesso, para podermos gerir o deploy diretamente, ou usar a interface do Render:

1. Em [Render Dashboard](https://dashboard.render.com/), escolher **New > Blueprint**.
2. Ligar GitHub e selecionar **urbanz95/memecoin-radar-mvp**.
3. Selecionar **branch `feat/solana-cloud-hosting-20261106`** e o ficheiro `render.yaml` na raiz; escolher plano **Free**, sem alterar para um plano pago.
4. Aprovar o serviço **solana-pump-radar-mvp**. O blueprint já configura a build, Node 24, launcher cloud, a porta pública e limites RPC. Não são precisos tokens de carteira.
5. Obter o URL HTTPS efetivamente atribuído pelo Render. Confirmar no navegador `https://<URL_REAL>/dashboard` e `https://<URL_REAL>/health`. O endpoint health pode responder `DEGRADED` devido à sobrecarga; **HTTP 200 não significa cobertura completa**.

## 2. Ligar o Cloudflare — uma ação do utilizador

1. Em [Cloudflare Workers & Pages](https://dash.cloudflare.com/), selecionar **Create application** e ligar o repositório GitHub `urbanz95/memecoin-radar-mvp` através de Workers Builds.
2. Escolher como **branch de produção `feat/solana-cloud-hosting-20261106`**, raiz **`cloud/keepalive`** e nome do Worker **`solana-radar-keepalive`**.
3. Build: `npm install --ignore-scripts`. Deploy: `npx wrangler deploy` usando `wrangler.toml` deste diretório. Escolher o plano **Workers Free**.
4. Depois de publicar, abrir **Settings > Variables and Secrets** no Worker e definir a variável não secreta `RENDER_RADAR_HEALTH_URL` para **o URL real** do Render mais `/health`, ex.: `https://servico-real.onrender.com/health`. Não inventar o nome. Guardar e reimplementar se necessário.
5. Confirmar na secção **Triggers** a expressão `*/5 * * * *`, e nos logs se aparecem `RADAR_KEEPALIVE` com o estado da blockchain. Se vir `RADAR_KEEPALIVE_FAILED`, consultar a causa e o URL. Não declarar ativo apenas por ter um Worker publicado.

**Não criar nem colar tokens de API em chats ou ficheiros.** Com a integração GitHub da Cloudflare, não é necessário criar um token para esta instalação. Respeitar o limite de triggers da conta Cloudflare Free.

## 3. Critérios de aceitação que substituem 'localhost funciona'

- URL HTTPS do Render acessível com o computador desligado: `/dashboard` mostra mints reais, `/radar` responde JSON e `/health` reporta `chain=solana`/`mode=READ_ONLY`.
- O dashboard indica sempre quando é um **snapshot offline**, ou quando o WebSocket está desconectado/DEGRADED; não mostra dados parados como atualizados.
- Os endpoints `/observations`, `/events`, `/evidence`, `/security`, `/gaps`, `/market` e `/tokens` retornam **404** em cloud (evita expor gratuitamente exportações de dados brutos). Endpoints read-only não aceitam POST/PUT.
- Uma execução Cloudflare cron com `RADAR_KEEPALIVE` aparece nos logs, sem loop de chamadas sem limites. Confirmar amostras em duas ou mais execuções distintas ao longo do tempo.
- O total de tentativas RPC respeita 12/min no modo focado; logs são apenas parciais e FDV estimado não corresponde a market cap circulante. Se o serviço suspender, a interface fica stale/offline e o reinício não preserva histórico.

## Validação técnica antes de deploy

- Testes Cloudflare: `node --test cloud/keepalive/test/*.test.mjs` (destino, HTTP falhado, resposta DEGRADED).
- Testes Solana: `cd solana && npm ci --ignore-scripts && node --test test/cloud-hosting.test.mjs test/radar.test.mjs` (porta, GET público, rotas bloqueadas, dados reais de fixture).
- GitHub Actions: **Solana cloud hosting smoke tests** e **Validate pipelines**, a verificar no PR.

## Compatibilidade com o MVP local

- `bash solana/scripts/run-pump-focused.sh` (a partir da pasta solana: `bash scripts/run-pump-focused.sh`) continua a servir em localhost como antes.
- O novo launcher `bash scripts/run-cloud.sh` serve em `0.0.0.0:$PORT` **apenas** em ambiente cloud. Não ativar localmente em redes não confiáveis.
- Não alterar a `main`, newsletter, Fase3B, Cloudflare collector existente ou APIs pagas. A cloud deste radar usa um **novo** Worker com nome isolado.

## Fontes de limites (verificadas em 2026-11-06)

- Render Free: https://render.com/docs/free
- Render Blueprint: https://render.com/docs/infrastructure-as-code
- Cloudflare Builds: https://developers.cloudflare.com/workers/ci-cd/builds/
- Cloudflare Cron: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Limites Cloudflare Workers: https://developers.cloudflare.com/workers/platform/limits/
- RPC público Solana: https://solana.com/docs/references/clusters
