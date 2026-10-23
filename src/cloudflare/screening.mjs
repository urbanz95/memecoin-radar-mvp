import { decodeFunctionResult, encodeFunctionData, formatUnits } from 'viem';
import { ERC20, EIP1967 } from '../onchain/abi.mjs';
import { isEvmAddress } from '../network.mjs';
import policy from '../../config/policies.json' with { type: 'json' };
import { hex } from './rpc.mjs';
import { ageEvidence } from './age-evidence.mjs';
import { analysePool } from './pool-analysis.mjs';
import { readProviders } from './providers.mjs';
import { analyseContractSecurity } from './contract-security.mjs';
import { analyseHolders } from './holder-analysis.mjs';
import { assessLiquidityProtection } from './liquidity-protection.mjs';
import { simulateTrade } from './trade-simulation.mjs';
import { mergeSafetySnapshots } from './safety-state.mjs';

const zero = '0x' + '0'.repeat(40);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const gapLabels = {
  TOKEN_SAFETY_AND_TRADE_APPROVAL_NOT_EVALUATED: 'O estado da pool não constitui uma auditoria ao token.',
  USD_CONVERSION_UNAVAILABLE: 'Preço on-chain em moeda de cotação; conversão USD não comprovada on-chain.',
  ACTIVITY_IS_NOT_A_TIME_WINDOW: 'Atividade medida numa amostra de blocos, não numa janela completa de cinco minutos.',
  V4_POOL_IDENTITY_NOT_FULLY_VERIFIED: 'Pool v4 identificada pelo evento; hooks e executabilidade ainda exigem revisão.',
  CLMM_BALANCES_ARE_NOT_EXECUTABLE_DEPTH: 'Liquidez concentrada e saldos não representam profundidade de venda executável.',
  GOPLUS_SECURITY_NOT_CONCLUSIVE: 'Os indicadores GoPlus são informação do fornecedor, não uma auditoria conclusiva.',
  GOPLUS_HOLDERS_NOT_EXHAUSTIVE: 'A lista de holders do fornecedor não comprova toda a distribuição.',
  DEXSCREENER_MARKET_NOT_VERIFIED_ONCHAIN: 'Preços USD e volumes publicados pelo DEXScreener não foram reconciliados on-chain.',
  DEXSCREENER_NO_MATCHING_PAIR: 'Sem par de mercado compatível no DEXScreener para este contrato.',
};
const describeGap = code => gapLabels[code] ?? (code.startsWith('GOPLUS_') ? 'Leitura GoPlus incompleta ou indisponível.'
  : code.startsWith('DEXSCREENER_') ? 'Leitura de mercado DEXScreener incompleta ou indisponível.'
    : code.includes('BUDGET') ? 'Parte da leitura foi adiada para respeitar o orçamento gratuito.'
      : code.includes('UNAVAILABLE') || code.startsWith('POOL_READ_') ? 'Uma leitura on-chain não devolveu dados suficientes.' : code);
const safetyGap = value => {
  if (typeof value === 'object') return value?.message;
  if (typeof value !== 'string') return null;
  const labels = {
    SOURCE_NOT_INDEXED: 'O código deste contrato ainda não está disponível no Sourcify.',
    SOURCE_TIMEOUT: 'A consulta ao código-fonte excedeu o prazo; a análise mantém-se pendente.',
    SOURCE_RECOMPILATION_NOT_EXACT: 'Não foi comprovada correspondência byte a byte com o código recompilado.',
    SOURCE_RPC_RUNTIME_MISMATCH: 'O bytecode do fornecedor não corresponde ao observado na rede.',
    OWNER_AND_INDIRECT_PRIVILEGES_NOT_PROVEN: 'O owner foi lido; os seus poderes e administradores indiretos ainda não foram comprovados.',
    CONTROL_FLOW_AND_PRIVILEGES_NOT_AUDITED: 'A inspeção do código não constitui uma auditoria aos privilégios e caminhos de execução.',
    TRANSFER_SEMANTICS_NOT_PROVEN: 'O comportamento de todas as transferências ainda não foi provado.',
    DELEGATED_IMPLEMENTATIONS_NOT_VERIFIED: 'Implementações delegadas e respetivos privilégios exigem verificação própria.',
    HOLDER_INSIDERS_NOT_INDEXED: 'O financiamento de insiders ainda não foi indexado.',
    HOLDER_BUNDLES_NOT_PROVEN: 'A existência ou ausência de bundles não foi comprovada.',
  };
  return labels[value] ?? (/^[A-Z0-9_:]+$/.test(value) ? `Prova pendente (${value}).` : value);
};
const read = (result, name) => {
  try { return decodeFunctionResult({ abi: ERC20, functionName: name, data: result?.value }); }
  catch { return null; }
};

export function priorityScore(market, pipeline) {
  if (!market || !['new', 'established'].includes(pipeline)) return null;
  const p = policy.pipelines[pipeline];
  const liquidityFloor = p.eligibilityGates.find(gate => gate.metric === 'market.liquidityUsd').value;
  const volume = pipeline === 'new' ? market.volumeUsd?.m5 ?? market.volume5mUsd : market.volumeUsd?.h24 ?? market.volume24hUsd;
  const volumeFloor = pipeline === 'new' ? 5000 : 100000;
  const change = pipeline === 'new' ? market.priceChangePct?.m5 ?? market.priceChange5mPct : market.priceChangePct?.h1 ?? market.priceChange1hPct;
  if (![market.liquidityUsd, volume, change].every(finite) || market.liquidityUsd < 0 || volume < 0) return null;
  // Prioridade de revisão baseada em três métricas publicadas. Não é o score
  // de aprovação da política, nem incorpora campos de segurança desconhecidos.
  const liquidityPoints = Math.min(1, market.liquidityUsd / (liquidityFloor * 5)) * 35;
  const volumePoints = Math.min(1, volume / (volumeFloor * 5)) * 40;
  const momentumPoints = change >= 0 && change <= (pipeline === 'new' ? 20 : 25) ? Math.min(1, change / 10) * 25 : 0;
  return Math.round((liquidityPoints + volumePoints + momentumPoints) * 10) / 10;
}

export async function screenToken(rpc, pool, head, created, facts,
  { address, fetchImpl = fetch, now = Date.now, safetyState = null, safetyPhase = 0, evidenceRef, providerState,
    include23HourBoundary = false, onValidatedEvents } = {}) {
  const token = { decimals: null, totalSupplyRaw: null, symbol: null };
  const decimals = read(facts[1], 'decimals');
  const supply = read(facts[2], 'totalSupply');
  if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 36) token.decimals = decimals;
  if (typeof supply === 'bigint') token.totalSupplyRaw = supply.toString();
  const risks = []; const checks = []; const unknowns = [];
  const security = {}; const proxySlots = {};
  const hasBytecode = typeof facts[0]?.value === 'string' && facts[0].value !== '0x';
  checks.push({ metric: 'security.hasBytecode', value: hasBytecode, passed: hasBytecode });
  if (!hasBytecode) risks.push({ code: 'NO_BYTECODE', reason: 'Endereço sem bytecode de contrato.' });
  if (token.decimals !== null && token.totalSupplyRaw !== null) security.tokenStandard = 'erc20';
  if ((rpc.requests ?? 0) < 26) {
    try {
      const functions = ['symbol', 'owner', 'paused'];
      const calls = functions.map(functionName => ['eth_call', [{ to: address,
        data: encodeFunctionData({ abi: ERC20, functionName }) }, hex(head.number)]]);
      for (const slot of Object.values(EIP1967)) calls.push(['eth_getStorageAt', [address, slot, hex(head.number)]]);
      const extra = await rpc.batch(calls);
      const symbol = read(extra[0], 'symbol');
      token.symbol = typeof symbol === 'string' ? symbol.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 32) : null;
      const owner = read(extra[1], 'owner');
      if (typeof owner === 'string' && isEvmAddress(owner)) {
        token.owner = owner.toLowerCase();
        checks.push({ metric: 'ownerObserved', value: token.owner, passed: null });
        if (token.owner !== zero) unknowns.push('Existe um owner; os seus privilégios ainda exigem análise.');
      }
      const paused = read(extra[2], 'paused');
      if (typeof paused === 'boolean') token.paused = paused;
      if (paused === true) {
        security.canPause = true;
        risks.push({ code: 'TRANSFERS_PAUSED', reason: 'paused() devolveu true no bloco observado.' });
      }
      const proxyObserved = extra.slice(3).some(result => typeof result?.value === 'string'
        && /^0x[0-9a-f]{64}$/i.test(result.value) && BigInt(result.value) !== 0n);
      Object.keys(EIP1967).forEach((name, index) => { proxySlots[name] = extra[index + 3]?.value ?? null; });
      if (proxyObserved) {
        security.proxyUpgradeable = true;
        risks.push({ code: 'PROXY_STORAGE', reason: 'Slots de implementação, admin ou beacon EIP-1967 não vazios.' });
      }
    } catch { unknowns.push('Metadados adicionais ou slots proxy indisponíveis nesta leitura.'); }
  } else unknowns.push('Metadados adicionais adiados pelo orçamento RPC.');

  // Os provedores independentes não partilham o cursor nem podem invalidar o
  // estado confirmado. As falhas ficam explícitas na observação.
  const providersPromise = readProviders(address, { fetchImpl, now, state: providerState, skipMarket: true })
    .catch(() => ({ gaps: ['Fontes externas indisponíveis.'], providerState }));
  const contractPromise = analyseContractSecurity(address, { chainId: 4663, runtimeBytecode: facts[0]?.value,
    blockNumber: head.number, blockHash: head.hash, owner: token.owner, paused: token.paused, proxySlots,
    sourceCache: safetyState?.sourceCache }, { fetchImpl, now }).catch(() => ({ status: 'unavailable',
    checks: [], risks: [], gaps: ['Não foi possível verificar o código e os privilégios nesta leitura.'] }));
  let age = { classification: 'unclassified', basis: 'Sem prova de idade disponível.' };
  try {
    // The caller checks the previous canonical head before reusing this state.
    // Reuse the historical proof during the two continuation phases, advancing
    // age bounds by actual elapsed chain time rather than refetching its source.
    const priorAge = safetyState?.age;
    const priorTime = safetyState?.ageHeadTimestamp;
    if (safetyPhase > 0 && priorAge?.evidence?.length && Number.isSafeInteger(priorTime)
      && head.timestamp >= priorTime && head.timestamp - priorTime <= 300) {
      age = structuredClone(priorAge);
      const elapsed = (head.timestamp - priorTime) / 60;
      for (const key of ['lowerBoundMinutes', 'upperBoundMinutes'])
        if (Number.isFinite(age[key])) age[key] += elapsed;
      age.classification = age.lowerBoundMinutes >= 10080 ? 'established'
        : age.lowerBoundMinutes >= 15 && age.upperBoundMinutes <= 2880 ? 'new' : 'unclassified';
    } else age = await ageEvidence(rpc, address, pool, head, created,
      { fetchImpl, now, maxRequests: Math.min(25, (rpc.requests ?? 0) + 4), include23HourBoundary });
  }
  catch { unknowns.push('Não foi possível confirmar a idade por recibo ou bytecode histórico.'); }
  let native = { identityVerified: null, activeLiquidity: null };
  try { native = await analysePool(rpc, pool, head, token, { maxRequests: 28, onValidatedEvents }); }
  catch { unknowns.push('Leitura do estado da pool indisponível nesta execução.'); }
  const providers = await providersPromise;
  risks.push(...(native.risks ?? [])); checks.push(...(native.checks ?? []));
  unknowns.push(...(native.gaps ?? []).map(describeGap), ...(providers.gaps ?? []).map(describeGap));
  const providerSecurity = providers.security;
  for (const [name, value] of Object.entries(providerSecurity?.providerReported?.flags ?? {}))
    checks.push({ metric: `GoPlus.${name} (fornecedor)`, value, passed: null });
  if (finite(providerSecurity?.providerReported?.holderCount))
    checks.push({ metric: 'GoPlus.holders (distribuição por comprovar)', value: providerSecurity.providerReported.holderCount, passed: null });
  // Só riscos positivos do fornecedor podem bloquear; flags de ausência não
  // substituem a análise conclusiva exigida para aprovar uma operação.
  const positiveFields = ['canMint', 'canPause', 'canBlacklist', 'whitelistOnly', 'canChangeFees', 'canConfiscate',
    'proxyUpgradeable', 'hiddenPrivileges', 'honeypotDetected', 'mutableTransferRules', 'knownMalicious'];
  for (const name of positiveFields) if (providerSecurity?.[name] === true) {
    security[name] = true;
    risks.push({ code: `PROVIDER_${name.toUpperCase()}`, reason: `GoPlus reportou risco em ${name}; confirmação adicional necessária.` });
  }
  for (const name of ['buyTaxPct', 'sellTaxPct']) if (finite(providerSecurity?.[name]) && providerSecurity[name] > 0) {
    security[name] = providerSecurity[name];
    risks.push({ code: `PROVIDER_${name.toUpperCase()}`, reason: `GoPlus reportou ${name}: ${providerSecurity[name]}%.` });
  }
  if (!age.contractCreatedAt) unknowns.push('Data exata de deployment sem recibo comprovado; faixa etária baseada apenas nas provas indicadas.');
  const contract = await contractPromise;
  Object.assign(security, contract.security ?? {});
  risks.push(...(contract.risks ?? [])); checks.push(...(contract.checks ?? []));
  const rawMarket = providers.market?.externalMarket ?? providers.market ?? null;
  const externalMarket = rawMarket ? { ...rawMarket,
    ...(finite(rawMarket.volumeUsd?.m5) ? { volume5mUsd: rawMarket.volumeUsd.m5 } : {}),
    ...(finite(rawMarket.volumeUsd?.h24) ? { volume24hUsd: rawMarket.volumeUsd.h24 } : {}),
    ...(finite(rawMarket.priceChangePct?.m5) ? { priceChange5mPct: rawMarket.priceChangePct.m5 } : {}),
    ...(finite(rawMarket.priceChangePct?.h1) ? { priceChange1hPct: rawMarket.priceChangePct.h1 } : {}) } : null;
  const pipeline = ['new', 'established'].includes(age.classification) ? age.classification : 'unclassified';
  const deferred = label => ({ status: 'NOT_CHECKED', checkedAt: null,
    gaps: [`${label}: leitura distribuída pelos três ciclos consecutivos de análise deste contrato.`] });
  const safety = { ...(safetyState?.assessments ?? {}), contract: { ...contract,
    checkedAt: new Date(now()).toISOString() } };
  // Cache and source material belong to persisted state/evidence, not the UI.
  for (const key of ['cache', 'sourceCache', 'sourceRecord', 'security', 'evidence']) delete safety.contract[key];
  let holders; let liquidity; let simulation;
  try {
    if (safetyPhase === 0) {
      const creation = age.evidence?.find(value => value.kind === 'direct-creation-receipt');
      holders = await analyseHolders(rpc, address, head, token, { state: safetyState?.holderState,
        creation: creation ? { ...creation, deployer: age.deployer } : undefined,
        observedFromBlock: pool.createdBlock, verifiedPoolAddresses: native.identityVerified === true && pool.address ? [pool.address] : [],
        candidateAddresses: providerSecurity?.providerReported?.holderCandidates?.map(value => value.address) ?? [],
        pipeline, maxRequests: 30, maxHttpRequests: 2, now, onValidatedEvents,
        ...(onValidatedEvents ? { maxLogs: 32 } : {}) });
      safety.holders = holders.assessment;
    } else if (safetyPhase === 1) {
      liquidity = await assessLiquidityProtection(rpc, pool, head, { identityVerified: native.identityVerified === true,
        creator: age.deployer ?? null, maxRequests: 30, now });
      safety.liquidity = liquidity.assessment;
    } else {
      simulation = await simulateTrade(rpc, pool, head, { identityVerified: native.identityVerified === true,
        maxRequests: 30, now });
      safety.simulation = simulation.assessment;
    }
  } catch {
    const key = ['holders', 'liquidity', 'simulation'][safetyPhase] ?? 'simulation';
    safety[key] = { status: 'unavailable', checkedAt: new Date(now()).toISOString(),
      gaps: ['A leitura não devolveu uma prova válida; a recolha principal foi preservada.'] };
  }
  safety.holders ??= deferred('Holders');
  safety.liquidity ??= deferred('Proteção de LP');
  safety.simulation ??= deferred('Simulação de compra e venda');
  for (const output of [holders, liquidity, simulation]) {
    if (!output?.assessment) continue;
    risks.push(...(output.assessment.risks ?? [])); checks.push(...(output.assessment.checks ?? []));
    Object.assign(security, output.snapshot?.security ?? {});
  }
  const currentProofs = {
    ...(holders?.snapshot ?? {}), ...(liquidity?.snapshot ?? {}), ...(simulation?.snapshot ?? {}),
    ...(simulation?.snapshot?.security ? { security: { ...simulation.snapshot.security,
      checkedAt: simulation.assessment.checkedAt, source: 'onchain-readonly-roundtrip/v1' } } : {}),
  };
  if (typeof evidenceRef === 'string') for (const section of Object.keys(currentProofs))
    currentProofs[section] = { ...currentProofs[section], evidence: [evidenceRef] };
  const proofSnapshots = mergeSafetySnapshots(safetyState?.proofSnapshots, currentProofs, now());
  for (const name of ['buyTaxPct', 'sellTaxPct']) {
    if (proofSnapshots.security?.[name] > 0) security[name] = Math.max(security[name] ?? 0, proofSnapshots.security[name]);
  }
  if (proofSnapshots.security) {
    security.checkedAt = proofSnapshots.security.checkedAt;
    if (proofSnapshots.security.evidence) security.evidence = proofSnapshots.security.evidence;
  }
  for (const assessment of Object.values(safety)) {
    const assessedAt = Date.parse(assessment.checkedAt ?? assessment.observedAt);
    if (Number.isFinite(assessedAt) && now() - assessedAt >= 0 && now() - assessedAt <= 600000)
      risks.push(...(assessment.risks ?? []));
    for (const gap of assessment.gaps ?? []) {
      const label = safetyGap(gap);
      if (typeof label === 'string') unknowns.push(label);
    }
  }
  unknowns.push('Ausência de privilégios ocultos e segurança futura não são provadas por flags negativas ou por uma simulação isolada.',
    'Financiamento de insiders, bundles e organicidade exigem análise adicional de proveniência.');
  const uniqueRisks = [...new Map(risks.filter(item => item?.code && item?.reason).map(item => [item.code, item])).values()].slice(0, 16);
  let status = uniqueRisks.length ? 'BLOCKED' : native.activeLiquidity === false ? 'NO_LIQUIDITY' : 'REVIEW';
  if (status === 'REVIEW' && finite(externalMarket?.liquidityUsd) && ['new', 'established'].includes(pipeline)) {
    const threshold = pipeline === 'new' ? 50000 : 150000;
    if (externalMarket.liquidityUsd < threshold) status = 'WATCH';
  }
  return { entry: { address, poolId: pool.id, poolType: pool.type, symbol: token.symbol,
    observedAt: new Date(now()).toISOString(), blockNumber: head.number, pipeline, status, age,
    native, safety, providers: providers.evidence ?? [], ...(externalMarket ? { externalMarket } : {}), risks: uniqueRisks, checks: checks.slice(0, 32),
    unknowns: [...new Set(unknowns)].slice(0, 16), priorityScore: uniqueRisks.length ? null : priorityScore(externalMarket, pipeline),
    priorityMethod: 'liquidity35-volume40-momentum25/v1; provider-reported; not-trade-approval' },
  snapshot: { ...(token.symbol ? { symbol: token.symbol } : {}),
    ...(age.contractCreatedAt ? { contractCreatedAt: age.contractCreatedAt } : {}), security,
    ...(proofSnapshots.holders ? { holders: proofSnapshots.holders } : {}),
    ...(proofSnapshots.liquidityProtection ? { liquidityProtection: proofSnapshots.liquidityProtection } : {}),
    ...(proofSnapshots.quote ? { quote: proofSnapshots.quote } : {}),
    market: typeof native.identityVerified === 'boolean' ? { dexVerified: native.identityVerified } : {} },
  providerState: providers.providerState,
  safetyState: { sourceCache: contract.cache ?? contract.sourceCache ?? safetyState?.sourceCache,
    holderState: holders?.state ?? safetyState?.holderState, assessments: safety,
    age, ageHeadTimestamp: head.timestamp, proofSnapshots },
  evidence: { token: { ...token, ...(token.decimals !== null && token.totalSupplyRaw !== null
    ? { totalSupply: formatUnits(BigInt(token.totalSupplyRaw), token.decimals) } : {}) }, providers: providers.evidence ?? [],
    proofSnapshots, safety: { contract: contract.evidence ?? [], holders: holders?.evidence ?? null,
      liquidity: liquidity?.evidence ?? null, simulation: simulation?.evidence ?? null } } };
}

export function screeningHistory(previous, entry, results, now) {
  const entries = (Array.isArray(previous) ? previous : []).filter(item => item && isEvmAddress(item.address)
    && Number.isFinite(Date.parse(item.observedAt)) && now - Date.parse(item.observedAt) <= 6 * 3600000
    && (!entry || item.address !== entry.address));
  if (entry) entries.push({ ...entry, strict: Object.fromEntries(results.filter(result => result.address === entry.address)
    .map(result => [result.pipeline, result.status])) });
  entries.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  entries.splice(20);
  while (new TextEncoder().encode(JSON.stringify(entries)).length > 65536) entries.pop();
  return entries;
}
