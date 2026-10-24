import { NETWORK, QUOTE_ASSETS, isEvmAddress } from '../network.mjs';
import { decodePool } from '../onchain/decode-pool.mjs';
import { runScan } from '../runner.mjs';
import policy from '../../config/policies.json' with { type: 'json' };
import collector from '../../config/collector.json' with { type: 'json' };
import { FreeRpc, hex, quantity, hash } from './rpc.mjs';
import { screenToken, screeningHistory } from './screening.mjs';
import { keccak256 } from 'viem';
import { resumeSafetyFocus, nextSafetyFocus, findSafetyState, saveSafetyState, pendingSafetyPool } from './safety-state.mjs';
import { refreshMarketData } from './providers.mjs';
import { evaluateMarketSignals, mergeIncrementalEvaluationState } from './market-signals.mjs';
import marketSignalPolicy from '../../config/market-signals.json' with { type: 'json' };
import { publicReport } from './public-report.mjs';
import { providerFetch } from '../mvp/provider-fetch.mjs';
import { prepareDecisionRecords } from '../mvp/records.mjs';
import { queryDueOutcomes, prepareOutcomeUpdates, prepareMarketObservations, queryArchivedOutcomePoints } from '../mvp/outcomes.mjs';
import { evaluateNewToken, MVP_SCORE_VERSION, MVP_POLICY_HASH } from '../mvp/pipeline.mjs';
import { prepareDryRunAlerts } from '../mvp/alerts.mjs';
import { decisionKey } from '../mvp/records.mjs';
import { prepareWalletLedger, enrichWalletTransactions, readWalletProfiles } from '../mvp/wallet-ledger.mjs';
import { projectObservedWallets } from '../mvp/wallet-runtime.mjs';
import { prepareWeeklyReport } from '../mvp/weekly-report.mjs';
import { prepareWalletTemporalUpdates, attachWalletTemporalEvidence } from '../mvp/wallet-temporal.mjs';
import { scoreWalletProfile } from '../mvp/wallet-scoring.mjs';
import PROFILES_CONFIG from '../mvp/config.mjs';

const TOPICS = { v2: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
  v3: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
  v4: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438' };
const quote = new Set(Object.values(QUOTE_ASSETS));
const CATALOG_LIMIT = 50000;
const RETENTION_CADENCE_CYCLES = 1440;
export function target(pool) {
  const supported = value => quote.has(value) || pool.type === 'v4' && value === '0x' + '0'.repeat(40);
  const q0 = supported(pool.token0); const q1 = supported(pool.token1);
  return q0 === q1 ? null : q0 ? pool.token1 : pool.token0;
}
export async function boundedLogs(rpc, from, to, maxLogs, backward = false, offset = 0) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const logs = await rpc.request('eth_getLogs', [{ address: collector.venues.map(v => v.address),
        topics: [Object.values(TOPICS)], fromBlock: hex(from), toBlock: hex(to) }]);
      if (!Array.isArray(logs)) throw new Error('INVALID_LOGS');
      if (logs.length > maxLogs && from !== to) throw new Error('RANGE_TOO_LARGE');
      const validated = []; const seen = new Set();
      for (const log of logs) {
        const venue = collector.venues.find(v => v.address === log.address?.toLowerCase());
        if (!venue || log.removed || !hash(log.blockHash) || !hash(log.transactionHash)
          || log.topics?.[0]?.toLowerCase() !== TOPICS[venue.type] || quantity(log.blockNumber) < from || quantity(log.blockNumber) > to) throw new Error('INVALID_LOG');
        const key = `${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
        if (seen.has(key)) continue; seen.add(key);
        validated.push({ log, venue });
      }
      validated.sort((a, b) => quantity(a.log.blockNumber) - quantity(b.log.blockNumber) || quantity(a.log.logIndex) - quantity(b.log.logIndex));
      const page = validated.slice(offset, offset + maxLogs);
      const nextOffset = offset + page.length < validated.length ? offset + page.length : 0;
      return { from, to, pools: page.map(({ log, venue }) => decodePool(log, venue)), nextOffset };
    } catch (error) {
      if (from >= to || !(['RANGE_TOO_LARGE', 'RPC_RESPONSE_LIMIT'].includes(error.message) || [-32005, -32602].includes(error.code))) throw error;
      const middle = Math.floor((from + to) / 2);
      if (backward) from = middle + 1; else to = middle;
    }
  }
  throw new Error('RANGE_TOO_DENSE');
}
function integer(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error('INVALID_CONFIG'); return n;
}
function appendMomentumHistory(previous, snapshot, entry, observedAt, runId) {
  const history = (Array.isArray(previous) ? previous : []).filter(point =>
    point?.canonical === true && Number.isFinite(Date.parse(point.observedAt))
    && observedAt - Date.parse(point.observedAt) >= 0 && observedAt - Date.parse(point.observedAt) <= 900000);
  const holders = entry?.safety?.holders; const market = entry?.externalMarket;
  // A cached holder count at another head cannot become a new growth sample.
  if (holders?.coverage?.distributionComplete === true && holders.blockNumber === snapshot.chainState.blockNumber
    && holders.blockHash === snapshot.chainState.blockHash && Number.isSafeInteger(snapshot.holders?.count)
    && Number.isFinite(market?.liquidityUsd) && typeof market.pairAddress === 'string') {
    const point = { chainId: NETWORK.chainId, address: snapshot.address,
      observedAt: new Date(observedAt).toISOString(), source: 'reconciled-holders-and-dexscreener/v1', evidence: [`d1:runs:${runId}`],
      canonical: true, blockNumber: snapshot.chainState.blockNumber, blockHash: snapshot.chainState.blockHash,
      holdersCount: snapshot.holders.count, holdersComplete: true, holdersCheckedAt: snapshot.holders.checkedAt,
      liquidityUsd: market.liquidityUsd, liquidityFetchedAt: market.fetchedAt, pairAddress: market.pairAddress };
    const kept = history.filter(old => old.address !== point.address || old.holdersCheckedAt !== point.holdersCheckedAt);
    kept.push(point);
    // Two points per token, twenty tokens. This is a cache, not the archive.
    const counts = new Map();
    return kept.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)).filter(old => {
      const count = counts.get(old.address) ?? 0; counts.set(old.address, count + 1); return count < 2;
    }).slice(0, 40);
  }
  return history.slice(0, 40);
}
export async function collectFree(env, { now = Date.now, fetchImpl = fetch, rpc: supplied, walletProofs = {} } = {}) {
  const owner = crypto.randomUUID(); const start = now(); const leaseUntil = start + 300000;
  const held = await env.DB.prepare("UPDATE control SET state_json=CASE WHEN status='COMPLETED' THEN state_json ELSE json_set(state_json,'$.evaluationState',json('{}')) END,lease_owner=?,lease_until=?,status='RUNNING' WHERE id=1 AND lease_until<=? RETURNING state_json,last_success")
    .bind(owner, leaseUntil, start).first();
  if (!held) return { status: 'SKIPPED' };
  try {
    const rpc = supplied ?? new FreeRpc({ url: env.ROBINHOOD_RPC_URL || NETWORK.rpcUrl, fetchImpl, signal: AbortSignal.timeout(60000) });
    const chunk = integer(env.LOG_CHUNK, 2048, 1, 2048); const maxLogs = integer(env.MAX_LOGS, 4, 1, 4);
    const analysisEnabled = env.ANALYSIS_ENABLED === '1';
    const recordingEnabled = env.MVP_RECORDING_ENABLED === '1';
    const mvpPhase = recordingEnabled ? integer(env.MVP_PHASE, 1, 1, 3) : 0;
    const marketTransport = env.MARKET_GATEWAY_URL || 'direct';
    const fetchMarket = providerFetch(fetchImpl, env.MARKET_GATEWAY_URL);
    let saved = JSON.parse(held.state_json); let reorg = false;
    if (quantity(await rpc.request('eth_chainId')) !== NETWORK.chainId) throw new Error('WRONG_CHAIN');
    const head = await rpc.block();
    if (head.timestamp * 1000 > now() + 30000 || now() - head.timestamp * 1000 > 60000) throw new Error('STALE_HEAD');
    if (saved.head) {
      const prior = saved.head.number <= head.number ? await rpc.block(saved.head.number) : null;
      if (!prior || prior.hash !== saved.head.hash) { saved = {}; reorg = true; }
    }
    const sequence = (saved.sequence ?? 0) + 1;
    const initialFrom = Math.max(0, head.number - chunk + 1);
    const from = Math.min(head.number, saved.recentNext ?? initialFrom);
    // Uma amostra independente junto da cabeça evita que o backlog impeça
    // observar lançamentos recentes. Não avança nem substitui o cursor contínuo.
    const sampleLatest = sequence % 2 === 1 && maxLogs >= 3 && head.number - from >= chunk;
    const latestSample = sampleLatest
      ? await boundedLogs(rpc, Math.max(0, head.number - 63), head.number, 1, true)
      : null;
    // Orçamento global de CPU/escritas; reservar também um evento histórico.
    const recentBudget = (sequence % 2 === 1 && maxLogs > 1 ? maxLogs - 1 : maxLogs) - (latestSample?.pools.length ?? 0);
    const recent = await boundedLogs(rpc, from, saved.recentOffset ? from : Math.min(head.number, from + chunk - 1), recentBudget, false, saved.recentOffset ?? 0);
    const olderBudget = maxLogs - recent.pools.length - (latestSample?.pools.length ?? 0);
    let olderSequence = saved.olderSequence ?? 0;
    let backfillCursor = saved.backfillCursor ?? initialFrom - 1;
    let historicalCursor = saved.historicalCursor;
    let backfillOffset = saved.backfillOffset ?? 0; let historicalOffset = saved.historicalOffset ?? 0;
    let older = null;
    // A amostra histórica é separada do backfill contíguo. A altura é estimada
    // por tempo médio e nunca é usada como data de criação do token.
    if (olderBudget > 0 && historicalCursor === undefined && head.number > 10000) {
      const anchor = await rpc.block(head.number - 10000);
      const secondsPerBlock = (head.timestamp - anchor.timestamp) / 10000;
      if (!(secondsPerBlock > 0)) throw new Error('INVALID_BLOCK_TIMING');
      historicalCursor = Math.max(0, head.number - Math.round(14 * 86400 / secondsPerBlock));
    }
    const sample = olderSequence % 2 === 0 && historicalCursor !== undefined;
    const end = sample ? historicalCursor : backfillCursor;
    if (olderBudget > 0 && end >= 0) {
      const offset = sample ? historicalOffset : backfillOffset;
      older = await boundedLogs(rpc, offset ? end : Math.max(0, end - chunk + 1), end, olderBudget, true, offset);
      olderSequence++;
      if (sample) { historicalCursor = older.nextOffset ? older.from : older.from - 1; historicalOffset = older.nextOffset; }
      else { backfillCursor = older.nextOffset ? older.from : older.from - 1; backfillOffset = older.nextOffset; }
    }
    const discovered = [...(latestSample?.pools ?? []), ...recent.pools, ...(older?.pools ?? [])].filter(p => isEvmAddress(target(p)));
    let selected;
    if (!reorg && sequence % 2 === 0) selected = await env.DB.prepare('SELECT pool_json FROM pools ORDER BY last_enriched,created_block LIMIT 1').first();
    if (analysisEnabled && !reorg && sequence % 4 === 1) {
      // Esta estimativa apenas escolhe uma pool para ler. A classificação usa
      // depois recibos ou timestamps/código históricos efetivamente verificados.
      const seconds = saved.head && head.number > saved.head.number
        ? (head.timestamp - saved.head.timestamp) / (head.number - saved.head.number) : 0.1;
      const blockSeconds = seconds >= 0.01 && seconds <= 10 ? seconds : 0.1;
      const earliest = Math.max(0, head.number - Math.ceil(48 * 3600 / blockSeconds));
      const latest = Math.max(0, head.number - Math.ceil(20 * 60 / blockSeconds));
      selected = await env.DB.prepare('SELECT pool_json FROM pools WHERE created_block BETWEEN ? AND ? ORDER BY created_block DESC LIMIT 1')
        .bind(earliest, latest).first();
    }
    const resumedFocus = analysisEnabled && !reorg ? resumeSafetyFocus(saved.safetyFocus, now()) : null;
    if (resumedFocus) selected = { pool_json: JSON.stringify(resumedFocus.pool) };
    else if (analysisEnabled && !reorg) {
      const activeSetup = (saved.screeningEntries ?? []).filter(entry => entry.status !== 'BLOCKED'
        && now() - Date.parse(entry.observedAt) > 8 * 60000
        && now() - Date.parse(entry.externalMarket?.fetchedAt) <= 120000
        && entry.externalMarket?.liquidityUsd >= (entry.pipeline === 'new' ? 50000 : 150000))
        .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))[0];
      const activePool = activeSetup ? await env.DB.prepare('SELECT pool_json FROM pools WHERE id=?').bind(activeSetup.poolId).first() : null;
      const pendingPool = pendingSafetyPool(saved.safetyStates, sequence, now());
      if (activePool) selected = activePool;
      else if (pendingPool) selected = { pool_json: JSON.stringify(pendingPool) };
    }
    const safetyPhase = resumedFocus?.phase ?? 0;
    const pool = selected ? JSON.parse(selected.pool_json) : discovered[0];
    let safetyStates = reorg ? [] : saved.safetyStates;
    let providerState = saved.providerState;
    if (providerState && saved.marketTransport !== marketTransport) {
      providerState = structuredClone(providerState);
      providerState.cooldowns = { ...providerState.cooldowns,
        dexscreener: { until: 0, nextRequestAt: 0, failures: 0 } };
    }
    const snapshots = []; const tokenFacts = []; const errors = []; let analysis;
    const walletCapture = { events: [], ranges: [] }; let walletCaptureError = false;
    const captureWalletEvents = batch => {
      if (walletCapture.events.length + batch.events.length > 128 || walletCapture.ranges.length >= 16) {
        walletCaptureError = true; throw new Error('WALLET_CAPTURE_LIMIT');
      }
      walletCapture.events.push(...batch.events); walletCapture.ranges.push(batch.range);
    };
    if (pool) {
      try {
        const created = await rpc.block(pool.createdBlock);
        if (created.hash !== pool.createdBlockHash) throw new Error('POOL_REORG');
        const address = target(pool);
        const facts = await rpc.batch([['eth_getCode', [address, hex(head.number)]],
          ['eth_call', [{ to: address, data: '0x313ce567' }, hex(head.number)]],
          ['eth_call', [{ to: address, data: '0x18160ddd' }, hex(head.number)]]]);
        const bytecode = facts[0].value;
        if (typeof bytecode !== 'string' || !/^0x([0-9a-f]{2})*$/i.test(bytecode)) throw new Error('BYTECODE_UNAVAILABLE');
        const stamp = { checkedAt: new Date(head.timestamp * 1000).toISOString(), source: 'cloudflare-readonly-rpc/v1', evidence: [`d1:runs:${owner}`] };
        const snapshot = { schemaVersion: 2, synthetic: false, chain: NETWORK.chain, chainId: NETWORK.chainId, environment: NETWORK.environment,
          address, chainState: { ...stamp, rpcChainId: NETWORK.chainId, headTimestamp: stamp.checkedAt,
            blockNumber: head.number, blockHash: head.hash, finalityStage: 'sequencer', reorgDetected: reorg },
          security: { ...stamp, hasBytecode: bytecode !== '0x' },
          market: { ...stamp,
            ...(pool.type === 'v4' && pool.hooks !== '0x' + '0'.repeat(40) ? { hasUnreviewedHooks: true } : {}) },
          holders: {}, activity: {}, liquidityProtection: {}, quote: {},
          collection: { classification: 'unclassified-erc20-candidate', poolId: pool.id,
            selectedPoolCreatedAt: new Date(created.timestamp * 1000).toISOString(),
            gaps: ['Deployment do contrato sem prova; idade da pool não usada como idade do token',
              'Segurança conclusiva, holders/insiders, LP, simulações e USD não comprovados',
              'Aprovação de negociação exige todas as provas da política, mesmo quando a monitorização tem métricas disponíveis'] } };
        if (analysisEnabled) {
          try {
            const codeHash = keccak256(bytecode);
            const safetyState = findSafetyState(safetyStates, address, pool.id, codeHash, now());
            analysis = await screenToken(rpc, pool, head, created, facts,
              { address, now, fetchImpl, safetyState, safetyPhase, providerState,
                include23HourBoundary: mvpPhase >= 2,
                ...(mvpPhase >= 3 ? { onValidatedEvents: captureWalletEvents } : {}),
                evidenceRef: `d1:runs:${owner}` });
            providerState = analysis.providerState ?? providerState;
            Object.assign(snapshot, analysis.snapshot);
            snapshot.security = { ...stamp, hasBytecode: bytecode !== '0x', ...analysis.snapshot.security };
            snapshot.market = { ...stamp, hasUnreviewedHooks: pool.type === 'v4' && pool.hooks !== '0x' + '0'.repeat(40),
              ...analysis.snapshot.market };
            for (const section of ['holders', 'liquidityProtection', 'quote'])
              if (analysis.snapshot[section] && Object.keys(analysis.snapshot[section]).length)
                snapshot[section] = { ...stamp, ...analysis.snapshot[section] };
            safetyStates = saveSafetyState(safetyStates, { address, poolId: pool.id, pool, codeHash,
              updatedAt: new Date(now()).toISOString(), ...analysis.safetyState }, now());
            tokenFacts.push({ address, analysis: analysis.evidence });
          } catch { errors.push('TOKEN_ANALYSIS_FAILED'); }
        }
        snapshots.push(snapshot);
        // The calls are already retained in the bounded RPC audit. Duplicating
        // their raw output here could exhaust the outer evidence budget even
        // when a malformed token returns a very large decimals/supply value.
        tokenFacts.push({ address, metadataEvidence: 'rpc.audit:eth_call:0x313ce567,0x18160ddd',
          blockNumber: head.number, bytecodeBytes: (bytecode.length - 2) / 2 });
      } catch { errors.push('TOKEN_ENRICHMENT_FAILED'); }
    }
    if (walletCaptureError) throw new Error('WALLET_CAPTURE_LIMIT');
    const walletEnrichment = mvpPhase >= 3 ? await enrichWalletTransactions(env.DB, rpc,
      { events: walletCapture.events, head, now, maxTransactions: 2, maxRequests: 30 })
      : { receipts: [], attempts: [], diagnostics: [] };
    const pinned = await rpc.block(head.number); const final = await rpc.block();
    if (pinned.hash !== head.hash) throw new Error('REORG_DURING_COLLECTION');
    if (final.number > head.number && final.timestamp >= head.timestamp && now() - final.timestamp * 1000 <= 60000 && final.timestamp * 1000 <= now() + 30000)
      for (const snapshot of snapshots) snapshot.chainState.sequencerHealthy = true;
    const scan = runScan(snapshots, policy, { now: now(), state: reorg ? {} : saved.evaluationState ?? {} });
    let screeningEntries = analysisEnabled ? screeningHistory(reorg ? [] : saved.screeningEntries, analysis?.entry, scan.results, now()) : undefined;
    let marketData; let marketSignals;
    const outcomeJobs = recordingEnabled ? await queryDueOutcomes(env.DB, { now, limit: 4, maxJobs: 24 }) : [];
    let outcomeUpdates = { commands: [], diagnostics: [] };
    let marketObservations = { commands: [], counts: {}, diagnostics: [] };
    if (analysisEnabled) {
      const visibleAddresses = new Set(screeningEntries.map(entry => entry.address));
      // Expired jobs need a historical point; fetching their current price
      // consumes the free-provider quota without recovering the missed label.
      const outcomeAddresses = new Set(outcomeJobs.filter(job => job.captureState === 'LIVE').map(job => job.address));
      const outcomeTargets = [...outcomeAddresses].map(address => screeningEntries.find(entry => entry.address === address) ?? { address });
      const marketTargets = [...outcomeTargets, ...screeningEntries.filter(entry => !outcomeAddresses.has(entry.address))];
      const requestedAddresses = new Set([...new Set(marketTargets.map(entry => entry.address))].slice(0, 20));
      const refreshed = await refreshMarketData(marketTargets,
        providerState, { fetchImpl: fetchMarket, now });
      providerState = refreshed.providerState;
      marketData = refreshed.diagnostics;
      // Persist bounded observations, not repeated derived criteria. Each run
      // archives its full evaluated signal while confirmation state stays small.
      screeningEntries = screeningHistory(refreshed.entries.filter(entry => visibleAddresses.has(entry.address)), null, [], now());
      marketSignals = evaluateMarketSignals(screeningEntries, reorg ? {} : saved.marketSignalState, { now: now() });
      if (recordingEnabled) {
        marketObservations = prepareMarketObservations(env.DB,
          refreshed.entries.filter(entry => requestedAddresses.has(entry.address)),
          { runId: owner, observedAt: now(), refreshed: refreshed.diagnostics.status === 'REFRESHED' });
        const archived = await queryArchivedOutcomePoints(env.DB, outcomeJobs, { now });
        outcomeUpdates = prepareOutcomeUpdates(env.DB, outcomeJobs.map((job, index) => {
          const market = job.captureState === 'LIVE'
            ? refreshed.entries.find(entry => entry.address === job.address)?.externalMarket : null;
          const sourceAt = Date.parse(market?.fetchedAt);
          const inWindow = Number.isFinite(sourceAt) && sourceAt >= job.dueAt && sourceAt <= job.dueAt + job.allowedLagMs;
          return { job, observation: market && inWindow ? { priceUsd: market.priceUsd, liquidityUsd: market.liquidityUsd,
            sourceTimestamp: market.fetchedAt, source: { provider: market.source, pairAddress: market.pairAddress,
              chainId: market.chainId, baseTokenAddress: market.baseTokenAddress } } : archived[index]?.observation ?? null };
        }), { runId: owner, now });
      }
    }
    const projectedWallets = mvpPhase >= 3 ? await projectObservedWallets(env.DB, walletEnrichment.receipts,
      { now: now(), reorgDetected: reorg, receiptEvidence: walletProofs.receiptEvidence,
        walletEvidence: walletProofs.walletEvidence, replayEvidence: walletProofs.replayEvidence })
      : { profiles: [], diagnostics: [], realizedEvents: [] };
    const temporal = mvpPhase >= 3 ? await prepareWalletTemporalUpdates(env.DB, { runId: owner,
      observedAt: now(), profiles: projectedWallets.profiles, realizedEvents: projectedWallets.realizedEvents,
      config: PROFILES_CONFIG, reorgDetected: reorg }) : { profiles: [], realizationUpdates: [], diagnostics: [] };
    projectedWallets.profiles = temporal.profiles.map(profile => ({ ...profile,
      eligible: scoreWalletProfile(profile, { now: now(), config: PROFILES_CONFIG }).eligible }));
    let mvpMomentum = reorg ? [] : saved.mvpMomentum ?? [];
    const mvpDecisions = [];
    if (mvpPhase >= 2) for (const snapshot of snapshots) {
      const existingProfiles = mvpPhase >= 3 && !reorg ? await readWalletProfiles(env.DB, { tokenAddress: snapshot.address }) : [];
      const mergedProfiles = new Map(existingProfiles.map(profile => [profile.walletAddress, profile]));
      for (const profile of projectedWallets.profiles) if (walletEnrichment.receipts.some(value =>
        value.tokenAddress === snapshot.address && value.receipt.from?.toLowerCase() === profile.walletAddress)
        || profile.tokenEntries?.some(value => value.tokenAddress === snapshot.address))
        mergedProfiles.set(profile.walletAddress, profile);
      const scoringProfiles = mvpPhase >= 3
        ? await attachWalletTemporalEvidence(env.DB, [...mergedProfiles.values()],
          { now: now(), config: PROFILES_CONFIG, reorgDetected: reorg })
        : [...mergedProfiles.values()];
      const entry = screeningEntries?.find(value => value.address === snapshot.address) ?? {};
      if (mvpPhase >= 3) mvpMomentum = appendMomentumHistory(mvpMomentum, snapshot, entry, now(), owner);
      mvpDecisions.push(evaluateNewToken(snapshot, entry,
        { now: now(), walletProfiles: scoringProfiles,
          walletEntries: scoringProfiles.flatMap(profile => profile.tokenEntries ?? []),
          momentumObservations: mvpMomentum.filter(point => point.address === snapshot.address) }));
    }
    const dryRunAlerts = mvpPhase >= 2 ? prepareDryRunAlerts(env.DB, mvpDecisions.map(decision => ({
      ...decision, decisionId: decisionKey(NETWORK.chainId, decision.address, decision.scoreVersion, decision.profile),
      wallets: decision.wallets.wallets })), { runId: owner, observedAt: now() }) : null;
    const weekly = mvpPhase >= 3 ? await prepareWeeklyReport(env.DB, { now }) : null;
    const report = { runId: owner, completedAt: new Date(now()).toISOString(), chainId: NETWORK.chainId,
      operationalStatus: errors.length ? 'DEGRADED' : 'PARTIAL', observedHead: head, snapshots,
      results: scan.results, alerts: scan.alerts, errors,
      ...(analysisEnabled ? { screening: { version: 2, analysisRevision: 'market-signals-v1',
        safetyPhase, asOf: new Date(now()).toISOString(), entries: marketSignals.entries,
        currentSignalsAvailable: false, marketSignalsAvailable: false,
        scope: 'Alertas de mercado avaliados separadamente da aprovação estrita para trade.' },
        marketData, signals: { policy: marketSignalPolicy } } : {}),
      ...(recordingEnabled ? { mvp: { phase: mvpPhase, dryRun: true, recording: true,
        scoreVersion: mvpPhase >= 2 ? MVP_SCORE_VERSION : policy.version, outcomeWindows: ['15m', '1h', '24h', '7d'],
        outcomeCollection: { jobs: outcomeJobs.length,
          liveJobs: outcomeJobs.filter(job => job.captureState === 'LIVE').length,
          expiredJobs: outcomeJobs.filter(job => job.captureState === 'EXPIRED').length,
          marketObservations: marketObservations.counts, diagnostics: outcomeUpdates.diagnostics },
        ...(mvpPhase >= 2 ? { profile: 'profile_new',
          filters: { evaluated: mvpDecisions.length, rejected: mvpDecisions.filter(d => d.status === 'REJECTED').length,
            incomplete: mvpDecisions.filter(d => d.status === 'INCOMPLETE').length,
            outOfScope: mvpDecisions.filter(d => d.status === 'OUT_OF_SCOPE').length },
          outbox: { dryRun: true, prepared: dryRunAlerts.accepted.length,
            diagnostics: dryRunAlerts.diagnostics },
          ...(mvpPhase >= 3 ? { walletCollection: { events: walletCapture.events.length, ranges: walletCapture.ranges.length,
            receipts: walletEnrichment.receipts.length, profilesUpdated: projectedWallets.profiles.length,
            realizedDisposals: projectedWallets.realizedEvents.length,
            temporalProfilesUpdated: temporal.realizationUpdates.length,
            scoreMethod: PROFILES_CONFIG.profiles.profile_new.walletScoring.version,
            diagnostics: [...walletEnrichment.diagnostics, ...projectedWallets.diagnostics, ...temporal.diagnostics] },
            weekly: { due: weekly.due, reportKey: weekly.report?.reportKey ?? null,
              generatedAt: weekly.report?.generatedAt ?? null } } : {}),
          decisions: mvpDecisions.filter(d => !['REJECTED', 'OUT_OF_SCOPE'].includes(d.status)).map(d => ({
            address: d.address, symbol: d.symbol, status: d.status, score: d.score,
            scoreComplete: d.scoreComplete, securityComplete: d.securityComplete,
            walletsComplete: d.walletsComplete, reasons: d.reasons, gaps: d.gaps })) } : {}),
        futurePhasesEnabled: false } } : {}),
      coverage: { recentRange: [recent.from, recent.to],
        recentBacklogBlocks: head.number - recent.to, olderRange: older ? [older.from, older.to] : null,
        latestSampleRange: latestSample ? [latestSample.from, latestSample.to] : null,
        latestSampleRequestedRange: latestSample ? [Math.max(0, head.number - 63), head.number] : null,
        latestSampleBlockPartial: Boolean(latestSample?.nextOffset), latestSampleLogOffset: latestSample?.nextOffset ?? 0,
        latestSampleIsCompleteIndex: false,
        recentBlockPartial: Boolean(recent.nextOffset), recentLogOffset: recent.nextOffset,
        olderMode: !older ? 'deferred-or-complete' : sample ? 'approximate-14-day-sample' : 'contiguous-backfill',
        discoveredPoolsThisRun: discovered.length, historicalCoverageComplete: false,
        catalogLimit: CATALOG_LIMIT, retentionCadenceCycles: RETENTION_CADENCE_CYCLES,
        scope: 'Configured Uniswap deployments; one token enriched; not a complete memecoin index' } };
    const evidence = JSON.stringify({ rpc: rpc.audit, tokenFacts });
    if (new TextEncoder().encode(evidence).length > 262144) throw Object.assign(new Error('EVIDENCE_BUDGET_EXCEEDED'), {
      diagnostics: { rpcAuditBytes: new TextEncoder().encode(JSON.stringify(rpc.audit)).length,
        tokenFactsBytes: new TextEncoder().encode(JSON.stringify(tokenFacts)).length } });
    const published = publicReport(report, now());
    if (analysisEnabled) {
      report.signals = published.signals;
      report.screening.currentSignalsAvailable = published.currentSignalsAvailable;
      report.screening.marketSignalsAvailable = published.marketSignalsAvailable;
    }
    const state = { sequence, olderSequence, recentNext: recent.nextOffset ? recent.to : recent.to + 1, recentOffset: recent.nextOffset,
      ...(mvpPhase >= 3 ? { mvpMomentum } : {}),
      backfillCursor, backfillOffset, historicalCursor, historicalOffset, head,
      evaluationState: mergeIncrementalEvaluationState(saved.evaluationState, scan.state,
        { now: now(), policyHash: scan.policyHash, pipelines: policy.pipelines, reorg }),
      ...(analysisEnabled ? { screeningEntries, safetyStates,
        providerState, marketTransport, marketSignalState: marketSignals.state,
        signalAvailability: {
          tradeExpiresAt: Math.max(0, ...published.signals.tradeCandidates.map(value => Date.parse(value.evidenceExpiresAt))),
          marketExpiresAt: Math.min(head.timestamp * 1000 + 60000,
            Math.max(0, ...published.signals.marketAlerts.map(value => Date.parse(value.expiresAt)))) },
        safetyFocus: analysis?.entry ? nextSafetyFocus(pool, safetyPhase, resumedFocus?.startedAt, now()) : null } : {}) };
    // D1 batch é uma transação. CHECK aborta toda a transação se o lease foi perdido.
    const commands = [env.DB.prepare("INSERT OR REPLACE INTO commit_fence(id,ok) VALUES(1,(SELECT CASE WHEN lease_owner=? AND lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) THEN 1 ELSE 0 END FROM control WHERE id=1))").bind(owner)];
    if (mvpPhase >= 3) commands.push(...prepareWalletLedger(env.DB, { runId: owner, observedAt: now(),
      ...walletCapture, ...walletEnrichment, profiles: projectedWallets.profiles,
      realizedEvents: projectedWallets.realizedEvents, realizationUpdates: temporal.realizationUpdates,
      reorgDetected: reorg }).commands,
      ...weekly.commands);
    if (recordingEnabled) {
      const observedAt = now();
      const source = { collector: 'cloudflare-readonly-rpc', runId: owner,
        blockNumber: head.number, blockHash: head.hash, reorgDetected: reorg };
      const records = prepareDecisionRecords(env.DB, { runId: owner, observedAt, source,
        ...(mvpPhase >= 3 ? { eventFeaturesEncoding: 'gzip-base64/v1' } : {}),
        scoreVersion: policy.version, policyHash: scan.policyHash,
        seenTokens: [...discovered, ...(pool ? [pool] : [])].map(item => ({ address: target(item), poolId: item.id, source })),
        decisions: scan.results.map(result => {
          const snapshot = snapshots.find(item => item.address === result.address);
          const entry = screeningEntries?.find(item => item.address === result.address);
          const createdAt = Date.parse(entry?.age?.contractCreatedAt);
          const isLaunch = result.pipeline === 'new' && (Number.isFinite(createdAt)
            ? observedAt - createdAt >= 0 && observedAt - createdAt < 86400000
            : entry?.age?.lowerBoundMinutes >= 0 && entry.age.upperBoundMinutes < 1440);
          return { address: result.address, profile: `legacy_${result.pipeline}`, status: result.status,
            isLaunch: Boolean(isLaunch), features: { snapshot, externalMarket: entry?.externalMarket ?? null,
              score: result.score, reasons: result.reasons, age: entry?.age ?? null,
              riskCodes: entry?.risks?.map(risk => risk.code) ?? [], evaluatedAt: result.evaluatedAt } };
        }) });
      commands.push(...records.commands, ...marketObservations.commands, ...outcomeUpdates.commands);
      if (mvpPhase >= 2) {
        const mvpRecords = prepareDecisionRecords(env.DB, { runId: owner, observedAt, source,
          eventFeaturesEncoding: 'gzip-base64/v1',
          scoreVersion: MVP_SCORE_VERSION, policyHash: MVP_POLICY_HASH,
          decisions: mvpDecisions.map(decision => {
            const entry = screeningEntries?.find(item => item.address === decision.address);
            return { address: decision.address, profile: decision.profile, status: decision.status,
              isLaunch: decision.security.age?.lowerBoundMinutes >= 0
                && decision.security.age?.upperBoundMinutes < 1440,
              features: { snapshot: snapshots.find(item => item.address === decision.address),
                externalMarket: entry?.externalMarket ?? null, decision } };
          }) });
        commands.push(...mvpRecords.commands, ...dryRunAlerts.commands);
      }
    }
    if (reorg) commands.push(env.DB.prepare('DELETE FROM pools'));
    for (const p of discovered) commands.push(env.DB.prepare('INSERT INTO pools(id,address,created_block,pool_json) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(p.id, target(p), p.createdBlock, JSON.stringify(p)));
    if (pool) commands.push(env.DB.prepare('UPDATE pools SET last_enriched=? WHERE id=?').bind(now(), pool.id));
    // Poda seletiva amortizada: preservar enriquecimentos recentes, mesmo de
    // pools antigas. O índice pools_rotation também serve a ordem inversa.
    if (sequence % RETENTION_CADENCE_CYCLES === 0) commands.push(env.DB.prepare('DELETE FROM pools WHERE id IN (SELECT id FROM pools ORDER BY last_enriched DESC,created_block DESC LIMIT -1 OFFSET ?)').bind(CATALOG_LIMIT));
    commands.push(env.DB.prepare('INSERT INTO runs(id,completed_at,head_number,report_json,evidence_json) VALUES(?,?,?,?,?)').bind(owner, now(), head.number, JSON.stringify(report), evidence));
    commands.push(env.DB.prepare('DELETE FROM runs WHERE completed_at<?').bind(now() - 3 * 3600000));
    commands.push(env.DB.prepare("UPDATE control SET state_json=?,last_success=?,status='COMPLETED',last_error=NULL,lease_owner=NULL,lease_until=0 WHERE id=1").bind(JSON.stringify(state), now()));
    const committed = await env.DB.batch(commands);
    return { status: 'COMPLETED', runId: owner, head: head.number, snapshots: snapshots.length, ...report.coverage,
      ...(mvpPhase >= 3 ? { event: 'COLLECTION_COMPLETED', phase: mvpPhase,
        d1RowsWritten: committed.every(value => Number.isFinite(value.meta?.rows_written))
          ? committed.reduce((total, value) => total + value.meta.rows_written, 0) : null,
        walletEvents: walletCapture.events.length, walletReceipts: walletEnrichment.receipts.length } : {}) };
  } catch (error) {
    if (error.message === 'INVALID_RPC_ENVELOPE' && error.rpcDiagnostic)
      console.warn(JSON.stringify({ event: 'RPC_ENVELOPE_REJECTED', ...error.rpcDiagnostic }));
    // Nenhum cursor avança. Reiniciar confirmação, preservando o catálogo.
    const safeCodes = new Set(['INVALID_CONFIG', 'WRONG_CHAIN', 'STALE_HEAD', 'INVALID_BLOCK_TIMING', 'INVALID_BLOCK',
      'INVALID_LOG', 'INVALID_LOGS', 'RANGE_TOO_DENSE', 'RPC_RESPONSE_LIMIT', 'RPC_HTTP_ERROR', 'INVALID_RPC_ENVELOPE',
      'RPC_TRANSPORT_FAILED', 'RPC_REMOTE_ERROR', 'RPC_BUDGET_EXCEEDED', 'REORG_DURING_COLLECTION', 'EVIDENCE_BUDGET_EXCEEDED']);
    const code = safeCodes.has(error.message) || /^RPC_HTTP_[1-5]\d{2}$/.test(error.message) ? error.message : 'COLLECTION_FAILED';
    const previous = JSON.parse(held.state_json); previous.evaluationState = {};
    await env.DB.prepare("UPDATE control SET status='ERROR',last_error=?,state_json=?,lease_owner=NULL,lease_until=0 WHERE id=1 AND lease_owner=?")
      .bind(code, JSON.stringify(previous), owner).run();
    return { status: 'ERROR', reason: code, ...(code === 'EVIDENCE_BUDGET_EXCEEDED' && error.diagnostics ? { diagnostics: error.diagnostics } : {}) };
  }
}
