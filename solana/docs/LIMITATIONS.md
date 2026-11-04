# Limitações comprovadas e próximas etapas

## Cobertura

Não é um índice global da Solana nem um scanner com cobertura integral dos quatro protocolos. Só reconhece os Program IDs fixados, as variantes suportadas pelas IDLs e a evidência recebida. Nenhum nome/símbolo de token identifica um programa ou identidade de token. Endereços base58 são case-sensitive.

A [matriz de protocolos](PROTOCOL-COVERAGE.md) distingue operações observadas em Mainnet, operações só testadas com dados determinísticos e operações ausentes. A primeira captura real de criação Pump não é o mesmo token cuja graduação/migração foi capturada: não se afirma possuir todo o histórico vitalício desse mint.

Program accounts executáveis e IDLs oficiais não provam equivalência entre código-fonte e binário implantado. Nos eventos reais de trading Pump/PumpSwap já existe divergência de oito bytes face à IDL oficial consultada: prefixos conhecidos descodificados, sufixo desconhecido, `INCOMPLETE`. Upgrades posteriores podem quebrar layouts. Instruções desconhecidas nunca viram swaps por heurísticas de palavras.

Eventos emitidos por uma CPI revertida são descartados mesmo quando a transação exterior tem sucesso. Logs truncados/incompletos não permitem provar todos os eventos; eventos emitidos apenas via inner instruction podem exigir a transação completa. Uma transferência SPL não é uma compra/venda.

## Capacidade gratuita e latência

O primeiro ensaio Mainnet de 60s recebeu 5.494 notificações em cerca de 15s, encontrou 12 respostas 429 e p95 de 53.671 ms de receção até persistência de eventos de transações suportadas. A fase inicial teve p95 de 800 ms numa amostra de apenas cinco transações; essa amostra não demonstrou desempenho sustentado. Nenhum destes números é simulado.

O gargalo é o enriquecimento HTTP por assinatura, juntamente com o limite efetivo partilhado do RPC público. Um orçamento de 60 pedidos/min não cobre centenas de notificações/s, nem todas as chamadas são transações: reconciliação, histórico e segurança partilham o mesmo limite. Backpressure conserva o trabalho capturado e pausa/subseleciona contexto; não converte eventos não enriquecidos em ausência de atividade. Os relatórios completos medem o ensaio e identificam a versão/configuração efetivamente executada.

O caminho de observações por logs disponibiliza apenas os campos demonstrados pelo evento binário e fica separado dos eventos enriquecidos. Pode operar com HTTP escasso; **não substitui** mints/contas/ALT/instruções ausentes. A sua latência é medida separadamente. PumpSwap TradeEvent, por exemplo, identifica pool/utilizador/montantes mas não carrega os mints: permanecem desconhecidos até haver contexto.

Alternativas concretas: limitar programas/pools de interesse; manter cache de pools e metadados com evidência datada; filtrar/enriquecer apenas eventos novos que precisem de contas; usar feeds gratuitos explicitamente autorizados se disponíveis; obter capacidade HTTP histórica e sustentada suficiente para o volume observado. Para cobertura completa sob um fluxo de ~366 notificações/s, o limite superior ingénuo é ~22.000 enriquecimentos/min, antes de deduplicação/falhas e leituras auxiliares. O número necessário deve ser medido com a taxa real de transações únicas relevantes e o cache, não vendido como requisito fixo. Nenhuma assinatura paga/upgrade foi efetuado.

## Recuperação e finalização

Histórico depende de `getSignaturesForAddress`, retenção do fornecedor, paginação, disponibilidade de transações e capacidade de processamento. `before` e head original permitem continuar entre ticks; se a âncora já não existir no histórico, o scanner regista a fronteira disponível e a lacuna. Uma resposta vazia não prova ausência de eventos. Uma pausa pode crescer mais depressa do que o backfill consegue recuperar.

Primeiro arranque começa numa janela recente limitada, com `INITIAL_HISTORY_BOUNDARY`; não promete recuperar todos os lançamentos anteriores. Checkpoint avança só após persistência do lote selecionado. Instrução desconhecida mantém transação/evidência e diagnóstico, mas não inventa eventos. Histórico disponível pode continuar à espera enquanto o backlog partilha o orçamento.

Observações `processed` são reversíveis. Eventos enriquecidos esperam `confirmed` ou `finalized`; reconciliação usa `getSignatureStatuses` com histórico. Status ausente, inválido ou slot divergente torna a evidência `UNRESOLVED`; não é prova automática de reversão. Falha comprovada marca `REVERTED`, excluída de mercado. Observações por logs sem enriquecimento continuam explicitamente sem reconciliação: um commitment recebido não garante uma verificação posterior independente. Não existe prova negativa de reversão de toda a rede.

## Segurança e finanças

Segurança inicial analisa autoridades e extensões de mint SPL/Token-2022. Ausência de autoridades não é um atestado de segurança. Alguns riscos são rejeições de uma política conservadora, não acusações de fraude. Extensões desconhecidas/malformadas, fornecimento/holders incompletos e falta de prova LP impedem PASS global. Uma lista de maiores token accounts não é censo de holders nem prova de distribuição completa.

Não estão implementados: monitorização contínua de mudanças de autoridade, lockers/tempo de desbloqueio, histórico completo de holders, concentração global, prova de liquidez irremovível, insiders/bundles/wash trading, PnL, backtest, scoring especulativo, IA ou trading. A interface prepara o consumo futuro de evidência, mas não concede controlo de filtros/scoring/permissões.

Preços são razões exatas das quantidades reportadas, com semântica de fees própria do protocolo. Não são garantias de execução. Reservas de evento podem ser pré ou pós-trade; não se confundem com liquidez imediatamente disponível. Progresso percentual até graduação, impacto estimado e liquidez disponível permanecem null quando falta denominador/estado suficiente. USD permanece null; não existe fonte SOL/USD nesta entrega. Market cap não substitui liquidez.

## Operação e armazenamento

Só o diretório `solana/` é novo. Não se instalaram serviços, não se alteraram production configs/D1/deployments, não houve merge nem operações financeiras. O processo precisa de host ligado e disco durável; esta sessão não constitui hosting permanente.

SQLite tem WAL, synchronous FULL, transações e índices. Uma queda antes de COMMIT reverte o lote; observações ainda em RAM dependem de recuperação. Retenção é limitada e documentada; ficheiros reais/catálogos não são guardados indefinidamente. A API é local de leitura, sem autenticação de rede pública. Não há promessa de execução em Windows (launcher usa `flock`) nem de disco persistente numa função serverless.

Os testes determinísticos provam propriedades de implementação; fixtures reais provam decodificação das transações capturadas. O ensaio live prova apenas a janela, fonte, máquina, configuração e carga observadas. Contenção com testes/instalação de dependências nesta máquina partilhada é uma limitação adicional das medições; não é benchmark isolado de hardware de produção.
