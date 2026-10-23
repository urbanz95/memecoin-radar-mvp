import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { ERC20 } from '../src/onchain/abi.mjs';
import { analyseHolders, HOLDER_PROBE_ABI, HOLDER_PROBE_RUNTIME } from '../src/cloudflare/holder-analysis.mjs';
import { hex } from '../src/cloudflare/rpc.mjs';

const address = n => '0x' + n.toString(16).padStart(40, '0');
const blockHash = n => '0x' + (n + 1).toString(16).padStart(64, '0');
const ZERO = address(0); const TOKEN = address(1); const A = address(2); const B = address(3); const POOL = address(4);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const HEAD = { number: 1000, timestamp: 1792670400, hash: blockHash(1000) };
const topic = a => '0x' + '0'.repeat(24) + a.slice(2);
function transfer(from, to, amount, block = 10, index = 0) {
  return { address: TOKEN, topics: [TRANSFER, topic(from), topic(to)], data: hex(amount).replace('0x', '0x' + '0'.repeat(64 - BigInt(amount).toString(16).length)),
    blockNumber: hex(block), blockHash: blockHash(block), transactionHash: '0x' + (block + 2000).toString(16).padStart(64, '0'),
    logIndex: hex(index), transactionIndex: '0x0', removed: false };
}
function fixture(changes = {}) {
  const calls = [];
  const logs = changes.logs ?? [transfer(ZERO, A, 700n, 10, 0), transfer(ZERO, B, 200n, 10, 1), transfer(ZERO, POOL, 100n, 10, 2)];
  const balances = changes.balances ?? { [A]: 700n, [B]: 200n, [POOL]: 100n };
  const head = changes.head ?? HEAD;
  const rpc = { requests: changes.requests ?? 0, async batch(batch) {
    this.requests++; calls.push(batch);
    if (changes.throws) throw new Error('private-url-and-secret');
    return batch.map(([method, params]) => {
      if (method === 'eth_getBlockByNumber') {
        const n = Number(BigInt(params[0]));
        const value = { number: hex(n), hash: n === head.number ? head.hash : blockHash(n), timestamp: hex(head.timestamp - (head.number - n)) };
        if (changes.header) Object.assign(value, changes.header(n, calls.length));
        return { value };
      }
      if (method === 'eth_getCode') return { value: params[0] === TOKEN ? changes.genesisCode ?? '0x' : changes.probeCode ?? '0x' };
      if (method === 'eth_getLogs') {
        const { fromBlock, toBlock } = params[0];
        assert.equal(params[0].address, TOKEN); assert.deepEqual(params[0].topics, [TRANSFER]);
        return changes.logsError ? { error: -32005 } : { value: logs.filter(log => {
          const n = Number(BigInt(log.blockNumber)); return n >= Number(BigInt(fromBlock)) && n <= Number(BigInt(toBlock));
        }) };
      }
      assert.equal(method, 'eth_call');
      if (params.length === 3) {
        const decoded = decodeFunctionData({ abi: HOLDER_PROBE_ABI, data: params[0].data });
        assert.equal(decoded.functionName, 'balances'); assert.equal(decoded.args[0].toLowerCase(), TOKEN);
        assert.equal(params[2][params[0].to].code, HOLDER_PROBE_RUNTIME);
        assert.deepEqual(Object.keys(params[2][params[0].to]), ['code']);
        if (changes.aggregateError) return { error: changes.aggregateError };
        const result = decoded.args[1].map(a => balances[a.toLowerCase()] ?? 0n);
        if (changes.aggregateMismatch) result[0] += 1n;
        return { value: encodeFunctionResult({ abi: HOLDER_PROBE_ABI, functionName: 'balances', result }) };
      }
      assert.equal(params[0].to, TOKEN);
      const decoded = decodeFunctionData({ abi: ERC20, data: params[0].data });
      if (changes.missingBalance && decoded.functionName === 'balanceOf' && decoded.args[0].toLowerCase() === changes.missingBalance) return { error: -32000 };
      const result = decoded.functionName === 'totalSupply' ? (changes.supply ?? 1000n) : balances[decoded.args[0].toLowerCase()] ?? 0n;
      return { value: encodeFunctionResult({ abi: ERC20, functionName: decoded.functionName, result }) };
    });
  } };
  return { rpc, calls, head, options: { verifiedPoolAddresses: [POOL], pipeline: 'new', ...(changes.options ?? {}) } };
}
const run = f => analyseHolders(f.rpc, TOKEN, f.head, {}, f.options);

test('genesis absence + complete transfers + every balance at the same canonical head proves concentration', async () => {
  const f = fixture(); const result = await run(f);
  assert.equal(f.rpc.requests, 2);
  assert.equal(result.assessment.status, 'RECONCILED_AT_HEAD');
  assert.equal(result.assessment.coverage.transferHistoryComplete, true);
  assert.equal(result.assessment.coverage.distributionComplete, true);
  assert.equal(result.assessment.supplyReconciled, true);
  assert.deepEqual(result.assessment.metrics, { count: 2, top1Pct: 70, top10Pct: 90 });
  assert.equal(result.snapshot.holders.count, 2);
  assert.equal(result.assessment.checkedAt, new Date(HEAD.timestamp * 1000).toISOString());
  assert.equal(result.assessment.blockHash, HEAD.hash);
  assert.deepEqual(result.evidence.excludedVerifiedPools, [POOL]);
  assert.ok(result.assessment.risks.some(r => r.code === 'HOLDER_TOP1_CONCENTRATION'));
  assert.equal(result.assessment.linkedInsidersPct, null);
  assert.equal(result.assessment.bundledSupplyPct, null);
  assert.equal(Object.hasOwn(result.snapshot.holders, 'linkedInsidersPct'), false);
});

test('a transient view aggregator verifies every holder above six within two read-only batches', async () => {
  const balances = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [address(i + 10), 125n]));
  const logs = Object.keys(balances).map((a, i) => transfer(ZERO, a, 125n, 10, i));
  const f = fixture({ logs, balances }); const result = await run(f);
  assert.equal(result.assessment.coverage.transferHistoryComplete, true);
  assert.equal(result.assessment.coverage.distributionComplete, true);
  assert.equal(result.snapshot.holders.count, 8);
  assert.equal(result.evidence.balanceReadCount, 8);
  assert.equal(result.evidence.aggregateBalanceVerification.accountCount, 8);
  assert.equal(result.evidence.balances.length, 5);
  assert.ok(f.calls.every(batch => batch.length <= 8));
});

test('200 and 1000 holders can satisfy the population count without exceeding the RPC or evidence limits', async () => {
  for (const count of [200, 1000]) {
    const balances = Object.fromEntries(Array.from({ length: count }, (_, i) => [address(i + 100), 1000n]));
    const supply = BigInt(count) * 1000n;
    const state = { version: 1, address: TOKEN,
      origin: { kind: 'chain-genesis', blockNumber: 0, blockHash: blockHash(0), proven: true, genesisCodeAbsent: true },
      nextBlock: HEAD.number + 1, anchor: HEAD, balances: Object.entries(balances).map(([a, n]) => [a, n.toString()]),
      netSupplyRaw: supply.toString(), transfers: count, window: HEAD.number + 1 };
    const f = fixture({ balances, supply, logs: [], options: { state } });
    const result = await run(f);
    assert.equal(result.assessment.coverage.distributionComplete, true);
    assert.equal(result.snapshot.holders.count, count);
    assert.equal(f.rpc.requests, 2);
    assert.ok(f.calls.every(batch => batch.length <= 8));
    assert.ok(Buffer.byteLength(JSON.stringify(result.state)) <= 131072);
    assert.ok(Buffer.byteLength(JSON.stringify(result.evidence)) < 4096);
    assert.equal(result.evidence.aggregateBalanceVerification.accountCount, count);
    assert.equal(Object.hasOwn(result.snapshot.holders, 'linkedInsidersPct'), false);
  }
});

test('unsupported state overrides, occupied probe addresses or differing caller results do not approve a census', async () => {
  const balances = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [address(i + 10), 125n]));
  const logs = Object.keys(balances).map((a, i) => transfer(ZERO, a, 125n, 10, i));
  for (const changes of [{ aggregateError: -32602 }, { aggregateMismatch: true }, { probeCode: '0x6000' }, { missingBalance: address(10) }]) {
    const result = await run(fixture({ logs, balances, ...changes }));
    assert.equal(result.assessment.coverage.distributionComplete, false);
    assert.equal(result.snapshot.holders, undefined);
    assert.ok(result.assessment.gaps.includes('HOLDER_ALL_BALANCES_NOT_VERIFIED'));
    assert.ok(result.evidence.balanceReadCount <= 5);
    if (changes.aggregateMismatch) assert.ok(result.assessment.risks.some(risk => risk.code === 'HOLDER_BALANCE_CALLER_INCONSISTENT'));
    else assert.equal(result.assessment.risks.some(risk => risk.code === 'HOLDER_BALANCE_CALLER_INCONSISTENT'), false);
  }
});

test('a contract already present at genesis cannot claim complete initial balances from Transfer events', async () => {
  const f = fixture({ genesisCode: '0x6000' }); const result = await run(f);
  assert.equal(result.assessment.coverage.fromBlockProven, false);
  assert.equal(result.assessment.coverage.distributionComplete, false);
  assert.equal(result.snapshot.holders, undefined);
  assert.ok(result.assessment.gaps.includes('HOLDER_GENESIS_INITIAL_BALANCES_UNKNOWN'));
});

test('a partial range plus independently measured candidates only proves lower-bound risks', async () => {
  const f = fixture({ logs: [], options: { historyMode: 'partial', observedFromBlock: 500, candidateAddresses: [A, B, POOL] } });
  const result = await run(f);
  assert.equal(result.assessment.lowerBounds.top1Pct, 70);
  assert.equal(result.assessment.lowerBounds.top10Pct, 90);
  assert.equal(result.assessment.coverage.transferHistoryComplete, false);
  assert.equal(result.snapshot.holders, undefined);
  assert.ok(result.assessment.risks.some(r => r.code === 'HOLDER_TOP1_CONCENTRATION'));
});

test('mint, burn and self transfers reconcile exact balances without double-counting', async () => {
  const logs = [transfer(ZERO, A, 1000n, 10, 0), transfer(A, B, 300n, 20, 0), transfer(A, ZERO, 100n, 30, 0), transfer(A, A, 600n, 40, 0)];
  const f = fixture({ logs, balances: { [A]: 600n, [B]: 300n }, supply: 900n });
  const result = await run(f);
  assert.equal(result.state.netSupplyRaw, '900');
  assert.equal(result.assessment.coverage.distributionComplete, true);
  assert.equal(result.assessment.metrics.top1Pct, 66.666667);
  assert.equal(result.assessment.metrics.top10Pct, 100);
});

test('identical repeated log IDs are deduplicated but conflicting contents reject the whole range', async () => {
  const original = transfer(ZERO, A, 1000n);
  const dedup = await run(fixture({ logs: [original, original], balances: { [A]: 1000n } }));
  assert.equal(dedup.state.transfers, 1);
  assert.equal(dedup.assessment.coverage.distributionComplete, true);
  const bad = await run(fixture({ logs: [original, { ...original, data: transfer(ZERO, A, 999n).data }] }));
  assert.equal(bad.state.nextBlock, 0);
  assert.ok(bad.assessment.gaps.includes('HOLDER_CONFLICTING_TRANSFER'));
  assert.equal(bad.snapshot.holders, undefined);
});

test('wrong token, removed log, malformed indexed account and noncanonical endpoint do not advance the cursor', async () => {
  const valid = transfer(ZERO, A, 1000n, HEAD.number, 0);
  const changes = [{ address: address(50) }, { removed: true }, { topics: [TRANSFER, '0x' + '1'.repeat(64), topic(A)] }, { blockHash: blockHash(999) }];
  for (const change of changes) {
    const result = await run(fixture({ logs: [{ ...valid, ...change }], balances: { [A]: 1000n } }));
    assert.equal(result.state.nextBlock, 0);
    assert.equal(result.snapshot.holders, undefined);
    assert.ok(result.assessment.gaps.some(gap => /INVALID_TRANSFER|INCONSISTENT_TRANSFER_BLOCK/.test(gap)));
  }
});

test('unlogged supply changes and dishonest balanceOf outputs never produce exact distribution', async () => {
  for (const changes of [{ supply: 1001n }, { balances: { [A]: 699n, [B]: 200n, [POOL]: 100n } }, { missingBalance: B }]) {
    const result = await run(fixture(changes));
    assert.equal(result.assessment.coverage.distributionComplete, false);
    assert.equal(result.snapshot.holders, undefined);
  }
  const inconsistent = await run(fixture({ balances: { [A]: 900n, [B]: 200n, [POOL]: 100n } }));
  assert.ok(inconsistent.assessment.risks.some(r => r.code === 'BALANCE_SUPPLY_INCONSISTENT'));
});

test('a changed canonical endpoint rolls back rather than committing the tentative ledger', async () => {
  const f = fixture({ header: (n, batch) => batch === 2 && n === HEAD.number ? { hash: blockHash(2000) } : {} });
  const result = await run(f);
  assert.equal(result.state.nextBlock, 0);
  assert.deepEqual(result.state.balances, []);
  assert.ok(result.assessment.gaps.includes('HOLDER_RANGE_CONFIRMATION_UNAVAILABLE'));
  assert.equal(result.snapshot.holders, undefined);
});

test('a persisted anchor reorg discards old balances before reading any new transfers', async () => {
  const first = await run(fixture());
  const nextHead = { number: 1200, timestamp: HEAD.timestamp + 200, hash: blockHash(1200) };
  const f = fixture({ head: nextHead, header: n => n === HEAD.number ? { hash: blockHash(3000) } : {}, options: { state: first.state } });
  const result = await run(f);
  assert.equal(result.state.nextBlock, 0);
  assert.equal(result.state.transfers, 0);
  assert.ok(result.assessment.gaps.includes('HOLDER_REORG_RESTARTED'));
  assert.equal(f.rpc.requests, 1);
});

test('dense ranges shrink and capacity limits preserve cursors without truncating balances', async () => {
  const dense = await run(fixture({ options: { maxLogs: 2 } }));
  assert.equal(dense.state.nextBlock, 0);
  assert.equal(dense.state.window, 500);
  assert.ok(dense.assessment.gaps.includes('HOLDER_RANGE_SHRUNK'));
  const capacity = await run(fixture({ options: { maxAddresses: 2 } }));
  assert.equal(capacity.state.nextBlock, 0);
  assert.deepEqual(capacity.state.balances, []);
  assert.ok(capacity.assessment.gaps.includes('HOLDER_LEDGER_CAPACITY_REACHED'));
  assert.equal(capacity.assessment.coverage.distributionComplete, false);
});

test('incremental windows remain contiguous and publish no exact totals before reaching the head', async () => {
  let state;
  for (let step = 0; step < 3; step++) {
    const f = fixture({ options: { maxBlocks: 400, state } });
    const result = await run(f); state = result.state;
    assert.equal(f.rpc.requests, 2);
    assert.equal(state.nextBlock, step < 2 ? (step + 1) * 400 : HEAD.number + 1);
    assert.equal(result.assessment.coverage.distributionComplete, step === 2);
    if (step < 2) assert.equal(result.snapshot.holders, undefined);
  }
});

test('budget guard reserves both holder calls and never consumes the collector final calls', async () => {
  const skipped = fixture({ requests: 29 }); const result = await run(skipped);
  assert.equal(skipped.rpc.requests, 29);
  assert.ok(result.assessment.gaps.includes('HOLDER_RPC_BUDGET_DEFERRED'));
  const allowed = fixture({ requests: 28 }); await run(allowed);
  assert.equal(allowed.rpc.requests, 30);
});

test('saved state is validated, bounded and cannot smuggle duplicate accounts or arbitrary metadata', async () => {
  const prior = await run(fixture());
  const badState = { ...prior.state, balances: [[A, '700'], [A, '700']], secret: 'untrusted-persisted-field' };
  const result = await run(fixture({ options: { state: badState } }));
  assert.ok(result.assessment.gaps.includes('HOLDER_SAVED_STATE_REJECTED'));
  assert.equal(result.state.secret, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result.state)) <= 16384);
  const unavailable = await run(fixture({ throws: true }));
  assert.equal(JSON.stringify(unavailable).includes('private-url-and-secret'), false);
});
