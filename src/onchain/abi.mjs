import { parseAbi, toEventSelector } from 'viem';

export const EVENTS = {
  v2: parseAbi(['event PairCreated(address indexed token0, address indexed token1, address pair, uint256 pairCount)'])[0],
  v3: parseAbi(['event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'])[0],
  v4: parseAbi(['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)'])[0],
};
export const SWAPS = {
  v2: parseAbi(['event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)'])[0],
  v3: parseAbi(['event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'])[0],
  v4: parseAbi(['event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)'])[0],
};
export const topic = (event) => toEventSelector(event);
export const ERC20 = parseAbi([
  'function symbol() view returns (string)', 'function name() view returns (string)',
  'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function owner() view returns (address)', 'function paused() view returns (bool)',
]);
export const V2 = parseAbi([
  'function factory() view returns (address)', 'function token0() view returns (address)',
  'function token1() view returns (address)', 'function getPair(address token0, address token1) view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
]);
export const V3 = parseAbi([
  'function factory() view returns (address)', 'function token0() view returns (address)',
  'function token1() view returns (address)', 'function fee() view returns (uint24)',
  'function getPool(address token0, address token1, uint24 fee) view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
]);
export const V4 = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
]);
export const EIP1967 = {
  implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
};
