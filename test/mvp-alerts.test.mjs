import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatDryRunAlert, prepareDryRunAlerts, getRecentDryRunAlerts, getDryRunAlertStats } from '../src/mvp/alerts.mjs';
import { setup, TOKEN, time } from './helpers/mvp-sqlite.mjs';

const schema = await readFile(new URL('../cloudflare/migrations/0003_mvp_outbox.sql', import.meta.url), 'utf8');
const poolId = '0x' + 'ab'.repeat(32);
function db(t) { const DB = setup(t); DB.sqlite.exec(schema); return DB; }
function eligible(changes = {}) {
  return { chainId: 4663, address: TOKEN(1), symbol: 'RADAR', status: 'PASS', profile: 'profile_new', direction: 'ENTRY',
    score: 88, scoreVersion: 'mvp-new-v1', scoreComplete: true, walletsComplete: true, securityComplete: true,
    reasons: ['Fluxo comprador confirmado', 'Carteiras de grupos independentes', 'Liquidez e verificações cumprem o perfil'],
    wallets: [{ address: TOKEN(10), score: 85, clusterId: 'independent-a', realizedTrades: 5, eligible: true },
      { address: TOKEN(11), score: 80, clusterId: 'independent-b', realizedTrades: 9, eligible: true }],
    riskFlags: [], chartUrl: `https://dexscreener.com/robinhood/${TOKEN(5)}`, synthetic: false,
    decisionId: 'canonical-decision-1', episodeId: 'entry-episode-1', observedAt: new Date(time).toISOString(), ...changes };
}

test('outbox migration is additive and repeatable without changing legacy tables or records counters', t => {
  const DB = setup(t);
  DB.sqlite.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run('legacy-alert', time, 100, '{"alerts":[{"type":"candidate"}]}', '{}');
  const oldRun = { ...DB.sqlite.prepare('SELECT * FROM runs').get() };
  const oldStats = { ...DB.sqlite.prepare('SELECT * FROM mvp_stats').get() };
  DB.sqlite.exec(schema); DB.sqlite.exec(schema);
  assert.deepEqual({ ...DB.sqlite.prepare('SELECT * FROM runs').get() }, oldRun);
  assert.deepEqual({ ...DB.sqlite.prepare('SELECT * FROM mvp_stats').get() }, oldStats);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_alert_outbox').get().n, 0);
});

test('formatter produces bounded plain Telegram text with the contract, score, three reasons, real scored wallets, flags and chart', () => {
  const result = formatDryRunAlert(eligible());
  assert.equal(result.dryRun, true); assert.equal(result.state, 'DRY_RUN'); assert.equal(result.minScore, 75);
  assert.match(result.text, /^\[NOVO\] RADAR\nDRY RUN · sem envio/);
  assert.ok(result.text.includes(TOKEN(1))); assert.ok(result.text.includes('Score: 88/100'));
  assert.equal(result.reasons.length, 3); assert.equal(result.wallets.length, 2);
  assert.ok(result.text.includes('5 trades realizados')); assert.ok(result.text.includes('independent-b'));
  assert.ok(result.text.includes('Flags reportadas: nenhuma'));
  assert.ok(result.text.includes(`Gráfico: https://dexscreener.com/robinhood/${TOKEN(5)}`));
  assert.ok(result.text.length <= 4096);
  assert.equal(Object.hasOwn(result, 'parse_mode'), false); assert.equal(Object.hasOwn(result, 'chat_id'), false);
});

test('chart links accept only canonical Robinhood DEX addresses or v4 pool IDs', () => {
  assert.equal(formatDryRunAlert(eligible({ chartUrl: `https://dexscreener.com/robinhood/${poolId}` })).chartUrl,
    `https://dexscreener.com/robinhood/${poolId}`);
  for (const chartUrl of ['https://evil.invalid/robinhood/' + TOKEN(5), 'http://dexscreener.com/robinhood/' + TOKEN(5),
    'https://dexscreener.com/ethereum/' + TOKEN(5), 'https://user:password@dexscreener.com/robinhood/' + TOKEN(5),
    `https://dexscreener.com/robinhood/${TOKEN(5)}?key=private`, `https://dexscreener.com/robinhood/${TOKEN(5)}#fragment`,
    'javascript:alert(1)', 'https://dexscreener.com/robinhood/0x' + '0'.repeat(40)])
    assert.throws(() => formatDryRunAlert(eligible({ chartUrl })), /MVP_ALERT_INVALID_CHART/);
});

test('incomplete, malformed or below-threshold decisions are rejected instead of becoming alerts', () => {
  for (const change of [{ status: 'REJECTED' }, { profile: 'profile_existing' }, { chainId: 1 }, { direction: 'EXIT' },
    { scoreComplete: undefined }, { walletsComplete: false }, { securityComplete: undefined }, { securityComplete: false },
    { score: 74.99 }, { score: NaN }, { score: 101 }, { eligible: false }, { synthetic: 'true' }, { reasons: ['one', 'two'] }])
    assert.throws(() => formatDryRunAlert(eligible(change)), /MVP_ALERT_/);
  assert.throws(() => formatDryRunAlert(eligible({ score: 88 }), { minScore: 90 }), /MVP_ALERT_INCOMPLETE_SCORE/);
  assert.throws(() => formatDryRunAlert(eligible(), { minScore: 1 }), /MVP_ALERT_INVALID_MIN_SCORE/);
  assert.equal(formatDryRunAlert(eligible({ score: 90 }), { minScore: 90 }).score, 90);
});

test('wallet eligibility requires actual score, five realized trades and distinct independent groups', () => {
  const wallet = eligible().wallets[0];
  for (const wallets of [[], [{ ...wallet, realizedTrades: 4 }], [{ ...wallet, realizedTrades: undefined }],
    [{ ...wallet, eligible: undefined }], [{ ...wallet, score: undefined }], [{ ...wallet, synthetic: true }],
    [wallet, { ...wallet, address: TOKEN(12) }], [wallet, { ...wallet, clusterId: 'other' }]])
    assert.throws(() => formatDryRunAlert(eligible({ wallets })), /MVP_ALERT_/);
});

test('three eligible wallets in two independent groups produce one dry-run preview without counting a cluster twice', t => {
  const DB = db(t);
  const [a, b] = eligible().wallets;
  const wallets = [a, { ...a, address: TOKEN(12) }, b];
  const result = formatDryRunAlert(eligible({ wallets }));
  assert.equal(result.wallets.length, 3);
  assert.equal(new Set(result.wallets.map(wallet => wallet.clusterId)).size, 2);
  assert.ok(result.text.includes(TOKEN(12)));
  const prepared = prepareDryRunAlerts(DB, [eligible({ wallets })], { runId: 'two-groups', observedAt: time });
  assert.equal(prepared.accepted.length, 1);
  assert.equal(prepared.commands.length, 1);
  assert.throws(() => formatDryRunAlert(eligible({ wallets: [a] })), /MVP_ALERT_DEPENDENT_WALLET_GROUPS/);
  assert.throws(() => formatDryRunAlert(eligible({ wallets: [a, { ...a, address: TOKEN(12) }] })), /MVP_ALERT_DEPENDENT_WALLET_GROUPS/);
  assert.throws(() => formatDryRunAlert(eligible({ wallets }), { minIndependentGroups: 3 }), /MVP_ALERT_DEPENDENT_WALLET_GROUPS/);
  assert.throws(() => formatDryRunAlert(eligible({ wallets }), { minIndependentGroups: 1 }), /MVP_ALERT_INVALID_MIN_GROUPS/);
});

test('known critical risk flags and high severity evidence block an otherwise PASS decision', () => {
  for (const riskFlags of [['HONEYPOT'], ['canMint'], ['hidden_owner'], ['SELL_TAX_POSITIVE'], ['EMPTY_LIQUIDITY'],
    ['SYBIL_CLUSTER'], ['BUY_SIMULATION_FAILED'], ['SECURITY_CHECK_MISSING'],
    [{ code: 'UNKNOWN_CHECK', severity: 'HIGH' }], [{ code: 'PROXY_UNREVIEWED', severity: 'INFO' }]])
    assert.throws(() => formatDryRunAlert(eligible({ riskFlags })), /MVP_ALERT_HIGH_RISK/);
  assert.deepEqual(formatDryRunAlert(eligible({ riskFlags: [{ code: 'UNCALIBRATED_MVP', severity: 'INFO' }] })).riskFlags, ['UNCALIBRATED_MVP']);
});

test('symbol and reasons cannot inject markup, mentions, line breaks, bidi controls or arbitrary links', () => {
  const result = formatDryRunAlert(eligible({ symbol: '<b>@RADAR</b>\nFAKE\u202e',
    reasons: ['<script>texto</script> @everyone\nhttps://evil.invalid/private', 'x'.repeat(10000), 'terceiro motivo', 'quarto não apresentado'] }));
  assert.equal(result.symbol, 'RADAR FAKE');
  assert.equal(result.reasons.length, 3); assert.equal([...result.reasons[1]].length, 160); assert.ok(result.reasons[1].endsWith('…'));
  assert.equal(result.text.includes('evil.invalid'), false); assert.equal(result.text.includes('<b>'), false);
  assert.equal(result.text.includes('@everyone'), false); assert.equal(result.text.includes('\u202e'), false);
  assert.ok(result.text.length <= 4096);
});

test('synthetic alerts are visibly synthetic and every request to disable dry-run is rejected', () => {
  const result = formatDryRunAlert(eligible({ synthetic: true }));
  assert.equal(result.synthetic, true); assert.match(result.text, /SINTÉTICO · DRY RUN · sem envio/);
  assert.throws(() => formatDryRunAlert(eligible({ synthetic: true }), { dryRun: false }), /MVP_ALERT_DRY_RUN_REQUIRED/);
  assert.throws(() => formatDryRunAlert(eligible(), { dryRun: false }), /MVP_ALERT_DRY_RUN_REQUIRED/);
});

test('durable outbox deduplicates decision/version/episode/destination across run retries and keeps exact counts', async t => {
  const DB = db(t);
  const one = prepareDryRunAlerts(DB, [eligible(), eligible()], { runId: 'run-1', observedAt: time });
  assert.equal(one.commands.length, 1); assert.equal(one.diagnostics[1].reason, 'DUPLICATE_IN_RUN');
  await DB.batch(one.commands); await DB.batch(one.commands);
  await DB.batch(prepareDryRunAlerts(DB, [eligible()], { runId: 'run-2', observedAt: time + 1000 }).commands);
  assert.equal((await getDryRunAlertStats(DB)).queuedDryRun, 1);
  await DB.batch(prepareDryRunAlerts(DB, [eligible({ episodeId: 'entry-episode-2' })], { runId: 'run-3', observedAt: time + 2000 }).commands);
  await DB.batch(prepareDryRunAlerts(DB, [eligible({ scoreVersion: 'mvp-new-v2' })], { runId: 'run-4', observedAt: time + 3000 }).commands);
  await DB.batch(prepareDryRunAlerts(DB, [eligible()], { runId: 'run-5', observedAt: time + 4000, destinationKey: 'telegram:dry-run:review' }).commands);
  assert.equal((await getDryRunAlertStats(DB)).queuedDryRun, 4);
  const recent = await getRecentDryRunAlerts(DB, { limit: 2 });
  assert.equal(recent.length, 2); assert.equal(recent[0].createdAt, new Date(time + 4000).toISOString());
  assert.ok(recent.every(alert => alert.dryRun && alert.state === 'DRY_RUN'));
  assert.throws(() => DB.sqlite.exec("UPDATE mvp_alert_outbox SET state='SENT'"), /MVP_OUTBOX_DRY_RUN_IMMUTABLE/);
  assert.throws(() => DB.sqlite.exec('DELETE FROM mvp_alert_outbox'), /MVP_OUTBOX_APPEND_ONLY/);
});

test('outbox and trigger counters roll back with the existing collector fence', async t => {
  const DB = db(t);
  const prepared = prepareDryRunAlerts(DB, [eligible()], { runId: 'fenced', observedAt: time });
  await assert.rejects(DB.batch([...prepared.commands, DB.prepare('INSERT OR REPLACE INTO commit_fence(id,ok) VALUES(1,0)')]), /CHECK constraint failed/);
  assert.equal((await getDryRunAlertStats(DB)).queuedDryRun, 0);
  assert.deepEqual(await getRecentDryRunAlerts(DB), []);
});

test('invalid and high-risk decisions produce redacted diagnostics and no outbox commands', t => {
  const DB = db(t);
  const secret = '123456789:FAKE_TOKEN_MUST_NOT_APPEAR_ANYWHERE';
  const result = prepareDryRunAlerts(DB, [eligible({ reasons: [`TELEGRAM_BOT_TOKEN=${secret}`, 'two', 'three'] }),
    eligible({ riskFlags: ['HONEYPOT'] }), eligible({ observedAt: new Date(time + 1000).toISOString() })],
  { runId: 'redacted', observedAt: time });
  assert.equal(result.commands.length, 0); assert.equal(result.accepted.length, 0);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.diagnostics[2].reason, 'MVP_ALERT_FUTURE_OBSERVATION');
  assert.throws(() => prepareDryRunAlerts(DB, [eligible()], { runId: 'bad-destination', observedAt: time, destinationKey: '-100123456789' }), /MVP_ALERT_INVALID_DESTINATION_ALIAS/);
});

test('configured Telegram credentials never enable networking or appear in public projections', async t => {
  const DB = db(t); let networkCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { networkCalls++; throw Error('Network is forbidden in phase 2'); });
  // These fixtures exist only in the isolated test process, never real credentials.
  process.env.TELEGRAM_BOT_TOKEN = '123456789:FAKE_TOKEN_MUST_NOT_APPEAR_ANYWHERE';
  process.env.TELEGRAM_CHAT_ID = '-100123456789';
  process.env.TELEGRAM_DRY_RUN = 'false';
  const result = prepareDryRunAlerts(DB, [eligible({ botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID })],
    { runId: 'credentials-ignored', observedAt: time, botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID });
  await DB.batch(result.commands);
  const publicData = JSON.stringify(await getRecentDryRunAlerts(DB));
  assert.equal(networkCalls, 0); assert.equal(publicData.includes('FAKE_TOKEN'), false); assert.equal(publicData.includes('-100123456789'), false);
  assert.throws(() => prepareDryRunAlerts(DB, [eligible()], { runId: 'live-forbidden', observedAt: time, dryRun: false }), /MVP_ALERT_DRY_RUN_REQUIRED/);
  assert.equal(networkCalls, 0);
  const source = await readFile(new URL('../src/mvp/alerts.mjs', import.meta.url), 'utf8');
  assert.equal(/process\.env|\bfetch\s*\(|sendMessage/.test(source), false, 'production module has no environment/network delivery path');
});
