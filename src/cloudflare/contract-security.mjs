import { keccak256, stringToHex } from 'viem';
import { NETWORK, isEvmAddress } from '../network.mjs';

const VERSION = 'contract-security-v2';
const LIMIT = 128 * 1024;
const CACHE_LIMIT = 8192;
const MISSING_SOURCE_RETRY_MS = 6 * 3600000;
const TRANSIENT_SOURCE_RETRY_MS = 5 * 60000;
const RATE_LIMIT_RETRY_MS = 3600000;
// Whole source trees frequently exceed the read budget. Runtime verification
// uses the compiled artifact; source-content inspection remains a separate gap.
const FIELDS = 'abi,compilation,runtimeBytecode.onchainBytecode,runtimeBytecode.recompiledBytecode,runtimeBytecode.transformations,runtimeBytecode.transformationValues,runtimeBytecode.immutableReferences';
const bytes = value => typeof value === 'string' && /^0x(?:[a-f0-9]{2})*$/i.test(value);
const hash = value => typeof value === 'string' && /^0x[a-f0-9]{64}$/i.test(value);
const address = value => typeof value === 'string' && /^0x[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : null;
const shortText = (value, max = 96) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null;
const empty = value => value === undefined || value === null ||
  (Array.isArray(value) ? value.length === 0 : typeof value === 'object' && Object.keys(value).length === 0);
const size = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const OPCODES = { 0x55: 'SSTORE', 0xf0: 'CREATE', 0xf1: 'CALL', 0xf2: 'CALLCODE', 0xf4: 'DELEGATECALL',
  0xf5: 'CREATE2', 0xfa: 'STATICCALL', 0xff: 'SELFDESTRUCT' };
const GAP_LABELS = {
  CONTRACT_CLOCK_INVALID: 'Não foi possível confirmar a hora desta verificação.',
  CONTRACT_FACTS_INVALID: 'As leituras do contrato e do bloco não permitem verificar o código.',
  SOURCE_IDENTITY_MISMATCH: 'O registo de código devolvido não corresponde a este contrato nesta rede.',
  SOURCE_RUNTIME_UNAVAILABLE: 'O registo de código não inclui bytecode suficiente para comparação.',
  SOURCE_RPC_RUNTIME_MISMATCH: 'O bytecode do registo de código difere do bytecode observado na rede.',
  SOURCE_RECOMPILATION_NOT_EXACT: 'A recompilação não coincide byte a byte com o contrato observado; a verificação não foi aprovada.',
  SOURCE_ARTIFACT_INCOMPLETE: 'O registo de código não inclui fontes e interfaces suficientes para análise.',
  SOURCE_CONTENT_NOT_REVIEWED: 'As fontes completas não foram descarregadas nesta leitura; a correspondência do bytecode não equivale a revisão do código-fonte.',
  SOURCE_NOT_EXACTLY_MATCHED: 'Não foi obtida uma correspondência exata entre o código e o contrato observado.',
  OWNER_AND_INDIRECT_PRIVILEGES_NOT_PROVEN: 'owner() é uma observação; os seus privilégios e outros administradores ainda exigem análise.',
  DELEGATED_IMPLEMENTATIONS_NOT_VERIFIED: 'Há indicadores de delegação; a implementação e os seus administradores ainda exigem verificação.',
  CONTRACT_BYTECODE_FORMAT_UNSUPPORTED: 'O formato do bytecode não permite esta análise de instruções EVM.',
  CONTRACT_SOURCE_CACHE_REJECTED: 'O registo de código guardado foi renovado por estar expirado ou não corresponder a esta análise.',
  SOURCE_NOT_INDEXED: 'Este contrato ainda não tem código verificado disponível no Sourcify.',
  SOURCE_RESPONSE_LIMIT: 'O registo de código excedeu o limite de leitura; não foi usado para aprovar segurança.',
  SOURCE_INVALID_JSON: 'O fornecedor de código não devolveu um registo válido.',
  SOURCE_TIMEOUT: 'A consulta do código não respondeu dentro do tempo disponível; será repetida após uma pausa.',
  SOURCE_UNAVAILABLE: 'O fornecedor de código está indisponível; será repetida a consulta após uma pausa.',
  CONTRACT_ABI_ENUMERATION_TRUNCATED: 'A lista de interfaces é extensa e a leitura apresentada é parcial.',
  ROLE_MEMBERSHIP_NOT_ENUMERATED: 'Existem interfaces de papéis administrativos; os seus titulares não foram enumerados.',
  CONTROL_FLOW_AND_PRIVILEGES_NOT_AUDITED: 'Correspondência de código não equivale a auditoria dos caminhos de execução e dos privilégios.',
  TRANSFER_SEMANTICS_NOT_PROVEN: 'A análise de código e interfaces não comprova por si só todas as regras de transferência.',
};
const gapLabel = code => GAP_LABELS[code] ?? (/^SOURCE_HTTP_\d{3}$/.test(code)
  ? code === 'SOURCE_HTTP_429' ? 'O fornecedor de código limitou as consultas; nova tentativa adiada.'
    : 'O fornecedor de código recusou ou não conseguiu responder à consulta.'
  : 'Uma parte da verificação do contrato não ficou comprovada.');

// Presence is an indicator, not proof of reachability or transfer semantics.
// PUSH data is never mistaken for an opcode. Do not strip alleged metadata:
// arbitrary contracts may jump into bytes that merely resemble metadata.
function bytecodeIndicators(code) {
  const result = { format: code.startsWith('0xef') ? 'unsupported-ef-format' : 'legacy-evm', opcodes: {} };
  const body = code.slice(2);
  for (let index = 0; index < body.length; index += 2) {
    const opcode = Number.parseInt(body.slice(index, index + 2), 16);
    if (OPCODES[opcode]) result.opcodes[OPCODES[opcode]] = (result.opcodes[OPCODES[opcode]] ?? 0) + 1;
    if (opcode >= 0x60 && opcode <= 0x7f) index += (opcode - 0x5f) * 2;
  }
  const clone = /^0x363d3d373d3d3d363d73([a-f0-9]{40})5af43d82803e903d91602b57fd5bf3$/.exec(code);
  if (clone) result.delegation = { kind: 'eip1167-fixed-implementation', implementation: `0x${clone[1]}` };
  const delegatedAccount = /^0xef0100([a-f0-9]{40})$/.exec(code);
  if (delegatedAccount) result.delegation = { kind: 'eip7702-delegation', implementation: `0x${delegatedAccount[1]}` };
  return result;
}

async function sourceGet(url, fetchImpl) {
  const controller = new AbortController(); let timer; let reader; let httpStatus;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(); void reader?.cancel().catch(() => {}); reject(new Error('SOURCE_TIMEOUT'));
    }, 3000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetchImpl.call(globalThis, url, { method: 'GET', redirect: 'manual',
        headers: { accept: 'application/json' }, signal: controller.signal });
      httpStatus = response.status;
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(response.status === 404 ? 'SOURCE_NOT_INDEXED' : `SOURCE_HTTP_${response.status}`);
      }
      const length = response.headers.get('content-length');
      if (length && /^\d+$/.test(length) && Number(length) > LIMIT) {
        void response.body?.cancel().catch(() => {}); throw new Error('SOURCE_RESPONSE_LIMIT');
      }
      if (!response.body) throw new Error('SOURCE_INVALID_JSON');
      reader = response.body.getReader(); const chunks = []; let total = 0;
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > LIMIT) { void reader.cancel().catch(() => {}); throw new Error('SOURCE_RESPONSE_LIMIT'); }
        chunks.push(value);
      }
      const output = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output)); }
      catch { throw new Error('SOURCE_INVALID_JSON'); }
      return { body, httpStatus, responseBytes: total };
    })()]);
  } catch (error) {
    const reason = controller.signal.aborted ? 'SOURCE_TIMEOUT' :
      ['SOURCE_NOT_INDEXED', 'SOURCE_RESPONSE_LIMIT', 'SOURCE_INVALID_JSON'].includes(error?.message) || /^SOURCE_HTTP_[1-5]\d{2}$/.test(error?.message)
        ? error.message : 'SOURCE_UNAVAILABLE';
    return { reason, ...(Number.isInteger(httpStatus) ? { httpStatus } : {}) };
  } finally { clearTimeout(timer); }
}

function abiType(input, depth = 0) {
  if (depth > 4 || typeof input?.type !== 'string' || input.type.length > 48) return null;
  if (/^tuple(?:\[\d*\])*$/.test(input.type)) {
    if (!Array.isArray(input.components) || input.components.length > 12) return null;
    const components = input.components.map(component => abiType(component, depth + 1));
    return components.every(Boolean) ? `(${components.join(',')})${input.type.slice(5)}` : null;
  }
  return /^(?:address|bool|string|bytes(?:[1-9]|[12]\d|3[0-2])?|u?int(?:8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?)(?:\[\d*\])*$/.test(input.type)
    ? input.type.replace(/^(u?int)(?=\[|$)/, '$1256') : null;
}

function sourceFeatures(content) {
  // Strip comments and string contents before reporting lexical indicators.
  // These are not control-flow proofs and never become negative safety flags.
  const text = content.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, ' ');
  return {
    assembly: /\bassembly\b/.test(text), delegatecall: /\bdelegatecall\b/.test(text),
    callcode: /\bcallcode\b/.test(text), selfdestruct: /\b(?:selfdestruct|suicide)\b/.test(text),
    lowLevelCall: /\.\s*call\s*[({]/.test(text), sstore: /\bsstore\s*\(/.test(text),
  };
}

function summarizeSource(record, requested, runtimeHash) {
  const summary = { sourceStatus: 'unavailable', reason: 'SOURCE_NOT_EXACTLY_MATCHED' };
  if (String(record?.chainId) !== String(NETWORK.chainId) || address(record?.address) !== requested) {
    summary.reason = 'SOURCE_IDENTITY_MISMATCH'; return summary;
  }
  const runtime = record.runtimeBytecode;
  if (!bytes(runtime?.onchainBytecode) || runtime.onchainBytecode === '0x') {
    summary.reason = 'SOURCE_RUNTIME_UNAVAILABLE'; return summary;
  }
  summary.onchainRuntimeHash = keccak256(runtime.onchainBytecode);
  summary.runtimeMatch = ['match', 'exact_match'].includes(record.runtimeMatch) ? record.runtimeMatch : null;
  if (summary.onchainRuntimeHash !== runtimeHash) { summary.reason = 'SOURCE_RPC_RUNTIME_MISMATCH'; return summary; }
  summary.runtimeHashMatches = true;
  if (bytes(runtime.recompiledBytecode) && runtime.recompiledBytecode !== '0x')
    summary.recompiledRuntimeHash = keccak256(runtime.recompiledBytecode);
  if (record.runtimeMatch !== 'exact_match' || summary.recompiledRuntimeHash !== runtimeHash ||
      !empty(runtime.transformations) || !empty(runtime.transformationValues) || !empty(runtime.immutableReferences)) {
    summary.reason = 'SOURCE_RECOMPILATION_NOT_EXACT'; return summary;
  }
  if (!Array.isArray(record.abi)) {
    summary.reason = 'SOURCE_ARTIFACT_INCOMPLETE'; return summary;
  }
  const files = record.sources && typeof record.sources === 'object' && !Array.isArray(record.sources)
    ? Object.entries(record.sources) : [];
  const sourceContentAvailable = files.length > 0 && files.every(([, source]) => typeof source?.content === 'string');
  const functions = []; let functionsTotal = 0;
  for (const entry of record.abi) {
    if (entry?.type !== 'function') continue;
    functionsTotal++;
    if (typeof entry.name !== 'string' || !/^[a-z_$][a-z0-9_$]{0,63}$/i.test(entry.name) ||
        !Array.isArray(entry.inputs) || entry.inputs.length > 16) continue;
    const types = entry.inputs.map(input => abiType(input));
    if (!types.every(Boolean)) continue;
    const signature = `${entry.name}(${types.join(',')})`;
    if (signature.length > 160 || functions.length >= 24) continue;
    functions.push({ signature, mutability: ['view', 'pure', 'payable', 'nonpayable'].includes(entry.stateMutability) ? entry.stateMutability : 'unknown' });
  }
  const features = {};
  for (const [, source] of sourceContentAvailable ? files : []) for (const [name, present] of Object.entries(sourceFeatures(source.content)))
    if (present) features[name] = true;
  return { sourceStatus: 'matched', runtimeMatch: 'exact_match', runtimeHashMatches: true,
    onchainRuntimeHash: summary.onchainRuntimeHash, recompiledRuntimeHash: summary.recompiledRuntimeHash,
    compilationName: shortText(record.compilation?.name), sourceContentAvailable, sourcesCount: sourceContentAvailable ? files.length : 0,
    ...(sourceContentAvailable ? { sourcesHash: keccak256(stringToHex(files.sort(([a], [b]) => a.localeCompare(b))
      .map(([path, source]) => `${path}\u0000${keccak256(stringToHex(source.content))}`).join('\u0000'))) } : {}),
    functions, functionsTotal, abiTruncated: functions.length !== functionsTotal, sourceFeatures: features };
}

function validatedCache(cache, requested, runtimeHash, now) {
  try {
    if (!cache || size(cache) > CACHE_LIMIT || cache.analyzerVersion !== VERSION || cache.chainId !== NETWORK.chainId ||
        cache.address !== requested || cache.runtimeHash !== runtimeHash || !Number.isFinite(Date.parse(cache.sourceCheckedAt))) return null;
    const age = now - Date.parse(cache.sourceCheckedAt);
    if (age < 0) return null;
    const summary = cache.summary;
    if (!summary || !['matched', 'unavailable'].includes(summary.sourceStatus)) return null;
    if (summary.sourceStatus === 'matched') {
      if (summary.runtimeMatch !== 'exact_match' || summary.runtimeHashMatches !== true ||
          summary.onchainRuntimeHash !== runtimeHash || summary.recompiledRuntimeHash !== runtimeHash ||
          typeof summary.sourceContentAvailable !== 'boolean' || !Number.isSafeInteger(summary.sourcesCount) ||
          (summary.sourceContentAvailable ? !hash(summary.sourcesHash) || summary.sourcesCount < 1 : summary.sourcesCount !== 0) ||
          !Array.isArray(summary.functions) || summary.functions.length > 24 ||
          summary.functions.some(fn => typeof fn?.signature !== 'string' || fn.signature.length > 160 ||
            !/^[a-z_$][a-z0-9_$]*\([a-z0-9_,()\[\]]*\)$/i.test(fn.signature) ||
            !['view', 'pure', 'payable', 'nonpayable', 'unknown'].includes(fn.mutability))) return null;
    } else {
      if (typeof summary.reason !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(summary.reason)) return null;
      const retryAfter = summary.reason === 'SOURCE_HTTP_429' ? RATE_LIMIT_RETRY_MS
        : ['SOURCE_UNAVAILABLE', 'SOURCE_TIMEOUT'].includes(summary.reason) || /^SOURCE_HTTP_5\d{2}$/.test(summary.reason)
          ? TRANSIENT_SOURCE_RETRY_MS : MISSING_SOURCE_RETRY_MS;
      if (age >= retryAfter) return null;
    }
    return { analyzerVersion: VERSION, chainId: NETWORK.chainId, address: requested, runtimeHash,
      sourceCheckedAt: cache.sourceCheckedAt, summary: structuredClone(summary),
      ...(Number.isInteger(cache.httpStatus) ? { httpStatus: cache.httpStatus } : {}),
      ...(Number.isSafeInteger(cache.responseBytes) && cache.responseBytes >= 0 ? { responseBytes: cache.responseBytes } : {}) };
  } catch { return null; }
}

/**
 * Existing pinned RPC facts only; this module never duplicates RPC reads.
 * Source inspection is NOT an audit. No canMint/canPause/etc false values are
 * inferred from ABI, owner(), opcode absence, or third-party negative flags.
 * Reuse sourceCache for the same runtime: Sourcify requires caching, not crawling.
 */
export async function analyseContractSecurity(requestedAddress, facts = {}, { fetchImpl = fetch, now = Date.now } = {}) {
  const result = { status: 'unavailable', security: {}, checks: [], risks: [], gaps: [], evidence: [] };
  const gap = code => { if (!result.gaps.some(value => value.code === code) && result.gaps.length < 12)
    result.gaps.push({ code, message: gapLabel(code) }); };
  const requested = address(requestedAddress);
  const code = typeof facts.runtimeBytecode === 'string' ? facts.runtimeBytecode.toLowerCase() : null;
  let checkedAt; let clock;
  try { clock = now(); checkedAt = new Date(clock).toISOString(); } catch { gap('CONTRACT_CLOCK_INVALID'); return result; }
  if (!isEvmAddress(requested) || facts.chainId !== NETWORK.chainId ||
      !Number.isSafeInteger(facts.blockNumber) || facts.blockNumber < 0 || !hash(facts.blockHash) || /^0x0{64}$/i.test(facts.blockHash) ||
      (facts.address !== undefined && address(facts.address) !== requested) || !bytes(code) || code.length > LIMIT + 2) {
    gap('CONTRACT_FACTS_INVALID'); return result;
  }
  const runtimeHash = keccak256(code);
  result.security.hasBytecode = code !== '0x';
  result.checks.push({ metric: 'security.hasBytecode', value: result.security.hasBytecode, passed: result.security.hasBytecode });
  result.evidence.push({ source: 'pinned-rpc-runtime', chainId: NETWORK.chainId, address: requested,
    blockNumber: facts.blockNumber, blockHash: facts.blockHash.toLowerCase(), runtimeHash, bytecodeBytes: (code.length - 2) / 2 });
  if (code === '0x') {
    result.status = 'blocked'; result.risks.push({ code: 'CONTRACT_NO_BYTECODE', reason: 'O RPC não devolveu bytecode no bloco observado.' }); return result;
  }
  const indicators = bytecodeIndicators(code);
  result.observedOpcodes = indicators.opcodes;
  result.checks.push({ metric: 'runtime.opcodeIndicators', value: indicators.opcodes, passed: null });
  result.observedState = {};
  if (address(facts.owner)) {
    result.observedState.owner = address(facts.owner);
    result.checks.push({ metric: 'owner.returnedAddress', value: result.observedState.owner, passed: null });
    gap('OWNER_AND_INDIRECT_PRIVILEGES_NOT_PROVEN');
  }
  if (typeof facts.paused === 'boolean') {
    result.observedState.paused = facts.paused;
    result.checks.push({ metric: 'paused.returnedValue', value: facts.paused, passed: null });
  }
  let populatedSlot = false;
  const proxySlots = {};
  for (const name of ['implementation', 'admin', 'beacon']) {
    const value = facts.proxySlots?.[name];
    if (!hash(value)) continue;
    const nonzero = BigInt(value) !== 0n; populatedSlot ||= nonzero;
    proxySlots[name] = { populated: nonzero,
      ...(nonzero && /^0x0{24}[a-f0-9]{40}$/i.test(value) ? { address: `0x${value.slice(-40).toLowerCase()}` } : {}) };
  }
  if (Object.keys(proxySlots).length) {
    result.observedState.proxySlots = proxySlots;
    result.checks.push({ metric: 'eip1967.observedSlots', value: proxySlots, passed: null });
  }
  const recognizedDelegation = indicators.delegation || populatedSlot;
  const delegation = recognizedDelegation || indicators.opcodes.DELEGATECALL || indicators.opcodes.CALLCODE;
  if (indicators.delegation) result.delegation = indicators.delegation;
  if (delegation) {
    gap('DELEGATED_IMPLEMENTATIONS_NOT_VERIFIED');
  }
  // A linear scan cannot prove that an instruction is reachable. Only an
  // identified delegation form or populated proxy slot becomes a blocking
  // review finding; isolated opcodes remain explicit unknowns.
  if (recognizedDelegation) {
    result.risks.push({ code: 'CONTRACT_UNREVIEWED_DELEGATION',
      reason: 'Há indicadores de delegação ou slots proxy; a implementação e os caminhos de controlo exigem verificação própria.' });
  }
  if (indicators.format !== 'legacy-evm') gap('CONTRACT_BYTECODE_FORMAT_UNSUPPORTED');

  let cache = validatedCache(facts.sourceCache, requested, runtimeHash, clock);
  const cached = Boolean(cache);
  if (!cache) {
    if (facts.sourceCache) gap('CONTRACT_SOURCE_CACHE_REJECTED');
    const url = `https://sourcify.dev/server/v2/contract/${NETWORK.chainId}/${requested}?fields=${FIELDS}`;
    const source = await sourceGet(url, fetchImpl);
    const summary = source.reason ? { sourceStatus: 'unavailable', reason: source.reason } : summarizeSource(source.body, requested, runtimeHash);
    cache = { analyzerVersion: VERSION, chainId: NETWORK.chainId, address: requested, runtimeHash, sourceCheckedAt: checkedAt, summary };
    if (source.httpStatus) cache.httpStatus = source.httpStatus;
    if (source.responseBytes !== undefined) cache.responseBytes = source.responseBytes;
  }
  result.cache = cache;
  const summary = cache.summary;
  result.sourceVerification = { provider: 'sourcify', status: summary.sourceStatus, checkedAt: cache.sourceCheckedAt,
    runtimeMatch: summary.runtimeMatch ?? null, runtimeHashMatches: summary.runtimeHashMatches === true,
    recompilationHashMatches: summary.recompiledRuntimeHash === runtimeHash, cached };
  result.evidence.push({ source: 'sourcify-v2-runtime-artifact', cached, checkedAt: cache.sourceCheckedAt,
    runtimeHash, ...(summary.onchainRuntimeHash ? { onchainRuntimeHash: summary.onchainRuntimeHash } : {}),
    ...(summary.recompiledRuntimeHash ? { recompiledRuntimeHash: summary.recompiledRuntimeHash } : {}),
    ...(summary.sourcesHash ? { sourcesHash: summary.sourcesHash, sourcesCount: summary.sourcesCount } : {}),
    ...(cache.httpStatus ? { httpStatus: cache.httpStatus } : {}),
    ...(cache.responseBytes !== undefined ? { responseBytes: cache.responseBytes } : {}) });
  if (summary.sourceStatus === 'matched') {
    result.status = 'checked';
    result.observedAbiSignatures = summary.functions.map(fn => fn.signature);
    if (summary.sourceContentAvailable) result.sourceFeatures = summary.sourceFeatures;
    result.checks.push({ metric: 'source.runtimeAndRecompilationMatch', value: true, passed: true });
    result.checks.push({ metric: 'source.compilationName', value: summary.compilationName, passed: null });
    const classifications = [
      ['mint', /^(?:mint|mintTo|mintTokens|issue|increaseSupply)\(/i],
      ['pause', /^(?:pause|unpause|setPaused|setTrading|enableTrading|disableTrading)\(/i],
      ['blacklistOrWhitelist', /(?:blacklist|whitelist|blocklist|allowlist|botlist)/i],
      ['feeControls', /^(?:set|update|change).*(?:fee|tax|slippage)/i],
      ['ownershipOrRoles', /^(?:owner|transferOwnership|renounceOwnership|grantRole|revokeRole|renounceRole|hasRole|getRoleAdmin)\(/i],
      ['upgrade', /^(?:upgradeTo|upgradeToAndCall|setImplementation|setBeacon|changeAdmin)\(/i],
      ['balanceControls', /^(?:setBalance|changeBalance|wipe|confiscate|seize|burnFrom)\(/i],
    ];
    for (const [kind, pattern] of classifications) {
      const signatures = summary.functions.filter(fn => pattern.test(fn.signature)).map(fn => fn.signature);
      if (signatures.length) result.checks.push({ metric: `abi.${kind}Interfaces`, value: signatures, passed: null });
    }
    if (summary.sourceContentAvailable) result.checks.push({ metric: 'source.lexicalIndicators', value: summary.sourceFeatures, passed: null });
    else gap('SOURCE_CONTENT_NOT_REVIEWED');
    if (summary.abiTruncated) gap('CONTRACT_ABI_ENUMERATION_TRUNCATED');
    if (summary.functions.some(fn => /^(?:grantRole|revokeRole|hasRole|getRoleAdmin)\(/.test(fn.signature)))
      gap('ROLE_MEMBERSHIP_NOT_ENUMERATED');
    if (!delegation && indicators.format === 'legacy-evm') result.security.contractVerified = true;
  } else gap(summary.reason ?? 'CONTRACT_SOURCE_UNAVAILABLE');
  if (recognizedDelegation) result.status = 'blocked';
  gap('CONTROL_FLOW_AND_PRIVILEGES_NOT_AUDITED');
  gap('TRANSFER_SEMANTICS_NOT_PROVEN');
  // No audited runtime allowlist is embedded. ABI/selector absence and owner
  // renunciation never fill negative safety gates or imply trade approval.
  return result;
}
