# Verificação do collector no runtime Cloudflare

Executar na raiz do projeto, depois de `npm ci`:

```sh
WRANGLER_SEND_METRICS=false npm run cloudflare:check
node scripts/probe-cloudflare-runtime.mjs --fixture 2
node scripts/probe-cloudflare-runtime.mjs 2
```

O primeiro comando apenas compila o bundle. O segundo executa dois crons no
`workerd` com D1 local e RPC determinístico, sem pedidos à Internet. O terceiro
executa o mesmo bundle contra o RPC público oficial da Robinhood Chain. Não
cria recursos remotos, não publica o Worker e não configura uma recolha 24/7.

A ponte de teste usa `undici.EnvHttpProxyAgent` para respeitar os proxies e a
confiança TLS já configurados na sessão. Apenas aceita pedidos POST para o RPC
configurado em `wrangler.json` (ou o endpoint de `src/network.mjs` quando não há override). O Worker de produção continua a usar o
`fetch` nativo do runtime. Não é necessário definir credenciais Cloudflare.

Cada ciclo verifica o evento cron, a escrita do relatório e do cursor em D1,
a libertação do lease, `/health`, `/latest` e a correspondência entre o endpoint
e o relatório persistido. A fixture verifica também que uma pool descoberta é
reavaliada no ciclo seguinte sem duplicar o catálogo, e que os dois pipelines
ficam `INCOMPLETE` enquanto faltam provas de segurança.

O estado real local persiste em `runtime/cloudflare-runtime-probe/storage/` e
o último relatório em `runtime/cloudflare-runtime-probe/latest-report.json`.
A fixture usa um diretório temporário separado, eliminado no fim. Os dados
sintéticos da fixture nunca são publicados. Ambos os diretórios são ignorados
pelos artefactos do repositório.

O JSON de saída distingue `synthetic`, `localRuntime` e `remoteDeployment`,
mede `wallMs` e indica explicitamente `cpuLimitVerified: false`. O tempo de
parede inclui espera por rede e D1; não demonstra conformidade com o limite
de CPU do Workers Free. Essa validação exige métricas de uma execução no
serviço Cloudflare. Aprovação de tokens e segurança conclusiva continuam
indisponíveis enquanto os respetivos dados não forem recolhidos.

Na última verificação de 20 de outubro de 2026, dois ciclos reais concluíram nos blocos 93766853 e
93766882, com um token observado por ciclo, ambos os pipelines `INCOMPLETE` e
`/health` HTTP 200. A verificação no runtime encontrou e permitiu corrigir
duas incompatibilidades que os mocks Node não detetavam: o receiver de `fetch`
e a opção `redirect: 'error'`, não suportada pelo `workerd`.

O primeiro ciclo verificou ainda a amostra independente dos últimos 64 blocos,
preservando o cursor contíguo atrasado. Essa amostra não transforma a descoberta
num índice completo. Os tempos totais foram 3,18s e 2,02s; não são medições de CPU.

Em 21/10/2026 foram também verificados dois ciclos **remotos naturais** na
Cloudflare, com Pinax e D1 persistente: blocos 94.560.297 e 94.560.903, às
21:28:22 e 21:29:24 de Lisboa. `/health` e `/latest` responderam 200 e os dois
pipelines ficaram `INCOMPLETE`. Ver [operação do deployment](OPERATIONS.md).

A arquitetura final encaminha o cron para o Durable Object SQLite Free
`Collector`, mantendo D1. O probe configura `useSQLite: true` e executa esse
mesmo caminho no workerd. Passaram 153 testes e dois ciclos locais reais com
DO/Pinax. Em produção, dois crons pós-DO concluíram às 21:46:22 e 21:47:22 de
Lisboa nos blocos 94.570.728 e 94.571.304. A CPU do Worker chamador foi 0,416 e
0,548 ms; a CPU do DO tem o limite próprio documentado de 30 segundos por pedido.

Em 22/10/2026, após a correção do envelope para chamadas individuais, foram
confirmados diretamente no D1 dois crons remotos sucessivos às 10:10:21 e
10:11:21 UTC, com avanço dos blocos 95.032.710 para 95.033.297. Havia 179
relatórios concluídos retidos nas três horas anteriores; isso não equivale a
179 ciclos consecutivos sem falhas. O estado era `COMPLETED`, sem erro, e os
dados continuavam `PARTIAL` com os pipelines `INCOMPLETE`. A suite atual passou
158 testes. Ver a cronologia e as limitações em [operação](OPERATIONS.md).

A verificação de 22/10/2026 incluiu também o browser na página publicada. Sem
recarregar nem clicar, duas consultas automáticas receberam recolhas dos blocos
95.071.763 e 95.072.356 e atualizaram hora, bloco e identificador no DOM. Os
recursos principais responderam HTTP 200, sem erros JavaScript ou CSP. Um
teste separado com APIs sintéticas interceptadas confirmou offline/recuperação
e ausência de pedidos sobrepostos. A suite passou 159 testes.
