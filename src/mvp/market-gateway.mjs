const UPSTREAM = 'https://api.dexscreener.com/tokens/v1/robinhood/';
const MAX_ADDRESSES = 20;
const MAX_BYTES = 128 * 1024;
const TIMEOUT_MS = 3000;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const POOL = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const ZERO = /^0x0+$/i;

const privateHeaders = () => ({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'cdn-cache-control': 'no-store',
  'vercel-cdn-cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});
const failure = (status, error, extra = {}, headers = {}) => new Response(JSON.stringify({ error, ...extra }), {
  status, headers: { ...privateHeaders(), ...headers },
});

function requestedAddresses(url) {
  if (url.pathname !== '/api/market') return { error: 'NOT_FOUND', status: 404 };
  if ([...url.searchParams.keys()].some(key => key !== 'addresses') || url.searchParams.getAll('addresses').length !== 1)
    return { error: 'INVALID_ADDRESSES', status: 400 };
  const value = url.searchParams.get('addresses');
  if (!value || value.length > MAX_ADDRESSES * 43) return { error: 'INVALID_ADDRESSES', status: 400 };
  const addresses = value.split(',');
  if (addresses.length > MAX_ADDRESSES || addresses.some(address => !ADDRESS.test(address) || ZERO.test(address)))
    return { error: 'INVALID_ADDRESSES', status: 400 };
  return { addresses: [...new Set(addresses.map(address => address.toLowerCase()))].sort() };
}

function validPairs(body, addresses) {
  if (!Array.isArray(body)) return false;
  const expected = new Set(addresses);
  return body.every(pair => pair && typeof pair === 'object' && !Array.isArray(pair)
    && pair.chainId === 'robinhood'
    && typeof pair.baseToken?.address === 'string' && ADDRESS.test(pair.baseToken.address) && !ZERO.test(pair.baseToken.address)
    && typeof pair.pairAddress === 'string' && POOL.test(pair.pairAddress) && !ZERO.test(pair.pairAddress)
    && typeof pair.quoteToken?.address === 'string' && ADDRESS.test(pair.quoteToken.address)
    && (expected.has(pair.baseToken.address.toLowerCase()) || expected.has(pair.quoteToken.address.toLowerCase())));
}

function retryAfter(value, timestamp) {
  if (typeof value === 'string' && /^\d{1,8}$/.test(value)) return Math.max(1, Number(value));
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed > timestamp ? Math.ceil((parsed - timestamp) / 1000) : 60;
}

/** A fixed, anonymous, read-only upstream. No user-supplied URL, network or credentials. */
export function createMarketGateway({ fetchImpl = fetch, now = Date.now,
  logger = entry => console.log(JSON.stringify(entry)) } = {}) {
  return async request => {
    let started;
    try { started = now(); } catch { started = NaN; }
    const log = (status, outcome) => {
      let ended;
      try { ended = now(); } catch { ended = NaN; }
      const durationMs = Number.isFinite(ended) && Number.isFinite(started) ? Math.max(0, ended - started) : null;
      try { logger({ event: 'MARKET_GATEWAY', status, outcome, durationMs }); } catch {}
    };
    const reject = (status, error, extra, headers) => {
      log(status, error); return failure(status, error, extra, headers);
    };
    if (request.method !== 'GET') return reject(405, 'METHOD_NOT_ALLOWED', {}, { allow: 'GET' });
    let input;
    try { input = requestedAddresses(new URL(request.url)); }
    catch { return reject(400, 'INVALID_REQUEST'); }
    if (input.error) return reject(input.status, input.error);
    if (!Number.isFinite(started) || started < 0) return reject(500, 'CLOCK_UNAVAILABLE');

    const controller = new AbortController();
    let reader;
    let timer;
    const deadline = new Promise((_, rejectPromise) => {
      timer = setTimeout(() => {
        controller.abort();
        void reader?.cancel().catch(() => {});
        rejectPromise(new Error('UPSTREAM_TIMEOUT'));
      }, TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([deadline, (async () => {
        const response = await fetchImpl(UPSTREAM + input.addresses.join(','), {
          method: 'GET', redirect: 'manual', headers: { accept: 'application/json' }, signal: controller.signal,
        });
        if (response.status === 429) {
          void response.body?.cancel().catch(() => {});
          const seconds = retryAfter(response.headers.get('retry-after'), started);
          return { response: failure(429, 'UPSTREAM_RATE_LIMITED', { retryAfterSeconds: seconds }, { 'retry-after': String(seconds) }),
            outcome: 'UPSTREAM_RATE_LIMITED' };
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          return { response: failure(502, 'UPSTREAM_UNAVAILABLE'), outcome: `UPSTREAM_HTTP_${response.status}` };
        }
        const declared = response.headers.get('content-length');
        if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BYTES) {
          void response.body?.cancel().catch(() => {});
          throw new Error('UPSTREAM_RESPONSE_LIMIT');
        }
        if (!response.body) throw new Error('UPSTREAM_INVALID_RESPONSE');
        reader = response.body.getReader();
        const chunks = []; let bytes = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) {
            void reader.cancel().catch(() => {});
            throw new Error('UPSTREAM_RESPONSE_LIMIT');
          }
          chunks.push(value);
        }
        const buffer = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
        let text; let pairs;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); pairs = JSON.parse(text); }
        catch { throw new Error('UPSTREAM_INVALID_RESPONSE'); }
        if (!validPairs(pairs, input.addresses)) throw new Error('UPSTREAM_INVALID_RESPONSE');
        let fetchedAt;
        try { fetchedAt = new Date(now()).toISOString(); }
        catch { throw new Error('CLOCK_UNAVAILABLE'); }
        return { response: new Response(text, { status: 200, headers: {
          ...privateHeaders(),
          'cdn-cache-control': 'public, max-age=30',
          'vercel-cdn-cache-control': 'public, max-age=30',
          'x-radar-fetched-at': fetchedAt,
        } }), outcome: 'UPSTREAM_OK' };
      })()]);
      log(result.response.status, result.outcome);
      return result.response;
    } catch (error) {
      const code = controller.signal.aborted ? 'UPSTREAM_TIMEOUT'
        : ['UPSTREAM_RESPONSE_LIMIT', 'UPSTREAM_INVALID_RESPONSE', 'CLOCK_UNAVAILABLE'].includes(error?.message)
          ? error.message : 'UPSTREAM_UNAVAILABLE';
      return reject(code === 'UPSTREAM_TIMEOUT' ? 504 : code === 'CLOCK_UNAVAILABLE' ? 500 : 502, code);
    } finally { clearTimeout(timer); }
  };
}
