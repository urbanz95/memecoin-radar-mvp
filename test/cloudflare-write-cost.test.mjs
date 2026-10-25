import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createWriteBatch } from '../src/cloudflare/write-cost.mjs';
import { collectFree } from '../src/cloudflare/collector.mjs';
import { setup } from './helpers/mvp-sqlite.mjs';

const measurement = rows => ({ meta: { rows_written: rows } });

test('D1 cost groups preserve one batch and exact statement order, including repeated groups', () => {
  const batch = createWriteBatch();
  const commands = [{ sql: 'fence' }, { sql: 'wallet' }, { sql: 'insert pool' }, { sql: 'update pool' }];
  batch.append('fencing', commands.slice(0, 1));
  batch.append('wallets', commands.slice(1, 2));
  batch.append('catalog', commands.slice(2, 3));
  batch.append('outbox', []);
  batch.append('catalog', commands.slice(3));
  assert.deepEqual(batch.commands, commands);
  assert.ok(batch.commands.every((command, index) => command === commands[index]));
  assert.deepEqual(batch.measure([2, 11, 5, 3].map(measurement)), {
    totalRowsWritten: 21,
    rowsWrittenByGroup: { fencing: 2, wallets: 11, catalog: 8, outbox: 0 },
  });
});

test('missing or invalid D1 metadata remains unknown without discarding measured groups', () => {
  for (const invalid of [undefined, null, -1, 1.5, '2', NaN, Infinity]) {
    const batch = createWriteBatch();
    batch.append('wallets', [{}, {}]);
    batch.append('outcomes', [{}]);
    batch.append('outbox', []);
    assert.deepEqual(batch.measure([measurement(4), measurement(invalid), measurement(0)]), {
      totalRowsWritten: null,
      rowsWrittenByGroup: { wallets: null, outcomes: 0, outbox: 0 },
    });
  }
});

test('a mismatched D1 response cannot associate measurements with the wrong statement groups', () => {
  const batch = createWriteBatch();
  batch.append('wallets', [{}]);
  batch.append('outcomes', [{}]);
  for (const results of [undefined, {}, [], [measurement(2)], [measurement(2), measurement(3), measurement(4)]]) {
    assert.deepEqual(batch.measure(results), {
      totalRowsWritten: null,
      rowsWrittenByGroup: { wallets: null, outcomes: null },
    });
  }
});

test('D1 cost aggregation keeps zero writes distinct from unknown and refuses unsafe totals', () => {
  const batch = createWriteBatch();
  batch.append('wallets', [{}, {}]);
  assert.deepEqual(batch.measure([measurement(0), measurement(0)]), {
    totalRowsWritten: 0, rowsWrittenByGroup: { wallets: 0 },
  });
  assert.deepEqual(batch.measure([measurement(Number.MAX_SAFE_INTEGER), measurement(1)]), {
    totalRowsWritten: null, rowsWrittenByGroup: { wallets: null },
  });
});

test('the real collector commits once and returns the sum of its measured command groups', async t => {
  const DB = setup(t, { migrate: false });
  const directory = new URL('../cloudflare/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name) && !name.startsWith('0001_')).sort())
    DB.sqlite.exec(await readFile(new URL(name, directory), 'utf8'));
  const originalBatch = DB.batch.bind(DB);
  let batches = 0;
  let statements = 0;
  DB.batch = async commands => {
    batches++;
    statements = commands.length;
    const results = await originalBatch(commands);
    // Distinct fixture measurements detect misplaced or omitted group ranges.
    return results.map((result, index) => ({ ...result, meta: { ...result.meta, rows_written: index + 1 } }));
  };
  const at = Date.now() + 5000;
  const head = { number: 1000, timestamp: Math.floor(at / 1000), hash: '0x' + '1'.repeat(64) };
  const rpc = { audit: [], async block() { return head; }, async request(method) {
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getLogs') return [];
    throw Error('unexpected-rpc');
  } };
  const result = await collectFree({ DB, MVP_RECORDING_ENABLED: '1', MVP_PHASE: '3', ANALYSIS_ENABLED: '1' },
    { now: () => at, rpc, fetchImpl: async () => Response.json({}, { status: 404 }) });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(batches, 1);
  assert.equal(DB.sqlite.prepare('SELECT status FROM control WHERE id=1').get().status, 'COMPLETED');
  assert.equal(result.d1RowsWritten, statements * (statements + 1) / 2);
  assert.equal(Object.values(result.d1WriteBreakdown).reduce((sum, value) => sum + value, 0), result.d1RowsWritten);
  assert.equal(result.d1WriteBreakdown.fencing, 1);
  assert.equal(result.d1WriteBreakdown.control, statements);
  assert.equal(result.d1WriteBreakdown.wallets, 0);
  assert.equal(result.d1WriteBreakdown.outbox, 0);
});
