import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { LogSocket } from '../src/websocket.mjs';
import { Metrics } from '../src/metrics.mjs';
const PROGRAM='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

async function until(predicate,timeout=2000){
  const end=Date.now()+timeout;
  while(!predicate()){
    if(Date.now()>end)throw Error('WAIT_TIMEOUT');
    await delay(5);
  }
}

test('invalid close frame after ACK escalates retry backoff and switches official public hostname',async t=>{
  const seen=[],metrics=new Metrics();
  class FlappingWebSocket extends EventEmitter {
    constructor(url){
      super();seen.push(url);
      queueMicrotask(()=>this.emit('open'));
    }
    send(bytes){
      const request=JSON.parse(bytes.toString());
      queueMicrotask(()=>{
        this.emit('message',Buffer.from(JSON.stringify({jsonrpc:'2.0',id:request.id,result:11})));
        this.emit('error',Object.assign(Error('synthetic invalid close'),{code:'WS_ERR_INVALID_CLOSE_CODE'}));
      });
    }
    terminate(){}
    ping(){}
  }
  const ws=new LogSocket({
    url:'wss://api.mainnet-beta.solana.com',
    WebSocketImpl:FlappingWebSocket,
    programs:[PROGRAM],
    metrics,reconnectBaseMs:20,reconnectMaxMs:1000,
    random:()=>0,
  });
  t.after(()=>ws.stop());
  ws.start();
  await until(()=>seen.length>=4);
  assert.deepEqual(seen.slice(0,4),[
    'wss://api.mainnet-beta.solana.com',
    'wss://api.mainnet-beta.solana.com',
    'wss://api.mainnet-beta.solana.com',
    'wss://api.mainnet.solana.com',
  ]);
  assert.ok((metrics.snapshot().counters.websocket_official_endpoint_failovers??0)>=1);
  assert.ok(metrics.snapshot().gauges.reconnect_delay_ms>10);
  assert.ok(!JSON.stringify(metrics.snapshot()).includes('synthetic invalid close'));
});

test('a healthy stream resets retry escalation only after sustained actual logs',async t=>{
  const sockets=[],metrics=new Metrics();
  let clock=100000;
  class StableWebSocket extends EventEmitter {
    constructor(){
      super();sockets.push(this);
      queueMicrotask(()=>this.emit('open'));
    }
    send(bytes){
      const request=JSON.parse(bytes.toString());
      queueMicrotask(()=>this.emit('message',Buffer.from(JSON.stringify({
        jsonrpc:'2.0',id:request.id,result:11,
      }))));
    }
    terminate(){}
    ping(){}
  }
  const ws=new LogSocket({
    url:'ws://127.0.0.1:9999',
    WebSocketImpl:StableWebSocket,
    programs:[PROGRAM],metrics,now:()=>clock,stableConnectionMs:1000,
  });
  ws.attempt=4;
  t.after(()=>ws.stop());
  ws.start();
  await until(()=>ws.ready===true);
  assert.equal(ws.attempt,4,'subscription ACK alone is not proof of recovery');
  clock+=1100;
  sockets[0].emit('message',Buffer.from(JSON.stringify({
    jsonrpc:'2.0',method:'logsNotification',
    params:{subscription:11,result:{
      context:{slot:123},value:{signature:'synthetic-signature',err:null,logs:[]},
    }},
  })));
  assert.equal(ws.attempt,0);
  assert.equal(metrics.snapshot().counters.websocket_stable_backoff_resets,1);
});

test('non-official custom endpoint never switches to Solana public without opt-in',()=>{
  const ws=new LogSocket({url:'ws://127.0.0.1:1234',programs:[PROGRAM]});
  assert.deepEqual(ws.urls,['ws://127.0.0.1:1234']);
  ws.stop();
  assert.throws(()=>new LogSocket({
    programs:[PROGRAM],fallbackUrl:'https://unsafe.invalid',
  }),/INVALID_WEBSOCKET_FALLBACK_URL/);
});
