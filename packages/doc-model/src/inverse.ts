import type { Document } from './document.ts';
import type { Op } from './types.ts';

/**
 * Ops that undo `op`, computed against `doc` *before* `op` is applied.
 * Deleting a node is undone by recreating its whole subtree with the
 * original ids, parents first.
 */
export function inverseOf(doc: Document, op: Op): Op[] {
  switch (op.t) {
    case 'create':
      return doc.has(op.id) ? [] : [{ t: 'delete', id: op.id }];
    case 'set': {
      const prev = doc.get(op.id);
      if (!prev) return [];
      return [{ t: 'set', id: op.id, key: op.key, value: prev[op.key] }];
    }
    case 'delete':
      return doc.subtree(op.id).map((id) => ({ t: 'create', id, props: doc.get(id)! }));
  }
}
