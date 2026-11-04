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
import { decodeTransaction, PROGRAMS } from "./protocols/index.mjs";
export class Scanner {
  constructor(
    config,
    {
      rpc,
      store,
      metrics,
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
    this.socketFactory = socketFactory;
    this.buffer = [];
    this.stopping = false;
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
    this.startedAt = new Date().toISOString();
    this.metrics.set("mainnetVerified", true);
    this.socket = this.socketFactory({
      url: this.config.wsUrl,
      programs: this.programs.map((p) => p.programId),
      commitment: this.config.commitment ?? "confirmed",
      metrics: this.metrics,
      reconnectMaxMs: this.config.reconnectMaxMs,
      idleTimeoutMs: this.config.idleTimeoutMs,
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
    if (
      this.config.logObservationsEnabled !== false &&
      this.contextBacklog + this.buffer.length >=
        (this.config.maxDurableBacklog ?? 250)
    ) {
      this.metrics.inc("contextEnrichmentSkipped");
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
    });
    if (this.buffer.length >= 100) this.flush();
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
      this.socket?.stop();
      throw e;
    }
  }
  flush() {
    this.flushObservations();
    if (!this.buffer.length) return;
    const items = this.buffer.splice(0, 100);
    try {
      this.store.receiveBatch(items);
    } catch (e) {
      this.buffer.unshift(...items);
      this.metrics.inc("persistenceFailures");
      this.socket?.stop();
      throw e;
    }
  }
  pump() {
    if (this.stopping) return;
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
    for (const observation of this.store.pending(Math.min(50, available))) {
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
    }
  }
  async processObservation(observation) {
    if (this.stopping) return false;
    if (this.store.isDone(observation.signature)) return true;
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
      ]);
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
        this.socket?.stop();
      }
      this.store.retry(observation.signature, error.code ?? error.message);
      this.recordError("PROCESSING_FAILED", error);
      return false;
    }
  }
  async tickRecovery() {
    if (this.stopping || this.recovering) return;
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
    return {
      schemaVersion: 1,
      chain: "solana",
      network: "mainnet-beta",
      mode: "READ_ONLY",
      status: this.stopping
        ? "STOPPING"
        : !metrics.gauges.websocket_connected ||
            metrics.gauges.coverageOverloaded ||
            storage.pending > 50
          ? "DEGRADED"
          : "OBSERVING",
      startedAt: this.startedAt ?? null,
      programs: this.programs,
      metrics,
      storage,
      coverage: "PARTIAL",
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
      while (this.buffer.length || this.observationBuffer.length) this.flush();
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
