import test from 'node:test';
import assert from 'node:assert/strict';
import { PriorityScheduler } from '../src/enrichment-priority.mjs';

const item = (priority, signature) => ({ contextPriority: priority, signature });

test('sparse buckets do not stall scheduling or starve a populated lower tier', () => {
  const scheduler = new PriorityScheduler();
  const buckets = [
    Array.from({ length: 12 }, (_, n) => item(0, `p0-${n}`)),
    [],
    [],
    Array.from({ length: 12 }, (_, n) => item(3, `p3-${n}`)),
  ];
  const blocked = new Set();
  const selected = [];
  for (let n = 0; n < 12; n++) {
    const next = scheduler.select(buckets, 1, blocked);
    assert.equal(next.length, 1);
    selected.push(next[0]);
    blocked.add(next[0].signature);
  }
  assert.ok(selected.some(x => x.contextPriority === 3));
  assert.equal(new Set(selected.map(x => x.signature)).size, selected.length);
});

test('duplicate signatures across priority buckets are selected only once', () => {
  const scheduler = new PriorityScheduler();
  const selected = scheduler.select([
    [item(0, 'shared'), item(0, 'p0')],
    [item(1, 'shared'), item(1, 'p1')],
    [],
    [item(3, 'shared'), item(3, 'p3')],
  ], 20);
  assert.deepEqual(new Set(selected.map(x => x.signature)),
    new Set(['shared', 'p0', 'p1', 'p3']));
  assert.equal(selected.length, 4);
});

test('empty and zero-capacity selection is inert and invalid inputs fail closed', () => {
  const scheduler = new PriorityScheduler();
  const buckets = [[item(0, 'p0')], [], [], []];
  assert.deepEqual(scheduler.select(buckets, 0), []);
  assert.equal(scheduler.position, 0);
  assert.deepEqual(scheduler.select([[], [], [], []], 4), []);
  assert.equal(scheduler.position, 0);
  for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => scheduler.select(buckets, invalid), /INVALID_PRIORITY_CAPACITY/);
  assert.throws(() => scheduler.select([[], []], 1), /INVALID_PRIORITY_BUCKETS/);
});
