import test from 'node:test';
import assert from 'node:assert/strict';
import { priorityScore, screeningHistory } from '../src/cloudflare/screening.mjs';

const address = n => '0x' + n.toString(16).padStart(40, '0');
const now = Date.parse('2026-10-22T12:00:00Z');
test('prioridade depende de métricas publicadas e nunca preenche métricas desconhecidas', () => {
  assert.equal(priorityScore(null, 'new'), null);
  assert.equal(priorityScore({ liquidityUsd: 250000, volume5mUsd: 25000 }, 'new'), null);
  assert.equal(priorityScore({ liquidityUsd: 250000, volume5mUsd: 25000, priceChange5mPct: 10 }, 'unclassified'), null);
  assert.equal(priorityScore({ liquidityUsd: 250000, volume5mUsd: 25000, priceChange5mPct: 10 }, 'new'), 100);
  assert.equal(priorityScore({ liquidityUsd: 750000, volume24hUsd: 500000, priceChange1hPct: 10 }, 'established'), 100);
  assert.equal(priorityScore({ liquidityUsd: 250000, volume5mUsd: 25000, priceChange5mPct: 200 }, 'new'), 75);
});

test('histórico deduplica contrato, conserva validações reais e limita o catálogo visível', () => {
  const prior = Array.from({ length: 30 }, (_, i) => ({ address: address(i + 1), observedAt: new Date(now - i * 60000).toISOString(), poolId: `pool-${i}` }));
  const entry = { address: address(1), poolId: 'new-pool', observedAt: new Date(now).toISOString(), status: 'REVIEW' };
  const result = screeningHistory(prior, entry, [{ address: entry.address, pipeline: 'new', status: 'BLOCKED' },
    { address: entry.address, pipeline: 'established', status: 'INCOMPLETE' }], now);
  assert.equal(result.length, 20);
  assert.equal(result.filter(item => item.address === entry.address).length, 1);
  assert.equal(result[0].poolId, 'new-pool');
  assert.deepEqual(result[0].strict, { new: 'BLOCKED', established: 'INCOMPLETE' });
});

test('observações expiradas e entradas inválidas são removidas; tamanho em bytes permanece limitado', () => {
  const prior = [{ address: address(1), observedAt: new Date(now - 7 * 3600000).toISOString() },
    { address: 'bad-address', observedAt: new Date(now).toISOString() },
    ...Array.from({ length: 20 }, (_, i) => ({ address: address(i + 2), observedAt: new Date(now - i * 1000).toISOString(), notes: 'x'.repeat(5000) }))];
  const result = screeningHistory(prior, null, [], now);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
  assert.ok(result.length > 0 && result.length < 20);
  assert.ok(!result.some(item => item.address === address(1) || item.address === 'bad-address'));
});
