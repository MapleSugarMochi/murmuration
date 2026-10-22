import { describe, expect, it } from 'vitest';
import { Document, defaultProps, type Op } from '@murmuration/doc-model';
import {
  apply,
  boundsOf,
  containsPoint,
  containsRect,
  corners,
  distanceToSegment,
  expand,
  invert,
  localMatrix,
  multiply,
  rectFromPoints,
  rotate,
  rotationOf,
  translate,
  unionRects,
} from './geometry.ts';
import { Scene, isLineLike, pointsOf } from './scene.ts';

const build = (ops: Op[]) => {
  const doc = new Document();
  for (const op of ops) doc.apply(op);
  return { doc, scene: new Scene(doc) };
};

describe('Scene display list', () => {
  it('flattens in paint order, skips hidden subtrees and marks clip ranges', () => {
    const { scene } = build([
      { t: 'create', id: 'f', props: defaultProps('frame', { index: 'a0' }) },
      { t: 'create', id: 'a', props: defaultProps('rect', { parentId: 'f', index: 'a0' }) },
      {
        t: 'create',
        id: 'g',
        props: defaultProps('frame', { parentId: 'f', index: 'a1', clipContent: false }),
      },
      { t: 'create', id: 'b', props: defaultProps('rect', { parentId: 'g' }) },
      { t: 'create', id: 'h', props: defaultProps('frame', { index: 'a1', visible: false }) },
      { t: 'create', id: 'c', props: defaultProps('rect', { parentId: 'h' }) },
      { t: 'create', id: 'top', props: defaultProps('ellipse', { index: 'a2' }) },
    ]);
    const list = scene.displayList();
    expect(list.map((e) => e.id)).toEqual(['f', 'a', 'g', 'b', 'top']);
    // f clips and has children: its clip ends just past its subtree.
    expect(list[0]!.clipEnd).toBe(4);
    // g has children but does not clip; leaves never clip.
    expect(list[2]!.clipEnd).toBe(-1);
    expect(list[1]!.clipEnd).toBe(-1);
  });

  it('is cached until the document changes', () => {
    const { doc, scene } = build([{ t: 'create', id: 'r', props: defaultProps('rect') }]);
    const first = scene.displayList();
    expect(scene.displayList()).toBe(first);
    const touched = new Set<string>();
    doc.apply({ t: 'set', id: 'r', key: 'x', value: 5 }, touched);
    scene.update(doc, touched);
    const second = scene.displayList();
    expect(second).not.toBe(first);
    expect(second[0]!.props.x).toBe(5);
  });

  it('rebuilds from scratch and reports bounds, order, locks and visibility', () => {
    const { doc, scene } = build([
      { t: 'create', id: 'f', props: defaultProps('frame', { locked: true, x: 10, y: 10 }) },
      {
        t: 'create',
        id: 'r',
        props: defaultProps('rect', { parentId: 'f', width: 10, height: 10 }),
      },
      { t: 'create', id: 's', props: defaultProps('rect', { x: 500, index: 'a1' }) },
    ]);
    scene.rebuild(doc);
    expect(scene.document).toBe(doc);
    expect(scene.isLocked('r')).toBe(true);
    expect(scene.isLocked('s')).toBe(false);
    expect(scene.isShown('r')).toBe(true);
    expect(scene.sortByOrder(['s', 'r', 'f'])).toEqual(['f', 'r', 's']);
    expect(scene.boundsOfNodes(['r', 's'])).toEqual({ x: 10, y: 0, width: 590, height: 100 });
    expect(scene.boundsOfNodes([])).toBeNull();
    // Locked nodes are skipped unless asked for.
    expect(scene.hitTest({ x: 15, y: 15 }, { tolerance: 0 })).toBeNull();
    expect(scene.hitTest({ x: 15, y: 15 }, { tolerance: 0, includeLocked: true })).toBe('r');
    expect(
      scene.hitTest(
        { x: 15, y: 15 },
        { tolerance: 0, includeLocked: true, exclude: new Set(['f']) },
      ),
    ).toBeNull();
  });

  it('hit-tests outlines of unfilled shapes and lines', () => {
    const { scene } = build([
      {
        t: 'create',
        id: 'box',
        props: defaultProps('rect', { fill: null, stroke: '#000000ff', width: 100, height: 100 }),
      },
      {
        t: 'create',
        id: 'ring',
        props: defaultProps('ellipse', {
          fill: null,
          stroke: '#000000ff',
          x: 200,
          width: 100,
          height: 100,
        }),
      },
      {
        t: 'create',
        id: 'line',
        props: defaultProps('line', {
          x: 0,
          y: 300,
          width: 100,
          height: 0,
          points: [0, 0, 100, 0],
        }),
      },
    ]);
    expect(scene.hitsNode('box', { x: 50, y: 50 }, 2)).toBe(false);
    expect(scene.hitsNode('box', { x: 1, y: 50 }, 2)).toBe(true);
    expect(scene.hitsNode('ring', { x: 250, y: 250 }, 2)).toBe(false);
    expect(scene.hitsNode('ring', { x: 250, y: 1 }, 2)).toBe(true);
    expect(scene.hitsNode('line', { x: 50, y: 301 }, 2)).toBe(true);
    expect(scene.hitsNode('line', { x: 50, y: 320 }, 2)).toBe(false);
    expect(scene.hitsNode('missing', { x: 0, y: 0 }, 2)).toBe(false);
  });

  it('derives default endpoints for lines without points', () => {
    const line = defaultProps('line', { width: 30, height: 40 });
    expect(pointsOf(line)).toEqual([
      { x: 0, y: 0 },
      { x: 30, y: 40 },
    ]);
    expect(isLineLike(line)).toBe(true);
    expect(isLineLike(defaultProps('rect'))).toBe(false);
  });
});

describe('geometry', () => {
  it('composes, inverts and decomposes rigid transforms', () => {
    const m = multiply(translate(10, 20), rotate(90));
    const p = apply(m, { x: 1, y: 0 });
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(21);
    const back = apply(invert(m), p);
    expect(back.x).toBeCloseTo(1);
    expect(back.y).toBeCloseTo(0);
    expect(rotationOf(m)).toBeCloseTo(90);
    expect(invert({ a: 0, b: 0, c: 0, d: 0, e: 1, f: 1 })).toEqual({
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 0,
    });
  });

  it('rotates a box about its centre', () => {
    const m = localMatrix({ x: 0, y: 0, width: 100, height: 20, rotation: 90 });
    const pts = corners(m, 100, 20);
    const b = boundsOf(pts);
    expect(b.x).toBeCloseTo(40);
    expect(b.width).toBeCloseTo(20);
    expect(b.height).toBeCloseTo(100);
  });

  it('handles rectangles', () => {
    expect(boundsOf([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(unionRects([])).toBeNull();
    expect(
      unionRects([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 20, y: -5, width: 5, height: 5 },
      ]),
    ).toEqual({ x: 0, y: -5, width: 25, height: 15 });
    const outer = { x: 0, y: 0, width: 100, height: 100 };
    expect(containsRect(outer, { x: 10, y: 10, width: 10, height: 10 })).toBe(true);
    expect(containsRect(outer, { x: 95, y: 10, width: 10, height: 10 })).toBe(false);
    expect(containsPoint(outer, { x: 100, y: 0 })).toBe(true);
    expect(expand(outer, 5)).toEqual({ x: -5, y: -5, width: 110, height: 110 });
    expect(rectFromPoints({ x: 5, y: 9 }, { x: 1, y: 2 })).toEqual({
      x: 1,
      y: 2,
      width: 4,
      height: 7,
    });
  });

  it('measures distance to segments, including degenerate ones', () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distanceToSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});
