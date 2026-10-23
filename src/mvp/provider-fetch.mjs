const API_ORIGIN = 'https://api.dexscreener.com';
const TOKEN_PATH = /^\/tokens\/v1\/robinhood\/(0x[0-9a-f]{40}(?:,0x[0-9a-f]{40}){0,19})$/i;

// Reuse the provider parser and rate limiter; only the fixed public market
// endpoint changes transport. RPC and security requests are never redirected.
export function providerFetch(fetchImpl, gatewayUrl) {
  if (!gatewayUrl) return fetchImpl;
  const gateway = new URL(gatewayUrl);
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash
    || gateway.pathname !== '/api/market') throw new Error('INVALID_MARKET_GATEWAY');
  return (input, init) => {
    const url = new URL(input);
    const matched = url.origin === API_ORIGIN && !url.search ? TOKEN_PATH.exec(url.pathname) : null;
    if (!matched || init?.method && init.method !== 'GET') return fetchImpl.call(globalThis, input, init);
    const target = new URL(gateway);
    target.searchParams.set('addresses', matched[1]);
    return fetchImpl.call(globalThis, target.href, init);
  };
}
