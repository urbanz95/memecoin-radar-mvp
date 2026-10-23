import { encodeFunctionData, decodeFunctionResult, keccak256, formatUnits } from 'viem';
import { hex, quantity } from './rpc.mjs';
import { ERC20, EIP1967 } from './abi.mjs';

export async function readContract(rpc, address, abi, functionName, args, block) {
  const data = encodeFunctionData({ abi, functionName, args });
  const result = await rpc.request('eth_call', [{ to: address, data }, hex(block)]);
  return decodeFunctionResult({ abi, functionName, data: result });
}

export async function optionalRead(rpc, address, abi, functionName, args, block, errors) {
  try { return await readContract(rpc, address, abi, functionName, args, block); }
  catch (error) { errors.push({ operation: functionName, error: error.code ?? 'UNAVAILABLE_OR_INVALID_ABI' }); return undefined; }
}

export async function tokenMetadata(rpc, address, head) {
  const errors = [];
  const code = await rpc.request('eth_getCode', [address, hex(head.number)]);
  if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(code)) throw new Error('Bytecode inválido');
  const hasBytecode = code !== '0x';
  if (!hasBytecode) return { address, hasBytecode, errors };
  const symbol = await optionalRead(rpc, address, ERC20, 'symbol', [], head.number, errors);
  const decimals = await optionalRead(rpc, address, ERC20, 'decimals', [], head.number, errors);
  const supply = await optionalRead(rpc, address, ERC20, 'totalSupply', [], head.number, errors);
  const owner = await optionalRead(rpc, address, ERC20, 'owner', [], head.number, errors);
  const paused = await optionalRead(rpc, address, ERC20, 'paused', [], head.number, errors);
  const proxySlots = {};
  for (const [name, slot] of Object.entries(EIP1967)) {
    try {
      const value = await rpc.request('eth_getStorageAt', [address, slot, hex(head.number)]);
      if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error('Storage inválido');
      proxySlots[name] = value.toLowerCase();
    } catch (error) { errors.push({ operation: `storage.${name}`, error: error.code ?? 'UNAVAILABLE' }); }
  }
  const erc20InterfaceObserved = Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 && typeof supply === 'bigint';
  return { address, hasBytecode, codeHash: keccak256(code), codeSize: (code.length - 2) / 2,
    symbol: typeof symbol === 'string' ? symbol.slice(0, 32) : null,
    decimals: Number.isInteger(decimals) && decimals <= 36 ? decimals : null,
    totalSupplyRaw: typeof supply === 'bigint' ? supply.toString() : null,
    totalSupply: erc20InterfaceObserved ? formatUnits(supply, decimals) : null,
    erc20InterfaceObserved, owner: typeof owner === 'string' ? owner.toLowerCase() : null,
    paused: typeof paused === 'boolean' ? paused : null, proxySlots,
    proxyStoragePresent: Object.values(proxySlots).some((v) => BigInt(v) !== 0n), errors };
}

// A fronteira de existência de código é uma pista, nunca substitui uma prova de deployment.
export async function deploymentEvidence(rpc, address, head, { candidateCreations = [], codeHash } = {}) {
  const candidateErrors = [];
  for (const transactionHash of [...new Set(candidateCreations)].slice(0, 2)) {
    try {
      const receipt = await rpc.request('eth_getTransactionReceipt', [transactionHash]);
      if (!receipt || quantity(receipt.status) !== 1) continue;
      const block = await rpc.block(quantity(receipt.blockNumber));
      if (receipt.blockHash?.toLowerCase() !== block.hash.toLowerCase()) throw new Error('Recibo fora da cadeia canónica');
      let creator = null; let proof = null;
      if (receipt.contractAddress?.toLowerCase() === address.toLowerCase()) proof = 'proven-direct-creation-receipt';
      else {
        const trace = await rpc.request('debug_traceTransaction', [transactionHash, { tracer: 'callTracer', timeout: '5s' }]);
        let visited = 0;
        const findCreation = (node, depth = 0) => {
          if (!node || node.error || depth > 100 || ++visited > 10000) return null;
          if (['CREATE', 'CREATE2'].includes(node.type) && node.to?.toLowerCase() === address.toLowerCase() && typeof node.output === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(node.output) && codeHash && keccak256(node.output) === codeHash) return node;
          for (const child of node.calls ?? []) { const found = findCreation(child, depth + 1); if (found) return found; }
          return null;
        };
        const creation = findCreation(trace);
        if (creation) { proof = 'proven-create-call-trace-and-bytecode'; creator = creation.from?.toLowerCase(); }
      }
      if (proof) return { status: proof, contractCreatedAt: new Date(block.timestamp * 1000).toISOString(),
        blockNumber: block.number, blockHash: block.hash, transactionHash, ...(creator ? { creatorContract: creator } : {}) };
    } catch (error) {
      candidateErrors.push({ transactionHash, error: error.code ?? 'CREATION_PROOF_UNAVAILABLE' });
      if (error.code === -32601) break;
    }
  }
  try {
    let low = 0; let high = head.number;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const code = await rpc.request('eth_getCode', [address, hex(mid)]);
      if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(code)) throw new Error('Código histórico inválido');
      if (code === '0x') low = mid + 1;
      else high = mid;
    }
    const first = await rpc.block(low, true);
    const boundary = { status: 'historical-code-boundary-only', blockNumber: first.number,
      blockHash: first.hash, firstCodeTimestamp: new Date(first.timestamp * 1000).toISOString() };
    // Apenas recibos de criação direta provam a data nesta versão. CREATE/CREATE2 interno
    // precisa de traces; a data da pool ou a primeira transferência não são usadas como substituto.
    const candidates = (first.transactions ?? []).filter((tx) => tx && typeof tx === 'object' && tx.to === null);
    for (const tx of candidates.slice(0, 16)) {
      const receipt = await rpc.request('eth_getTransactionReceipt', [tx.hash]);
      if (receipt?.contractAddress?.toLowerCase() === address.toLowerCase() && receipt.blockHash?.toLowerCase() === first.hash.toLowerCase() && quantity(receipt.status) === 1) {
        return { ...boundary, status: 'proven-direct-creation-receipt', contractCreatedAt: boundary.firstCodeTimestamp,
          deployer: tx.from.toLowerCase(), transactionHash: tx.hash };
      }
    }
    return { ...boundary, candidateErrors };
  } catch (error) { return { status: 'unavailable', error: error.code ?? 'ARCHIVE_OR_CREATION_UNAVAILABLE', candidateErrors }; }
}
