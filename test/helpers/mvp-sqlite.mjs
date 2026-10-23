import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
export const legacySchema = await readFile(new URL('../../cloudflare/migrations/0001_collector.sql', import.meta.url), 'utf8');
export const mvpSchema = await readFile(new URL('../../cloudflare/migrations/0002_mvp_records.sql', import.meta.url), 'utf8');
export const TOKEN = n => '0x' + n.toString(16).padStart(40, '0');
export const time = Date.parse('2026-10-23T12:00:00.000Z');
export const version = 'mvp-score-v1';
export const profile = 'CORE';
export const policyHash = 'sha256:' + 'ab'.repeat(32);
export class MvpSqliteD1 {
  constructor({ migrate = true } = {}) {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys=ON');
    this.sqlite.exec(legacySchema);
    if (migrate) this.sqlite.exec(mvpSchema);
  }
  prepare(sql) {
    const sqlite = this.sqlite; let values = [];
    return {
      bind(...arguments_) { values = arguments_; return this; },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { return { success: true, results: sqlite.prepare(sql).all(...values) }; },
      async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const result = []; for (const statement of statements) result.push(await statement.run()); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
export function setup(t, options) { const DB = new MvpSqliteD1(options); t.after(() => DB.sqlite.close()); return DB; }
export function decision(address = TOKEN(1), changes = {}) {
  return { address, status: 'REJECTED', scoreVersion: version, profile, policyHash, isLaunch: true,
    features: { observedAt: new Date(time).toISOString(), externalMarket: { priceUsd: 2, liquidityUsd: 100,
      fetchedAt: new Date(time).toISOString(), source: 'dexscreener', trust: 'provider-reported' } }, ...changes };
}
