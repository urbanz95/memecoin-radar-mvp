import { randomUUID, createHash } from 'node:crypto';
import { NETWORK } from '../network.mjs';
import { SECTIONS } from '../engine.mjs';
import { runScan } from '../runner.mjs';
import { RpcClient, hex } from './rpc.mjs';
import { discover } from './discovery.mjs';
import { tokenMetadata, deploymentEvidence } from './reader.mjs';
import { targetFor, poolState, poolActivity, quotePrice } from './pools.mjs';

export function validateCollectorConfig(config) {
  if (config?.chainId !== NETWORK.chainId) throw new Error('Collector exige mainnet 4663');
  const bounds = {
    recentHours: [0.01, 720], chunkSize: [1, 1000000], maxRecentChunksPerVenue: [1, 1000],
    backfillChunksPerVenue: [0, 1000], maxTokensPerRun: [1, 100], maxPoolsPerToken: [1, 10],
    establishedSampleDays: [7, 365], historicalSampleChunksPerVenue: [0, 100],
    maxSwapsPerPool: [1, 50000], maxRpcRequests: [10, 100000], timeoutMs: [100, 120000],
    retries: [0, 5], pollSeconds: [10, 86400], reorgOverlapBlocks: [1, 10000],
  };
  for (const [field, [min, max]] of Object.entries(bounds)) {
    if (!Number.isFinite(config[field]) || config[field] < min || config[field] > max || (field !== 'recentHours' && !Number.isInteger(config[field]))) throw new Error(`Collector: ${field} inválido`);
  }
  const venues = new Set();
  for (const venue of config.venues ?? []) {
    if (!['v2', 'v3', 'v4'].includes(venue.type) || !/^0x[0-9a-f]{40}$/.test(venue.address) || (venue.type === 'v4' && !/^0x[0-9a-f]{40}$/.test(venue.stateView))) throw new Error('Deployment de venue inválido');
    const key = `${venue.type}:${venue.address}`;
    if (venues.has(key)) throw new Error('Venue duplicada');
    venues.add(key);
  }
  if (!venues.size) throw new Error('Collector sem venues');
  return config;
}

export function selectTargets(catalog, previousObservations, limit) {
  const targets = new Map();
  for (const pool of catalog) {
    const target = targetFor(pool);
    if (!target || /^0x0{40}$/.test(target.address)) continue;
    const found = targets.get(target.address) ?? { address: target.address, pools: [] };
    found.pools.push(pool); targets.set(target.address, found);
  }
  const all = [...targets.values()].sort((a, b) => Math.max(...b.pools.map((p) => p.createdBlock)) - Math.max(...a.pools.map((p) => p.createdBlock)));
  const newSlots = Math.max(1, Math.floor(limit / 2));
  const selected = all.slice(0, newSlots);
  const selectedSet = new Set(selected.map((t) => t.address));
  const others = all.filter((t) => !selectedSet.has(t.address)).sort((a, b) => {
    const lastA = previousObservations[a.address]?.lastEnrichedAtMs ?? 0;
    const lastB = previousObservations[b.address]?.lastEnrichedAtMs ?? 0;
    return lastA - lastB || Math.min(...a.pools.map((p) => p.createdBlock)) - Math.min(...b.pools.map((p) => p.createdBlock));
  });
  return { selected: [...selected, ...others.slice(0, limit - selected.length)], totalTargets: all.length };
}

export async function collectOnce({ config, policy, previous = {}, rpc: suppliedRpc, now = () => Date.now(), signal }) {
  validateCollectorConfig(config);
  const startedAt = new Date(now()).toISOString();
  const runId = startedAt.replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const collectorHash = createHash('sha256').update(JSON.stringify({ version: 1, chainId: config.chainId, venues: config.venues })).digest('hex');
  const saved = previous.collectorHash === collectorHash ? previous : {};
  const rpc = suppliedRpc ?? new RpcClient({ ...config, url: process.env.ROBINHOOD_RPC_URL || NETWORK.rpcUrl, signal });
  const ref = (section) => ({ checkedAt: new Date(head.timestamp * 1000).toISOString(), source: `onchain-json-rpc/v1:${section}`,
    evidence: [`runs/${runId}.rpc.json#${section}`] });
  let head;
  try {
    await rpc.assertMainnet();
    head = await rpc.block();
    if (head.timestamp * 1000 > now() + 30000) throw new Error('Timestamp da rede está no futuro');
    const discovery = await discover(rpc, head, config, saved.discovery);
    const priorObservations = discovery.reorgDetected ? {} : saved.observations ?? {};
    const collectableCatalog = discovery.catalog.filter((p) => !discovery.venues[`${p.type}:${p.factory}`]?.error);
    const { selected, totalTargets } = selectTargets(collectableCatalog, priorObservations, config.maxTokensPerRun);
    const boundaries = {};
    for (const [name, seconds] of Object.entries({ '5m': 300, '10m': 600, '1h': 3600, '24h': 86400 })) {
      boundaries[name] = await rpc.findBlockAtOrAfter(Math.max(0, head.timestamp - seconds), head);
    }
    const metadata = new Map();
    const readToken = async (address) => {
      if (!metadata.has(address)) metadata.set(address, await tokenMetadata(rpc, address, head));
      return metadata.get(address);
    };
    const snapshots = [];
    const observations = { ...priorObservations };
    const tokenErrors = [];
    const details = [];
    for (const target of selected) {
      const firstCall = rpc.id + 1;
      try {
        const token = await readToken(target.address);
        const cached = observations[target.address];
        let creation = !token.hasBytecode ? { status: 'no-bytecode' } : cached?.codeHash === token.codeHash && cached?.creation?.contractCreatedAt
          ? cached.creation : await deploymentEvidence(rpc, target.address, head, {
            codeHash: token.codeHash, candidateCreations: [...target.pools].sort((a, b) => a.createdBlock - b.createdBlock).map((p) => p.creationTransactionHash) });
        if (!creation.evidenceFile) creation = { ...creation, evidenceFile: `runs/${runId}.rpc.json` };
        const pools = [];
        const oldestKnown = target.pools.reduce((a, b) => a.createdBlock < b.createdBlock ? a : b);
        const oldestBlock = await rpc.block(oldestKnown.createdBlock);
        if (oldestBlock.hash.toLowerCase() !== oldestKnown.createdBlockHash) throw new Error('Pool antiga fora da cadeia canónica');
        for (const pool of target.pools.slice(0, config.maxPoolsPerToken)) {
          try {
            const created = await rpc.block(pool.createdBlock);
            if (created.hash.toLowerCase() !== pool.createdBlockHash) throw new Error('Pool de bloco não canónico');
            const quote = targetFor(pool);
            const quoteMeta = await readToken(quote.quoteAssetAddress);
            const state = await poolState(rpc, pool, head);
            const activity = await poolActivity(rpc, pool, head, boundaries, quoteMeta.decimals, config);
            const price = quotePrice(pool, state, token.decimals, quoteMeta.decimals);
            pools.push({ ...pool, createdAt: new Date(created.timestamp * 1000).toISOString(), ...quote, state, priceInQuote: price,
              quoteDecimals: quoteMeta.decimals, activity });
          } catch (error) { pools.push({ id: pool.id, type: pool.type, error: error.code ?? 'POOL_ENRICHMENT_FAILED' }); }
        }
        const usable = pools.find((p) => !p.error);
        const evidence = { firstCall, lastCall: rpc.id, address: target.address };
        details.push({ token, creation, pools, evidence });
        const security = { ...ref('security'), hasBytecode: token.hasBytecode,
          ...(token.erc20InterfaceObserved ? { tokenStandard: 'erc20' } : {}),
          // Só evidência positiva permite assinalar risco; ausência de selectors/slots
          // nunca é convertida em prova de ausência de privilégios.
          ...(token.paused === true ? { canPause: true } : {}),
          ...(token.proxyStoragePresent ? { proxyUpgradeable: true } : {}) };
        const snapshot = {
          schemaVersion: 2, synthetic: false, chain: NETWORK.chain, chainId: NETWORK.chainId, environment: NETWORK.environment,
          address: target.address, symbol: token.symbol,
          ...(creation.contractCreatedAt ? { contractCreatedAt: creation.contractCreatedAt } : {}),
          chainState: { ...ref('chainState'), rpcChainId: NETWORK.chainId,
            headTimestamp: new Date(head.timestamp * 1000).toISOString(), blockNumber: head.number,
            blockHash: head.hash, finalityStage: 'sequencer', reorgDetected: discovery.reorgDetected },
          security, holders: {}, liquidityProtection: {}, quote: {},
          market: { ...ref('market'), oldestPoolCreatedAt: new Date(oldestBlock.timestamp * 1000).toISOString(),
            hasUnreviewedHooks: target.pools.some((p) => p.type === 'v4' && p.hooks !== '0x' + '0'.repeat(40)),
            ...(usable ? { quoteAsset: usable.quoteAsset, quoteAssetAddress: usable.quoteAssetAddress } : {}) },
          activity: { ...ref('activity') },
          collection: { runId, blockNumber: head.number, poolsKnown: target.pools.length, poolsEnriched: pools.filter((p) => !p.error).length,
            classification: 'unclassified-erc20-candidate; not-a-verified-memecoin',
            gaps: [!creation.contractCreatedAt ? 'Deployment sem prova de recibo; fronteira de bytecode não usada como data' : null,
              'Código/roles/regras de transferência ainda sem análise conclusiva',
              'Holders, insiders, coordenação e organicidade não comprovados',
              'Proteção de LP e simulação de ida e volta não comprovadas',
              'Preços/volumes em quote currency; sem conversão USD verificada',
              target.pools.length > pools.length ? 'Nem todas as pools conhecidas foram enriquecidas nesta execução' : null].filter(Boolean) },
        };
        snapshots.push(snapshot);
        observations[target.address] = { codeHash: token.codeHash, creation, lastEnrichedAtMs: now() };
      } catch (error) { tokenErrors.push({ address: target.address, error: error.code ?? 'TOKEN_ENRICHMENT_FAILED' }); }
    }
    // Reconsultar sem cache: todas as leituras foram fixadas por altura e só são
    // publicadas se o hash dessa altura continuar canónico no fim da sessão.
    const pinned = await rpc.request('eth_getBlockByNumber', [hex(head.number), false]);
    if (pinned?.hash?.toLowerCase() !== head.hash.toLowerCase()) throw new Error('Reorganização durante a recolha; snapshots descartados');
    const after = await rpc.block();
    const progressed = after.number > head.number && after.timestamp >= head.timestamp && now() - after.timestamp * 1000 <= 60000 && after.timestamp * 1000 <= now() + 30000;
    for (const snapshot of snapshots) if (progressed) snapshot.chainState.sequencerHealthy = true;
    const evaluations = runScan(snapshots, policy, { now: now(), state: discovery.reorgDetected ? {} : saved.evaluationState ?? {} });
    const unresolved = snapshots.map((snapshot) => ({ address: snapshot.address, missingGroups: SECTIONS.filter((s) => !snapshot[s]?.checkedAt), gaps: snapshot.collection.gaps }));
    const errors = [...discovery.diagnostics, ...tokenErrors, ...details.flatMap((d) => d.pools.filter((p) => p.error).map((p) => ({ address: d.token.address, pool: p.id, error: p.error })))];
    const payload = { schemaVersion: 1, collectorVersion: 'rpc-v1', collectorHash, runId, startedAt,
      completedAt: new Date(now()).toISOString(), operationalStatus: errors.length ? 'DEGRADED' : 'PARTIAL',
      chain: NETWORK.chain, chainId: NETWORK.chainId, environment: NETWORK.environment, synthetic: false,
      observedHead: { number: head.number, hash: head.hash, timestamp: head.timestamp },
      progressObserved: progressed, rawEvidenceFile: `runs/${runId}.rpc.json`,
      coverage: { catalogPools: discovery.catalog.length, discoveredTargetContracts: totalTargets, enrichedContracts: snapshots.length,
        selectedContracts: selected.length, venues: discovery.venues,
        scope: 'Configured Uniswap v2/v3/v4 deployments only; catalogue progressively backfilled; pools are not classified as memecoins',
        historicCoverageComplete: Object.values(discovery.venues).every((v) => !v.error && v.fullHistoryComplete) },
      errors, unresolved, snapshots, results: evaluations.results, alerts: evaluations.alerts,
      evaluationState: evaluations.state, discovery, observations, rpcRequestCount: rpc.requestCount,
    };
    return { payload, evidence: { schemaVersion: 1, runId, chainId: NETWORK.chainId, head: payload.observedHead,
      discovery: { venues: discovery.venues, catalog: discovery.catalog }, chainState: { initial: head, final: after },
      security: details.map(({ token, creation, evidence }) => ({ token, creation, evidence })),
      market: details.map(({ token, pools }) => ({ address: token.address, pools })),
      activity: details.map(({ token, pools }) => ({ address: token.address, pools: pools.map((p) => ({ id: p.id, activity: p.activity })) })),
      rpc: rpc.audit } };
  } finally { if (!suppliedRpc) await rpc.close(); }
}
