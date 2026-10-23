// Local CPU estimate, not a Cloudflare Free acceptance test. No network/credentials.
// The SQLite backend and fake RPC server's work are timed separately because
// those execute outside the Worker in production. D1 client overhead remains an
// approximation; only remote Workers Metrics can certify the 10 ms limit.
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { encodeAbiParameters, parseAbiParameters, encodeEventTopics, keccak256 } from 'viem';
import { collectFree } from '../src/cloudflare/collector.mjs';
import { decodePool } from '../src/onchain/decode-pool.mjs';
import { EVENTS } from '../src/onchain/abi.mjs';
import { runScan } from '../src/runner.mjs';
import { QUOTE_ASSETS } from '../src/network.mjs';
import policy from '../config/policies.json' with { type: 'json' };

const schema = await readFile(new URL('../cloudflare/migrations/0001_collector.sql', import.meta.url), 'utf8');
const hex = n => '0x' + BigInt(n).toString(16);
const h = n => '0x' + BigInt(n + 1).toString(16).padStart(64, '0');
const address = (prefix, n) => '0x' + prefix + BigInt(n).toString(16).padStart(38, '0');
const cpu = () => { const n = process.cpuUsage(); return n.user + n.system; };
function stats(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const q = n => Number(ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * n))].toFixed(3));
  return { p50Ms: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), maxMs: q(1) };
}
class D1 {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec(schema); this.cpuMicros = 0; }
  time(fn) { const t = cpu(); try { return fn(); } finally { this.cpuMicros += cpu() - t; } }
  prepare(sql) {
    const db = this; let args = [];
    return { bind(...values) { args = values; return this; },
      async first() { return db.time(() => db.db.prepare(sql).get(...args) ?? null); },
      async run() { return db.time(() => { const r = db.db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; }); } };
  }
  async batch(statements) {
    this.time(() => this.db.exec('BEGIN'));
    try { const out = []; for (const s of statements) out.push(await s.run()); this.time(() => this.db.exec('COMMIT')); return out; }
    catch (error) { this.time(() => this.db.exec('ROLLBACK')); throw error; }
  }
}
function makeLog(type, number, index = 0) {
  const token0 = QUOTE_ASSETS.WETH; const token1 = address('11', number * 10 + index); const pool = address('22', number * 10 + index);
  const common = { blockNumber: hex(number), blockHash: h(number), transactionHash: h(number * 100 + index), logIndex: hex(index), removed: false };
  if (type === 'v2') return { ...common, address: '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f',
    topics: encodeEventTopics({ abi: [EVENTS.v2], eventName: 'PairCreated', args: { token0, token1 } }),
    data: encodeAbiParameters(parseAbiParameters('address,uint256'), [pool, 1n]) };
  if (type === 'v3') return { ...common, address: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
    topics: encodeEventTopics({ abi: [EVENTS.v3], eventName: 'PoolCreated', args: { token0, token1, fee: 500 } }),
    data: encodeAbiParameters(parseAbiParameters('int24,address'), [10, pool]) };
  const hooks = '0x' + '0'.repeat(40);
  const id = keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'), [token0, token1, 500, 10, hooks]));
  return { ...common, address: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    topics: encodeEventTopics({ abi: [EVENTS.v4], eventName: 'Initialize', args: { id, currency0: token0, currency1: token1 } }),
    data: encodeAbiParameters(parseAbiParameters('uint24,int24,address,uint160,int24'), [500, 10, hooks, 2n ** 96n, 0]) };
}
async function scenario({ name, logsPerRange, bytecodeBytes, type = 'v2' }) {
  const DB = new D1(); let head = 20000000; let latest = 0; let serverCpu = 0;
  const env = { DB, LOG_CHUNK: '2048', MAX_LOGS: '4' };
  const bytecode = '0x' + '60'.repeat(bytecodeBytes);
  const fetchImpl = async (_url, options) => {
    const start = cpu();
    try {
      const request = JSON.parse(options.body);
      const response = request.map(call => {
        let result;
        if (call.method === 'eth_chainId') result = '0x1237';
        else if (call.method === 'eth_getBlockByNumber') {
          const n = call.params[0] === 'latest' ? head + latest++ : Number(BigInt(call.params[0]));
          result = { number: hex(n), timestamp: hex(Math.floor(Date.now() / 1000) - Math.floor(Math.max(0, head - n) / 10)), hash: h(n) };
        } else if (call.method === 'eth_getLogs') {
          const n = Number(BigInt(call.params[0].toBlock));
          result = Array.from({ length: logsPerRange }, (_, i) => makeLog(type, n, i));
        } else if (call.method === 'eth_getCode') result = bytecode;
        else if (call.method === 'eth_call') result = '0x' + '0'.repeat(63) + '1';
        else throw new Error('unexpected method');
        return { jsonrpc: '2.0', id: call.id, result };
      });
      return new Response(JSON.stringify(response));
    } finally { serverCpu += cpu() - start; }
  };
  const total = []; const estimatedWorker = []; const sql = []; const server = [];
  try {
    for (let i = 0; i < 240; i++) {
      const state = JSON.parse(DB.db.prepare('SELECT state_json FROM control').get().state_json);
      state.backfillCursor = head - 10000; state.backfillOffset = 0;
      state.historicalCursor = head - 1000000; state.historicalOffset = 0;
      DB.db.prepare('UPDATE control SET state_json=?').run(JSON.stringify(state));
      DB.cpuMicros = 0; serverCpu = 0; latest = 0;
      const start = cpu();
      const result = await collectFree(env, { fetchImpl });
      const elapsed = cpu() - start;
      if (result.status !== 'COMPLETED') throw new Error(JSON.stringify(result));
      if (i >= 40) {
        total.push(elapsed / 1000); sql.push(DB.cpuMicros / 1000); server.push(serverCpu / 1000);
        estimatedWorker.push(Math.max(0, elapsed - DB.cpuMicros - serverCpu) / 1000);
      }
      head += 600;
    }
    return { name, samples: 200, logsPerRange, bytecodeBytes, type, totalLocalCpu: stats(total),
      localSqliteCpu: stats(sql), fakeRpcServerCpu: stats(server), estimatedWorkerCpu: stats(estimatedWorker) };
  } finally { DB.db.close(); }
}
function micro(name, fn, iterations = 1000) {
  for (let i = 0; i < 100; i++) fn();
  const start = cpu(); for (let i = 0; i < iterations; i++) fn();
  return { name, averageMs: Number(((cpu() - start) / iterations / 1000).toFixed(4)) };
}
const sampleLog = makeLog('v2', 10000);
const snapshot = { schemaVersion: 2, synthetic: false, chain: 'robinhood', chainId: 4663, environment: 'mainnet', address: address('11', 1),
  chainState: {}, security: {}, market: {}, holders: {}, activity: {}, quote: {}, liquidityProtection: {} };
const components = [micro('two-pipeline-runScan-incomplete', () => runScan([snapshot], policy)),
  micro('json-parse-24KiB-bytecode-envelope', (() => { const raw = JSON.stringify([{ jsonrpc: '2.0', id: 1, result: '0x' + '60'.repeat(24535) }]); return () => JSON.parse(raw); })())];
for (const type of ['v2', 'v3', 'v4']) {
  const log = makeLog(type, 10000); const venue = { type, address: log.address };
  components.push(micro(`decode-8-${type}-pool-events`, () => { for (let i = 0; i < 8; i++) decodePool(log, venue); }));
}
const scenarios = [];
for (const config of [
  { name: 'quiet-no-pools', logsPerRange: 0, bytecodeBytes: 0 },
  { name: 'typical-1-event-per-range-3.5KiB-code', logsPerRange: 1, bytecodeBytes: 3553 },
  { name: 'cap-4-events-per-range-24KiB-code', logsPerRange: 4, bytecodeBytes: 24535 },
  { name: 'v4-cap-4-events-per-range-24KiB-code', logsPerRange: 4, bytecodeBytes: 24535, type: 'v4' },
]) scenarios.push(await scenario(config));
const output = { measuredAt: new Date().toISOString(), node: process.versions.node, arch: process.arch,
  warning: 'Node/x86 CPU estimate only, not remote Cloudflare CPU proof. SQL + fake RPC server CPU subtracted from per-sample estimates. D1 client/I/O bookkeeping, platform CPU accounting and hardware differ.', components, scenarios };
const path = resolve(process.argv[2] ?? 'runtime/benchmark-cloudflare-local.json');
await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ report: path, ...output }, null, 2));
