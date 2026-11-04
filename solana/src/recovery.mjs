/** Bounded address history, continuing older pages across ticks without abandoning a reachable anchor. */
export async function recoverProgram({
  rpc,
  store,
  programId,
  processObservation,
  metrics,
  maxPages = 5,
  pageSize = 100,
  now = Date.now,
}) {
  const previous = store.checkpoint(programId),
    continuation = store.recoveryState(programId);
  let before = continuation?.before,
    head = continuation?.head,
    reached = false,
    exhausted = false,
    pages = 0;
  const rows = [],
    seen = new Set();
  try {
    while (pages < maxPages) {
      const page = await rpc.request("getSignaturesForAddress", [
        programId,
        {
          limit: pageSize,
          commitment: "confirmed",
          ...(before ? { before } : {}),
        },
      ]);
      pages++;
      if (!Array.isArray(page)) throw Error("INVALID_HISTORY_PAGE");
      if (!head) head = page[0] ?? null;
      for (const item of page) {
        if (item.signature === previous?.signature) {
          reached = true;
          break;
        }
        if (!seen.has(item.signature)) {
          rows.push(item);
          seen.add(item.signature);
        }
      }
      exhausted = !page.length || page.length < pageSize;
      if (reached || exhausted) break;
      const next = page.at(-1).signature;
      if (next === before) throw Error("HISTORY_CURSOR_STALLED");
      before = next;
      if (!previous) break; // Explicit bounded first-start boundary.
    }
    const needsContinuation = !!previous && !reached && !exhausted;
    const gap = !previous
      ? "INITIAL_HISTORY_BOUNDARY"
      : !reached
        ? needsContinuation
          ? "HISTORY_RECOVERY_PENDING"
          : "HISTORY_ANCHOR_NOT_REACHED"
        : null;
    if (gap) {
      store.gap(gap, {
        programId,
        anchor: previous,
        oldest: rows.at(-1) ?? null,
        newest: head,
        pages,
        maxPages,
        pageSize,
        before,
      });
      metrics?.inc("recoveryGaps");
    }
    if (!head)
      return {
        pages,
        recovered: 0,
        complete: false,
        gap: gap ?? "EMPTY_HISTORY",
        checkpointAdvanced: false,
      };
    const observations = rows.map((row) => ({
      signature: row.signature,
      slot: row.slot,
      programId,
      receivedAt: new Date(now()).toISOString(),
      confirmationStatus: row.confirmationStatus ?? "confirmed",
      evidenceSource: "rpc:getSignaturesForAddress",
      onchainError: row.err ?? null,
    }));
    store.receiveBatch(observations);
    let persisted = 0;
    for (const observation of observations.reverse()) {
      if (store.isDone(observation.signature)) {
        persisted++;
        continue;
      }
      // A persisted coverage hole must not pin the history cursor forever.
      // The durable inbox retries UNAVAILABLE signatures independently after its cooldown.
      if (store.isSettled(observation.signature)) continue;
      await processObservation(observation);
      if (store.isDone(observation.signature)) persisted++;
    }
    const holes = observations
      .filter((o) => store.isSettled(o.signature) && !store.isDone(o.signature))
      .map((o) => o.signature);
    const hadHoles = continuation?.hadHoles === true || holes.length > 0;
    if (holes.length) {
      store.gap("HISTORY_TRANSACTION_HOLES", { programId, signatures: holes });
      metrics?.inc("recoveryGaps");
    }
    const all = observations.every((o) => store.isSettled(o.signature));
    if (all) {
      if (needsContinuation)
        store.saveRecoveryState(programId, {
          before,
          head,
          targetSignature: previous.signature,
          hadHoles,
          startedAt: continuation?.startedAt ?? new Date(now()).toISOString(),
        });
      else {
        store.advanceCheckpoint(
          programId,
          {
            signature: head.signature,
            slot: head.slot,
            recoveredAt: new Date(now()).toISOString(),
            continuity: gap || hadHoles ? "PARTIAL" : "RPC_ANCHOR_REACHED",
            transactionHoles: hadHoles,
            anchorReached: reached,
            priorAnchor: previous?.signature ?? null,
          },
          observations.map((o) => o.signature),
        );
        store.clearRecoveryState(programId);
      }
    }
    return {
      pages,
      recovered: persisted,
      selected: observations.length,
      complete: all && !gap && !hadHoles,
      gap: gap ?? (hadHoles ? "HISTORY_TRANSACTION_HOLES" : null),
      transactionHoles: holes.length,
      hadHoles,
      continuation: needsContinuation,
      checkpointAdvanced: all && !needsContinuation,
    };
  } catch (error) {
    store.gap("RECOVERY_ERROR", {
      programId,
      code: error.code ?? error.message,
      pages,
      anchor: previous,
    });
    metrics?.inc("recoveryGaps");
    return {
      pages,
      recovered: 0,
      complete: false,
      gap: "RECOVERY_ERROR",
      checkpointAdvanced: false,
    };
  }
}
