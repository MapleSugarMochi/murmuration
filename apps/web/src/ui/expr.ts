/**
 * Evaluates simple arithmetic typed into number fields ("100+20", "(3*4)/2").
 * A tiny recursive-descent parser — never `eval`. Returns null on bad input.
 */
export function evaluate(input: string): number | null {
  const src = input.replace(/\s+/g, '');
  let i = 0;

  const number = (): number | null => {
    const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };

  const factor = (): number | null => {
    if (src[i] === '-') {
      i++;
      const v = factor();
      return v === null ? null : -v;
    }
    if (src[i] === '(') {
      i++;
      const v = expr();
      if (src[i] !== ')') return null;
      i++;
      return v;
    }
    return number();
  };

  const term = (): number | null => {
    let v = factor();
    while (v !== null && (src[i] === '*' || src[i] === '/')) {
      const op = src[i++];
      const r = factor();
      if (r === null) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };

  const expr = (): number | null => {
    let v = term();
    while (v !== null && (src[i] === '+' || src[i] === '-')) {
      const op = src[i++];
      const r = term();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };

  const v = expr();
  return v !== null && i === src.length && Number.isFinite(v) ? v : null;
}
