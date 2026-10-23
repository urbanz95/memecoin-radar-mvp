import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const MAX_EVENT_FEATURE_BYTES = 64 * 1024;
const MAX_COMPRESSED_BYTES = MAX_EVENT_FEATURE_BYTES + 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_COMPRESSED_BYTES / 3) * 4;
const MAX_ENVELOPE_BYTES = MAX_BASE64_LENGTH + 1024;
// Workerd's zlib counts internal inflate buffers against maxOutputLength.
// Reserve a bounded 128 KiB workspace, then enforce the 64 KiB payload limit.
const MAX_INFLATE_BUFFER_BYTES = MAX_EVENT_FEATURE_BYTES * 2;
const ENCODING = 'gzip-base64/v1';
const KEYS = ['schemaVersion', 'encoding', 'sha256', 'uncompressedBytes', 'data'];
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const fail = code => { throw new Error('MVP_FEATURE_CODEC_' + code); };

function utf8(value, limit, code) {
  if (typeof value !== 'string') fail('INVALID_INPUT');
  // UTF8 byte length is bounded before parsing or compression. Reject a lossy
  // conversion of unpaired UTF16 surrogates instead of changing archived data.
  if (value.length > limit) fail(code);
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length > limit) fail(code);
  if (buffer.toString('utf8') !== value) fail('INVALID_UTF8');
  return buffer;
}
function json(value) {
  try { return JSON.parse(value); } catch { fail('INVALID_JSON'); }
}
function encodedEnvelope(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (typeof value.encoding === 'string' && value.encoding.startsWith('gzip-base64/')
      || KEYS.slice(1).every(key => Object.hasOwn(value, key)));
}

/** Compress immutable decision-event features; canonical first features remain independent. */
export function encodeEventFeatures(jsonString) {
  const original = utf8(jsonString, MAX_EVENT_FEATURE_BYTES, 'INPUT_LIMIT');
  json(jsonString);
  const compressed = gzipSync(original, { level: 6 });
  if (compressed.length > MAX_COMPRESSED_BYTES) fail('COMPRESSED_LIMIT');
  return JSON.stringify({ schemaVersion: 1, encoding: ENCODING, sha256: digest(original),
    uncompressedBytes: original.length, data: compressed.toString('base64') });
}

/** Decode a bounded gzip envelope or return legacy unencoded JSON without reserializing it. */
export function decodeEventFeatures(jsonString) {
  const input = utf8(jsonString, MAX_ENVELOPE_BYTES, 'ENVELOPE_LIMIT');
  const value = json(jsonString);
  if (!encodedEnvelope(value)) {
    if (input.length > MAX_EVENT_FEATURE_BYTES) fail('INPUT_LIMIT');
    return jsonString;
  }
  if (value.encoding !== ENCODING) fail('UNSUPPORTED_ENCODING');
  if (Object.keys(value).length !== KEYS.length || !KEYS.every(key => Object.hasOwn(value, key))
    || value.schemaVersion !== 1 || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.uncompressedBytes) || value.uncompressedBytes < 1 || typeof value.data !== 'string')
    fail('INVALID_ENVELOPE');
  if (value.uncompressedBytes > MAX_EVENT_FEATURE_BYTES) fail('INPUT_LIMIT');
  if (value.data.length > MAX_BASE64_LENGTH) fail('COMPRESSED_LIMIT');
  if (!value.data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data))
    fail('INVALID_BASE64');
  const compressed = Buffer.from(value.data, 'base64');
  if (compressed.toString('base64') !== value.data) fail('INVALID_BASE64');
  if (compressed.length > MAX_COMPRESSED_BYTES) fail('COMPRESSED_LIMIT');
  let original;
  try { original = gunzipSync(compressed, { maxOutputLength: MAX_INFLATE_BUFFER_BYTES }); }
  catch (error) { fail(error?.code === 'ERR_BUFFER_TOO_LARGE'
    || error?.name === 'RangeError' && error?.message === 'Memory limit exceeded' ? 'DECOMPRESSION_LIMIT' : 'INVALID_GZIP'); }
  if (original.length > MAX_EVENT_FEATURE_BYTES) fail('DECOMPRESSION_LIMIT');
  if (original.length !== value.uncompressedBytes) fail('SIZE_MISMATCH');
  if (digest(original) !== value.sha256) fail('HASH_MISMATCH');
  let decoded;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(original); } catch { fail('INVALID_UTF8'); }
  json(decoded);
  return decoded;
}
