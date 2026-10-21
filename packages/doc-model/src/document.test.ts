import { describe, expect, it } from 'vitest';
import { Document } from './document.ts';
import { inverseOf } from './inverse.ts';
import { defaultProps, type Op } from './types.ts';

const rect = (id: string, overrides = {}): Op => ({
  t: 'create',
  id,
  props: defaultProps('rect', overrides),
});
const frame = (id: string, overrides = {}): Op => ({
  t: 'create',
  id,
  props: defaultProps('frame', overrides),
});

describe('Document', () => {
  it('creates, sets and deletes nodes', () => {
    const doc = new Document();
    expect(doc.apply(rect('c:1')).status).toBe('applied');
    expect(doc.apply({ t: 'set', id: 'c:1', key: 'x', value: 40 }).status).toBe('applied');
    expect(doc.get('c:1')!.x).toBe(40);
    expect(doc.apply({ t: 'delete', id: 'c:1' }).status).toBe('applied');
    expect(doc.has('c:1')).toBe(false);
  });

  it('drops ops that lost a race and rejects malformed ones', () => {
    const doc = new Document();
    expect(doc.apply({ t: 'set', id: 'c:9', key: 'x', value: 1 }).status).toBe('dropped');
    expect(doc.apply({ t: 'delete', id: 'c:9' }).status).toBe('dropped');
    doc.apply(rect('c:1'));
    expect(doc.apply(rect('c:1')).status).toBe('dropped');
    expect(doc.apply({ t: 'set', id: 'c:1', key: 'opacity', value: 2 }).status).toBe('invalid');
    expect(doc.apply({ t: 'set', id: 'c:1', key: 'type' as 'x', value: 1 }).status).toBe('invalid');
    expect(doc.apply(rect('root')).status).toBe('invalid');
  });

  it('orders siblings by index then id', () => {
    const doc = new Document();
    doc.apply(rect('c:2', { index: 'a1' }));
    doc.apply(rect('c:1', { index: 'a1' }));
    doc.apply(rect('c:3', { index: 'a0' }));
    expect(doc.childrenOf('root')).toEqual(['c:3', 'c:1', 'c:2']);
    doc.apply({ t: 'set', id: 'c:3', key: 'index', value: 'a2' });
    expect(doc.childrenOf('root')).toEqual(['c:1', 'c:2', 'c:3']);
  });

  it('only allows frames as parents and never forms cycles', () => {
    const doc = new Document();
    doc.apply(frame('f:1'));
    doc.apply(frame('f:2', { parentId: 'f:1' }));
    doc.apply(rect('r:1'));
    expect(doc.apply({ t: 'set', id: 'f:1', key: 'parentId', value: 'f:2' }).status).toBe(
      'dropped',
    );
    expect(doc.apply({ t: 'set', id: 'f:1', key: 'parentId', value: 'f:1' }).status).toBe(
      'dropped',
    );
    expect(doc.apply({ t: 'set', id: 'f:1', key: 'parentId', value: 'r:1' }).status).toBe(
      'invalid',
    );
    expect(doc.apply({ t: 'set', id: 'r:1', key: 'parentId', value: 'f:2' }).status).toBe(
      'applied',
    );
    expect(doc.childrenOf('f:2')).toEqual(['r:1']);
    doc.assertInvariants();
  });

  it('deletes subtrees', () => {
    const doc = new Document();
    doc.apply(frame('f:1'));
    doc.apply(rect('r:1', { parentId: 'f:1' }));
    doc.apply(rect('r:2', { parentId: 'f:1' }));
    const touched = new Set<string>();
    doc.apply({ t: 'delete', id: 'f:1' }, touched);
    expect(doc.size).toBe(0);
    expect(touched).toEqual(new Set(['f:1', 'r:1', 'r:2']));
  });

  it('rolls back a batch that contains an invalid op', () => {
    const doc = new Document();
    doc.apply(rect('r:1', { x: 5 }));
    const before = doc.clone();
    const res = doc.applyBatch([
      { t: 'set', id: 'r:1', key: 'x', value: 10 },
      rect('r:2'),
      { t: 'delete', id: 'r:1' },
      { t: 'set', id: 'r:2', key: 'fill', value: 'red' },
    ]);
    expect(res).toMatchObject({ ok: false, opIndex: 3 });
    expect(doc.equals(before)).toBe(true);
    expect(doc.childrenOf('root')).toEqual(['r:1']);
  });

  it('clones independently', () => {
    const doc = new Document();
    doc.apply(rect('r:1'));
    const copy = doc.clone();
    copy.apply({ t: 'set', id: 'r:1', key: 'x', value: 99 });
    copy.apply(rect('r:2'));
    expect(doc.get('r:1')!.x).toBe(0);
    expect(doc.childrenOf('root')).toEqual(['r:1']);
  });

  it('inverse ops restore the previous state', () => {
    const doc = new Document();
    doc.apply(frame('f:1'));
    doc.apply(rect('r:1', { parentId: 'f:1', x: 3 }));
    const before = doc.clone();
    const ops: Op[] = [
      { t: 'set', id: 'r:1', key: 'x', value: 50 },
      rect('r:2'),
      { t: 'delete', id: 'f:1' },
    ];
    const inverses: Op[][] = [];
    for (const op of ops) {
      inverses.push(inverseOf(doc, op));
      doc.apply(op);
    }
    for (const inv of inverses.reverse()) for (const op of inv) doc.apply(op);
    expect(doc.equals(before)).toBe(true);
  });
});
