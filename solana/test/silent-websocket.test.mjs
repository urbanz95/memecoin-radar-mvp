import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { LogSocket } from '../src/websocket.mjs';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Scanner } from '../src/scanner.mjs';
import { Metrics } from '../src/metrics.mjs';
import { readFileSync } from 'node:fs';

class LocalWebSocket extends WebSocket {}
const PROGRAM='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

async function until(predicate, timeout = 2500) {
  const end=Date.now()+timeout;
  while (!predicate()) {
    if (Date.now()>end) throw Error('WAIT_TIMEOUT');
    await delay(10);
  }
}

test('silent stream monitoring is opt-in and bounded', () => {
  assert.equal(loadConfig({ SOLANA_PROGRAMS:'pump_fun' }).wsNoLogTimeoutMs,0);
  assert.equal(loadConfig({
    SOLANA_PROGRAMS:'pump_fun',
    SOLANA_WS_NO_LOG_TIMEOUT_MS:'45000',
  }).wsNoLogTimeoutMs,45000);
  assert.throws(()=>loadConfig({ SOLANA_WS_NO_LOG_TIMEOUT_MS:'-1' }),/INVALID_CONFIG/);
  assert.throws(()=>new LogSocket({
    programs:[PROGRAM],noLogTimeoutMs: -3,
  }),/INVALID_NO_LOG_TIMEOUT/);
});

test('acknowledged but silent WebSocket reconnects despite healthy ping/pong',async(t)=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});
  await once(server,'listening');
  const clients=[],disconnects=[],metrics=new Metrics();
  let ack=0;
  server.on('connection',client=>{
    clients.push(client);
    client.on('message',bytes=>{
      const request=JSON.parse(bytes.toString());
      client.send(JSON.stringify({jsonrpc:'2.0',id:request.id,result:101}));
    });
  });
  const ws=new LogSocket({
    url:'ws://127.0.0.1:'+server.address().port,
    WebSocketImpl:LocalWebSocket, programs:[PROGRAM],
    noLogTimeoutMs:110, heartbeatMs:20, idleTimeoutMs:1500,
    reconnectBaseMs:1000, metrics,
    onConnect:()=>ack++,
    onDisconnect:e=>disconnects.push(e.reason),
  });
  t.after(async()=>{
    ws.stop();
    clients.forEach(x=>x.terminate());
    await new Promise(resolve=>server.close(resolve));
  });
  ws.start();
  await until(()=>ack>=1);
  await until(()=>disconnects.includes('NO_LOG_NOTIFICATIONS'));
  assert.equal(metrics.snapshot().counters.log_notifications??0,0);
  assert.equal(metrics.snapshot().counters.websocket_silent_reconnects,1);
  assert.equal(metrics.snapshot().gauges.websocket_last_disconnect_reason,'NO_LOG_NOTIFICATIONS');
});

test('health cannot claim OBSERVING when no events arrive on acknowledged socket',async()=>{
  const db=new Store(':memory:');
  const metrics=new Metrics();
  metrics.set('websocket_connected',true);
  metrics.set('websocket_connected_at',new Date().toISOString());
  const scanner=new Scanner({
    ...loadConfig({SOLANA_PROGRAMS:'pump_fun'}),
    wsNoLogTimeoutMs:45000,
  },{store:db,metrics,rpc:{async close(){}}});
  try{
    assert.equal(scanner.health().status,'DEGRADED');
    assert.equal(scanner.health().logStream.noRecentLogs,true);
    metrics.set('lastEventReceived',new Date().toISOString());
    assert.equal(scanner.health().logStream.noRecentLogs,false);
    assert.equal(scanner.health().status,'OBSERVING');
    metrics.set('lastEventReceived',new Date(Date.now()-60000).toISOString());
    assert.equal(scanner.health().logStream.noRecentLogs,true);
    assert.equal(scanner.health().status,'DEGRADED');
    const page=readFileSync(new URL('../static/radar.html',import.meta.url),'utf8');
    assert.match(page,/SEM EVENTOS RECENTES/);
  }finally{await scanner.stop()}
});
