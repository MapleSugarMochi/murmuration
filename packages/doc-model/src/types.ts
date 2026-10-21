export type NodeId = string;

/** The implicit document root. It is never stored as a node. */
export const ROOT_ID = 'root';

export const NODE_TYPES = ['rect', 'ellipse', 'line', 'arrow', 'text', 'path', 'frame'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/**
 * Every node carries the full property set so that each property can be
 * resolved independently with last-writer-wins. Properties that do not apply
 * to a node type keep their default value.
 */
export interface NodeProps {
  type: NodeType;
  parentId: NodeId;
  /** Fractional index; siblings sort ascending, ties broken by node id. */
  index: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees in [0, 360). */
  rotation: number;
  /** `#RRGGBBAA` or null for none. */
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  opacity: number;
  cornerRadius: number;
  /** Flat [x0, y0, x1, y1, ...] relative to the node origin. */
  points: number[];
  text: string;
  fontSize: number;
  name: string;
  visible: boolean;
  locked: boolean;
  clipContent: boolean;
}

/** Properties that can change after creation. */
export type PropKey = Exclude<keyof NodeProps, 'type'>;
export type PropValue = NodeProps[PropKey];

export type CreateOp = { t: 'create'; id: NodeId; props: NodeProps };
export type SetOp = { t: 'set'; id: NodeId; key: PropKey; value: PropValue };
export type DeleteOp = { t: 'delete'; id: NodeId };
export type Op = CreateOp | SetOp | DeleteOp;

export const PROP_KEYS: readonly PropKey[] = [
  'parentId',
  'index',
  'x',
  'y',
  'width',
  'height',
  'rotation',
  'fill',
  'stroke',
  'strokeWidth',
  'opacity',
  'cornerRadius',
  'points',
  'text',
  'fontSize',
  'name',
  'visible',
  'locked',
  'clipContent',
];

export function isPropKey(key: unknown): key is PropKey {
  return typeof key === 'string' && (PROP_KEYS as readonly string[]).includes(key);
}

export function isContainerType(type: NodeType): boolean {
  return type === 'frame';
}

const DEFAULT_NAMES: Record<NodeType, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  text: 'Text',
  path: 'Drawing',
  frame: 'Frame',
};

export function defaultProps(type: NodeType, overrides: Partial<NodeProps> = {}): NodeProps {
  const isStrokeOnly = type === 'line' || type === 'arrow' || type === 'path';
  return {
    type,
    parentId: ROOT_ID,
    index: 'a0',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    fill: isStrokeOnly
      ? null
      : type === 'text'
        ? '#1e1e1eff'
        : type === 'frame'
          ? '#ffffffff'
          : '#d9d9d9ff',
    stroke: isStrokeOnly ? '#1e1e1eff' : null,
    strokeWidth: isStrokeOnly ? 2 : 1,
    opacity: 1,
    cornerRadius: 0,
    points: [],
    text: '',
    fontSize: 16,
    name: DEFAULT_NAMES[type],
    visible: true,
    locked: false,
    clipContent: type === 'frame',
    ...overrides,
  };
}
