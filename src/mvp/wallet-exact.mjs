// Exact components are persisted with the position that incurred each FIFO
// allocation. Combining unrelated denominators is an evaluation step, not the
// storage format. These computation limits are independent of the caller's
// JSON/state memory limit; exceeding either requires a different checkpoint,
// rather than an identical full replay or a rounded monetary value.
import limits from './wallet-accounting-config.mjs';
export const EXACT_INTEGER_BITS = limits.exactIntegerBits;
export const EXACT_POSITION_LIMIT = limits.exactPositionComponents;
const MAX_INTEGER_DIGITS = Math.ceil(EXACT_INTEGER_BITS * Math.LOG10E * Math.LN2) + 1;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const gcd = (a, b) => { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a || 1n; };
const precision = value => {
  if ((value < 0n ? -value : value).toString(2).length > EXACT_INTEGER_BITS)
    throw Error('ACCOUNTING_EXACT_PRECISION_BUDGET_EXCEEDED');
  return value;
};
export function exactFraction(n = 0n, d = 1n) {
  if (d <= 0n) throw Error('INVALID_DENOMINATOR');
  const divisor = gcd(n, d);
  return { n: precision(n / divisor), d: precision(d / divisor) };
}
export const exactPacked = value => ({ n: value.n.toString(), d: value.d.toString() });
export function exactRational(value) {
  // Bound text before parsing BigInt; the bit budget is checked after reduction.
  if (!object(value) || typeof value.n !== 'string' || typeof value.d !== 'string') throw Error('INVALID_FRACTION');
  if (value.n.length > MAX_INTEGER_DIGITS + 1 || value.d.length > MAX_INTEGER_DIGITS)
    throw Error('ACCOUNTING_EXACT_PRECISION_BUDGET_EXCEEDED');
  if (!/^-?\d+$/.test(value.n) || !/^[1-9]\d*$/.test(value.d)) throw Error('INVALID_FRACTION');
  return exactFraction(BigInt(value.n), BigInt(value.d));
}
export function exactAdd(a, b) {
  // Cross-cancel denominators first. Limits apply to the reduced result, not
  // an unnecessarily large intermediate denominator.
  const divisor = gcd(a.d, b.d);
  return exactFraction(a.n * (b.d / divisor) + b.n * (a.d / divisor), a.d * (b.d / divisor));
}
const decimalDenominator = value => {
  let d = value;
  while (!(d % 2n)) d /= 2n;
  while (!(d % 5n)) d /= 5n;
  return d === 1n;
};
export function exactComponents(value = { n: '0', d: '1' }) {
  const cash = exactRational(value); const positions = {};
  if (value.positions !== undefined) {
    if (!object(value.positions) || Object.keys(value.positions).length > EXACT_POSITION_LIMIT)
      throw Error('ACCOUNTING_EXACT_POSITION_CAPACITY_EXCEEDED');
    for (const [id, term] of Object.entries(value.positions)) {
      if (!/^(?:p:[1-9]\d{0,15}|legacy)$/.test(id)) throw Error('INVALID_EXACT_POSITION');
      positions[id] = exactPacked(exactRational(term));
    }
  }
  return { ...exactPacked(cash), positions };
}
export function exactTotal(value) {
  const components = exactComponents(value);
  let sum = exactRational(components);
  for (const term of Object.values(components.positions)) sum = exactAdd(sum, exactRational(term));
  return sum;
}
export function exactCashAdd(value, amount) {
  const components = exactComponents(value);
  return { ...exactPacked(exactAdd(exactRational(components), amount)), positions: components.positions };
}
export function exactPositionAdd(value, id, amount) {
  const components = exactComponents(value);
  if (!/^(?:p:[1-9]\d{0,15}|legacy)$/.test(id)) throw Error('INVALID_EXACT_POSITION');
  const term = exactAdd(components.positions[id] ? exactRational(components.positions[id]) : exactFraction(), amount);
  if (term.n === 0n || decimalDenominator(term.d)) {
    delete components.positions[id];
    return exactCashAdd(components, term);
  }
  components.positions[id] = exactPacked(term);
  if (Object.keys(components.positions).length > EXACT_POSITION_LIMIT)
    throw Error('ACCOUNTING_EXACT_POSITION_CAPACITY_EXCEEDED');
  return components;
}
export function exactComponentsAdd(a, b) {
  const right = exactComponents(b);
  let sum = exactCashAdd(a, exactRational(right));
  for (const [id, term] of Object.entries(right.positions)) sum = exactPositionAdd(sum, id, exactRational(term));
  return sum;
}
