import {
  ROOT_ID,
  isValidNodeId,
  keysBetween,
  normalizeRotation,
  validateNodeProps,
  type Document,
  type NodeId,
  type NodeProps,
  type Op,
} from '@murmuration/doc-model';
import { apply, rotationOf, type Scene } from '@murmuration/renderer';
import { topLevel, worldOf } from './transforms.ts';

const PREFIX = 'murmuration/v1:';
/** Still accepted when pasting content copied before the rename. */
const LEGACY_PREFIX = 'tandem/v1:';

export interface ClipNode {
  id: NodeId;
  props: NodeProps;
}

/**
 * Serialises the selection with its subtrees. Top-level nodes are stored
 * with their world position and rotation, so they paste in place at the
 * root whatever frame they came from.
 */
export function serialize(doc: Document, scene: Scene, ids: Iterable<NodeId>): string | null {
  const nodes = collect(doc, scene, ids);
  return nodes.length > 0 ? PREFIX + JSON.stringify({ nodes }) : null;
}

export function collect(doc: Document, scene: Scene, ids: Iterable<NodeId>): ClipNode[] {
  const roots = scene.sortByOrder(topLevel(doc, ids));
  const nodes: ClipNode[] = [];
  for (const root of roots) {
    for (const id of doc.subtree(root)) {
      const props = doc.get(id)!;
      if (id !== root) {
        nodes.push({ id, props });
        continue;
      }
      const world = worldOf(scene, id);
      const c = apply(world, { x: props.width / 2, y: props.height / 2 });
      nodes.push({
        id,
        props: {
          ...props,
          parentId: ROOT_ID,
          x: c.x - props.width / 2,
          y: c.y - props.height / 2,
          rotation: normalizeRotation(Math.round(rotationOf(world) * 1000) / 1000),
        },
      });
    }
  }
  return nodes;
}

/** Parses clipboard text; anything unexpected yields null. */
export function parse(text: string): ClipNode[] | null {
  const prefix = [PREFIX, LEGACY_PREFIX].find((p) => text.startsWith(p));
  return prefix ? parseNodes(text.slice(prefix.length)) : null;
}

/** Parses `{ nodes: [...] }` JSON (clipboard or a JSON export). */
export function parseNodes(json: string): ClipNode[] | null {
  try {
    const data = JSON.parse(json) as { nodes?: unknown };
    if (!Array.isArray(data.nodes) || data.nodes.length > 200_000) return null;
    const nodes = data.nodes as ClipNode[];
    const ids = new Set(nodes.map((n) => n?.id));
    for (const n of nodes) {
      if (!isValidNodeId(n?.id) || validateNodeProps(n.props) !== null) return null;
      if (n.props.parentId !== ROOT_ID && !ids.has(n.props.parentId)) return null;
    }
    return nodes;
  } catch {
    return null;
  }
}

/**
 * Ops that recreate nodes under fresh ids. Roots go on top of the root
 * level, shifted by `offset`; children keep their relative placement.
 * Parents must precede children in `nodes` (as `collect` produces).
 */
export function pasteOps(
  doc: Document,
  nodes: readonly ClipNode[],
  newId: () => NodeId,
  offset: number,
): { ops: Op[]; roots: NodeId[] } {
  const idMap = new Map<NodeId, NodeId>();
  for (const n of nodes) idMap.set(n.id, newId());
  const rootNodes = nodes.filter((n) => n.props.parentId === ROOT_ID);
  const last = doc.childrenOf(ROOT_ID).at(-1);
  const keys = keysBetween(last ? doc.get(last)!.index : null, null, rootNodes.length);
  const ops: Op[] = [];
  const roots: NodeId[] = [];
  let k = 0;
  for (const n of nodes) {
    const id = idMap.get(n.id)!;
    if (n.props.parentId === ROOT_ID) {
      roots.push(id);
      ops.push({
        t: 'create',
        id,
        props: { ...n.props, index: keys[k++]!, x: n.props.x + offset, y: n.props.y + offset },
      });
    } else {
      ops.push({ t: 'create', id, props: { ...n.props, parentId: idMap.get(n.props.parentId)! } });
    }
  }
  return { ops, roots };
}
