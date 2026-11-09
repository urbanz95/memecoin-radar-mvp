import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalEvent, CONFIRMATIONS } from "./events.mjs";
import { installRadarRollups, recordRadarRollup, pruneRadarRollups, readRadarRollups } from "./radar-time-aggregation.mjs";
const json = (value) => JSON.stringify(value);
const parse = (row) => (row ? JSON.parse(row.payload) : null);
export class Store {
  constructor(
    path,
    {
      maxBytes = 512 * 1024 * 1024,
      rawRetentionHours = 24,
      eventRetentionDays = 7,
    } = {},
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.path = path;
    this.maxBytes = maxBytes;
    this.rawRetentionHours = rawRetentionHours;
    this.eventRetentionDays = eventRetentionDays;
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS inbox(signature TEXT PRIMARY KEY, slot INTEGER NOT NULL, received_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(status,next_at,received_at);
      CREATE TABLE IF NOT EXISTS event_observations(id TEXT PRIMARY KEY,signature TEXT NOT NULL,token_mint TEXT,pool_address TEXT,wallet TEXT,received_at INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS observations_signature ON event_observations(signature);
      CREATE INDEX IF NOT EXISTS observations_time ON event_observations(received_at);
      CREATE TABLE IF NOT EXISTS selected_log_messages(signature TEXT NOT NULL,source_message_sha256 TEXT NOT NULL,received_at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(signature,source_message_sha256));
      CREATE TABLE IF NOT EXISTS raw_transaction_revisions(signature TEXT NOT NULL,slot INTEGER NOT NULL,retained_at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(signature,slot));
      CREATE TABLE IF NOT EXISTS raw_transactions(signature TEXT PRIMARY KEY, retained_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transactions(signature TEXT PRIMARY KEY, slot INTEGER NOT NULL, confirmation TEXT NOT NULL, reconciliation TEXT NOT NULL DEFAULT 'ACTIVE', received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tx_confirmation ON transactions(confirmation,updated_at);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, signature TEXT NOT NULL, token_mint TEXT, pool_address TEXT, wallet TEXT, event_type TEXT NOT NULL, slot INTEGER NOT NULL, event_time INTEGER, received_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_token_time ON events(token_mint,event_time);
      CREATE INDEX IF NOT EXISTS events_wallet ON events(wallet,slot);
      CREATE INDEX IF NOT EXISTS events_signature ON events(signature);
      CREATE TABLE IF NOT EXISTS tokens(mint TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, created_at INTEGER, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pools(address TEXT PRIMARY KEY, token_mint TEXT, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_state(program_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints(program_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gaps(id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, resolved_at INTEGER, code TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gaps_time ON gaps(created_at);
      CREATE TABLE IF NOT EXISTS errors(id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, code TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security(mint TEXT PRIMARY KEY, checked_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS market_observations(id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operational_metrics(id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, payload TEXT NOT NULL);`);
    // Additive migration. Existing raw/canonical SQLite evidence is never rewritten.
    installRadarRollups(this.db);
    // Local additive evolution: preserve every distinct raw log payload on restart.
    if (
      !this.db
        .prepare("PRAGMA table_info(selected_log_messages)")
        .all()
        .some((c) => c.name === "source_message_sha256")
    ) {
      this.atomic(() => {
        const old = this.db
          .prepare("SELECT * FROM selected_log_messages")
          .all();
        this.db.exec(
          "ALTER TABLE selected_log_messages RENAME TO selected_log_messages_v1; CREATE TABLE selected_log_messages(signature TEXT NOT NULL,source_message_sha256 TEXT NOT NULL,received_at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(signature,source_message_sha256));",
        );
        const insert = this.db.prepare(
          "INSERT INTO selected_log_messages VALUES(?,?,?,?)",
        );
        for (const row of old) {
          const raw = parse(row);
          const hash = createHash("sha256")
            .update(JSON.stringify(raw.logs))
            .digest("hex");
          insert.run(row.signature, hash, row.received_at, row.payload);
        }
        this.db.exec("DROP TABLE selected_log_messages_v1");
      });
    }
    // Any previously interrupted work remains replayable from durable inbox.
    this.db.exec("UPDATE inbox SET status='PENDING' WHERE status='PROCESSING'");
  }
  atomic(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  checkBudget() {
    if (this.storageBytes() >= this.maxBytes)
      throw Error("STORAGE_BUDGET_EXCEEDED");
  }
  receiveBatch(items) {
    this.checkBudget();
    return this.atomic(() => {
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO inbox(signature,slot,received_at,payload) VALUES(?,?,?,?)",
      );
      let count = 0;
      for (const item of items) {
        if (!item.signature || !Number.isSafeInteger(item.slot))
          throw Error("INVALID_OBSERVATION");
        if (item.contextPriority !== undefined &&
            ![0, 1, 2, 3].includes(item.contextPriority))
          throw Error("INVALID_CONTEXT_PRIORITY");
        count += Number(
          insert.run(
            item.signature,
            item.slot,
            Date.parse(item.receivedAt) || Date.now(),
            json(item),
          ).changes,
        );
      }
      return count;
    });
  }
  persistLogBatch(items, { maxRows = 25000 } = {}) {
    this.checkBudget();
    return this.atomic(() => {
      let count = 0;
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO event_observations VALUES(?,?,?,?,?,?,?)",
      );
      for (const { notification, observations } of items) {
        if (!observations.length) continue;
        if (
          !notification.signature ||
          !Number.isSafeInteger(notification.slot) ||
          !Array.isArray(notification.logs) ||
          !Number.isFinite(Date.parse(notification.receivedAt))
        )
          throw Error("INVALID_LOG_NOTIFICATION");
        const sourceHash = createHash("sha256")
          .update(JSON.stringify(notification.logs))
          .digest("hex");
        const rawPrior = parse(
          this.db
            .prepare(
              "SELECT payload FROM selected_log_messages WHERE signature=? AND source_message_sha256=?",
            )
            .get(notification.signature, sourceHash),
        );
        if (
          !rawPrior ||
          CONFIRMATIONS.indexOf(notification.confirmationStatus) >
            CONFIRMATIONS.indexOf(rawPrior.confirmationStatus)
        )
          this.db
            .prepare(
              "INSERT OR REPLACE INTO selected_log_messages VALUES(?,?,?,?)",
            )
            .run(
              notification.signature,
              sourceHash,
              Date.parse(notification.receivedAt),
              json(notification),
            );
        for (const e of observations) {
          if (
            !/^[0-9a-f]{64}$/.test(e.id ?? "") ||
            !Number.isFinite(Date.parse(e.receivedAt)) ||
            Date.parse(e.receivedAt) !== Date.parse(notification.receivedAt) ||
            e.chain !== "solana" ||
            e.schemaVersion !== 1 ||
            !CONFIRMATIONS.includes(e.confirmationStatus)
          )
            throw Error("INVALID_LOG_OBSERVATION");
          for (const key of ["amountTokenRaw", "amountQuoteRaw"])
            if (
              e[key] !== null &&
              (typeof e[key] !== "string" || !/^\d+$/.test(e[key]))
            )
              throw Error("INVALID_LOG_OBSERVATION_RAW_AMOUNT");
          if (
            e.transactionSignature !== notification.signature ||
            e.slot !== notification.slot ||
            e.evidenceSource?.sourceMessageSha256 !== sourceHash
          )
            throw Error("LOG_OBSERVATION_IDENTITY_MISMATCH");
          const prior = parse(
            this.db
              .prepare("SELECT payload FROM event_observations WHERE id=?")
              .get(e.id),
          );
          if (prior) {
            if (
              CONFIRMATIONS.indexOf(e.confirmationStatus) >
              CONFIRMATIONS.indexOf(prior.confirmationStatus)
            )
              this.db
                .prepare("UPDATE event_observations SET payload=? WHERE id=?")
                .run(
                  json({ ...prior, confirmationStatus: e.confirmationStatus }),
                  e.id,
                );
          } else
            count += Number(
              insert.run(
                e.id,
                e.transactionSignature,
                e.tokenMint,
                e.poolAddress,
                e.wallet,
                Date.parse(e.receivedAt),
                json(e),
              ).changes,
            );
        }
        // Must be within this batch's BEGIN IMMEDIATE/COMMIT boundary.
        // A stale duplicate can be reinserted into the bounded raw table,
        // but its retained seen-ID never increments the rollup twice.
        recordRadarRollup(this.db, e);
      }
      pruneRadarRollups(this.db);
      const excess =
        Number(
          this.db.prepare("SELECT COUNT(*) n FROM event_observations").get().n,
        ) - maxRows;
      if (excess > 0) {
        this.logObservationRowsPruned =
          (this.logObservationRowsPruned ?? 0) + excess;
        this.db
          .prepare(
            "DELETE FROM event_observations WHERE id IN (SELECT id FROM event_observations ORDER BY received_at LIMIT ?)",
          )
          .run(excess);
        this.db.exec(
          "DELETE FROM selected_log_messages WHERE NOT EXISTS (SELECT 1 FROM event_observations e WHERE e.signature=selected_log_messages.signature AND json_extract(e.payload,'$.evidenceSource.sourceMessageSha256')=selected_log_messages.source_message_sha256)",
        );
      }
      return count;
    });
  }
  // Close only stale, *unclaimed* live-log enrichment in the durable queue.
  // Observations in event_observations are independent and remain untouched.
  // Recovery entries or actively-processing rows are never modified.
  expireStaleLogContext({ maxAgeMs, now = Date.now(), signature = null } = {}) {
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 3600000 ||
        !Number.isFinite(now) ||
        (signature !== null && (typeof signature !== "string" || !signature)))
      throw Error("INVALID_CONTEXT_EXPIRY");
    const base = "UPDATE inbox SET status='EXPIRED' WHERE status IN ('PENDING','UNAVAILABLE')" +
      " AND received_at < ? AND json_extract(payload,'$.evidenceSource')='rpc:logsSubscribe'";
    const stmt = signature === null ? base : base + " AND signature=?";
    return Number(this.db.prepare(stmt).run(
      now - maxAgeMs, ...(signature === null ? [] : [signature]),
    ).changes);
  }
  radarRollups({ now = Date.now() } = {}) {
    return readRadarRollups(this.db, { now });
  }
  // Bounded read-only slice for the MVP radar. Uses receivedAt, not an
  // inferred on-chain timestamp; never claims full history or global volume.
  radarObservations({ limit = 10000, now = Date.now() } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 ||
        !Number.isFinite(now)) throw Error("INVALID_RADAR_QUERY");
    return this.db.prepare(
      "SELECT payload FROM event_observations WHERE received_at BETWEEN ? AND ? ORDER BY received_at DESC,id LIMIT ?",
    ).all(now - 300000, now + 15000, limit).map(parse);
  }
  observations({ mint, wallet, poolAddress, signature, limit = 100 } = {}) {
    let where = "1=1",
      args = [];
    for (const [column, value] of [
      ["token_mint", mint],
      ["wallet", wallet],
      ["pool_address", poolAddress],
      ["signature", signature],
    ])
      if (value) {
        where += ` AND ${column}=?`;
        args.push(value);
      }
    return this.db
      .prepare(
        `SELECT payload FROM event_observations WHERE ${where} ORDER BY received_at DESC,id LIMIT ?`,
      )
      .all(...args, Math.min(1000, Math.max(1, limit)))
      .map((row) => {
        const e = parse(row),
          tx = this.transaction(e.transactionSignature);
        const mismatch = !!tx && tx.slot !== e.slot;
        return {
          ...e,
          contextEnrichmentAvailable: !!tx,
          contextSlotMismatch: mismatch,
          ...(tx
            ? {
                confirmationStatus:
                  !mismatch &&
                  CONFIRMATIONS.indexOf(tx.confirmation) >
                    CONFIRMATIONS.indexOf(e.confirmationStatus)
                    ? tx.confirmation
                    : e.confirmationStatus,
                reconciliationStatus: mismatch
                  ? "UNRESOLVED"
                  : tx.reconciliation,
              }
            : {}),
        };
      });
  }
  // Uses JSON stored in the existing durable inbox payload to avoid changing
  // the on-disk schema. Old/unprioritized rows default to exploratory P3.
  // Inbox is capped by admission; this query remains bounded per rank.
  pendingByPriority(priority, limit = 50, now = Date.now()) {
    if (![0, 1, 2, 3].includes(priority) ||
        !Number.isSafeInteger(limit) || limit < 0 || limit > 1000)
      throw Error("INVALID_CONTEXT_PRIORITY_QUERY");
    if (limit === 0) return [];
    return this.db.prepare(
      "SELECT * FROM inbox WHERE status IN ('PENDING','UNAVAILABLE') AND next_at<=? AND COALESCE(json_extract(payload,'$.contextPriority'),3)=? ORDER BY received_at,signature LIMIT ?",
    ).all(now, priority, limit).map(row => ({ ...parse(row), attempts: row.attempts }));
  }
  pending(limit = 100, now = Date.now()) {
    return this.db
      .prepare(
        "SELECT * FROM inbox WHERE status IN ('PENDING','UNAVAILABLE') AND next_at<=? ORDER BY received_at,signature LIMIT ?",
      )
      .all(now, limit)
      .map((r) => ({ ...parse(r), attempts: r.attempts }));
  }
  claim(signature) {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE inbox SET status='PROCESSING' WHERE signature=? AND status IN ('PENDING','UNAVAILABLE') AND next_at<=?",
          )
          .run(signature, Date.now()).changes,
      ) === 1
    );
  }
  retry(signature, code, { delayMs = 5000, maxAttempts = 8 } = {}) {
    this.atomic(() => {
      const row = this.db
        .prepare("SELECT attempts,payload FROM inbox WHERE signature=?")
        .get(signature);
      if (!row) return;
      const attempts = row.attempts + 1,
        failed = attempts >= maxAttempts;
      this.db
        .prepare(
          "UPDATE inbox SET status=?,attempts=?,next_at=? WHERE signature=?",
        )
        .run(
          failed ? "UNAVAILABLE" : "PENDING",
          attempts,
          Date.now() +
            (failed
              ? Math.max(60000, delayMs) *
                Math.min(
                  60,
                  2 ** Math.floor((attempts - maxAttempts) / maxAttempts),
                )
              : delayMs),
          signature,
        );
      if (failed && attempts % maxAttempts === 0)
        this.gap("TRANSACTION_UNAVAILABLE", {
          signature,
          code,
          observation: parse(row),
        });
    });
  }
  persistTransaction(observation, transaction, events, diagnostics = []) {
    this.checkBudget();
    return this.atomic(() => {
      const now = Date.now(),
        signature = observation.signature;
      const prior = this.db
        .prepare("SELECT * FROM transactions WHERE signature=?")
        .get(signature);
      const confirmation =
        CONFIRMATIONS[
          Math.max(
            CONFIRMATIONS.indexOf(prior?.confirmation),
            CONFIRMATIONS.indexOf(
              observation.confirmationStatus ?? "confirmed",
            ),
          )
        ];
      if (prior && prior.slot !== transaction.slot) {
        const oldRaw = this.db
          .prepare("SELECT payload FROM raw_transactions WHERE signature=?")
          .get(signature);
        if (oldRaw)
          this.db
            .prepare(
              "INSERT OR REPLACE INTO raw_transaction_revisions VALUES(?,?,?,?)",
            )
            .run(signature, prior.slot, now, oldRaw.payload);
        for (const row of this.db
          .prepare("SELECT id,payload FROM events WHERE signature=?")
          .all(signature)) {
          const old = parse(row);
          this.db
            .prepare("UPDATE events SET payload=? WHERE id=?")
            .run(json({ ...old, reconciliationStatus: "REVERTED" }), row.id);
        }
        this.gap("TRANSACTION_REEXECUTED", {
          signature,
          previousSlot: prior.slot,
          slot: transaction.slot,
        });
      }
      this.db
        .prepare("INSERT OR REPLACE INTO raw_transactions VALUES(?,?,?)")
        .run(signature, now, json(transaction));
      this.db
        .prepare(
          "INSERT INTO transactions(signature,slot,confirmation,received_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(signature) DO UPDATE SET slot=excluded.slot,confirmation=excluded.confirmation,reconciliation='ACTIVE',updated_at=excluded.updated_at",
        )
        .run(
          signature,
          transaction.slot,
          confirmation,
          Date.parse(observation.receivedAt),
          now,
        );
      for (const input of events) {
        const e = canonicalEvent({
          ...input,
          transactionSignature: signature,
          confirmationStatus: confirmation,
          receivedAt: observation.receivedAt,
          processedAt: new Date(now).toISOString(),
        });
        this.db
          .prepare(
            "INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET signature=excluded.signature,token_mint=excluded.token_mint,pool_address=excluded.pool_address,wallet=excluded.wallet,event_type=excluded.event_type,slot=excluded.slot,event_time=excluded.event_time,received_at=excluded.received_at,payload=excluded.payload",
          )
          .run(
            e.id,
            signature,
            e.tokenMint,
            e.poolAddress,
            e.wallet,
            e.eventType,
            e.slot,
            e.eventTimestamp ? Date.parse(e.eventTimestamp) : null,
            Date.parse(e.receivedAt),
            json(e),
          );
        if (e.tokenMint) {
          this.db
            .prepare(
              "INSERT INTO tokens VALUES(?,?,?,?) ON CONFLICT(mint) DO UPDATE SET created_at=COALESCE(tokens.created_at,excluded.created_at)",
            )
            .run(
              e.tokenMint,
              Date.parse(e.receivedAt),
              e.eventType === "TOKEN_CREATED" && e.eventTimestamp
                ? Date.parse(e.eventTimestamp)
                : null,
              json({
                mint: e.tokenMint,
                creator: e.creator,
                firstEvidence: e.id,
              }),
            );
        }
        if (e.poolAddress)
          this.db
            .prepare(
              "INSERT INTO pools VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET token_mint=COALESCE(pools.token_mint,excluded.token_mint),payload=excluded.payload",
            )
            .run(e.poolAddress, e.tokenMint, json(e));
      }
      for (const d of diagnostics)
        this.error(d.code ?? "DECODER_DIAGNOSTIC", { signature, ...d });
      this.db
        .prepare("UPDATE inbox SET status='DONE' WHERE signature=?")
        .run(signature);
      this.db
        .prepare(
          "UPDATE gaps SET resolved_at=? WHERE code='TRANSACTION_UNAVAILABLE' AND resolved_at IS NULL AND json_extract(payload,'$.signature')=?",
        )
        .run(now, signature);
      this.db
        .prepare(
          "UPDATE gaps SET resolved_at=? WHERE code='HISTORY_TRANSACTION_HOLES' AND resolved_at IS NULL AND NOT EXISTS (SELECT 1 FROM json_each(gaps.payload,'$.signatures') h LEFT JOIN inbox i ON i.signature=h.value WHERE i.signature IS NULL OR i.status NOT IN ('DONE','FAILED'))",
        )
        .run(now);
      return events.length;
    });
  }
  completeFailed(observation, error, transaction = null) {
    this.atomic(() => {
      const stage =
        observation.confirmationStatus === "finalized"
          ? "finalized"
          : "confirmed";
      const now = Date.now();
      this.db
        .prepare("UPDATE inbox SET status='FAILED' WHERE signature=?")
        .run(observation.signature);
      this.db
        .prepare(
          "INSERT INTO transactions(signature,slot,confirmation,reconciliation,received_at,updated_at) VALUES(?,?,?,'FAILED',?,?) ON CONFLICT(signature) DO UPDATE SET slot=excluded.slot,confirmation=excluded.confirmation,reconciliation='FAILED',updated_at=excluded.updated_at",
        )
        .run(
          observation.signature,
          transaction?.slot ?? observation.slot,
          stage,
          Date.parse(observation.receivedAt),
          now,
        );
      if (transaction)
        this.db
          .prepare("INSERT OR REPLACE INTO raw_transactions VALUES(?,?,?)")
          .run(observation.signature, now, json(transaction));
      this.error("ONCHAIN_TRANSACTION_FAILED", {
        signature: observation.signature,
        error,
        confirmationStatus: stage,
      });
    });
  }
  evidence(signature) {
    return {
      transactionSignature: signature,
      rawTransaction: parse(
        this.db
          .prepare("SELECT payload FROM raw_transactions WHERE signature=?")
          .get(signature),
      ),
      logMessages: this.db
        .prepare(
          "SELECT source_message_sha256,payload FROM selected_log_messages WHERE signature=?",
        )
        .all(signature)
        .map((row) => ({
          sourceMessageSha256: row.source_message_sha256,
          notification: parse(row),
        })),
      revisions: this.db
        .prepare(
          "SELECT slot,payload FROM raw_transaction_revisions WHERE signature=? ORDER BY slot",
        )
        .all(signature)
        .map((row) => ({ slot: row.slot, transaction: parse(row) })),
      receipt: parse(
        this.db
          .prepare("SELECT payload FROM inbox WHERE signature=?")
          .get(signature),
      ),
    };
  }
  transaction(signature) {
    return this.db
      .prepare("SELECT * FROM transactions WHERE signature=?")
      .get(signature);
  }
  isDone(signature) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM inbox WHERE signature=? AND status IN ('DONE','FAILED')",
      )
      .get(signature);
  }
  isSettled(signature) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM inbox WHERE signature=? AND status IN ('DONE','FAILED','UNAVAILABLE')",
      )
      .get(signature);
  }
  recoveryState(programId) {
    return parse(
      this.db
        .prepare("SELECT payload FROM recovery_state WHERE program_id=?")
        .get(programId),
    );
  }
  saveRecoveryState(programId, value) {
    this.db
      .prepare("INSERT OR REPLACE INTO recovery_state VALUES(?,?)")
      .run(programId, json(value));
  }
  clearRecoveryState(programId) {
    this.db
      .prepare("DELETE FROM recovery_state WHERE program_id=?")
      .run(programId);
  }
  checkpoint(programId) {
    return parse(
      this.db
        .prepare("SELECT payload FROM checkpoints WHERE program_id=?")
        .get(programId),
    );
  }
  advanceCheckpoint(programId, checkpoint, requiredSignatures = []) {
    this.atomic(() => {
      if (requiredSignatures.some((s) => !this.isSettled(s)))
        throw Error("CHECKPOINT_BEFORE_PERSISTENCE");
      this.db
        .prepare("INSERT OR REPLACE INTO checkpoints VALUES(?,?,?)")
        .run(programId, Date.now(), json(checkpoint));
      this.db
        .prepare("DELETE FROM recovery_state WHERE program_id=?")
        .run(programId);
      if (
        checkpoint.continuity === "RPC_ANCHOR_REACHED" ||
        checkpoint.anchorReached === true
      )
        this.db
          .prepare(
            "UPDATE gaps SET resolved_at=? WHERE code='HISTORY_RECOVERY_PENDING' AND resolved_at IS NULL AND json_extract(payload,'$.programId')=?",
          )
          .run(Date.now(), programId);
    });
  }
  nonFinalized(limit = 256) {
    return this.db
      .prepare(
        "SELECT * FROM transactions WHERE confirmation!='finalized' OR reconciliation='UNRESOLVED' ORDER BY updated_at LIMIT ?",
      )
      .all(limit);
  }
  reconcile(signature, status) {
    this.atomic(() => {
      const tx = this.transaction(signature);
      if (!tx) return;
      const slotInvalid =
        status?.slot !== undefined &&
        (!Number.isSafeInteger(status.slot) || status.slot < 0);
      const mismatch =
        Number.isSafeInteger(status?.slot) && status.slot !== tx.slot;
      const stage = status?.confirmationStatus;
      const validStage = CONFIRMATIONS.includes(stage),
        weaker =
          validStage &&
          CONFIRMATIONS.indexOf(stage) < CONFIRMATIONS.indexOf(tx.confirmation);
      if (
        tx.confirmation === "finalized" &&
        (!validStage || weaker) &&
        !mismatch &&
        !slotInvalid
      ) {
        this.gap("FINALITY_WEAKER_SOURCE_IGNORED", { signature, status });
        return;
      }
      const next =
        slotInvalid || mismatch || !validStage || weaker
          ? "UNRESOLVED"
          : status.err
            ? "REVERTED"
            : "ACTIVE";
      let confirmation =
        validStage && !weaker && !slotInvalid && !mismatch
          ? stage
          : tx.confirmation;
      if (mismatch)
        this.gap("FINALITY_SLOT_MISMATCH", {
          signature,
          observedSlot: tx.slot,
          statusSlot: status.slot,
        });
      const inbox = this.db
        .prepare("SELECT status,payload FROM inbox WHERE signature=?")
        .get(signature);
      const retryExecution =
        validStage &&
        !weaker &&
        !slotInvalid &&
        status.err === null &&
        (mismatch ||
          inbox?.status === "FAILED" ||
          tx.reconciliation === "REVERTED" ||
          tx.reconciliation === "FAILED");
      const reconciliation = retryExecution ? "UNRESOLVED" : next;
      this.db
        .prepare(
          "UPDATE transactions SET confirmation=?,reconciliation=?,updated_at=? WHERE signature=?",
        )
        .run(confirmation, reconciliation, Date.now(), signature);
      if (retryExecution && inbox) {
        const before = parse(inbox);
        this.db
          .prepare(
            "UPDATE inbox SET slot=?,status='PENDING',attempts=0,next_at=0,payload=? WHERE signature=?",
          )
          .run(
            status.slot ?? tx.slot,
            json({
              ...before,
              slot: status.slot ?? tx.slot,
              onchainError: null,
              confirmationStatus: stage,
              priorObservationSlot: before.slot,
            }),
            signature,
          );
      }
      for (const row of this.db
        .prepare("SELECT id,payload FROM events WHERE signature=?")
        .all(signature))
        this.db.prepare("UPDATE events SET payload=? WHERE id=?").run(
          json({
            ...parse(row),
            confirmationStatus: confirmation,
            reconciliationStatus: reconciliation,
          }),
          row.id,
        );
      if (reconciliation !== "ACTIVE")
        this.gap("FINALITY_" + reconciliation, { signature, status });
    });
  }
  gap(code, payload) {
    this.db
      .prepare("INSERT INTO gaps(created_at,code,payload) VALUES(?,?,?)")
      .run(Date.now(), code, json(payload));
  }
  error(code, payload) {
    this.db
      .prepare("INSERT INTO errors(created_at,code,payload) VALUES(?,?,?)")
      .run(Date.now(), code, json(payload));
  }
  security(mint, value) {
    this.db
      .prepare("INSERT OR REPLACE INTO security VALUES(?,?,?)")
      .run(mint, Date.now(), json(value));
  }
  nextSecurityMint() {
    return (
      this.db
        .prepare(
          "SELECT t.mint FROM tokens t LEFT JOIN security s ON s.mint=t.mint WHERE s.mint IS NULL ORDER BY t.first_seen DESC LIMIT 1",
        )
        .get()?.mint ?? null
    );
  }
  getSecurity(mint) {
    return parse(
      this.db.prepare("SELECT payload FROM security WHERE mint=?").get(mint),
    );
  }
  recordMetrics(value) {
    this.db
      .prepare(
        "INSERT INTO operational_metrics(created_at,payload) VALUES(?,?)",
      )
      .run(Date.now(), json(value));
  }
  recordMarket(value) {
    this.db
      .prepare(
        "INSERT INTO market_observations(created_at,payload) VALUES(?,?)",
      )
      .run(Date.now(), json(value));
  }
  events({ mint, wallet, signature, since = 0, limit = 1000 } = {}) {
    let where = "received_at>=?",
      args = [since];
    for (const [column, value] of [
      ["token_mint", mint],
      ["wallet", wallet],
      ["signature", signature],
    ])
      if (value) {
        where += ` AND ${column}=?`;
        args.push(value);
      }
    return this.db
      .prepare(
        `SELECT payload FROM events WHERE ${where} ORDER BY slot DESC,id DESC LIMIT ?`,
      )
      .all(...args, Math.min(10000, Math.max(1, limit)))
      .map(parse);
  }
  tokens(limit = 100) {
    return this.db
      .prepare("SELECT * FROM tokens ORDER BY first_seen DESC LIMIT ?")
      .all(limit)
      .map((r) => {
        const base = parse(r);
        const creation = this.db
          .prepare(
            "SELECT payload FROM events WHERE token_mint=? AND event_type='TOKEN_CREATED' ORDER BY slot LIMIT 1",
          )
          .get(r.mint);
        const proof = parse(creation),
          active =
            proof && (proof.reconciliationStatus ?? "ACTIVE") === "ACTIVE";
        return {
          ...base,
          creator: active ? proof.creator : null,
          firstSeenAt: new Date(r.first_seen).toISOString(),
          createdAt: active ? proof.eventTimestamp : null,
          confirmationStatus: proof?.confirmationStatus ?? null,
          reconciliationStatus: proof?.reconciliationStatus ?? "UNKNOWN",
          creationEvidenceRetained: !!proof,
        };
      });
  }
  gaps(limit = 100) {
    return this.db
      .prepare("SELECT * FROM gaps ORDER BY id DESC LIMIT ?")
      .all(limit)
      .map((r) => ({ ...r, payload: parse(r) }));
  }
  stats() {
    return Object.fromEntries(
      [
        "inbox",
        "events",
        "event_observations",
        "tokens",
        "pools",
        "gaps",
        "errors",
        "raw_transactions",
      ]
        .map((t) => [
          t,
          Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n),
        ])
        .concat([
          [
            "pending",
            Number(
              this.db
                .prepare(
                  "SELECT COUNT(*) AS n FROM inbox WHERE status IN ('PENDING','PROCESSING')",
                )
                .get().n,
            ),
          ],
          [
            "deferred",
            Number(
              this.db
                .prepare(
                  "SELECT COUNT(*) n FROM inbox WHERE status='UNAVAILABLE'",
                )
                .get().n,
            ),
          ],
          ["storageBytes", this.storageBytes()],
        ]),
    );
  }
  storageBytes() {
    if (this.path === ":memory:")
      return (
        Number(this.db.prepare("PRAGMA page_count").get().page_count) * 4096
      );
    return ["", "-wal", "-shm"].reduce((n, s) => {
      try {
        return n + statSync(this.path + s).size;
      } catch {
        return n;
      }
    }, 0);
  }
  retain(now = Date.now()) {
    this.atomic(() => {
      this.db
        .prepare("DELETE FROM raw_transactions WHERE retained_at<?")
        .run(now - this.rawRetentionHours * 3600000);
      this.db
        .prepare("DELETE FROM event_observations WHERE received_at<?")
        .run(now - this.rawRetentionHours * 3600000);
      this.db.exec(
        "DELETE FROM selected_log_messages WHERE NOT EXISTS (SELECT 1 FROM event_observations e WHERE e.signature=selected_log_messages.signature AND json_extract(e.payload,'$.evidenceSource.sourceMessageSha256')=selected_log_messages.source_message_sha256)",
      );
      this.db
        .prepare("DELETE FROM raw_transaction_revisions WHERE retained_at<?")
        .run(now - this.rawRetentionHours * 3600000);
      const cut = now - this.eventRetentionDays * 86400000;
      for (const t of ["events", "inbox"])
        this.db
          .prepare(
            `DELETE FROM ${t} WHERE received_at<? ${t === "inbox" ? "AND status NOT IN ('PENDING','PROCESSING','UNAVAILABLE')" : ""}`,
          )
          .run(cut);
      this.db
        .prepare(
          "DELETE FROM transactions WHERE updated_at<? AND signature NOT IN (SELECT signature FROM inbox)",
        )
        .run(cut);
      for (const t of ["operational_metrics", "market_observations", "errors"])
        this.db.prepare(`DELETE FROM ${t} WHERE created_at<?`).run(cut);
      // Coverage records and token/pool catalog are capped separately; pruning is explicit.
      const catalogs = this.db.prepare("SELECT COUNT(*) n FROM tokens").get().n;
      if (catalogs > 50000) {
        this.gap("CATALOG_RETENTION", { removed: catalogs - 50000 });
        this.db
          .prepare(
            "DELETE FROM tokens WHERE mint NOT IN (SELECT mint FROM tokens ORDER BY first_seen DESC LIMIT 50000)",
          )
          .run();
      }
      this.db
        .prepare(
          "DELETE FROM pools WHERE address NOT IN (SELECT address FROM pools ORDER BY rowid DESC LIMIT 50000)",
        )
        .run();
      this.db.exec(
        "DELETE FROM gaps WHERE id NOT IN (SELECT id FROM gaps ORDER BY id DESC LIMIT 10000)",
      );
    });
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (
      this.path !== ":memory:" &&
      this.storageBytes() > this.maxBytes * 0.8 &&
      Number(this.db.prepare("PRAGMA freelist_count").get().freelist_count) > 0
    )
      this.db.exec("VACUUM");
    this.checkBudget();
  }
  close() {
    this.db.close();
  }
}
