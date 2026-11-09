import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { serve } from '../src/api.mjs';
import { execFileSync } from 'node:child_process';

const config = loadConfig({
  SOLANA_PROGRAMS: 'pump_fun,pump_swap',
  SOLANA_PUBLIC_DASHBOARD_ONLY: 'true',
  SOLANA_RPC_REQUESTS_PER_MINUTE: '12',
});
test('Render cloud profile has opt-in limited public API and fixed budget', () => {
  assert.equal(config.publicDashboardOnly,true);
  assert.equal(config.requestsPerMinute,12);
  assert.equal(loadConfig({SOLANA_PROGRAMS:'pump_fun'}).publicDashboardOnly,false);
  assert.throws(() => loadConfig({SOLANA_PUBLIC_DASHBOARD_ONLY:'yes'}),/INVALID_SOLANA_PUBLIC_DASHBOARD_ONLY/);
});

test('cloud-only public API excludes raw wallet/log evidence',async(t)=>{
  let calls=0;
  const scanner={
    radar:()=>{calls++; return {kind:'SOLANA_PUMP_RADAR_MVP',coverage:'PARTIAL',candidates:[]}},
    health:()=>({chain:'solana',mode:'READ_ONLY',status:'DEGRADED'}),
  };
  const server=await serve(scanner,{host:'127.0.0.1',port:0,publicDashboardOnly:true});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root='http://127.0.0.1:'+server.address().port;
  for(const route of ['/radar','/dashboard','/health']){
    const response=await fetch(root+route);
    assert.equal(response.status,200,route);
  }
  for(const route of ['/observations','/events','/security','/evidence','/tokens','/market','/gaps']){
    const response=await fetch(root+route);
    assert.equal(response.status,404,route);
    assert.deepEqual(await response.json(),{error:'NOT_FOUND'});
  }
  const post=await fetch(root+'/radar',{method:'POST'});
  assert.equal(post.status,405);
  assert.ok(calls>=2);
});

test('cloud launcher refuses malformed listening port before starting scanner',()=>{
  assert.throws(()=>execFileSync('bash',['scripts/run-cloud.sh'],{
    cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'badport'},stdio:'pipe'
  }),/Command failed/);
});
