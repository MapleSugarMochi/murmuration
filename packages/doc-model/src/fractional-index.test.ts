import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  isValidOrderKey,
  keyBetween,
  keyBetweenJittered,
  keysBetween,
} from './fractional-index.ts';

describe('keyBetween', () => {
  it('handles the unbounded cases', () => {
    expect(keyBetween(null, null)).toBe('a0');
    expect(keyBetween('a0', null)).toBe('a1');
    expect(keyBetween(null, 'a0')).toBe('Zz');
    expect(keyBetween('a0', 'a1')).toBe('a0V');
  });

  it('keeps keys short when appending repeatedly', () => {
    let key: string | null = null;
    for (let i = 0; i < 10_000; i++) key = keyBetween(key, null);
    expect(key!.length).toBeLessThanOrEqual(4);
  });

  it('keeps keys short when prepending repeatedly', () => {
    let key: string | null = null;
    for (let i = 0; i < 10_000; i++) key = keyBetween(null, key);
    expect(key!.length).toBeLessThanOrEqual(4);
  });

  it('rejects inverted bounds', () => {
    expect(() => keyBetween('a1', 'a0')).toThrow();
    expect(() => keyBetween('a0', 'a0')).toThrow();
  });

  it('always produces a valid key strictly between its bounds', () => {
    // Build a pool of keys by random insertions, then check random pairs.
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 200 }), (picks) => {
        const keys: string[] = [];
        for (const p of picks) {
          const pos = p % (keys.length + 1);
          const k = keyBetween(keys[pos - 1] ?? null, keys[pos] ?? null);
          expect(isValidOrderKey(k)).toBe(true);
          if (pos > 0) expect(k > keys[pos - 1]!).toBe(true);
          if (pos < keys.length) expect(k < keys[pos]!).toBe(true);
          keys.splice(pos, 0, k);
        }
      }),
    );
  });

  it('jittered keys stay strictly between their bounds', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(), fc.double({ min: 0, max: 0.999, noNaN: true })), {
          minLength: 1,
          maxLength: 200,
        }),
        (picks) => {
          const keys: string[] = [];
          for (const [p, r] of picks) {
            const pos = p % (keys.length + 1);
            const k = keyBetweenJittered(keys[pos - 1] ?? null, keys[pos] ?? null, () => r);
            expect(isValidOrderKey(k)).toBe(true);
            if (pos > 0) expect(k > keys[pos - 1]!).toBe(true);
            if (pos < keys.length) expect(k < keys[pos]!).toBe(true);
            keys.splice(pos, 0, k);
          }
        },
      ),
    );
  });

  it('keysBetween returns ascending keys', () => {
    const keys = keysBetween('a0', 'a1', 50);
    expect([...keys].sort()).toEqual(keys);
    expect(keys[0]! > 'a0' && keys[49]! < 'a1').toBe(true);
  });
});

describe('isValidOrderKey', () => {
  it('rejects malformed keys', () => {
    for (const bad of ['', 'a', 'a00', 'b0', '!!', 'a0-', 'A' + '0'.repeat(26), 42, null]) {
      expect(isValidOrderKey(bad)).toBe(false);
    }
  });
});
