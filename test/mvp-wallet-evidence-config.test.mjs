import test from 'node:test';
import assert from 'node:assert/strict';
import CONFIG, { validateWalletEvidenceConfig } from '../src/mvp/wallet-evidence-config.mjs';

test('validated backfill budgets fit the actual bounded worker and refuse misleading accepted options', () => {
  assert.equal(CONFIG.backfill.maxEvents, 8);
  assert.equal(validateWalletEvidenceConfig(structuredClone(CONFIG)).historyDays, 30);
  for (const [key, value] of Object.entries({ maxStepRequests: 5, chunkBlocks: 2049, maxLogs: 33, maxEvents: 17, maxReceipts: 2 })) {
    const config = structuredClone(CONFIG); config.backfill[key] = value;
    assert.throws(() => validateWalletEvidenceConfig(config), /INVALID_WALLET_EVIDENCE_CONFIG/);
  }
  const wrongWindow = structuredClone(CONFIG); wrongWindow.historyDays = 29;
  assert.throws(() => validateWalletEvidenceConfig(wrongWindow), /INVALID_WALLET_EVIDENCE_CONFIG/);
});
