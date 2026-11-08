# Transporte R2: prova offline de backup e restauro — 2026-11-08

**Estado:** código de transporte e testes exclusivamente em
`test/solana-sqlite-restore-offline-20261108`.
**NÃO integrado no scanner**; nenhuma conta/bucket/credencial R2, cron,
Worker, deploy, custo de API ou alteração à produção. Ler sempre issue #17.

## Implementado e testado com adapter em memória

- `src/backup-offline.mjs`: backup consistente de SQLite WAL através da
  ligação `DatabaseSync` aberta, gzip, `PRAGMA integrity_check`,
  `PRAGMA foreign_key_check`, contagem de todas as tabelas,
  SHA-256 e `manifest.json`. Restauro numa DB nova; nunca substitui
  uma base já existente.
- `src/backup-object-store.mjs`: protocolo de transporte injetável.
  Cada cópia possui um UUID e duas chaves imutáveis:
  `radar-backups/v1/<uuid>/snapshot.sqlite.gz` e `manifest.json`.
  Após upload, **descarrega a cópia inteira e restaura em scratch**;
  só publica o manifesto depois de validar SHA-256, tamanhos e SQLite.
  Só atualiza `radar-backups/v1/latest.json` após confirmar ambas
  as cópias. O apontador usa `If-None-Match: *` na criação e
  `If-Match: <etag>` nas atualizações (CAS). O índice mantém
  até três entradas para fallback.
- `test/backup-object-store.test.mjs`: 10 cenários com memória:
  roundtrip, upload corrompido, falha na publicação do manifesto,
  recuperação da cópia anterior, conflito CAS, proteção do destino
  existente, índice com chave adulterada, todas as cópias corrompidas,
  índice inexistente e limite de bytes.
- `test/backup-offline.test.mjs`: cinco cenários de SQLite, incluindo
  o esquema real do Store e checkpoints. CI Node 22/24 é
  obrigatória para ambos os grupos.

## Contrato do futuro adapter R2/S3

O código não importa SDK nem conhece credenciais. O futuro adapter deve
implementar:

```js
await store.putFile(key, sourcePath, {ifNoneMatch: '*'});
await store.getFile(key, destinationPath, {maxBytes});
await store.putText(key, utf8, {ifNoneMatch: '*' });
// ou, ao atualizar o índice:
await store.putText(indexKey, utf8, {ifMatch: oldEtag});
const item = await store.getText(key, {maxBytes});
// item === null se inexistente, senão {body: string, etag: string}
```

Requisitos do adapter real:
- Endpoint R2 S3 privado `https://<account>.r2.cloudflarestorage.com`,
  região `auto`; usar AWS SDK mantido e HTTPS, não criar assinatura
  SigV4 manual nem expor credenciais na issue/GitHub.
- `getFile` deve **limitar bytes durante o streaming**, abortar quando
  exceder `maxBytes` e escrever um ficheiro temporário criado com
  `wx`. `getText` deve aplicar o limite antes de carregar em memória.
- A versão ETag do objeto `latest.json` deve ser devolvida no
  `getText` e usada exclusivamente em `If-Match`. Em caso de HTTP
  412, falhar sem apagar outras versões nem sobrescrever índice.
- Metadados de ETag **não** são utilizados como checksum. SHA-256
  calcula-se e valida-se nos bytes do arquivo. `PutObject` com
  condições é suportado por R2, mas multipart tem requisitos próprios;
  testar contratos para ambos os tamanhos antes de ativar.
- Adaptar retries com limites, timeouts, cancelamento e métricas internas;
  jamais bloquear a receção WS por falha de um backup.
- Descarregamento e restauro repetido devem rejeitar ficheiros existentes,
  links simbólicos de destino e base com schema inesperado.

## Bloqueios para ligar R2 real

1. **Capacidade temporária:** a prova remota mantém ao mesmo tempo uma
   cópia gzip local, outra gzip descarregada e uma DB restaurada, além
   da base original do scanner. Fazer ensaios de 64/128/256 MiB em
   CI isolada e medir disco/CPU/latência e tempo de upload; não assumir
   que cabe no disco efémero ou que é compatível com o Render Free.
2. **Retenção física:** o índice guarda três versões, mas as chaves
   antigas e uploads órfãos **continuam a ocupar R2**. Não ativar
   backups recorrentes sem implementação de limpeza segura após
   publicação bem-sucedida, com salvaguarda do último backup válido
   e contabilização de espaço/conta. Não interpretar «3 versões no
   índice» como retenção física ou limite de cobrança.
3. **Orçamento:** franquia gratuita R2 Standard de 10 GB-mês,
   1 milhão de operações Classe A e 10 milhões Classe B mensais,
   sujeita a cobrança acima da franquia. Confirmar conta,
   alertas de faturação e limites antes de ativar. Não usar R2
   Infrequent Access para esta POC.
4. **Segurança e disponibilidade:** bucket privado, credenciais com
   menor privilégio, definição apenas no ambiente Render (nunca Git),
   teste de cliente e identificação de erro `RESTORE_UNAVAILABLE`.
   Nenhum endpoint público para snapshots/SQLite.
5. **Migração:** testar restauro num processo isolado **antes** de abrir
   Store, WS e RPC. A base local atual nunca deve ser sobreposta.
   RPO medido pela hora da última cópia bem-sucedida; não afirmar
   recuperação do período entre snapshots nem dados históricos já
   perdidos no último deploy.
6. **Fonte Cloudflare:** PR #33 continua separado, sem deploy/merge até
   inspeção do Worker editado manualmente; não confundir D1 com backup.

## Decisão

GO para testes offline de transporte e restauro. NO-GO para publicar
a branch, configurar armazenamento real ou reiniciar Render antes de
resolver limites de recursos, retenção/custos e prova de restauro isolada.

Referências:
- https://developers.cloudflare.com/r2/api/s3/api/
- https://developers.cloudflare.com/r2/reference/consistency/
- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/r2/objects/upload-objects/
