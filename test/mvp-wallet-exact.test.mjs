import test from 'node:test';
import assert from 'node:assert/strict';
import { exactFraction, exactRational, exactTotal, exactComponents, exactCashAdd, exactPositionAdd,
  exactComponentsAdd, EXACT_INTEGER_BITS, EXACT_POSITION_LIMIT } from '../src/mvp/wallet-exact.mjs';
import limits, { validateWalletAccountingLimits } from '../src/mvp/wallet-accounting-config.mjs';

test('accounting resource configuration is centralized and rejects unknown or Free-plan-unsafe limits', () => {
  assert.deepEqual(validateWalletAccountingLimits(limits), limits);
  for (const invalid of [{ ...limits, exactIntegerBits: 32768 }, { ...limits, stateMaxBytes: 65536 },
    { ...limits, openLots: 129 }, { ...limits, realizationMaxBytes: 65536 }, { ...limits, exactPositionComponents: 0 }, { ...limits, extra: true },
    { ...limits, schemaVersion: 2 }])
    assert.throws(() => validateWalletAccountingLimits(invalid), /INVALID_RESOURCE_CONFIG/);
});

test('exact position components preserve non-decimal allocations and fold only exact decimal sums', () => {
  let state = exactPositionAdd(exactCashAdd(exactComponents(), exactFraction(2n)), 'p:1', exactFraction(-1n, 3n));
  assert.deepEqual(exactTotal(state), { n: 5n, d: 3n });
  assert.deepEqual(state.positions['p:1'], { n: '-1', d: '3' });
  state = exactPositionAdd(state, 'p:1', exactFraction(-2n, 3n));
  assert.deepEqual(state, { n: '1', d: '1', positions: {} });
});

test('exact precision budget is explicit and independent of component memory/count', () => {
  const unsupported = { n: (1n << BigInt(EXACT_INTEGER_BITS)).toString(), d: '1' };
  assert.throws(() => exactRational(unsupported), /EXACT_PRECISION_BUDGET_EXCEEDED/);
  const reducible = { n: '1' + '0'.repeat(500), d: '1' + '0'.repeat(500) };
  assert.deepEqual(exactRational(reducible), { n: 1n, d: 1n });
  const positions = Object.fromEntries(Array.from({ length: EXACT_POSITION_LIMIT + 1 }, (_, i) => [`p:${i + 1}`, { n: '1', d: '3' }]));
  assert.throws(() => exactComponents({ n: '0', d: '1', positions }), /POSITION_CAPACITY_EXCEEDED/);
});

test('invalid components and zero denominators fail closed without mutating the checkpoint', () => {
  const source = { n: '1', d: '2', positions: { 'p:1': { n: '-1', d: '3' } } };
  const original = structuredClone(source);
  assert.throws(() => exactPositionAdd(source, '__proto__', exactFraction(1n)), /INVALID_EXACT_POSITION/);
  assert.throws(() => exactComponentsAdd(source, { n: '1', d: '0' }), /INVALID_FRACTION/);
  assert.deepEqual(source, original);
  assert.deepEqual(exactComponentsAdd(source, source), { n: '1', d: '1', positions: { 'p:1': { n: '-2', d: '3' } } });
});
