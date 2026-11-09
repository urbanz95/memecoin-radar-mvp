// Durable per-second buckets for *observed* verified RPC logs. No completeness
// or unique-wallet inference. Called inside persistLogBatch's SQLite transaction.
const BUY = new Set(['TOKEN_BOUGHT']);
const SELL = new Set(['TOKEN_SOLD']);
const STAGES = new Set(['TOKEN_CREATED','POOL_CREATED','TOKEN_MIGRATED','TOKEN_GRADUATED']);
const SECOND = 1000, WINDOW = 300000, SEEN_TTL = 360000, MAX_GROUPS = 15000;
const ceil = n => Math.ceil(n / SECOND) * SECOND;

export function installRadarRollups(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS radar_seen_ids(id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS radar_seen_time ON radar_seen_ids(received_at);
    CREATE TABLE IF NOT EXISTS radar_second_buckets(
      second_start INTEGER NOT NULL, mint TEXT NOT NULL, protocol TEXT NOT NULL,
      events INTEGER NOT NULL, buys INTEGER NOT NULL, sells INTEGER NOT NULL,
      lifecycle INTEGER NOT NULL, first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,
      PRIMARY KEY(second_start,mint,protocol));
    CREATE INDEX IF NOT EXISTS radar_second_time ON radar_second_buckets(second_start);
    CREATE TABLE IF NOT EXISTS radar_rollup_state(name TEXT PRIMARY KEY,value_ms INTEGER NOT NULL);
  `);
}

export function recordRadarRollup(db, e, now = Date.now()) {
  if (e?.dataMode !== 'REAL_RPC_LOG_OBSERVATION' ||
    e?.evidenceStatus !== 'VERIFIED_RPC_LOG_EVENT' ||
    e?.evidenceSource?.kind !== 'rpc:logsSubscribe' ||
    !/^[0-9a-f]{64}$/.test(e?.id ?? '') ||
    typeof e?.tokenMint !== 'string' || !e.tokenMint ||
    typeof e?.protocol !== 'string' || !e.protocol ||
    typeof e?.transactionSignature !== 'string' || !e.transactionSignature) return false;
  const at = Date.parse(e.receivedAt ?? '');
  if (!Number.isSafeInteger(at) || !Number.isFinite(now) ||
    at < now - WINDOW || at > now + 15000) return false;
  const inserted = db.prepare(
    'INSERT OR IGNORE INTO radar_seen_ids(id,received_at) VALUES(?,?)'
  ).run(e.id, at);
  if (inserted.changes !== 1) return false;
  db.prepare(`
    INSERT INTO radar_second_buckets
      (second_start,mint,protocol,events,buys,sells,lifecycle,first_at,last_at)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(second_start,mint,protocol) DO UPDATE SET
      events=events+excluded.events,
      buys=buys+excluded.buys,
      sells=sells+excluded.sells,
      lifecycle=lifecycle+excluded.lifecycle,
      first_at=MIN(first_at,excluded.first_at),
      last_at=MAX(last_at,excluded.last_at)
  `).run(Math.floor(at / SECOND) * SECOND,e.tokenMint,e.protocol,
    1,Number(BUY.has(e.eventType)),Number(SELL.has(e.eventType)),
    Number(STAGES.has(e.eventType)),at,at);
  db.prepare("INSERT OR IGNORE INTO radar_rollup_state(name,value_ms) VALUES('started_at',?)").run(at);
  return true;
}

export function pruneRadarRollups(db, now = Date.now()) {
  if (!Number.isFinite(now)) throw Error('INVALID_RADAR_ROLLUP_CLOCK');
  db.prepare('DELETE FROM radar_seen_ids WHERE received_at < ?').run(now-SEEN_TTL);
  db.prepare('DELETE FROM radar_second_buckets WHERE second_start < ?')
    .run(ceil(now-WINDOW));
}

export function readRadarRollups(db,{now=Date.now()}={}) {
  if (!Number.isFinite(now)) throw Error('INVALID_RADAR_ROLLUP_CLOCK');
  const meta=db.prepare("SELECT value_ms FROM radar_rollup_state WHERE name='started_at'").get();
  if(!meta) return null; // Before first post-migration eligible log.
  const a15=ceil(now-15000),a60=ceil(now-60000),a300=ceil(now-WINDOW);
  const rows=db.prepare(`
    SELECT mint,GROUP_CONCAT(DISTINCT protocol) AS protocols,
      SUM(events) AS events300,SUM(buys) AS buys300,
      SUM(sells) AS sells300,SUM(lifecycle) AS lifecycle300,
      SUM(CASE WHEN second_start>=? THEN events ELSE 0 END) AS events15,
      SUM(CASE WHEN second_start>=? THEN buys ELSE 0 END) AS buys15,
      SUM(CASE WHEN second_start>=? THEN sells ELSE 0 END) AS sells15,
      SUM(CASE WHEN second_start>=? THEN lifecycle ELSE 0 END) AS lifecycle15,
      SUM(CASE WHEN second_start>=? THEN events ELSE 0 END) AS events60,
      SUM(CASE WHEN second_start>=? THEN buys ELSE 0 END) AS buys60,
      SUM(CASE WHEN second_start>=? THEN sells ELSE 0 END) AS sells60,
      SUM(CASE WHEN second_start>=? THEN lifecycle ELSE 0 END) AS lifecycle60,
      MIN(first_at) AS first_at,MAX(last_at) AS last_at
    FROM radar_second_buckets WHERE second_start>=? AND second_start<=?
    GROUP BY mint ORDER BY events60 DESC,last_at DESC,mint ASC LIMIT ?
  `).all(a15,a15,a15,a15,a60,a60,a60,a60,
    a300,Math.floor(now/SECOND)*SECOND,MAX_GROUPS+1);
  const truncated=rows.length>MAX_GROUPS;
  if(truncated) rows.length=MAX_GROUPS;
  const first=Number(meta.value_ms);
  return {
    rows,truncated,maxGroupRows:MAX_GROUPS,
    firstRecordedAt:new Date(first).toISOString(),
    observedDurationSeconds:Math.min(300,Math.max(0,Math.floor((now-first)/1000))),
    window15sWarmingUp:now-first<15000,
    window60sWarmingUp:now-first<60000,
    window300sWarmingUp:now-first<WINDOW,
    timeGranularityMs:SECOND,
  };
}

const activity=(row,suffix)=>({
  events:Number(row['events'+suffix]),buys:Number(row['buys'+suffix]),
  sells:Number(row['sells'+suffix]),lifecycle:Number(row['lifecycle'+suffix])
});

// FDV is borrowed only when evidenced in the separate recent raw sample.
// Aggregating counts does NOT yield distinct transactions, wallets or complete
// trade history; null explicitly means not measured.
export function applyRadarRollups(raw,rollups,{now=Date.now(),limit=50}={}) {
  if(!rollups) return {
    ...raw,sample:{...raw.sample,aggregationSource:'LEGACY_BOUNDED_RAW_SAMPLE',
      aggregateAvailable:false,window15sPotentiallyTruncated:true,
      window60sPotentiallyTruncated:true,window300sPotentiallyTruncated:true}
  };
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)
    throw Error('INVALID_RADAR_AGGREGATE_LIMIT');
  const evidence=new Map(raw.candidates.map(x=>[x.mint,x]));
  const all=rollups.rows.map(r=>{
    const known=evidence.get(r.mint);
    return {
      mint:r.mint,protocols:r.protocols.split(',').sort(),
      firstObservedAt:new Date(r.first_at).toISOString(),
      lastObservedAt:new Date(r.last_at).toISOString(),
      lastEventType:null,lastTransactionSignature:null,
      observedEvents:Number(r.events300),
      distinctObservedTransactions:null,observedWalletsIdentified:null,
      unattributedBuySellEvents:null,
      activity:{'15s':activity(r,'15'),'60s':activity(r,'60'),'300s':activity(r,'300')},
      estimatedFdvUsd:known?.estimatedFdvUsd??null,
      fdvStatus:known?.fdvStatus??'FDV_UNKNOWN',
      fdvEvidence:known?.fdvEvidence??null,
      context:'PARTIAL_RPC_LOG_OBSERVATIONS_ROLLING_AGGREGATES',
      confidence:null,safetyConclusion:null,
    };
  });
  const rank={ABOVE_FLOOR:0,NEAR_FLOOR:1,FDV_UNKNOWN:2,BELOW_FLOOR:3};
  all.sort((a,b)=>(rank[a.fdvStatus]-rank[b.fdvStatus]) ||
    (b.activity['60s'].events-a.activity['60s'].events) ||
    b.lastObservedAt.localeCompare(a.lastObservedAt) || a.mint.localeCompare(b.mint));
  const shown=all.filter(x=>x.fdvStatus!=='BELOW_FLOOR');
  const oldest=rollups.rows.reduce((n,r)=>n===null?Number(r.first_at):
    Math.min(n,Number(r.first_at)),null);
  const sample={
    rowsInspected:rollups.rows.length,
    verifiedUniqueEvents:rollups.rows.reduce((n,r)=>n+Number(r.events300),0),
    oldestRetainedObservationInWindow:oldest===null?null:new Date(oldest).toISOString(),
    maxRowsRead:rollups.maxGroupRows,
    possibleTruncation:rollups.truncated,
    sampledLookbackSeconds:rollups.observedDurationSeconds,
    timeWindowSeconds:300,
    window15sPotentiallyTruncated:rollups.truncated||rollups.window15sWarmingUp,
    window60sPotentiallyTruncated:rollups.truncated||rollups.window60sWarmingUp,
    window300sPotentiallyTruncated:rollups.truncated||rollups.window300sWarmingUp,
    aggregateAvailable:true,aggregationSource:'DURABLE_SQLITE_1S_BUCKETS',
    aggregationGranularityMs:rollups.timeGranularityMs,
    firstAggregateRecordedAt:rollups.firstRecordedAt,
    rawRowsInspected:raw.sample.rowsInspected,
    rawSamplePotentiallyTruncated:raw.sample.possibleTruncation,
    distinctTransactionsKnown:false,distinctWalletsKnown:false,
    coverage:'PARTIAL_UNQUANTIFIED'
  };
  return {
    ...raw,generatedAt:new Date(now).toISOString(),sample,
    totals:{
      observedDistinctMints:all.length,eligibleOrUnknown:shown.length,
      aboveFloor:all.filter(x=>x.fdvStatus==='ABOVE_FLOOR').length,
      nearFloor:all.filter(x=>x.fdvStatus==='NEAR_FLOOR').length,
      unknownFdv:all.filter(x=>x.fdvStatus==='FDV_UNKNOWN').length,
      belowFloorNotDisplayed:all.length-shown.length
    },
    candidates:shown.slice(0,limit),
    warnings:[...raw.warnings,
      'Activity windows count observed RPC logs in durable per-second buckets, not all chain transactions.',
      'Up to one second of left-boundary observations is conservatively excluded.',
      ...(sample.window300sPotentiallyTruncated ?
        ['Rollup still warming up or group-cap reached; windows may be incomplete.']:[]),
      'Distinct wallets/transactions cannot be inferred from bucket sums.',
      'FDV may remain UNKNOWN when raw creation/reserve evidence is unavailable.']
  };
}
