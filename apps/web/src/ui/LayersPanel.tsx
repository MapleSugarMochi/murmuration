import { useMemo, useRef, useState } from 'react';
import { ROOT_ID, keyBetweenJittered, type NodeId } from '@tandem/doc-model';
import type { Editor } from '../editor/editor.ts';
import { placeOps, worldOf } from '../editor/transforms.ts';
import { Icons, type IconName } from './icons.tsx';
import { useEditor } from './useEditor.ts';

const ROW = 28;
const OVERSCAN = 10;

interface Row {
  id: NodeId;
  depth: number;
  hasKids: boolean;
}

type Drop = { id: NodeId; where: 'before' | 'after' | 'inside' };

/** Layer tree, topmost first, virtualised so 10k layers stay fast. */
export function LayersPanel({ editor }: { editor: Editor }) {
  const version = useEditor(editor);
  const doc = editor.doc;
  const [collapsed, setCollapsed] = useState<Set<NodeId>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [renaming, setRenaming] = useState<NodeId | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const dragId = useRef<NodeId | null>(null);
  const anchor = useRef<NodeId | null>(null);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const visit = (id: NodeId, depth: number) => {
      const kids = doc.childrenOf(id);
      out.push({ id, depth, hasKids: kids.length > 0 });
      if (!collapsed.has(id)) for (let i = kids.length - 1; i >= 0; i--) visit(kids[i]!, depth + 1);
    };
    const top = doc.childrenOf(ROOT_ID);
    for (let i = top.length - 1; i >= 0; i--) visit(top[i]!, 0);
    return out;
    // `version` changes whenever the document does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, version, collapsed]);

  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN);

  const select = (id: NodeId, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current) {
      const a = rows.findIndex((r) => r.id === anchor.current);
      const b = rows.findIndex((r) => r.id === id);
      if (a >= 0 && b >= 0) {
        editor.setSelection(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.id));
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(editor.selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      editor.setSelection(next);
    } else {
      editor.setSelection([id]);
    }
    anchor.current = id;
  };

  const applyDrop = (target: Drop) => {
    const id = dragId.current;
    if (!id || id === target.id || !editor.canEdit) return;
    // Never drop a frame into its own subtree.
    if (doc.isAncestor(id, target.id)) return;
    const t = doc.get(target.id)!;
    const parentId = target.where === 'inside' ? target.id : t.parentId;
    // Siblings bottom-to-top. The list shows topmost first, so dropping
    // "before" a row means just above it in z-order.
    const sibs = doc.childrenOf(parentId).filter((s) => s !== id);
    const idx = (n: NodeId | undefined) => (n ? doc.get(n)!.index : null);
    let lo: string | null;
    let hi: string | null;
    if (target.where === 'inside') {
      lo = idx(sibs.at(-1));
      hi = null;
    } else {
      const at = sibs.indexOf(target.id);
      if (target.where === 'before') {
        lo = idx(sibs[at]);
        hi = idx(sibs[at + 1]);
      } else {
        lo = idx(sibs[at - 1]);
        hi = idx(sibs[at]);
      }
    }
    if (lo !== null && hi !== null && lo >= hi) return;
    const index = keyBetweenJittered(lo, hi);
    const ops =
      parentId === doc.get(id)!.parentId
        ? []
        : placeOps(doc, editor.scene, id, worldOf(editor.scene, id), parentId);
    editor.sync.apply([
      ...ops.filter((o) => !(o.t === 'set' && o.key === 'index')),
      { t: 'set', id, key: 'index', value: index },
    ]);
  };

  const icon = (type: string): IconName => (type === 'path' ? 'path' : (type as IconName));

  return (
    <aside className="panel" aria-label="Layers">
      <div className="panel-title">Layers</div>
      <div
        className="layers"
        role="tree"
        ref={(el) => {
          if (el && el.clientHeight !== height) setHeight(el.clientHeight);
        }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {rows.length === 0 && (
          <div className="empty">No layers yet. Pick a tool and draw on the canvas.</div>
        )}
        <div style={{ height: rows.length * ROW, position: 'relative' }}>
          {rows.slice(first, last).map((row, i) => {
            const props = doc.get(row.id);
            if (!props) return null;
            const Icon = Icons[icon(props.type)];
            const selected = editor.selection.has(row.id);
            const dropClass = drop?.id === row.id ? `drop-${drop.where}` : '';
            return (
              <div
                key={row.id}
                role="treeitem"
                aria-selected={selected}
                className={`layer-row ${selected ? 'selected' : ''} ${props.visible ? '' : 'hidden-layer'} ${dropClass}`}
                style={{ top: (first + i) * ROW, paddingLeft: 8 + row.depth * 14 }}
                draggable={editor.canEdit && renaming !== row.id}
                onClick={(e) => select(row.id, e)}
                onDoubleClick={() => editor.canEdit && setRenaming(row.id)}
                onMouseEnter={() => {
                  editor.hover = row.id;
                  editor.invalidate();
                }}
                onMouseLeave={() => {
                  editor.hover = null;
                  editor.invalidate();
                }}
                onDragStart={(e) => {
                  dragId.current = row.id;
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  const y = (e.clientY - r.top) / r.height;
                  const where =
                    props.type === 'frame' && y > 0.25 && y < 0.75
                      ? 'inside'
                      : y < 0.5
                        ? 'before'
                        : 'after';
                  if (drop?.id !== row.id || drop.where !== where) setDrop({ id: row.id, where });
                }}
                onDragLeave={() => setDrop(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drop) applyDrop(drop);
                  setDrop(null);
                  dragId.current = null;
                }}
              >
                <span
                  className="twisty"
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = new Set(collapsed);
                    if (next.has(row.id)) next.delete(row.id);
                    else next.add(row.id);
                    setCollapsed(next);
                  }}
                >
                  {row.hasKids &&
                    (collapsed.has(row.id) ? <Icons.chevronRight /> : <Icons.chevronDown />)}
                </span>
                <Icon />
                <span className="layer-name">
                  {renaming === row.id ? (
                    <input
                      autoFocus
                      defaultValue={props.name}
                      maxLength={200}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== props.name) editor.setProps({ name: v }, [row.id]);
                        setRenaming(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  ) : (
                    props.name
                  )}
                </span>
                {editor.canEdit && (
                  <>
                    <button
                      className={`icon-button ${props.locked ? 'on' : ''}`}
                      title={props.locked ? 'Unlock' : 'Lock'}
                      aria-label={props.locked ? 'Unlock' : 'Lock'}
                      onClick={(e) => {
                        e.stopPropagation();
                        editor.setProps({ locked: !props.locked }, [row.id]);
                      }}
                    >
                      {props.locked ? <Icons.lock /> : <Icons.unlock />}
                    </button>
                    <button
                      className={`icon-button ${props.visible ? '' : 'on'}`}
                      title={props.visible ? 'Hide' : 'Show'}
                      aria-label={props.visible ? 'Hide' : 'Show'}
                      onClick={(e) => {
                        e.stopPropagation();
                        editor.setProps({ visible: !props.visible }, [row.id]);
                      }}
                    >
                      {props.visible ? <Icons.eye /> : <Icons.eyeOff />}
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
