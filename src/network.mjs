// Referências oficiais consultadas em 2026-10-19. Metadados, sem ligação RPC.
export const NETWORK = Object.freeze({
  chain: 'robinhood', chainId: 4663, environment: 'mainnet', nativeGasSymbol: 'ETH',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorerUrl: 'https://robinhoodchain.blockscout.com',
  testnetChainId: 46630,
  configurationSource: 'https://docs.robinhood.com/chain/connecting/',
  assetsSource: 'https://docs.robinhood.com/chain/contracts/',
});

export const QUOTE_ASSETS = Object.freeze({
  WETH: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  USDG: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
});

// Não valida checksum EIP-55. O contrato e o bytecode exigem prova do adaptador.
export function isEvmAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value);
}

export function normalizeAddress(value) {
  return isEvmAddress(value) ? value.toLowerCase() : value;
}
