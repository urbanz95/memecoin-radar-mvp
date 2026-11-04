import { fetch, EnvHttpProxyAgent } from "undici";
import { setTimeout as delay } from "node:timers/promises";

export const MAINNET_GENESIS_HASH =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const READ_METHODS = new Set([
  "getGenesisHash",
  "getSlot",
  "getBlockTime",
  "getAccountInfo",
  "getMultipleAccounts",
  "getTokenLargestAccounts",
  "getTokenSupply",
  "getTokenAccountsByOwner",
  "getSignaturesForAddress",
  "getTransaction",
  "getSignatureStatuses",
  "getHealth",
  "minimumLedgerSlot",
  "getFirstAvailableBlock",
  "getVersion",
]);

/** Preserve JSON integer literals outside JS's exact range as decimal strings. */
export function parseRpcJson(text) {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const start = index++;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index++] === '"') break;
      }
      output += text.slice(start, index);
      continue;
    }
    if (char === "-" || /[0-9]/.test(char)) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
        text.slice(index),
      );
      if (match) {
        const literal = match[0];
        output +=
          /^-?\d+$/.test(literal) && !Number.isSafeInteger(Number(literal))
            ? `"${literal}"`
            : literal;
        index += literal.length;
        continue;
      }
    }
    output += char;
    index++;
  }
  return JSON.parse(output);
}

export class RpcError extends Error {
  constructor(method, code = "TRANSPORT", retryAfterMs = 0) {
    super(`RPC ${method} failed (${code})`);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
export class RpcClient {
  constructor({
    url = "https://api.mainnet-beta.solana.com",
    metrics,
    requestsPerMinute = 60,
    maxConcurrency = 2,
    maxPending = 1000,
    retries = 3,
    timeoutMs = 20000,
    maxResponseBytes = 16 * 1024 * 1024,
    fetchImpl = fetch,
    dispatcher,
    now = Date.now,
    sleep = delay,
    random = Math.random,
  } = {}) {
    if (!["http:", "https:"].includes(new URL(url).protocol))
      throw Error("INVALID_RPC_URL");
    if (
      !Number.isInteger(requestsPerMinute) ||
      requestsPerMinute < 1 ||
      !Number.isInteger(maxConcurrency) ||
      maxConcurrency < 1
    )
      throw Error("INVALID_RPC_CONFIG");
    Object.assign(this, {
      url,
      metrics,
      requestsPerMinute,
      maxConcurrency,
      maxPending,
      retries,
      timeoutMs,
      maxResponseBytes,
      fetchImpl,
      now,
      sleep,
      random,
    });
    this.dispatcher =
      dispatcher ?? (fetchImpl === fetch ? new EnvHttpProxyAgent() : undefined);
    this.controller = new AbortController();
    this.id = 0;
    this.active = 0;
    this.waiters = [];
    this.nextRequestAt = 0;
    this.cooldownUntil = 0;
    this.throttleTail = Promise.resolve();
    this.mainnetVerified = false;
  }
  async acquire() {
    if (this.controller.signal.aborted) throw new RpcError("request", "CLOSED");
    if (this.active >= this.maxConcurrency) {
      if (this.waiters.length >= this.maxPending)
        throw new RpcError("request", "PENDING_LIMIT");
      await new Promise((resolve, reject) =>
        this.waiters.push({ resolve, reject }),
      );
    } else this.active++;
  }
  release() {
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.active--;
  }
  async throttle() {
    const previous = this.throttleTail;
    let release;
    this.throttleTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      while (true) {
        if (this.controller.signal.aborted)
          throw new RpcError("request", "CLOSED");
        const now = this.now();
        const notBefore = Math.max(this.nextRequestAt, this.cooldownUntil);
        if (now >= notBefore) {
          this.nextRequestAt = now + 60000 / this.requestsPerMinute;
          return;
        }
        this.metrics?.inc("rpc_budget_waits");
        // Smooth budget rather than a full minute's burst; long cooldowns remain cancellable.
        await this.sleep(
          Math.max(1, Math.min(60000, Math.ceil(notBefore - now))),
          undefined,
          { signal: this.controller.signal },
        );
      }
    } finally {
      release();
    }
  }
  async request(method, params = []) {
    if (!READ_METHODS.has(method)) throw Error("RPC_READ_ONLY_METHOD_REQUIRED");
    await this.acquire();
    try {
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        await this.throttle();
        const id = ++this.id;
        const started = this.now();
        this.metrics?.inc("rpc_requests");
        this.metrics?.inc(`rpc_method_${method}`);
        try {
          const response = await this.fetchImpl(this.url, {
            method: "POST",
            redirect: "error",
            headers: {
              "content-type": "application/json",
              "user-agent": "solana-memecoin-radar/1.0",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
            signal: AbortSignal.any([
              this.controller.signal,
              AbortSignal.timeout(this.timeoutMs),
            ]),
            ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
          });
          if (!response.ok) {
            const header = response.headers?.get("retry-after");
            const retryAfterMs = header
              ? /^\d+(?:\.\d+)?$/.test(header)
                ? Number(header) * 1000
                : Math.max(0, Date.parse(header) - this.now())
              : 0;
            await response.body?.cancel();
            throw new RpcError(
              method,
              `HTTP_${response.status}`,
              Math.min(300000, retryAfterMs || 0),
            );
          }
          const chunks = [];
          let bytes = 0;
          for await (const chunk of response.body) {
            bytes += chunk.byteLength;
            if (bytes > this.maxResponseBytes)
              throw new RpcError(method, "RESPONSE_LIMIT");
            chunks.push(chunk);
          }
          let body;
          try {
            body = parseRpcJson(Buffer.concat(chunks).toString("utf8"));
          } catch {
            throw new RpcError(method, "INVALID_JSON");
          }
          if (body.id !== id || body.jsonrpc !== "2.0")
            throw new RpcError(method, "INVALID_ENVELOPE");
          if (body.error)
            throw new RpcError(method, body.error.code ?? "REMOTE_ERROR");
          if (!Object.hasOwn(body, "result"))
            throw new RpcError(method, "MISSING_RESULT");
          this.metrics?.observe("rpc_latency_ms", this.now() - started);
          return body.result;
        } catch (error) {
          const safe = this.controller.signal.aborted
            ? new RpcError(method, "CLOSED")
            : error instanceof RpcError
              ? error
              : new RpcError(method);
          this.metrics?.inc("rpc_errors");
          if (safe.code === "HTTP_429" || safe.code === -32005)
            this.metrics?.inc("rate_limit_errors");
          const retryable = [
            "TRANSPORT",
            "HTTP_408",
            "HTTP_429",
            "HTTP_500",
            "HTTP_502",
            "HTTP_503",
            "HTTP_504",
            -32005,
          ].includes(safe.code);
          const retryMs = Math.max(
            safe.retryAfterMs,
            Math.min(30000, 500 * 2 ** attempt) * (0.5 + this.random()),
          );
          if (safe.code === "HTTP_429" || safe.code === -32005) {
            this.cooldownUntil = Math.max(
              this.cooldownUntil,
              this.now() + retryMs,
            );
            this.metrics?.set(
              "rpc_cooldown_until",
              new Date(this.cooldownUntil).toISOString(),
            );
          }
          if (!retryable || attempt === this.retries) throw safe;
          this.metrics?.inc("rpc_retries");
          if (safe.code !== "HTTP_429" && safe.code !== -32005)
            await this.sleep(retryMs, undefined, {
              signal: this.controller.signal,
            });
        }
      }
    } finally {
      this.release();
    }
  }
  async assertMainnet() {
    const genesis = await this.request("getGenesisHash");
    if (genesis !== MAINNET_GENESIS_HASH)
      throw Error("SOLANA_MAINNET_REQUIRED");
    this.mainnetVerified = true;
    return genesis;
  }
  async close() {
    this.controller.abort();
    this.waiters
      .splice(0)
      .forEach(({ reject }) => reject(new RpcError("request", "CLOSED")));
    await this.dispatcher?.close?.();
  }
}
