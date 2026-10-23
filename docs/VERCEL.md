# Dashboard publicado na Vercel Hobby

O dashboard está publicado em **[memecoin-radar-six.vercel.app](https://memecoin-radar-six.vercel.app)**, no plano **Hobby**, desde 23/10/2026. O projeto `memecoin-radar` serve os ficheiros estáticos de `public/`, encaminha as leituras do painel para a Cloudflare e disponibiliza uma Function Node limitada para leitura de mercado em `/api/market`.

A recolha continua em **Cloudflare Workers Free + Durable Object SQLite Free + D1**, sem cartão. O cron recolhe dados a cada minuto, independentemente de existir um browser aberto. A página na Vercel consulta `/health` e `/latest` a cada 30 segundos enquanto está visível. O [dashboard servido diretamente pelo Worker](https://memecoin-radar-collector.radar-605437d4ee90.workers.dev/) também permanece disponível.

## Configuração publicada

- Projeto `memecoin-radar`, equipa `urbanz95s-projects`, plano Hobby confirmado, sem trial pago.
- Framework **Other**, output `public`, comandos de instalação e build vazios. A validação `npm run validate` foi executada localmente antes da publicação.
- Upload limitado a cinco ficheiros: `vercel.json`, `public/index.html`, `public/dashboard.js`, `api/market.mjs` e `src/mvp/market-gateway.mjs`. Estado, catálogo, provas locais e credenciais não fazem parte da publicação.
- Uma Function Node em `/api/market`, com duração máxima configurada de 10 segundos. Sem cron, Blob ou integração Git na Vercel. Não são necessárias variáveis `CRON_SECRET`, `BLOB_STORE_ID` ou credenciais de storage na Vercel.

A versão com gateway `dpl_4EFMLQg9Nu5gBTkXsGvGKwP7jrQw`, criada às **13:39:09 UTC de 23/10/2026**, terminou em `READY`. O teste público devolveu HTTP 200 para entrada válida e HTTP 400 para entrada inválida, com timestamp original no sucesso. O collector já confirmou gravação MVP num cron natural da versão Cloudflare `755f82fe-6322-4c30-a549-6483549bbcd6`. O `STALE_SOURCE` observado no início foi corrigido na comparação do relógio após a resposta. O cron natural da fase 2 às 17:59:23 UTC confirmou mercado `REFRESHED` HTTP 200 através do gateway; o teste isolado do gateway não seria suficiente para essa conclusão. As provas integradas e do browser são registadas em [operação](OPERATIONS.md).

## Encaminhamento dos dados

O [vercel.json](../vercel.json) contém dois rewrites externos:

| Caminho na Vercel | Destino |
|---|---|
| `/health` | `https://memecoin-radar-collector.radar-605437d4ee90.workers.dev/health` |
| `/latest` | `https://memecoin-radar-collector.radar-605437d4ee90.workers.dev/latest` |

O browser mantém os pedidos na mesma origem. Os rewrites permitem ler os endpoints existentes sem depender de CORS entre a página e a Cloudflare. A Vercel não inicia recolhas nestes pedidos.

Todas as respostas têm `Cache-Control: no-store`. Nos dois endpoints, `x-vercel-enable-rewrite-caching: 0`, `Vercel-CDN-Cache-Control: no-store` e `CDN-Cache-Control: no-store` desativam o cache dos rewrites externos, que pode estar ativo por defeito em projetos novos. Preservar os timestamps e as respostas de erro do backend ao alterar esta configuração.

## Gateway de mercado

`GET /api/market?addresses=...` aceita de um a vinte endereços ERC-20 válidos e consulta apenas o endpoint fixo DEXScreener da Robinhood Chain. Não aceita URL arbitrário, rede, credenciais ou métodos de escrita. Limita a resposta a 128 KiB, o pedido externo a três segundos e valida a identidade dos pares. Erros não devolvem um preço inventado nem executam retries imediatos.

O browser recebe `Cache-Control: no-store`. Apenas respostas válidas de mercado podem ser reutilizadas pelo CDN durante **30 segundos**, preservando `x-radar-fetched-at`; respostas de erro usam `no-store` também no CDN. Esse cache é independente dos rewrites `/health` e `/latest`, que continuam sem cache. O collector usa `MARKET_GATEWAY_URL` quando configurado; RPC e segurança continuam nas suas fontes originais.

O gateway não agenda recolhas nem guarda estado durável. Consome as quotas Hobby de Functions e transferência; não foi ativado Pro, trial ou recurso de storage. A disponibilidade depende também do fornecedor. Ver [âmbito do MVP](MVP-PROGRESS.md).

O painel verifica a atualidade dos resultados e distingue a última consulta da última recolha. A API distingue `marketSignalsAvailable`, para alertas de atividade `MARKET_ALERT` com segurança pendente, de `currentSignalsAvailable`, para candidatos estritos válidos. Ambas dependem dos resultados e da sua expiração; sem candidatos reais podem permanecer `false`. O painel apresenta as duas avaliações separadamente e preserva `tradeApproved: false` nos alertas de mercado. Publicar a página não elimina as lacunas de segurança nem autoriza operações.

Os tokens com estado `BLOCKED` são ocultados das listas, dos contadores e da última observação. O filtro volta a ser aplicado a cada consulta; se todos estiverem bloqueados, o painel apresenta um estado vazio. Os relatórios JSON conservam a evidência e os motivos dos bloqueios.

## Voltar a publicar

1. Executar `npm test`, `npm run validate` e `npm run profiles:check` antes do upload; verificar a sintaxe do dashboard e da Function.
2. Confirmar a equipa, o projeto `memecoin-radar` e o plano Hobby antes de qualquer publicação. O projeto local está ligado através de `.vercel/project.json`, excluído do controlo de versões; esse ficheiro precisa de ser recriado ou de uma ligação autenticada num ambiente novo.
3. Publicar os cinco ficheiros indicados, preservando a Function, os rewrites e os headers. A publicação inicial usou a API autenticada da Vercel, sem criar um repositório GitHub.
4. Verificar no URL de produção a página, os dois endpoints e duas recolhas distintas recebidas pelo polling do browser sem reload. Confirmar JSON fresco e ausência de cache em `/health` e `/latest`; testar também entrada válida/inválida e timestamp do gateway.

Não comprar planos, ativar trial pago ou ligar Blob para operar este collector. A página permanece sujeita aos limites e termos do Hobby.

## Porque o collector permanece na Cloudflare

O cron Hobby permite cada job apenas uma vez por dia. A recolha a cada minuto e a persistência do estado continuam no serviço Cloudflare já configurado. A atualização do dashboard apenas lê resultados; o cron mantém a recolha quando o browser está fechado.

Para a instalação e os limites do collector: [Cloudflare Free e configuração](FREE-HOSTING.md).

Fontes: [Rewrites externos](https://vercel.com/docs/rewrites), [Cron por plano](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Vercel Hobby](https://vercel.com/docs/plans/hobby).
