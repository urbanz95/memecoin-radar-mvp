apel: engenheiro sénior de sistemas de trading on-chain.

CONTEXTO
Repo memecoin-radar-mvp (Robinhood Chain 4663, Cloudflare Worker + Durable Object + D1, dashboard na Vercel). Branch base: feat/phase3-wallet-outcome-quality (b888ae5). Cria um branch novo a partir dela.
Fases 1 a 3 do MVP estão implementadas: arquivo de dados e outcomes, filtros duros e outbox dry-run do modo A (<24h), wallet scoring e relatório semanal. Antes de mexer em qualquer coisa, lê docs/AUDIT-2026-10-24.md (branch audit/phase0-3-20261024), docs/MVP-PROGRESS.md e docs/MVP-DATA.md.
Estado real segundo a auditoria: em produção nenhum score de wallets chega a completar (A04), há uma paragem do collector sem causa conhecida (A01), e só entram pares cotados em WETH, ETH nativo ou USDG.

EXECUTA AGORA: FASE 3B (consolidação). As fases 4, 5 e 6 ficam especificadas abaixo, mas cada uma só começa quando eu escrever "AVANÇA FASE N".

REGRAS
- Dry-run sempre. Sem trades. Sem envio real de Telegram: a outbox continua em pré-visualização até eu confirmar.
- Não baixes requisitos de filtros para aparecerem alertas. Desconhecido nunca passa e nunca vira zero.
- Nenhum LLM no caminho de decisão de entrada. LLM só para código, resumos e narrativa, nunca no score.
- Mantém interfaces e formatos atuais ou cria camada de compatibilidade. Migrations só aditivas, com ponto D1 Time Travel registado antes.
- Chaves em .env, logging estruturado, retries com backoff, config central em YAML/JSON validada, módulos desacoplados, testes em cada módulo novo ou alterado. No fim de cada bloco corre a suite completa, validate e profiles:check.
- Respeita os limites do plano Cloudflare Free (CPU do Worker, quotas D1/DO). Se algo não couber, propõe cadência ou lotes em vez de estourar a quota.
- Se precisares de algo meu (permissões, quotas, segredos), diz-me exatamente o quê e continua com o que não depende disso.

CONTRATO TRANSVERSAL (liga todas as fases)
A descoberta produz UM objeto "par" canónico e todos os módulos o consomem. Nenhum módulo lê QUOTE_ASSETS nem assume WETH/USDG.
- Par = { alvo (endereço), cotação { endereço, tier T0/T1S/T1/T2, flags }, pool principal (tipo, id), liquidez USD agregada, rota de preço (saltos, frescura), estado do par }.
- Estado do par: OK, UNPRICED_QUOTE, AMBIGUOUS_PAIR ou SPOOFED_QUOTE. Os três últimos são arquivados com outcomes, sem score nem alerta.
- Flags de cotação: ISSUER_CONTROLLED_QUOTE, QUOTE_PUMP, REFERENCE_STALE, CORPORATE_ACTION_BREAK.
- O par e as flags aparecem em: registo de dados (avistamentos, decisões, eventos, outcomes), filtros duros, wallet accounting, motor de score, alertas, verificação X, modo B, relatórios e backtest/modelo.
- Versão do score e da política incluem a config de cotações. Qualquer relatório ou dashboard separa coortes por versão, perfil e tier de cotação.
- Outcomes guardam retorno em USD E em unidades da cotação. Janelas que atravessem um CORPORATE_ACTION_BREAK ficam marcadas e nunca contam como ganho ou perda.
- Detecção de clones partilhada: se o símbolo ou nome de um token alvo coincidir com um stock token canónico noutro endereço, o alvo leva a flag TICKER_CLONE (risco crítico nos filtros duros) e entra no registo como tentativa de spoof.

========== FASE 3B: CONSOLIDAÇÃO (executa agora) ==========

3B-1 ESTABILIDADE (auditoria A01, A02, A05 a A09)
1. A01: diagnostica a paragem do collector (cron, CPU e duração do DO, quotas Workers/D1). Corrige. Acrescenta um heartbeat que me avisa quando passar [10] min sem ciclo, com a causa no payload, e não só COLLECTION_FAILED.
2. A02: isola o relatório semanal do caminho de ingestão (job próprio, paginado por coorte, sem o limite de 256 KiB a bloquear escritas).
3. A05: alinha o formatter da outbox com o score de wallets. Três carteiras em dois grupos independentes têm de gerar alerta.
4. A06: invalida decisões baseline em blocos órfãos antes de entrarem em relatórios, backtest ou treino.
5. A07: TTL no contador de wallets elegíveis. A08: limite de precisão do FIFO separado do limite de memória, persistindo componentes exatos por posição. A09: relatório e dashboard por versão, perfil e tier, nunca misturados.
Se a suite passar e o collector estiver estável há ≥[6]h, avança. Se A01 depender de algo meu, pára e diz-me o quê.

3B-2 PROVAS REAIS (A03, A04)
A03:
- Produtores de prova tipada para deployerHistory (contratos anteriores do criador, rugs conhecidos, origem dos fundos) e launchActivity (bundledSupplyPct, sniperManipulationConfirmed), no formato que hard-filters.mjs já exige (schemaVersion, checkedAt, evidence, complete).
- Diz-me quais requisitos de aprovação continuam por provar (privilégios do contrato, simulação em USD, proteção de LP v3/v4) e porquê. Não os contornes.
A04:
- Backfill de swaps e transfers dos últimos [30] dias. "Histórico completo" passa a ser "completo dentro da janela declarada", com campo historyWindow no perfil. Documenta em docs/MVP-DATA.md e faz bump para wallet-manual-v2. Vendas sem compra correspondente dentro da janela ficam fora do PnL, nunca com custo zero.
- Clustering: primeira fonte de fundos de cada carteira, compras no mesmo bloco da criação da pool e transferências diretas entre carteiras. Union-find com clusterId estável. Flags insider, bundler e washTrading com a evidência.
- Custos, taxas e atribuição passam a ser calculados em vez de fixos a false. Se um dado não existir, o campo fica false e dizes-me o que falta.
- Reconcilia ETH nativo em v4 (hoje NATIVE_OR_UNKNOWN_QUOTE_SETTLEMENT).

3B-3 PARES DE COTAÇÃO ALÉM DE ETH/WETH E USDG
Objetivo: descobrir, avaliar e pontuar pools cuja cotação não seja só WETH, ETH nativo ou USDG, incluindo tokens novos cotados em stock tokens (ex. AMC), memecoins (ex. $MEME) e outras stablecoins.

Fonte única de verdade e tiers
- config/quote-assets.json (validado e compilado como o profiles.yaml) substitui o QUOTE_ASSETS fixo de network.mjs. Por entrada: symbol, address (identidade é sempre o endereço, nunca o símbolo), decimals lidos on-chain, tier, usdRoute, minQuoteDepthUsd, enabled, evidence.
- Todos os módulos que hoje importam QUOTE_ASSETS (onchain/pools, cloudflare/providers, collector, pool-analysis, market-signals, outcomes, engine, trade-simulation) passam a consumir o objeto "par" do contrato transversal.
- T0: ETH nativo (moeda zero do v4), WETH, USDG. Comportamento atual, intocado.
- T1S (stock tokens oficiais da Robinhood): endereços lidos do registo on-chain de ativos (a tabela de docs.robinhood.com/chain/contracts é gerada a partir dele; localiza o contrato do registry, lê-o por RPC e ressincroniza todos os dias). Mesmo ticker ou nome noutro endereço = SPOOFED_QUOTE. Confirma os decimals on-chain. Stock tokens são cotação, nunca alvo.
- T1: outras stablecoins ou moedas principais com pool direta contra T0.
- T2: qualquer outro token usado como cotação (ex. $MEME). A allowlist T2 é reavaliada todos os dias. Uma cotação que perca profundidade ou rota de preço é desativada automaticamente, e os pares dela passam a UNPRICED_QUOTE.

Censo antes de ativar
- Corre um censo de criação de pools v2/v3/v4 nos factories configurados, SEM filtrar por cotação (o catálogo atual só tem pools com WETH/USDG, por isso não mostra o que falta).
- Tabela das cotações mais frequentes fora do T0: endereço, nº de pools, liquidez estimada, idade, rota de preço até T0, se passa os filtros duros.
- T1S ativa-se pelo registry. T1 e T2 ativam-se automaticamente só se cumprirem critérios objetivos em YAML: ≥[N] pools, profundidade ≥$[X] pela rota até T0, rota com no máximo 1 salto, o próprio token de cotação a passar os filtros duros e taxa de transferência zero. As restantes ficam enabled:false com o motivo.

Descoberta e escolha do alvo
- targetFor() passa a suportar qualquer par com pelo menos um lado na allowlist. Alvo = o token mais novo (prova de idade). Se nenhum lado estiver na allowlist, AMBIGUOUS_PAIR.
- Filtros duros e modo A correm sobre o alvo. A cotação é avaliada à parte, segundo o seu tier, e o resultado fica ligado ao par.
- O mesmo token em várias pools: liquidez agregada em USD, pool principal = a de maior liquidez USD, e o momentum usa sempre a mesma pool.

Preço e liquidez em USD
- Liquidez, FDV e impacto de preço sempre em USD pela rota comprovada até T0. Sem rota fresca (≤[120]s) ou abaixo da profundidade mínima: UNPRICED_QUOTE.

Segurança da cotação, por tier
- T1S: não rejeites por poderes do emissor. Lê o bytecode e o ABI e regista as flags (pause, blacklist, proxy upgradeável, uiMultiplier). Se existirem, o par leva ISSUER_CONTROLLED_QUOTE, visível no alerta: o emissor pode bloquear a cotação e prender a pool. A simulação de venda é obrigatória e a perna da cotação tem de sair. Não assumas que não há pausa só porque a documentação não a menciona.
- Preço da cotação sempre pela rota on-chain até T0, nunca oráculo × saldo cru. Se usares o feed Chainlink como referência, aplica o uiMultiplier.
- Desvio face à referência só conta dentro da janela de tokenização (seg 02:00 a sáb 02:00 CET/CEST) e fora de corporate actions. Fora disso, REFERENCE_STALE e não rejeites. Dentro da janela, desvio > [X]% = flag e par sem score.
- Se o uiMultiplier mudar entre observações, CORPORATE_ACTION_BREAK (quebra de série; momentum e outcomes que a atravessem ficam marcados).
- T1 e T2: o token de cotação passa todos os filtros duros como se fosse alvo, com taxa zero e sem rebase, pausa, blacklist ou proxy sem prova. Depeg acima de [X]% = rejeitado.
- T2 ($MEME e afins): liquidez USD = mínimo entre o preço spot e a mediana de [15] min. Se a cotação subiu mais de [X]% em 1h, QUOTE_PUMP, e essa subida não conta como liquidez do token novo.

Simulação, accounting e alertas
- trade-simulation generalizado a qualquer cotação da allowlist, com montante de teste em USD pela rota de preço. Sem simulação suportada (cotação ou tipo de pool): INCOMPLETE, nunca PASS. Se não conseguires suportar v3/v4 já, diz-me o que falta.
- Produtor dos price proofs (quoteUsd, feeAssetUsd) a partir da rota de preço, com a atualidade que o accounting já exige. Valor USD do trade = montante de cotação × preço USD da cotação nesse bloco. Sem rota provada nesse bloco, o trade fica fora do PnL e a carteira INCOMPLETE.
- Alertas (outbox dry-run) mostram: cotação, tier, liquidez USD, flags, top 3 razões, carteiras envolvidas, link do gráfico, etiqueta [NOVO].

Implantação em duas etapas
- Etapa 1 (shadow, ≥[3] dias): descoberta e arquivo dos novos pares, sem score nem alertas. Reporta contagens por tier e uso de D1 (free ~90 MB), estima o crescimento por dia e a retenção que aguenta.
- Etapa 2: ligar o score só para as cotações com cobertura de preço ≥[95]% e outcomes a preencher.

Testes obrigatórios da fase 3B
- Regressão: WETH, ETH nativo e USDG com resultado idêntico ao atual.
- Cotação falsa com símbolo de uma real; AMC falso noutro endereço; token alvo com TICKER_CLONE; cotação sem rota; rota obsoleta; cotação com taxa; par com dois tokens fora da allowlist; depeg.
- uiMultiplier a mudar a meio de um outcome; par avaliado ao fim de semana; $MEME inflacionado 5x; AMC pausado com a venda a falhar (INCOMPLETE ou REJECTED, nunca PASS).
- Mesmo token em 3 pools com cotações diferentes; retorno em USD vs em unidades da cotação; relatório semanal separado por tier.

PARA no fim da etapa 1 do shadow: changelog por item da auditoria e por bloco, o que ficou por fazer, riscos conhecidos, cotações ativadas e rejeitadas com o motivo. Mostra-me o estado.

========== FASES SEGUINTES (só com "AVANÇA FASE N") ==========

FASE 4: VERIFICAÇÃO NO X
- Handle oficial do alvo via metadata/site, com confirmação bidirecional (token → X → token). Perfis fake ou copiados ficam marcados.
- Métricas: idade da conta, rácio followers/following, engagement real vs inflado, % de bots a interagir, histórico de tokens promovidos, menções antes vs depois do lançamento, picos coordenados, texto repetido.
- Fonte: [API oficial do X / provider]. Sem scraping que viole os ToS. Cache agressivo. Só corre em tokens que já passaram filtros duros e têm sinal de wallets (par OK), por causa do custo.
- Output: x_score + flags ("shill coordenado", "conta nova", "followers comprados"), guardados no registo ligados ao par e à versão. Alvos com TICKER_CLONE ou cotação SPOOFED_QUOTE nunca chegam aqui.
- Peso inicial do X no score = 0 (só flags e dados em shadow). Só ganha peso depois de a Fase 6 mostrar valor fora da amostra. Os pesos de profile_new continuam a somar 100.

FASE 5: MODO B (TOKENS EXISTENTES)
- Antes de ativar: mede o universo real por limiar de idade. O YAML atual exige ≥2.880 horas (120 dias) e config.mjs força profile_existing.enabled=false. Calcula quantos tokens com liquidez ≥$[Y] e volume ≥$[Z] existem para cada limiar ([7], [14], [30], [60], [120] dias) e propõe o limiar com universo útil. Altera o validador de forma explícita e testada.
- Universo: pares OK de qualquer tier, com liquidez USD agregada entre todas as pools do token. Stock tokens e cotações da allowlist ficam fora do universo (não são memecoins). Reavaliação a cada [N] min, não em tempo real.
- Sinais: tendência de volume e holders (1h/24h/7d), fluxo líquido de smart money (acumulação vs distribuição, usando wallet scoring e clusters), variação de liquidez e de LP em todas as pools do token, vendas do deployer e unlocks, wash trading ao longo do tempo, breakout vs média móvel.
- Sinais de SAÍDA: smart money a distribuir, liquidez a cair, dev a vender, e também a cotação a degradar-se (QUOTE_PUMP a desinflar, ISSUER_CONTROLLED_QUOTE com pausa ativa, depeg).
- CORPORATE_ACTION_BREAK é tratado como quebra de série, nunca como breakout ou queda.
- profile_existing no YAML: 40% fluxo de carteiras, 30% tendência, 20% liquidez/segurança, 10% X (a 0 até a Fase 6 justificar). Alertas dry-run com etiqueta [EXISTENTE] e ENTRADA ou SAÍDA.
- Reaproveita 100% dos módulos partilhados (filtros duros, wallet scoring, par canónico, registo de dados). Só muda a camada de histórico e os pesos.

FASE 6: BACKTEST E MODELO
- Gate: só arranca com ≥[300] lançamentos únicos com os quatro outcomes completos, na mesma versão e perfil, depois de A06 aplicado. Reporta também a contagem por tier. Tiers com menos de [N] amostras ficam "insuficiente" e nunca são extrapolados.
- Backtest com slippage calculado pela profundidade da pool no momento, taxas, latência de entrada e liquidez real da altura. Sem lookahead, incluindo tokens mortos e rejeitados. Janelas com CORPORATE_ACTION_BREAK ou pares UNPRICED_QUOTE ficam fora do treino e do cálculo de resultado, e dizes quantas foram.
- Resultados em USD e em unidades da cotação, por modo (A e B), por faixa de score e por tier. Relatório: win rate, EV por trade, max drawdown.
- Modelo (gradient boosting) treinado no registo de dados, com tier e flags da cotação como features. Comparado contra os pesos manuais fora da amostra, só substitui se bater o baseline em todos os tiers com amostra suficiente. Se não bater, mantém os pesos manuais e diz-me.

ENTREGA EM CADA FASE
Changelog, o que ficou por fazer, riscos conhecidos, e o que decidiste por mim (com o motivo).