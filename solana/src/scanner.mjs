import { performance } from "node:perf_hooks";
import { Store } from "./store.mjs";
import { Metrics } from "./metrics.mjs";
import { RpcClient } from "./rpc.mjs";
import { BoundedQueue } from "./queue.mjs";
import { LogSocket } from "./websocket.mjs";
import { recoverProgram } from "./recovery.mjs";
import { aggregateMarket } from "./market.mjs";
import { inspectMint } from "./security.mjs";
import { decodeLogObservation } from "./log-observations.mjs";
import { FdvEnrichmentGate } from "./market-cap-gate.mjs";
import { SolUsdOracle } from "./sol-usd-oracle.mjs";
import { buildRadarSnapshot } from "./radar.mjs";
import { classifyContextPriority, PriorityScheduler } from "./enrichment-priority.mjs";
import { decodeTransaction, PROGRAMS } from "./protocols/index.mjs";
export class Scanner {
  constructor(
    config,
    {
      rpc,
      store,
      metrics,
      oracle,
      decode = decodeTransaction,
      socketFactory = (opts) => new LogSocket(opts),
    } = {},
  ) {
    this.config = config;
    this.metrics = metrics ?? new Metrics();
    this.store =
      store ??
      new Store(config.dbPath, {
        maxBytes: config.maxStorageBytes,
        rawRetentionHours: config.rawRetentionHours,
        eventRetentionDays: config.eventRetentionDays,
      });
    this.rpc =
      rpc ??
      new RpcClient({
        url: config.httpUrl,
        metrics: this.metrics,
        requestsPerMinute: config.requestsPerMinute ?? 60,
        maxConcurrency: config.rpcConcurrency ?? 2,
        retries: config.rpcRetries ?? 2,
      });
    this.decode = decode;
    this.oracle = oracle ?? new SolUsdOracle({ enabled: config.solUsdFeedEnabled, fallbackEnabled: config.solUsdFallbackEnabled });
    this.fdvGate = new FdvEnrichmentGate({
      minimumUsd: config.fdvMinimumUsd ?? 0,
      oracle: this.oracle,
    });
    this.socketFactory = socketFactory;
    this.priorityScheduler = new PriorityScheduler();
    this.buffer = [];
    this.stopping = false;
    // Storage failures must not leave a live HTTP process with a permanently
    // stopped ingest socket.
    this.storagePaused = false;
    this.storagePausedAt = null;
    this.storageRetryAt = 0;
    this.storageFailuresInRow = 0;
    this.metrics.set("websocket_storage_paused", false);
    this.recoveryPending = false;
    this.recovering = false;
    this.activeSignatures = new Set();
    this.timers = [];
    this.backgroundTasks = new Set();
    this.observationBuffer = [];
    this.contextBacklog = 0;
    this.logDiagnostics = new Map();
    this.queue = new BoundedQueue({
      capacity: config.queueCapacity ?? 500,
      concurrency: config.processingConcurrency ?? 2,
      metrics: this.metrics,
      onError: (e) => this.recordError("QUEUE_TASK_ERROR", e),
    });
    const enabled = config.programs ?? [
      "pump_fun",
      "pump_swap",
      "raydium_launchlab",
      "raydium_cpmm",
    ];
    this.programs = PROGRAMS.filter(
      (p) => enabled.includes(p.protocol) || enabled.includes(p.programId),
    );
    if (!this.programs.length) throw Error("NO_KNOWN_PROGRAM_SELECTED");
  }
  recordError(code, error) {
    this.metrics.inc("errors");
    try {
      this.store.error(code, {
        code: error.code ?? error.message ?? "UNKNOWN",
      });
    } catch {
      this.metrics.inc("persistenceFailures");
    }
  }
  async start() {
    await this.rpc.assertMainnet();
    // Optional external quote feed; failure must never prevent log observation.
    if (this.config.fdvMinimumUsd > 0) await this.oracle.refresh();
    this.startedAt = new Date().toISOString();
    this.metrics.set("mainnetVerified", true);
    this.socket = this.socketFactory({
      url: this.config.wsUrl,
      programs: this.programs.map((p) => p.programId),
      commitment: this.config.commitment ?? "confirmed",
      metrics: this.metrics,
      reconnectMaxMs: this.config.reconnectMaxMs,
      idleTimeoutMs: this.config.idleTimeoutMs,
      noLogTimeoutMs: this.config.wsNoLogTimeoutMs ?? 0,
      onLog: (message, programId) => this.receive(message, programId),
      onConnect: () => {
        if (this.disconnectedAt)
          this.store.gap("RECONNECTED_RECOVERY_REQUIRED", {
            from: this.disconnectedAt,
            to: new Date().toISOString(),
            lastObservedSlot:
              this.metrics.snapshot().gauges.currentSlot ?? null,
          });
        this.disconnectedAt = null;
        this.recoveryPending = true;
      },
      onDisconnect: (reason) => {
        this.disconnectedAt = new Date().toISOString();
        this.recoveryPending = true;
        this.store.gap("WEBSOCKET_DISCONNECTED", {
          reason: reason?.reason ?? String(reason ?? "DISCONNECT"),
        });
        this.metrics.inc("recoveryGaps");
      },
    });
    this.socket.start();
    if ((this.config.contextMaxAgeMs ?? 0) > 0) {
      this.expireStaleContext();
      this.every(() => this.expireStaleContext(), 10000);
    }
    if (this.config.fdvMinimumUsd > 0)
      this.every(() => this.oracle.refresh(), 120000);
    // Separate from WebSocket heartbeat: a durable-write canary controls recovery.
    this.every(() => this.storageRecoveryWatchdog(), 5000);
    this.every(() => this.flush(), 250);
    this.every(() => this.pump(), 250);
    this.every(() => this.tickRecovery(), 5000);
    this.every(() => this.reconcile(), 30000);
    this.every(() => {
      this.recoveryPending = true;
    }, 120000);
    this.every(() => this.persistMetrics(), 10000);
    this.every(() => this.store.retain(), 60000);
    this.pump();
  }
  expireStaleContext() {
    const n = this.store.expireStaleLogContext({
      maxAgeMs: this.config.contextMaxAgeMs,
    });
    if (n > 0) this.metrics.inc("contextEnrichmentExpired", n);
    return n;
  }
  every(fn, ms) {
    let running = false;
    const timer = setInterval(() => {
      if (running || this.stopping) return;
      running = true;
      const task = Promise.resolve()
        .then(fn)
        .catch((e) => this.recordError("BACKGROUND_ERROR", e))
        .finally(() => {
          running = false;
          this.backgroundTasks.delete(task);
        });
      this.backgroundTasks.add(task);
    }, ms);
    this.timers.push(timer);
  }
  receive(message, programId) {
    programId ??= message?.programId;
    const value = message?.params?.result?.value ?? message?.value ?? message;
    const slot =
      message?.params?.result?.context?.slot ??
      message?.context?.slot ??
      value?.slot;
    if (!value?.signature || !Number.isSafeInteger(slot)) {
      this.recordError("INVALID_LOG_NOTIFICATION", Error("INVALID_SHAPE"));
      return;
    }
    const receivedAt = message.receivedAt ?? new Date().toISOString();
    let logObservations = [];
    if (this.config.logObservationsEnabled !== false) {
      const notification = {
        ...value,
        signature: value.signature,
        slot,
        programId,
        receivedAt,
        confirmationStatus: this.config.commitment ?? "confirmed",
      };
      try {
        const result = decodeLogObservation(notification);
        logObservations = result.observations;
        for (const d of result.diagnostics) {
          this.metrics.inc(`logDiagnostic_${d.code}`);
          if (/UNKNOWN|INVALID|FAILURE|TRUNCATED/.test(d.code)) {
            this.metrics.inc("logDecoderFailures");
            const last = this.logDiagnostics.get(d.code) ?? 0;
            if (Date.now() - last > 60000) {
              this.store.gap("LOG_DECODER_COVERAGE", {
                code: d.code,
                signature: notification.signature,
                programId,
              });
              this.logDiagnostics.set(d.code, Date.now());
            }
          }
        }
        if (result.observations.length) {
          if (this.observationBuffer.length >= 1000) this.flushObservations();
          this.observationBuffer.push({
            notification,
            observations: result.observations,
          });
          this.metrics.inc(
            "logObservationsDecoded",
            result.observations.length,
          );
        }
      } catch (e) {
        this.recordError("LOG_OBSERVATION_DECODE_FAILED", e);
      }
    }
    this.metrics.set("currentSlot", slot);
    this.metrics.set("lastEventReceived", new Date().toISOString());
    this.metrics.inc("notificationsReceived");
    let valuation = { action: "UNKNOWN" };
    if (this.config.logObservationsEnabled !== false &&
        this.config.fdvMinimumUsd > 0) {
      // Log observations have already been buffered for durable persistence.
      // Only suppress expensive HTTP enrichment when an evidence-backed,
      // fresh SOL-quoted Pump.fun FDV proxy is unambiguously below the floor.
      valuation = this.fdvGate.evaluate(logObservations);
      if (valuation.action === "SKIP_LOW_FDV") {
        this.metrics.inc("fdvGateSkippedLow");
        return;
      }
      if (valuation.action === "ENRICH") this.metrics.inc("fdvGateEligible");
      else this.metrics.inc("fdvGateUnknown");
    }
    const prioritize = this.config.contextPrioritiesEnabled === true &&
      this.config.logObservationsEnabled !== false;
    const contextPriority = prioritize
      ? classifyContextPriority(logObservations, valuation) : 3;
    if (prioritize) this.metrics.inc(`contextPrioritySeenP${contextPriority}`);
    // Under a constrained HTTP budget, focus only on opted-in priorities.
    // This never discards or downgrades the separately persisted log events.
    if (prioritize && contextPriority > (this.config.contextMaxPriority ?? 3)) {
      this.metrics.inc(`contextPrioritySkippedP${contextPriority}`);
      this.metrics.inc("contextEnrichmentExcludedByPolicy");
      return;
    }
    // Reserve a few of the *existing* durable slots for P0 arrivals; no
    // increase to durable capacity or shared RPC request budget.
    const maxBacklog = this.config.maxDurableBacklog ?? 250;
    const reserved = prioritize
      ? Math.min(maxBacklog, this.config.priorityP0ReservedSlots ?? 8) : 0;
    const backlogLimit = contextPriority === 0
      ? maxBacklog : Math.max(0, maxBacklog - reserved);
    if (
      this.config.logObservationsEnabled !== false &&
      this.contextBacklog + this.buffer.length >= backlogLimit
    ) {
      if (prioritize) {
        this.metrics.inc(`contextPrioritySkippedP${contextPriority}`);
        if (contextPriority !== 0 &&
            this.contextBacklog + this.buffer.length < maxBacklog)
          this.metrics.inc("contextPriorityReservedAdmissionSkip");
      }
      this.metrics.inc("contextEnrichmentSkipped");
      // Distinguish persistent queue pressure from unflushed ingress pressure.
      // These are admission diagnostics, not a count of missing market events.
      if (this.contextBacklog >= (this.config.maxDurableBacklog ?? 250))
        this.metrics.inc("contextSkippedDurableBacklog");
      else this.metrics.inc("contextSkippedIngressBuffer");
      return;
    }
    if (this.buffer.length >= (this.config.ingressCapacity ?? 1000)) {
      this.metrics.inc("ingressRejected");
      this.store.gap("INGRESS_BACKPRESSURE", {
        programId,
        signature: value.signature,
        slot,
      });
      this.metrics.inc("recoveryGaps");
      this.socket.reconnect("INGRESS_BACKPRESSURE");
      return;
    }
    this.buffer.push({
      signature: value.signature,
      slot,
      programId,
      receivedAt: new Date().toISOString(),
      confirmationStatus: this.config.commitment ?? "confirmed",
      evidenceSource: "rpc:logsSubscribe",
      onchainError: value.err ?? null,
      ...(prioritize ? { contextPriority } : {}),
    });
    if (prioritize) this.metrics.inc(`contextPriorityAdmittedP${contextPriority}`);
    if (this.buffer.length >= 100) this.flush();
  }
  pauseForStorageError(error) {
    if (this.stopping) return;
    const now = Date.now();
    if (!this.storagePaused) {
      this.storagePaused = true;
      this.storagePausedAt = new Date(now).toISOString();
      this.disconnectedAt ??= this.storagePausedAt;
      this.recoveryPending = true;
      this.metrics.inc("websocket_storage_pauses");
      this.metrics.set("websocket_storage_paused", true);
      this.metrics.set("websocket_storage_paused_at", this.storagePausedAt);
      // Preserve uncommitted buffers; do not keep ingesting while SQLite fails.
      this.socket?.stop();
    }
    const code = error?.code;
    this.metrics.set("websocket_storage_last_error_code",
      typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
        ? code : error?.message === "STORAGE_BUDGET_EXCEEDED"
          ? "STORAGE_BUDGET_EXCEEDED" : "STORAGE_WRITE_ERROR");
    this.storageFailuresInRow = Math.min(this.storageFailuresInRow + 1, 16);
    const delay = Math.min(60000, 5000 * 2 ** Math.min(this.storageFailuresInRow - 1, 4));
    this.storageRetryAt = now + delay;
    this.metrics.set("websocket_storage_retry_delay_ms", delay);
    this.metrics.set("websocket_storage_next_retry_at", new Date(this.storageRetryAt).toISOString());
  }
  storageRecoveryWatchdog() {
    if (this.stopping) return;
    if (!this.storagePaused) {
      // start() does nothing when LogSocket already runs or is reconnecting.
      // Respect deliberate backpressure in profiles without log persistence.
      if (this.socket?.stopped === true &&
          (this.config.logObservationsEnabled !== false || !this.overloadRecorded)) {
        this.metrics.inc("websocket_unexpected_stops");
        this.socket.start();
      }
      return;
    }
    if (Date.now() < this.storageRetryAt) return;
    this.metrics.inc("websocket_storage_recovery_attempts");
    try {
      this.store.checkBudget();
      this.flush({ allowPaused: true });
      // An actual write verifies recovery; a successful health GET does not.
      this.store.recordMetrics(this.health());
      this.store.gap("PERSISTENCE_PAUSE_RECOVERED", {
        from: this.storagePausedAt,
        to: new Date().toISOString(),
      });
      this.storagePaused = false;
      this.storagePausedAt = null;
      this.storageRetryAt = 0;
      this.storageFailuresInRow = 0;
      this.metrics.set("websocket_storage_paused", false);
      this.metrics.set("websocket_storage_next_retry_at", null);
      this.metrics.inc("websocket_storage_recoveries");
      this.recoveryPending = true;
      this.socket?.start();
      // Only subscriptions and subsequent notifications establish live health.
    } catch (error) {
      this.metrics.inc("websocket_storage_recovery_failures");
      // flush() might already have scheduled retry; do not double the backoff.
      if (this.storageRetryAt <= Date.now()) {
        this.metrics.inc("persistenceFailures");
        this.pauseForStorageError(error);
      }
    }
  }
  flushObservations() {
    if (!this.observationBuffer.length) return;
    const batch = this.observationBuffer.splice(0, 1000);
    try {
      const n = this.store.persistLogBatch(batch, {
        maxRows: this.config.maxObservationRows ?? 25000,
      });
      this.metrics.inc("logObservationsPersisted", n);
      this.metrics.set(
        "logObservationRowsPruned",
        this.store.logObservationRowsPruned ?? 0,
      );
      for (const item of batch)
        this.metrics.observe(
          "logObservationLatencyMs",
          Date.now() - Date.parse(item.notification.receivedAt),
        );
      this.metrics.set("lastLogObservationPersisted", new Date().toISOString());
    } catch (e) {
      this.observationBuffer.unshift(...batch);
      this.metrics.inc("persistenceFailures");
      this.pauseForStorageError(e);
      throw e;
    }
  }
  flush({ allowPaused = false } = {}) {
    if (this.storagePaused && !allowPaused) return;
    this.flushObservations();
    if (!this.buffer.length) return;
    const items = this.buffer.splice(0, 100);
    try {
      this.store.receiveBatch(items);
    } catch (e) {
      this.buffer.unshift(...items);
      this.metrics.inc("persistenceFailures");
      this.pauseForStorageError(e);
      throw e;
    }
  }
  pump() {
    if (this.stopping || this.storagePaused) return;
    const capacity = this.config.maxDurableBacklog ?? 5000;
    const stats = this.store.stats();
    this.contextBacklog = stats.pending;
    this.metrics.set("durableBacklog", stats.pending);
    if (stats.pending >= capacity) {
      this.metrics.set("coverageOverloaded", true);
      if (this.config.logObservationsEnabled === false) this.socket?.stop();
      if (!this.overloadRecorded) {
        this.store.gap("DURABLE_BACKPRESSURE", {
          pending: stats.pending,
          limit: capacity,
        });
        this.metrics.inc("recoveryGaps");
        this.overloadRecorded = true;
      }
    } else if (this.overloadRecorded && stats.pending < capacity / 2) {
      this.overloadRecorded = false;
      this.metrics.set("coverageOverloaded", false);
      this.socket?.start();
      this.recoveryPending = true;
    }
    const available = Math.max(
      0,
      (this.config.queueCapacity ?? 500) - this.queue.depth,
    );
    const selected = this.config.contextPrioritiesEnabled === true &&
      this.config.logObservationsEnabled !== false
      ? this.priorityScheduler.select(
          [0, 1, 2, 3].map(rank => this.store.pendingByPriority(
            rank, Math.min(100, Math.max(4, available * 4)),
          )),
          Math.min(50, available), this.activeSignatures,
        )
      : this.store.pending(Math.min(50, available));
    for (const observation of selected) {
      if (this.activeSignatures.has(observation.signature)) continue;
      this.activeSignatures.add(observation.signature);
      const accepted = this.queue.submit(async () => {
        try {
          await this.processObservation(observation);
        } finally {
          this.activeSignatures.delete(observation.signature);
        }
      });
      if (!accepted) {
        this.activeSignatures.delete(observation.signature);
        this.metrics.inc("queueBackpressure");
        break;
      }
      if (this.config.contextPrioritiesEnabled === true &&
          Number.isInteger(observation.contextPriority))
        this.metrics.inc(`contextPriorityScheduledP${observation.contextPriority}`);
    }
  }
  async processObservation(observation) {
    if (this.stopping) return false;
    if (this.store.isDone(observation.signature)) return true;
    // Avoid wasting scarce RPC on an observation that aged while queued.
    if ((this.config.contextMaxAgeMs ?? 0) > 0 &&
        observation.evidenceSource === "rpc:logsSubscribe" &&
        Number.isFinite(Date.parse(observation.receivedAt)) &&
        Date.now() - Date.parse(observation.receivedAt) > this.config.contextMaxAgeMs) {
      const expired = this.store.expireStaleLogContext({
        maxAgeMs: this.config.contextMaxAgeMs,
        signature: observation.signature,
      });
      if (expired) this.metrics.inc("contextEnrichmentExpired", expired);
      return false;
    }
    if (!this.store.claim(observation.signature)) return false;
    try {
      if (
        observation.onchainError &&
        observation.confirmationStatus !== "processed"
      ) {
        this.store.completeFailed(observation, observation.onchainError);
        return true;
      }
      const started = performance.now();
      const tx = await this.rpc.request("getTransaction", [
        observation.signature,
        {
          encoding: "json",
          commitment:
            observation.confirmationStatus === "finalized"
              ? "finalized"
              : "confirmed",
          maxSupportedTransactionVersion: 1,
        },
      ], {
        priority: observation.contextPriority,
      });
      this.metrics.observe(
        "transactionEnrichmentLatencyMs",
        performance.now() - started,
      );
      if (!tx) {
        this.store.retry(observation.signature, "NOT_YET_AVAILABLE", {
          delayMs: 10000,
        });
        this.metrics.inc("transactionUnavailable");
        return false;
      }
      if (
        !Array.isArray(tx.transaction?.signatures) ||
        !tx.transaction.signatures.includes(observation.signature)
      )
        throw Error("TRANSACTION_IDENTITY_MISMATCH");
      if (tx.slot !== observation.slot) {
        if (observation.confirmationStatus !== "processed")
          throw Error("TRANSACTION_IDENTITY_MISMATCH");
        this.store.gap("EARLY_OBSERVATION_SLOT_CHANGED", {
          signature: observation.signature,
          observedSlot: observation.slot,
          confirmedSlot: tx.slot,
        });
        this.metrics.inc("recoveryGaps");
      }
      if (tx.meta?.err) {
        this.store.completeFailed(
          {
            ...observation,
            slot: tx.slot,
            confirmationStatus:
              observation.confirmationStatus === "finalized"
                ? "finalized"
                : "confirmed",
          },
          tx.meta.err,
          tx,
        );
        return true;
      }
      const enriched = {
        ...observation,
        confirmationStatus:
          observation.confirmationStatus === "finalized"
            ? "finalized"
            : "confirmed",
      };
      const result = this.decode(tx, enriched);
      const count = this.store.persistTransaction(
        enriched,
        tx,
        result.events,
        result.diagnostics,
      );
      this.metrics.inc("transactionsProcessed");
      // Count only successfully persisted enrichment, not queued or retried RPC.
      if (this.config.contextPrioritiesEnabled === true &&
          [0, 1, 2, 3].includes(observation.contextPriority)) {
        this.metrics.inc(`contextPriorityCompletedP${observation.contextPriority}`);
        this.metrics.observe(`contextPriorityCompletionLatencyP${observation.contextPriority}Ms`,
          Math.max(0, Date.now() - Date.parse(observation.receivedAt)));
      }
      this.metrics.inc("events_processed", count);
      this.metrics.inc(
        "decoderFailures",
        result.diagnostics?.filter((d) =>
          /UNKNOWN|FAIL|UNSUPPORTED|INVALID|ERROR/.test(d.code),
        ).length ?? 0,
      );
      this.metrics.set("lastEventProcessed", new Date().toISOString());
      if (count)
        this.metrics.observe(
          observation.evidenceSource === "rpc:logsSubscribe"
            ? "eventProcessingLatencyMs"
            : "recoveryProcessingLatencyMs",
          Date.now() - Date.parse(observation.receivedAt),
        );
      if (
        observation.evidenceSource === "rpc:logsSubscribe" &&
        tx.blockTime &&
        Number.isSafeInteger(tx.blockTime)
      )
        this.metrics.observe(
          "onchainToReceiveLatencyMs",
          Math.max(0, Date.parse(observation.receivedAt) - tx.blockTime * 1000),
        );
      return true;
    } catch (error) {
      this.metrics.inc("processingFailures");
      if (/STORAGE|SQLITE|EVENT_|RAW_AMOUNT/.test(error.message)) {
        this.metrics.inc("persistenceFailures");
        this.pauseForStorageError(error);
      }
      try {
        this.store.retry(observation.signature, error.code ?? error.message);
      } catch (storageError) {
        this.metrics.inc("persistenceFailures");
        this.pauseForStorageError(storageError);
      }
      this.recordError("PROCESSING_FAILED", error);
      return false;
    }
  }
  async tickRecovery() {
    if (this.stopping || this.storagePaused || this.recovering) return;
    // Drain captured live data before using the shared free RPC budget for history.
    if (
      this.recoveryPending &&
      this.store.stats().pending < (this.config.recoveryBacklogThreshold ?? 50)
    ) {
      this.recovering = true;
      this.recoveryPending = false;
      try {
        for (const p of this.programs) {
          if (this.stopping) break;
          const result = await recoverProgram({
            rpc: this.rpc,
            store: this.store,
            programId: p.programId,
            processObservation: (o) => this.processObservation(o),
            metrics: this.metrics,
            maxPages: this.config.recoveryMaxPages ?? 3,
            pageSize: this.config.recoveryPageSize ?? 25,
          });
          this.metrics.set(`recovery.${p.protocol}`, result);
          if (!result.checkpointAdvanced) this.recoveryPending = true;
        }
      } finally {
        this.recovering = false;
      }
    }
    if (this.config.securityEnabled && !this.stopping) {
      const mint = this.store.nextSecurityMint();
      if (mint) {
        try {
          this.store.security(mint, await inspectMint(this.rpc, mint));
        } catch (e) {
          this.store.security(mint, {
            status: "UNKNOWN",
            error: e.code ?? e.message,
            checkedAt: new Date().toISOString(),
          });
          this.recordError("SECURITY_ENRICHMENT_FAILED", e);
        }
      }
    }
  }
  async reconcile() {
    if (this.storagePaused) return;
    const rows = this.store.nonFinalized();
    if (!rows.length) return;
    try {
      const result = await this.rpc.request("getSignatureStatuses", [
        rows.map((r) => r.signature),
        { searchTransactionHistory: true },
      ]);
      if (!Array.isArray(result?.value) || result.value.length !== rows.length)
        throw Error("INVALID_STATUS_RESPONSE");
      rows.forEach((row, i) => {
        const status = result.value[i];
        if (status === null && Date.now() - row.received_at < 180000) return;
        this.store.reconcile(row.signature, status);
      });
    } catch (e) {
      this.recordError("FINALITY_RECONCILIATION_FAILED", e);
    }
  }
  persistMetrics() {
    const snapshot = this.health();
    this.store.recordMetrics(snapshot);
    this.metrics.set("storageConsumptionBytes", snapshot.storage.storageBytes);
  }
  radar({ limit = 50, now = Date.now() } = {}) {
    const sampleLimit = Math.min(10000, this.config.maxObservationRows ?? 10000);
    const rows = this.store.radarObservations({ limit: sampleLimit, now });
    return buildRadarSnapshot(rows, {
      now, minimumFdvUsd: this.config.fdvMinimumUsd || 5000,
      limit, quote: this.oracle.snapshot(), sampleLimit,
    });
  }
  market() {
    return aggregateMarket(
      this.store.events({ since: Date.now() - 900000, limit: 10000 }),
      {
        coverage: {
          status: "PARTIAL",
          scope: "selected_programs_and_decoded_events",
          gaps: this.store.stats().gaps,
          limit: 10000,
        },
      },
    );
  }
  health() {
    const metrics = this.metrics.snapshot();
    const storage = this.store.stats();
    const noLogTimeoutMs = this.config.wsNoLogTimeoutMs ?? 0;
    const lastLogAt = Date.parse(metrics.gauges.lastEventReceived ?? "");
    const noRecentLogs = noLogTimeoutMs > 0 &&
      (!Number.isFinite(lastLogAt) ||
        Date.parse(metrics.measuredAt) - lastLogAt >= noLogTimeoutMs);
    return {
      schemaVersion: 1,
      chain: "solana",
      network: "mainnet-beta",
      mode: "READ_ONLY",
      status: this.stopping
        ? "STOPPING"
        : this.storagePaused || !metrics.gauges.websocket_connected ||
            noRecentLogs ||
            metrics.gauges.coverageOverloaded ||
            storage.pending > 50
          ? "DEGRADED"
          : "OBSERVING",
      startedAt: this.startedAt ?? null,
      programs: this.programs,
      metrics,
      storage,
      coverage: "PARTIAL",
      backup: this.backupAgent?.status?.() ?? { enabled: false },
      logStream: {
        noRecentLogs,
        timeoutMs: noLogTimeoutMs,
        lastObservedAt: Number.isFinite(lastLogAt)
          ? new Date(lastLogAt).toISOString() : null,
      },
      contextPriorityScheduler: {
        enabled: this.config.contextPrioritiesEnabled === true &&
          this.config.logObservationsEnabled !== false,
        cycle: "P0:4 P1:2 P2:1 P3:1; weighted admissions, not reserved RPC calls",
        reservedP0Slots: Math.min(this.config.maxDurableBacklog ?? 250,
          this.config.priorityP0ReservedSlots ?? 8),
        logObservationsPreservedIndependently: true,
        backlogCoverage: "PARTIAL",
        maxHttpPriority: this.config.contextMaxPriority ?? 3,
        maxAgeMs: this.config.contextMaxAgeMs ?? 0,
      },
      fdvFilter: {
        enabled: (this.config.fdvMinimumUsd ?? 0) > 0,
        minimumUsd: this.config.fdvMinimumUsd ?? 0,
        valuation: "PUMP_FUN_SOL_QUOTED_VIRTUAL_RESERVE_FDV_PROXY_NOT_CIRCULATING_MCAP",
        oraclePrice: this.oracle.snapshot(),
        oracleFailures: this.oracle.failures ?? 0,
        fallbackSuccesses: this.oracle.fallbackSuccesses ?? 0,
        supplyCacheSize: this.fdvGate.supplies.size,
        supplyCacheEvictions: this.fdvGate.cacheEvictions,
      },
      latencyScope:
        "logObservationLatencyMs: partial RPC logs; eventProcessingLatencyMs: enriched transactions; no production guarantee",
    };
  }
  async stop() {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    this.socket?.stop();
    let failure;
    try {
      while (this.buffer.length || this.observationBuffer.length)
        this.flush({ allowPaused: true });
    } catch (e) {
      failure = e;
    }
    await this.rpc.close();
    await this.queue.stop();
    await Promise.allSettled([...this.backgroundTasks]);
    try {
      this.store.recordMetrics(this.health());
    } finally {
      this.store.close();
    }
    if (failure) throw failure;
  }
}
