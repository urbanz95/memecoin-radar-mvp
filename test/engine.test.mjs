import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluate, validateConfig } from '../src/engine.mjs';
import { isEvmAddress, QUOTE_ASSETS } from '../src/network.mjs';
import { runScan } from '../src/runner.mjs';
import { fixture, DEMO_TIME as NOW } from '../examples/fixtures.mjs';

const config = JSON.parse(await readFile(new URL('../config/policies.json', import.meta.url)));
const check = (snapshot, pipeline = 'new', options = {}) => evaluate(snapshot, pipeline, config, { now: NOW, ...options });
const change = (snapshot, path, value) => {
  const parts = path.split('.');
  const target = parts.slice(0, -1).reduce((v, key) => v[key], snapshot);
  target[parts.at(-1)] = value;
  return snapshot;
};

test('a política é válida e ambos os exemplos têm score 100 sem confirmação imediata', () => {
  validateConfig(config);
  for (const pipeline of ['new', 'established']) {
    const result = check(fixture(pipeline), pipeline);
    assert.equal(result.status, 'CONFIRMING');
    assert.equal(result.score, 100);
    assert.equal(result.dataMode, 'synthetic');
    assert.equal(result.issues.length, 0);
  }
});

for (const [path, value] of [
  ['chainState.sequencerHealthy', false], ['chainState.reorgDetected', true],
  ['security.hasBytecode', false], ['security.contractVerified', false],
  ['security.canMint', true], ['security.canPause', true], ['security.canBlacklist', true],
  ['security.whitelistOnly', true], ['security.canChangeFees', true], ['security.canConfiscate', true],
  ['security.proxyUpgradeable', true], ['security.hiddenPrivileges', true],
  ['security.untrustedTransferCalls', true], ['security.honeypotDetected', true],
  ['market.dexVerified', false], ['market.hasUnreviewedHooks', true],
  ['security.mutableTransferRules', true], ['security.knownMalicious', true],
  ['security.liquidityRemovableByCreator', true], ['security.buyTaxPct', 0.1],
  ['security.sellTaxPct', 0.1], ['security.suspiciousVolumePct', 20.001],
  ['holders.top1Pct', 5.001], ['holders.top10Pct', 25.001],
  ['holders.deployerPct', 2.001], ['holders.linkedInsidersPct', 10.001],
  ['holders.bundledSupplyPct', 10.001], ['liquidityProtection.coveragePct', 94.99],
  ['liquidityProtection.verified', false], ['market.liquidityChange5mPct', -10.001],
  ['quote.buySucceeded', false], ['quote.sellSucceeded', false],
  ['quote.buyImpactPct', 2.001], ['quote.sellImpactPct', 2.001],
  ['quote.roundTripLossPct', 8.001], ['security.tokenStandard', 'erc721'],
  ['market.quoteAsset', 'FAKE_USDG'], ['liquidityProtection.mechanism', 'unknown'],
  ['market.quoteAssetAddress', '0x3333333333333333333333333333333333333333'],
]) {
  test(`segurança bloqueia independentemente do potencial: ${path}`, () => {
    const result = check(change(fixture(), path, value));
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.score, null);
  });
}

for (const [path, value] of [
  ['security.canMint', undefined], ['security.knownMalicious', 'false'],
  ['chainState.rpcChainId', 46630], ['chainState.finalityStage', 'unknown'],
  ['chainState.blockNumber', -1], ['chainState.blockHash', '0x123'],
  ['market.quoteAssetAddress', undefined],
  ['holders.bundledSupplyPct', null], ['holders.count', -1], ['holders.top1Pct', 101],
  ['activity.uniqueTraders5m', 30.5], ['activity.previous5mVolumeUsd', 0],
  ['activity.holderGrowth5mPct', NaN], ['activity.volume5mUsd', Infinity],
  ['market.liquidityUsd', 0], ['market.fdvUsd', '1000000'],
  ['quote.amountUsd', 1000], ['market.source', ''], ['holders.evidence', []],
  ['market.checkedAt', '2026-10-19'],
]) {
  test(`dado crítico inválido nunca aprova: ${path}`, () => {
    const result = check(change(fixture(), path, value));
    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.score, null);
  });
}

test('dados expirados, futuros e ausência de grupos ficam incompletos', () => {
  for (const section of Object.keys(config.data.maxAgeSeconds)) {
    const snapshot = fixture();
    snapshot[section].checkedAt = new Date(NOW - (config.data.maxAgeSeconds[section] + 1) * 1000).toISOString();
    assert.equal(check(snapshot).status, 'INCOMPLETE', section);
  }
  assert.equal(check(change(fixture(), 'market.checkedAt', new Date(NOW + 31000).toISOString())).status, 'INCOMPLETE');
  const snapshot = fixture();
  delete snapshot.quote;
  assert.equal(check(snapshot).status, 'INCOMPLETE');
});

test('uma falha conhecida de segurança mantém o bloqueio mesmo com dados em falta', () => {
  const snapshot = fixture();
  snapshot.security.canBlacklist = true;
  delete snapshot.holders.bundledSupplyPct;
  const result = check(snapshot);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.issues.length);
});

test('idade do contrato desconhecida não esconde um risco de segurança comprovado', () => {
  for (const pipeline of ['new', 'established']) {
    const snapshot = fixture(pipeline);
    delete snapshot.contractCreatedAt;
    snapshot.security.canMint = true;
    delete snapshot.holders.bundledSupplyPct;
    const result = check(snapshot, pipeline);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.score, null);
    assert.equal(result.nextState.count, 0);
    assert.ok(result.checks.some(check => check.metric === 'security.canMint' && check.passed === false));
    assert.ok(result.issues.some(issue => issue.path === 'contractCreatedAt'));
    assert.ok(result.issues.some(issue => issue.path === 'holders.bundledSupplyPct'));
  }
});

test('todos os filtros são reportados sem idade comprovada, mas nunca há confirmação ou candidato', () => {
  for (const pipeline of ['new', 'established']) {
    let previous = check(fixture(pipeline), pipeline).nextState;
    for (const seconds of [0, 60, 120]) {
      const now = NOW + seconds * 1000;
      const snapshot = fixture(pipeline, now);
      const baseline = check(snapshot, pipeline, { now });
      delete snapshot.contractCreatedAt;
      const result = check(snapshot, pipeline, { now, previous });
      assert.equal(result.status, 'INCOMPLETE');
      assert.equal(result.score, null);
      assert.deepEqual(result.issues.map(issue => issue.path), ['contractCreatedAt']);
      assert.deepEqual(result.checks, baseline.checks);
      assert.equal(result.nextState.count, 0);
      previous = result.nextState;
    }
  }
});

test('a ausência de idade também reporta os restantes dados críticos em falta', () => {
  const source = fixture();
  const snapshot = { schemaVersion: 2, synthetic: false, chain: source.chain, chainId: source.chainId,
    environment: source.environment, address: source.address, chainState: source.chainState,
    security: { ...source.security, hasBytecode: true }, holders: {}, market: {}, activity: {}, liquidityProtection: {}, quote: {} };
  delete snapshot.security.contractVerified;
  const result = check(snapshot);
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.score, null);
  for (const path of ['contractCreatedAt', 'security.contractVerified', 'holders.top1Pct', 'market.liquidityUsd',
    'activity.uniqueTraders5m', 'liquidityProtection.coveragePct', 'quote.buySucceeded']) {
    assert.ok(result.issues.some(issue => issue.path === path), path);
    assert.ok(result.reasons.some(reason => reason.startsWith(path + ':')), path);
  }
  assert.ok(result.checks.some(check => check.metric === 'security.hasBytecode' && check.passed === true));
  assert.ok(result.checks.some(check => check.metric === 'quote.buySucceeded' && check.passed === null));
  const gates = [...config.securityGates, ...config.pipelines.new.securityGates, ...config.pipelines.new.eligibilityGates];
  assert.equal(result.checks.length, gates.length + 1);
  for (const gate of gates) assert.ok(result.checks.some(check => check.metric === gate.metric && check.reason === gate.reason), gate.metric);
});

test('identidade ou rede inválida continuam a impedir qualquer análise dos filtros', () => {
  for (const [path, value] of [['address', '0x123'], ['chainId', 46630]]) {
    const snapshot = change(fixture(), path, value);
    delete snapshot.contractCreatedAt;
    snapshot.security.canMint = true;
    const result = check(snapshot);
    assert.equal(result.status, 'INCOMPLETE');
    assert.deepEqual(result.checks, []);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].path, path);
  }
});

test('limites inclusivos dos filtros de segurança e liquidez', () => {
  const snapshot = fixture();
  Object.assign(snapshot.holders, { top1Pct: 5, top10Pct: 25, deployerPct: 2, linkedInsidersPct: 10, bundledSupplyPct: 10 });
  snapshot.security.suspiciousVolumePct = 20;
  snapshot.liquidityProtection.coveragePct = 95;
  snapshot.liquidityProtection.unlockAt = new Date(NOW + 7 * 86400000).toISOString();
  snapshot.market.liquidityUsd = 50000;
  snapshot.market.liquidityChange5mPct = -10;
  Object.assign(snapshot.quote, { buyImpactPct: 2, sellImpactPct: 2, roundTripLossPct: 8 });
  assert.equal(check(snapshot).status, 'CONFIRMING');
  assert.equal(check(snapshot).score, 85);
});

test('bloqueio insuficiente e LP queimado', () => {
  assert.equal(check(change(fixture(), 'liquidityProtection.unlockAt', new Date(NOW + 6.9 * 86400000).toISOString())).status, 'BLOCKED');
  const burned = fixture();
  burned.liquidityProtection.mechanism = 'burned';
  delete burned.liquidityProtection.unlockAt;
  assert.equal(check(burned).status, 'CONFIRMING');
  assert.ok(!JSON.stringify(check(burned)).includes('Infinity'));
});

test('concentrações incoerentes e volume contado duas vezes ficam incompletos', () => {
  assert.equal(check(change(fixture(), 'holders.top10Pct', 1)).status, 'INCOMPLETE');
  assert.equal(check(change(fixture(), 'activity.buyVolume5mUsd', 50000)).status, 'INCOMPLETE');
  const old = fixture('established');
  old.activity.volume24hUsd = old.activity.volume1hUsd;
  assert.equal(check(old, 'established').status, 'INCOMPLETE');
});

test('filtros de potencial e score insuficiente produzem WATCH', () => {
  assert.equal(check(change(fixture(), 'market.liquidityUsd', 49999)).status, 'WATCH');
  assert.equal(check(change(fixture(), 'market.priceChange5mPct', 20.001)).status, 'WATCH');
  const snapshot = fixture();
  snapshot.activity.holderGrowth5mPct = 1;
  snapshot.activity.uniqueTraders5m = 30;
  assert.equal(check(snapshot).status, 'WATCH');
  assert.equal(check(snapshot).score, 60);
});

test('tokens velhos com pool recente não entram nos novos; intervalo de 2–7 dias fica excluído', () => {
  const old = fixture('established');
  old.market.oldestPoolCreatedAt = new Date(NOW - 20 * 60000).toISOString();
  assert.equal(check(old).status, 'OUT_OF_SCOPE');
  assert.equal(check(old, 'established').status, 'WATCH');
  const gap = fixture();
  gap.contractCreatedAt = new Date(NOW - 3 * 86400000).toISOString();
  assert.equal(check(gap).status, 'OUT_OF_SCOPE');
  assert.equal(check(gap, 'established').status, 'OUT_OF_SCOPE');
});

test('o pipeline estabelecido usa limites próprios', () => {
  const old = fixture('established');
  Object.assign(old.holders, { top1Pct: 8, top10Pct: 35, deployerPct: 3, linkedInsidersPct: 15, bundledSupplyPct: 15 });
  old.liquidityProtection.unlockAt = new Date(NOW + 30 * 86400000).toISOString();
  assert.equal(check(old, 'established').status, 'CONFIRMING');
  old.holders.top1Pct = 8.01;
  assert.equal(check(old, 'established').status, 'BLOCKED');
});

test('novos: três observações distintas ao longo de dois minutos', () => {
  let previous = null;
  for (const [seconds, status] of [[0, 'CONFIRMING'], [60, 'CONFIRMING'], [120, 'CANDIDATE']]) {
    const now = NOW + seconds * 1000;
    const result = check(fixture('new', now), 'new', { now, previous });
    assert.equal(result.status, status);
    previous = result.nextState;
  }
  assert.equal(previous.count, 3);
});

test('estabelecidos: o tempo mínimo continua obrigatório mesmo com várias observações', () => {
  let previous = null;
  for (const seconds of [0, 300, 600, 900]) {
    const now = NOW + seconds * 1000;
    const result = check(fixture('established', now), 'established', { now, previous });
    assert.equal(result.status, seconds === 900 ? 'CANDIDATE' : 'CONFIRMING');
    previous = result.nextState;
  }
});

test('repetir o mesmo snapshot não incrementa a confirmação', () => {
  const snapshot = fixture();
  const previous = check(snapshot).nextState;
  const result = check(snapshot, 'new', { now: NOW + 30000, previous });
  assert.equal(result.status, 'CONFIRMING');
  assert.equal(result.nextState.count, 1);
});

test('um intervalo excessivo, uma falha ou alteração de política reinicia a confirmação', () => {
  const first = check(fixture());
  const now = NOW + 181000;
  const afterGap = check(fixture('new', now), 'new', { now, previous: first.nextState });
  assert.equal(afterGap.nextState.count, 1);
  const bad = check(change(fixture(), 'security.canMint', true), 'new', { previous: first.nextState });
  const good = check(fixture(), 'new', { previous: bad.nextState });
  assert.equal(good.nextState.count, 1);
  const changedConfig = structuredClone(config);
  changedConfig.version = 'robinhood-observe-v3';
  assert.equal(evaluate(fixture(), 'new', changedConfig, { now: NOW, previous: first.nextState }).nextState.count, 1);
});

test('evidência de mercado não pode recuar dentro de uma sequência', () => {
  const first = check(fixture());
  const snapshot = fixture('new', NOW + 10000);
  snapshot.market.checkedAt = new Date(NOW - 1000).toISOString();
  assert.equal(check(snapshot, 'new', { now: NOW + 10000, previous: first.nextState }).status, 'INCOMPLETE');
});

test('o runner não aceita contratos duplicados e elimina estado de tokens ausentes', () => {
  assert.throws(() => runScan([fixture(), fixture()], config, { now: NOW }), /duplicado/);
  const first = runScan([fixture()], config, { now: NOW });
  assert.deepEqual(runScan([], config, { now: NOW + 60000, state: first.state }).state, {});
});

test('eventos são emitidos uma vez por transição e o estado funciona após serialização', () => {
  let state = {};
  for (const seconds of [0, 60, 120, 180]) {
    const now = NOW + seconds * 1000;
    const report = runScan([fixture('new', now)], config, { now, state, pipelines: ['new'] });
    assert.equal(report.alerts.length, seconds === 120 ? 1 : 0);
    state = JSON.parse(JSON.stringify(report.state));
  }
});

test('identidades inválidas nunca geram candidatos', () => {
  assert.equal(isEvmAddress('0x1111111111111111111111111111111111111111'), true);
  assert.equal(isEvmAddress('0x0000000000000000000000000000000000000000'), false);
  assert.equal(isEvmAddress('11111111111111111111111111111111'), false);
  assert.equal(check(change(fixture(), 'chain', 'base')).status, 'INCOMPLETE');
  assert.equal(check(change(fixture(), 'address', '0x123')).status, 'INCOMPLETE');
  assert.equal(check(null).status, 'INCOMPLETE');
});

test('configurações perigosamente malformadas são recusadas', () => {
  for (const mutate of [
    (c) => { c.pipelines.new.score[0].weight = 100; },
    (c) => { c.pipelines.new.score[0].target = 0; },
    (c) => { c.pipelines.new.minScore = 101; },
    (c) => { c.pipelines.new.ageMaxMinutes = 20000; },
    (c) => { c.data.maxAgeSeconds.quote = 0; },
    (c) => { c.data.allowedTokenStandards.push('erc721'); },
    (c) => { c.chainId = 46630; },
    (c) => { c.data.allowedQuoteAssets.push('USDC'); },
    (c) => { c.securityGates[0].value = 'false'; },
    (c) => { c.pipelines.new.score[0].metric = 'unknown'; },
  ]) {
    const invalid = structuredClone(config);
    mutate(invalid);
    assert.throws(() => validateConfig(invalid), /Configuração inválida/);
  }
});

test('a testnet e snapshots v1 não podem ser avaliados como mainnet', () => {
  assert.equal(check(change(fixture(), 'chainId', 46630)).status, 'INCOMPLETE');
  assert.equal(check(change(fixture(), 'environment', 'testnet')).status, 'INCOMPLETE');
  assert.equal(check(change(fixture(), 'schemaVersion', 1)).status, 'INCOMPLETE');
});

test('cabeça de rede antiga ou etapa desconhecida impede confirmação', () => {
  const old = fixture();
  old.chainState.headTimestamp = new Date(NOW - 61000).toISOString();
  assert.equal(check(old).status, 'INCOMPLETE');
  const missing = fixture();
  delete missing.chainState;
  assert.equal(check(missing).status, 'INCOMPLETE');
});

test('símbolos de quote asset exigem o contrato oficial e aceitam diferenças de capitalização', () => {
  const snapshot = fixture();
  snapshot.market.quoteAsset = 'WETH';
  snapshot.market.quoteAssetAddress = '0x' + QUOTE_ASSETS.WETH.slice(2).toUpperCase();
  assert.equal(check(snapshot).status, 'CONFIRMING');
  snapshot.market.quoteAssetAddress = QUOTE_ASSETS.USDG;
  assert.equal(check(snapshot).status, 'BLOCKED');
});

test('capitalização de endereço não duplica token nem reinicia o seu estado', () => {
  const first = fixture();
  first.address = '0x' + 'abcd'.repeat(10);
  const second = structuredClone(first);
  second.address = '0x' + first.address.slice(2).toUpperCase();
  assert.throws(() => runScan([first, second], config, { now: NOW }), /duplicado/);
  const initial = runScan([first], config, { now: NOW, pipelines: ['new'] });
  const next = fixture('new', NOW + 60000);
  next.address = second.address;
  const report = runScan([next], config, { now: NOW + 60000, pipelines: ['new'], state: initial.state });
  assert.equal(Object.values(report.state)[0].count, 2);
  assert.equal(report.results[0].address, first.address);
});

test('o mesmo bloco não conta novamente; recuo de altura ou troca de hash invalida a sequência', () => {
  const initial = check(fixture());
  const same = fixture('new', NOW + 30000);
  same.chainState.blockNumber = initial.nextState.lastBlockNumber;
  same.chainState.blockHash = initial.nextState.lastBlockHash;
  const repeated = check(same, 'new', { now: NOW + 30000, previous: initial.nextState });
  assert.equal(repeated.nextState.count, 1);
  same.chainState.blockHash = '0x' + 'ab'.repeat(32);
  assert.equal(check(same, 'new', { now: NOW + 30000, previous: initial.nextState }).status, 'INCOMPLETE');
  same.chainState.blockNumber--;
  assert.equal(check(same, 'new', { now: NOW + 30000, previous: initial.nextState }).status, 'INCOMPLETE');
});

test('a passagem do tempo sem observação nova não completa o intervalo de confirmação', () => {
  let previous = null;
  let snapshot;
  for (const seconds of [0, 30, 60]) {
    const now = NOW + seconds * 1000;
    snapshot = fixture('new', now);
    const result = check(snapshot, 'new', { now, previous });
    assert.equal(result.status, 'CONFIRMING');
    previous = result.nextState;
  }
  assert.equal(previous.count, 3);
  const repeated = check(snapshot, 'new', { now: NOW + 120000, previous });
  assert.equal(repeated.status, 'CONFIRMING');
  assert.equal(repeated.nextState.count, 3);
  assert.equal(check(fixture('new', NOW + 120000), 'new', { now: NOW + 120000, previous: repeated.nextState }).status, 'CANDIDATE');
});
