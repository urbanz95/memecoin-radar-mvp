# Solana radar: backup durável e restauro verificável — plano sem deploy

Estado: **DESENHO/REVISÃO, NÃO IMPLEMENTADO, NÃO TESTADO EM PRODUÇÃO**.
Escopo único: `urbanz95/memecoin-radar-mvp` / branch cloud
`feat/solana-cloud-hosting-20261106`. Não modificar `main`, newsletter ou EVM.
Fonte de coordenação obrigatória: issue #17.

## Problema e objetivo

- Render Free usa filesystem efémero; no deploy de 08/11/2026 uma SQLite
  ~225 MB foi substituída por uma base nova ~34 MB. Cloudflare D1 guarda
  apenas uma amostra até 50 tokens por cron de cinco minutos.
- Preservar **todas as tabelas da SQLite** (incluindo evidências, checkpoints,
  observações, erros, gaps) e permitir recuperar um snapshot consistente.
- Medir RPO real: `snapshot.created_at` até à hora do incidente; nunca
  declarar RPO=0, recuperação integral da blockchain ou 24/7.
- Zero transações, zero alteração a RPC/WS ou cap 12 HTTP RPC/min.

## Formato do snapshot

1. Usar `backup(sourceDatabaseSync, tempPath)` de `node:sqlite` (Node 24)
   sobre a conexão já aberta em `Store`. **Não** fazer `cp scanner.sqlite`
   a quente sem `-wal`; WAL pode conter transações ainda não checkpointed.
2. Abrir o snapshot temporário como SQLite em modo read-only e executar
   `PRAGMA integrity_check`: o único resultado aceitável é `ok`.
3. Validar esquema esperado, `PRAGMA user_version`, tabelas essenciais e
   consistência referencial `PRAGMA foreign_key_check`; registar contagens
   e checkpoint por programa. NÃO guardar chaves privadas.
4. Produzir hash SHA-256 do ficheiro de bytes **tal como guardado**.
   Compressão opcional (gzip/zstd) **antes** de calcular o hash sobre o
   objeto final, nunca alterar depois de assinar. Metadados imutáveis.

Manifest mínimo (JSON estrito; exemplo ilustrativo):

```json
{
  "format": "solana-radar-sqlite-backup-v1",
  "createdAt": "2026-11-08T21:00:00.000Z",
  "objectKey": "snapshots/2026/11/08/2100-<nonce>.db.zst",
  "sha256": "<64 hex characters>",
  "sizeBytes": 0,
  "sqliteIntegrity": "ok",
  "schemaVersion": 1,
  "tables": {"event_observations": 0, "transactions": 0},
  "lastObservedAt": null,
  "sourceCommit": "<40 hex characters>"
}
```

Os campos ilustrativos zero/null NÃO são valores reais. O manifest não deve
incluir segredos nem dados pessoais/endereços de carteiras desnecessários.
O próprio backup contém dados on-chain sensíveis em termos operacionais:
usar bucket privado e credenciais apenas do serviço.

## Destino e protocolo de publicação

- Bucket privado Cloudflare R2 **Standard** exclusivo para snapshots; objetos
  sem acesso público. R2 é independente da D1 e do Worker de keepalive.
- No Render, configurar apenas em ambiente após testes:
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_BUCKET` e toggle `BACKUP_ENABLED=false` por omissão.
  NUNCA publicar estes valores em GitHub, logs, issue ou dashboard público.
- Utilizar SDK S3 compatível com R2 e tempo de espera/retry limitado.
  Upload primeiro para uma chave imutável `snapshots/...`; validar HEAD
  com tamanho esperado; em teste de integração baixar e validar o SHA-256.
- Só após upload completo e validação, publicar manifest para a chave de
  snapshot; atualizar marcador de `latest` **em último lugar**.
- Snapshot falhado não deve substituir o anterior; relatório interno
  `backup_last_success_at` / `backup_last_failure_code`, sem alterar
  `websocket_connected` nem dados de cobertura.
- Após recuperação, testar leitura real do objeto. HEAD isolado não prova
  integridade dos bytes; R2 ETag não deve ser usado como SHA-256 genérico.

## Retenção, custos e limites operacionais

- Plano inicial a avaliar, não ativado: 1 snapshot completo / 6 horas,
  retenção de 7 dias, máximo ~28 cópias.
- Se cada snapshot atingir 256 MiB: ~7 GiB sem compressão/metadata;
  porém confirmação da capacidade e tamanho real vem da configuração e
  métricas em produção, não de uma hipótese.
- Free tier Cloudflare R2 Standard (documentação 30/10/2026):
  10 GB-mês de armazenamento, 1 milhão de operações Classe A/mês e
  10 milhões Classe B/mês. **Não é hard spending cap**: ultrapassar a
  franquia pode gerar cobrança. Não criar bucket ou credenciais antes
  de rever faturação e limite monetário.
- Definir um limite conservador de utilização contratada: parar novos
  snapshots ou reduzir retenção antes de ultrapassar um teto definido,
  **nunca** eliminar a última cópia íntegra sem substituto.
- Se snapshot completo frequente causar carga significativa/latência, medir
  CPU, I/O, armazenamento temporário, duração e tamanho e só então decidir
  entre menos cópias, incremental verificável ou outro alojamento.
- Não acrescentar cron externo nem automações de chat. Timer interno só
  pode ser ativado na fase de integração testada.

## Restauro no arranque

1. Executar **antes** de `new Store(dbPath)` e de abrir WS/RPC, sem fazer
   mutações em produção durante a fase de testes.
2. Se SQLite local já existe e passa integrity_check, NUNCA sobrescrever
   automaticamente: o disco atual pode ter eventos mais recentes.
3. Se base ausente: obter manifest `latest` e, se inválido, procurar
   **última versão íntegra conhecida**, com política de tempo e quotas.
4. Descarregar para ficheiro temporário, verificar tamanho + SHA-256,
   descomprimir (se aplicável), executar integrity_check, foreign_key_check,
   schema e contagens do manifest; garantir espaço temporário suficiente.
5. Só depois fazer rename atómico no mesmo filesystem para `dbPath`,
   sem WAL/SHM antigos; abrir Store. Publicar `restore_source_backup_at`,
   `restore_integrity_status` e `restore_gap_since_backup` no /health.
6. Se falhar todo o restauro: política explícita **fail-safe**; pode iniciar
   base nova somente com estado `HISTORY_INCOMPLETE/RESTORE_UNAVAILABLE`
   e gap durável, nunca marcar histórico recuperado.
7. Não executar replay ingênuo de assinaturas antigas, nem creditar eventos
   "recuperados" sem ID/slot e deduplicação confirmados.

## Testes obrigatórios antes de PR de produção

- Snapshot sobre WAL com escrita concorrente e integrity_check no destino.
- Snapshot de todas as tabelas; contagens e chaves de eventos/checkpoints
  idênticas depois de restaurar numa pasta **nova**.
- Restauro repetido idempotente, seguido de reinício de scanner com dedupe.
- Falhas de rede, permissão negada, upload truncado, manifest antigo,
  hash incorreto, base corrompida, schema incompatível, disco cheio.
- Simular queda entre upload e publicação do manifest (último válido
  preservado), e entre download e rename (base local preservada).
- Verificar que sem credenciais R2 o scanner continua a correr no perfil
  anterior, sem abrir endpoints de SQLite e sem enviar dados privados.
- CI Node 22/24 conforme compatibilidade exata do `sqlite.backup`;
  provas de integração com mock S3/R2 e ensaio restaurado **offline**.
- Nenhum deploy até existir uma demonstração de restauro, orçamento aprovado,
  acesso R2 configurado e confirmação do risco de perder a SQLite atual.

## Sequência recomendada

A. Concluir amostras WS/Shrine e medir perda antes de alterar a ingestão.
B. Implementar backup/restore em branch específica e testes offline.
C. Auditar segurança, integridade e custos; confirmar plano R2 privado.
D. Só depois preparar PR de integração dirigido à branch cloud. Deploy
   controlado apenas com autorização separada e evidência de restauro.
E. Não integrar PR #33 antes de comparar fonte do Worker manual publicado.

Fontes oficiais:
- https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsourceDb-path-options
- https://developers.cloudflare.com/r2/pricing/
- https://render.com/docs/free
