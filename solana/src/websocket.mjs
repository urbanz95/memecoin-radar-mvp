import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";

/** One connection, one independent mentions subscription per configured program. */
export class LogSocket {
  constructor({
    url = "wss://api.mainnet-beta.solana.com",
    programs,
    commitment = "confirmed",
    onLog = () => {},
    onConnect = () => {},
    onDisconnect = () => {},
    metrics,
    WebSocketImpl = WebSocket,
    agent,
    reconnectBaseMs = 500,
    reconnectMaxMs = 30000,
    idleTimeoutMs = 60000,
    ackTimeoutMs = 15000,
    heartbeatMs = 15000,
    random = Math.random,
    now = Date.now,
  } = {}) {
    if (!["ws:", "wss:"].includes(new URL(url).protocol))
      throw Error("INVALID_WEBSOCKET_URL");
    if (!["processed", "confirmed", "finalized"].includes(commitment))
      throw Error("INVALID_COMMITMENT");
    const ids = [
      ...new Set(
        (programs ?? []).map((p) =>
          typeof p === "string" ? p : (p.programId ?? p.id),
        ),
      ),
    ];
    if (
      !ids.length ||
      ids.some((id) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id))
    )
      throw Error("INVALID_PROGRAM_SUBSCRIPTIONS");
    Object.assign(this, {
      url,
      programs: ids,
      commitment,
      onLog,
      onConnect,
      onDisconnect,
      metrics,
      WebSocketImpl,
      reconnectBaseMs,
      reconnectMaxMs,
      idleTimeoutMs,
      ackTimeoutMs,
      heartbeatMs,
      random,
      now,
    });
    const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
    this.agent =
      agent ??
      (WebSocketImpl === WebSocket && proxy
        ? new HttpsProxyAgent(proxy)
        : undefined);
    this.stopped = true;
    this.attempt = 0;
    this.requestId = 0;
    this.everConnected = false;
    this.generation = 0;
    this.metrics?.set("websocket_connected", false);
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  connect() {
    if (this.stopped) return;
    const generation = ++this.generation;
    let socket;
    try {
      socket = new this.WebSocketImpl(this.url, {
        agent: this.agent,
        handshakeTimeout: this.ackTimeoutMs,
        maxPayload: 2 * 1024 * 1024,
      });
    } catch {
      this.disconnected("CONNECT_FAILED", generation);
      return;
    }
    this.socket = socket;
    this.pending = new Map();
    this.subscriptions = new Map();
    this.lastFrameAt = this.now();
    this.awaitingPongAt = null;
    this.ready = false;
    const current = () => !this.stopped && this.generation === generation;
    this.ackTimer = setTimeout(() => {
      if (current() && !this.ready) this.reconnect("SUBSCRIPTION_TIMEOUT");
    }, this.ackTimeoutMs);
    socket.on("open", () => {
      if (!current()) return;
      for (const programId of this.programs) {
        const id = ++this.requestId;
        this.pending.set(id, programId);
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "logsSubscribe",
            params: [
              { mentions: [programId] },
              { commitment: this.commitment },
            ],
          }),
        );
      }
      this.heartbeat = setInterval(() => {
        if (!current()) return;
        const now = this.now();
        if (
          this.awaitingPongAt !== null &&
          now - this.awaitingPongAt > this.idleTimeoutMs
        ) {
          this.reconnect("HEARTBEAT_TIMEOUT");
          return;
        }
        if (now - this.lastFrameAt > this.idleTimeoutMs) {
          this.reconnect("IDLE_TIMEOUT");
          return;
        }
        if (this.awaitingPongAt === null) {
          this.awaitingPongAt = now;
          socket.ping();
        }
      }, this.heartbeatMs);
      this.heartbeat.unref?.();
    });
    socket.on("pong", () => {
      if (current()) {
        this.lastFrameAt = this.now();
        this.awaitingPongAt = null;
      }
    });
    socket.on("message", (bytes) => {
      if (!current()) return;
      this.lastFrameAt = this.now();
      let message;
      try {
        message = JSON.parse(bytes.toString());
      } catch {
        this.metrics?.inc("websocket_invalid_messages");
        this.reconnect("INVALID_JSON");
        return;
      }
      if (Object.hasOwn(message, "id")) {
        const programId = this.pending.get(message.id);
        if (!programId) return;
        if (message.error || !Number.isSafeInteger(message.result)) {
          this.metrics?.inc("subscription_errors");
          this.reconnect("SUBSCRIPTION_REJECTED");
          return;
        }
        this.pending.delete(message.id);
        this.subscriptions.set(message.result, programId);
        if (!this.pending.size && !this.ready) {
          clearTimeout(this.ackTimer);
          this.ready = true;
          this.attempt = 0;
          this.everConnected = true;
          this.metrics?.set("websocket_connected", true);
          this.metrics?.set(
            "websocket_connected_at",
            new Date(this.now()).toISOString(),
          );
          this.invoke(this.onConnect, {
            programs: [...this.programs],
            commitment: this.commitment,
          });
        }
        return;
      }
      if (message.method !== "logsNotification") return;
      const programId = this.subscriptions.get(message.params?.subscription);
      const result = message.params?.result;
      const value = result?.value;
      const slot = result?.context?.slot;
      if (
        !programId ||
        !value ||
        !Number.isSafeInteger(slot) ||
        typeof value.signature !== "string" ||
        !Array.isArray(value.logs)
      ) {
        this.metrics?.inc("websocket_invalid_messages");
        this.reconnect("INVALID_NOTIFICATION");
        return;
      }
      const receivedAt = new Date(this.now()).toISOString();
      this.metrics?.inc("log_notifications");
      this.metrics?.set("last_event_received", receivedAt);
      this.metrics?.set("current_slot", slot);
      try {
        const accepted = this.onLog({
          programId,
          signature: value.signature,
          slot,
          logs: value.logs,
          err: value.err,
          receivedAt,
          confirmationStatus: this.commitment,
        });
        if (accepted === false) this.reconnect("BACKPRESSURE");
        else if (accepted?.catch)
          accepted.catch(() => {
            this.metrics?.inc("websocket_callback_errors");
            this.reconnect("HANDLER_FAILURE");
          });
      } catch {
        this.metrics?.inc("websocket_callback_errors");
        this.reconnect("HANDLER_FAILURE");
      }
    });
    socket.on("error", () => {
      if (current()) this.reconnect("TRANSPORT_ERROR");
    });
    socket.on("close", () => {
      if (current()) this.disconnected("SOCKET_CLOSED", generation);
    });
  }
  invoke(callback, value) {
    try {
      const result = callback(value);
      result?.catch?.(() => this.metrics?.inc("websocket_callback_errors"));
    } catch {
      this.metrics?.inc("websocket_callback_errors");
    }
  }
  disconnected(reason, generation) {
    if (this.stopped || this.generation !== generation) return;
    this.generation++;
    clearTimeout(this.ackTimer);
    clearInterval(this.heartbeat);
    this.ready = false;
    this.metrics?.set("websocket_connected", false);
    this.metrics?.set(
      "websocket_disconnected_at",
      new Date(this.now()).toISOString(),
    );
    this.metrics?.inc("websocket_disconnects");
    this.invoke(this.onDisconnect, {
      reason,
      receivedAt: new Date(this.now()).toISOString(),
    });
    this.schedule();
  }
  schedule() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const ms =
      Math.min(
        this.reconnectMaxMs,
        this.reconnectBaseMs * 2 ** Math.min(this.attempt++, 16),
      ) *
      (0.5 + this.random() * 0.5);
    this.metrics?.inc("reconnect_count");
    this.metrics?.set("reconnect_delay_ms", ms);
    this.reconnectTimer = setTimeout(() => this.connect(), ms);
  }
  reconnect(reason = "REQUESTED") {
    if (this.stopped) return;
    const socket = this.socket;
    this.disconnected(reason, this.generation);
    socket?.terminate();
  }
  stop() {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.ackTimer);
    clearInterval(this.heartbeat);
    this.metrics?.set("websocket_connected", false);
    this.socket?.terminate();
  }
}
