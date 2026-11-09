// Short read-only smoke test of two public Solana RPC WebSocket gateways.
// No API keys, wallets, transactions, writes or raw log payloads are stored.
import WebSocket from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';
import { appendFile } from 'node:fs/promises';

const targets=[
  ['solana_public','wss://api.mainnet-beta.solana.com'],
  ['publicnode','wss://solana-rpc.publicnode.com']
];
const PUMP_FUN='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const safeCode=x=>typeof x==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(x)?x:null;
const results=[];

async function testOne(name,url){
  const result={provider:name,subscribed:false,logNotifications:0,
    errors:[],closedBeforeDeadline:false,durationMs:null};
  const started=Date.now();
  let ws,done=false,timer;
  await new Promise(resolve=>{
    const finish=()=>{if(done)return;done=true;clearTimeout(timer);result.durationMs=Date.now()-started;
      try{ws?.terminate();}catch{} resolve();};
    timer=setTimeout(finish,13000);
    try{
      ws=new WebSocket(url,{handshakeTimeout:6000,maxPayload:2*1024*1024,perMessageDeflate:false});
      ws.on('open',()=>ws.send(JSON.stringify({
        jsonrpc:'2.0',id:1,method:'logsSubscribe',
        params:[{mentions:[PUMP_FUN]},{commitment:'confirmed'}]
      })));
      ws.on('message',bytes=>{
        try{
          const msg=JSON.parse(bytes.toString());
          if(msg.id===1){result.subscribed=Number.isSafeInteger(msg.result)&&!msg.error;
            if(msg.error)result.errors.push('SUBSCRIPTION_REJECTED');}
          if(msg.method==='logsNotification')result.logNotifications++;
        }catch{result.errors.push('INVALID_JSON');}
      });
      ws.on('error',err=>{
        result.errors.push(safeCode(err?.code)??'TRANSPORT_ERROR');
        finish();
      });
      ws.on('close',()=>{
        if(!done){result.closedBeforeDeadline=true;finish();}
      });
    }catch{result.errors.push('CONNECT_FAILED');finish();}
  });
  return result;
}
for(const [name,url] of targets){
  results.push(await testOne(name,url));
  await sleep(1200);
}
const lines=['## Solana public WS provider micro-smoke (read-only)',
'',
'This is a 13s/endpoint sample, not proof of long-term reliability or completeness.',
'',
...results.map(r=>'- '+r.provider+': subscribed='+r.subscribed+
  ', notifications='+r.logNotifications+
  ', transportErrors='+((r.errors.join(',')||'none'))+
  ', closedEarly='+r.closedBeforeDeadline+
  ', runtimeMs='+r.durationMs),
'',
'No production configuration or RPC quota was modified.'];
const summary=lines.join('\n')+'\n';
console.log(summary);
if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,summary);
