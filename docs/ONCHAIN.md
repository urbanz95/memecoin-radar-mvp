# Recolha on-chain — Robinhood Chain 4663

O collector consulta a mainnet e alimenta os dois pipelines com o que consegue comprovar. A demonstração continua separada e sintética. Não há carteira, assinatura, swaps enviados, Telegram ou deployment nesta integração.

## Executar

```sh
npm ci --ignore-scripts
npm run collect
npm run collect -- --max-tokens 4 --recent-hours 2 --backfill-chunks 2
npm run collect:watch
```

`ROBINHOOD_RPC_URL` é uma variável opcional do servidor para um endpoint dedicado. Sem ela usa-se o [RPC público oficial](https://docs.robinhood.com/chain/connecting/). Manter proxies e certificados do ambiente; o transporte usa `undici.EnvHttpProxyAgent`. Não colocar URLs privadas com API keys no GitHub. O collector não imprime nem arquiva a URL do RPC e não necessita de chave de carteira.

O modo contínuo da CLI executa uma sessão, espera `pollSeconds` e repete; não sobrepõe sessões. O intervalo total por token depende da duração e da rotação do enriquecimento. Uma sessão longa pode expirar as evidências da política; o motor continua a rejeitá-las. Esse modo exige um processo vivo. Para operação contínua com recuperação foi acrescentado um worker Linux + systemd, preparado para alojamento gratuito com disco persistente: ver [instalação e limites](FREE-HOSTING.md). A página pode ficar na Vercel Hobby, sem cron/Blob de recolha.

## O que recolhe

1. Confirma `eth_chainId=4663` antes de descobrir contratos. A testnet é recusada.
2. Lê cabeça e hash da cadeia, eventos `PairCreated` de v2, `PoolCreated` de v3 e `Initialize` de v4. Os deployments configurados estão no [registry oficial Uniswap](https://developers.uniswap.org/deployments.json). O ID de v4 é recalculado a partir da PoolKey para validar o evento.
3. Mantém um catálogo persistente, sobrepõe a cauda nas retomas, compara checkpoints e deteta alterações de código das factories/managers. O backfill percorre a história gradualmente. Há também amostras históricas a partir de 14 dias para observar pools antigas desde a primeira sessão. **Uma amostra não preenche o intervalo intermédio nem torna o histórico completo.**
4. Seleciona contratos com pares WETH/USDG, excluindo pares entre os próprios quote assets. Reserva parte do orçamento para os mais recentes e parte para os menos observados, incluindo as amostras antigas. Estes ERC-20 são candidatos de recolha, não uma classificação comprovada de “memecoin”.
5. Para os contratos selecionados lê símbolo, decimals, supply, bytecode/hash, respostas opcionais de `owner`/`paused` e os slots EIP-1967 de implementação, admin e beacon.
6. Tenta provar deployment por recibo de criação direta ou trace de `CREATE`/`CREATE2`, com bloco canónico e hash do código criado. Também tenta localizar a fronteira histórica de código via archive. Essa fronteira **não é publicada como data de deployment sem prova de criação**. A data da pool nunca substitui a data do contrato.
7. Verifica identidade de pools v2/v3 na factory e lê reservas, slot0, tick, fees, liquidez ativa e, em v3, saldos por pool. Em v4 usa o StateView e o pool ID; o saldo global do singleton não é atribuído a uma pool.
8. Lê swaps de até 24h, em intervalos de blocos calculados por timestamps reais. Guarda volumes em quote currency para 5m, 5m anteriores, 1h e 24h, contagens de swaps/transações e preços racionais em quote. As convenções de sinal v3/v4 são diferentes e têm testes próprios.
9. Fixa leituras por altura e reconsulta o hash dessa altura antes do commit. Se mudar durante a sessão, descarta os snapshots. Regista a etapa mínima de confirmação conhecida como `sequencer`, sem afirmar finalização em Ethereum.

Só são enriquecidos até `maxTokensPerRun` contratos e `maxPoolsPerToken` pools de cada contrato por sessão. O catálogo pode ser muito maior. `coverage` inclui os intervalos efetivamente lidos, cursores, contagens e a indicação de histórico incompleto. Outras DEX, curvas e pares sem WETH/USDG não estão cobertos. Os defaults são uma configuração operacional inicial, não uma garantia de cobertura de mercado.

## O que não infere

- Um `owner` zero, `paused=false`, ausência de um selector ou slots de proxy vazios **não provam ausência de privilégios**. Os flags negativos de segurança ficam em falta. Estado pausado e slots de proxy ocupados podem justificar exclusões conservadoras, mas não constituem uma auditoria completa.
- Não preenche `contractVerified` sem prova de código e implementação. O explorador devolveu HTTP 403 na verificação inicial; não há fallback que transforme a indisponibilidade em verificação positiva.
- Contagens de transações ou endereços de routers não substituem traders únicos, organicidade, holders, insiders ou coordenação de lançamento.
- Preços/volumes WETH ou USDG não são USD. Não presume USDG=US$1. Liquidez ativa de CLMM e saldos de contratos também não são profundidade executável em USD.
- Reservas e quotes não substituem proteção de LP nem simulação de compra/venda com estado encadeado. Essas métricas continuam ausentes.
- Pools sem swaps ou com reservas zero continuam no catálogo. Não são apresentadas como oportunidades.

Os snapshots reais têm `synthetic=false`, mas o motor mantém `dataMode=unverified-input`: a origem não é autenticada criptograficamente pelo avaliador. O collector e os seus ficheiros têm de pertencer a uma zona de confiança. Os campos em falta mantêm o estado `INCOMPLETE`; nenhuma regra foi reduzida para gerar candidatos.

## Resultados e persistência

`runtime/onchain/latest.json` é o bundle atómico atual:

- `coverage`: catálogo, contratos selecionados/enriquecidos, intervalos por venue e estado do histórico.
- `snapshots`: dados normalizados parciais, com `collection.gaps` por contrato.
- `results`, `alerts`, `evaluationState`: avaliação dos dois pipelines e continuidade.
- `discovery`, `observations`: cursores, catálogo, cache de provas de criação e rotação.
- `rawEvidenceFile`: arquivo da sessão em `runs/<runId>.rpc.json`.

O arquivo inclui as respostas RPC originais, blocos, metadados, estado de pools e atividade. As referências `#security`, `#market`, `#activity` e `#chainState` nos snapshots apontam para secções desse arquivo. Provas de criação reutilizadas mantêm `evidenceFile` da sessão de origem. Não apagar arquivos que ainda sustentem provas em cache; planear retenção e armazenamento antes de operação prolongada. O diretório `runtime/` é excluído do GitHub e do ZIP do código.

Há também um array imutável `runs/<runId>.snapshots.json`, compatível com a CLI `scan` enquanto as evidências ainda forem recentes. O collector já avalia os pipelines; não se deve iniciar um segundo canal de notificações sobre o mesmo conjunto sem deduplicação.

Estados operacionais:

| Estado | Significado |
|---|---|
| `PARTIAL` | Recolha executada, mas esta integração ainda não comprova todas as métricas críticas |
| `DEGRADED` | Uma ou mais fontes/pools/contratos falharam; consultar `errors` e cobertura |
| `ERROR` | Sessão descartada; resultados, alertas e continuidade de avaliação são invalidados |

Um erro mantém o catálogo anteriormente confirmado para retoma, mas nunca mantém os candidatos da sessão anterior como atuais. Há lock por diretório; um crash pode deixar o lock e deve confirmar-se que o processo terminou antes de o remover. Erros de configuração ou estado corrompido interrompem o arranque; o consumidor deve verificar a hora do bundle e saúde do processo em vez de confiar apenas na presença de um ficheiro antigo.

## Limites e próximos dados necessários

Timeout, retries, intervalos, máximo de logs/swaps e orçamento RPC são limitados. Respostas de logs demasiado grandes são divididas em intervalos menores; uma leitura incompleta não produz um volume dito completo. Cada fornecedor pode ter limites adicionais e indisponibilidades. O RPC público não é uma garantia de archive, traces, quotas ou cadência de produção. Na primeira recolha real, as tentativas históricas de código devolveram `-32000`; a prova de deployment ficou em falta, em vez de ser inferida de um listing.

Para completar sinais reais: fornecedor com archive/traces e capacidade medida; análise verificável de código/permissões e hooks; histórico de holders e heurísticas de insiders; provas de LP; simulação EVM com estado; e preços USD com origem/atualidade verificáveis. Depois, executar shadow mode/backtest e calibrar os parâmetros. O serviço só será um radar de candidatos aprovados quando estas evidências estiverem presentes — não apenas quando conseguir descobrir tokens.
