import configured from '../../config/wallet-accounting.json' with { type: 'json' };

export function validateWalletAccountingLimits(value) {
  const maxima = { stateMaxBytes: 16384, realizationMaxBytes: 16384, openLots: 128, exactPositionComponents: 128, exactIntegerBits: 4096 };
  const minima = { stateMaxBytes: 4096, realizationMaxBytes: 4096, openLots: 1, exactPositionComponents: 1, exactIntegerBits: 1024 };
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1
    || Object.keys(value).length !== 6 || Object.keys(value).some(key => key !== 'schemaVersion' && !(key in maxima))
    || Object.entries(maxima).some(([key, maximum]) => !Number.isSafeInteger(value[key]) || value[key] < minima[key] || value[key] > maximum))
    throw Error('MVP_WALLET_ACCOUNTING_INVALID_RESOURCE_CONFIG');
  return Object.freeze({ ...value });
}

export default validateWalletAccountingLimits(configured);
