// Dados fabricados. Endereços são identificadores de teste; não consultar nem negociar.
import { QUOTE_ASSETS } from '../src/network.mjs';
export const DEMO_TIME = Date.parse('2026-10-19T12:00:00Z');

export function fixture(pipeline = 'new', now = DEMO_TIME) {
  const fresh = { checkedAt: new Date(now).toISOString(), source: 'synthetic-fixture', evidence: ['fixture:not-on-chain'] };
  const established = pipeline === 'established';
  const blockNumber = 100000 + Math.floor((now - DEMO_TIME) / 1000) * 4;
  return {
    schemaVersion: 2, synthetic: true, chain: 'robinhood', chainId: 4663, environment: 'mainnet',
    address: established ? '0x2222222222222222222222222222222222222222' : '0x1111111111111111111111111111111111111111',
    symbol: established ? 'DEMO_OLD' : 'DEMO_NEW',
    contractCreatedAt: new Date(DEMO_TIME - (established ? 30 * 86400000 : 2 * 3600000)).toISOString(),
    chainState: { ...fresh, rpcChainId: 4663, sequencerHealthy: true, reorgDetected: false,
      headTimestamp: new Date(now).toISOString(), blockNumber,
      blockHash: '0x' + BigInt(blockNumber).toString(16).padStart(64, '0'), finalityStage: 'sequencer' },
    security: { ...fresh, tokenStandard: 'erc20', hasBytecode: true, contractVerified: true,
      canMint: false, canPause: false, canBlacklist: false, whitelistOnly: false,
      canChangeFees: false, canConfiscate: false, proxyUpgradeable: false,
      hiddenPrivileges: false, untrustedTransferCalls: false, honeypotDetected: false,
      mutableTransferRules: false, knownMalicious: false, liquidityRemovableByCreator: false,
      buyTaxPct: 0, sellTaxPct: 0, suspiciousVolumePct: 5 },
    holders: { ...fresh, count: established ? 5000 : 800, top1Pct: 2, top10Pct: 18,
      deployerPct: 1, linkedInsidersPct: 5, bundledSupplyPct: 3 },
    market: { ...fresh, quoteAsset: 'USDG', quoteAssetAddress: QUOTE_ASSETS.USDG,
      dexVerified: true, hasUnreviewedHooks: false, liquidityUsd: established ? 1000000 : 250000,
      fdvUsd: established ? 10000000 : 1000000,
      oldestPoolCreatedAt: new Date(DEMO_TIME - (established ? 28 * 86400000 : 100 * 60000)).toISOString(),
      liquidityChange5mPct: 3, liquidityChange1hPct: 5, priceChange5mPct: 10,
      priceChange1hPct: 15, priceChange24hPct: 20, distanceToVwap1hPct: 5, drawdownFrom7dHighPct: 20 },
    activity: { ...fresh, volume5mUsd: 50000, previous5mVolumeUsd: 15000,
      volume1hUsd: 500000, volume24hUsd: 2500000,
      uniqueTraders5m: 200, uniqueTraders1h: 1000, organicTraderPct: 90,
      holderGrowth5mPct: 8, holderGrowth24hPct: 15,
      buyVolume5mUsd: 35000, sellVolume5mUsd: 15000,
      buyVolume1hUsd: 310000, sellVolume1hUsd: 190000 },
    liquidityProtection: { ...fresh, verified: true, mechanism: 'locked', coveragePct: 98,
      unlockAt: new Date(DEMO_TIME + 90 * 86400000).toISOString() },
    quote: { ...fresh, amountUsd: 100, buySucceeded: true, sellSucceeded: true,
      buyImpactPct: 0.3, sellImpactPct: 0.4, roundTripLossPct: 1.2 },
  };
}
