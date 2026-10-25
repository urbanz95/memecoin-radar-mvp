import { WALLET_EVIDENCE_CONFIG } from './wallet-evidence-config.mjs';

const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value)
  && !/^0x0{40}$/i.test(value) ? value.toLowerCase() : null;
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value)
  && !/^0x0{64}$/i.test(value) ? value.toLowerCase() : null;
const whole = value => Number.isSafeInteger(value) && value >= 0;
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const source = value => typeof value === 'string' && value.length > 0 && value.length <= 240;
const refs = value => Array.isArray(value) && value.length > 0 && value.length <= 64
  && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 240);
const amount = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,77})$/.test(value)
  && BigInt(value) < 2n ** 256n;

function openingProof(value, wallet, fromBlock) {
  if (!value || value.schemaVersion !== 1 || value.scope !== 'opening-balances' || value.chainId !== 4663
    || address(value.walletAddress) !== wallet || value.blockNumber !== Math.max(0, fromBlock - 1)
    || !hash(value.blockHash) || value.canonical !== true || value.complete !== true
    || !source(value.source) || !refs(value.evidence) || !amount(value.nativeRaw)
    || !Array.isArray(value.assets) || value.assets.length > 128
    || value.assets.some(asset => !address(asset?.assetAddress) || !amount(asset?.quantityRaw))
    || new Set(value.assets.map(asset => address(asset.assetAddress))).size !== value.assets.length) return null;
  return { ...value, walletAddress: wallet, blockHash: hash(value.blockHash),
    assets: value.assets.map(asset => ({ assetAddress: address(asset.assetAddress), quantityRaw: asset.quantityRaw })),
    evidence: [...value.evidence] };
}

/** A declared range is metadata, not proof of coverage. Partial boundary lookup
 * keeps fromBlock/hash null. Only a fully bounded, canonical and contiguous
 * range with an actual opening-balance proof can become complete. */
export function normalizeHistoryWindow(value, { walletAddress, now = Date.now(), anchor = null } = {}) {
  const wallet = address(walletAddress ?? value?.walletAddress);
  const start = stamp(value?.startAt); const end = stamp(value?.endAt);
  const boundaryResolved = whole(value?.fromBlock) && Boolean(hash(value?.fromBlockHash));
  if (!value || value.schemaVersion !== 1 || value.scope !== 'declared-window' || value.chainId !== 4663
    || !wallet || address(value.walletAddress) !== wallet || value.days !== WALLET_EVIDENCE_CONFIG.historyDays
    || !Number.isSafeInteger(now) || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end)
    || end > now || end - start !== value.days * 86400000 || !whole(value.toBlock) || !hash(value.toBlockHash)
    || boundaryResolved && value.fromBlock > value.toBlock
    || !boundaryResolved && (value.fromBlock !== null || value.fromBlockHash !== null)
    || !['complete', 'contiguous', 'canonical', 'openingBalanceKnown'].every(key => typeof value[key] === 'boolean')
    || !source(value.source) || !refs(value.evidence)
    || anchor && (anchor.number !== value.toBlock || hash(anchor.hash) !== hash(value.toBlockHash)
      || !whole(anchor.timestamp) || anchor.timestamp * 1000 !== end)) return null;
  const opening = boundaryResolved ? openingProof(value.openingBalanceProof, wallet, value.fromBlock) : null;
  const complete = boundaryResolved && value.complete && value.contiguous && value.canonical
    && value.openingBalanceKnown && Boolean(opening);
  return { schemaVersion: 1, scope: 'declared-window', chainId: 4663, walletAddress: wallet,
    days: value.days, startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(),
    fromBlock: boundaryResolved ? value.fromBlock : null, fromBlockHash: boundaryResolved ? hash(value.fromBlockHash) : null,
    toBlock: value.toBlock, toBlockHash: hash(value.toBlockHash), boundaryResolved,
    complete, contiguous: boundaryResolved && value.contiguous, canonical: value.canonical,
    openingBalanceKnown: Boolean(opening) && value.openingBalanceKnown, openingBalanceProof: opening,
    source: value.source, evidence: [...value.evidence] };
}

export function historyWindowComplete(value) {
  return value?.scope === 'declared-window' && value.complete === true && value.boundaryResolved === true
    && value.contiguous === true && value.canonical === true && value.openingBalanceKnown === true
    && value.openingBalanceProof?.complete === true;
}

export function historyWindowKey(value) {
  return value ? JSON.stringify([value.chainId, value.walletAddress, value.startAt, value.endAt,
    value.fromBlock, value.fromBlockHash, value.toBlock, value.toBlockHash]) : null;
}
