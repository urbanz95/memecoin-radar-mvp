import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { collectFree } from '../src/cloudflare/collector.mjs';
import { setup, TOKEN } from './helpers/mvp-sqlite.mjs';

async function fixture(t, failHistory = false) {
  const DB = setup(t, { migrate: false });
  const directory = new URL('../cloudflare/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name) && !name.startsWith('0001_')).sort())
    DB.sqlite.exec(await readFile(new URL(name, directory), 'utf8'));
  const at = Date.now() + 5000;
  DB.sqlite.prepare(`INSERT INTO mvp_wallet_profiles(chain_id,wallet_address,generation,checked_at,eligible,profile_json)
    VALUES(4663,?,0,?,0,'{}')`).run(TOKEN(10), at);
  const headNumber = 50000000;
  const block = number => ({ number, timestamp: Math.floor(at / 1000) - Math.floor((headNumber - number) / 10),
    hash: '0x' + BigInt(number + 1).toString(16).padStart(64, '0') });
  const rpc = { requests: 0, audit: [],
    async request(method, params = []) {
      this.requests++;
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getLogs') return [];
      if (method === 'eth_getBlockByNumber') {
        const number = params[0] === 'latest' ? headNumber : Number(BigInt(params[0]));
        if (failHistory && number !== headNumber && number !== headNumber - 10000) throw Error('RPC_REMOTE_ERROR');
        const b = block(number);
        return { number: '0x' + number.toString(16), timestamp: '0x' + b.timestamp.toString(16), hash: b.hash };
      }
      throw Error('UNEXPECTED_RPC');
    },
    async block(number = 'latest') {
      const b = await this.request('eth_getBlockByNumber', [number === 'latest' ? number : '0x' + number.toString(16), false]);
      return { number: Number(BigInt(b.number)), timestamp: Number(BigInt(b.timestamp)), hash: b.hash };
    },
  };
  const collect = () => collectFree({ DB, MVP_RECORDING_ENABLED: '1', MVP_PHASE: '3', ANALYSIS_ENABLED: '1',
    WALLET_BACKFILL_ENABLED: '1' }, { now: () => at, rpc,
    fetchImpl: async () => Response.json({}, { status: 404 }) });
  return { DB, rpc, collect };
}

test('the collector commits a real fixed-window backfill checkpoint within its existing shared budget and batch', async t => {
  const f = await fixture(t);
  assert.equal((await f.collect()).status, 'COMPLETED');
  const rows = f.DB.sqlite.prepare('SELECT * FROM mvp_wallet_backfill_jobs').all();
  assert.equal(rows.length, 1);
  const job = JSON.parse(rows[0].job_json);
  assert.equal(job.endAt - job.startAt, 30 * 86400000);
  assert.equal(rows[0].state, 'BOUNDARY');
  const report = JSON.parse(f.DB.sqlite.prepare('SELECT report_json FROM runs').get().report_json);
  assert.equal(report.mvp.walletCollection.backfill.requests, 4);
  assert.equal(report.mvp.walletCollection.historyWindows[0].complete, false);
  assert.ok(f.rpc.requests <= 32);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM mvp_alert_outbox').get().n, 0);
});

test('an unavailable historical header retries backfill while the normal collector still commits', async t => {
  const f = await fixture(t, true);
  assert.equal((await f.collect()).status, 'COMPLETED');
  assert.equal(f.DB.sqlite.prepare('SELECT state FROM mvp_wallet_backfill_jobs').get().state, 'RETRY');
  assert.equal(f.DB.sqlite.prepare('SELECT status FROM control WHERE id=1').get().status, 'COMPLETED');
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM runs').get().n, 1);
});
