# Observações de eventos em logs RPC

`src/log-observations.mjs` descodifica eventos binários demonstrados por uma notificação RPC `logsSubscribe`, sem exigir `getTransaction` para cada signature. Este caminho reduz o custo de deteção; não fornece as contas, os balanços ou as instruções que o RPC não incluiu na notificação.

`decodeLogObservation(notification)` recebe `signature`, `slot`, `logs`, `err`, `receivedAt` e `confirmationStatus`, com `programId` opcional para identificar a subscrição. Retorna `{observations, diagnostics}` e contém falhas de parsing. O cliente de rede continua responsável por verificar Solana Mainnet e a origem RPC; o módulo não realiza pedidos de rede nem verifica assinaturas criptograficamente.

As observações pertencem a um fluxo separado dos eventos enriquecidos por transação. Não somar ambos os fluxos: uma mesma operação pode existir nos dois. A persistência e a API devem manter essa distinção; estas observações não devem alimentar implicitamente o mercado dos eventos enriquecidos.

## Evidência e campos desconhecidos

O decoder reutiliza os IDLs fixados e o parser de ownership das invocações. Só considera payloads `Program data` de programas reconhecidos, após sucesso da invocação e de todos os seus ancestrais. Palavras como `buy` ou `sell`, nomes de tokens, meras menções ao endereço de um programa e transferências SPL não provam um trade. Uma falha on-chain indicada na notificação não produz observações de eventos. Traces malformados são rejeitados; frames truncados ou sem conclusão não fornecem eventos demonstrados.

O contexto temporário passado internamente ao decoder tem listas de contas e instruções vazias, balanços vazios e `blockTime: null`. Não é uma transação reconstruída, não é persistido e não é apresentado como evidência de uma chamada `getTransaction`.

Cada observação contém os campos normalizados, com:

- `dataMode: REAL_RPC_LOG_OBSERVATION` e `evidenceSource.kind: rpc:logsSubscribe`;
- `instructionIndex: null` e `innerInstructionIndex: null`, porque a notificação não os prova;
- `contextCompleteness: INCOMPLETE` e `completeness: INCOMPLETE`;
- `evidenceStatus: VERIFIED_RPC_LOG_EVENT`, que identifica o payload e a ownership RPC demonstrados, sem afirmar contexto completo;
- `reconciliationStatus: UNRECONCILED` inicialmente, até o serviço efetuar a reconciliação;
- `confirmationStatus` preservado exatamente: `processed`, `confirmed` ou `finalized`;
- valores financeiros brutos como strings de inteiros exatos; dados desconhecidos ficam `null`.

Um evento `confirmed` não se torna `processed` por ter campos desconhecidos. A confirmação e a completude são dimensões distintas. Uma observação `processed` continua sujeita a reversão.

`eventTimestamp` só é preenchido quando o próprio evento protocolar contém um timestamp interpretado pelo decoder. Não se usa o relógio de receção como timestamp on-chain. `receivedAt` mede receção; `processedAt` mede descodificação.

## Cobertura demonstrada por fixtures reais

| Protocolo/operação | O que o log demonstra | Contexto que permanece desconhecido |
|---|---|---|
| Pump.fun criação | Mint, criador, wallet do evento, bonding curve, timestamp e dados de criação | Índices das instruções; quote nativo quando o campo protocolar é a chave zero |
| Pump.fun trade | Mint, wallet, sentido, montantes e timestamp do evento | Pool/curve derivada de contas; quote nativo quando só a instrução o demonstra; decimais ausentes |
| Pump.fun graduação/migração | Mint, curve/pool e timestamp dos eventos existentes | Histórico anterior não observado; quote nativo quando depende da instrução |
| PumpSwap criação de pool | Mints, pool, criador da pool separado do criador do token, montantes e timestamp | Índices e restante contexto transacional |
| PumpSwap trade | Pool, wallet, sentido, montantes e timestamp | Mints que só constam das contas da instrução, salvo contexto obtido separadamente |
| LaunchLab trade | Pool, sentido e montantes do evento | Mints, wallet, timestamp de bloco e índices |
| CPMM swap | Mints, pool, sentido e montantes do evento | Wallet, timestamp de bloco e índices |
| CPMM criação de pool | Sem evento suportado neste caminho | A criação é demonstrada pela instrução da transação completa |

A criação LaunchLab exige associação de contas no decoder atual e pode não aparecer neste caminho. Eventos emitidos apenas em dados de `emit_cpi`, sem cópia `Program data` disponível, também exigem a transação completa. Logs truncados, versões desconhecidas e divergência entre IDL e programa reduzem cobertura explicitamente. O erro `NO_SUPPORTED_LOG_EVENT` não significa ausência de atividade no protocolo.

## Identidade e medições

`sourceMessageSha256` é SHA-256 da serialização do array de logs, sem endpoint, chave ou credencial. O ID da observação combina a versão desta identidade, signature, programa efetivamente descodificado, hash dos logs, ordinal e tipo de evento. Notificações idênticas repetidas por subscrições distintas ou upgrades de commitment conservam o ID. Este ID é próprio das observações e não substitui a identidade dos eventos enriquecidos.

O hash comprova integridade do conteúdo guardado; não é uma prova independente da honestidade do fornecedor RPC. Uma mudança de logs no mesmo signature produz outra identidade e requer investigação/reconciliação.

Medir latência de observação separadamente da latência de enriquecimento completo. Os testes de replay das fixtures verificam comportamento determinístico e não representam latência de produção.
