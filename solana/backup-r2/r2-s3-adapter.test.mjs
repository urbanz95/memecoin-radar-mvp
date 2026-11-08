import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as S3 from '@aws-sdk/client-s3';
import { createR2S3Adapter, createR2AdapterFromCredentials } from './r2-s3-adapter.mjs';

const bucket = 'solana-radar-test-only';
const root = 'radar-backups/v1/';
const id = '11111111-1111-4111-8111-111111111111';
const archiveKey = root + id + '/snapshot.sqlite.gz';
const manifestKey = root + id + '/manifest.json';
const indexKey = root + 'latest.json';

class FakeS3 {
  constructor() {
    this.objects = new Map();
    this.requests = [];
    this.version = 0;
    this.overrideGet = null;
    this.truncated = false;
  }
  async send(command) {
    const o = command.input;
    this.requests.push({ type: command.constructor.name, key: o.Key ?? null });
    if (command instanceof S3.PutObjectCommand) {
      const exists = this.objects.get(o.Key);
      if ((o.IfNoneMatch === '*' && exists) ||
          (o.IfMatch && exists?.etag !== o.IfMatch)) {
        const e = Error('PreconditionFailed');
        e.name = 'PreconditionFailed'; e.$metadata = { httpStatusCode: 412 };
        throw e;
      }
      let data;
      if (Buffer.isBuffer(o.Body)) data = Buffer.from(o.Body);
      else {
        const chunks = [];
        for await (const chunk of o.Body) chunks.push(Buffer.from(chunk));
        data = Buffer.concat(chunks);
      }
      assert.equal(o.ContentLength, data.length);
      const etag = '"v' + (++this.version) + '"';
      this.objects.set(o.Key, { data, etag });
      return { ETag: etag };
    }
    if (command instanceof S3.GetObjectCommand) {
      if (this.overrideGet) return this.overrideGet(o);
      const item = this.objects.get(o.Key);
      if (!item) {
        const e = Error('NoSuchKey'); e.name = 'NoSuchKey';
        e.$metadata = { httpStatusCode: 404 }; throw e;
      }
      return {
        Body: Readable.from([item.data.subarray(0, 2), item.data.subarray(2)]),
        ETag: item.etag, ContentLength: item.data.length,
      };
    }
    if (command instanceof S3.ListObjectsV2Command) {
      return {
        IsTruncated: this.truncated,
        Contents: [...this.objects].filter(([key]) => key.startsWith(o.Prefix))
          .map(([Key, item]) => ({
            Key, LastModified: new Date('2026-11-01T00:00:00Z'),
            Size: item.data.length,
          })),
      };
    }
    if (command instanceof S3.DeleteObjectCommand) {
      this.objects.delete(o.Key); return {};
    }
    throw Error('UNSUPPORTED_COMMAND');
  }
}
function make() {
  const client = new FakeS3();
  return { client, store: createR2S3Adapter({
    client, commands: S3, bucket,
  }) };
}
async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'solana-r2-adapter-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('official S3 PutObject conditional create and IfMatch protect latest JSON', async () => {
  const { client, store } = make();
  const initial = await store.putText(indexKey, '{"v":1}', { ifNoneMatch: '*' });
  assert.match(initial.etag, /^"v/);
  await assert.rejects(store.putText(indexKey, '{"v":2}', {
    ifNoneMatch: '*',
  }), /R2_PRECONDITION_FAILED/);
  await assert.rejects(store.putText(indexKey, '{"v":2}', {
    ifMatch: '"stale"',
  }), /R2_PRECONDITION_FAILED/);
  const updated = await store.putText(indexKey, '{"v":2}', {
    ifMatch: initial.etag,
  });
  assert.notEqual(initial.etag, updated.etag);
  assert.equal((await store.getText(indexKey)).body, '{"v":2}');
  assert.equal(client.objects.size, 1);
});

test('private large-file API reads upload source as stream with exact ContentLength', async t => {
  const dir = await workspace(t);
  const source = join(dir, 'original.gz');
  const bytes = Buffer.alloc(256 * 1024, 0x6b);
  await writeFile(source, bytes);
  const { client, store } = make();
  await store.putFile(archiveKey, source, { ifNoneMatch: '*' });
  assert.deepEqual(client.objects.get(archiveKey).data, bytes);
  const destination = join(dir, 'restored.gz');
  await store.getFile(archiveKey, destination, { maxBytes: bytes.length + 1 });
  assert.deepEqual(await readFile(destination), bytes);
});

test('getText returns null for missing S3 key, and enforces size limit', async () => {
  const { client, store } = make();
  assert.equal(await store.getText(manifestKey), null);
  await store.putText(manifestKey, '{"valid":true}', { ifNoneMatch: '*' });
  await assert.rejects(store.getText(manifestKey, { maxBytes: 3 }),
    /R2_TEXT_LIMIT_EXCEEDED/);
  assert.equal((await store.getText(manifestKey)).body, '{"valid":true}');
  assert.ok(client.requests.some(x => x.type === 'GetObjectCommand'));
});

test('download is stopped when streaming bytes exceed specified budget', async t => {
  const dir = await workspace(t);
  const { client, store } = make();
  client.overrideGet = async () => ({
    Body: Readable.from([Buffer.alloc(5), Buffer.alloc(20)]),
    ETag: '"body"', // intentionally no ContentLength
  });
  const destination = join(dir, 'oversized.gz');
  await assert.rejects(store.getFile(archiveKey, destination, { maxBytes: 10 }),
    /R2_DOWNLOAD_LIMIT_EXCEEDED/);
  await assert.rejects(readFile(destination), { code: 'ENOENT' });
});

test('S3-advertised oversized ContentLength is rejected before touching disk', async t => {
  const dir = await workspace(t);
  const { client, store } = make();
  client.overrideGet = async () => ({
    Body: Readable.from([Buffer.alloc(5)]), ContentLength: 100,
    ETag: '"body"',
  });
  const destination = join(dir, 'refused.gz');
  await assert.rejects(store.getFile(archiveKey, destination, { maxBytes: 10 }),
    /R2_DOWNLOAD_LIMIT_EXCEEDED/);
  await assert.rejects(readFile(destination), { code: 'ENOENT' });
});

test('truncated stream is rejected and partial local file removed', async t => {
  const dir = await workspace(t);
  const { client, store } = make();
  client.overrideGet = async () => ({
    Body: Readable.from([Buffer.alloc(2)]), ContentLength: 20,
    ETag: '"body"',
  });
  const destination = join(dir, 'truncated.gz');
  await assert.rejects(store.getFile(archiveKey, destination),
    /R2_DOWNLOAD_TRUNCATED/);
  await assert.rejects(readFile(destination), { code: 'ENOENT' });
});

test('existing download destination is preserved byte-for-byte', async t => {
  const dir = await workspace(t);
  const { store } = make();
  await store.putText(manifestKey, '{"v":1}', { ifNoneMatch: '*' });
  const destination = join(dir, 'do-not-overwrite.json');
  await writeFile(destination, 'existing-content');
  await assert.rejects(store.getFile(manifestKey, destination), { code: 'EEXIST' });
  assert.equal(await readFile(destination, 'utf8'), 'existing-content');
});

test('adapter rejects keys outside the backup namespace and unconditioned writes', async () => {
  const { client, store } = make();
  await assert.rejects(store.putText('some-other-service/keys', 'oops', {
    ifNoneMatch: '*',
  }), /R2_INVALID_BACKUP_KEY/);
  await assert.rejects(store.putText(indexKey, '{"v":1}'),
    /R2_CONDITIONAL_WRITE_REQUIRED/);
  await assert.rejects(store.putText(indexKey, '{"v":1}', {
    ifMatch: '"a"', ifNoneMatch: '*',
  }), /R2_INVALID_CONDITION/);
  assert.equal(client.requests.length, 0);
});

test('listObjects advertises truncation so cleanup fails closed', async () => {
  const { client, store } = make();
  await store.putText(manifestKey, '{}', { ifNoneMatch: '*' });
  client.truncated = true;
  const listing = await store.listObjects({ prefix: root, maxKeys: 1000 });
  assert.equal(listing.truncated, true);
  assert.equal(listing.objects[0].key, manifestKey);
  assert.equal(listing.objects[0].lastModified, '2026-11-01T00:00:00.000Z');
  await assert.rejects(store.listObjects({ prefix: 'another/' }), /R2_LIST_INVALID/);
});

test('deletion never allows latest index or keys outside backup prefix', async () => {
  const { client, store } = make();
  await store.putText(manifestKey, '{}', { ifNoneMatch: '*' });
  await assert.rejects(store.deleteObject(indexKey), /R2_PROTECTED_INDEX/);
  await assert.rejects(store.deleteObject('other/index.json'),
    /R2_INVALID_BACKUP_KEY/);
  await store.deleteObject(manifestKey);
  assert.equal(client.objects.size, 0);
});

test('configuration refuses missing credentials before SDK client construction', async () => {
  await assert.rejects(createR2AdapterFromCredentials({
    accountId: 'not-hex', accessKeyId: 'example', secretAccessKey: 'not-secret',
    bucket,
  }), /R2_CREDENTIALS_MISSING_OR_INVALID/);
});

test('official S3 client builds without making any network requests', async () => {
  const accountId = 'a'.repeat(32);
  const { adapter, client } = await createR2AdapterFromCredentials({
    accountId, accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-value',
    bucket,
  });
  assert.equal(typeof adapter.putFile, 'function');
  assert.equal(typeof adapter.getFile, 'function');
  assert.equal(typeof client.send, 'function');
  client.destroy();
});
