import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedRenderHealthUrl, checkRadar } from '../src/index.mjs';

const url = 'https://solana-pump-radar-mvp.onrender.com/health';

test('health target must be Render HTTPS /health with no credentials or redirects', () => {
  assert.equal(checkedRenderHealthUrl(url), url);
  for (const value of [
    undefined, '', 'http://solana-pump-radar-mvp.onrender.com/health',
    'https://solana-pump-radar-mvp.onrender.com.evil.org/health',
    'https://example.com/health',
    'https://solana-pump-radar-mvp.onrender.com/private',
    'https://solana-pump-radar-mvp.onrender.com/health?url=x',
    'https://user:secret@solana-pump-radar-mvp.onrender.com/health',
  ]) assert.throws(() => checkedRenderHealthUrl(value), /RENDER_HEALTH_URL/);
});

test('successful probe is truthful and never counts a degraded scanner as healthy', async () => {
  let called = 0;
  const result = await checkRadar(async (target, options) => {
    assert.equal(target, url);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    called++;
    return { ok: true, json: async () => ({
      chain:'solana', mode:'READ_ONLY', status:'DEGRADED', coverage:'PARTIAL',
      metrics:{gauges:{websocket_connected:false}},
    }) };
  }, url);
  assert.equal(called, 1);
  assert.deepEqual(result, {
    reachable:true,status:'DEGRADED',websocketConnected:false,coverage:'PARTIAL',
  });
});

test('request errors, wrong API and rate limits are not converted into success', async () => {
  await assert.rejects(() => checkRadar(async () => ({ok:false,status:429}),url),/RENDER_HTTP_429/);
  await assert.rejects(() => checkRadar(async () => ({
    ok:true,json:async () => ({chain:'ethereum',mode:'LIVE_TRADING'}),
  }),url),/INVALID_SOLANA_HEALTH/);
});
