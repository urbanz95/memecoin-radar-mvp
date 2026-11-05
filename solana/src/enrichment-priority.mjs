// Bounded, evidence-only prioritization of *HTTP context enrichment*.
// This is NOT a trading score, a coverage claim, or proof of token safety.
const P0 = new Set(['TOKEN_CREATED', 'POOL_CREATED', 'TOKEN_MIGRATED', 'TOKEN_GRADUATED']);
const P2 = new Set([
  'TOKEN_BOUGHT', 'TOKEN_SOLD', 'CURVE_PROGRESS_UPDATED',
  'LIQUIDITY_ADDED', 'LIQUIDITY_REMOVED',
]);
export const PRIORITY_NAMES = Object.freeze(['P0', 'P1', 'P2', 'P3']);

// Weight 4:2:1:1, interleaved instead of a strict P0-first FIFO.
// With every priority continuously backlogged and successful work, P3
// receives 1/8 of selections. This does not reserve raw RPC capacity.
export const PRIORITY_CYCLE = Object.freeze([0, 0, 1, 0, 2, 0, 1, 3]);

export function classifyContextPriority(observations, valuation) {
  if (!Array.isArray(observations) || !observations.length) return 3;
  let rank = 3;
  for (const event of observations) {
    if (!event || event.evidenceStatus !== 'VERIFIED_RPC_LOG_EVENT' ||
        event.evidenceSource?.kind !== 'rpc:logsSubscribe') continue;
    // Cannot prioritize fabricated mint/pool identities.
    const hasIdentity = typeof event.tokenMint === 'string' && event.tokenMint.length > 0;
    if (hasIdentity && P0.has(event.eventType)) return 0;
    if (hasIdentity && P2.has(event.eventType)) {
      if (valuation?.action === 'ENRICH' && event.protocol === 'pump_fun') rank = Math.min(rank, 1);
      else rank = Math.min(rank, 2);
    }
  }
  return rank;
}

/** Fair rotation across 4 already-sorted, bounded, deduplicated priority buckets. */
export class PriorityScheduler {
  constructor() { this.position = 0; }
  select(buckets, capacity, blocked = new Set()) {
    if (!Number.isSafeInteger(capacity) || capacity < 0) throw Error('INVALID_PRIORITY_CAPACITY');
    if (!Array.isArray(buckets) || buckets.length !== 4 ||
        buckets.some(x => !Array.isArray(x))) throw Error('INVALID_PRIORITY_BUCKETS');
    const offsets = [0, 0, 0, 0];
    const seen = new Set(blocked);
    const selected = [];
    for (let n = 0; n < capacity; n++) {
      let chosen = null;
      for (let step = 0; step < PRIORITY_CYCLE.length; step++) {
        const slot = (this.position + step) % PRIORITY_CYCLE.length;
        const priority = PRIORITY_CYCLE[slot];
        while (offsets[priority] < buckets[priority].length &&
               seen.has(buckets[priority][offsets[priority]].signature))
          offsets[priority]++;
        if (offsets[priority] < buckets[priority].length) {
          chosen = { priority, slot, item: buckets[priority][offsets[priority]++] };
          break;
        }
      }
      if (!chosen) break;
      this.position = (chosen.slot + 1) % PRIORITY_CYCLE.length;
      seen.add(chosen.item.signature);
      selected.push(chosen.item);
    }
    return selected;
  }
}
