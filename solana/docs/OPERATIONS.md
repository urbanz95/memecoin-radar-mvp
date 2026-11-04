# Operação local

## Instalar e iniciar

Linux, `flock`, Node >=22.13, disco persistente. Node 24.19.0 foi o ambiente principal de validação. SQLite é `node:sqlite`, não um módulo nativo instalado por script. As dependências estão fixadas no lockfile próprio.

```sh
cd solana
npm ci --ignore-scripts
npm test
npm start
```

`npm start` adquire um **novo** lock do kernel para o caminho SQLite configurado, antes de abrir Store. Não modifica nem adquire o lock Robinhood/3B. Um segundo `npm start`/`npm run soak` com a mesma base termina sem roubar trabalho. O kernel liberta o lock após SIGKILL. Importar Store diretamente em scripts externos contorna essa proteção e não é uma configuração operacional suportada. Usar uma base diferente para experiências independentes.

Não existe daemon instalado nem servidor provisionado: o processo Node funciona sem browser enquanto o host e o disco estiverem disponíveis. Um supervisor pode chamar o mesmo comando, mas nenhum serviço de produção foi alterado. SIGINT/SIGTERM param subscrições, persistem o buffer, cancelam RPC e mantêm trabalho pendente para replay. SQLite WAL/FULL protege transações confirmadas em disco; observações ainda no buffer RAM (até 250 ms) podem perder-se num SIGKILL e dependem da recuperação histórica. Um disco cheio é uma falha explícita, não uma prova de cobertura.

## Configuração

[.env.example](../.env.example) lista todas as variáveis; exportar no ambiente do processo. O scanner não carrega automaticamente `.env`. Nunca inserir private keys. Os endpoints podem conter segredos privados: não devem ser publicados em relatórios. O RPC HTTP é verificado por `getGenesisHash` Mainnet antes de subscrever; o resultado WS é cruzado com a assinatura e slot da transação no RPC Mainnet. `maxSupportedTransactionVersion: 1` é necessário para as transações atuais observadas.

- `SOLANA_RPC_HTTP_URL` / `SOLANA_RPC_WS_URL`: fontes configuráveis, defaults públicos oficiais.
- `SOLANA_PROGRAMS`: CSV dos slugs `pump_fun,pump_swap,raydium_launchlab,raydium_cpmm`; restringir o universo reduz carga, mas **não garante** capacidade suficiente.
- `SOLANA_COMMITMENT`: `processed`, `confirmed` (default), `finalized`. `processed` só produz observações antecipadas; eventos canónicos esperam enriquecimento confirmed. Erros processed não são tratados como falhas terminais. Uma mudança de slot durante confirmação é registada.
- `SOLANA_RPC_REQUESTS_PER_MINUTE=60`: limite global, pedidos espaçados, sem burst inicial; concorrência 2, cooldown partilhado perante 429. O limite do fornecedor pode ser inferior e partilhado com outros utilizadores.
- `SOLANA_MAX_DURABLE_BACKLOG=250`: pausa subscrições quando a fila durável excede o limite e retoma após drenar para metade. Uma rajada em trânsito pode exceder o limiar. A pausa gera lacuna; o scanner não promete recuperar o intervalo inteiro.
- `SOLANA_QUEUE_CAPACITY`, `SOLANA_QUEUE_CONCURRENCY`, `SOLANA_INGRESS_CAPACITY`: limites RAM. O backlog persistido é separado da fila de workers.
- `SOLANA_RECOVERY_PAGE_SIZE`, `SOLANA_RECOVERY_MAX_PAGES`: orçamento por programa/tick. Continuação persiste `before` e head original para percorrer páginas seguintes; nunca avançar checkpoint sobre transações selecionadas ainda não persistidas.
- `SOLANA_DB_PATH`: default relativo a `solana/`, `runtime/solana/scanner.sqlite`. `SOLANA_RETENTION_DAYS=7`, `SOLANA_RAW_RETENTION_HOURS=24`, `SOLANA_MAX_STORAGE_BYTES=536870912`: retenção e limite. O catálogo tem teto de 50.000 tokens/pools; gaps até 10.000. Crescimento/limites provocam poda ou suspensão explícita, sem arquivo ilimitado.
- `SOLANA_SECURITY_ENABLED=false`: enriquecimento de mints opcional, uma conta por tick elegível, partilha orçamento RPC. A API devolve null até existir observação real. Não é monitorização contínua de autoridades nem censo de holders.
- `SOLANA_HEALTH_HOST=127.0.0.1`, `SOLANA_HEALTH_PORT=8787`: API local de leitura. Não a publicar diretamente na Internet sem controlo de acesso/reverse proxy apropriado.

## Verificar e investigar

```sh
npm run health
npm run probe
curl http://127.0.0.1:8787/health
curl 'http://127.0.0.1:8787/events?limit=100'
curl 'http://127.0.0.1:8787/events?mint=ENDERECO_MINT'
curl 'http://127.0.0.1:8787/events?wallet=ENDERECO_WALLET'
curl http://127.0.0.1:8787/tokens
curl http://127.0.0.1:8787/market
curl http://127.0.0.1:8787/gaps
curl 'http://127.0.0.1:8787/security?mint=ENDERECO_MINT'
```

Todos os endpoints aceitam só GET; não há alteração de filtros, scoring ou permissões via API. `/health` pode dizer `DEGRADED`: consultar conexão, backlog, idade do último evento, erros, gaps e timestamps, sem interpretar ausência de eventos como inatividade da rede. Health exit code: 0 `OBSERVING`, 2 outro estado respondido, 1 falha HTTP. `OBSERVING` não significa cobertura completa nem token seguro.

Conservar a base e respetivo WAL em backup SQLite consistente (backup API ou parar o processo antes de copiar); copiar só o ficheiro principal durante escrita pode perder dados. Não remover WAL/locks de outro processo nem reutilizar pastas de runtime Robinhood.

## Ensaio real reproduzível

```sh
SOLANA_SOAK_SECONDS=3600 \
SOLANA_DB_PATH=runtime/soak/scanner.sqlite \
SOLANA_QUEUE_CAPACITY=32 \
SOLANA_RECOVERY_PAGE_SIZE=5 \
SOLANA_RECOVERY_MAX_PAGES=1 \
npm run soak
```

Grava `runtime/soak-progress.json` a cada 10s e `runtime/soak.json` no fim, com métricas, gaps, exemplos e contagens por protocolo. Dura uma hora real, não acelera o relógio nem usa fixtures. `npm run probe` grava `runtime/probe.json` e mede seu próprio consumo RPC. Estes testes live não correm automaticamente em CI. Todos os testes `npm test` são determinísticos, sem credenciais pagas.

## Observações contínuas com contexto incompleto

`SOLANA_LOG_OBSERVATIONS_ENABLED=true` é o default. Eventos binários demonstráveis nos logs são escritos em lotes para `event_observations`, com os logs selecionados e o hash de origem. `GET /observations` permite filtrar `mint`, `pool`, `wallet`, `signature`, `limit`. A resposta explicita contexto incompleto; não somar estes registos com `/events` nem introduzi-los implicitamente em `/market`. `GET /evidence?signature=...` devolve a evidência bruta selecionada ainda retida.

Neste modo o limite de backlog preserva o WebSocket e limita apenas a admissão para enriquecimento HTTP. `contextEnrichmentSkipped` contabiliza notificações não admitidas; `coverageOverloaded` e gaps mostram capacidade insuficiente. Com `SOLANA_LOG_OBSERVATIONS_ENABLED=false`, o comportamento é o modo anterior: pausa o WebSocket, drena o inbox e tenta backfill. Nenhum dos modos promete cobertura total.

`SOLANA_MAX_OBSERVATION_ROWS=25000` limita o fluxo de logs a uma janela móvel por quantidade, além da retenção temporal dos dados brutos. Em carga alta isto pode representar apenas alguns minutos. Os contadores acumulados de deteção não significam que todas as observações continuam armazenadas. O contexto das transações selecionadas tem retenção própria. `logObservationLatencyMs` mede as notificações suportadas até ao COMMIT, separado da latência de eventos enriquecidos; consultar o âmbito da janela e os buckets acumulados nas métricas.

Para ensaios concorrentes usar tanto `SOLANA_DB_PATH` como `SOLANA_HEALTH_PORT` e `SOLANA_REPORT_DIR` distintos. O limite RPC configurado aplica-se a cada processo; a quota do fornecedor pode ser partilhada entre ambos. Os ensaios desta entrega registam essa contenção explicitamente.
