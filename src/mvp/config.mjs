import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import generated from '../../config/profiles.generated.json' with { type: 'json' };

const ROOT_KEYS = ['schemaVersion', 'network', 'dryRun', 'pollingSeconds', 'outcomeWindows', 'evaluation', 'profiles'];
const PROFILE_IDS = ['profile_new', 'profile_existing'];
const OUTCOME_WINDOWS = ['15m', '1h', '24h', '7d'];
const MAX_YAML_BYTES = 65536;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const digest = text => createHash('sha256').update(text).digest('hex');
const invalid = path => { throw new Error(`PROFILE_CONFIG_INVALID:${path}`); };
const exact = (value, expected, path) => { if (value !== expected) invalid(path); };
const shape = (value, keys, path) => {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid(path);
};
const integer = (value, floor, ceiling, path) => {
  if (!Number.isSafeInteger(value) || value < floor || value > ceiling) invalid(path);
};
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
function weights(value, names, path) {
  shape(value, names, path);
  if (names.some(name => typeof value[name] !== 'number' || !Number.isFinite(value[name]) || value[name] <= 0 || value[name] > 100)
    || Math.abs(names.reduce((sum, name) => sum + value[name], 0) - 100) > 1e-9) invalid(path);
}

/** Pure validation. Unknown keys are rejected so credentials, env expressions,
 * future integrations or a misspelled floor cannot silently enter this policy.
 * The legacy config/policies.json schema and engine contracts are independent.
 */
export function validateProfiles(config) {
  shape(config, ROOT_KEYS, 'root');
  exact(config.schemaVersion, 1, 'schemaVersion');
  shape(config.network, ['chain', 'chainId', 'environment'], 'network');
  exact(config.network.chain, 'robinhood', 'network.chain');
  exact(config.network.chainId, 4663, 'network.chainId');
  exact(config.network.environment, 'mainnet', 'network.environment');
  exact(config.dryRun, true, 'dryRun');
  integer(config.pollingSeconds, 60, 3600, 'pollingSeconds');
  if (!Array.isArray(config.outcomeWindows) || config.outcomeWindows.length !== OUTCOME_WINDOWS.length
    || OUTCOME_WINDOWS.some((window, index) => config.outcomeWindows[index] !== window)) invalid('outcomeWindows');
  shape(config.evaluation, ['minLabeledLaunches'], 'evaluation');
  integer(config.evaluation.minLabeledLaunches, 300, 1000000, 'evaluation.minLabeledLaunches');
  shape(config.profiles, PROFILE_IDS, 'profiles');
  const fresh = config.profiles.profile_new;
  shape(fresh, ['enabled', 'age', 'weights', 'minWalletTrades', 'minScore', 'walletScoring', 'momentum'], 'profiles.profile_new');
  exact(fresh.enabled, true, 'profiles.profile_new.enabled');
  shape(fresh.age, ['minHours', 'maxHours', 'maxExclusive'], 'profiles.profile_new.age');
  exact(fresh.age.minHours, 0, 'profiles.profile_new.age.minHours');
  exact(fresh.age.maxHours, 24, 'profiles.profile_new.age.maxHours');
  exact(fresh.age.maxExclusive, true, 'profiles.profile_new.age.maxExclusive');
  weights(fresh.weights, ['wallets', 'security', 'momentum'], 'profiles.profile_new.weights');
  integer(fresh.minWalletTrades, 5, 1000000, 'profiles.profile_new.minWalletTrades');
  integer(fresh.minScore, 75, 100, 'profiles.profile_new.minScore');
  const wallet = fresh.walletScoring;
  const walletPath = 'profiles.profile_new.walletScoring';
  shape(wallet, ['version', 'minRealizedTrades', 'minScore', 'minIndependentGroups', 'timeDecayHalfLifeDays',
    'maxProfileAgeSeconds', 'maxEntryAgeSeconds', 'maxFutureSkewSeconds', 'maxWallets', 'maxEntries', 'weights', 'targets'], walletPath);
  exact(wallet.version, 'wallet-manual-v1', `${walletPath}.version`);
  integer(wallet.minRealizedTrades, fresh.minWalletTrades, 1000000, `${walletPath}.minRealizedTrades`);
  integer(wallet.minScore, 70, 100, `${walletPath}.minScore`);
  integer(wallet.minIndependentGroups, 2, 128, `${walletPath}.minIndependentGroups`);
  integer(wallet.timeDecayHalfLifeDays, 1, 365, `${walletPath}.timeDecayHalfLifeDays`);
  integer(wallet.maxProfileAgeSeconds, 1, 600, `${walletPath}.maxProfileAgeSeconds`);
  integer(wallet.maxEntryAgeSeconds, 1, 600, `${walletPath}.maxEntryAgeSeconds`);
  integer(wallet.maxFutureSkewSeconds, 0, 30, `${walletPath}.maxFutureSkewSeconds`);
  integer(wallet.maxWallets, 2, 128, `${walletPath}.maxWallets`);
  integer(wallet.maxEntries, 2, 256, `${walletPath}.maxEntries`);
  weights(wallet.weights, ['profit', 'winRate', 'earlyEntry', 'drawdown', 'holding'], `${walletPath}.weights`);
  shape(wallet.targets, ['netRealizedPnlUsd', 'winRatePct', 'earlyEntryPct', 'drawdownCapPct', 'holdingSeconds'], `${walletPath}.targets`);
  integer(wallet.targets.netRealizedPnlUsd, 1, 1000000000, `${walletPath}.targets.netRealizedPnlUsd`);
  for (const name of ['winRatePct', 'earlyEntryPct', 'drawdownCapPct']) integer(wallet.targets[name], 1, 100, `${walletPath}.targets.${name}`);
  integer(wallet.targets.holdingSeconds, 1, 86400, `${walletPath}.targets.holdingSeconds`);
  const momentum = fresh.momentum;
  const momentumPath = 'profiles.profile_new.momentum';
  shape(momentum, ['version', 'weights', 'holderGrowthTargetPct', 'liquidityGrowthTargetPct', 'minObservationSpanSeconds',
    'maxObservationSpanSeconds', 'maxObservationAgeSeconds', 'maxHoldersAgeSeconds', 'maxLiquidityAgeSeconds',
    'maxFutureSkewSeconds', 'maxObservations'], momentumPath);
  exact(momentum.version, 'launch-growth-v1', `${momentumPath}.version`);
  weights(momentum.weights, ['holders', 'liquidity'], `${momentumPath}.weights`);
  integer(momentum.holderGrowthTargetPct, 1, 100, `${momentumPath}.holderGrowthTargetPct`);
  integer(momentum.liquidityGrowthTargetPct, 1, 100, `${momentumPath}.liquidityGrowthTargetPct`);
  integer(momentum.minObservationSpanSeconds, 60, 900, `${momentumPath}.minObservationSpanSeconds`);
  integer(momentum.maxObservationSpanSeconds, momentum.minObservationSpanSeconds, 900, `${momentumPath}.maxObservationSpanSeconds`);
  integer(momentum.maxObservationAgeSeconds, 1, 600, `${momentumPath}.maxObservationAgeSeconds`);
  integer(momentum.maxHoldersAgeSeconds, 1, 300, `${momentumPath}.maxHoldersAgeSeconds`);
  integer(momentum.maxLiquidityAgeSeconds, 1, 120, `${momentumPath}.maxLiquidityAgeSeconds`);
  integer(momentum.maxFutureSkewSeconds, 0, 30, `${momentumPath}.maxFutureSkewSeconds`);
  integer(momentum.maxObservations, 2, 16, `${momentumPath}.maxObservations`);
  const existing = config.profiles.profile_existing;
  shape(existing, ['enabled', 'age', 'weights', 'minScore'], 'profiles.profile_existing');
  exact(existing.enabled, false, 'profiles.profile_existing.enabled');
  shape(existing.age, ['minHours', 'maxHours', 'maxExclusive'], 'profiles.profile_existing.age');
  exact(existing.age.minHours, 2880, 'profiles.profile_existing.age.minHours');
  exact(existing.age.maxHours, null, 'profiles.profile_existing.age.maxHours');
  exact(existing.age.maxExclusive, false, 'profiles.profile_existing.age.maxExclusive');
  weights(existing.weights, ['walletFlow', 'trend', 'liquiditySecurity', 'x'], 'profiles.profile_existing.weights');
  integer(existing.minScore, 75, 100, 'profiles.profile_existing.minScore');
  return structuredClone(config);
}

/** Parse provided text only: no filesystem, process.env, tags or custom loaders. */
export function parseProfilesYaml(rawText) {
  if (typeof rawText !== 'string' || new TextEncoder().encode(rawText).length > MAX_YAML_BYTES)
    throw new Error('PROFILE_YAML_INVALID');
  let config;
  try {
    const document = parseDocument(rawText, { version: '1.2', schema: 'core', strict: true, uniqueKeys: true, prettyErrors: false });
    if (document.errors.length || document.warnings.length) throw new Error('YAML_REJECTED');
    config = document.toJS({ mapAsMap: false, maxAliasCount: 0 });
  } catch { throw new Error('PROFILE_YAML_INVALID'); }
  return validateProfiles(config);
}

export function configProfileFingerprint(config) {
  const validated = validateProfiles(config);
  const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return digest(JSON.stringify(canonical(validated)));
}

export function compileProfiles(rawText) {
  const config = parseProfilesYaml(rawText);
  return { schemaVersion: 1, sourceSha256: digest(rawText), config };
}

export function assertCompiledProfilesCurrent(rawText, envelope) {
  if (JSON.stringify(compileProfiles(rawText)) !== JSON.stringify(envelope)) throw new Error('PROFILE_COMPILED_STALE');
  return true;
}

export function loadCompiledProfiles(envelope) {
  shape(envelope, ['schemaVersion', 'sourceSha256', 'config'], 'compiled');
  exact(envelope.schemaVersion, 1, 'compiled.schemaVersion');
  if (typeof envelope.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.sourceSha256)) invalid('compiled.sourceSha256');
  return freeze(validateProfiles(envelope.config));
}

export const PROFILES_CONFIG = loadCompiledProfiles(generated);
export function getProfile(id, config = PROFILES_CONFIG) {
  if (!PROFILE_IDS.includes(id)) invalid('profileId');
  return validateProfiles(config).profiles[id];
}
export default PROFILES_CONFIG;
