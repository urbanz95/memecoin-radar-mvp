import { fetch, EnvHttpProxyAgent } from 'undici';
import { setTimeout as delay } from 'node:timers/promises';
import { NETWORK } from '../network.mjs';

const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber',
  'eth_getCode', 'eth_call', 'eth_getStorageAt', 'eth_getLogs', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'debug_traceTransaction']);
export const hex = (n) => '0x' + BigInt(n).toString(16);
export const quantity = (value) => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('Quantidade RPC inválida');
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Quantidade RPC fora do domínio');
  return n;
};
export const hash = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);

export class RpcError extends Error {
  constructor(method, code = 'TRANSPORT') { super(`RPC ${method} falhou (${code})`); this.code = code; }
}

export class RpcClient {
  constructor({ url = NETWORK.rpcUrl, timeoutMs = 20000, retries = 2, maxRpcRequests = 2000, fetchImpl = fetch, dispatcher, signal } = {}) {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('RPC HTTP(S) obrigatório');
    this.url = url; // Nunca serializado: endpoints privados podem conter credenciais.
    this.timeoutMs = timeoutMs; this.retries = retries; this.maxRpcRequests = maxRpcRequests;
    this.fetchImpl = fetchImpl;
    this.signal = signal;
    this.dispatcher = dispatcher ?? (fetchImpl === fetch ? new EnvHttpProxyAgent() : undefined);
    this.id = 0; this.audit = []; this.blocks = new Map(); this.requestCount = 0;
  }
  async request(method, params = []) {
    if (!READ_METHODS.has(method)) throw new Error('Método fora da allowlist de leitura');
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (this.signal?.aborted) throw new RpcError(method, 'DEADLINE_EXCEEDED');
      if (++this.requestCount > this.maxRpcRequests) throw new RpcError(method, 'BUDGET_EXCEEDED');
      const id = ++this.id;
      try {
        const response = await this.fetchImpl(this.url, { method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'memecoin-radar/0.3' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
          ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}) });
        if (!response.ok) { await response.body?.cancel(); throw new RpcError(method, `HTTP_${response.status}`); }
        const body = await response.text();
        if (body.length > 20 * 1024 * 1024) throw new RpcError(method, 'RESPONSE_TOO_LARGE');
        let data;
        try { data = JSON.parse(body); } catch { throw new RpcError(method, 'INVALID_JSON'); }
        if (data.id !== id || data.jsonrpc !== '2.0') throw new RpcError(method, 'INVALID_ENVELOPE');
        if (data.error) {
          const error = new RpcError(method, Number.isInteger(data.error.code) ? data.error.code : 'REMOTE_ERROR');
          error.rangeLimit = /block range|too many|response size|query returned more|limit exceeded/i.test(data.error.message ?? '');
          throw error;
        }
        if (!Object.hasOwn(data, 'result')) throw new RpcError(method, 'MISSING_RESULT');
        this.audit.push({ id, method, params, result: data.result, receivedAt: new Date().toISOString() });
        return data.result;
      } catch (error) {
        const safe = this.signal?.aborted ? new RpcError(method, 'DEADLINE_EXCEEDED') : error instanceof RpcError ? error : new RpcError(method);
        this.audit.push({ id, method, params, error: safe.code, receivedAt: new Date().toISOString() });
        const retry = ['TRANSPORT', 'HTTP_429', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504', -32016].includes(safe.code);
        if (!retry || attempt === this.retries) throw safe;
        try { await delay(Math.min(2000, 300 * 2 ** attempt), undefined, { signal: this.signal }); }
        catch { throw new RpcError(method, 'DEADLINE_EXCEEDED'); }
      }
    }
  }
  async assertMainnet() {
    const id = quantity(await this.request('eth_chainId'));
    if (id !== NETWORK.chainId) throw new Error('RPC não é Robinhood Chain mainnet 4663; recolha interrompida');
    return id;
  }
  async block(number = 'latest', full = false) {
    const key = `${number}:${full}`;
    if (number === 'latest' || !this.blocks.has(key)) {
      const value = await this.request('eth_getBlockByNumber', [number === 'latest' ? number : hex(number), full]);
      if (!value || !hash(value.hash) || /^0x0{64}$/i.test(value.hash)) throw new Error('Bloco RPC ausente ou inválido');
      const result = { ...value, number: quantity(value.number), timestamp: quantity(value.timestamp) };
      if (number !== 'latest' && result.number !== number) throw new Error('RPC devolveu outra altura de bloco');
      if (number !== 'latest') this.blocks.set(key, result);
      return result;
    }
    return this.blocks.get(key);
  }
  async findBlockAtOrAfter(timestamp, head) {
    let low = 0; let high = head.number;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if ((await this.block(mid)).timestamp < timestamp) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  async logs(address, topics, from, to) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from > to) throw new Error('Intervalo de logs inválido');
    let logs;
    try {
      logs = await this.request('eth_getLogs', [{ address, topics, fromBlock: hex(from), toBlock: hex(to) }]);
      if (!Array.isArray(logs)) throw new RpcError('eth_getLogs', 'INVALID_LOGS');
      if (logs.length >= 10000) throw new RpcError('eth_getLogs', 'RESPONSE_TOO_LARGE');
    } catch (error) {
      if (from >= to || !(error.rangeLimit || [-32005, -32602, 'RESPONSE_TOO_LARGE'].includes(error.code))) throw error;
      const middle = Math.floor((from + to) / 2);
      return [...await this.logs(address, topics, from, middle), ...await this.logs(address, topics, middle + 1, to)];
    }
    const seen = new Set();
    return logs.filter((log) => {
      if (log.removed || !hash(log.blockHash) || !hash(log.transactionHash) || /^0x0{64}$/i.test(log.blockHash) || /^0x0{64}$/i.test(log.transactionHash) || typeof log.address !== 'string' || log.address.toLowerCase() !== address.toLowerCase()) throw new Error('Log removido ou identidade inválida');
      const number = quantity(log.blockNumber);
      if (number < from || number > to || !Array.isArray(log.topics) || log.topics.some((t) => !hash(t))) throw new Error('Log fora do intervalo ou tópicos inválidos');
      for (let i = 0; i < topics.length; i++) {
        const expected = topics[i];
        if (expected && !(Array.isArray(expected) ? expected : [expected]).map((v) => v.toLowerCase()).includes(log.topics[i]?.toLowerCase())) throw new Error('Log não corresponde ao filtro pedido');
      }
      const id = `${log.blockHash}:${log.transactionHash}:${quantity(log.logIndex)}`;
      if (seen.has(id)) return false;
      seen.add(id); return true;
    }).sort((a, b) => quantity(a.blockNumber) - quantity(b.blockNumber) || quantity(a.logIndex) - quantity(b.logIndex));
  }
  async close() { await this.dispatcher?.close?.(); }
}
