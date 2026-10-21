/**
 * Fractional indexing with base-62 keys, after the scheme described by
 * David Greenspan ("Implementing Fractional Indexing") and popularised by
 * Figma. A key is an integer part whose length is encoded by its first
 * character, followed by an optional fractional part that never ends in '0'.
 * Keys compare with plain string comparison.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SMALLEST_INTEGER = 'A' + '0'.repeat(26);

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`invalid order key head: ${head}`);
}

function integerPart(key: string): string {
  const len = integerLength(key.charAt(0));
  if (len > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, len);
}

function assertValidKey(key: string): void {
  if (key === SMALLEST_INTEGER) throw new Error(`invalid order key: ${key}`);
  const int = integerPart(key);
  for (const ch of key) {
    if (!DIGITS.includes(ch)) throw new Error(`invalid order key: ${key}`);
  }
  if (key.length > int.length && key.endsWith('0')) {
    throw new Error(`invalid order key: ${key}`);
  }
}

export function isValidOrderKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1000) return false;
  try {
    assertValidKey(key);
    return true;
  } catch {
    return false;
  }
}

/** Midpoint of two fractional parts; `b === null` means 1. */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (b !== null) {
    let n = 0;
    while ((a.charAt(n) || '0') === b.charAt(n)) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a.charAt(0)) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b.charAt(0)) : DIGITS.length;
  if (digitB - digitA > 1) {
    return DIGITS.charAt(Math.round((digitA + digitB) / 2));
  }
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS.charAt(digitA) + midpoint(a.slice(1), null);
}

function incrementInteger(x: string): string | null {
  const head = x.charAt(0);
  const digs = x.slice(1).split('');
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]!) + 1;
    if (d === DIGITS.length) {
      digs[i] = '0';
    } else {
      digs[i] = DIGITS.charAt(d);
      carry = false;
    }
  }
  if (!carry) return head + digs.join('');
  if (head === 'Z') return 'a0';
  if (head === 'z') return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > 'a') digs.push('0');
  else digs.pop();
  return nextHead + digs.join('');
}

function decrementInteger(x: string): string | null {
  const head = x.charAt(0);
  const digs = x.slice(1).split('');
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]!) - 1;
    if (d === -1) {
      digs[i] = DIGITS.charAt(DIGITS.length - 1);
    } else {
      digs[i] = DIGITS.charAt(d);
      borrow = false;
    }
  }
  if (!borrow) return head + digs.join('');
  if (head === 'a') return 'Z' + DIGITS.charAt(DIGITS.length - 1);
  if (head === 'A') return null;
  const prevHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (prevHead < 'Z') digs.push(DIGITS.charAt(DIGITS.length - 1));
  else digs.pop();
  return prevHead + digs.join('');
}

/**
 * Returns a key strictly between `a` and `b`. `null` means unbounded on that
 * side. Appending at either end stays short: it increments or decrements the
 * integer part instead of growing the fraction.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) assertValidKey(a);
  if (b !== null) assertValidKey(b);
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);

  if (a === null) {
    if (b === null) return 'a0';
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb);
    if (ib < b) return ib;
    const res = decrementInteger(ib);
    if (res === null) throw new Error('cannot decrement order key');
    return res;
  }

  if (b === null) {
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const next = incrementInteger(ia);
    return next === null ? ia + midpoint(fa, null) : next;
  }

  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const next = incrementInteger(ia);
  if (next === null) throw new Error('cannot increment order key');
  if (next < b) return next;
  return ia + midpoint(fa, null);
}

/** Returns `n` ascending keys strictly between `a` and `b`. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  const keys: string[] = [];
  let prev = a;
  for (let i = 0; i < n; i++) {
    prev = keyBetween(prev, b);
    keys.push(prev);
  }
  return keys;
}

/**
 * Like keyBetween, but appends one random non-zero digit where that is safe,
 * so two people inserting at the same spot at the same moment usually get
 * distinct keys. Equal keys are still legal: siblings tie-break by node id.
 */
export function keyBetweenJittered(
  a: string | null,
  b: string | null,
  random: () => number = Math.random,
): string {
  const key = keyBetween(a, b);
  if (b !== null && b.startsWith(key)) return key;
  const digit = DIGITS.charAt(1 + Math.floor(random() * (DIGITS.length - 1)));
  return key + digit;
}
