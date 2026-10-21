import { isValidOrderKey } from './fractional-index.ts';
import { NODE_TYPES, PROP_KEYS, ROOT_ID, type NodeType, type PropKey } from './types.ts';

export const LIMITS = {
  coordinate: 1e7,
  strokeWidth: 100,
  fontSizeMin: 1,
  fontSizeMax: 999,
  points: 20_000,
  text: 10_000,
  name: 200,
  id: 100,
} as const;

const COLOR_RE = /^#[0-9a-fA-F]{8}$/;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function inRange(v: unknown, min: number, max: number): boolean {
  return finite(v) && v >= min && v <= max;
}

export function isValidNodeId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= LIMITS.id && id !== ROOT_ID;
}

export function isNodeType(t: unknown): t is NodeType {
  return typeof t === 'string' && (NODE_TYPES as readonly string[]).includes(t);
}

/** Returns an error message, or null when `value` is legal for `key`. */
export function validateProp(key: PropKey, value: unknown): string | null {
  const ok = (cond: boolean) => (cond ? null : `invalid value for ${key}`);
  switch (key) {
    case 'parentId':
      return ok(typeof value === 'string' && value.length > 0 && value.length <= LIMITS.id);
    case 'index':
      return ok(isValidOrderKey(value));
    case 'x':
    case 'y':
      return ok(inRange(value, -LIMITS.coordinate, LIMITS.coordinate));
    case 'width':
    case 'height':
    case 'cornerRadius':
      return ok(inRange(value, 0, LIMITS.coordinate));
    case 'rotation':
      return ok(finite(value) && value >= 0 && value < 360);
    case 'fill':
    case 'stroke':
      return ok(value === null || (typeof value === 'string' && COLOR_RE.test(value)));
    case 'strokeWidth':
      return ok(inRange(value, 0, LIMITS.strokeWidth));
    case 'opacity':
      return ok(inRange(value, 0, 1));
    case 'points':
      return ok(
        Array.isArray(value) &&
          value.length % 2 === 0 &&
          value.length <= LIMITS.points &&
          value.every((p) => inRange(p, -LIMITS.coordinate, LIMITS.coordinate)),
      );
    case 'text':
      return ok(typeof value === 'string' && value.length <= LIMITS.text);
    case 'fontSize':
      return ok(inRange(value, LIMITS.fontSizeMin, LIMITS.fontSizeMax));
    case 'name':
      return ok(typeof value === 'string' && value.length <= LIMITS.name);
    case 'visible':
    case 'locked':
    case 'clipContent':
      return ok(typeof value === 'boolean');
  }
}

/** Validates a complete property set for a create op. */
export function validateNodeProps(props: unknown): string | null {
  if (typeof props !== 'object' || props === null || Array.isArray(props))
    return 'props must be an object';
  const record = props as Record<string, unknown>;
  if (!isNodeType(record.type)) return 'invalid node type';
  const keys = Object.keys(record);
  if (keys.length !== PROP_KEYS.length + 1)
    return 'props must contain exactly the node property set';
  for (const key of PROP_KEYS) {
    if (!(key in record)) return `missing property ${key}`;
    const err = validateProp(key, record[key]);
    if (err) return err;
  }
  return null;
}

export function normalizeRotation(deg: number): number {
  const r = deg % 360;
  const n = r < 0 ? r + 360 : r;
  // Guard against -0 and floating error landing exactly on 360.
  return n >= 360 || Object.is(n, -0) ? 0 : n;
}
