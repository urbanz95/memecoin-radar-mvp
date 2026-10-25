import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as weekly from '../src/mvp/weekly-report.mjs';
import { prepareDecisionRecords, decisionKey } from '../src/mvp/records.mjs';
import { setup, TOKEN, policyHash, time } from './helpers/mvp-sqlite.mjs';
const indexes = await readFile(new URL('../cloudflare/migrations/0005_mvp_weekly.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../cloudflare/migrations/0010_mvp_weekly_jobs.sql', import.meta.url), 'utf8');
const AT = Date.parse('2026-11-02T00:15:00Z');
function db(t) { const DB = setup(t); DB.sqlite.exec(indexes); DB.sqlite.exec(migration); return DB; }
async function seed(DB, n, { scoreVersion = `weekly-version-${String(n).padStart(3,'0')}`, profile = 'profile_new', quoteTier,
  observedAt = time, score = 80, walletScore = 85 } = {}) {
  const pair = quoteTier === undefined ? {} : { pair: { quote: { tier: quoteTier } } };
  await DB.batch(prepareDecisionRecords(DB, { runId: `weekly-seed-${n}-${scoreVersion}-${profile}-${quoteTier ?? ''}`,
    observedAt, decisions: [{ address: TOKEN(n), status: 'REJECTED', scoreVersion, profile, policyHash, isLaunch: true,
      features: { ...pair, snapshot: { synthetic: false, chainState: { blockNumber: 10, blockHash: '0x' + 'ab'.repeat(32) } },
        decision: { synthetic: false, score, wallets: { status: 'READY', score: walletScore } },
        externalMarket: { priceUsd: 10, liquidityUsd: 1000 } } }] }).commands);
  return decisionKey(4663,TOKEN(n),scoreVersion,profile);
}

test('dedicated weekly job pages 30 cohorts without the combined 256KiB limit and never pools score versions', async t => {
  const DB = db(t);
  assert.equal(typeof weekly.runWeeklyReportJob, 'function', 'report generation must have a separate bounded job');
  for (let n=1;n<=30;n++) await seed(DB,n);
  let result;
  for (let n=0;n<31;n++) result = await weekly.runWeeklyReportJob(DB,{now: AT+n*60000});
  assert.equal(result.status,'COMPLETE');
  assert.equal(DB.sqlite.prepare('SELECT count(*) n FROM mvp_weekly_cohort_pages').get().n,30);
  const first = await weekly.getWeeklyReportPage(DB);
  assert.equal(first.schemaVersion,2); assert.equal(first.cohorts.length,1);
  assert.equal(first.totals.realDecisions,1); assert.equal(first.pagination.totalPages,30);
  assert.equal(first.pagination.page,0); assert.equal(first.pagination.hasNext,true);
  assert.equal(first.quoteTier,'UNKNOWN');
  assert.ok(Buffer.byteLength(JSON.stringify(first))<65536);
  const last = await weekly.getWeeklyReportPage(DB,{reportKey:first.reportKey,page:29});
  assert.equal(last.pagination.hasNext,false); assert.equal(last.pagination.hasPrevious,true);
  assert.notEqual(last.scoreVersion,first.scoreVersion);
  assert.equal(await weekly.getWeeklyReportPage(DB,{reportKey:first.reportKey,page:30}),null);
});

test('weekly job resumes one cohort at a time, freezes membership/cutoff and uses exact immutable cohort pages', async t => {
  const DB = db(t); await seed(DB,1); await seed(DB,2);
  const first = await weekly.runWeeklyReportJob(DB,{now:AT});
  assert.equal(first.status,'PENDING'); assert.equal(first.pagesWritten,1);
  const page = await weekly.getWeeklyReportPage(DB);
  await seed(DB,3,{scoreVersion:'weekly-version-000'});
  const next = await weekly.runWeeklyReportJob(DB,{now:AT+60000});
  assert.equal(next.pagesWritten,1);
  await weekly.runWeeklyReportJob(DB,{now:AT+120000});
  const repeated = await weekly.getWeeklyReportPage(DB,{reportKey:page.reportKey,page:0});
  assert.deepEqual(repeated.bands,page.bands); assert.equal(repeated.dataCutoff,new Date(AT).toISOString());
  assert.equal(repeated.pagination.totalPages,2,'late backfill is outside the frozen source rowid boundary');
  assert.throws(()=>DB.sqlite.exec("UPDATE mvp_weekly_cohort_pages SET report_json='{}'"),/MVP_WEEKLY_COHORT_IMMUTABLE/);
  const retry = await weekly.runWeeklyReportJob(DB,{now:AT+180000});
  assert.equal(retry.status,'COMPLETE'); assert.equal(retry.pagesWritten,0);
});

test('weekly pages separate quote tiers and profiles and retain unknown quote metadata',async t=>{
  const DB=db(t);
  await seed(DB,1,{scoreVersion:'same',quoteTier:'T0'});
  await seed(DB,2,{scoreVersion:'same',quoteTier:'T1S'});
  await seed(DB,3,{scoreVersion:'same',quoteTier:'T2',profile:'legacy_new'});
  await seed(DB,4,{scoreVersion:'same'});
  for(let n=0;n<5;n++) await weekly.runWeeklyReportJob(DB,{now:AT+n*60000});
  const pages=[]; for(let page=0;page<4;page++)pages.push(await weekly.getWeeklyReportPage(DB,{page}));
  assert.deepEqual(pages.map(p=>p.quoteTier).sort(),['T0','T1S','T2','UNKNOWN']);
  assert.ok(pages.every(p=>p.totals.realDecisions===1&&p.cohorts.length===1));
  const selected=await weekly.getWeeklyReportPage(DB,{scoreVersion:'same',profile:'profile_new',quoteTier:'T1S'});
  assert.equal(selected.quoteTier,'T1S'); assert.equal(selected.profile,'profile_new');
});

test('weekly job retries an aggregate failure separately and resumes without publishing a partial page',async t=>{
  const DB=db(t); await seed(DB,1);
  const prepare=DB.prepare.bind(DB); let fail=true;
  DB.prepare=sql=>{if(fail&&sql.startsWith('WITH raw'))throw new Error('MVP_WEEKLY_TEST_AGGREGATE_FAILURE');return prepare(sql);};
  const failed=await weekly.runWeeklyReportJob(DB,{now:AT});
  assert.equal(failed.status,'RETRY'); assert.equal(failed.error,'MVP_WEEKLY_TEST_AGGREGATE_FAILURE');
  assert.equal(DB.sqlite.prepare('SELECT count(*) n FROM mvp_weekly_cohort_pages').get().n,0);
  assert.equal(DB.sqlite.prepare('SELECT state FROM mvp_weekly_jobs').get().state,'RETRY');
  fail=false;
  const early=await weekly.runWeeklyReportJob(DB,{now:AT+1}); assert.equal(early.pagesWritten,0);
  const retry=await weekly.runWeeklyReportJob(DB,{now:AT+60000});assert.equal(retry.pagesWritten,1);
});

test('weekly page lookup validates input and never falls back to a mixed legacy report',async t=>{
  const DB=db(t);
  assert.equal(await weekly.getWeeklyReportPage(DB),null);
  await assert.rejects(weekly.getWeeklyReportPage(DB,{page:-1}),/MVP_WEEKLY_INVALID_PAGE/);
  await assert.rejects(weekly.getWeeklyReportPage(DB,{quoteTier:'FAKE'}),/MVP_WEEKLY_INVALID_QUOTE_TIER/);
});

test('a reorg quarantines already stored report pages, preserving evidence but hiding all aggregate labels',async t=>{
  const DB=db(t); await seed(DB,1);
  await weekly.runWeeklyReportJob(DB,{now:AT});
  const first=await weekly.getWeeklyReportPage(DB);
  DB.sqlite.prepare('INSERT INTO mvp_decision_reorgs(run_id,observed_at) VALUES(?,?)').run('weekly-reorg',AT+1000);
  const quarantined=await weekly.getWeeklyReportPage(DB,{reportKey:first.reportKey});
  assert.equal(quarantined.quarantined,true); assert.deepEqual(quarantined.cohorts,[]);
  assert.equal(quarantined.bands,null); assert.equal(quarantined.walletScoreBands,null);
  assert.equal(DB.sqlite.prepare('SELECT count(*) n FROM mvp_weekly_cohort_pages').get().n,1);
});

test('unproved historical baseline blocks are archived but cannot enter any report cohort',async t=>{
  const DB=db(t);
  await DB.batch(prepareDecisionRecords(DB,{runId:'unproved-first',observedAt:time,decisions:[{
    address:TOKEN(1),status:'REJECTED',scoreVersion:'unknown-block',profile:'profile_new',policyHash,isLaunch:true,
    features:{snapshot:{synthetic:false},decision:{score:90,synthetic:false},externalMarket:{priceUsd:10,liquidityUsd:1000}},
  }]}).commands);
  assert.equal(DB.sqlite.prepare('SELECT count(*) n FROM mvp_decisions').get().n,1);
  const result=await weekly.runWeeklyReportJob(DB,{now:AT}); assert.equal(result.status,'COMPLETE');
  const report=await weekly.getWeeklyReportPage(DB);
  assert.deepEqual(report.cohorts,[]); assert.equal(report.totals.realDecisions,0);
});

test('completed weekly pages use indexed bounded reads without aggregate work on dashboard polling',async t=>{
  const DB=db(t);await seed(DB,1);await weekly.runWeeklyReportJob(DB,{now:AT});
  const calls=[]; const prepare=DB.prepare.bind(DB); DB.prepare=sql=>{calls.push(sql);return prepare(sql);};
  const result=await weekly.getWeeklyReportPage(DB);assert.equal(result.cohorts.length,1);
  assert.equal(calls.length,3);assert.ok(calls.every(sql=>!sql.startsWith('WITH raw')));
  assert.ok(calls.some(sql=>/page_index=\?/.test(sql)));
});

test('weekly snapshot waits for canonical header revalidation instead of permanently freezing a partial empty cohort',async t=>{
  const DB=db(t);await seed(DB,1);
  DB.sqlite.prepare('INSERT INTO mvp_decision_reorgs(run_id,observed_at) VALUES(?,?)').run('pre-report-reorg',AT);
  const waiting=await weekly.runWeeklyReportJob(DB,{now:AT+1000});
  assert.equal(waiting.status,'WAITING_CANONICALITY');assert.equal(waiting.pagesWritten,0);
  assert.equal(DB.sqlite.prepare('SELECT count(*) n FROM mvp_weekly_jobs').get().n,0);
  DB.sqlite.prepare('INSERT INTO mvp_decision_block_checks(chain_id,block_number,generation,block_hash,checked_at,run_id) VALUES(?,?,?,?,?,?)')
    .run(4663,10,1,'0x'+'ab'.repeat(32),AT+2000,'checked-original-baseline');
  DB.sqlite.exec('UPDATE mvp_decision_epoch SET revalidation_complete=1 WHERE id=1');
  const ready=await weekly.runWeeklyReportJob(DB,{now:AT+60000});
  assert.equal(ready.pagesWritten,1);
  assert.equal((await weekly.getWeeklyReportPage(DB)).totals.realDecisions,1);
});
