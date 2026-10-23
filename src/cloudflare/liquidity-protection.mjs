import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import { isEvmAddress, NETWORK } from '../network.mjs';
import { hash, hex, quantity } from './rpc.mjs';

const LP = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function MINIMUM_LIQUIDITY() view returns (uint256)',
]);
const ZERO = '0x' + '0'.repeat(40);
const DEAD = '0x' + '0'.repeat(36) + 'dead';
const MINIMUM_LIQUIDITY = 1000n;
const MAX_REQUESTS = 30;
const whole = value => Number.isSafeInteger(value) && value >= 0;

/**
 * LP balances at one canonical block, for one already identified v2 pair.
 * This does not enumerate other pools, analyse lockers or verify token safety.
 * No token-wide liquidityProtection fields are emitted from a single pool.
 */
export async function assessLiquidityProtection(rpc, pool, head, {
  identityVerified = false, creator = null, maxRequests = MAX_REQUESTS, now = Date.now,
} = {}) {
  const assessment = {
    status: 'NOT_CHECKED', scope: 'selected-v2-pool-only',
    poolId: typeof pool?.id === 'string' ? pool.id.slice(0, 160) : null,
    poolAddress: isEvmAddress(pool?.address) ? pool.address.toLowerCase() : null,
    checkedAt: null, blockNumber: null, blockHash: null, canonicalConfirmed: false,
    mechanism: null, coveragePct: null, poolBurnConfirmed: false, tokenWideProtectionProven: false,
    checks: [], risks: [], observations: [], gaps: [],
  };
  const evidence = { source: 'onchain-v2-lp-balances/v1', chainId: NETWORK.chainId, reads: [] };
  const output = { assessment, snapshot: {}, evidence };
  const gap = (code, message) => assessment.gaps.push({ code, message });
  if (pool?.type === 'v3' || pool?.type === 'v4') {
    assessment.status = 'UNSUPPORTED';
    assessment.scope = 'selected-pool-only';
    gap('POSITION_PROTECTION_UNVERIFIED', 'A proteção de posições v3/v4 exige identificar posições, proprietários e mecanismos de bloqueio; não é inferida dos saldos da pool.');
    return output;
  }
  if (pool?.type !== 'v2' || !isEvmAddress(pool?.address) || !whole(head?.number)
    || !hash(head?.hash) || !whole(head?.timestamp)) {
    gap('INVALID_LP_INPUT', 'Pool ou bloco inválido para verificar a proteção de LP.'); return output;
  }
  if (identityVerified !== true) {
    gap('LP_POOL_IDENTITY_UNVERIFIED', 'A identidade da pool deve ser verificada antes de interpretar os seus saldos de LP.'); return output;
  }
  const clock = now();
  if (!Number.isFinite(clock) || head.timestamp * 1000 > clock + 30000 || clock - head.timestamp * 1000 > 60000) {
    gap('LP_HEAD_NOT_FRESH', 'O bloco observado não tem atualidade suficiente para avaliar a proteção de LP.'); return output;
  }
  if (!whole(maxRequests)) { gap('INVALID_LP_RPC_BUDGET', 'Orçamento RPC inválido para verificar LP.'); return output; }
  const ceiling = Math.min(MAX_REQUESTS, maxRequests);
  const initial = whole(rpc?.requests) ? rpc.requests : 0;
  // Reservar ambas as chamadas: saldos e confirmação canónica. As duas leituras
  // finais do collector continuam fora deste teto de 30 pedidos.
  if (initial + 2 > ceiling) { gap('LP_RPC_BUDGET_DEFERRED', 'Verificação de LP adiada para preservar o orçamento RPC.'); return output; }
  const target = pool.address.toLowerCase();
  const methods = [
    { key: 'totalSupplyRaw', name: 'totalSupply', args: [] },
    { key: 'deadBalanceRaw', name: 'balanceOf', args: [DEAD] },
    { key: 'zeroBalanceRaw', name: 'balanceOf', args: [ZERO] },
    { key: 'minimumLiquidityRaw', name: 'MINIMUM_LIQUIDITY', args: [] },
  ];
  if (isEvmAddress(creator)) methods.push({ key: 'creatorBalanceRaw', name: 'balanceOf', args: [creator.toLowerCase()] });
  let results;
  try {
    results = await rpc.batch(methods.map(method => ['eth_call', [{ to: target,
      data: encodeFunctionData({ abi: LP, functionName: method.name, args: method.args }) }, hex(head.number)]]));
  } catch {
    gap('LP_READ_UNAVAILABLE', 'Não foi possível obter os saldos e a emissão de LP no bloco fixado.'); return output;
  }
  const values = {};
  for (let i = 0; i < methods.length; i++) {
    const method = methods[i];
    try {
      const value = decodeFunctionResult({ abi: LP, functionName: method.name, data: results?.[i]?.value });
      if (typeof value !== 'bigint' || value < 0n) throw new Error('INVALID_LP_VALUE');
      values[method.key] = value;
      evidence.reads.push({ method: method.name, ...(method.args.length ? { account: method.args[0] } : {}), value: value.toString() });
    } catch {
      gap(`LP_VALUE_UNAVAILABLE:${method.key}`, `Leitura de LP indisponível: ${method.name}.`);
    }
  }
  if (['totalSupplyRaw', 'deadBalanceRaw', 'zeroBalanceRaw'].some(key => values[key] === undefined)) return output;
  const supply = values.totalSupplyRaw; const dead = values.deadBalanceRaw; const zero = values.zeroBalanceRaw;
  if (dead + zero > supply || (values.creatorBalanceRaw !== undefined && values.creatorBalanceRaw > supply)
    || (values.minimumLiquidityRaw === MINIMUM_LIQUIDITY && supply > 0n && (supply < MINIMUM_LIQUIDITY || zero < MINIMUM_LIQUIDITY))) {
    gap('LP_BALANCES_INCONSISTENT', 'Os saldos de LP não são coerentes com a emissão total.'); return output;
  }
  if (Math.max(initial + 1, whole(rpc.requests) ? rpc.requests : 0) >= ceiling) {
    gap('LP_CANONICAL_CHECK_DEFERRED', 'A confirmação do bloco de LP foi adiada pelo orçamento RPC.'); return output;
  }
  try {
    const block = await rpc.request('eth_getBlockByNumber', [hex(head.number), false]);
    if (!block || quantity(block.number) !== head.number || !hash(block.hash) || block.hash.toLowerCase() !== head.hash.toLowerCase()
      || quantity(block.timestamp) !== head.timestamp) throw new Error('LP_BLOCK_CHANGED');
  } catch {
    gap('LP_CANONICAL_BLOCK_UNCONFIRMED', 'O bloco da leitura de LP não foi confirmado como canónico; os saldos não provam proteção.'); return output;
  }
  assessment.canonicalConfirmed = true;
  assessment.checkedAt = new Date(head.timestamp * 1000).toISOString();
  assessment.blockNumber = head.number; assessment.blockHash = head.hash.toLowerCase();
  Object.assign(assessment, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.toString()])));
  Object.assign(evidence, { poolAddress: target, blockNumber: head.number, blockHash: head.hash.toLowerCase(), canonicalConfirmed: true });

  // Nunca contar os 1000 LP mínimos de Uniswap v2 como proteção do fornecedor
  // de liquidez. Sem confirmação da constante, ignorar todo o saldo de zero.
  const minimumVerified = values.minimumLiquidityRaw === MINIMUM_LIQUIDITY;
  const zeroBeyondMinimum = minimumVerified && zero > MINIMUM_LIQUIDITY ? zero - MINIMUM_LIQUIDITY : 0n;
  const burned = dead + zeroBeyondMinimum;
  assessment.excludedZeroBalanceRaw = (zero - zeroBeyondMinimum).toString();
  assessment.genuineBurnedRaw = burned.toString();
  assessment.coveragePct = supply > 0n ? Number(burned * 1000000n / supply) / 10000 : 0;
  assessment.poolBurnConfirmed = supply > 0n && burned * 100n >= supply * 95n;
  assessment.status = supply === 0n ? 'EMPTY_LP_SUPPLY' : assessment.poolBurnConfirmed ? 'BURNED_95_PERCENT' : 'BURN_COVERAGE_BELOW_95';
  assessment.mechanism = assessment.poolBurnConfirmed ? 'burned' : null;
  assessment.checks.push({ metric: 'lp.minimumLiquidity1000Verified', value: minimumVerified, passed: minimumVerified ? true : null },
    { metric: 'lp.selectedPoolBurnCoverage95Pct', value: assessment.coveragePct, passed: supply > 0n ? assessment.poolBurnConfirmed : null });
  if (!minimumVerified) gap('LP_MINIMUM_LIQUIDITY_UNCONFIRMED', 'A constante mínima de 1000 LP não foi confirmada; todo o saldo no endereço zero foi excluído da cobertura.');
  if (values.creatorBalanceRaw !== undefined) {
    assessment.creatorAddress = creator.toLowerCase();
    assessment.checks.push({ metric: 'lp.creatorBalanceRaw', value: values.creatorBalanceRaw.toString(), passed: null });
    if (values.creatorBalanceRaw > 0n) assessment.observations.push('O endereço indicado como criador tem saldo de LP neste bloco; um saldo, por si só, não prova controlo de retirada nem exclui um bloqueio contratual.');
  }
  gap('LP_LOCKERS_NOT_VERIFIED', 'Não foram verificados contratos de bloqueio ou respetivas datas de desbloqueio.');
  gap('LP_POOL_UNIVERSE_INCOMPLETE', 'A cobertura refere-se apenas a esta pool; a proteção de todas as pools relevantes do token continua por comprovar.');
  return output;
}
