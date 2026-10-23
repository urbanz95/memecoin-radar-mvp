import { decodeEventLog, formatUnits } from 'viem';
import { ERC20, V2, V3, V4, SWAPS, topic } from './abi.mjs';
import { readContract } from './reader.mjs';
import { quantity } from './rpc.mjs';
import { QUOTE_ASSETS } from '../network.mjs';

export function targetFor(pool) {
  const quotes = Object.entries(QUOTE_ASSETS);
  const q0 = quotes.find(([, address]) => address === pool.token0);
  const q1 = quotes.find(([, address]) => address === pool.token1);
  if (Boolean(q0) === Boolean(q1)) return null;
  const quote = q0 ?? q1;
  return { address: q0 ? pool.token1 : pool.token0, quoteAsset: quote[0], quoteAssetAddress: quote[1], quoteIndex: q0 ? 0 : 1 };
}

export function rationalDecimal(numerator, denominator, precision = 36) {
  if (denominator <= 0n || numerator < 0n) return null;
  const scale = 10n ** BigInt(precision);
  return formatUnits(numerator * scale / denominator, precision);
}

export function quotePrice(pool, state, targetDecimals, quoteDecimals) {
  if (![targetDecimals, quoteDecimals].every((v) => Number.isInteger(v) && v >= 0 && v <= 36)) return null;
  const target = targetFor(pool);
  if (!target) return null;
  let numerator; let denominator;
  if (pool.type === 'v2') {
    const quote = target.quoteIndex === 0 ? BigInt(state.reserve0) : BigInt(state.reserve1);
    const token = target.quoteIndex === 0 ? BigInt(state.reserve1) : BigInt(state.reserve0);
    numerator = quote * 10n ** BigInt(targetDecimals);
    denominator = token * 10n ** BigInt(quoteDecimals);
  } else {
    const square = BigInt(state.sqrtPriceX96) ** 2n;
    const q192 = 2n ** 192n;
    numerator = (target.quoteIndex === 1 ? square : q192) * 10n ** BigInt(targetDecimals);
    denominator = (target.quoteIndex === 1 ? q192 : square) * 10n ** BigInt(quoteDecimals);
  }
  return denominator > 0n ? { numerator: numerator.toString(), denominator: denominator.toString(), value: rationalDecimal(numerator, denominator) } : null;
}

export async function poolState(rpc, pool, head) {
  const call = (address, abi, name, args = []) => readContract(rpc, address, abi, name, args, head.number);
  if (pool.type === 'v4') {
    const slot = await call(pool.stateView, V4, 'getSlot0', [pool.poolId]);
    const liquidity = await call(pool.stateView, V4, 'getLiquidity', [pool.poolId]);
    return { sqrtPriceX96: slot[0].toString(), tick: slot[1], protocolFee: slot[2], lpFee: slot[3],
      activeLiquidityRaw: liquidity.toString(), poolIdentityVerified: false,
      verification: 'official-manager-initialize-event-and-stateview; hook/router/LP review pending' };
  }
  const abi = pool.type === 'v2' ? V2 : V3;
  const factory = (await call(pool.address, abi, 'factory')).toLowerCase();
  const token0 = (await call(pool.address, abi, 'token0')).toLowerCase();
  const token1 = (await call(pool.address, abi, 'token1')).toLowerCase();
  if (factory !== pool.factory || token0 !== pool.token0 || token1 !== pool.token1) throw new Error('Pool não corresponde à factory e aos tokens do evento');
  const indexed = pool.type === 'v2' ? await call(factory, V2, 'getPair', [token0, token1]) : await call(factory, V3, 'getPool', [token0, token1, pool.fee]);
  if (indexed.toLowerCase() !== pool.address) throw new Error('Factory não reconhece a pool');
  if (pool.type === 'v2') {
    const reserves = await call(pool.address, V2, 'getReserves');
    return { reserve0: reserves[0].toString(), reserve1: reserves[1].toString(), reserveTimestamp: reserves[2], poolIdentityVerified: true };
  }
  if (await call(pool.address, V3, 'fee') !== pool.fee) throw new Error('Fee da pool não corresponde ao evento');
  const slot = await call(pool.address, V3, 'slot0');
  const liquidity = await call(pool.address, V3, 'liquidity');
  const balance0 = await call(token0, ERC20, 'balanceOf', [pool.address]);
  const balance1 = await call(token1, ERC20, 'balanceOf', [pool.address]);
  return { sqrtPriceX96: slot[0].toString(), tick: slot[1], unlocked: slot[6], activeLiquidityRaw: liquidity.toString(),
    token0BalanceRaw: balance0.toString(), token1BalanceRaw: balance1.toString(), poolIdentityVerified: true,
    warning: 'Saldos/activeLiquidity de CLMM não são profundidade executável nem USD; não usar como liquidityUsd.' };
}

export function swapQuoteFlow(log, pool) {
  const { args } = decodeEventLog({ abi: [SWAPS[pool.type]], topics: log.topics, data: log.data, strict: true });
  const target = targetFor(pool);
  const i = target.quoteIndex;
  if (pool.type === 'v2') {
    const input = i === 0 ? args.amount0In : args.amount1In;
    const output = i === 0 ? args.amount0Out : args.amount1Out;
    if (input > 0n && output > 0n) throw new Error('Swap com entrada e saída da mesma quote currency requer revisão');
    return { buyQuoteRaw: input, sellQuoteRaw: output };
  }
  if (pool.type === 'v4' && args.id.toLowerCase() !== pool.poolId) throw new Error('Swap v4 de outra pool');
  const amount = i === 0 ? args.amount0 : args.amount1;
  // v3: positivo é pago à pool. v4: positivo é recebido pelo caller (BalanceDelta).
  const paidToPool = pool.type === 'v4' ? -amount : amount;
  return { buyQuoteRaw: paidToPool > 0n ? paidToPool : 0n, sellQuoteRaw: paidToPool < 0n ? -paidToPool : 0n };
}

export async function poolActivity(rpc, pool, head, boundaries, quoteDecimals, config) {
  const topics = [topic(SWAPS[pool.type]), ...(pool.type === 'v4' ? [pool.poolId] : [])];
  const logs = [];
  for (let start = Math.max(boundaries['24h'], pool.createdBlock); start <= head.number; start += config.chunkSize) {
    logs.push(...await rpc.logs(pool.address, topics, start, Math.min(head.number, start + config.chunkSize - 1)));
    if (logs.length > config.maxSwapsPerPool) return { complete: false, reason: 'SWAP_LIMIT_EXCEEDED', observedAtLeast: logs.length, fromBlock: boundaries['24h'], toBlock: head.number };
  }
  if (!Number.isInteger(quoteDecimals)) return { complete: false, reason: 'QUOTE_DECIMALS_UNAVAILABLE' };
  const windows = {};
  for (const window of ['5m', 'previous5m', '1h', '24h']) windows[window] = { buys: 0n, sells: 0n, swaps: 0, transactions: new Set() };
  for (const log of logs) {
    const block = quantity(log.blockNumber);
    const flow = swapQuoteFlow(log, pool);
    const names = ['24h'];
    if (block >= boundaries['1h']) names.push('1h');
    if (block >= boundaries['5m']) names.push('5m');
    else if (block >= boundaries['10m']) names.push('previous5m');
    for (const name of names) {
      const bucket = windows[name];
      bucket.buys += flow.buyQuoteRaw; bucket.sells += flow.sellQuoteRaw; bucket.swaps++;
      bucket.transactions.add(log.transactionHash.toLowerCase());
    }
  }
  return { complete: true, fromBlock: boundaries['24h'], toBlock: head.number,
    windows: Object.fromEntries(Object.entries(windows).map(([name, w]) => [name, {
      buyQuoteRaw: w.buys.toString(), sellQuoteRaw: w.sells.toString(), volumeQuoteRaw: (w.buys + w.sells).toString(),
      buyQuote: formatUnits(w.buys, quoteDecimals), sellQuote: formatUnits(w.sells, quoteDecimals), volumeQuote: formatUnits(w.buys + w.sells, quoteDecimals),
      swaps: w.swaps, transactionCount: w.transactions.size,
    }])),
    methodology: 'Fluxos da quote currency da pool; não são USD, traders únicos ou volume orgânico. Não agregar entre pools sem deduplicar rotas.' };
}
