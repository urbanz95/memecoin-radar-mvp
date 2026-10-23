# Como validar e calibrar

## Estado atual

Os testes validam o comportamento do software e a demo usa dados sintéticos. Já existe recolha on-chain real, com catálogo e evidência RPC arquivada, mas não foi constituída uma amostra representativa para validação, realizado backtest ou estimado retorno. Os limiares e pesos de `robinhood-observe-v2` são hipóteses de triagem para a Robinhood Chain, não resultados transportados de outra rede. Pools catalogadas e contratos parcialmente enriquecidos não equivalem a memecoins aprovadas.

## Recolha histórica

Guardar snapshots imutáveis, respostas de origem, chain ID/ambiente, bloco/hash, etapa de finalização, event time, ingest time e versão do adaptador. Incluir tokens que perderam liquidez, foram removidos de fornecedores ou tiveram rug pulls; não reconstruir o universo apenas pelos sobreviventes atuais. As permissões ERC-20, implementações, holders e locks têm de ser os da data de avaliação, não os atuais. Usar RPC archive/traces quando necessário. Dados da testnet não validam liquidez, preços ou retornos da mainnet.

Começar por pelo menos 30 dias de observação e, como meta operacional de cobertura, 1000 lançamentos e 300 tokens estabelecidos. Estes números não garantem poder estatístico: se houver poucos alertas ou um único regime de mercado, prolongar a amostra. Separar períodos cronológicos para ajuste, validação e avaliação fora da amostra; agrupar por token/deployer para não contaminar os conjuntos. Não otimizar no mesmo período que serve para anunciar resultados.

O modo CLI usa relógio atual. Um replay histórico terá de chamar o motor com `now` igual ao instante histórico e reproduzir a ordem e disponibilidade real dos dados; não editar timestamps para transformar dados atuais em históricos. O relógio injetável já existe, mas não há replay/backtest implementado nesta versão.

## Resultado a medir

- Cobertura: percentagem de tokens com todas as evidências, incompletos por campo/fornecedor e atraso até à primeira avaliação válida.
- Segurança: rug pulls/saídas impossíveis entre candidatos, falhas não detetadas, falsos bloqueios revistos manualmente e tempo para revogar um candidato.
- Seleção: candidatos por pipeline/dia, estabilidade do score, repetição de sinais e ganho em relação a uma baseline simples de idade/liquidez.
- Mercado: retornos executáveis aos 15m, 1h, 6h e 24h, e também 7 dias no estabelecido; máxima excursão favorável/adversa, drawdown, sobrevivência da liquidez e falhas de venda.
- Execução simulada: spread, slippage, taxas, custos de rede, impacto e capacidade para o montante de teste. Reportar perdas totais e saídas impossíveis; não descartar estes casos.

Não medir apenas “atingiu +50% em algum momento”. Definir previamente preço/instante de entrada (primeira oportunidade executável após o alerta, incluindo atraso) e regras de saída para paper trading. Sem regras de saída, reportar excursões e horizontes, sem chamar ao resultado “lucro da estratégia”. Uma análise de stop/target precisa de resolução suficiente para saber qual ocorreu primeiro.

## Mudanças de política

Variar poucos parâmetros de cada vez, comparar com a política inicial da Robinhood Chain, testar sensibilidade dos resultados e publicar distribuição de resultados e incerteza por pipeline. Não escolher apenas o melhor ponto da grelha. Rever a correlação entre liquidez, volume e traders e o efeito de cada filtro através de ablações. Medir também a disponibilidade real das métricas EVM de coordenação/insiders e a proporção de tokens incompletos. Se um filtro só melhora dados sintéticos, não há evidência de utilidade no mercado.

Antes de ligar um canal real de alertas, completar pelo menos 14 dias de shadow mode com monitorização de falhas, expiração, duplicação, cobertura e revisão manual de candidatos/bloqueios. Definir previamente tolerâncias de erro e orçamento dos fornecedores. A passagem a dados reais e os critérios numéricos de aceitação ficam por aprovar com base nessa amostra; esta entrega não declara os parâmetros validados.
