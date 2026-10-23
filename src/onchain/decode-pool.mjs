import { decodeEventLog, encodeAbiParameters, parseAbiParameters, keccak256 } from 'viem';
import { EVENTS } from './abi.mjs';
import { isEvmAddress } from '../network.mjs';
const quantity = value => { if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('INVALID_QUANTITY'); const n=Number(BigInt(value)); if (!Number.isSafeInteger(n) || n < 0) throw new Error('INVALID_QUANTITY'); return n; };

const lower = (value) => value.toLowerCase();
export function decodePool(log, venue) {
  const { args } = decodeEventLog({ abi: [EVENTS[venue.type]], topics: log.topics, data: log.data, strict: true });
  const token0 = lower(args.token0 ?? args.currency0);
  const token1 = lower(args.token1 ?? args.currency1);
  if ((!isEvmAddress(token0) && token0 !== '0x' + '0'.repeat(40)) || !isEvmAddress(token1) || token0 >= token1) throw new Error('Par de tokens inválido');
  if (venue.type === 'v4') {
    const id = keccak256(encodeAbiParameters(parseAbiParameters('address, address, uint24, int24, address'),
      [token0, token1, args.fee, args.tickSpacing, args.hooks]));
    if (id.toLowerCase() !== args.id.toLowerCase()) throw new Error('Pool ID v4 não corresponde à PoolKey');
  }
  const address = venue.type === 'v4' ? lower(venue.address) : lower(args.pair ?? args.pool);
  if (!isEvmAddress(address)) throw new Error('Endereço de pool inválido');
  return { id: `${venue.type}:${venue.type === 'v4' ? args.id.toLowerCase() : address}`,
    type: venue.type, address, factory: lower(venue.address), stateView: venue.stateView,
    poolId: args.id?.toLowerCase(), token0, token1, fee: args.fee,
    tickSpacing: args.tickSpacing, hooks: args.hooks?.toLowerCase(),
    createdBlock: quantity(log.blockNumber), createdBlockHash: log.blockHash.toLowerCase(),
    creationTransactionHash: log.transactionHash.toLowerCase(), creationLogIndex: quantity(log.logIndex) };
}

