import { NETWORK } from '../network.mjs';
import { createHash } from 'node:crypto';
import { keccak256 } from 'viem';

const METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_getCode', 'eth_call', 'eth_getStorageAt', 'eth_getTransactionReceipt',
  'eth_getTransactionByHash', 'debug_traceTransaction']);
export const hex = n => '0x' + BigInt(n).toString(16);
export function quantity(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('INVALID_QUANTITY');
  const n = Number(BigInt(value)); if (!Number.isSafeInteger(n) || n < 0) throw new Error('INVALID_QUANTITY'); return n;
}
export const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
export const MAX_AUDIT_BYTES = 131072;
const size = value => new TextEncoder().encode(JSON.stringify(value)).length;
const digest = value => ({ evidenceFormat: 'json-sha256-v1', rawRetained: false,
  sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'), jsonBytes: size(value) });
const project = (method, value) => {
  if (value === null) return null;
  if (method === 'eth_getBlockByNumber' && value && typeof value === 'object')
    return Object.fromEntries(['number', 'hash', 'timestamp'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  if (method === 'eth_getTransactionReceipt' && value && typeof value === 'object')
    return Object.fromEntries(['status', 'contractAddress', 'transactionHash', 'from', 'to', 'blockNumber', 'blockHash', 'transactionIndex']
      .filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  if (method === 'eth_getCode') {
    const validHex = typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value);
    return { evidenceFormat: 'bytecode-keccak256-v1', rawRetained: false, validHex,
      hasBytecode: validHex ? value !== '0x' : null,
      bytecodeBytes: validHex ? (value.length - 2) / 2 : null, codeHash: validHex ? keccak256(value) : null,
      ...(!validHex ? { invalidValue: digest(value) } : {}) };
  }
  if (method === 'eth_getLogs') return size(value) > 8192
    ? { ...digest(value), ...(Array.isArray(value) ? { logCount: value.length } : {}) } : value;
  return size(value) > 2048 ? digest(value) : value;
};

function compactEntry(entry) {
  const compact = { ...entry, ...(Object.hasOwn(entry, 'result') ? { result: digest(entry.result) } : {}) };
  if (size(compact) > 480 && Object.hasOwn(compact, 'params')) compact.params = digest(compact.params);
  return compact;
}
export class FreeRpc {
  constructor({ url = NETWORK.rpcUrl, fetchImpl = fetch, signal } = {}) {
    if (new URL(url).protocol !== 'https:') throw new Error('HTTPS_RPC_REQUIRED');
    Object.assign(this, { url, fetchImpl, signal }); this.id = 0; this.requests = 0; this.audit = []; this.auditBytes = 2;
  }
  record(entry) {
    let retained = { ...entry, ...(Object.hasOwn(entry, 'result') ? { result: project(entry.method, entry.result) } : {}) };
    if (size(retained) > 16384) retained = compactEntry(retained);
    if (this.auditBytes + size(retained) + 1 > MAX_AUDIT_BYTES) {
      // At most 32 batches of eight calls: compact records keep every call's
      // method/id and digest while bounding the aggregate independently of the
      // size of rejected log ranges, historical bytecode or receipt logs.
      this.audit = this.audit.map(compactEntry);
      this.auditBytes = size(this.audit);
      retained = compactEntry(retained);
    }
    this.audit.push(retained);
    this.auditBytes += size(retained) + 1;
  }
  async batch(calls) {
    if (!calls.length || calls.length > 8 || calls.some(([method]) => !METHODS.has(method))) throw new Error('READ_ONLY_BATCH_REQUIRED');
    if (++this.requests > 32) throw new Error('RPC_BUDGET_EXCEEDED');
    const body = calls.map(([method, params]) => ({ jsonrpc: '2.0', id: ++this.id, method, params }));
    // Uma chamada isolada usa o envelope normal. Alguns RPCs respondem a um
    // batch de um elemento com um objeto, violando a forma esperada do batch.
    const singleton = body.length === 1;
    let response; let envelopeDiagnostic;
    try {
      response = await this.fetchImpl.call(globalThis, this.url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(singleton ? body[0] : body), signal: AbortSignal.any([AbortSignal.timeout(12000), ...[this.signal].filter(Boolean)]) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`RPC_HTTP_${response.status}`); }
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 262144) { await reader.cancel(); throw new Error('RPC_RESPONSE_LIMIT'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const data = JSON.parse(new TextDecoder().decode(bytes));
      const rejectEnvelope = () => {
        const entries = (Array.isArray(data) ? data : [data]).slice(0, 8);
        envelopeDiagnostic = { methods: body.map(call => call.method), requestShape: singleton ? 'object' : 'array',
          responseShape: Array.isArray(data) ? 'array' : data === null ? 'null' : typeof data,
          responseCount: Array.isArray(data) ? data.length : 1,
          idsMatch: entries.every(entry => entry && body.some(call => call.id === entry.id)),
          versionsValid: entries.every(entry => entry?.jsonrpc === '2.0') };
        throw new Error('INVALID_RPC_ENVELOPE');
      };
      if (singleton ? !data || typeof data !== 'object' || Array.isArray(data)
        : !Array.isArray(data) || data.length !== body.length) rejectEnvelope();
      const results = singleton ? [data] : data;
      if (results.some(result => !result || typeof result !== 'object' || Array.isArray(result)
        || result.jsonrpc !== '2.0' || !body.some(call => call.id === result.id)
        || Object.hasOwn(result, 'result') === Object.hasOwn(result, 'error')
        || (Object.hasOwn(result, 'error') && (!result.error || typeof result.error !== 'object'
          || Array.isArray(result.error) || !Number.isInteger(result.error.code) || typeof result.error.message !== 'string')))) rejectEnvelope();
      const ids = new Set(results.map(result => result.id)); if (ids.size !== results.length) rejectEnvelope();
      return body.map(call => {
        const result = results.find(result => result.id === call.id);
        const entry = { ...call, ...(Object.hasOwn(result, 'error') ? { error: result.error.code } : { result: result.result }) };
        this.record(entry);
        return result.error ? { error: entry.error } : { value: result.result };
      });
    } catch (error) {
      // Erros de transporte não podem incluir a URL privada nem a sua API key.
      const safe = ['RPC_RESPONSE_LIMIT', 'RPC_HTTP_ERROR', 'INVALID_RPC_ENVELOPE'].includes(error.message) || /^RPC_HTTP_[1-5]\d{2}$/.test(error.message)
        ? error.message : 'RPC_TRANSPORT_FAILED';
      this.record({ error: safe });
      throw Object.assign(new Error(safe), envelopeDiagnostic ? { rpcDiagnostic: envelopeDiagnostic } : {});
    }
  }
  async request(method, params = []) {
    const [result] = await this.batch([[method, params]]);
    if (result.error !== undefined) throw Object.assign(new Error('RPC_REMOTE_ERROR'), { code: result.error });
    return result.value;
  }
  async block(number = 'latest') {
    const block = await this.request('eth_getBlockByNumber', [number === 'latest' ? number : hex(number), false]);
    if (!block || !hash(block.hash)) throw new Error('INVALID_BLOCK');
    const parsed = { number: quantity(block.number), timestamp: quantity(block.timestamp), hash: block.hash.toLowerCase() };
    if (number !== 'latest' && parsed.number !== number) throw new Error('INVALID_BLOCK');
    return parsed;
  }
}
