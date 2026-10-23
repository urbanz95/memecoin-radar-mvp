import { decodeEventLog, decodeFunctionResult, encodeFunctionData, formatUnits } from 'viem';
import { ERC20, V2, V3, V4, SWAPS, topic } from '../onchain/abi.mjs';
import { QUOTE_ASSETS, isEvmAddress } from '../network.mjs';
import { hash, hex, quantity } from './rpc.mjs';

const zeroAddress = '0x' + '0'.repeat(40);
const word = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const decimals = value => Number.isInteger(value) && value >= 0 && value <= 36;
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const read = (key, to, abi, name, args = []) => ({ key, to, abi, name, args });

function quoteFor(pool) {
  const entries = Object.entries(QUOTE_ASSETS);
  // Uniswap v4 represents the chain's native ETH currency with address zero.
  // It is not an ERC-20 or WETH and must never receive decimals()/balanceOf().
  if (pool.type === 'v4') entries.push(['ETH', zeroAddress]);
  const first = entries.find(([, value]) => value === pool.token0.toLowerCase());
  const second = entries.find(([, value]) => value === pool.token1.toLowerCase());
  if (Boolean(first) === Boolean(second)) return null;
  const [quoteAsset, quoteAddress] = first ?? second;
  return { quoteAsset, quoteAddress, index: first ? 0 : 1, native: quoteAsset === 'ETH' };
}

// Spot price in the quote currency's units. No USD conversion or
// executable depth is inferred from reserves, balances or active liquidity.
function spotPrice(pool, state, quote, targetDecimals, quoteDecimals) {
  if (!decimals(targetDecimals) || !decimals(quoteDecimals)) return null;
  let numerator; let denominator;
  if (pool.type === 'v2' && state.reserve0 !== undefined && state.reserve1 !== undefined) {
    const quoteRaw = BigInt(quote.index === 0 ? state.reserve0 : state.reserve1);
    const targetRaw = BigInt(quote.index === 0 ? state.reserve1 : state.reserve0);
    numerator = quoteRaw * 10n ** BigInt(targetDecimals);
    denominator = targetRaw * 10n ** BigInt(quoteDecimals);
  } else if (state.sqrtPriceX96 !== undefined) {
    const square = BigInt(state.sqrtPriceX96) ** 2n;
    const q192 = 2n ** 192n;
    numerator = (quote.index === 1 ? square : q192) * 10n ** BigInt(targetDecimals);
    denominator = (quote.index === 1 ? q192 : square) * 10n ** BigInt(quoteDecimals);
  }
  if (!(numerator > 0n) || !(denominator > 0n)) return null;
  const scaled = numerator * 10n ** 96n / denominator;
  return scaled > 0n ? { value: formatUnits(scaled, 96), quoteAsset: quote.quoteAsset } : null;
}

function analyseLogs(logs, pool, head, quote, quoteDecimals, fromBlock, events) {
  const scope = { scope: 'single-pool-block-range-sample', fromBlock, toBlock: head.number,
    fromTimestamp: null, toTimestamp: whole(head.timestamp) ? head.timestamp : null };
  if (!Array.isArray(logs)) throw new Error('INVALID_ACTIVITY_LOGS');
  if (logs.length > 64) return { ...scope, complete: false, reason: 'ACTIVITY_LOG_LIMIT_EXCEEDED', maxLogs: 64 };
  const event = SWAPS[pool.type]; const eventTopic = topic(event).toLowerCase();
  const seen = new Map(); const transactions = new Set();
  const blockHashes = new Map(); const transactionBlocks = new Map(); const blockIndices = new Map();
  let buys = 0n; let sells = 0n; let swaps = 0;
  for (const log of logs) {
    if (!log || address(log.address) !== pool.address.toLowerCase() || log.removed
      || !hash(log.blockHash) || !hash(log.transactionHash) || !Array.isArray(log.topics)
      || log.topics.some(value => !word(value)) || log.topics[0]?.toLowerCase() !== eventTopic
      || (pool.type === 'v4' && log.topics[1]?.toLowerCase() !== pool.poolId.toLowerCase())) throw new Error('INVALID_ACTIVITY_LOG');
    const block = quantity(log.blockNumber); const index = quantity(log.logIndex);
    if (block < fromBlock || block > head.number || typeof log.data !== 'string'
      || !/^0x(?:[0-9a-f]{2})*$/i.test(log.data)) throw new Error('INVALID_ACTIVITY_LOG');
    const blockHash = log.blockHash.toLowerCase(); const transactionHash = log.transactionHash.toLowerCase();
    const blockReference = `${block}:${blockHash}`;
    if ((block === head.number && hash(head.hash) && blockHash !== head.hash.toLowerCase())
      || (blockHashes.has(block) && blockHashes.get(block) !== blockHash)
      || (transactionBlocks.has(transactionHash) && transactionBlocks.get(transactionHash) !== blockReference)) throw new Error('INCONSISTENT_ACTIVITY_BLOCK');
    blockHashes.set(block, blockHash); transactionBlocks.set(transactionHash, blockReference);
    const id = `${log.blockHash.toLowerCase()}:${log.transactionHash.toLowerCase()}:${index}`;
    const fingerprint = `${block}:${log.topics.map(value => value.toLowerCase()).join(':')}:${log.data.toLowerCase()}`;
    const position = `${blockHash}:${index}`; const positionValue = `${transactionHash}:${fingerprint}`;
    if (blockIndices.has(position) && blockIndices.get(position) !== positionValue) throw new Error('INCONSISTENT_ACTIVITY_LOG_INDEX');
    blockIndices.set(position, positionValue);
    if (seen.has(id)) {
      if (seen.get(id) !== fingerprint) throw new Error('INCONSISTENT_ACTIVITY_LOG');
      continue;
    }
    seen.set(id, fingerprint);
    const { args } = decodeEventLog({ abi: [event], topics: log.topics, data: log.data, strict: true });
    if (events) events.push({ chainId: 4663, kind: 'SWAP', tokenAddress: quote.index === 0 ? pool.token1.toLowerCase() : pool.token0.toLowerCase(),
      address: pool.address.toLowerCase(), ...(pool.type === 'v4' ? { poolId: pool.poolId.toLowerCase() } : {}),
      blockNumber: block, blockHash, transactionHash, logIndex: index,
      topics: log.topics.map(value => value.toLowerCase()), data: log.data.toLowerCase(),
      args: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value])),
      pool: { type: pool.type, address: pool.address.toLowerCase(), token0: pool.token0.toLowerCase(), token1: pool.token1.toLowerCase(),
        ...(pool.type === 'v4' ? { poolId: pool.poolId.toLowerCase() } : {}), quoteAddress: quote.quoteAddress,
        quoteDecimals: decimals(quoteDecimals) ? quoteDecimals : null } });
    if (pool.type === 'v2') {
      const input = quote.index === 0 ? args.amount0In : args.amount1In;
      const output = quote.index === 0 ? args.amount0Out : args.amount1Out;
      if (input > 0n && output > 0n) throw new Error('AMBIGUOUS_QUOTE_FLOW');
      buys += input; sells += output;
    } else {
      if (pool.type === 'v4' && args.id.toLowerCase() !== pool.poolId.toLowerCase()) throw new Error('INVALID_ACTIVITY_POOL');
      const amount = quote.index === 0 ? args.amount0 : args.amount1;
      // v3 positive amounts enter the pool; v4 BalanceDelta positive amounts
      // are received by the caller, hence the inverted sign.
      const paidToPool = pool.type === 'v4' ? -amount : amount;
      if (paidToPool > 0n) buys += paidToPool; else sells -= paidToPool;
    }
    swaps++; transactions.add(transactionHash);
  }
  return { ...scope, complete: true, quoteAsset: quote.quoteAsset,
    quoteDecimals: decimals(quoteDecimals) ? quoteDecimals : null,
    swaps, transactionCount: transactions.size,
    buyQuoteRaw: buys.toString(), sellQuoteRaw: sells.toString(), volumeQuoteRaw: (buys + sells).toString(),
    ...(decimals(quoteDecimals) ? { buyQuote: formatUnits(buys, quoteDecimals), sellQuote: formatUnits(sells, quoteDecimals),
      volumeQuote: formatUnits(buys + sells, quoteDecimals) } : {}),
    methodology: 'Fluxos da quote currency num intervalo de blocos; não são USD, traders únicos, volume orgânico ou uma janela de cinco minutos.' };
}

/**
 * At most two pool-state HTTP batches and one log HTTP request, all read-only.
 * maxRequests is an absolute RPC counter ceiling (30 leaves two final calls).
 * Identity compares the caller's deployment metadata; it is not DEX/token approval.
 */
export async function analysePool(rpc, pool, head, token, { maxRequests = 30, onValidatedEvents } = {}) {
  const result = { identityVerified: null, poolState: {}, activeLiquidity: null, risks: [], checks: [],
    gaps: ['TOKEN_SAFETY_AND_TRADE_APPROVAL_NOT_EVALUATED', 'USD_CONVERSION_UNAVAILABLE', 'ACTIVITY_IS_NOT_A_TIME_WINDOW'] };
  const gap = code => { if (!result.gaps.includes(code)) result.gaps.push(code); };
  const risk = (code, reason) => result.risks.push({ code, reason });
  const check = (metric, value, passed) => result.checks.push({ metric, value: value ?? null, passed });
  if (!pool || !['v2', 'v3', 'v4'].includes(pool.type) || !isEvmAddress(pool.address)
    || !address(pool.token0) || !address(pool.token1) || !whole(pool.createdBlock)
    || !whole(head?.number) || pool.createdBlock > head.number
    || (pool.type !== 'v4' && !isEvmAddress(pool.factory))
    || (pool.type === 'v4' && (!isEvmAddress(pool.stateView) || !word(pool.poolId) || !address(pool.hooks)))
    || (pool.type === 'v3' && (!whole(pool.fee) || pool.fee > 0xffffff))) {
    gap('INVALID_POOL_INPUT'); return result;
  }
  const quote = quoteFor(pool);
  if (!quote) { gap('SUPPORTED_QUOTE_UNAVAILABLE'); return result; }
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 0) { gap('INVALID_RPC_BUDGET'); return result; }
  const ceiling = Math.min(30, maxRequests);
  const initialRequests = whole(rpc.requests) ? rpc.requests : 0;
  let localRequests = 0;
  const budgetAvailable = () => Math.max(whole(rpc.requests) ? rpc.requests : 0, initialRequests + localRequests) < ceiling;
  const batch = async reads => {
    if (!budgetAvailable()) { gap('POOL_RPC_BUDGET_DEFERRED'); return null; }
    localRequests++;
    let values;
    try {
      values = await rpc.batch(reads.map(item => ['eth_call', [{ to: item.to,
        data: encodeFunctionData({ abi: item.abi, functionName: item.name, args: item.args }) }, hex(head.number)]]));
    } catch { gap('POOL_RPC_UNAVAILABLE'); return null; }
    const decoded = {};
    for (let i = 0; i < reads.length; i++) {
      const item = reads[i];
      try {
        if (typeof values?.[i]?.value !== 'string') throw new Error('READ_UNAVAILABLE');
        decoded[item.key] = decodeFunctionResult({ abi: item.abi, functionName: item.name, data: values[i].value });
      } catch { gap(`POOL_READ_UNAVAILABLE:${item.key}`); }
    }
    return decoded;
  };
  const quoteReads = quote.native ? [] : [read('quoteDecimals', quote.quoteAddress, ERC20, 'decimals')];
  let current; let indexed;
  if (pool.type === 'v4') {
    current = await batch([read('slot', pool.stateView, V4, 'getSlot0', [pool.poolId]),
      read('liquidity', pool.stateView, V4, 'getLiquidity', [pool.poolId]), ...quoteReads]);
    gap('V4_POOL_IDENTITY_NOT_FULLY_VERIFIED');
    const unreviewed = pool.hooks.toLowerCase() !== zeroAddress;
    check('pool.unreviewedHooks', unreviewed, !unreviewed);
    if (unreviewed) risk('UNREVIEWED_HOOKS', 'A pool v4 usa hooks ainda sem revisão; a atividade não comprova segurança ou executabilidade.');
  } else {
    const abi = pool.type === 'v2' ? V2 : V3;
    const reads = [read('factory', pool.address, abi, 'factory'), read('token0', pool.address, abi, 'token0'),
      read('token1', pool.address, abi, 'token1')];
    if (pool.type === 'v2') reads.push(read('reserves', pool.address, V2, 'getReserves'));
    else reads.push(read('fee', pool.address, V3, 'fee'), read('slot', pool.address, V3, 'slot0'), read('liquidity', pool.address, V3, 'liquidity'));
    current = await batch([...reads, ...quoteReads]);
    if (current) {
      for (const field of ['factory', 'token0', 'token1']) check(`pool.${field}`, address(current[field]),
        address(current[field]) ? address(current[field]) === pool[field].toLowerCase() : null);
      if (pool.type === 'v3') check('pool.fee', current.fee, current.fee === undefined ? null : current.fee === pool.fee);
      const mismatch = result.checks.some(item => item.passed === false);
      if (!mismatch) {
        const confirmations = [pool.type === 'v2'
          ? read('indexed', pool.factory, V2, 'getPair', [pool.token0, pool.token1])
          : read('indexed', pool.factory, V3, 'getPool', [pool.token0, pool.token1, pool.fee])];
        if (pool.type === 'v3') confirmations.push(read('balance0', pool.token0, ERC20, 'balanceOf', [pool.address]),
          read('balance1', pool.token1, ERC20, 'balanceOf', [pool.address]));
        indexed = await batch(confirmations);
        check('pool.factoryIndex', address(indexed?.indexed), address(indexed?.indexed) ? address(indexed.indexed) === pool.address.toLowerCase() : null);
      }
      const identities = result.checks.filter(item => item.metric !== 'pool.unreviewedHooks');
      result.identityVerified = identities.some(item => item.passed === false) ? false
        : identities.every(item => item.passed === true) ? true : null;
      if (result.identityVerified === false) risk('POOL_IDENTITY_MISMATCH', 'Factory, tokens, fee ou índice da factory não correspondem ao evento de criação.');
      if (result.identityVerified === null) gap('POOL_IDENTITY_UNCONFIRMED');
    }
  }
  if (!current) return result;
  const state = result.poolState;
  if (current.reserves) Object.assign(state, { reserve0: current.reserves[0].toString(), reserve1: current.reserves[1].toString(), reserveTimestamp: Number(current.reserves[2]) });
  if (current.slot) {
    state.sqrtPriceX96 = current.slot[0].toString(); state.tick = Number(current.slot[1]);
    if (pool.type === 'v3') state.unlocked = current.slot[6];
    else { state.protocolFee = Number(current.slot[2]); state.lpFee = Number(current.slot[3]); }
  }
  if (current.liquidity !== undefined) state.activeLiquidityRaw = current.liquidity.toString();
  if (indexed?.balance0 !== undefined) state.token0BalanceRaw = indexed.balance0.toString();
  if (indexed?.balance1 !== undefined) state.token1BalanceRaw = indexed.balance1.toString();
  const quoteDecimals = quote.native ? 18 : decimals(current.quoteDecimals) ? current.quoteDecimals : null;
  state.quoteDecimals = quoteDecimals;
  if (quoteDecimals === null) gap('QUOTE_DECIMALS_UNAVAILABLE');
  if (!decimals(token?.decimals)) gap('TOKEN_DECIMALS_UNAVAILABLE');
  if (pool.type === 'v2' && current.reserves) result.activeLiquidity = current.reserves[0] > 0n && current.reserves[1] > 0n;
  else if (current.liquidity !== undefined && current.slot) result.activeLiquidity = current.liquidity > 0n && current.slot[0] > 0n;
  check('pool.identityVerified', result.identityVerified, result.identityVerified);
  check('pool.activeLiquidity', result.activeLiquidity, result.activeLiquidity);
  if (result.activeLiquidity === false) risk('EMPTY_LIQUIDITY', 'A pool não tem reservas ou liquidez ativa positiva no bloco observado.');
  if (state.unlocked === false) risk('POOL_LOCKED', 'A pool v3 reporta unlocked=false no bloco observado.');
  if (pool.type !== 'v2') gap('CLMM_BALANCES_ARE_NOT_EXECUTABLE_DEPTH');
  if (result.identityVerified !== false) {
    const price = spotPrice(pool, state, quote, token?.decimals, quoteDecimals);
    if (price) result.priceInQuote = price; else gap('PRICE_IN_QUOTE_UNAVAILABLE');
  }
  if (result.identityVerified === false) { gap('ACTIVITY_SKIPPED_IDENTITY_MISMATCH'); return result; }
  if (!budgetAvailable()) { gap('ACTIVITY_RPC_BUDGET_DEFERRED'); return result; }
  const fromBlock = Math.max(pool.createdBlock, head.number - 511, 0);
  localRequests++;
  try {
    const [response] = await rpc.batch([['eth_getLogs', [{ address: pool.address,
      topics: [topic(SWAPS[pool.type]), ...(pool.type === 'v4' ? [pool.poolId] : [])],
      fromBlock: hex(fromBlock), toBlock: hex(head.number) }]]]);
    if (response?.error !== undefined) throw new Error('ACTIVITY_RPC_ERROR');
    const events = typeof onValidatedEvents === 'function' ? [] : null;
    result.activity = analyseLogs(response?.value, pool, head, quote, quoteDecimals, fromBlock, events);
    if (!result.activity.complete) gap(result.activity.reason);
    else if (events) {
      for (const event of events) event.pool.tokenDecimals = decimals(token?.decimals) ? token.decimals : null;
      try { onValidatedEvents({ kind: 'SWAP', tokenAddress: quote.index === 0 ? pool.token1.toLowerCase() : pool.token0.toLowerCase(),
        range: { kind: 'SWAP', tokenAddress: quote.index === 0 ? pool.token1.toLowerCase() : pool.token0.toLowerCase(),
          address: pool.address.toLowerCase(), fromBlock, toBlock: head.number, headBlock: head.number, headHash: head.hash,
          source: 'validated-pool-activity/v1', historyComplete: false }, events }); }
      catch { gap('WALLET_EVENT_SINK_FAILED'); }
    }
  } catch { gap('ACTIVITY_UNAVAILABLE_OR_INVALID'); }
  return result;
}
