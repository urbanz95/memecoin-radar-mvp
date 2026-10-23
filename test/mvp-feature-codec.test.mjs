import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { encodeEventFeatures, decodeEventFeatures, MAX_EVENT_FEATURE_BYTES } from '../src/mvp/feature-codec.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const envelope = buffer => JSON.stringify({ schemaVersion: 1, encoding: 'gzip-base64/v1',
  sha256: sha256(buffer), uncompressedBytes: buffer.length, data: gzipSync(buffer).toString('base64') });
const replace = (encoded, patch) => JSON.stringify({ ...JSON.parse(encoded), ...patch });

test('event features round-trip exact UTF8, whitespace, timestamps and nulls in a JSON-valid versioned envelope', () => {
  const original = ' { "schemaVersion": 1, "capturedAt": "2026-10-23T14:00:00.000Z", "values": { "nome": "Observação 🪙", "unknown": null } }\n';
  const encoded = encodeEventFeatures(original);
  const body = JSON.parse(encoded);
  assert.equal(body.schemaVersion, 1); assert.equal(body.encoding, 'gzip-base64/v1');
  assert.equal(body.uncompressedBytes, Buffer.byteLength(original));
  assert.equal(body.sha256, sha256(Buffer.from(original)));
  assert.equal(decodeEventFeatures(encoded), original);
  assert.equal(encodeEventFeatures(original), encoded);
});

test('legacy unencoded JSON remains byte-for-byte compatible, including primitive or array payloads', () => {
  for (const original of [' {"schemaVersion":1,"values":{"priceUsd":null}}\n', '[1,null,"é"]', 'null', '0', '"raw"',
    '{"encoding":"application/json","value":1}'])
    assert.equal(decodeEventFeatures(original), original);
});

test('the uncompressed limit is exactly 64KiB measured in bytes, not JavaScript characters', () => {
  assert.equal(MAX_EVENT_FEATURE_BYTES, 65536);
  const limit = '"' + 'é'.repeat((MAX_EVENT_FEATURE_BYTES - 2) / 2) + '"';
  assert.equal(Buffer.byteLength(limit), MAX_EVENT_FEATURE_BYTES);
  assert.equal(decodeEventFeatures(encodeEventFeatures(limit)), limit);
  const oversized = '"' + 'é'.repeat(MAX_EVENT_FEATURE_BYTES / 2) + '"';
  assert.throws(() => encodeEventFeatures(oversized), /MVP_FEATURE_CODEC_INPUT_LIMIT/);
  assert.throws(() => decodeEventFeatures(oversized), /MVP_FEATURE_CODEC_INPUT_LIMIT/);
});

test('invalid JSON and non-string inputs cannot be encoded or decoded as archived features', () => {
  for (const original of ['', 'not JSON', '{', '[1,]', undefined, null, {}, 123]) {
    assert.throws(() => encodeEventFeatures(original), /MVP_FEATURE_CODEC_(INVALID_INPUT|INVALID_JSON)/);
    assert.throws(() => decodeEventFeatures(original), /MVP_FEATURE_CODEC_(INVALID_INPUT|INVALID_JSON)/);
  }
});

test('decoder rejects altered hash, declared size and invalid envelope metadata', () => {
  const original = '{"value":1}'; const encoded = encodeEventFeatures(original);
  assert.throws(() => decodeEventFeatures(replace(encoded, { sha256: 'a'.repeat(64) })), /MVP_FEATURE_CODEC_HASH_MISMATCH/);
  assert.throws(() => decodeEventFeatures(replace(encoded, { uncompressedBytes: Buffer.byteLength(original) + 1 })), /MVP_FEATURE_CODEC_SIZE_MISMATCH/);
  for (const patch of [{ schemaVersion: 2 }, { sha256: 'bad' }, { uncompressedBytes: -1 },
    { uncompressedBytes: 1.5 }, { data: 7 }, { unexpected: true }])
    assert.throws(() => decodeEventFeatures(replace(encoded, patch)), /MVP_FEATURE_CODEC_INVALID_ENVELOPE/);
  assert.throws(() => decodeEventFeatures(replace(encoded, { encoding: 'gzip-base64/v2' })), /MVP_FEATURE_CODEC_UNSUPPORTED_ENCODING/);
});

test('decoder requires canonical base64 and a valid complete gzip stream', () => {
  const encoded = encodeEventFeatures('{"value":1}');
  for (const data of ['', 'not base64!!', 'AAAA=', 'Zh==', ' eA=='])
    assert.throws(() => decodeEventFeatures(replace(encoded, { data })), /MVP_FEATURE_CODEC_INVALID_BASE64/);
  assert.throws(() => decodeEventFeatures(replace(encoded, { data: Buffer.from('not gzip').toString('base64') })), /MVP_FEATURE_CODEC_INVALID_GZIP/);
  const compressed = Buffer.from(JSON.parse(encoded).data, 'base64');
  assert.throws(() => decodeEventFeatures(replace(encoded, { data: compressed.subarray(0, compressed.length - 3).toString('base64') })), /MVP_FEATURE_CODEC_INVALID_GZIP/);
});

test('declared oversized data and zip bombs with a false small declaration cannot exceed the decompression cap', () => {
  const bomb = Buffer.from('"' + 'x'.repeat(MAX_EVENT_FEATURE_BYTES * 20) + '"');
  const encoded = JSON.parse(envelope(bomb));
  assert.throws(() => decodeEventFeatures(JSON.stringify(encoded)), /MVP_FEATURE_CODEC_INPUT_LIMIT/);
  encoded.uncompressedBytes = 1;
  assert.throws(() => decodeEventFeatures(JSON.stringify(encoded)), /MVP_FEATURE_CODEC_DECOMPRESSION_LIMIT/);
});

test('decoded content must still be strict UTF8 and valid JSON even when its size and hash agree', () => {
  assert.throws(() => decodeEventFeatures(envelope(Buffer.from('not JSON'))), /MVP_FEATURE_CODEC_INVALID_JSON/);
  assert.throws(() => decodeEventFeatures(envelope(Buffer.from([0xc3, 0x28]))), /MVP_FEATURE_CODEC_INVALID_UTF8/);
  assert.throws(() => encodeEventFeatures('"\ud800"'), /MVP_FEATURE_CODEC_INVALID_UTF8/);
});

test('compressed input and envelope byte limits are enforced before attempting expensive inflation', () => {
  const encoded = encodeEventFeatures('{}');
  assert.throws(() => decodeEventFeatures(replace(encoded, { data: Buffer.alloc(MAX_EVENT_FEATURE_BYTES + 1025).toString('base64') })),
    /MVP_FEATURE_CODEC_(ENVELOPE_LIMIT|COMPRESSED_LIMIT)/);
  assert.throws(() => decodeEventFeatures(' '.repeat(100000) + encoded), /MVP_FEATURE_CODEC_ENVELOPE_LIMIT/);
});
