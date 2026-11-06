import test from 'node:test';
import assert from 'node:assert/strict';
import { PriorityScheduler, PRIORITY_CYCLE } from '../src/enrichment-priority.mjs';

test('continuously backlogged priorities receive their documented 4:2:1:1 rotation', () => {
  const scheduler = new PriorityScheduler();
  const buckets = Array.from({ length: 4 }, (_, priority) =>
    Array.from({ length: 32 }, (_, index) => ({
      contextPriority: priority,
      signature: `p${priority}-${index}`,
    })));
  const blocked = new Set();
  const observed = [];
  for (let i = 0; i < 16; i++) {
    const selected = scheduler.select(buckets, 1, blocked);
    assert.equal(selected.length, 1);
    observed.push(selected[0].contextPriority);
    blocked.add(selected[0].signature);
  }
  assert.deepEqual(observed, [...PRIORITY_CYCLE, ...PRIORITY_CYCLE]);
  assert.deepEqual(
    Array.from({ length: 4 }, (_, priority) =>
      observed.filter(value => value === priority).length),
    [8, 4, 2, 2],
  );
  assert.equal(scheduler.position, 0);
});
