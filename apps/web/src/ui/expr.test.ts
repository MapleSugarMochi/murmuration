import { describe, expect, it } from 'vitest';
import { evaluate } from './expr.ts';

describe('evaluate', () => {
  it('computes arithmetic with precedence and parentheses', () => {
    expect(evaluate('100+20')).toBe(120);
    expect(evaluate('2 + 3 * 4')).toBe(14);
    expect(evaluate('(2+3)*4')).toBe(20);
    expect(evaluate('-5 + 2')).toBe(-3);
    expect(evaluate('10/4')).toBe(2.5);
    expect(evaluate('.5*2')).toBe(1);
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'abc', '1+', '(1', '1/0', 'alert(1)', '2**3']) {
      expect(evaluate(bad)).toBeNull();
    }
  });
});
