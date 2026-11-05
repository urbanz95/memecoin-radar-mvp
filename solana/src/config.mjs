const integer = (env, name, fallback, min, max) => {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw Error(`INVALID_CONFIG_${name}`);
  return value;
};
export function loadConfig(env = process.env) {
  const rpcUrl =
    env.SOLANA_RPC_HTTP_URL ?? "https://api.mainnet-beta.solana.com";
  const wsUrl = env.SOLANA_RPC_WS_URL ?? "wss://api.mainnet-beta.solana.com";
  for (const [value, protocols, name] of [
    [rpcUrl, ["http:", "https:"], "HTTP"],
    [wsUrl, ["ws:", "wss:"], "WS"],
  ]) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw Error(`INVALID_RPC_${name}_URL`);
    }
    if (!protocols.includes(url.protocol))
      throw Error(`INVALID_RPC_${name}_URL`);
  }
  const commitment = env.SOLANA_COMMITMENT ?? "confirmed";
  if (!["processed", "confirmed", "finalized"].includes(commitment))
    throw Error("INVALID_COMMITMENT");
  const protocols = [
    "pump_fun",
    "pump_swap",
    "raydium_launchlab",
    "raydium_cpmm",
  ];
  const programs = (env.SOLANA_PROGRAMS ?? protocols.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!programs.length || programs.some((value) => !protocols.includes(value)))
    throw Error("INVALID_SOLANA_PROGRAMS");
  if (
    env.SOLANA_LOG_OBSERVATIONS_ENABLED !== undefined &&
    !["true", "false", "1", "0"].includes(env.SOLANA_LOG_OBSERVATIONS_ENABLED)
  )
    throw Error("INVALID_SOLANA_LOG_OBSERVATIONS_ENABLED");
  if (
    env.SOLANA_SECURITY_ENABLED !== undefined &&
    !["true", "false", "1", "0"].includes(env.SOLANA_SECURITY_ENABLED)
  )
    throw Error("INVALID_SOLANA_SECURITY_ENABLED");
  const solUsdFeed = env.SOLANA_SOL_USD_FEED ?? "off";
  if (!["off", "coingecko"].includes(solUsdFeed))
    throw Error("INVALID_SOLANA_SOL_USD_FEED");
  if (env.SOLANA_CONTEXT_PRIORITIES_ENABLED !== undefined &&
      !["true", "false", "1", "0"].includes(env.SOLANA_CONTEXT_PRIORITIES_ENABLED))
    throw Error("INVALID_SOLANA_CONTEXT_PRIORITIES_ENABLED");
  const queueConcurrency = integer(env, "SOLANA_QUEUE_CONCURRENCY", 2, 1, 32);
  const retentionDays = integer(env, "SOLANA_RETENTION_DAYS", 7, 1, 365);
  return {
    rpcUrl,
    httpUrl: rpcUrl,
    wsUrl,
    commitment,
    programs: [...new Set(programs)],
    fdvMinimumUsd: integer(env, "SOLANA_FDV_MINIMUM_USD", 0, 0, 1_000_000_000),
    solUsdFeedEnabled: solUsdFeed === "coingecko",
    contextPrioritiesEnabled: ["true", "1"].includes(env.SOLANA_CONTEXT_PRIORITIES_ENABLED),
    priorityP0ReservedSlots: integer(env, "SOLANA_PRIORITY_RESERVED_P0_SLOTS", 8, 0, 10000),
    securityEnabled: ["true", "1"].includes(env.SOLANA_SECURITY_ENABLED),
    logObservationsEnabled: ["true", "1"].includes(
      env.SOLANA_LOG_OBSERVATIONS_ENABLED ?? "true",
    ),
    maxObservationRows: integer(
      env,
      "SOLANA_MAX_OBSERVATION_ROWS",
      25000,
      100,
      1000000,
    ),
    requestsPerMinute: integer(
      env,
      "SOLANA_RPC_REQUESTS_PER_MINUTE",
      60,
      1,
      60000,
    ),
    rpcConcurrency: integer(env, "SOLANA_RPC_CONCURRENCY", 2, 1, 32),
    queueCapacity: integer(env, "SOLANA_QUEUE_CAPACITY", 1000, 1, 100000),
    queueConcurrency,
    processingConcurrency: queueConcurrency,
    maxDurableBacklog: integer(
      env,
      "SOLANA_MAX_DURABLE_BACKLOG",
      250,
      1,
      1000000,
    ),
    ingressCapacity: integer(env, "SOLANA_INGRESS_CAPACITY", 1000, 1, 100000),
    recoveryBacklogThreshold: integer(
      env,
      "SOLANA_RECOVERY_BACKLOG_THRESHOLD",
      20,
      0,
      100000,
    ),
    port: integer(env, "SOLANA_HEALTH_PORT", 8787, 0, 65535),
    host: env.SOLANA_HEALTH_HOST ?? "127.0.0.1",
    dbPath: env.SOLANA_DB_PATH ?? "runtime/solana/scanner.sqlite",
    retentionDays,
    eventRetentionDays: retentionDays,
    rawRetentionHours: integer(env, "SOLANA_RAW_RETENTION_HOURS", 24, 1, 8760),
    maxStorageBytes: integer(
      env,
      "SOLANA_MAX_STORAGE_BYTES",
      512 * 1024 * 1024,
      1024 * 1024,
      1024 ** 4,
    ),
    recoveryPageSize: integer(env, "SOLANA_RECOVERY_PAGE_SIZE", 100, 1, 1000),
    recoveryMaxPages: integer(env, "SOLANA_RECOVERY_MAX_PAGES", 5, 1, 1000),
    reconnectMaxMs: integer(
      env,
      "SOLANA_RECONNECT_MAX_MS",
      30000,
      1000,
      300000,
    ),
    idleTimeoutMs: integer(
      env,
      "SOLANA_WS_IDLE_TIMEOUT_MS",
      60000,
      1000,
      600000,
    ),
  };
}
