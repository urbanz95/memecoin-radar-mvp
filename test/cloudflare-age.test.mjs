import test from 'node:test';
import assert from 'node:assert/strict';
import { ageEvidence } from '../src/cloudflare/age-evidence.mjs';
import { FreeRpc, hex } from '../src/cloudflare/rpc.mjs';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const DEPLOYER = '0x2222222222222222222222222222222222222222';
const TX = '0x' + 'a'.repeat(64);
const blockHash = n => '0x' + BigInt(n + 1).toString(16).padStart(64, '0');
const HEAD = { number: 10000000, timestamp: 1792671000, hash: blockHash(10000000) };
const now = () => HEAD.timestamp * 1000;
const missingSource = async () => Response.json({ match: null }, { status: 404 });

function fixture({ poolAge = 600, tokenAge = 1200, exact = false, source, mutate } = {}) {
  const poolNumber = HEAD.number - poolAge;
  const pool = { createdBlock: poolNumber, createdBlockHash: blockHash(poolNumber), ...(exact ? { creationTransactionHash: TX } : {}) };
  const created = { number: poolNumber, timestamp: HEAD.timestamp - poolAge, hash: blockHash(poolNumber) };
  const rpc = { requests: 0, calls: [], async batch(calls) {
    this.requests++; this.calls.push(calls);
    return calls.map(([method, params]) => {
      let value;
      if (method === 'eth_getBlockByNumber') {
        const n = Number(BigInt(params[0]));
        value = { number: hex(n), timestamp: hex(HEAD.timestamp - (HEAD.number - n)), hash: blockHash(n) };
      } else if (method === 'eth_getCode') value = Number(BigInt(params[1])) >= HEAD.number - tokenAge ? '0x6000' : '0x';
      else if (method === 'eth_getTransactionReceipt') value = exact ? { transactionHash: TX, status: '0x1', contractAddress: ADDRESS,
        from: DEPLOYER, to: null, blockNumber: hex(poolNumber), blockHash: blockHash(poolNumber) } : null;
      return { value: mutate ? mutate(method, params, value) : value };
    });
  } };
  return { rpc, pool, created, options: { fetchImpl: source ?? missingSource, now } };
}

test('historical code proves the new window without inventing an exact creation timestamp', async () => {
  const f = fixture(); const result = await ageEvidence(f.rpc, ADDRESS, f.pool, HEAD, f.created, f.options);
  assert.equal(result.classification, 'new'); assert.equal(result.basis, 'code-existence-bounds');
  assert.equal(result.contractCreatedAt, undefined); assert.equal(result.deployer, undefined);
  assert.ok(result.lowerBoundMinutes >= 15); assert.ok(result.upperBoundMinutes <= 2880);
  assert.equal(f.rpc.requests, 4); assert.ok(f.rpc.calls.every(calls => calls.length <= 8));
});

test('an old pool plus historical token bytecode proves only an established lower bound', async () => {
  const f = fixture({ poolAge: 8 * 86400, tokenAge: 9 * 86400 });
  const result = await ageEvidence(f.rpc, ADDRESS, f.pool, HEAD, f.created, f.options);
  assert.equal(result.classification, 'established'); assert.equal(result.lowerBoundMinutes, 8 * 1440);
  assert.equal(result.contractCreatedAt, undefined); assert.equal(f.rpc.requests, 2);
});

test('only a successful matching direct creation receipt proves exact creation and deployer', async () => {
  const f = fixture({ poolAge: 1200, tokenAge: 1200, exact: true });
  const result = await ageEvidence(f.rpc, ADDRESS, f.pool, HEAD, f.created, f.options);
  assert.equal(result.contractCreatedAt, new Date(f.created.timestamp * 1000).toISOString());
  assert.equal(result.deployer, DEPLOYER); assert.equal(result.basis, 'direct-creation-receipt'); assert.equal(result.classification, 'new');
});

test('factory receipts, wrong transaction hashes and failed receipts never prove exact creation', async () => {
  for (const change of [r => ({ ...r, contractAddress: DEPLOYER }), r => ({ ...r, transactionHash: blockHash(1) }), r => ({ ...r, status: '0x0' })]) {
    const f = fixture({ exact: true, mutate: (method, _params, value) => method === 'eth_getTransactionReceipt' ? change(value) : value });
    const result = await ageEvidence(f.rpc, ADDRESS, f.pool, HEAD, f.created, f.options);
    assert.equal(result.contractCreatedAt, undefined);
  }
});

test('receipt block hash must match its canonical block header', async () => {
  const f = fixture({ exact: true, mutate: (method, _params, value) => method === 'eth_getTransactionReceipt' ? { ...value, blockHash: blockHash(7) } : value });
  const result = await ageEvidence(f.rpc, ADDRESS, f.pool, HEAD, f.created, f.options);
  assert.equal(result.contractCreatedAt, undefined);
});

test('canonical hash changes during code reads invalidate all age proofs', async () => {
  const f = fixture(); const batch = f.rpc.batch;
  f.rpc.batch = async function(calls) { const values = await batch.call(this, calls); return this.requests === 4 ? values.map(v => ({ value: { ...v.value, hash: blockHash(12) } })) : values; };
  const result = await ageEvidence(f.rpc, ADDRESS, f.pool, HEAD, f.created, f.options);
  assert.equal(result.classification, 'unclassified'); assert.equal(result.contractCreatedAt, undefined);
  assert.ok(result.reasons.includes('AGE_CANONICAL_PROOF_UNAVAILABLE'));
});

test('Sourcify dates and proxy metadata do not become creation dates; wrong identities are ignored', async () => {
  for (const identity of [{ chainId: '1', address: ADDRESS }, { chainId: '4663', address: DEPLOYER }, { chainId: '4663', address: ADDRESS }]) {
    const source = async () => Response.json({ ...identity, verifiedAt: '2020-01-01T00:00:00Z', runtimeMatch: 'exact_match', creationMatch: 'exact_match',
      proxyResolution: { isProxy: true }, deployment: { transactionHash: TX, blockNumber: String(HEAD.number - 600) } });
    const f = fixture({ source }); const result = await ageEvidence(f.rpc, ADDRESS, f.pool, HEAD, f.created, f.options);
    assert.equal(result.contractCreatedAt, undefined);
    if (identity.chainId === '4663' && identity.address === ADDRESS) assert.equal(result.sourceVerification.isProxy, true);
    else assert.equal(result.sourceVerification, undefined);
  }
});

test('Sourcify deployment is merely a candidate until receipt and canonical header agree', async () => {
  const source = async () => Response.json({ chainId: '4663', address: ADDRESS, runtimeMatch: 'exact_match',
    deployment: { transactionHash: TX, blockNumber: String(HEAD.number - 600) } });
  const f = fixture({ source, mutate: (method, _params, value) => method === 'eth_getTransactionReceipt'
    ? { transactionHash: TX, status: '0x1', contractAddress: ADDRESS, from: DEPLOYER, blockNumber: hex(HEAD.number - 600), blockHash: blockHash(HEAD.number - 600) } : value });
  const result = await ageEvidence(f.rpc, ADDRESS, f.pool, HEAD, f.created, f.options);
  assert.equal(result.contractCreatedAt, new Date(f.created.timestamp * 1000).toISOString());
});

test('absolute RPC budget is respected and missing age remains unknown', async () => {
  const f = fixture(); f.rpc.requests = 27;
  const result = await ageEvidence(f.rpc, ADDRESS, f.pool, HEAD, f.created, { ...f.options, maxRequests: 29 });
  assert.equal(f.rpc.requests, 29); assert.equal(result.classification, 'unclassified'); assert.equal(result.contractCreatedAt, undefined);
  assert.ok(result.reasons.includes('AGE_RPC_BUDGET_EXHAUSTED'));
});

test('a fresh token without 15 minutes of positive code is not classified as new', async () => {
  const f = fixture({ tokenAge: 120, poolAge: 60 }); const result = await ageEvidence(f.rpc, ADDRESS, f.pool, HEAD, f.created, f.options);
  assert.equal(result.classification, 'unclassified'); assert.equal(result.contractCreatedAt, undefined);
});

test('contradictory historical code does not classify a redeployment or disappearance as new', async () => {
  const f = fixture({ mutate: (method, params, value) => method === 'eth_getCode' && Number(BigInt(params[1])) === HEAD.number - 960 ? '0x' : value });
  const result = await ageEvidence(f.rpc, ADDRESS, f.pool, HEAD, f.created, f.options);
  // An older positive observation with newer absence breaks the age bound.
  // Force the 47-hour observation positive while retaining the 16-minute absence.
  const g = fixture({ mutate: (method, params, value) => method !== 'eth_getCode' ? value
    : Number(BigInt(params[1])) === HEAD.number - 47 * 3600 ? '0x6000'
      : Number(BigInt(params[1])) === HEAD.number - 960 ? '0x' : value });
  const contradiction = await ageEvidence(g.rpc, ADDRESS, g.pool, HEAD, g.created, g.options);
  assert.equal(result.classification, 'unclassified'); assert.equal(contradiction.classification, 'unclassified');
  assert.ok(contradiction.reasons.includes('AGE_CODE_CONTINUITY_UNPROVEN'));
});

test('bounded source responses and optional RPC failures return unknown safely', async () => {
  const f = fixture({ source: async () => new Response('x'.repeat(32769)) });
  f.rpc.batch = async () => { throw new Error('https://private.example/secret'); };
  const result = await ageEvidence(f.rpc, ADDRESS, f.pool, HEAD, f.created, f.options);
  assert.equal(result.classification, 'unclassified'); assert.ok(result.reasons.includes('SOURCE_RESPONSE_LIMIT'));
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('malformed RPC IDs are refused by the RPC transport before any age evidence is accepted', async () => {
  const f = fixture(); const rpc = new FreeRpc({ fetchImpl: async () => Response.json([{ jsonrpc: '2.0', id: 999, result: '0x6000' }]) });
  const result = await ageEvidence(rpc, ADDRESS, f.pool, HEAD, f.created, f.options);
  assert.equal(result.classification, 'unclassified'); assert.equal(result.contractCreatedAt, undefined); assert.deepEqual(result.evidence, []);
});
