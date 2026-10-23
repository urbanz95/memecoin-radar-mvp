import { evaluate, policyHash as legacyPolicyHash } from '../engine.mjs';
import legacyPolicy from '../../config/policies.json' with { type: 'json' };
import PROFILES_CONFIG from './config.mjs';
import { NETWORK, isEvmAddress } from '../network.mjs';

const VERSION = 'mvp-hard-filters-v1';
const HARD_SECTIONS = ['chainState', 'security', 'holders', 'market', 'liquidityProtection', 'quote'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const blockHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const timestamp = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value)).toISOString().slice(0, 19) === value.slice(0, 19) ? Date.parse(value) : NaN;

function ageEvidence(snapshot, entry, profile, now, policy, gap) {
  const maximum = profile.age.maxHours * 60;
  const created = timestamp(snapshot?.contractCreatedAt);
  if (Number.isFinite(created)) {
    if (created > now) { gap('AGE_FUTURE', 'contractCreatedAt', 'A criação reportada está no futuro.'); return null; }
    if (entry.age?.contractCreatedAt && timestamp(entry.age.contractCreatedAt) !== created) {
      gap('AGE_CONTRADICTORY', 'contractCreatedAt', 'As provas de criação não coincidem.'); return null;
    }
    const minutes = (now - created) / 60000;
    return { passed: minutes >= profile.age.minHours * 60 && minutes < maximum,
      basis: 'exact-creation', lowerBoundMinutes: minutes, upperBoundMinutes: minutes,
      expiresAtMs: created + maximum * 60000 };
  }
  if (snapshot?.contractCreatedAt !== undefined && snapshot.contractCreatedAt !== null) {
    gap('AGE_INVALID', 'contractCreatedAt', 'A data de criação não é uma prova UTC válida.'); return null;
  }
  const at = timestamp(entry.observedAt);
  const headAt = timestamp(snapshot?.chainState?.headTimestamp);
  const head = snapshot?.chainState?.blockNumber;
  const age = entry.age;
  if (!isEvmAddress(entry.address) || !same(entry.address, snapshot?.address) || !Number.isFinite(at)
    || now - at > policy.data.maxAgeSeconds.security * 1000 || at > now + policy.data.maxFutureSkewSeconds * 1000
    || !whole(entry.blockNumber) || !whole(head) || entry.blockNumber > head || !Number.isFinite(headAt)
    || at > headAt + policy.data.maxFutureSkewSeconds * 1000 || age?.basis !== 'code-existence-bounds'
    || !Array.isArray(age.evidence) || !age.evidence.length || age.evidence.length > 8) {
    gap('AGE_UNPROVEN', 'age', 'Faltam provas canónicas de ausência e presença de bytecode para a janela de idade.'); return null;
  }
  if (age.reasons !== undefined && !Array.isArray(age.reasons)) {
    gap('AGE_PROOF_INVALID', 'age.reasons', 'Os resultados da validação da idade têm formato inválido.'); return null;
  }
  if ((age.reasons ?? []).some(reason => ['AGE_CANONICAL_PROOF_UNAVAILABLE', 'AGE_CODE_CONTINUITY_UNPROVEN',
    'AGE_MULTIPLE_DEPLOYMENTS', 'AGE_INPUT_INVALID', 'AGE_EVIDENCE_UNAVAILABLE'].includes(reason))) {
    gap('AGE_CANONICAL_UNPROVEN', 'age', 'A continuidade ou a validade canónica da prova de idade não ficou confirmada.'); return null;
  }
  const proofs = [];
  const identities = new Map();
  for (const proof of age.evidence) {
    const time = timestamp(proof?.timestamp);
    if (proof?.kind !== 'historical-code-existence' || !whole(proof.blockNumber) || proof.blockNumber > entry.blockNumber
      || !blockHash(proof.blockHash) || !Number.isFinite(time) || time > at || time > headAt
      || typeof proof.hasBytecode !== 'boolean'
      || (proof.blockNumber === head && !same(proof.blockHash, snapshot.chainState.blockHash))) {
      gap('AGE_PROOF_INVALID', 'age.evidence', 'Uma prova histórica de bytecode tem identidade, bloco ou tempo inválido.'); return null;
    }
    const identity = `${proof.blockHash.toLowerCase()}:${time}:${proof.hasBytecode}`;
    if (identities.has(proof.blockNumber) && identities.get(proof.blockNumber) !== identity) {
      gap('AGE_PROOF_CONTRADICTORY', 'age.evidence', 'Há provas incompatíveis para o mesmo bloco.'); return null;
    }
    identities.set(proof.blockNumber, identity);
    proofs.push({ number: proof.blockNumber, time, present: proof.hasBytecode });
  }
  proofs.sort((a, b) => a.number - b.number);
  let presenceSeen = false;
  for (let index = 0; index < proofs.length; index++) {
    const proof = proofs[index];
    if ((index && proof.time < proofs[index - 1].time) || (presenceSeen && !proof.present)) {
      gap('AGE_CODE_CONTINUITY_UNPROVEN', 'age.evidence', 'A ordem dos blocos ou a continuidade do código é contraditória.'); return null;
    }
    presenceSeen ||= proof.present;
  }
  const positive = proofs.filter(proof => proof.present);
  const negative = proofs.filter(proof => !proof.present);
  const lower = positive.length ? Math.max(...positive.map(proof => (now - proof.time) / 60000)) : 0;
  if (lower >= maximum) return { passed: false, basis: 'code-existence-bounds', lowerBoundMinutes: lower, upperBoundMinutes: null };
  if (!negative.length || (!positive.length && snapshot.security?.hasBytecode !== true)) {
    gap('AGE_UNPROVEN', 'age.evidence', 'A janela exige ausência histórica e presença de código comprovadas.'); return null;
  }
  const upper = Math.min(...negative.map(proof => (now - proof.time) / 60000));
  if (lower > upper || upper < 0 || upper >= maximum || lower < profile.age.minHours * 60) {
    gap('AGE_WINDOW_UNPROVEN', 'age', 'Os limites de bytecode não comprovam a idade estritamente inferior a 24 horas.'); return null;
  }
  return { passed: true, basis: 'code-existence-bounds', lowerBoundMinutes: lower, upperBoundMinutes: upper,
    expiresAtMs: Math.max(...negative.map(proof => proof.time)) + maximum * 60000 };
}

function typedFact(value, path, snapshot, now, ttlSeconds, policy, gap) {
  const at = timestamp(value?.checkedAt);
  if (!object(value) || value.schemaVersion !== 1 || value.chainId !== NETWORK.chainId
    || !isEvmAddress(value.address) || !same(value.address, snapshot?.address)
    || !text(value.source) || value.source.length > 256 || !Array.isArray(value.evidence)
    || !value.evidence.length || value.evidence.length > 32 || !value.evidence.every(item => text(item) && item.length <= 256)
    || typeof value.complete !== 'boolean' || !Number.isFinite(at)
    || now - at > ttlSeconds * 1000 || at > now + policy.data.maxFutureSkewSeconds * 1000) {
    gap('HARD_EVIDENCE_UNPROVEN', path, 'Falta prova tipada, recente e identificada para este filtro.'); return null;
  }
  if (!value.complete) gap('HARD_EVIDENCE_PARTIAL', `${path}.complete`, 'A cobertura desta verificação permanece incompleta.');
  return value;
}

/**
 * Reuse the existing EVM policy engine for hard security rules. This adapter
 * does not run another scanner, score wallets, infer authorities from ownership,
 * or convert incomplete evidence into safety. Exact or historical code bounds
 * determine the new profile's universe without inventing a deployment date.
 */
export function evaluateHardFilters(snapshot, entry = {}, {
  profile = PROFILES_CONFIG.profiles.profile_new, now = Date.now(), policy = legacyPolicy,
} = {}) {
  if (!finite(now)) throw new Error('HARD_FILTER_CLOCK_INVALID');
  entry = object(entry) ? entry : {};
  const gaps = []; const checks = []; const reasons = [];
  const gap = (code, path, message) => {
    if (!gaps.some(item => item.code === code && item.path === path)) gaps.push({ code, path, message });
  };
  const compatiblePolicy = structuredClone(policy);
  compatiblePolicy.version = `${policy.version}:${VERSION}`;
  compatiblePolicy.pipelines.new.ageMinMinutes = 0;
  compatiblePolicy.pipelines.new.ageMaxMinutes = 1440;
  const fingerprint = legacyPolicyHash(compatiblePolicy);
  const evaluatedAt = new Date(now).toISOString();
  let age; let history; let activity;
  const result = status => ({ version: VERSION, profile: 'profile_new', status,
    score: status === 'PASS' ? 100 : status === 'REJECTED' ? 0 : null,
    checks, reasons: [...new Set([...reasons, ...gaps.map(item => item.message)])], gaps,
    policyHash: fingerprint, evaluatedAt, securityComplete: status === 'PASS',
    age: age ? { basis: age.basis, lowerBoundMinutes: age.lowerBoundMinutes, upperBoundMinutes: age.upperBoundMinutes } : null,
    evidenceExpiresAt: status === 'PASS' ? new Date(Math.min(
      ...HARD_SECTIONS.map(section => timestamp(snapshot?.[section]?.checkedAt) + policy.data.maxAgeSeconds[section] * 1000),
      timestamp(snapshot.chainState.headTimestamp) + policy.data.maxHeadAgeSeconds * 1000,
      timestamp(history.checkedAt) + policy.data.maxAgeSeconds.security * 1000,
      timestamp(activity.checkedAt) + policy.data.maxAgeSeconds.holders * 1000,
      age.expiresAtMs ?? Infinity,
    )).toISOString() : null,
  });
  if (profile?.enabled === false) { reasons.push('O perfil está desativado.'); return result('OUT_OF_SCOPE'); }
  if (profile?.enabled !== true || profile.age?.minHours !== 0 || profile.age?.maxHours !== 24 || profile.age?.maxExclusive !== true) {
    gap('PROFILE_UNSUPPORTED', 'profile', 'Este adaptador implementa apenas o modo A ativo, de 0h a menos de 24h.'); return result('INCOMPLETE');
  }
  age = ageEvidence(snapshot, entry, profile, now, policy, gap);
  checks.push({ category: 'universe', metric: 'contractAge', op: 'range',
    threshold: { minHours: 0, maxHours: 24, maxExclusive: true },
    value: age ? { lowerBoundMinutes: age.lowerBoundMinutes, upperBoundMinutes: age.upperBoundMinutes } : null,
    passed: age?.passed ?? null, reason: 'Idade do contrato fora do modo A ou sem prova.' });
  if (entry.address !== undefined && !same(entry.address, snapshot?.address))
    gap('ENTRY_IDENTITY_MISMATCH', 'entry.address', 'A análise e o snapshot pertencem a contratos diferentes.');
  const adapted = object(snapshot) ? structuredClone(snapshot) : snapshot;
  if (object(adapted)) {
    // An unknown/out-of-scope creation date must not hide positive security
    // findings behind the legacy engine's early universe return. Missing date
    // remains missing, and the explicit age check above supplies the universe.
    if (!age?.passed) delete adapted.contractCreatedAt;
    adapted.security = object(adapted.security) ? adapted.security : {};
    adapted.holders = object(adapted.holders) ? adapted.holders : {};
  }
  history = typedFact(entry.hardFilterEvidence?.deployerHistory, 'hardFilterEvidence.deployerHistory', snapshot,
    now, policy.data.maxAgeSeconds.security, policy, gap);
  activity = typedFact(entry.hardFilterEvidence?.launchActivity, 'hardFilterEvidence.launchActivity', snapshot,
    now, policy.data.maxAgeSeconds.holders, policy, gap);
  if (history) {
    if (!isEvmAddress(history.deployerAddress) || (entry.age?.deployer && !same(history.deployerAddress, entry.age.deployer)))
      gap('DEPLOYER_IDENTITY_UNPROVEN', 'hardFilterEvidence.deployerHistory.deployerAddress', 'A identidade do criador não está comprovada.');
    else if (!whole(history.knownMaliciousDeployments))
      gap('DEPLOYER_HISTORY_UNPROVEN', 'hardFilterEvidence.deployerHistory.knownMaliciousDeployments', 'O histórico do criador não foi comprovado por uma contagem tipada.');
    else if (history.knownMaliciousDeployments > 0 && object(adapted)) adapted.security.knownMalicious = true;
    checks.push({ category: 'provenance', metric: 'deployerHistory.complete', op: 'eq', threshold: true,
      value: history.complete, passed: history.complete ? true : null, reason: 'Histórico do criador incompleto.' });
  }
  if (activity) {
    if (!finite(activity.bundledSupplyPct) || activity.bundledSupplyPct < 0 || activity.bundledSupplyPct > 100)
      gap('BUNDLE_SUPPLY_UNPROVEN', 'hardFilterEvidence.launchActivity.bundledSupplyPct', 'A percentagem de supply em bundles não foi comprovada.');
    else if (object(adapted)) adapted.holders.bundledSupplyPct = Math.max(
      finite(adapted.holders.bundledSupplyPct) ? adapted.holders.bundledSupplyPct : 0, activity.bundledSupplyPct);
    if (typeof activity.sniperManipulationConfirmed !== 'boolean')
      gap('SNIPER_MANIPULATION_UNPROVEN', 'hardFilterEvidence.launchActivity.sniperManipulationConfirmed', 'Falta uma conclusão comprovada sobre manipulação coordenada de lançamento.');
    else if (activity.sniperManipulationConfirmed && object(adapted)) adapted.security.knownMalicious = true;
    checks.push({ category: 'provenance', metric: 'launchActivity.complete', op: 'eq', threshold: true,
      value: activity.complete, passed: activity.complete ? true : null, reason: 'Análise de lançamento incompleta.' });
  }
  const evaluation = evaluate(adapted, 'new', compatiblePolicy, { now });
  const hardChecks = evaluation.checks.filter(check => check.category === 'security');
  checks.push(...hardChecks);
  const hardMetrics = new Set([...compatiblePolicy.securityGates, ...compatiblePolicy.pipelines.new.securityGates].map(gate => gate.metric));
  const relevant = issue => {
    if (issue.path === 'contractCreatedAt' || issue.path === 'activity' || issue.path?.startsWith('activity.')) return false;
    if (['snapshot', 'chain', 'chainId', 'address'].includes(issue.path)) return true;
    if (['chainState', 'security', 'liquidityProtection', 'quote'].some(section => issue.path === section || issue.path?.startsWith(section + '.'))) return true;
    if (issue.path === 'holders' || ['holders.checkedAt', 'holders.source', 'holders.evidence'].includes(issue.path)) return true;
    if (issue.path === 'market' || ['market.checkedAt', 'market.source', 'market.evidence', 'market.quoteAsset', 'market.quoteAssetAddress'].includes(issue.path)) return true;
    return hardMetrics.has(issue.path) || (issue.code === 'DATA_INCONSISTENT' && issue.path === 'market.oldestPoolCreatedAt');
  };
  for (const issue of evaluation.issues.filter(relevant)) gap(issue.code, issue.path, issue.message);
  const knownScreeningRisk = entry.status === 'BLOCKED' || (Array.isArray(entry.risks) && entry.risks.length > 0);
  if (knownScreeningRisk) {
    const at = timestamp(entry.observedAt);
    const identified = snapshot?.chain === NETWORK.chain && snapshot?.chainId === NETWORK.chainId && snapshot?.environment === NETWORK.environment
      && isEvmAddress(entry.address) && same(entry.address, snapshot.address) && Number.isFinite(at)
      && whole(entry.blockNumber) && whole(snapshot.chainState?.blockNumber) && entry.blockNumber <= snapshot.chainState.blockNumber
      && now - at <= policy.data.maxAgeSeconds.security * 1000 && at <= now + policy.data.maxFutureSkewSeconds * 1000;
    if (identified) checks.push({ category: 'security', metric: 'screening.knownRisk', value: true, op: 'eq', threshold: false,
      passed: false, reason: 'O módulo de análise existente reportou riscos conhecidos neste contrato.' });
    else gap('SCREENING_RISK_UNPROVEN', 'entry.risks', 'O risco reportado não tem identidade e atualidade comprovadas nesta análise.');
  }
  const rejected = checks.filter(check => check.category === 'security' && check.passed === false);
  reasons.push(...rejected.map(check => check.reason));
  if (rejected.length) return result('REJECTED');
  if (age?.passed === false) { reasons.push('A idade comprovada está fora do modo A.'); return result('OUT_OF_SCOPE'); }
  if (gaps.length || !age?.passed || !hardChecks.length || hardChecks.some(check => check.passed !== true)) return result('INCOMPLETE');
  return result('PASS');
}
