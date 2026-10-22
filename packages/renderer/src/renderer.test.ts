import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Document, defaultProps, type Op } from '@murmuration/doc-model';
import { apply, intersects, type Rect } from './geometry.ts';
import { QuadTree } from './quadtree.ts';
import { Scene } from './scene.ts';

const rectArb = fc
  .record({
    x: fc.integer({ min: -20_000, max: 20_000 }),
    y: fc.integer({ min: -20_000, max: 20_000 }),
    width: fc.integer({ min: 0, max: 3000 }),
    height: fc.integer({ min: 0, max: 3000 }),
  })
  .map((r): Rect => r);

describe('QuadTree', () => {
  it('matches a brute-force scan for inserts, moves, removes and queries', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(50), fc.oneof(rectArb, fc.constant(null))), { maxLength: 300 }),
        fc.array(rectArb, { minLength: 1, maxLength: 20 }),
        (edits, queries) => {
          const tree = new QuadTree<number>({ x: -1000, y: -1000, width: 2000, height: 2000 });
          const truth = new Map<number, Rect>();
          for (const [id, r] of edits) {
            if (r) {
              tree.insert(id, r);
              truth.set(id, r);
            } else {
              tree.remove(id);
              truth.delete(id);
            }
          }
          expect(tree.size).toBe(truth.size);
          for (const q of queries) {
            const expected = [...truth].filter(([, r]) => intersects(r, q)).map(([id]) => id);
            expect(tree.query(q).sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('Scene', () => {
  const build = (ops: Op[]) => {
    const doc = new Document();
    for (const op of ops) doc.apply(op);
    return { doc, scene: new Scene(doc) };
  };

  it('composes transforms through frames', () => {
    const { scene } = build([
      {
        t: 'create',
        id: 'f',
        props: defaultProps('frame', { x: 100, y: 100, width: 200, height: 200 }),
      },
      {
        t: 'create',
        id: 'r',
        props: defaultProps('rect', { parentId: 'f', x: 10, y: 20, width: 10, height: 10 }),
      },
    ]);
    expect(apply(scene.geometry('r')!.world, { x: 0, y: 0 })).toEqual({ x: 110, y: 120 });
    expect(scene.geometry('r')!.bounds).toEqual({ x: 110, y: 120, width: 10, height: 10 });
  });

  it('hit-tests the topmost shape and respects frame clipping', () => {
    const { scene } = build([
      { t: 'create', id: 'f', props: defaultProps('frame', { width: 100, height: 100 }) },
      {
        t: 'create',
        id: 'a',
        props: defaultProps('rect', { parentId: 'f', index: 'a0', width: 300, height: 50 }),
      },
      {
        t: 'create',
        id: 'b',
        props: defaultProps('ellipse', { parentId: 'f', index: 'a1', width: 50, height: 50 }),
      },
    ]);
    expect(scene.hitTest({ x: 25, y: 25 }, { tolerance: 0 })).toBe('b');
    expect(scene.hitTest({ x: 2, y: 2 }, { tolerance: 0 })).toBe('a'); // outside the ellipse
    expect(scene.hitTest({ x: 80, y: 80 }, { tolerance: 0 })).toBe('f');
    expect(scene.hitTest({ x: 250, y: 25 }, { tolerance: 0 })).toBeNull(); // clipped away
    expect(scene.frameAt({ x: 50, y: 50 })).toBe('f');
  });

  it('updates incrementally when a parent moves', () => {
    const { doc, scene } = build([
      { t: 'create', id: 'f', props: defaultProps('frame') },
      {
        t: 'create',
        id: 'r',
        props: defaultProps('rect', { parentId: 'f', width: 10, height: 10 }),
      },
    ]);
    const touched = new Set<string>();
    doc.apply({ t: 'set', id: 'f', key: 'x', value: 500 }, touched);
    scene.update(doc, touched);
    expect(scene.geometry('r')!.bounds.x).toBe(500);
    doc.apply({ t: 'delete', id: 'f' }, touched);
    scene.update(doc, touched);
    expect(scene.geometry('r')).toBeUndefined();
    expect(scene.queryRect({ x: -1e6, y: -1e6, width: 2e6, height: 2e6 })).toEqual([]);
  });

  it('accounts for rotation in bounds and hits', () => {
    const { scene } = build([
      {
        t: 'create',
        id: 'r',
        props: defaultProps('rect', { width: 100, height: 10, rotation: 90 }),
      },
    ]);
    const b = scene.geometry('r')!.bounds;
    expect(b.width).toBeCloseTo(10);
    expect(b.height).toBeCloseTo(100);
    expect(scene.hitTest({ x: 50, y: 0 }, { tolerance: 0 })).toBe('r');
    expect(scene.hitTest({ x: 90, y: 5 }, { tolerance: 0 })).toBeNull();
  });
});
