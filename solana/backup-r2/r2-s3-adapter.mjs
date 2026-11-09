// Isolated Cloudflare R2/S3 adapter. Not connected to the scanner or Render.
// All operations are private, bounded, and scoped to radar-backups/v1/*.
// The official AWS SDK v3 is installed only in this separate proof package.
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const KEY = /^radar-backups\/v1\/(?:latest\.json|[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/(?:snapshot\.sqlite\.gz|manifest\.json))$/i;
const BUCKET = /^(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function checkedKey(key) {
  if (typeof key !== 'string' || !KEY.test(key))
    throw Error('R2_INVALID_BACKUP_KEY');
  return key;
}
function checkedLimit(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw Error('R2_INVALID_BYTE_LIMIT');
  return value;
}
function condition(options = {}) {
  if (!options || typeof options !== 'object') throw Error('R2_INVALID_CONDITION');
  const { ifMatch, ifNoneMatch } = options;
  if (ifMatch !== undefined && ifNoneMatch !== undefined)
    throw Error('R2_INVALID_CONDITION');
  if (ifMatch !== undefined) {
    if (typeof ifMatch !== 'string' || !/^(?:W\/)?"[^"\r\n]{1,200}"$/.test(ifMatch))
      throw Error('R2_INVALID_CONDITION');
    return { IfMatch: ifMatch };
  }
  if (ifNoneMatch === '*') return { IfNoneMatch: '*' };
  // Fail closed; backup objects must never be uploaded unconditionally.
  throw Error('R2_CONDITIONAL_WRITE_REQUIRED');
}
function missing(error) {
  return ['NoSuchKey','NotFound'].includes(error?.name) ||
    error?.$metadata?.httpStatusCode === 404;
}
function normalError(error) {
  if (error?.$metadata?.httpStatusCode === 412 ||
      error?.name === 'PreconditionFailed')
    throw Error('R2_PRECONDITION_FAILED');
  throw error;
}
function validateClient(client, commands, bucket) {
  if (!client || typeof client.send !== 'function' ||
      !commands ||
      ['PutObjectCommand','GetObjectCommand','ListObjectsV2Command','DeleteObjectCommand']
        .some(name => typeof commands[name] !== 'function') ||
      typeof bucket !== 'string' || !BUCKET.test(bucket))
    throw Error('R2_ADAPTER_CONFIGURATION_INVALID');
}
function boundedBody(body, maxBytes) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function')
    throw Error('R2_INVALID_RESPONSE_STREAM');
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _, callback) {
      received += chunk.byteLength;
      if (received > maxBytes) callback(Error('R2_DOWNLOAD_LIMIT_EXCEEDED'));
      else callback(null, chunk);
    },
  });
  return { source: Readable.from(body), limiter, received: () => received };
}
async function textBody(body, maxBytes) {
  const parts = [];
  let total = 0;
  if (!body || typeof body[Symbol.asyncIterator] !== 'function')
    throw Error('R2_INVALID_RESPONSE_STREAM');
  for await (const chunk of body) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      body.destroy?.();
      throw Error('R2_TEXT_LIMIT_EXCEEDED');
    }
    parts.push(buf);
  }
  return Buffer.concat(parts).toString('utf8');
}

export function createR2S3Adapter({
  client, commands, bucket, maxObjectBytes = MAX_FILE_BYTES,
} = {}) {
  validateClient(client, commands, bucket);
  checkedLimit(maxObjectBytes, MAX_FILE_BYTES);
  const { PutObjectCommand, GetObjectCommand, ListObjectsV2Command,
    DeleteObjectCommand } = commands;

  return Object.freeze({
    async putText(key, text, options) {
      checkedKey(key);
      if (typeof text !== 'string') throw Error('R2_INVALID_TEXT');
      const bytes = Buffer.from(text, 'utf8');
      if (!bytes.length || bytes.length > MAX_TEXT_BYTES)
        throw Error('R2_TEXT_LIMIT_EXCEEDED');
      const headers = condition(options);
      try {
        const out = await client.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: bytes, ContentLength: bytes.length,
          ContentType: 'application/json; charset=utf-8',
          ...headers,
        }));
        return { etag: out.ETag ?? null };
      } catch (e) { normalError(e); }
    },
    async putFile(key, path, options) {
      checkedKey(key);
      if (typeof path !== 'string' || !path)
        throw Error('R2_INVALID_FILE_PATH');
      const st = await stat(path);
      if (!st.isFile() || st.size < 1 || st.size > maxObjectBytes)
        throw Error('R2_UPLOAD_LIMIT_EXCEEDED');
      const headers = condition(options);
      const body = createReadStream(path);
      try {
        const out = await client.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: body, ContentLength: st.size,
          ContentType: 'application/octet-stream',
          ...headers,
        }));
        return { etag: out.ETag ?? null };
      } catch (e) { normalError(e); }
      finally { body.destroy(); }
    },
    async getText(key, { maxBytes = MAX_TEXT_BYTES } = {}) {
      checkedKey(key);
      checkedLimit(maxBytes, MAX_TEXT_BYTES);
      try {
        const res = await client.send(new GetObjectCommand({
          Bucket: bucket, Key: key,
        }));
        if (Number.isFinite(res.ContentLength) && res.ContentLength > maxBytes) {
          res.Body?.destroy?.();
          throw Error('R2_TEXT_LIMIT_EXCEEDED');
        }
        const text = await textBody(res.Body, maxBytes);
        if (typeof res.ETag !== 'string' || !res.ETag)
          throw Error('R2_ETAG_MISSING');
        return { body: text, etag: res.ETag };
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    async getFile(key, path, { maxBytes = maxObjectBytes } = {}) {
      checkedKey(key);
      checkedLimit(maxBytes, maxObjectBytes);
      if (typeof path !== 'string' || !path)
        throw Error('R2_INVALID_FILE_PATH');
      let res;
      try {
        res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      } catch (e) {
        if (missing(e)) throw Error('R2_BACKUP_NOT_FOUND');
        throw e;
      }
      if (Number.isFinite(res.ContentLength) && res.ContentLength > maxBytes) {
        res.Body?.destroy?.();
        throw Error('R2_DOWNLOAD_LIMIT_EXCEEDED');
      }
      const { source, limiter, received } = boundedBody(res.Body, maxBytes);
      // Fail closed: destination already exists, including symlinks.
      try {
        await pipeline(source, limiter, createWriteStream(path, {
          flags: 'wx', mode: 0o600,
        }));
        if (Number.isFinite(res.ContentLength) &&
            received() !== res.ContentLength)
          throw Error('R2_DOWNLOAD_TRUNCATED');
        return { bytes: received() };
      } catch (e) {
        // Do not remove a pre-existing file if wx failed with EEXIST.
        if (e?.code !== 'EEXIST') await rm(path, { force: true });
        throw e;
      }
    },
    async listObjects({ prefix, maxKeys = 1000 } = {}) {
      if (prefix !== 'radar-backups/v1/' ||
          !Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 1000)
        throw Error('R2_LIST_INVALID');
      const result = await client.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, MaxKeys: maxKeys,
      }));
      return {
        truncated: result.IsTruncated === true ||
          Boolean(result.NextContinuationToken),
        objects: (result.Contents ?? []).map(x => ({
          key: x.Key, lastModified: x.LastModified instanceof Date
            ? x.LastModified.toISOString() : null, size: x.Size ?? null,
        })),
      };
    },
    async deleteObject(key) {
      checkedKey(key);
      if (key === 'radar-backups/v1/latest.json')
        throw Error('R2_PROTECTED_INDEX');
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  });
}

// Use only from a future explicitly configured, opt-in integration.
// The package has no ambient credential auto-discovery and never creates buckets.
export async function createR2AdapterFromCredentials({
  accountId, accessKeyId, secretAccessKey, bucket,
} = {}) {
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? '') ||
      typeof accessKeyId !== 'string' || accessKeyId.length < 5 ||
      typeof secretAccessKey !== 'string' || secretAccessKey.length < 8)
    throw Error('R2_CREDENTIALS_MISSING_OR_INVALID');
  const sdk = await import('@aws-sdk/client-s3');
  const client = new sdk.S3Client({
    region: 'auto',
    endpoint: 'https://' + accountId + '.r2.cloudflarestorage.com',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    maxAttempts: 2,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return { adapter: createR2S3Adapter({
    client, commands: sdk, bucket,
  }), client };
}
