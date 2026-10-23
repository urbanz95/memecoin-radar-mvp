import assert from 'node:assert/strict';
import test from 'node:test';
import { activateCloudflare } from '../scripts/activate-cloudflare.mjs';

const account = 'a'.repeat(32);
const otherAccount = 'b'.repeat(32);
const databaseId = '11111111-2222-3333-4444-555555555555';
const placeholder = '00000000-0000-0000-0000-000000000000';
const config = () => ({
  name: 'memecoin-radar-collector',
  vars: { LOG_CHUNK: '2048' },
  d1_databases: [{ binding: 'DB', database_name: 'memecoin-radar', database_id: placeholder }],
});
const json = value => ({ status: 0, stdout: JSON.stringify(value) });
const success = { status: 0, stdout: '' };
const user = accounts => json({ loggedIn: true, email: 'private@example.invalid', accounts: accounts.map(id => ({ id })) });
const databaseList = () => json([{ name: 'memecoin-radar', uuid: databaseId }]);

function harness({ responses = [user([account])], env = {}, stored = config(), check = false } = {}) {
  const calls = [];
  const output = [];
  const writes = [];
  const execute = () => activateCloudflare({
    check,
    env,
    run: async (args, selectedEnv) => {
      calls.push({ args, env: selectedEnv });
      assert.ok(responses.length, 'Unexpected Wrangler operation');
      return responses.shift();
    },
    readConfig: async () => structuredClone(stored),
    writeConfig: async updated => writes.push(updated),
    report: line => output.push(line),
  });
  return { execute, calls, output, writes };
}

test('--check without authentication only reports AUTH_REQUIRED', async () => {
  const h = harness({ check: true, responses: [{ status: 1, stdout: '', stderr: 'secret-token private@example.invalid' }] });
  assert.equal(await h.execute(), 1);
  assert.deepEqual(h.output, ['AUTH_REQUIRED']);
  assert.deepEqual(h.calls.map(call => call.args), [['whoami', '--json']]);
  assert.equal(h.writes.length, 0);
});

test('--check requires an explicit account when there are several', async () => {
  const h = harness({ check: true, responses: [user([account, otherAccount])] });
  assert.equal(await h.execute(), 1);
  assert.deepEqual(h.output, ['ACCOUNT_REQUIRED']);
  assert.equal(h.calls.length, 1);
  assert.equal(h.writes.length, 0);
});

test('a saved account cannot silently change, even with an explicit different account', async () => {
  const stored = { ...config(), account_id: otherAccount };
  const h = harness({ stored, check: true, env: { CLOUDFLARE_ACCOUNT_ID: account, RADAR_CONFIRMED_FREE_PLAN: '1' } });
  assert.equal(await h.execute(), 1);
  assert.deepEqual(h.output, ['ACCOUNT_REQUIRED']);
  assert.equal(h.calls.length, 1);
});

test('a user-selected account must be visible in whoami', async () => {
  const h = harness({ check: true, env: { CLOUDFLARE_ACCOUNT_ID: otherAccount, RADAR_CONFIRMED_FREE_PLAN: '1' } });
  assert.equal(await h.execute(), 1);
  assert.deepEqual(h.output, ['ACCOUNT_REQUIRED']);
});

test('normal activation stops before D1 without prior Free confirmation', async () => {
  const h = harness();
  assert.equal(await h.execute(), 1);
  assert.deepEqual(h.output, ['FREE_PLAN_CONFIRMATION_REQUIRED']);
  assert.equal(h.calls.length, 1);
  assert.equal(h.writes.length, 0);
});

test('--check READY performs only whoami and does not change config', async () => {
  const h = harness({ check: true, env: { CLOUDFLARE_ACCOUNT_ID: otherAccount, RADAR_CONFIRMED_FREE_PLAN: '1' }, responses: [user([account, otherAccount])] });
  assert.equal(await h.execute(), 0);
  assert.deepEqual(h.output, ['READY']);
  assert.deepEqual(h.calls.map(call => call.args), [['whoami', '--json']]);
  assert.equal(h.writes.length, 0);
});

test('activation reuses the named database, pins account, migrates and deploys', async () => {
  const h = harness({
    env: { RADAR_CONFIRMED_FREE_PLAN: '1' },
    responses: [user([account]), databaseList(), success, { status: 0, stdout: 'private@example.invalid https://memecoin-radar-collector.example.workers.dev' }],
  });
  assert.equal(await h.execute(), 0);
  assert.deepEqual(h.calls.map(call => call.args), [
    ['whoami', '--json'], ['d1', 'list', '--json'],
    ['d1', 'migrations', 'apply', 'DB', '--remote'], ['deploy', '--strict'],
  ]);
  assert.ok(h.calls.slice(1).every(call => call.env.CLOUDFLARE_ACCOUNT_ID === account));
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].account_id, account);
  assert.equal(h.writes[0].d1_databases[0].database_id, databaseId);
  assert.deepEqual(h.writes[0].vars, config().vars);
  assert.deepEqual(h.output, ['D1_READY', 'CONFIG_READY', 'MIGRATIONS_APPLIED', 'DEPLOYED', 'https://memecoin-radar-collector.example.workers.dev']);
});

test('activation only creates a database when placeholder has no matching remote database', async () => {
  const h = harness({ env: { RADAR_CONFIRMED_FREE_PLAN: '1' }, responses: [user([account]), json([]), success, databaseList(), success, success] });
  assert.equal(await h.execute(), 0);
  assert.deepEqual(h.calls.map(call => call.args), [
    ['whoami', '--json'], ['d1', 'list', '--json'],
    ['d1', 'create', 'memecoin-radar', '--update-config=false'], ['d1', 'list', '--json'],
    ['d1', 'migrations', 'apply', 'DB', '--remote'], ['deploy', '--strict'],
  ]);
  assert.equal(h.writes[0].d1_databases[0].database_id, databaseId);
});

test('an existing matching account and database do not rewrite config', async () => {
  const stored = config();
  stored.account_id = account;
  stored.d1_databases[0].database_id = databaseId;
  const h = harness({ stored, env: { RADAR_CONFIRMED_FREE_PLAN: '1' }, responses: [user([account]), databaseList(), success, success] });
  assert.equal(await h.execute(), 0);
  assert.equal(h.writes.length, 0);
});

test('a missing configured database is never recreated', async () => {
  const stored = config();
  stored.d1_databases[0].database_id = databaseId;
  const h = harness({ stored, env: { RADAR_CONFIRMED_FREE_PLAN: '1' }, responses: [user([account]), json([])] });
  assert.equal(await h.execute(), 1);
  assert.deepEqual(h.output, ['D1_CONFIG_CONFLICT']);
  assert.equal(h.calls.length, 2);
  assert.equal(h.writes.length, 0);
});

test('migration failure prevents deployment and exposes no raw output', async () => {
  const h = harness({ env: { RADAR_CONFIRMED_FREE_PLAN: '1' }, responses: [user([account]), databaseList(), { status: 1, stdout: 'secret-token', stderr: 'private@example.invalid' }] });
  assert.equal(await h.execute(), 1);
  assert.deepEqual(h.output, ['D1_READY', 'CONFIG_READY', 'MIGRATIONS_FAILED']);
  assert.equal(h.calls.length, 3);
});
