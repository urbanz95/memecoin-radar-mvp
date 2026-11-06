import test from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../src/api.mjs';

test('dashboard embeds untrusted mint as JSON data without creating executable markup', async t => {
  const maliciousMint = '</script><script>globalThis.injected=true</script><img src=x onerror=alert(1)>';
  const snapshot = {
    kind: 'SOLANA_PUMP_RADAR_MVP', coverage: 'PARTIAL',
    generatedAt: '2026-11-06T12:00:00Z',
    totals: { observedDistinctMints: 1, aboveFloor: 0, unknownFdv: 1 },
    sample: { verifiedUniqueEvents: 1, maxRowsRead: 10000, possibleTruncation: false },
    candidates: [{
      mint: maliciousMint, estimatedFdvUsd: null, fdvStatus: 'FDV_UNKNOWN',
      activity: { '15s': { events: 1 }, '60s': { events: 1, buys: 1, sells: 0 } },
      lastObservedAt: '2026-11-06T12:00:00Z', protocols: ['pump_fun'],
    }],
  };
  const server = await serve({ radar: () => snapshot }, { host: '127.0.0.1', port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/dashboard');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(response.headers.get('x-content-type-options'), /nosniff/);
  const html = await response.text();
  assert.ok(!html.includes(maliciousMint), 'raw untrusted HTML must not appear');
  assert.ok(!html.includes('</script><script>globalThis.injected=true'));
  const match = html.match(/<script type="application\\/json" id="snapshot">([^<]*)<\\/script>/);
  assert.ok(match, 'snapshot must remain in one inert JSON script element');
  assert.equal(JSON.parse(match[1]).candidates[0].mint, maliciousMint);
  assert.equal((html.match(/<script\\b/g) ?? []).length, 2, 'no injected script tags');
});
