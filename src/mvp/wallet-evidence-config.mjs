import settings from '../../config/wallet-evidence.json' with { type: 'json' };

const keysAre = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const bounded = (value, maximum) => Number.isSafeInteger(value) && value > 0 && value <= maximum;

export function validateWalletEvidenceConfig(value) {
  if (!keysAre(value, ['schemaVersion', 'enabled', 'historyDays', 'backfill', 'native'])
    || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean' || value.historyDays !== 30
    || !keysAre(value.backfill, ['maxStepRequests', 'chunkBlocks', 'maxLogs', 'maxEvents', 'maxReceipts'])
    || !bounded(value.backfill.maxStepRequests, 4) || !bounded(value.backfill.chunkBlocks, 2048)
    || !bounded(value.backfill.maxLogs, 32) || !bounded(value.backfill.maxEvents, 16)
    || !bounded(value.backfill.maxReceipts, 1)
    || !keysAre(value.native, ['enabled', 'maxTraceTransfers', 'maxFeeComponents'])
    || typeof value.native.enabled !== 'boolean' || !bounded(value.native.maxTraceTransfers, 512)
    || !bounded(value.native.maxFeeComponents, 16)) throw Error('INVALID_WALLET_EVIDENCE_CONFIG');
  return value;
}

export const WALLET_EVIDENCE_CONFIG = validateWalletEvidenceConfig(settings);
export default WALLET_EVIDENCE_CONFIG;
