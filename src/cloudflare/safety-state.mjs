import { isEvmAddress } from '../network.mjs';

const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const fresh = (value, now) => Number.isFinite(Date.parse(value)) && now - Date.parse(value) >= 0 && now - Date.parse(value) <= 6 * 3600000;

// Three consecutive observations give each bounded RPC check a turn without
// increasing the per-invocation RPC allowance or starving pool discovery.
export function resumeSafetyFocus(focus, now) {
  const p = focus?.pool;
  return fresh(focus?.startedAt, now) && [1, 2].includes(focus?.phase)
    && p && ['v2', 'v3', 'v4'].includes(p.type) && typeof p.id === 'string' && p.id.length <= 180
    && [p.token0, p.token1].every(value => isEvmAddress(value)
      || p.type === 'v4' && value === '0x' + '0'.repeat(40))
    && p.token0 !== p.token1
    && Number.isSafeInteger(p.createdBlock) && p.createdBlock >= 0 ? focus : null;
}

export function nextSafetyFocus(pool, phase, startedAt, now) {
  if (!pool || phase >= 2) return null;
  return { pool, phase: phase + 1, startedAt: startedAt ?? new Date(now).toISOString() };
}

export function pendingSafetyPool(states, sequence, now) {
  // Two out of every three new focus groups resume unfinished ledgers. The
  // third keeps discovery feeding fresh contracts into the analysis queue.
  if (Math.floor((sequence - 1) / 3) % 3 === 0) return null;
  const pending = (Array.isArray(states) ? states : []).filter(value => value?.holderState
    && value.assessments?.holders?.coverage?.distributionComplete !== true
    && resumeSafetyFocus({ pool: value.pool, phase: 1, startedAt: value.updatedAt }, now));
  pending.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  return pending[0]?.pool ?? null;
}

export function findSafetyState(states, address, poolId, codeHash, now) {
  return (Array.isArray(states) ? states : []).find(value => value?.address === address
    && value.poolId === poolId && value.codeHash === codeHash && fresh(value.updatedAt, now)) ?? null;
}

export function saveSafetyState(states, entry, now) {
  const values = (Array.isArray(states) ? states : []).filter(value => value && isEvmAddress(value.address)
    && fresh(value.updatedAt, now) && value.address !== entry?.address);
  if (entry && isEvmAddress(entry.address) && bytes(entry) <= 196608) values.unshift(entry);
  values.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  values.splice(12);
  while (bytes(values) > 524288) values.pop();
  return values;
}

// Keep each section's original evidence time. A new collection is not a new
// observation of balances or transfer fees measured in an earlier phase.
export function mergeSafetySnapshots(previous, current, now) {
  const output = {};
  for (const [section, seconds] of Object.entries({ holders: 300, liquidityProtection: 600, quote: 60, security: 600 })) {
    const value = current?.[section] ?? previous?.[section];
    const time = Date.parse(value?.checkedAt);
    if (!value || !Number.isFinite(time) || now - time < 0 || now - time > seconds * 1000) continue;
    if (section === 'security') {
      // Only observed risks from the fixed-quantity simulation are cached.
      const risks = Object.fromEntries(['buyTaxPct', 'sellTaxPct'].filter(name =>
        typeof value[name] === 'number' && Number.isFinite(value[name]) && value[name] > 0 && value[name] <= 100)
        .map(name => [name, value[name]]));
      if (Object.keys(risks).length) output.security = { checkedAt: value.checkedAt, source: value.source,
        ...(Array.isArray(value.evidence) ? { evidence: value.evidence.slice(0, 4) } : {}), ...risks };
    } else output[section] = structuredClone(value);
  }
  return output;
}
