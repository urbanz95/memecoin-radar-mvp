# Operação do collector

Worker publicado: `memecoin-radar-collector`.

- [Painel Vercel com atualização automática](https://memecoin-radar-six.vercel.app/)
- [Painel servido também pela Cloudflare](https://memecoin-radar-collector.radar-605437d4ee90.workers.dev/)
- [Estado do serviço](https://memecoin-radar-collector.radar-605437d4ee90.workers.dev/health)
- [Última recolha](https://memecoin-radar-collector.radar-605437d4ee90.workers.dev/latest)
- [Worker no painel Cloudflare](https://dash.cloudflare.com/605437d4ee90a0de71772eb374eb5b94/workers/services/view/memecoin-radar-collector/production)

O cron `* * * * *` agenda uma execução por minuto. Um agendamento novo pode demorar até 15 minutos a propagar, segundo a [documentação da Cloudflare](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

O perfil usa Workers Free, um Durable Object SQLite Free e D1, sem ativar subscrições pagas. O cron leve do Worker chama o objeto `Collector` nomeado `main`; o DO consulta a Robinhood Chain mainnet (4663) pelo endpoint público Pinax `https://robinhood.rpc.pinax.network`, listado nos [docs Robinhood](https://docs.robinhood.com/chain/connecting/), e persiste em D1. O cron é o único agendador, sem alarmes ou timers recorrentes no objeto. As credenciais do Wrangler servem para gerir o deployment; o collector publicado continua a executar sem este ambiente ou o chat abertos.

## Verificação remota inicial — anterior ao Durable Object

Dois crons naturais foram confirmados em **21/10/2026**, às **20:28:22 e 20:29:24 UTC** (**21:28:22 e 21:29:24 de Lisboa**), nos blocos **94.560.297 e 94.560.903**. Os dois endpoints responderam HTTP 200, com `runId` diferente, uma observação por ciclo e os dois pipelines `INCOMPLETE`. O estado persistiu no D1. A versão `8f334aaf-791f-4700-9755-4de920779dde` foi publicada sem alterar o cron existente. Esta prova pertence ao fluxo inicial, em que a recolha corria diretamente no Worker.

Medições remotas desse fluxo revelaram cerca de **23–55 ms de CPU**, acima dos 10 ms do Workers Free. Por isso, a recolha foi movida para o DO SQLite, com limite de 30 segundos de CPU por pedido. O Worker mantém o encaminhamento do cron e os GET públicos.

## Publicação com Durable Object e primeiras métricas

A versão ativa `f02035d1-4807-4f12-8526-ff54c25d64eb` foi publicada em **21/10/2026 às 20:44:21.629825 UTC**, com namespace SQLite `d9371fbee26d4de69c290401c17109dc`. O D1 e os timestamps do agendamento existente foram preservados.

A arquitetura com DO passou **153/153 testes**, incluindo SQLite real para retenção/rollback. Também passaram dois ciclos determinísticos no workerd com DO/D1 e dois ciclos locais com DO e RPC real.

As primeiras métricas remotas do Worker chamador após a mudança, em 21/10/2026, foram:

| Invocação observada | Hora de Lisboa | Hora UTC | CPU p99 |
|---|---|---|---|
| Cron encaminhado ao DO | 21:45:18 | 20:45:18 | 0,854 ms |
| Cron com recolha concluída | 21:46:18 | 20:46:18 | 0,416 ms |
| Cron com recolha concluída | 21:47:18 | 20:47:18 | 0,548 ms |
| GET público | 21:45:55 | 20:45:55 | 3,227 ms |

Dois crons naturais pós-DO foram comprovados diretamente no D1: **21:46:22 e 21:47:22 de Lisboa**, nos blocos **94.570.728 e 94.571.304**, com `runId` diferentes, estado `COMPLETED`, sem erro operacional e uma observação por ciclo. Ambos os pipelines ficaram `INCOMPLETE`. Os endpoints públicos responderam HTTP 200. A CPU do Worker nesses ciclos ficou abaixo dos 10 ms; a recolha executou no contexto DO com limite próprio de 30 segundos. A validação de CPU/duração do DO, quotas agregadas e estabilidade de 24 horas exige acompanhamento adicional; esta é uma verificação inicial, não uma garantia de disponibilidade.

## Dados e cobertura

Cada ciclo aceita até quatro eventos de criação e enriquece um contrato. A descoberta contígua, a amostra junto da cabeça e a amostra histórica têm coberturas distintas. `/latest` expõe os intervalos, paginação e backlog. Não existe cobertura integral da rede.

`PARTIAL` indica recolha executada com provas críticas em falta. `recordedResults` são avaliações datadas. `currentSignalsAvailable` mantém-se `false`; não são sinais de compra. `INCOMPLETE` nos dois pipelines significa que faltam dados para os filtros, incluindo segurança conclusiva, holders, LP, simulações e preços USD.

## Persistência e limites

O D1 guarda catálogo, cursores, lease e relatórios. A evidência tem retenção de três horas. O catálogo é limitado a 50.000 pools por uma poda a cada 1.440 ciclos concluídos; entre podas pode crescer até cerca de mais 5.760. Têm prioridade as pools enriquecidas mais recentemente, incluindo antigas. Uma pool descoberta mas nunca enriquecida pode ser removida. O catálogo continua seletivo.

O `/health` responde 503 se não houver sucesso recente, existir erro ou um lease abandonado. Dados com mais de seis minutos ficam desatualizados. Uma falha não avança os cursores; um lease de cinco minutos impede execuções sobrepostas. O próximo cron tenta retomar quando o lease permitir.

Confirmar no painel a CPU do Worker, CPU/duração/pedidos do DO e linhas D1. Workers Free tem 10 ms de CPU por execução; o pedido ao DO tem limite próprio de 30 segundos. O DO SQLite Free inclui 100.000 pedidos/dia, 13.000 GB-s de duração/dia e 5 GB de armazenamento por conta. O cron gera cerca de 1.440 chamadas/dia ao único objeto nomeado; as quotas também incluem outros recursos da conta. A duração durante chamadas de rede consome GB-s. Quotas esgotadas podem causar erros ou suspensão até ao reset; o código não ativa upgrades. Ver [limites e configuração](FREE-HOSTING.md).

## Atualizações

`wrangler.json` contém a conta e o ID real de D1; estes identificadores não são credenciais. Tokens e passwords não pertencem ao repositório. Para uma publicação normal na mesma conta, com Workers Free confirmado:

```sh
RADAR_CONFIRMED_FREE_PLAN=1 npm run cloudflare:activate
```

A primeira publicação da classe `Collector` exige o deploy normal do helper para aplicar `new_sqlite_classes` na migration `v1-collector-do`. Depois dessa migration, uma alteração só de código pode ser publicada com `wrangler versions upload` e `wrangler versions deploy <version-id>@100% --yes`, preservando o agendamento. Novas alterações de migrations também exigem o deploy normal. Estas operações exigem uma sessão Wrangler autorizada. A Vercel e o GitHub permanecem etapas separadas.

## Incidente RPC de 21/10/2026

Após o último ciclo concluído às 21:46:21 UTC (22:46:21 de Lisboa), o collector
ficou em `ERROR / INVALID_RPC_ENVELOPE`. O RPC Pinax devolveu um objeto JSON-RPC
para um batch de uma só chamada ao bloco 94.605.582; as chamadas a `latest`
continuavam a devolver arrays. A validação recusou a forma inconsistente, sem
avançar os cursores nem substituir o relatório anterior. `stale: true` indicava
que o último sucesso tinha mais de seis minutos.

A correção envia um objeto JSON-RPC nas chamadas individuais e mantém arrays
para batches com várias chamadas. IDs exatos, versão, estrutura e erros continuam
a ser validados. Não aceita arrays como resposta a objetos nem relaxa a validação
para contornar o fornecedor. A consulta ao bloco bloqueado e os intervalos
recentes/históricos persistidos passaram na reprodução real após a alteração.
Passaram 158 testes, incluindo regressões para as formas de resposta e IDs inválidos.

### Recuperação confirmada em 22/10/2026

A versão `a8bbb70d-825e-4e9d-be49-da3af9a35a43`, publicada em 21/10 às
22:20:40 UTC, está ativa com 100% do tráfego e mantém o cron por minuto.
Em 22/10 às 10:12 UTC, uma leitura direta do D1 confirmou `COMPLETED`,
`last_error = null` e sequência 773. Havia 179 relatórios concluídos retidos
entre 07:12:22 e 10:11:21 UTC. Esta contagem não comprova que todos os ciclos
intermédios tiveram sucesso nem determina o instante exato da retoma.

Dois ciclos sucessivos, às 10:10:21 e 10:11:21 UTC (11:10:21 e 11:11:21 de
Lisboa), avançaram dos blocos 95.032.710 para 95.033.297. Ambos ficaram
`PARTIAL`, sem erros operacionais registados, e os dois pipelines mantiveram
`INCOMPLETE`. `/health` e `/latest` responderam HTTP 200 com dados recentes.
Passaram 158 testes, incluindo o diagnóstico sanitizado de envelopes inválidos.
A cobertura histórica e a análise de segurança continuam incompletas.

## Atualização automática no browser

O painel em `/` usa Static Assets e consulta `/health` e `/latest` no mesmo
domínio a cada 30 segundos enquanto o separador está visível. Volta a consultar
ao regressar ao separador. O botão «Atualizar vista» faz apenas leituras; não
desencadeia uma recolha. A última consulta e a última recolha são datas distintas:
consultar várias vezes o mesmo relatório não altera a data da recolha.

Abrir diretamente `/health` ou `/latest` apresenta uma resposta JSON única.
O separador não volta a consultar sozinho esses endpoints. Para acompanhar a
evolução sem recarregar a página, usar o painel. O cron de recolha continua
independente do browser, inclusive quando todos os separadores estão fechados.
Falhas de ligação e dados antigos são apresentados no painel, preservando o
último relatório visível. Isso não converte os resultados parciais em sinais atuais.

### Verificação da atualização da página em 22/10/2026

O painel foi publicado na versão `42f21532-9bea-414d-8e9b-4d57d6109372` às
11:18:38 UTC, preservando o cron existente. Passaram 159 testes e o build
Wrangler; HTML e JavaScript públicos corresponderam aos ficheiros locais.

Num Chromium com TLS validado e uma única navegação inicial, duas consultas
automáticas separadas por cerca de 30 segundos atualizaram o DOM sem click ou
reload: recolha das 11:18:22 UTC no bloco 95.071.763 → recolha das 11:19:22 UTC
no bloco 95.072.356. Hora da recolha, bloco e identificador mudaram, e a vista
mostrou «Nova recolha recebida». A hora da consulta permaneceu distinta da hora
da recolha. Ambos os pipelines continuaram `INCOMPLETE`.

Num browser separado, com respostas de API sintéticas interceptadas apenas no
teste, verificaram-se preservação dos dados offline, recuperação automática e
ausência de consultas sobrepostas. Estes dados de teste não foram gravados no
collector ou apresentados como observações reais.

## Análise por contrato e incidente de evidência de 22/10/2026

A versão `8a777afe-4fcd-4335-9660-5e96414202b5` ativou a análise adicional e
produziu listas reais de novos e estabelecidos, com idade por prova histórica
ou recibo, métricas das pools, mercado externo identificado e riscos. A
verificação inicial do browser às 12:36 UTC não recebeu listas na sua janela
e falhou; não é uma prova de sucesso da análise publicada. Relatórios posteriores
confirmaram que as análises passaram a ser gravadas.

A partir do último sucesso das 14:12:24 UTC, o estado ficou em
`EVIDENCE_BUDGET_EXCEEDED`. Respostas individuais cabiam no limite, mas o audit
acumulava bytecode repetido, blocos/recibos com campos não usados e intervalos
de logs rejeitados durante a redução da pesquisa. O collector preservou cursores
e o último relatório confirmado.

A correção tem duas partes: limita o audit RPC a 128 KiB, projetando os campos
usados e resumindo dados grandes com hashes e `rawRetained: false`; também remove
a duplicação de respostas brutas de `decimals` e `totalSupply` em `tokenFacts`.
Os metadados ficam tipados e compactos, com referências à evidência RPC. As
respostas originais continuam a alimentar os cálculos; o arquivo não conserva
todas as respostas brutas. O teto total de evidência continua em 256 KiB.
Ver [metodologia](SCREENING.md).

Passaram **209 testes**, incluindo regressões de agregação, bytecode e logs
grandes, provas de idade e ausência da duplicação em metadados. Também passaram
dois ciclos determinísticos no workerd e um ensaio local com RPC real, com
28 pedidos.

A versão `3c826fc5-af3d-4526-90cf-31facab5b9ba` foi publicada em
**22/10/2026 às 18:00:47 UTC**, com 100% do tráfego e o cron preservado.
O cron natural iniciado às **18:01:19.925 UTC** devolveu `COMPLETED`, com
run `9354145b-dfe5-4d14-a199-4a0856bbf4d8` e bloco **95.303.855**.
O tail sanitizado confirmou essa versão e não registou erros da API de gestão.
Esta é uma prova de um ciclo recuperado; a verificação do browser ainda estava
pendente nesse momento e não há comprovação de 24 horas sem interrupções.

A verificação do browser passou às **18:03:38 UTC**: numa única navegação, o
polling de 30 segundos atualizou o DOM sem click ou reload, do run
`7177c0a4` (recolha 18:02:22.754 UTC, bloco 95.304.445) para `1e522e42`
(18:03:23.253 UTC, bloco 95.305.041). As listas classificadas passaram de
10 novos/6 estabelecidos para 11 novos/5 estabelecidos, mantendo 16 entradas.
Entradas antigas ficaram explicitamente desatualizadas. `currentSignalsAvailable`
continuou `false`, houve zero tokens aprovados e a avaliação estrita manteve
`INCOMPLETE` onde faltavam provas. A evidência do browser ficou em
`runtime/dashboard-browser-proof/analysis-natural-refresh.json`.

## Verificações adicionais de segurança — validação local de 22/10/2026

O código acrescenta quatro módulos com resultados e datas próprios: correspondência
de artefactos de contrato, distribuição de holders, proteção de LP v2 e simulação
de compra/venda v2 em WETH. A pool selecionada é mantida durante três ciclos,
distribuindo as leituras de holders, LP e simulação sem aumentar o teto de 32
pedidos RPC. Cursor, cache e avaliações usam a transação D1 existente; resultados
de fases anteriores conservam a sua data. A metodologia e os limites estão em
[SCREENING.md](SCREENING.md).

Provas de leitura na rede pública, guardadas em `runtime/safety-verification/`,
confirmaram no token Venom `0x4e9250c8ab2d82f03121a6c1d668804483876be4`:

- Às 23:19:05 UTC, histórico desde o genesis até ao bloco 95.486.750 conciliado
  com emissão e os quatro saldos on-chain. Excluída a pool comprovada, havia três
  carteiras, top 1 de 29,080305% e top 10 de 45,872417% da emissão. Os dois valores
  ultrapassavam os limites do pipeline de novos; `holders-real.json` conserva
  essa observação datada.
- Às 23:19:15 UTC, uma compra e venda de teste de 0,001 WETH numa única execução
  `eth_call`, sem fundos ou transação, mostrou taxas de transferência de 2% na
  compra e 2% na venda e perda de ida e volta de 4,111234%. O bloco 95.486.892
  foi confirmado antes e depois; a simulação usou dois pedidos RPC.
  `trade-real.json` conserva essa prova.

Estes ensaios exercitam leituras reais dos módulos; não são prova da execução do
novo fluxo completo em produção. A publicação, o cron natural e a atualização
do browser dessa versão exigem verificação própria. Os registos de produção das
secções anteriores pertencem às versões e funcionalidades ali identificadas.

A simulação implementada não comprova o montante de 100 USD da política nem
ausência universal de honeypot. A queima verificada de LP refere-se a uma pool,
sem aprovar todas as pools, lockers ou posições v3/v4. Artefacto exato não é uma
auditoria de privilégios; distribuição conciliada não identifica insiders ou
bundles. Essas lacunas continuam a impedir aprovação quando exigidas pela política.

### Publicação e verificações de 22/10/2026, às 23h UTC

Passaram **265 testes**, a validação da política, a demonstração e o build.
Três ciclos determinísticos no workerd usaram 15/14/14 pedidos RPC. Três ciclos
locais com DO, D1 e RPC real usaram 31/23/28 pedidos, sem ultrapassar o teto de
32. A concentração de holders comprovada no primeiro ciclo continuou a produzir
`BLOCKED` nos seguintes, conservando a data e referência do relatório original.
O ensaio separado do agregador confirmou 1.024 leituras de saldos numa chamada
efémera; não foi instalado um contrato na rede.

A versão inicial de segurança `21cebeff-b652-4dd9-b6bf-db3852896cfa` foi
publicada às **23:29:39 UTC**. Apesar da estratégia de atualização imediata
pedida ao fornecedor, os primeiros relatórios ainda tinham o formato antigo.
O primeiro relatório público com `safety` foi confirmado às **23:35:25.796 UTC**,
run `fbad0d3f-e8e0-4ec6-9780-b0f535f623b8`, bloco **95.496.140**.
Não ficou demonstrada a causa do atraso. Um teste inicial do browser foi
arquivado como falha de aquecimento; não foi tratado como prova de sucesso.

O browser passou às **23:43:36 UTC**, com uma única navegação, sem reload ou
click e sem erros. O DOM recebeu quatro relatórios naturais, das 23:40:22 às
23:43:25 UTC, avançando dos blocos 95.498.881 para 95.500.573. No contrato
`0x6d3b4be6cee599fc933f4a8359f64356931a7777`, as recolhas 23:41/42/43
mostraram as três fases: holders conciliados (duas carteiras, maior carteira
99,999954%), LP com emissão vazia e tentativa de simulação sem prova de
execução por falta de liquidez. A data dos holders permaneceu 23:41:20 UTC
nas fases seguintes; as consultas ao código tiveram datas próprias.
O painel coincidiu com a API, conservou zero aprovados e mostrou 6 novos e
5 estabelecidos nessa observação. Provas em
`runtime/safety-verification/browser-production.json` e `.png`.
Outro teste foi arquivado como falha por a janela não abranger as três fases;
apenas o ensaio final com todas as verificações passou.

A revisão de continuação `4e372242-4ad7-4d23-8fbb-f4d975bbfd5f`, publicada às
**23:40:40 UTC**, acrescenta a retoma automática dos históricos de holders
pendentes, descrita em [SCREENING.md](SCREENING.md). O relatório das
**23:46:22.874 UTC**, run `5f924257-bf43-4080-89fb-51768bdc51b0`, bloco
**95.502.370**, confirmou `analysisRevision: safety-v2-continuation` e fase 2.
`/health` e `/latest` responderam HTTP 200, sem erro operacional ou dados
desatualizados. O cron, D1 e namespace SQLite foram preservados.
A prova do browser acima verifica os mesmos quatro módulos; a revisão final
altera a seleção da fila, validada também nos testes automatizados.

## Publicação do painel na Vercel — 23/10/2026

O painel está publicado em **https://memecoin-radar-six.vercel.app/**, no projeto
novo `memecoin-radar` da equipa `urbanz95s-projects`. O plano foi confirmado como
**Hobby**, sem trial. O deployment de produção
`dpl_EdEf6rsyNTAWscLAsTm3LLviGD7K`, criado às **07:45:46 UTC**, terminou em
`READY`. O projeto tem ID `prj_NoIuyCmSBmOPr79jHGP4gTClbLi5`.

Foram enviados apenas `vercel.json`, `public/index.html` e `public/dashboard.js`.
A publicação é estática, com output `public`, sem instalação ou build remoto.
Não foram criados Functions, cron, Blob ou ligação Git. O collector, o D1, o DO
e o cron de um minuto continuam na Cloudflare. Os rewrites de `/health` e
`/latest` encaminham os pedidos para os endpoints existentes. Esses caminhos
desativam explicitamente a cache de rewrites externos e preservam `no-store`.
Ver [configuração e publicação Vercel](VERCEL.md).

Passaram a validação local da política e a verificação de sintaxe do dashboard.
Às **07:50:25 UTC**, os quatro caminhos públicos `/`, `/dashboard.js`, `/health`
e `/latest` responderam HTTP 200, sem redirecionamento para autenticação.
Os hashes SHA-256 do HTML e JavaScript publicados coincidiram com os ficheiros
locais. Os endpoints JSON responderam `x-vercel-cache: MISS`, sem `Age`, com
`Cache-Control: no-store`; o collector estava `COMPLETED`, sem erro operacional.

O ensaio do browser terminou com **PASS às 07:50:38 UTC**, numa única navegação,
sem cliques ou reload. O polling natural recebeu o run
`4df01e5a-0583-4a9f-b247-55a8feb024e6`, recolhido às **07:49:23 UTC**, bloco
**95.780.906**, e depois `5e951de4-9efb-4dca-a29b-9ccc5feed850`, às
**07:50:22 UTC**, bloco **95.781.489**. As seis entradas eram uma nova, quatro
estabelecidas e uma sem idade classificada. O DOM coincidiu com a API, incluindo
os quatro módulos de segurança e as datas próprias. Os avisos de provas ausentes
ou desatualizadas permaneceram visíveis; os aprovados continuaram em zero e
`currentSignalsAvailable` em `false`. Não houve erros de página ou API.
Esta verificação comprova a atualização observada, sem garantir disponibilidade
contínua ou completar as provas de segurança em falta.

As provas sanitizadas estão em `runtime/vercel-deploy/`: `deployment.json`,
`manifest.json`, `http.json`, `browser.json` e `browser.png`. Não contêm tokens
de acesso. Não foi efetuado push para o GitHub.

### Ocultar tokens bloqueados — 23/10/2026, 08h UTC

O deployment de produção `dpl_6rEgY2jrxhwYmyY1vGEQHqqss7r9`, criado às
**08:42:46 UTC**, ficou `READY` no mesmo URL e plano Hobby. Apenas os dois
ficheiros do painel e a configuração estática foram enviados. Tokens com
`status: BLOCKED` deixam de aparecer nas listas de novos, estabelecidos e sem
idade classificada, nos contadores e no endereço da última observação.
O filtro é reaplicado a cada consulta, mantendo os relatórios do collector.

A sintaxe do JavaScript e a validação da política passaram. Quatro ensaios
do browser com fixtures identificadas como sintéticas também passaram:
estados mistos nos três grupos, todos bloqueados, filtro antes do limite
de vinte entradas e passagem de visível para bloqueado num poll natural de
trinta segundos. Neste último, os tokens desapareceram sem clique ou reload.
Às **08:43:16 UTC**, HTML e JavaScript no URL público coincidiram com os hashes
locais, os quatro caminhos responderam HTTP 200 e os endpoints JSON usaram
`no-store` e cache `MISS`. Provas em `runtime/vercel-hidden-blocked/`.

O browser público passou às **08:44:39 UTC**, numa única navegação, sem clique
ou reload. Recebeu naturalmente os runs
`f85f53a5-a683-48a5-aef1-df34a63fb90b` (**08:43:23 UTC**, bloco **95.811.637**)
e `7afc7897-d2a6-4785-9664-00f9d49df2c5` (**08:44:22 UTC**, bloco
**95.812.220**). Em ambos, a API continha seis entradas, quatro bloqueadas;
o painel mostrou apenas as duas não bloqueadas e não expôs endereços bloqueados
na última observação. As contagens, módulos e datas coincidiram com a API
filtrada. Os endpoints continuaram HTTP 200, `no-store` e `MISS`, sem erros
de página ou API. Os aprovados mantiveram-se em zero. A prova e captura estão
em `browser.json` e `browser.png` na mesma pasta.

### MVP — fase 3, 23/10/2026, 23h UTC

Código no branch `feat/mvp-wallet-signals`, commit `419dfd0`, seguido de
`536916f` para permitir trocar a instância do collector sem mudar o D1. A suite
completa passou 470 testes. As correções finais passaram 17 testes de
codec/records, 40 testes do collector e cinco verificações de codec no workerd,
incluindo o payload exato de 64 KiB e a rejeição de descompressão excessiva.
O workspace de descompressão é limitado a 128 KiB; o payload aceite mantém
o limite de 64 KiB. Três ciclos locais workerd passaram com 15/14/14 RPC;
um ciclo local com RPC real usou 22. Estes ensaios não medem o limite CPU remoto.

Antes das migrations aditivas `0004_mvp_wallets.sql` e `0005_mvp_weekly.sql`,
foi registado às **23:26:07 UTC** o bookmark integral Time Travel
`0000001c-00000132-0000510d-deea770c03f1f67b8dff4c28bb01778b`.
O manifesto `runtime/backups/pre-phase3-manifest.json` guarda os hashes e
a aplicação às **23:26:46 UTC**. Retenção de sete dias; sem export SQL offline.

A versão Cloudflare `7ecc290f-beb4-4dce-8c9c-33bbac20be73` ficou publicada
a 100%, mas a rotina continuou a gravar relatórios de fase 2. A publicação
seguinte, `3067cd8d-5b70-4e81-89ba-198e4a36fd5b`, usa a instância DO
`main-mvp-v3`. Os cursores, o lease e o arquivo continuaram no mesmo D1;
não foram apagados dados nem renomeadas tabelas. O cron natural
`0943a3b7-9c1a-49cf-909a-2606c352925c`, às **23:32:24 UTC**, confirmou fase 3.

Vercel Hobby: `dpl_9NjeLxKBV6VDrpq6KoPEgy5WGpjS`, READY e associado ao URL
público existente. Foram enviados os cinco ficheiros do painel/config/gateway.
HTML e JavaScript públicos coincidiram com os hashes locais. Gateway válido
HTTP 200 e inválido HTTP 400; timestamps originais e cabeçalhos de cache
foram preservados. Não foi ligada uma integração Git.

O browser passou às **23:33:49 UTC** com uma navegação, sem cliques ou reload:
recebeu naturalmente os runs das **23:32:24** e **23:33:25 UTC**, nos blocos
96.321.914 e 96.322.490. O arquivo avançou de 1.574 para 1.577 tokens e
de 173 para 174 decisões, mantendo 28 outcomes completos. Uma observação de
mercado real coincidiu entre API e DOM; a segunda recolha ocultou os seis
tokens bloqueados. Endpoints HTTP 200/no-store, zero erros de página/API.
PnL desconhecido, zero wallets elegíveis e zero alertas dry-run foram
apresentados sem transformar dados ausentes em métricas favoráveis.

Provas: `runtime/mvp-phase3/production.json`, `browser.json`, `browser.png`,
`verification.json`, `codec-workerd.json` e `vercel/`. Estas pastas de runtime
não são incluídas no Git. A fase 3 termina aqui; X, novo modo B e backtest/modelo
permanecem por construir e dependem de confirmação.

O pedido de criar o repositório privado `urbanz95/memecoin-radar-mvp` foi
recusado pelo GitHub: GraphQL `Resource not accessible by integration
(createRepository)`; o fallback REST também não autorizou a criação.
Não foi criado repositório nem feito push, e o remote local ficou inalterado.
Prova sanitizada em `runtime/github/create-attempt.json`. É necessário criar
o repositório e conceder acesso à ligação antes de publicar o branch.

### MVP — fase 1, 23/10/2026

O branch `feat/mvp-wallet-signals` preserva o baseline local `d8e8c0d`.
Antes da alteração passaram os 298 testes existentes; após a fase 1 passaram
342 testes, a compilação dos profiles YAML e o build Cloudflare. Os três ciclos
locais de workerd mantiveram 15/14/14 pedidos RPC; o ensaio real local usou 23.

Antes de aplicar `0002_mvp_records.sql`, foi guardado um ponto de recuperação
integral D1 Time Travel em `runtime/backups/pre-mvp-time-travel.json` e um
manifesto com os hashes das migrações. A exportação SQL falhou com erro de
autenticação 10000: não existe backup SQL offline. O Time Travel gratuito tem
retenção de sete dias. A migração foi aditiva e preservou as tabelas existentes.

O collector `755f82fe-6322-4c30-a549-6483549bbcd6` foi publicado a 100%.
O cron natural `e2ad96cb-13e5-4ba6-aec7-90fa376940ef`, às **13:58:25 UTC**,
confirmou `mvp.recording: true`: 12 tokens, 17 eventos de observação, duas
decisões canónicas, seis eventos de decisão e oito jobs de outcomes pendentes.
A prova está em `runtime/mvp-phase1/production-first-records.json`. Os outcomes
ainda não estavam disponíveis; não foram fabricados preços ou resultados.

A Vercel Hobby ganhou uma Function de leitura `/api/market`, sem cron ou
serviços pagos. O deployment `dpl_4EFMLQg9Nu5gBTkXsGvGKwP7jrQw` ficou READY,
com cinco ficheiros, e devolveu dados reais com HTTP 200. O collector usa essa
rota para contornar os 429 do fornecedor observados na saída Cloudflare.
Na primeira prova de gravação, o collector ainda reportava `STALE_SOURCE`;
a recuperação do mercado tem de ser comprovada separadamente.

### MVP — fase 2 e recuperação do mercado, 23/10/2026

O commit `b5b255d` implementou filtros duros do modo A, de 0h a menos de 24h,
e uma outbox Telegram exclusivamente dry-run, mantendo os pipelines antigos.
O conjunto completo passou **397 testes**; o ensaio final focado de filtros e
pipeline passou 33. A configuração, os profiles compilados e o build passaram.
O teste de um contrato com 23h também preservou o comportamento legado.
Prova local: `runtime/mvp-phase2/verification.json`.

Antes de `0003_mvp_outbox.sql`, foi registado um novo ponto de recuperação
integral D1 Time Travel às **14:04:18 UTC**, com manifesto em
`runtime/backups/pre-phase2-manifest.json`. A migration aditiva foi aplicada
às **14:06:07 UTC**. O Time Travel continua limitado a sete dias no Free;
não foi criado um export SQL offline. As mensagens são append-only,
deduplicadas por decisão/versão/episódio/destino e só aceitam `DRY_RUN`.
Não existe código de envio Telegram nem leitura de token/chat ID pelo formatter.

O `STALE_SOURCE` inicial resultava de validar o timestamp recebido contra
o relógio anterior ao pedido. O commit `5c877b0` passou a comparar a atualidade
após a resposta, preservando o timestamp original do gateway e os TTLs.
A prova remota seguinte verificou a recuperação do mercado, além do HTTP 200
isolado anteriormente observado na Vercel.

A versão Cloudflare **`181f2942-ec57-4a7b-b1a2-c9aeaa876810`** foi confirmada
pelo cron natural das **17:59:23 UTC**, run
`feb162b4-7cb7-4910-abf4-87928c9f05a9`. `/latest` mostrou `mvp.phase: 2`,
695 tokens, 1.221 avistamentos, 85 decisões canónicas, 702 eventos de decisão,
27 outcomes completos, 197 jobs pendentes e 116 em retry. O mercado devolveu
`REFRESHED`, HTTP 200, com três contratos atualizados entre nove pedidos;
a data da fonte observada foi **17:59:23.882 UTC**.
Prova: `runtime/mvp-phase2/production.json`.

A outbox manteve **zero mensagens**. A fase 2 ainda não tem histórico de wallets
com PnL realizado comprovado; score global nulo e flags de completude falsas
impedem preparar alertas. Uma aprovação dos filtros duros não substitui esses
dados. O formatter exige decisão global `PASS`, score ≥75 e wallets elegíveis
com pelo menos cinco trades realizados, sem duplicar clusters coordenados.
A fase 3 de wallets/relatório semanal estava em implementação; não foi tratada
como concluída por esta prova. X, novo modo B, backtest/modelo e operações
financeiras permaneceram desativados. Este ensaio não comprova disponibilidade
contínua nem permite antecipar outcomes de sete dias.
