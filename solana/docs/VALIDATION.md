# Validação técnica e de rede

A implementação tem três classes de prova separadas: testes determinísticos, replay de respostas Mainnet arquivadas e ensaios live. Um teste com fixture real verifica o decoder sobre a transação capturada; não mede latência de produção nem prova cobertura contínua do protocolo.

## Estado da validação

| Verificação | Estado e evidência |
|---|---|
| Suite determinística final | **160/160** passaram em Node 24.19.0; TAP e resumo em `reports/` |
| Compatibilidade Node 22.13 | **160/160** passaram em Node 22.13.0, sem testes live no comando CI |
| Registos reais de protocolos | 14 fixtures de transações Mainnet, incluindo um caso negativo de mera menção ao programa, com signatures, slots e SHA-256 em [MANIFEST.json](../fixtures/MANIFEST.json) |
| Program IDs e rede | [Probe Mainnet](../reports/mainnet-program-probe.json): genesis hash Mainnet e quatro contas de programa executáveis, sem erro no probe |
| Ensaio live inicial | 60,438 s concluídos; evidenciou sobrecarga e falha do objetivo p95 de 2 s |
| Primeira tentativa longa com enriquecimento HTTP | Interrompida pelo ambiente após 952,081 s observados; **não completou 60 minutos contínuos** |
| Tentativa com observações por logs | Interrompida pelo ambiente após 304,226 s observados; **não completou a duração pedida** |
| Nova janela contínua de 3600 s | **IN_PROGRESS** — preparação/reexecução; só será aprovada com relatório final `DURATION_COMPLETED`, duração efetiva ≥3600 s e revisão das lacunas |

Os ensaios interrompidos conservam as últimas amostras duráveis, não um relatório final de encerramento normal. A duração refere-se ao último checkpoint de métricas disponível; o instante exato da interrupção pode ser posterior. Não se somam janelas separadas para afirmar uma hora contínua. O código evoluiu entre os ensaios; os resultados antigos não são um benchmark da versão final. O manifesto [mainnet-60m-baseline.json](../reports/mainnet-60m-baseline.json) identifica a configuração e os hashes de fonte da primeira tentativa longa, não constitui prova de conclusão dessa tentativa.

## Executar os testes

```sh
cd solana
npm ci --ignore-scripts
npm test
```

A suite usa `node:test`, SQLite real local e transportes simulados ou WebSocket local. Não exige RPC de rede, credenciais pagas, private keys ou contas financiadas. Testes sintéticos encontram-se identificados; os snapshots financeiros construídos para testes não são apresentados como oportunidades de mercado.

| Cenário exigido | Prova disponível |
|---|---|
| Criação Pump.fun | Fixture Mainnet `create_v2`, mint/creator e compra inicial |
| Compra e venda | Pump v2/v3 e PumpSwap com transações reais, inclusive rotas internas |
| Graduação e migração para PumpSwap | Dois RPC reais do mesmo mint em slots 465057017 e 465057019; criação da pool de destino comprovada |
| Nova pool Raydium | `initialize` CPMM real; criação LaunchLab real |
| Duplicados | Inbox, eventos, observações por logs e referências brutas idempotentes |
| Desconexão e reconstrução de subscrições | WebSocket local determinístico; reconexões também observadas no ensaio live |
| Recuperação de eventos perdidos | Histórico simulado paginado com SQLite real, âncora, continuação entre ticks e deduplicação |
| 429 | Mock com cooldown global/Retry-After e ocorrências reais nos relatórios live |
| Histórico insuficiente | Mock de retenção/paginação limitada e lacuna explícita |
| Transação não finalizada | `processed`/`confirmed` separados, reconciliação, status ausente/fraco e mudanças de slot |
| Instrução desconhecida | Diagnóstico explícito; transferências/menções não viram swaps |
| Token-2022 com risco | Fixtures determinísticas de TLV e restrições; snapshot Mainnet de mint documentado em [SECURITY.md](SECURITY.md) |
| Interrupção de persistência | Processo SQLite real interrompido com SIGKILL antes de COMMIT, rollback e reabertura |
| Reinício de checkpoint | Reabertura do inbox, recuperação e atomicidade checkpoint/continuação |
| Backpressure | Fila limitada; modo de pausa e modo de logs contínuos com admissão HTTP limitada |
| Finanças incompletas | Valores desconhecidos mantidos como null; ausência de dados não vira zero ou PASS |
| Símbolos duplicados | Identidade por mint case-sensitive, sem agrupamento por símbolo |
| Precisão numérica | Inteiros acima de 2^53, u64/i128 e preços/volumes racionais exatos |

A recuperação com mocks prova as propriedades de cursor/persistência; não afirma que o RPC público conservou todas as transações de uma desconexão real. Uma transação adiada por indisponibilidade tem lacuna e retry durável próprios; um checkpoint parcial não declara essa transação recuperada.

## Evidência Mainnet arquivada

As [fixtures](../fixtures/README.md) documentam as signatures e como repetir `getTransaction`, sujeito à retenção do fornecedor. Foram pedidas transações JSON, commitment `finalized` e `maxSupportedTransactionVersion: 1`. As transações versão 1 são uma observação real; pedir apenas versão 0 produziu rejeição RPC na investigação.

O ciclo comprovado de graduação/migração é do mint `BxGdDCJDHr35RwpxFomSnSGXMYyk32c1YNVAdiwjpump`: graduação na signature `3K91vqn7iW2AgVyUccdd18TLQJzwyxQ6kfRYRtYtp4RpFb37m4hxEjgSJkFDDBxEr9c4Ta6FNM829uAEiPTqRf8V`, seguida de migração/criação PumpSwap na signature `4prYVbxEX3SeE93kjHCMRdBxBWcQsR5VcsAEua8kRoV8yrNNwWM8bmfuFpKPoF8UoqjN5agD8FERKDQsaConT2Xq`. Não se capturou a criação inicial deste mesmo mint e não se afirma possuir o seu histórico vitalício completo.

Os Program IDs foram confrontados com fontes oficiais/IDLs e contas executáveis Mainnet. Isso não prova equivalência entre um commit de código-fonte e o binário implantado. Os eventos reais de trading Pump/PumpSwap têm oito bytes adicionais face à IDL oficial fixada; o prefixo demonstrado é descodificado, o sufixo fica desconhecido e a completude permanece `INCOMPLETE`.

## Ensaios live e aprovação operacional

Os relatórios em [PERFORMANCE.md](PERFORMANCE.md) e [RPC-CONSUMPTION.md](RPC-CONSUMPTION.md) usam exclusivamente contadores e timestamps dos ensaios reais. O objetivo p95 <2 s falhou no caminho de enriquecimento integral por assinatura. As observações binárias por logs reduziram a latência medida de deteção, mas não fornecem o contexto que faltava na notificação; ficam separadas de `/events` e não entram implicitamente no mercado.

Uma janela contínua só confirma a estabilidade do processo e das métricas durante a duração observada. Reconexões, lacunas, retenção e limites HTTP continuam visíveis e impedem qualquer afirmação de cobertura total. O ensaio final deve conservar configuração, hashes/commit, relatório completo, exemplos verificáveis e consumo RPC. Não há aprovação de trading ou de segurança de tokens associada ao ensaio.

Não foram enviados trades, mensagens Telegram, ordens, pedidos a LLMs ou transações assinadas. Não houve contratação de serviços pagos, deploy ou alteração das bases/configurações de produção Robinhood.
