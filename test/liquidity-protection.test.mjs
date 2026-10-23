import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';
import { assessLiquidityProtection } from '../src/cloudflare/liquidity-protection.mjs';
import { hex } from '../src/cloudflare/rpc.mjs';

const ABI = parseAbi(['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
  'function MINIMUM_LIQUIDITY() view returns (uint256)']);
const ZERO = '0x' + '0'.repeat(40);
const DEAD = '0x' + '0'.repeat(36) + 'dead';
const CREATOR = '0x' + '3'.repeat(40);
const POOL = { type: 'v2', id: 'v2:fixture', address: '0x' + '2'.repeat(40) };
const HEAD = { number: 1000, hash: '0x' + 'a'.repeat(64), timestamp: 1792670400 };
const NOW = HEAD.timestamp * 1000;

function fixture(changes = {}) {
  const values = { supply: 1000000n, dead: 950000n, zero: 1000n, minimum: 1000n, creator: 0n, ...changes };
  const calls = [];
  const rpc = {
    requests: changes.initialRequests ?? 0,
    async batch(batch) {
      this.requests++; calls.push(batch);
      if (changes.batchThrows) throw new Error('private-rpc-url-and-token');
      return batch.map(([method, params]) => {
        assert.equal(method, 'eth_call'); assert.equal(params[0].to, POOL.address); assert.equal(params[1], hex(HEAD.number));
        const decoded = decodeFunctionData({ abi: ABI, data: params[0].data });
        let value = decoded.functionName === 'totalSupply' ? values.supply : decoded.functionName === 'MINIMUM_LIQUIDITY' ? values.minimum
          : decoded.args[0].toLowerCase() === DEAD ? values.dead : decoded.args[0].toLowerCase() === ZERO ? values.zero : values.creator;
        if (changes.missing === decoded.functionName || value === undefined) return { error: -32000 };
        if (changes.malformed === decoded.functionName) return { value: '0x1234' };
        return { value: encodeFunctionResult({ abi: ABI, functionName: decoded.functionName, result: value }) };
      });
    },
    async request(method, params) {
      this.requests++; calls.push({ method, params });
      assert.equal(method, 'eth_getBlockByNumber'); assert.deepEqual(params, [hex(HEAD.number), false]);
      if (changes.canonicalThrows) throw new Error('private-rpc-url-and-token');
      return { number: hex(HEAD.number), hash: HEAD.hash, timestamp: hex(HEAD.timestamp), ...changes.canonical };
    },
  };
  return { rpc, calls, options: { identityVerified: true, now: () => NOW, ...(changes.options ?? {}) } };
}

test('95% de LP genuinamente queimado é comprovado apenas para a pool e bloco canónico', async () => {
  const f = fixture();
  const result = await assessLiquidityProtection(f.rpc, POOL, HEAD, f.options);
  assert.equal(f.rpc.requests, 2);
  assert.equal(result.assessment.status, 'BURNED_95_PERCENT');
  assert.equal(result.assessment.coveragePct, 95);
  assert.equal(result.assessment.genuineBurnedRaw, '950000');
  assert.equal(result.assessment.excludedZeroBalanceRaw, '1000');
  assert.equal(result.assessment.mechanism, 'burned');
  assert.equal(result.assessment.poolBurnConfirmed, true);
  assert.equal(result.assessment.canonicalConfirmed, true);
  assert.equal(result.assessment.blockHash, HEAD.hash);
  assert.equal(result.assessment.tokenWideProtectionProven, false);
  assert.deepEqual(result.snapshot, {});
  assert.ok(result.assessment.gaps.some(gap => gap.code === 'LP_POOL_UNIVERSE_INCOMPLETE'));
  assert.ok(result.assessment.gaps.some(gap => gap.code === 'LP_LOCKERS_NOT_VERIFIED'));
  assert.equal(JSON.stringify(result).includes('Infinity'), false);
});

test('os 1000 LP mínimos no endereço zero nunca contam como proteção', async () => {
  const f = fixture({ supply: 1000n, dead: 0n, zero: 1000n });
  const { assessment, snapshot } = await assessLiquidityProtection(f.rpc, POOL, HEAD, f.options);
  assert.equal(assessment.coveragePct, 0);
  assert.equal(assessment.genuineBurnedRaw, '0');
  assert.equal(assessment.poolBurnConfirmed, false);
  assert.equal(assessment.mechanism, null);
  assert.deepEqual(snapshot, {});
});

test('queima adicional no endereço zero deduz os mínimos antes de calcular os 95%', async () => {
  const f = fixture({ supply: 100000n, dead: 0n, zero: 96000n });
  const { assessment } = await assessLiquidityProtection(f.rpc, POOL, HEAD, f.options);
  assert.equal(assessment.genuineBurnedRaw, '95000');
  assert.equal(assessment.coveragePct, 95);
  assert.equal(assessment.poolBurnConfirmed, true);
});

test('sem constante mínima confirmada todo o saldo zero é excluído conservadoramente', async () => {
  for (const changes of [{ missing: 'MINIMUM_LIQUIDITY' }, { minimum: 500n }]) {
    const f = fixture({ supply: 100000n, dead: 0n, zero: 96000n, ...changes });
    const { assessment } = await assessLiquidityProtection(f.rpc, POOL, HEAD, f.options);
    assert.equal(assessment.coveragePct, 0);
    assert.equal(assessment.excludedZeroBalanceRaw, '96000');
    assert.equal(assessment.poolBurnConfirmed, false);
    assert.ok(assessment.gaps.some(gap => gap.code === 'LP_MINIMUM_LIQUIDITY_UNCONFIRMED'));
  }
});

test('o limiar de 95% usa inteiros exatos e não arredonda para aprovar', async () => {
  const supply = 10n ** 70n;
  for (const [dead, expected] of [[supply * 95n / 100n, true], [supply * 95n / 100n - 1n, false]]) {
    const f = fixture({ supply, dead, zero: 1000n });
    const { assessment } = await assessLiquidityProtection(f.rpc, POOL, HEAD, f.options);
    assert.equal(assessment.poolBurnConfirmed, expected);
    if (!expected) assert.ok(assessment.coveragePct < 95);
  }
});

test('um saldo do criador é uma observação e não prova controlo de retirada ou ausência de locker', async () => {
  const f = fixture({ supply: 100000n, dead: 0n, creator: 99000n });
  const { assessment, snapshot } = await assessLiquidityProtection(f.rpc, POOL, HEAD, { ...f.options, creator: CREATOR });
  assert.equal(assessment.creatorBalanceRaw, '99000');
  assert.equal(assessment.creatorAddress, CREATOR);
  assert.ok(assessment.observations.length);
  assert.deepEqual(assessment.risks, []);
  assert.ok(assessment.checks.some(check => check.metric === 'lp.creatorBalanceRaw' && check.passed === null));
  assert.deepEqual(snapshot, {});
  assert.ok(!Object.hasOwn(snapshot, 'security'));
});

test('v3/v4 e identidade da pool não comprovada não são aprovados por saldos fungíveis', async () => {
  for (const type of ['v3', 'v4']) {
    const f = fixture();
    const result = await assessLiquidityProtection(f.rpc, { ...POOL, type }, HEAD, f.options);
    assert.equal(result.assessment.status, 'UNSUPPORTED');
    assert.equal(result.assessment.poolBurnConfirmed, false);
    assert.equal(f.rpc.requests, 0);
  }
  const f = fixture();
  const result = await assessLiquidityProtection(f.rpc, POOL, HEAD, { ...f.options, identityVerified: false });
  assert.equal(result.assessment.status, 'NOT_CHECKED');
  assert.equal(f.rpc.requests, 0);
});

test('reservar o orçamento de ambos os pedidos preserva as chamadas finais do collector', async () => {
  const skipped = fixture({ initialRequests: 29 });
  const result = await assessLiquidityProtection(skipped.rpc, POOL, HEAD, skipped.options);
  assert.equal(skipped.rpc.requests, 29);
  assert.equal(result.assessment.coveragePct, null);
  const allowed = fixture({ initialRequests: 28 });
  assert.equal((await assessLiquidityProtection(allowed.rpc, POOL, HEAD, allowed.options)).assessment.poolBurnConfirmed, true);
  assert.equal(allowed.rpc.requests, 30);
});

test('bloco reorganizado, altura ou timestamp divergente não permitem publicar proteção', async () => {
  for (const canonical of [{ hash: '0x' + 'b'.repeat(64) }, { number: '0x1' }, { timestamp: hex(HEAD.timestamp + 1) }]) {
    const f = fixture({ canonical });
    const result = await assessLiquidityProtection(f.rpc, POOL, HEAD, f.options);
    assert.equal(result.assessment.canonicalConfirmed, false);
    assert.equal(result.assessment.coveragePct, null);
    assert.equal(result.assessment.poolBurnConfirmed, false);
    assert.deepEqual(result.snapshot, {});
  }
});

test('emissão vazia não divide por zero e saldos inconsistentes são recusados', async () => {
  const empty = fixture({ supply: 0n, dead: 0n, zero: 0n });
  const first = await assessLiquidityProtection(empty.rpc, POOL, HEAD, empty.options);
  assert.equal(first.assessment.status, 'EMPTY_LP_SUPPLY');
  assert.equal(first.assessment.coveragePct, 0);
  assert.equal(first.assessment.poolBurnConfirmed, false);
  const invalid = fixture({ dead: 1000000n, zero: 1000n });
  const second = await assessLiquidityProtection(invalid.rpc, POOL, HEAD, invalid.options);
  assert.equal(second.assessment.status, 'NOT_CHECKED');
  assert.equal(second.assessment.coveragePct, null);
  assert.ok(second.assessment.gaps.some(gap => gap.code === 'LP_BALANCES_INCONSISTENT'));
  const missingMinimum = fixture({ supply: 1000n, dead: 1000n, zero: 0n });
  const third = await assessLiquidityProtection(missingMinimum.rpc, POOL, HEAD, missingMinimum.options);
  assert.equal(third.assessment.status, 'NOT_CHECKED');
  assert.equal(third.assessment.poolBurnConfirmed, false);
});

test('falhas de leitura, ABI ou confirmação mantêm a prova desconhecida e não expõem dados privados', async () => {
  for (const changes of [{ batchThrows: true }, { canonicalThrows: true }, { missing: 'totalSupply' }, { malformed: 'balanceOf' }]) {
    const f = fixture(changes);
    const result = await assessLiquidityProtection(f.rpc, POOL, HEAD, f.options);
    assert.equal(result.assessment.status, 'NOT_CHECKED');
    assert.equal(result.assessment.coveragePct, null);
    assert.equal(result.assessment.poolBurnConfirmed, false);
    assert.equal(JSON.stringify(result).includes('private-rpc-url-and-token'), false);
  }
});

test('blocos antigos ou futuros e configuração inválida não fazem pedidos RPC', async () => {
  for (const [head, options] of [[{ ...HEAD, timestamp: HEAD.timestamp - 61 }, {}],
    [{ ...HEAD, timestamp: HEAD.timestamp + 31 }, {}], [HEAD, { maxRequests: -1 }]]) {
    const f = fixture();
    const result = await assessLiquidityProtection(f.rpc, POOL, head, { ...f.options, ...options });
    assert.equal(result.assessment.status, 'NOT_CHECKED');
    assert.equal(f.rpc.requests, 0);
  }
});
