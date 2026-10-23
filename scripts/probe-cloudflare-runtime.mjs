import { Miniflare, convertV4MiniflareOptions, Response as LocalResponse } from 'miniflare';
import { fetch as proxyFetch, EnvHttpProxyAgent } from 'undici';
import { readFile, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { NETWORK, QUOTE_ASSETS } from '../src/network.mjs';
import { encodeAbiParameters, parseAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';
import { EVENTS, ERC20, V2 } from '../src/onchain/abi.mjs';

// Local verification only. The production Worker still uses native fetch.
// Forward the runtime's real HTTPS requests through the session's existing
// proxy with inherited CA trust, without creating Cloudflare resources.
const fixture = process.argv.includes('--fixture');
const count = Number(process.argv.slice(2).find(arg => arg !== '--fixture') ?? 1);
if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('Use 1–3 cycles');
const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
const allowedRpcUrl = new URL(config.vars?.ROBINHOOD_RPC_URL ?? NETWORK.rpcUrl).href;
const analysisEnabled = config.vars?.ANALYSIS_ENABLED === '1';
const root = resolve(fixture ? `runtime/cloudflare-runtime-fixture-${process.pid}` : 'runtime/cloudflare-runtime-probe');
await mkdir(root, { recursive: true, mode: 0o700 });
const source = await readFile('/tmp/memecoin-cloudflare-build/worker.js', 'utf8');
await writeFile(join(root, 'worker.mjs'), source);
const dispatcher = new EnvHttpProxyAgent();
let forwardedRequests = 0;
let rpcRequests = 0;
const providerRequests = { sourcify: 0, goplus: 0, dexscreener: 0 };
const cycleProofs = [];
let latestCalls = 0;
const hash = n => '0x' + BigInt(n + 1).toString(16).padStart(64, '0');
const token = '0x1111111111111111111111111111111111111111';
const pool = '0x2222222222222222222222222222222222222222';
const factory = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f';
const zeroAddress = '0x' + '0'.repeat(40);
const fixtureTimestamp = Math.floor(Date.now() / 1000);
const sourceFields = 'abi,compilation,runtimeBytecode.onchainBytecode,runtimeBytecode.recompiledBytecode,runtimeBytecode.transformations,runtimeBytecode.transformationValues,runtimeBytecode.immutableReferences';
function providerFor(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
  const address = '0x[0-9a-fA-F]{40}';
  if (url.origin === 'https://sourcify.dev'
    && new RegExp(`^/server/v2/contract/${NETWORK.chainId}/${address}$`).test(url.pathname)
    && url.searchParams.size === 1 && ['deployment,proxyResolution', sourceFields].includes(url.searchParams.get('fields'))) return 'sourcify';
  if (url.origin === 'https://api.gopluslabs.io' && url.pathname === `/api/v1/token_security/${NETWORK.chainId}`
    && url.searchParams.size === 1 && new RegExp(`^${address}$`).test(url.searchParams.get('contract_addresses') ?? '')) return 'goplus';
  if (url.origin === 'https://api.dexscreener.com' && new RegExp(`^/(?:token-pairs|tokens)/v1/robinhood/${address}(?:,${address}){0,19}$`).test(url.pathname)
    && !url.search) return 'dexscreener';
  const gateway = config.vars?.MARKET_GATEWAY_URL ? new URL(config.vars.MARKET_GATEWAY_URL) : null;
  if (gateway && url.origin === gateway.origin && url.pathname === gateway.pathname
    && url.searchParams.size === 1 && new RegExp(`^${address}(?:,${address}){0,19}$`).test(url.searchParams.get('addresses') ?? '')) return 'dexscreener';
  return null;
}
const fixtureReads = new Map();
function fixtureRead(abi, functionName, result, args = []) {
  const selector = encodeFunctionData({ abi, functionName, args }).slice(0, 10);
  fixtureReads.set(selector, () => encodeFunctionResult({ abi, functionName, result: typeof result === 'function' ? result() : result }));
}
fixtureRead(ERC20, 'decimals', 18);
fixtureRead(ERC20, 'totalSupply', 1000000n * 10n ** 18n);
fixtureRead(ERC20, 'symbol', 'FIXTURE');
fixtureRead(ERC20, 'owner', zeroAddress);
fixtureRead(ERC20, 'paused', false);
fixtureRead(V2, 'factory', factory);
fixtureRead(V2, 'token0', QUOTE_ASSETS.WETH);
fixtureRead(V2, 'token1', token);
fixtureRead(V2, 'getPair', pool, [QUOTE_ASSETS.WETH, token]);
fixtureRead(V2, 'getReserves', () => [2n * 10n ** 18n, 1000000n * 10n ** 18n, Math.floor(Date.now() / 1000)]);
const lpAbi = parseAbi(['function MINIMUM_LIQUIDITY() view returns (uint256)']);
fixtureRead(lpAbi, 'MINIMUM_LIQUIDITY', 1000n);
fixtureReads.set('0x70a08231', tx => encodeFunctionResult({ abi: ERC20, functionName: 'balanceOf',
  result: tx.to?.toLowerCase() === pool && tx.data.slice(-64) === '0'.repeat(64) ? 1000n : 0n }));
function fixtureResponse(payload) {
  const batch = Array.isArray(payload);
  const calls = batch ? payload : [payload];
  const results = calls.map(call => {
    let result;
    if (call.method === 'eth_chainId') result = '0x1237';
    else if (call.method === 'eth_getBlockByNumber') {
      const number = call.params[0] === 'latest' ? 1000 + latestCalls++ : Number(BigInt(call.params[0]));
      result = { number: '0x' + number.toString(16), hash: hash(number), timestamp: '0x' + (fixtureTimestamp - Math.max(0, 1000 - number)).toString(16) };
    } else if (call.method === 'eth_getLogs') {
      const filter = call.params[0];
      result = Array.isArray(filter.address) && filter.address.includes(factory)
        && Number(BigInt(filter.fromBlock)) <= 995 && Number(BigInt(filter.toBlock)) >= 995 ? [{
        address: factory,
        topics: encodeEventTopics({ abi: [EVENTS.v2], eventName: 'PairCreated', args: { token0: QUOTE_ASSETS.WETH, token1: token } }),
        data: encodeAbiParameters(parseAbiParameters('address,uint256'), [pool, 1n]),
        blockNumber: '0x3e3', blockHash: hash(995), transactionHash: hash(99999), logIndex: '0x0', removed: false
      }] : [];
    } else if (call.method === 'eth_getCode') result = Number(BigInt(call.params[1])) === 0
      || ![token, pool, factory, QUOTE_ASSETS.WETH].includes(call.params[0]?.toLowerCase()) ? '0x' : '0x60006000';
    else if (call.method === 'eth_getStorageAt') result = '0x' + '0'.repeat(64);
    else if (call.method === 'eth_getTransactionReceipt') result = null;
    else if (call.method === 'eth_call') {
      // Unsupported simulation capability is a valid JSON-RPC response. It
      // must not abort unrelated calls or the enclosing collector cycle.
      if (call.params.length > 2) return { jsonrpc: '2.0', id: call.id,
        error: { code: -32601, message: 'Transient overrides not implemented by this synthetic fixture' } };
      const read = fixtureReads.get(call.params[0]?.data?.slice(0, 10));
      if (!read) throw new Error('Fixture does not allow this contract call');
      result = read(call.params[0]);
    }
    else throw new Error('Fixture does not allow this RPC method');
    return { jsonrpc: '2.0', id: call.id, result };
  });
  return new LocalResponse(JSON.stringify(batch ? results : results[0]), { headers: { 'content-type': 'application/json' } });
}
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  scriptPath: join(root, 'worker.mjs'),
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  bindings: config.vars,
  d1Databases: { DB: 'runtime-probe' },
  durableObjects: { COLLECTOR: { className: 'Collector', useSQLite: true } },
  resourcePersistencePath: join(root, 'storage'),
  outboundService: async request => {
    const isRpc = new URL(request.url).href === allowedRpcUrl && request.method === 'POST';
    const provider = request.method === 'GET' ? providerFor(request.url) : null;
    if (!isRpc && !provider) throw new Error('Unexpected outbound destination');
    forwardedRequests++;
    if (isRpc) rpcRequests++; else providerRequests[provider]++;
    if (fixture) return isRpc ? fixtureResponse(await request.json())
      : new LocalResponse('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    const upstream = await proxyFetch(request.url, {
      method: request.method,
      headers: isRpc ? { 'content-type': 'application/json' } : { accept: 'application/json' },
      ...(isRpc ? { body: await request.arrayBuffer() } : {}), dispatcher,
      signal: AbortSignal.timeout(15000), redirect: 'error'
    });
    const body = await upstream.arrayBuffer();
    // undici decodes transport compression. Do not preserve its old length or
    // encoding headers when constructing the local bridge response.
    return new LocalResponse(body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json',
        ...(upstream.headers.get('x-radar-fetched-at') ? { 'x-radar-fetched-at': upstream.headers.get('x-radar-fetched-at') } : {}),
        ...(upstream.headers.get('retry-after') ? { 'retry-after': upstream.headers.get('retry-after') } : {}) }
    });
  }
}));
try {
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir('cloudflare/migrations')).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort()) {
    const schema = await readFile(join('cloudflare/migrations', name), 'utf8');
    let statement = '';
    for (const line of schema.split('\n')) {
      if (!statement && (!line.trim() || line.trimStart().startsWith('--'))) continue;
      statement += line + '\n';
      const trigger = /^\s*CREATE\s+TRIGGER\b/i.test(statement);
      if (trigger ? /\bEND;\s*$/i.test(statement) : /;\s*$/.test(line)) {
        await db.prepare(statement).run(); statement = '';
      }
    }
    if (statement.trim()) throw new Error('INCOMPLETE_LOCAL_MIGRATION');
  }
  const worker = await mf.getWorker();
  let previousRunId;
  let previousSafety;
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    const rpcBefore = rpcRequests;
    const scheduled = await worker.scheduled({ cron: '* * * * *' });
    const healthResponse = await mf.dispatchFetch('https://local.test/health');
    const health = await healthResponse.json();
    const latestResponse = await mf.dispatchFetch('https://local.test/latest');
    const published = await latestResponse.json();
    const latest = await db.prepare('SELECT id,report_json FROM runs ORDER BY completed_at DESC LIMIT 1').first();
    const report = latest ? JSON.parse(latest.report_json) : null;
    const control = await db.prepare('SELECT state_json,lease_owner,lease_until FROM control WHERE id=1').first();
    const state = JSON.parse(control.state_json);
    if (report) await writeFile(join(root, 'latest-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    const result = {
      cycle: i + 1, synthetic: fixture, localRuntime: 'workerd', remoteDeployment: false,
      scheduledOutcome: scheduled.outcome, wallMs: Math.round(performance.now() - started),
      analysisEnabled, forwardedRequests, rpcRequests, cycleRpcRequests: rpcRequests - rpcBefore,
      providerRequests: { ...providerRequests }, safetyFocusPhase: state.safetyFocus?.phase ?? null,
      healthHttpStatus: healthResponse.status, latestHttpStatus: latestResponse.status, health,
      report: report ? { runId: report.runId, observedHead: report.observedHead,
        operationalStatus: report.operationalStatus, snapshots: report.snapshots.length,
        statuses: report.results.map(r => r.status), coverage: report.coverage,
        ...(report.screening ? { screening: { version: report.screening.version, entries: report.screening.entries.map(entry => ({
          address: entry.address, pipeline: entry.pipeline, status: entry.status, strict: entry.strict,
          ageBasis: entry.age?.basis, identityVerified: entry.native?.identityVerified, activeLiquidity: entry.native?.activeLiquidity,
          priceInQuote: entry.native?.priceInQuote, activitySwaps: entry.native?.activity?.swaps,
          externalProvider: entry.externalMarket?.source, unknowns: entry.unknowns.length,
          safety: Object.fromEntries(Object.entries(entry.safety ?? {}).map(([key, value]) => [key, {
            status: value.status, checkedAt: value.checkedAt, reason: value.reason,
            ...(value.coverage ? { coverage: value.coverage } : {}),
            ...(typeof value.coveragePct === 'number' ? { coveragePct: value.coveragePct } : {}) }])) })) } } : {}) } : null,
      ...(published.mvp ? { mvp: published.mvp } : {}), cpuLimitVerified: false
    };
    cycleProofs.push(result);
    await writeFile(fixture ? resolve('runtime/cloudflare-runtime-fixture-proof.json') : join(root, 'cycles-proof.json'), JSON.stringify(cycleProofs, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result));
    assert.equal(scheduled.outcome, 'ok', 'Cron must finish in the real runtime');
    assert.ok(rpcRequests - rpcBefore <= 32, 'Each collection must respect the global RPC request budget');
    assert.equal(healthResponse.status, 200, 'Local D1 health must be current');
    assert.equal(health.status, 'COMPLETED');
    assert.equal(latestResponse.status, 200, 'The public data route must read the committed report');
    assert.ok(report, 'Cron must commit a report in local D1');
    assert.notEqual(report.runId, previousRunId, 'Each cycle must commit a new run');
    assert.equal(published.runId, report.runId);
    assert.equal(published.currentSignalsAvailable, false);
    assert.equal(published.dataStale, false);
    assert.deepEqual(published.observations, report.snapshots);
    assert.deepEqual(published.recordedResults, report.results);
    if (config.vars?.MVP_RECORDING_ENABLED === '1') {
      assert.equal(published.mvp?.recording, true);
      assert.ok(published.mvp.archive.decisions >= 2, 'Both legacy evaluations must enter durable recording');
      assert.ok(published.mvp.archive.outcomeJobs.pending >= 8, 'Each initial decision must schedule four horizons');
    }
    if (analysisEnabled) {
      assert.equal(report.screening?.version, 2, 'Analysis must publish a versioned screening history');
      assert.equal(report.screening.currentSignalsAvailable, false);
      assert.deepEqual(published.screening, report.screening);
      if (report.snapshots.length) assert.ok(report.screening.entries.some(entry => entry.address === report.snapshots[0].address), 'The enriched token must enter the watchlists');
    }
    assert.equal(state.head.number, report.observedHead.number);
    assert.equal(control.lease_owner, null, 'The completed cron must release its lease');
    assert.equal(control.lease_until, 0);
    assert.ok(report.results.every(r => r.status !== 'CANDIDATE'), 'Metadata collection must not imply trade approval');
    if (fixture) {
      assert.equal(report.snapshots.length, 1, 'The deterministic event must create one observation');
      assert.equal(report.results.length, 2, 'Both pipelines must be evaluated');
      assert.ok(report.results.every(r => r.status === 'INCOMPLETE'));
      assert.equal(report.coverage.discoveredPoolsThisRun, i === 0 ? 1 : 0);
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM pools').first()).count, 1);
      if (analysisEnabled) {
        const entry = report.screening.entries.find(item => item.address === token);
        assert.equal(entry.pipeline, 'unclassified', 'A pool age cannot establish a token deployment age');
        assert.equal(entry.age.classification, 'unclassified');
        assert.equal(entry.native.identityVerified, true, 'Factory, tokens and factory index must match');
        assert.equal(entry.native.activeLiquidity, true);
        assert.equal(entry.native.priceInQuote.quoteAsset, 'WETH');
        assert.equal(entry.native.activity.swaps, 0);
        assert.equal(entry.native.activity.complete, true);
        assert.ok(entry.unknowns.length > 0, 'Successful pool reads must retain unknown security properties');
        assert.equal(entry.externalMarket, undefined, 'Unavailable providers must not fabricate USD metrics');
        assert.deepEqual(entry.strict, { new: 'INCOMPLETE', established: 'INCOMPLETE' });
        assert.equal(report.errors.length, 0, 'A failed optional capability must not abort token analysis');
        assert.equal(state.safetyFocus?.phase ?? null, [1, 2, null][i], 'The three security phases must advance and release focus');
        assert.deepEqual(Object.keys(entry.safety).sort(), ['contract', 'holders', 'liquidity', 'simulation']);
        assert.equal(entry.safety.holders.coverage.fromBlockProven, true, 'Genesis absence and complete empty logs can prove coverage start');
        assert.equal(entry.safety.holders.coverage.distributionComplete, false, 'Empty Transfer history cannot reconcile a positive supply');
        assert.ok(entry.safety.holders.gaps.includes('HOLDER_SUPPLY_NOT_RECONCILED'));
        if (i > 0) assert.equal(entry.safety.holders.checkedAt, previousSafety.holders.checkedAt, 'A later phase must preserve the actual holder observation time');
        if (i >= 1) {
          assert.equal(entry.safety.liquidity.coveragePct, 0, 'Only mandatory minimum LP is not genuine protected liquidity');
          assert.equal(entry.safety.liquidity.poolBurnConfirmed, false);
        }
        if (i > 1) {
          assert.equal(entry.safety.liquidity.checkedAt, previousSafety.liquidity.checkedAt, 'Simulation must not refresh the timestamp of an old LP read');
          assert.equal(entry.safety.simulation.status, 'unavailable');
          assert.equal(entry.safety.simulation.reason, 'SIMULATION_RPC_REVERTED_OR_UNSUPPORTED');
          assert.equal(entry.safety.simulation.attempted, true);
          assert.equal(entry.safety.simulation.executionVerified, false);
        }
        // One age query and one source-artifact query in the initial phase;
        // their canonical age proof and negative source cache are then reused.
        assert.equal(providerRequests.sourcify, 2);
        assert.equal(providerRequests.goplus, 1, 'Persistent cooldown prevents immediate cross-cycle retries');
        assert.equal(providerRequests.dexscreener, 1, 'Persistent cooldown prevents immediate cross-cycle retries');
        previousSafety = structuredClone(entry.safety);
      }
    }
    previousRunId = report.runId;
  }
} finally {
  await mf.dispose(); await dispatcher.close();
  if (fixture) await rm(root, { recursive: true, force: true });
}
