import test from 'node:test';
import assert from 'node:assert/strict';
import { operationError, runManagedCollection, readOperations, heartbeatPayload, OPERATIONS_CONFIG, validateOperationsConfig } from '../src/cloudflare/operations.mjs';
const memory = () => { const values=new Map(); return { async get(k){return structuredClone(values.get(k));},async put(k,v){values.set(k,structuredClone(v));} }; };
test('operation diagnostics preserve safe module codes and classify D1 quota without secrets', () => {
  assert.equal(operationError(Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit. https://private/key")).code,'D1_DAILY_WRITE_LIMIT');
  assert.equal(operationError(Error('MVP_WEEKLY_REPORT_LIMIT_EXCEEDED')).module,'weekly');
  assert.equal(operationError(Error('https://private/key')).code,'COLLECTION_FAILED');
  assert.equal(operationError(Error('CPU_LIMIT')).module,'cpu');
  assert.ok(!JSON.stringify(operationError(Error('https://private/key'))).includes('private'));
});
test('daily quota opens a circuit until UTC reset; retries do not write D1 or fabricate success',async()=>{
  const storage=memory(); let at=Date.parse('2026-10-24T23:50:00Z');let calls=0;
  const collect=async()=>{calls++;throw Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit.");};
  const first=await runManagedCollection({storage,collect,now:()=>at});
  assert.equal(first.reason,'D1_DAILY_WRITE_LIMIT');
  at+=180000;
  const second=await runManagedCollection({storage,collect,now:()=>at});
  assert.equal(second.reason,'D1_QUOTA_COOLDOWN');assert.equal(calls,1);
  at=Date.parse('2026-10-25T00:00:01Z');
  await runManagedCollection({storage,collect:async()=>{calls++;return{status:'COMPLETED',d1RowsWritten:100};},now:()=>at});
  assert.equal(calls,2);assert.equal((await readOperations(storage,{now:at})).lastError,null);
});
test('managed cadence skips D1; cost includes overhead and retains a daily safety reserve',async()=>{
  const storage=memory();let at=Date.parse('2026-10-25T00:01:00Z');let calls=0;
  const collect=async()=>{calls++;return{status:'COMPLETED',d1RowsWritten:300};};
  await runManagedCollection({storage,collect,now:()=>at});
  at+=180000;const skipped=await runManagedCollection({storage,collect,now:()=>at});
  assert.equal(skipped.reason,'COLLECTION_CADENCE');assert.equal(calls,1);
  const state=await readOperations(storage,{now:at});
  assert.ok(state.cadenceSeconds>=334);assert.equal(state.budget.estimatedRowsWritten,310);
  assert.equal(state.budget.limit,80000);assert.equal(OPERATIONS_CONFIG.collector.minimumCadenceSeconds,180);
});
test('six hour stability requires actual completed cycles with bounded gaps and resets on failure',async()=>{
  const storage=memory();let at=Date.parse('2026-10-25T00:00:00Z');const start=at;
  const collect=async()=>({status:'COMPLETED',d1RowsWritten:100});
  for(let i=0;i<=120;i++){at=start+i*180000;await runManagedCollection({storage,collect,now:()=>at});}
  assert.equal((await readOperations(storage,{now:at})).stability.qualified,true);
  at+=180000;await runManagedCollection({storage,collect:async()=>({status:'ERROR',reason:'MVP_WALLET_RUNTIME_INPUT'}),now:()=>at});
  assert.equal((await readOperations(storage,{now:at})).stability.qualified,false);
  at+=180000;await runManagedCollection({storage,collect,now:()=>at});
  assert.equal((await readOperations(storage,{now:at})).stability.stableSince,new Date(at).toISOString());
});
test('heartbeat after ten minutes includes actual cause and no dry-run signal delivery',async()=>{
  const storage=memory();let at=Date.parse('2026-10-25T00:00:00Z');
  await runManagedCollection({storage,collect:async()=>({status:'COMPLETED',d1RowsWritten:10}),now:()=>at});
  at+=180000;await runManagedCollection({storage,collect:async()=>{throw Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit.");},now:()=>at});
  at+=421000;const payload=heartbeatPayload(await readOperations(storage,{now:at}),{now:at});
  assert.equal(payload.alert,true);assert.equal(payload.cause.code,'D1_DAILY_WRITE_LIMIT');
  assert.equal(payload.notificationChannel,'GITHUB_ISSUE');assert.equal(payload.telegramDelivery,false);
});
test('stability never advances through wall clock without a six-hour completed cycle span',async()=>{
  const storage=memory();let at=Date.parse('2026-10-25T00:00:00Z');const start=at;
  for(let i=0;i<120;i++){at=start+i*180000;await runManagedCollection({storage,collect:async()=>({status:'COMPLETED',d1RowsWritten:10}),now:()=>at});}
  assert.equal((await readOperations(storage,{now:start+21600000})).stability.qualified,false);
});
test('unknown write estimates do not compound; UTC-crossing cycles charge the new day conservatively',async()=>{
  const storage=memory();let at=Date.parse('2026-10-24T23:59:00Z');
  await runManagedCollection({storage,collect:async()=>{at+=120000;return{status:'COMPLETED'};},now:()=>at});
  assert.equal((await readOperations(storage,{now:at})).budget.dayUtc,'2026-10-25');
  for(let i=0;i<3;i++){at+=1000000;await runManagedCollection({storage,collect:async()=>({status:'ERROR',reason:'RPC_TRANSPORT_FAILED'}),now:()=>at});}
  assert.equal((await readOperations(storage,{now:at})).budget.estimatedRowsWritten,8192);
  const invalid=structuredClone(OPERATIONS_CONFIG);invalid.collector.retryBackoffSeconds=[180,60];
  assert.throws(()=>validateOperationsConfig(invalid),/INVALID_OPERATIONS_CONFIG/);
});
test('a killed invocation retains its reservation and cannot silently preserve six-hour stability',async()=>{
  const underlying=memory();let puts=0;let at=Date.parse('2026-10-25T00:00:00Z');
  const storage={get:(...args)=>underlying.get(...args),async put(...args){if(++puts===2)throw Error('SIMULATED_PROCESS_KILL');return underlying.put(...args);}};
  await assert.rejects(runManagedCollection({storage,collect:async()=>({status:'COMPLETED',d1RowsWritten:100}),now:()=>at}),/SIMULATED_PROCESS_KILL/);
  const interrupted=await readOperations(storage,{now:at+601000});
  assert.equal(interrupted.budget.estimatedRowsWritten,2048);
  assert.equal(heartbeatPayload(interrupted,{now:at+601000}).cause.code,'CYCLE_INCOMPLETE_OR_INTERRUPTED');
  at+=601000;
  await runManagedCollection({storage,collect:async()=>({status:'COMPLETED',d1RowsWritten:100}),now:()=>at});
  const recovered=await readOperations(storage,{now:at});
  assert.equal(recovered.budget.estimatedRowsWritten,2158);assert.equal(recovered.stability.qualified,false);
});
