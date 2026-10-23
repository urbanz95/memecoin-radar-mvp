import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import profiles, { parseProfilesYaml, validateProfiles, compileProfiles, assertCompiledProfilesCurrent,
  loadCompiledProfiles, configProfileFingerprint, getProfile } from '../src/mvp/config.mjs';
import { validateConfig, evaluate } from '../src/engine.mjs';
import { runScan } from '../src/runner.mjs';
import { fixture, DEMO_TIME } from '../examples/fixtures.mjs';

const yaml = await readFile(new URL('../config/profiles.yaml', import.meta.url), 'utf8');
const generated = JSON.parse(await readFile(new URL('../config/profiles.generated.json', import.meta.url), 'utf8'));
const legacy = JSON.parse(await readFile(new URL('../config/policies.json', import.meta.url), 'utf8'));
const change = mutate => { const candidate = structuredClone(profiles); mutate(candidate); return candidate; };

test('phase 1 preserves legacy JSON schema, engine interfaces and full-snapshot replacement semantics', () => {
  assert.equal(validateConfig(legacy), legacy);
  assert.equal(legacy.pipelines.new.ageMaxMinutes, 2880, 'legacy policy is not silently migrated by the new loader');
  assert.equal(legacy.pipelines.established.ageMinMinutes, 10080);
  const snapshot = fixture('new');
  const result = evaluate(snapshot, 'new', legacy, { now: DEMO_TIME });
  assert.equal(result.status, 'CONFIRMING');
  assert.equal(result.score, 100);
  const first = runScan([snapshot], legacy, { now: DEMO_TIME });
  assert.ok(Object.keys(first.state).length > 0);
  assert.deepEqual(runScan([], legacy, { now: DEMO_TIME, state: first.state }).state, {});
});

test('central YAML activates only dry-run profile_new, younger than 24 hours, with the requested scoring floors', () => {
  const config = parseProfilesYaml(yaml);
  assert.deepEqual(config, profiles);
  assert.deepEqual(config.network, { chain: 'robinhood', chainId: 4663, environment: 'mainnet' });
  assert.equal(config.dryRun, true);
  assert.equal(config.pollingSeconds, 60);
  assert.deepEqual(config.outcomeWindows, ['15m', '1h', '24h', '7d']);
  assert.equal(config.evaluation.minLabeledLaunches, 300);
  const fresh = getProfile('profile_new');
  assert.equal(fresh.enabled, true);
  assert.deepEqual(fresh.age, { minHours: 0, maxHours: 24, maxExclusive: true });
  assert.deepEqual(fresh.weights, { wallets: 50, security: 30, momentum: 20 });
  assert.equal(fresh.minWalletTrades, 5);
  assert.equal(fresh.minScore, 75);
});

test('future profile_existing remains disabled and 2880 hours means 120 days, not 2880 minutes', () => {
  const existing = getProfile('profile_existing');
  assert.equal(existing.enabled, false);
  assert.equal(existing.age.minHours, 120 * 24);
  assert.equal(existing.age.minHours * 60, 172800);
  assert.equal(existing.age.maxHours, null);
  assert.deepEqual(existing.weights, { walletFlow: 40, trend: 30, liquiditySecurity: 20, x: 10 });
  assert.throws(() => validateProfiles(change(config => { config.profiles.profile_existing.enabled = true; })), /PROFILE_CONFIG_INVALID/);
  assert.throws(() => validateProfiles(change(config => { config.dryRun = false; })), /PROFILE_CONFIG_INVALID/);
});

test('compiled JSON matches the source and runtime config is validated and immutable without filesystem loading', () => {
  assert.deepEqual(compileProfiles(yaml), generated);
  assert.equal(assertCompiledProfilesCurrent(yaml, generated), true);
  assert.deepEqual(loadCompiledProfiles(generated), profiles);
  assert.ok(Object.isFrozen(profiles));
  assert.ok(Object.isFrozen(profiles.profiles.profile_new.weights));
  assert.throws(() => { profiles.dryRun = false; }, TypeError);
  const copy = getProfile('profile_new'); copy.weights.wallets = 1;
  assert.equal(getProfile('profile_new').weights.wallets, 50, 'callers cannot alter the shared runtime configuration');
});

test('CI stale check catches source edits, including comments, and tampered compiled values', () => {
  const commentOnly = yaml + '\n# Changed source; regeneration is required.\n';
  assert.throws(() => assertCompiledProfilesCurrent(commentOnly, generated), /PROFILE_COMPILED_STALE/);
  assert.equal(configProfileFingerprint(parseProfilesYaml(commentOnly)), configProfileFingerprint(profiles));
  const tampered = structuredClone(generated);
  tampered.config.profiles.profile_new.minScore = 80;
  assert.throws(() => assertCompiledProfilesCurrent(yaml, tampered), /PROFILE_COMPILED_STALE/);
  assert.throws(() => loadCompiledProfiles({ ...generated, sourceSha256: null }), /PROFILE_CONFIG_INVALID/);
});

test('profile fingerprint depends on validated semantics rather than object-key order', () => {
  const reordered = Object.fromEntries(Object.entries(structuredClone(profiles)).reverse());
  assert.equal(configProfileFingerprint(reordered), configProfileFingerprint(profiles));
  assert.notEqual(configProfileFingerprint(change(config => { config.profiles.profile_new.minScore = 80; })), configProfileFingerprint(profiles));
});

test('invalid weights, unknown profiles and unsafe floors are rejected before runtime', () => {
  const mutations = [
    config => { config.profiles.profile_new.weights.wallets = 49; },
    config => { config.profiles.profile_new.weights.security = '30'; },
    config => { config.profiles.profile_existing.weights.x = -10; },
    config => { config.profiles.profile_new.weights.wallets = NaN; },
    config => { config.profiles.profile_new.minWalletTrades = 4; },
    config => { config.profiles.profile_new.minWalletTrades = 5.5; },
    config => { config.profiles.profile_new.minScore = 74; },
    config => { config.profiles.profile_new.minScore = 101; },
    config => { config.profiles.profile_existing.minScore = 74; },
    config => { config.pollingSeconds = 59; },
    config => { config.evaluation.minLabeledLaunches = 299; },
    config => { config.profiles.profile_new.age.maxHours = 48; },
    config => { config.profiles.profile_new.age.maxExclusive = false; },
    config => { config.profiles.profile_existing.age.minHours = 48; },
    config => { config.profiles.profile_existing.age.minMinutes = 2880; },
    config => { config.profiles.future_mode = {}; },
    config => { config.outcomeWindows.push('30d'); },
  ];
  for (const mutate of mutations) assert.throws(() => validateProfiles(change(mutate)), /PROFILE_CONFIG_INVALID/);
  assert.throws(() => getProfile('profile_typo'), /PROFILE_CONFIG_INVALID:profileId/);
});

test('wrong networks, credentials, environment substitutions and unknown keys cannot be accepted silently', () => {
  const sentinel = 'SENTINEL_SECRET_DO_NOT_LOG';
  const mutations = [
    config => { config.network.chainId = 46630; },
    config => { config.network.environment = 'testnet'; },
    config => { config.network.chain = 'ethereum'; },
    config => { config.network.rpcUrl = sentinel; },
    config => { config.privateKey = sentinel; },
    config => { config.profiles.profile_new.telegram = sentinel; },
    config => { config.profiles.profile_new.minScore = '${SECRET_SCORE}'; },
  ];
  for (const mutate of mutations) {
    assert.throws(() => validateProfiles(change(mutate)), error => /PROFILE_CONFIG_INVALID/.test(error.message)
      && !error.message.includes(sentinel) && !error.message.includes('SECRET_SCORE'));
  }
});

test('YAML rejects duplicate keys, multiple documents, aliases and custom tags without exposing source values', () => {
  const malformed = [
    yaml.replace('dryRun: true', 'dryRun: true\ndryRun: false'),
    yaml + '\n---\ndryRun: false\n',
    'root: &a [1, 2]\ncopy: *a\n',
    'value: !external SENTINEL_SECRET_DO_NOT_LOG\n',
    'unclosed: [SENTINEL_SECRET_DO_NOT_LOG\n',
  ];
  for (const source of malformed) assert.throws(() => parseProfilesYaml(source), error => error.message === 'PROFILE_YAML_INVALID');
  assert.throws(() => parseProfilesYaml(' '.repeat(65537)), /PROFILE_YAML_INVALID/);
  assert.throws(() => parseProfilesYaml(null), /PROFILE_YAML_INVALID/);
  assert.throws(() => compileProfiles(null), /PROFILE_YAML_INVALID/);
  assert.throws(() => parseProfilesYaml(yaml.replace('dryRun: true', 'dryRun: yes')), /PROFILE_CONFIG_INVALID:dryRun/);
});
