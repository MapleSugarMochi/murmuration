import { describe, expect, it } from 'vitest';
import { defaultProps, type Op } from '@murmuration/doc-model';
import { Room } from './room.ts';

const create = (id: string): Op => ({ t: 'create', id, props: defaultProps('rect') });

describe('Room', () => {
  it('assigns increasing seqs', () => {
    const room = new Room();
    const a = room.submit('a', 1, [create('a:1')]);
    const b = room.submit('b', 1, [create('b:1')]);
    expect(a).toMatchObject({ kind: 'applied', batch: { seq: 1 } });
    expect(b).toMatchObject({ kind: 'applied', batch: { seq: 2 } });
    expect(room.seq).toBe(2);
  });

  it('deduplicates resent batches, including rejected ones', () => {
    const room = new Room();
    room.submit('a', 1, [create('a:1')]);
    expect(room.submit('a', 1, [create('a:1')])).toEqual({ kind: 'duplicate' });
    const bad: Op = { t: 'set', id: 'a:1', key: 'opacity', value: 7 };
    expect(room.submit('a', 2, [bad]).kind).toBe('rejected');
    expect(room.submit('a', 2, [bad])).toEqual({ kind: 'duplicate' });
    expect(room.seq).toBe(1);
    expect(room.ackedThrough('a')).toBe(2);
  });

  it('serves catch-up history and reports when it is gone', () => {
    const room = new Room(undefined, { historyLimit: 3 });
    for (let i = 1; i <= 5; i++) room.submit('a', i, [create(`a:${i}`)]);
    expect(room.batchesSince(5)).toEqual([]);
    expect(room.batchesSince(3)!.map((b) => b.seq)).toEqual([4, 5]);
    expect(room.batchesSince(2)!.map((b) => b.seq)).toEqual([3, 4, 5]);
    expect(room.batchesSince(1)).toBeNull();
    expect(room.batchesSince(9)).toBeNull();
  });

  it('restores from a snapshot and a batch log', () => {
    const room = new Room();
    room.submit('a', 1, [create('a:1')]);
    const snap = room.snapshot();
    const r2 = room.submit('a', 2, [create('a:2')]);
    const r3 = room.submit('b', 7, [{ t: 'set', id: 'a:1', key: 'x', value: 4 }]);
    const batches = [r2, r3].map((r) => (r.kind === 'applied' ? r.batch : null!));
    const restored = Room.restore(snap, batches);
    expect(restored.seq).toBe(3);
    expect(restored.doc.equals(room.doc)).toBe(true);
    expect(restored.ackedThrough('b')).toBe(7);
    expect(restored.submit('b', 7, [create('b:1')])).toEqual({ kind: 'duplicate' });
  });
});
