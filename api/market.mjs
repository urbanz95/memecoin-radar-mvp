import { createMarketGateway } from '../src/mvp/market-gateway.mjs';

const gateway = createMarketGateway();

/** Vercel Node.js function; bounded HTTP only, with no server process or scheduler. */
export default async function handler(request, response) {
  try {
    const url = new URL(request.url, 'https://market-gateway.invalid');
    const result = await gateway({ url: url.href, method: request.method || 'GET' });
    response.statusCode = result.status;
    result.headers.forEach((value, name) => response.setHeader(name, value));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('cdn-cache-control', 'no-store');
    response.setHeader('vercel-cdn-cache-control', 'no-store');
    response.end(JSON.stringify({ error: 'GATEWAY_UNAVAILABLE' }));
  }
}
