# Análise automática e listas de acompanhamento

O collector Cloudflare analisa **um contrato por ciclo**, no cron de um minuto. O dashboard apresenta listas de novos lançamentos, contratos estabelecidos e contratos sem idade comprovada. Cada entrada reúne métricas observadas, riscos, lacunas e hora da análise. Cada entrada distingue o alerta de mercado da avaliação estrita de segurança. `MARKET_ALERT` assinala atividade para revisão, com `tradeApproved: false`; `CANDIDATE` exige a política estrita completa. Nenhum destes estados executa uma operação.

A funcionalidade é ativada por `ANALYSIS_ENABLED: "1"` em `wrangler.json`. O painel consulta o backend a cada 30 segundos enquanto está visível. Essa consulta não inicia análises e a recolha continua com o browser fechado.

## Escolha do contrato e prova da idade

A seleção alterna descoberta recente e rotação do catálogo. Em cada quatro ciclos, um deles procura uma pool estimada entre 20 minutos e 48 horas para evitar selecionar apenas contratos acabados de criar. Depois de escolher uma pool, a análise mantém o contrato durante **três ciclos consecutivos**: holders, proteção da LP e simulação, respeitando o orçamento RPC de cada execução. A descoberta continua nesses ciclos. Os blocos do intervalo de seleção são estimados a partir da cadência observada da rede. **Esta estimativa só escolhe o contrato a analisar:** não comprova a idade do token. A rotação de entradas antigas também não prova que um contrato tem sete dias.

Para classificar a idade, são usados recibos e leituras históricas de código:

| Grupo | Prova exigida para a classificação de acompanhamento |
|---|---|
| Novos | Criação exata comprovada entre 15 minutos e 48 horas, ou presença de bytecode num bloco com pelo menos 15 minutos e ausência num bloco com até 48 horas, com timestamps reais verificados |
| Estabelecidos | Criação exata comprovada há pelo menos sete dias, ou presença de bytecode num bloco com pelo menos sete dias |
| Sem classificação | As provas disponíveis não permitem demonstrar uma das janelas acima |

As leituras históricas começam por uma estimativa e validam os timestamps dos blocos obtidos. Para pools mais jovens, as referências pretendidas são cerca de 16 minutos, 47 horas e sete dias mais uma hora; a classificação usa os tempos efetivos. Para uma pool com pelo menos sete dias, a presença de código do token nesse bloco pode provar apenas um limite inferior. Hashes canónicos são revalidados após as leituras. Dados contraditórios ou orçamento insuficiente mantêm a classificação desconhecida.

`contractCreatedAt` só é preenchido com um recibo de criação direta bem-sucedida, correspondente ao contrato, transação e bloco canónico, com deployer válido. A transação de criação da pool e o índice de deployment Sourcify são apenas candidatos para encontrar esse recibo. Um deployment interno numa factory não fica provado por um recibo cujo `contractAddress` não corresponde ao token. A data `verifiedAt` do Sourcify não é a data de criação.

Os limites de existência de código ficam em `age.lowerBoundMinutes` e `age.upperBoundMinutes`, com a base e os blocos de evidência. Não são convertidos numa data exata. A classificação de acompanhamento pode, por isso, ser conhecida enquanto a aprovação estrita continua `INCOMPLETE` por falta de `contractCreatedAt` ou de outras provas.

## Métricas on-chain e mercado externo

A leitura nativa usa o bloco observado e o deployment configurado:

- v2: factory, tokens, índice `getPair`, reservas e preço em WETH ou USDG.
- v3: factory, tokens, fee, índice `getPool`, `slot0`, liquidez ativa e saldos do contrato.
- v4: estado e liquidez através do StateView configurado, incluindo pares com ETH nativo. A moeda zero representa ETH, usa 18 casas decimais e não recebe chamadas ERC-20 `decimals()` ou `balanceOf()`. A identidade completa, os hooks e a executabilidade continuam sujeitos a revisão.

Liquidez ativa e saldos de uma pool concentrada não equivalem à profundidade de venda executável. Os preços nativos estão em unidades do contrato de cotação oficial; não se pressupõe que USDG vale um dólar.

A atividade usa **até 512 blocos da pool e 64 logs**. Os totais só são apresentados quando a amostra é válida e cabe no limite. Mais de 64 logs deixam a amostra incompleta, sem totais apresentados como completos. Contagem de transações não é contagem de traders únicos; a amostra de blocos não é uma janela completa de cinco minutos nem prova volume orgânico.

O DEXScreener fornece métricas externas de preço, liquidez, FDV, volume e variação, quando disponíveis. A identidade exige a chain Robinhood, o contrato base exato e um quote oficial; v4 também admite ETH nativo identificado pela moeda zero, mantendo-o distinto de WETH. Endereços de par têm 20 bytes; IDs de pools v4 têm 32 bytes e exigem a identificação v4 correspondente. O par externo escolhido fica identificado separadamente em `externalMarket.pairAddress`; pode diferir da pool lida por RPC e não substitui a sua evidência. São preservados `volumeUsd`, `priceChangePct` e `txns` por janela (`m5`, `h1`, `h24`). Esses valores são reportados pelo fornecedor: alimentam a avaliação de mercado, sem preencher os campos USD on-chain exigidos pela política estrita.

## Alertas de mercado e aprovação estrita

[`config/market-signals.json`](../config/market-signals.json) define uma avaliação própria para os dois grupos de idade. O alerta exige identidade, observação do contrato até dez minutos, mercado até 120 segundos, filtros e score ≥75, seguidos de observações distintas no tempo. Os limiares e fórmulas estão em [PARAMETERS.md](PARAMETERS.md). São hipóteses sem backtest; não representam uma probabilidade de lucro.

Cada entrada contém `signal`, com critérios, motivos, campos em falta, fonte, data, expiração e confirmação. Os estados são `WAITING_DATA`, `OUT_OF_SCOPE`, `NO_SETUP`, `CONFIRMING`, `MARKET_ALERT`, `STALE` e `BLOCKED`. Um risco observado bloqueia o alerta; a ausência de riscos observados não prova segurança. `MARKET_ALERT` conserva `tradeApproved: false`, mesmo quando o score e a confirmação passam. Auditoria conclusiva, insiders, proteção de posições v3/v4 e simulação exigida pela política continuam necessários à aprovação estrita.

O collector renova o mercado de todas as entradas retidas numa chamada conjunta DEXScreener, até 20 contratos e no máximo uma chamada por minuto. Esta renovação não muda `observedAt` do contrato nem as datas dos módulos de segurança. Falha HTTP ou cooldown só permite reutilizar cache ainda válido; uma resposta completa sem o token invalida o mercado anterior desse token. Uma métrica ausente continua ausente.

`/latest` revalida a expiração em cada GET. `marketSignalsAvailable` indica pelo menos um `MARKET_ALERT` atual; `currentSignalsAvailable` indica pelo menos um candidato estrito `CANDIDATE` válido, com score, identidade e evidência ainda atuais. `signals.marketAlerts` e `signals.tradeCandidates` são listas separadas. Cabeça com mais de 60 segundos, timestamp futuro inválido ou evidência expirada impede apresentar resultados antigos como atuais. Nenhuma flag é forçada a `true` para preencher o painel.

## Segurança e estados

Leituras de `paused()`, owner e slots EIP-1967 acrescentam observações reais. Um owner observado não descreve todos os seus privilégios; slots vazios e `paused() = false` não demonstram ausência de risco.

GoPlus é uma fonte externa complementar. Só riscos positivos com correspondência direta podem alimentar bloqueios, por exemplo mint, pause, taxas alteráveis, confisco, hidden owner ou honeypot reportados. Uma flag negativa do fornecedor não comprova que o contrato é seguro. A sua contagem e distribuição de holders permanecem explicitamente reportadas; uma lista parcial de top holders fornece candidatos a leituras independentes, sem ser tratada como distribuição completa. O painel identifica falhas HTTP e indisponibilidade das fontes.

### Contrato e privilégios

O bytecode observado no bloco fixado é comparado com o artefacto on-chain e o bytecode recompilado do Sourcify. Só uma correspondência exata e sem implementação delegada por verificar pode preencher `security.contractVerified`. O pedido compacto obtém ABI, compilação e artefactos de runtime; não descarrega a árvore completa de fontes nem equivale a uma auditoria do código.

A análise apresenta interfaces sensíveis, owner, slots EIP-1967 e indicadores de instruções EVM. Um opcode observado não prova que esse caminho é executável; os dados de `PUSH` não são tratados como instruções. Delegação reconhecida ou slots proxy preenchidos exigem verificação da implementação. A ausência de uma interface, de slots preenchidos ou de um owner não preenche flags negativas como `canMint: false` ou `hiddenPrivileges: false`.

O resumo do artefacto fica em cache por rede, endereço e hash do runtime, até 8 KiB. O mesmo código é reutilizado; estado dinâmico continua a ser lido. Indisponibilidade impõe pausas antes de nova consulta: seis horas para 404, uma hora para 429 e cinco minutos para falhas transitórias. Datas de consulta da fonte e de leitura do contrato são distintas.

### Distribuição de holders

O índice reconstrói os eventos `Transfer` desde uma criação direta comprovada ou desde o genesis, verificando neste último caso que o contrato ainda não tinha código nesse bloco. Intervalos densos são reduzidos sem saltar blocos; cursor e saldos ficam guardados para continuação. Logs inválidos, contraditórios, removidos ou de outra identidade não entram na distribuição. Uma reorganização invalida a continuidade.

Contagem e concentrações exatas só são publicadas quando o histórico chega ao bloco fixado, a emissão reconstruída coincide com `totalSupply` e os saldos são confirmados por `balanceOf`. Para listas maiores, uma chamada de leitura com código efémero agrega até 1.024 saldos, com verificações diretas adicionais; não existe contrato publicado nem transação enviada. O índice aceita até 1.024 endereços e 128 KiB de estado por token. Exceder um limite mantém cobertura incompleta, sem truncar a lista e apresentá-la como completa.

Pools com identidade comprovada são excluídas da contagem e concentração de carteiras; a emissão total continua a ser o denominador das percentagens. Mesmo com histórico parcial, um saldo individual confirmado pode provar um limite inferior de concentração e bloquear a análise. Financiamento de insiders e supply em bundles continuam desconhecidos: estar na mesma transação não prova relação financeira.

### Proteção da liquidez

Para uma pool v2 com identidade verificada, são lidos `totalSupply` dos LP tokens e saldos dos endereços zero, dead e, quando comprovado, do criador. O cálculo exclui os 1.000 LP mínimos do Uniswap v2; sem confirmação dessa constante, exclui conservadoramente todo o saldo do endereço zero. O limiar de 95% de queima é comparado com inteiros exatos e confirmado num bloco canónico.

Esta prova refere-se à **pool selecionada**. Um saldo de LP do criador não prova sozinho que ele controla a retirada, e queima de uma pool não comprova a proteção de todas as pools do token. Não são inferidos bloqueios ou datas de desbloqueio de contratos locker. Posições NFT v3 e posições v4 continuam sem proteção comprovada por este módulo. A leitura isolada não preenche a proteção global exigida pela aprovação estrita.

### Simulação de compra e venda

A simulação usa uma única execução `eth_call` com código e saldo efémeros para fazer a compra e a venda numa pool v2 oficial com WETH. Confirma a identidade da pool e a cabeça canónica, mede os saldos efetivamente recebidos e preserva a etapa e o motivo de uma reversão. Usa até dois pedidos HTTP RPC e não assina nem envia transações.

A quantidade inicial é **0,001 WETH**. O resultado mostra taxas de transferência observadas e perda de ida e volta. Taxas positivas ou falha observada acrescentam riscos; sucesso não demonstra ausência universal de honeypot, comportamento idêntico para outros endereços ou segurança futura. Esta quantidade não prova a simulação de **100 USD** exigida pela política. Pools v3/v4 e pares sem WETH ficam explicitamente indisponíveis neste simulador, sem aprovação por aproximação.

O motor estrito continua a avaliar os campos de segurança conhecidos quando falta a data exata de criação. Um risco conhecido pode resultar em `BLOCKED`, preservando as lacunas; a ausência de idade não termina antecipadamente a avaliação com um simples `INCOMPLETE`. Sem riscos conhecidos, dados críticos ausentes continuam a impedir aprovação.

`BLOCKED` identifica riscos observados. O painel Vercel oculta automaticamente esses tokens das três listas, dos seus contadores e da última observação; a próxima consulta retira um token que passe a bloqueado. Se todos estiverem bloqueados, apresenta uma lista vazia. Os relatórios do collector conservam os resultados e os motivos para consulta. `REVIEW` mantém a revisão pendente; `WATCH` identifica, entre outros critérios de seleção, liquidez externa abaixo do limiar do grupo. A ausência de um risco observado não atribui aprovação. Os estados estritos de ambos os pipelines continuam apresentados separadamente.

A prioridade de análise usa métricas externas disponíveis: liquidez com peso 35, volume com peso 40 e momentum com peso 25. Usa volume de cinco minutos para novos e de 24 horas para estabelecidos; o momentum usa cinco minutos e uma hora, respetivamente. Sem os campos necessários ou com riscos conhecidos, não é calculada. Esta prioridade é distinta do score de aprovação da política e não é uma probabilidade de valorização.

## Orçamento, retenção e atualidade

O limite total é **32 pedidos HTTP RPC por ciclo**. A análise respeita tetos intermédios e reserva os dois últimos pedidos para revalidar a cabeça fixada e ler a cabeça final. A fase de segurança usa até dois pedidos adicionais dentro desse total. Os pedidos externos são separados: GoPlus para o contrato analisado, uma chamada conjunta DEXScreener para o mercado e até dois pedidos Sourcify, para idade e artefacto de código. Cada pedido tem prazo de três segundos, sem retries imediatos. GoPlus, DEXScreener e o artefacto de código têm limite de 128 KiB por resposta; os metadados de idade Sourcify, 32 KiB. O estado persistente dos fornecedores tem teto de 32 KiB, até 20 entradas por fornecedor e TTL de 120 segundos para mercado e 300 segundos para GoPlus. Há intervalo mínimo de um minuto por fornecedor e backoff exponencial, respeitando `Retry-After` dentro do limite configurado, após falhas ou rate limits. Reutilizar cache preserva a data original. Falhas e limites deixam lacunas explícitas; não exigem plano pago nem chave de carteira.

As listas guardam até **20 contratos, seis horas e 64 KiB** no estado de controlo D1 existente. A atualização usa a mesma transação e o mesmo fencing do collector, sem nova migration ou base de dados. O arquivo de relatórios mantém a retenção separada de três horas. Uma reorganização reinicia a continuidade; não se reutiliza uma aprovação antiga como atual.

O estado de continuação de segurança é separado da lista visível: até 12 contratos durante seis horas, 192 KiB por entrada e 512 KiB no total. Guarda cursor de holders, resumos de código e avaliações por módulo, sem repetir bytecode ou fontes completas. O limite de bytes pode reduzir o número de contratos retidos antes do teto de entradas.

Quando um histórico de holders ainda não está conciliado, dois em cada três grupos de análise retomam o cursor pendente menos recentemente lido; o terceiro permite analisar outro contrato. Assim, uma resposta demasiado grande pode reduzir o intervalo e voltar a ser tentada automaticamente, sem esperar pela rotação de todo o catálogo. A descoberta de pools continua em todos os ciclos. Limites de capacidade e expiração continuam explícitos; esta fila limitada não garante indexação integral de todos os tokens da rede.

A evidência RPC persistida é limitada e não constitui um arquivo integral das respostas brutas. O registo RPC agregado tem teto de **128 KiB**, com compactação por entrada acima de 16 KiB. Para blocos, guarda os campos número, hash e timestamp usados na validação; para recibos, os oito campos de identidade, estado e localização utilizados na prova. Bytecode é representado por validade, presença, tamanho e hash Keccak-256, sem repetir o código inteiro. Resultados de logs acima de 8 KiB e outros resultados acima de 2 KiB são resumidos por tamanho e hash SHA-256 do JSON; logs incluem também a contagem. Os resumos identificam `evidenceFormat` e `rawRetained: false`. Sob pressão do limite agregado, os registos podem ser compactados adicionalmente, incluindo parâmetros grandes, preservando método e ID da chamada.

As respostas originais continuam a ser entregues às validações; a projeção altera apenas o que fica arquivado. Os metadados de `tokenFacts` usam valores tipados e referências, sem duplicar as respostas brutas de `decimals` e `totalSupply` fora do registo RPC limitado. Um hash permite comparar um valor obtido novamente, mas não recuperar a resposta omitida nem repetir uma análise completa a partir do resumo. Os 128 KiB limitam o registo RPC; o limite global da evidência da sessão, incluindo metadados, continua em 256 KiB. As referências D1 expiram com a retenção; não devem ser apresentadas como um arquivo permanente para backtest.

Cada contrato conserva `observedAt` e cada módulo de segurança a sua própria data. O dashboard assinala observações com mais de dez minutos como desatualizadas, mesmo que outro módulo ou contrato tenha sido atualizado. A hora da última consulta do browser, da última recolha e de cada análise são distintas. A continuação conserva resultados anteriores sem renovar a sua hora; não volta a publicar métricas antigas como leituras novas. Entradas retidas durante seis horas não são seis horas de dados frescos. A disponibilidade dos alertas e candidatos é calculada a partir dos resultados válidos e revalidada na leitura; a retenção não prolonga a sua validade.

Os parâmetros dos dois pipelines estão em [PARAMETERS.md](PARAMETERS.md), os limites da infraestrutura em [FREE-HOSTING.md](FREE-HOSTING.md) e as verificações de produção em [OPERATIONS.md](OPERATIONS.md). Nenhuma destas listas certifica tokens seguros ou garante ganhos.

## Incidente de evidência em 22/10/2026

Após a última recolha bem-sucedida das 14:12 UTC, o serviço passou a devolver `EVIDENCE_BUDGET_EXCEEDED`: respostas RPC individualmente válidas excediam o orçamento agregado do arquivo, incluindo bytecode repetido, intervalos de logs posteriormente reduzidos e respostas brutas duplicadas nos metadados. O erro impediu confirmar novos relatórios e manteve o último resultado antigo visível como desatualizado. A projeção limitada e a remoção das duplicações corrigem essas causas sem flexibilizar as validações de segurança. A recuperação de um cron natural está registada em [OPERATIONS.md](OPERATIONS.md); testes locais e ciclos isolados não demonstram estabilidade contínua durante 24 horas.
