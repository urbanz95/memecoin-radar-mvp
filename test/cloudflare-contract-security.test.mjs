import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'viem';
import { analyseContractSecurity } from '../src/cloudflare/contract-security.mjs';

const token = '0x' + '1'.repeat(40);
const owner = '0x' + '2'.repeat(40);
const blockHash = '0x' + 'a'.repeat(64);
const clock = Date.parse('2026-10-22T23:00:00Z');
const code = '0x600160005560026000f3';
const facts = (overrides = {}) => ({ chainId: 4663, runtimeBytecode: code,
  blockNumber: 100, blockHash, ...overrides });
const artifact = (overrides = {}) => ({ chainId: '4663', address: token,
  runtimeMatch: 'exact_match',
  runtimeBytecode: { onchainBytecode: code, recompiledBytecode: code,
    transformations: [], transformationValues: {}, immutableReferences: {} },
  compilation: { name: 'ExampleToken' }, sources: { 'Token.sol': { content: 'contract ExampleToken { function mint(address to, uint256 amount) external {} }' } },
  abi: [{ type: 'function', name: 'mint', inputs: [{ type: 'address' }, { type: 'uint' }], stateMutability: 'nonpayable' }],
  ...overrides });
const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const analyse = (supplied = facts(), body = artifact(), options = {}) => analyseContractSecurity(token, supplied,
  { fetchImpl: async () => response(body), now: () => clock, ...options });
const gapCodes = out => out.gaps.map(value => value.code);
const negativeSafetyFields = ['canMint', 'canPause', 'canBlacklist', 'whitelistOnly', 'canChangeFees',
  'canConfiscate', 'proxyUpgradeable', 'hiddenPrivileges', 'untrustedTransferCalls', 'honeypotDetected',
  'mutableTransferRules', 'knownMalicious'];

test('only exact RPC, on-chain artifact and recompilation agreement marks source verified', async () => {
  const out = await analyse();
  assert.equal(out.status, 'checked');
  assert.equal(out.security.contractVerified, true);
  assert.equal(out.sourceVerification.runtimeHashMatches, true);
  assert.equal(out.sourceVerification.recompilationHashMatches, true);
  assert.deepEqual(out.observedAbiSignatures, ['mint(address,uint256)']);
  assert.ok(out.checks.some(check => check.metric === 'abi.mintInterfaces' && check.passed === null));
  assert.ok(gapCodes(out).includes('CONTROL_FLOW_AND_PRIVILEGES_NOT_AUDITED'));
  for (const name of negativeSafetyFields) assert.equal(out.security[name], undefined, name);
  assert.ok(Buffer.byteLength(JSON.stringify(out.cache)) <= 8192);
});

test('runtime verification does not require downloading an unbounded source tree', async () => {
  const out = await analyse(facts(), artifact({ sources: undefined }));
  assert.equal(out.security.contractVerified, true);
  assert.equal(out.cache.summary.sourceContentAvailable, false);
  assert.equal(out.cache.summary.sourcesCount, 0);
  assert.equal(out.sourceFeatures, undefined);
  assert.ok(gapCodes(out).includes('SOURCE_CONTENT_NOT_REVIEWED'));
  assert.equal(out.security.canMint, undefined);
});

test('wrong chain or contract in source artifact cannot verify runtime', async () => {
  for (const overrides of [{ chainId: '1' }, { address: owner }]) {
    const out = await analyse(facts(), artifact(overrides));
    assert.equal(out.security.contractVerified, undefined);
    assert.ok(gapCodes(out).includes('SOURCE_IDENTITY_MISMATCH'));
  }
});

test('different RPC runtime or recompiled artifact, partial matches and transformations remain unverified', async () => {
  for (const body of [
    artifact({ runtimeBytecode: { onchainBytecode: '0x6000', recompiledBytecode: code } }),
    artifact({ runtimeBytecode: { onchainBytecode: code, recompiledBytecode: '0x6000' } }),
    artifact({ runtimeMatch: 'match' }),
    artifact({ runtimeBytecode: { onchainBytecode: code, recompiledBytecode: code, transformations: [{ type: 'insert', offset: 0 }] } }),
    artifact({ runtimeBytecode: { onchainBytecode: code, recompiledBytecode: code, immutableReferences: { '5': [{ start: 3, length: 32 }] } } }),
    artifact({ abi: undefined }),
  ]) {
    const out = await analyse(facts(), body);
    assert.equal(out.security.contractVerified, undefined);
    assert.equal(out.status, 'unavailable');
  }
});

test('a verified immutable runtime reuses compact source cache and refreshes dynamic owner/slots', async () => {
  const first = await analyse(facts({ owner }));
  let requests = 0;
  const second = await analyseContractSecurity(token, facts({ owner: '0x' + '0'.repeat(40), sourceCache: first.cache,
    proxySlots: { implementation: '0x' + '0'.repeat(24) + '3'.repeat(40), admin: '0x' + '0'.repeat(64) } }), {
    fetchImpl: async () => { requests++; throw new Error('cache should avoid HTTP'); }, now: () => clock + 60000,
  });
  assert.equal(requests, 0);
  assert.equal(second.sourceVerification.cached, true);
  assert.equal(second.sourceVerification.checkedAt, first.cache.sourceCheckedAt);
  assert.equal(second.observedState.owner, '0x' + '0'.repeat(40));
  assert.equal(second.observedState.proxySlots.implementation.address, '0x' + '3'.repeat(40));
  assert.equal(second.observedState.proxySlots.admin.populated, false);
  assert.equal(second.status, 'blocked');
  assert.equal(second.security.contractVerified, undefined);
  assert.equal(second.security.proxyUpgradeable, undefined);
});

test('changed runtime, invalid/future cache or incompatible analyzer version requires fresh source', async () => {
  const first = await analyse();
  for (const sourceCache of [
    { ...first.cache, runtimeHash: keccak256('0x6000') },
    { ...first.cache, sourceCheckedAt: new Date(clock + 1).toISOString() },
    { ...first.cache, analyzerVersion: 'older' },
    { ...first.cache, summary: { ...first.cache.summary, recompiledRuntimeHash: '0x' + 'b'.repeat(64) } },
    { ...first.cache, extra: 'x'.repeat(9000) },
  ]) {
    let requests = 0;
    const out = await analyse(facts({ sourceCache }), artifact(), { fetchImpl: async () => { requests++; return response(artifact()); } });
    assert.equal(requests, 1);
    assert.equal(out.security.contractVerified, true);
    assert.equal(out.sourceVerification.cached, false);
  }
});

test('unavailable source is cached with bounded retry backoff, not retried each minute', async () => {
  for (const [status, delay] of [[404, 6 * 3600000], [429, 3600000], [503, 5 * 60000]]) {
    const first = await analyse(facts(), artifact(), { fetchImpl: async () => new Response('', { status }) });
    assert.equal(first.cache.summary.sourceStatus, 'unavailable');
    let requests = 0;
    const fetchImpl = async () => { requests++; return response(artifact()); };
    const cached = await analyse(facts({ sourceCache: first.cache }), artifact(), { fetchImpl, now: () => clock + 60000 });
    assert.equal(requests, 0);
    assert.equal(cached.sourceVerification.cached, true);
    assert.equal(cached.security.contractVerified, undefined);
    const retried = await analyse(facts({ sourceCache: first.cache }), artifact(), { fetchImpl, now: () => clock + delay });
    assert.equal(requests, 1);
    assert.equal(retried.security.contractVerified, true);
  }
});

test('invalid pinned facts never fetch source; no bytecode is an observed block', async () => {
  for (const supplied of [facts({ chainId: 1 }), facts({ blockHash: '0x' + '0'.repeat(64) }), facts({ runtimeBytecode: '0xnothex' }),
    facts({ blockNumber: -1 }), facts({ address: owner })]) {
    let requests = 0;
    const out = await analyse(supplied, artifact(), { fetchImpl: async () => { requests++; return response(artifact()); } });
    assert.equal(requests, 0);
    assert.equal(out.status, 'unavailable');
    assert.ok(gapCodes(out).includes('CONTRACT_FACTS_INVALID'));
  }
  const empty = await analyse(facts({ runtimeBytecode: '0x' }));
  assert.equal(empty.status, 'blocked');
  assert.equal(empty.security.hasBytecode, false);
});

test('PUSH payload cannot become an opcode indicator and absent selectors never prove safety', async () => {
  const pushed = '0x60f460f260ff';
  const out = await analyse(facts({ runtimeBytecode: pushed, owner: '0x' + '0'.repeat(40) }),
    artifact({ runtimeBytecode: { onchainBytecode: pushed, recompiledBytecode: pushed }, abi: [] }));
  assert.deepEqual(out.observedOpcodes, {});
  assert.equal(out.status, 'checked');
  assert.ok(gapCodes(out).includes('OWNER_AND_INDIRECT_PRIVILEGES_NOT_PROVEN'));
  for (const name of negativeSafetyFields) assert.equal(out.security[name], undefined, name);
});

test('delegation indicators require independent implementation review, even if stub source matches', async () => {
  for (const delegated of [
    '0x363d3d373d3d3d363d73' + owner.slice(2) + '5af43d82803e903d91602b57fd5bf3',
    '0xef0100' + owner.slice(2),
  ]) {
    const out = await analyse(facts({ runtimeBytecode: delegated }),
      artifact({ runtimeBytecode: { onchainBytecode: delegated, recompiledBytecode: delegated } }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.security.contractVerified, undefined);
    assert.ok(out.risks.some(value => value.code === 'CONTRACT_UNREVIEWED_DELEGATION'));
    assert.ok(gapCodes(out).includes('DELEGATED_IMPLEMENTATIONS_NOT_VERIFIED'));
  }
});

test('a raw delegatecall opcode is an unknown reachability indicator, not proof of an executable privilege', async () => {
  const delegated = '0x6000f4';
  const out = await analyse(facts({ runtimeBytecode: delegated }),
    artifact({ runtimeBytecode: { onchainBytecode: delegated, recompiledBytecode: delegated } }));
  assert.equal(out.status, 'checked');
  assert.equal(out.security.contractVerified, undefined);
  assert.equal(out.risks.length, 0);
  assert.equal(out.observedOpcodes.DELEGATECALL, 1);
  assert.ok(gapCodes(out).includes('DELEGATED_IMPLEMENTATIONS_NOT_VERIFIED'));
});

test('source inspection reports roles/interfaces as review indicators and strips lexical comments/strings', async () => {
  const out = await analyse(facts(), artifact({
    abi: [{ type: 'function', name: 'grantRole', inputs: [{ type: 'bytes32' }, { type: 'address' }], stateMutability: 'nonpayable' }],
    sources: { 'Token.sol': { content: '/* delegatecall selfdestruct */ contract T { string s = "assembly sstore(0,0)"; function f() external { assembly { sstore(0,1) } } }' } },
  }));
  assert.equal(out.sourceFeatures.assembly, true);
  assert.equal(out.sourceFeatures.sstore, true);
  assert.equal(out.sourceFeatures.delegatecall, undefined);
  assert.equal(out.sourceFeatures.selfdestruct, undefined);
  assert.ok(gapCodes(out).includes('ROLE_MEMBERSHIP_NOT_ENUMERATED'));
  assert.ok(out.checks.some(value => value.metric === 'abi.ownershipOrRolesInterfaces' && value.passed === null));
  assert.equal(out.security.canMint, undefined);
});

test('source response size and redirect errors remain explicit and never enable verification', async () => {
  const responses = [
    new Response('x'.repeat(128 * 1024 + 1), { status: 200 }),
    new Response('{}', { status: 200, headers: { 'content-length': String(128 * 1024 + 1) } }),
    new Response('', { status: 302, headers: { location: 'https://example.invalid/' } }),
    new Response('not JSON', { status: 200 }),
  ];
  const expected = ['SOURCE_RESPONSE_LIMIT', 'SOURCE_RESPONSE_LIMIT', 'SOURCE_HTTP_302', 'SOURCE_INVALID_JSON'];
  for (let i = 0; i < responses.length; i++) {
    const out = await analyse(facts(), artifact(), { fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'manual');
      return responses[i];
    } });
    assert.equal(out.security.contractVerified, undefined);
    assert.ok(gapCodes(out).includes(expected[i]), expected[i]);
    assert.ok(Buffer.byteLength(JSON.stringify(out.cache)) <= 8192);
  }
});
