import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionResult, encodeErrorResult } from 'viem';
import { simulateTrade, SIMULATOR_ABI, SIMULATOR_RUNTIME } from '../src/cloudflare/trade-simulation.mjs';
import { hex } from '../src/cloudflare/rpc.mjs';
import { QUOTE_ASSETS } from '../src/network.mjs';

const address = digit => '0x' + digit.repeat(40);
const POOL = { type: 'v2', address: address('1'), factory: '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f',
  token0: QUOTE_ASSETS.WETH, token1: address('2') };
const HEAD = { number: 1000, hash: '0x' + 'a'.repeat(64), timestamp: 1792670400 };
const AMOUNT = 10n ** 15n;
const PROBE = address('3'); const CALLER = address('4');
const encoded = changes => encodeFunctionResult({ abi: SIMULATOR_ABI, functionName: 'run', result: {
  stage: 3n, quoteIn: AMOUNT, buyExpected: 100000n, buyReceived: 98000n,
  sellTransferred: 96200n, sellExpected: 970000000000000n, quoteReceived: 970000000000000n,
  revertData: '0x', ...changes,
} });
const error = message => encodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'message' }] }], errorName: 'Error', args: [message] });
function fixture(changes = {}) {
  const calls = [];
  const rpc = { requests: changes.initialRequests ?? 0, async batch(batch) {
    this.requests++; calls.push(batch);
    if (changes.throw) throw new Error('private-url-and-key');
    if (batch[0][0] === 'eth_getCode') return [
      { value: changes.probeCode ?? '0x' }, { value: '0x' },
      { value: { number: hex(HEAD.number), hash: HEAD.hash, timestamp: hex(HEAD.timestamp), ...changes.canonical } },
    ];
    assert.equal(batch.length, 1); assert.equal(batch[0][0], 'eth_call');
    const [tx, block, overrides] = batch[0][1];
    assert.equal(tx.from, CALLER); assert.equal(tx.to, PROBE); assert.equal(block, hex(HEAD.number));
    assert.equal(overrides[PROBE].code, SIMULATOR_RUNTIME);
    assert.equal(overrides[PROBE].balance, hex(AMOUNT));
    assert.deepEqual(Object.keys(overrides).sort(), [PROBE, CALLER].sort());
    const decoded = decodeFunctionData({ abi: SIMULATOR_ABI, data: tx.data });
    assert.equal(decoded.functionName, 'run');
    assert.equal(decoded.args[0].toLowerCase(), POOL.address);
    assert.equal(decoded.args[1].toLowerCase(), POOL.token1);
    assert.equal(decoded.args[2].toLowerCase(), QUOTE_ASSETS.WETH);
    assert.equal(decoded.args[4], AMOUNT);
    return [changes.response ?? { value: encoded(changes.result) }];
  } };
  return { rpc, calls, options: { identityVerified: true, probeAddress: PROBE, callerAddress: CALLER,
    now: () => HEAD.timestamp * 1000, ...changes.options } };
}

test('single eth_call performs a bounded transient roundtrip; success never approves a token or USD100', async () => {
  const f = fixture(); const result = await simulateTrade(f.rpc, POOL, HEAD, f.options);
  assert.equal(f.rpc.requests, 2);
  assert.ok(f.calls.flat().every(([method]) => ['eth_getCode', 'eth_getBlockByNumber', 'eth_call'].includes(method)));
  assert.equal(result.assessment.status, 'passed');
  assert.equal(result.assessment.buySucceeded, true); assert.equal(result.assessment.sellSucceeded, true);
  assert.equal(result.assessment.executionVerified, true);
  assert.equal(result.assessment.canonicalConfirmedBeforeExecution, true);
  assert.equal(result.assessment.notionalUsd, null); assert.equal(result.assessment.amountUsdVerified, false);
  assert.equal(result.assessment.approvesTrade, false);
  assert.equal(result.assessment.buy.observedTransferTaxPct, 2);
  assert.ok(result.assessment.sell.observedTransferTaxPct > 1.83);
  assert.equal(result.assessment.roundtripLossPct, 3);
  assert.deepEqual(Object.keys(result.snapshot.security).sort(), ['buyTaxPct', 'sellTaxPct']);
  assert.deepEqual(result.assessment.risks.map(value => value.code), ['OBSERVED_BUY_TRANSFER_FEE', 'OBSERVED_SELL_TRANSFER_FEE']);
  assert.equal(result.evidence.statePersistence, 'none'); assert.equal(result.evidence.readOnly, true);
  assert.ok(!Object.hasOwn(result.snapshot, 'quote'));
});

test('zero observed fees do not fill absence-of-fees or absence-of-honeypot policy fields', async () => {
  const f = fixture({ result: { buyReceived: 100000n, sellTransferred: 100000n } });
  const result = await simulateTrade(f.rpc, POOL, HEAD, f.options);
  assert.equal(result.assessment.status, 'passed');
  assert.equal(result.assessment.buy.observedTransferTaxPct, 0);
  assert.deepEqual(result.snapshot, {});
});

test('a positive sub-micropercent transfer fee cannot round down to a passing zero', async () => {
  const f = fixture({ result: { buyExpected: 10n ** 30n, buyReceived: 10n ** 30n - 1n, sellTransferred: 10n ** 30n - 1n } });
  const result = await simulateTrade(f.rpc, POOL, HEAD, f.options);
  assert.equal(result.snapshot.security.buyTaxPct, 0.000001);
});

test('reverted buy or sell has distinct stage evidence, with buy output preserved only after a successful buy', async () => {
  for (const stage of [1n, 2n]) {
    const f = fixture({ result: { stage, ...(stage === 1n ? { buyExpected: 0n, buyReceived: 0n } : {}),
      sellTransferred: 0n, sellExpected: 0n, quoteReceived: 0n, revertData: error('TRANSFER_FAILED') } });
    const result = await simulateTrade(f.rpc, POOL, HEAD, f.options);
    assert.equal(result.assessment.status, 'failed');
    assert.equal(result.assessment.stage, stage === 1n ? 'buy' : 'sell');
    assert.equal(result.assessment.buySucceeded, stage === 2n);
    assert.equal(result.assessment.sellSucceeded, false);
    assert.equal(result.assessment.revertReason, 'TRANSFER_FAILED');
    assert.ok(result.assessment.risks.some(value => value.code === 'OBSERVED_TRADE_FAILURE'));
    assert.equal(result.assessment.buy.receivedTokenRaw, stage === 1n ? null : '98000');
    assert.ok(!Object.hasOwn(result.snapshot.security ?? {}, 'honeypotDetected'));
  }
});

test('dust errors are unavailable evidence rather than a generic honeypot accusation', async () => {
  const f = fixture({ result: { stage: 1n, buyExpected: 0n, buyReceived: 0n, sellTransferred: 0n,
    sellExpected: 0n, quoteReceived: 0n, revertData: error('DUST_BUY') } });
  const result = await simulateTrade(f.rpc, POOL, HEAD, f.options);
  assert.equal(result.assessment.status, 'unavailable'); assert.equal(result.assessment.reason, 'PROBE_AMOUNT_DUST');
  assert.ok(!result.assessment.risks.some(value => value.code === 'OBSERVED_TRADE_FAILURE'));
  assert.deepEqual(result.snapshot, {});
});

test('malformed, contradictory and oversized outputs never become execution or approval evidence', async () => {
  for (const response of [{ error: -32602 }, { value: '0x1234' }, { value: '0x' + 'ab'.repeat(3000) },
    { value: encoded({ stage: 0n }) }, { value: encoded({ quoteIn: AMOUNT + 1n }) },
    { value: encoded({ stage: 1n }) }, { value: encoded({ stage: 2n }) },
    { value: encoded({ buyExpected: 0n }) }, { value: encoded({ quoteReceived: 1n }) },
    { value: encoded({ revertData: error('unexpected') }) }]) {
    const f = fixture({ response }); const result = await simulateTrade(f.rpc, POOL, HEAD, f.options);
    assert.equal(result.assessment.status, 'unavailable');
    assert.equal(result.assessment.executionVerified, false);
    assert.equal(result.assessment.buySucceeded, null); assert.equal(result.assessment.sellSucceeded, null);
    assert.deepEqual(result.snapshot, {});
  }
});

test('unknown protocols, quote assets, identity and unsafe addresses cannot trigger a call', async () => {
  for (const [pool, options] of [
    [{ ...POOL, type: 'v3' }, {}], [{ ...POOL, type: 'v4' }, {}], [POOL, { identityVerified: false }],
    [{ ...POOL, factory: address('8') }, {}], [{ ...POOL, token0: QUOTE_ASSETS.USDG }, {}],
    [POOL, { probeAddress: POOL.address }], [POOL, { callerAddress: PROBE }],
    [POOL, { probeAmountWei: 0n }], [POOL, { probeAmountWei: 10n ** 18n + 1n }],
  ]) {
    const f = fixture(); const result = await simulateTrade(f.rpc, pool, HEAD, { ...f.options, ...options });
    assert.equal(result.assessment.status, 'unavailable'); assert.equal(f.rpc.requests, 0);
  }
});

test('old/future heads and canonical mismatches cannot be labelled execution-verified', async () => {
  for (const timestamp of [HEAD.timestamp - 61, HEAD.timestamp + 31]) {
    const f = fixture(); const result = await simulateTrade(f.rpc, POOL, { ...HEAD, timestamp }, f.options);
    assert.equal(result.assessment.reason, 'SIMULATION_HEAD_NOT_FRESH'); assert.equal(f.rpc.requests, 0);
  }
  for (const canonical of [{ hash: '0x' + 'b'.repeat(64) }, { number: '0x1' }, { timestamp: '0x1' }]) {
    const f = fixture({ canonical }); const result = await simulateTrade(f.rpc, POOL, HEAD, f.options);
    assert.equal(result.assessment.reason, 'SIMULATION_BLOCK_UNCONFIRMED');
    assert.equal(f.rpc.requests, 1); assert.equal(result.assessment.attempted, false);
  }
});

test('RPC budget reserves both reads and collision checks prevent replacement of existing code', async () => {
  const deferred = fixture({ initialRequests: 29 });
  assert.equal((await simulateTrade(deferred.rpc, POOL, HEAD, deferred.options)).assessment.reason, 'SIMULATION_RPC_BUDGET_DEFERRED');
  assert.equal(deferred.rpc.requests, 29);
  const allowed = fixture({ initialRequests: 28 });
  assert.equal((await simulateTrade(allowed.rpc, POOL, HEAD, allowed.options)).assessment.status, 'passed');
  assert.equal(allowed.rpc.requests, 30);
  const collision = fixture({ probeCode: '0x6000' });
  assert.equal((await simulateTrade(collision.rpc, POOL, HEAD, collision.options)).assessment.reason, 'PROBE_ADDRESS_NOT_EMPTY');
  assert.equal(collision.rpc.requests, 1);
});

test('transport failures remain unavailable and do not expose private RPC diagnostics', async () => {
  const f = fixture({ throw: true }); const result = await simulateTrade(f.rpc, POOL, HEAD, f.options);
  assert.equal(result.assessment.status, 'unavailable'); assert.equal(result.assessment.reason, 'SIMULATION_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('private-url-and-key'), false);
});
