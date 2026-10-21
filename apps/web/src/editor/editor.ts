import {
  ROOT_ID,
  defaultProps,
  keysBetween,
  type NodeId,
  type NodeProps,
  type NodeType,
  type Op,
  type PropKey,
  type PropValue,
} from '@tandem/doc-model';
import {
  Scene,
  apply,
  containsRect,
  drawScene,
  expand,
  measureText,
  rectFromPoints,
  translate,
  visibleWorldRect,
  type Mat,
  type Rect,
  type Vec,
  type View,
} from '@tandem/renderer';
import type { PeerInfo } from '@tandem/protocol';
import type { SyncClient } from '@tandem/sync-client';
import { collect, parse, pasteOps, serialize, type ClipNode } from './clipboard.ts';
import { drawOverlay } from './overlay.ts';
import { snapMove, type Guide } from './snapping.ts';
import {
  HANDLES,
  alignOps,
  distributeOps,
  moveByOps,
  moveOps,
  moveOrigins,
  placeOps,
  r2,
  reorderOps,
  resizeMultiOps,
  resizeSingleOps,
  rotateOps,
  toLocal,
  topIndex,
  topLevel,
  worldOf,
  type Alignment,
  type Handle,
  type MoveOrigin,
  type ResizeStart,
} from './transforms.ts';

export type Tool =
  | 'select'
  | 'hand'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'text'
  | 'path'
  | 'frame';

export const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  h: 'hand',
  r: 'rect',
  o: 'ellipse',
  l: 'line',
  t: 'text',
  p: 'path',
  f: 'frame',
};

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;
const HANDLE_PX = 8;
const ROTATE_OFFSET_PX = 22;
const DRAG_THRESHOLD_PX = 3;
const SNAP_PX = 4;
const MAX_PATH_POINTS = 4000;

type Drag =
  | { kind: 'pan'; startScreen: Vec; startView: View }
  | { kind: 'marquee'; start: Vec; current: Vec; base: Set<NodeId> }
  | {
      kind: 'move';
      startScreen: Vec;
      startWorld: Vec;
      ids: NodeId[];
      origins: Map<NodeId, MoveOrigin>;
      box: Rect;
      started: boolean;
      /** Clicked an already-selected node: plain click narrows to it. */
      narrowTo: NodeId | null;
    }
  | { kind: 'resize'; handle: Handle; starts: ResizeStart[]; box: Rect; single: boolean }
  | { kind: 'rotate'; starts: ResizeStart[]; pivot: Vec; startAngle: number; base: number }
  | {
      kind: 'create';
      tool: 'rect' | 'ellipse' | 'frame' | 'line' | 'arrow';
      id: NodeId;
      parentId: NodeId;
      start: Vec;
      startScreen: Vec;
    }
  | { kind: 'draw'; id: NodeId; parentId: NodeId; points: Vec[] };

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

export interface TextEditState {
  id: NodeId;
  /** Created by this edit; discarded if left empty. */
  isNew: boolean;
}

export interface PointerInput {
  /** CSS pixels relative to the canvas. */
  x: number;
  y: number;
  button: number;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/**
 * Editor state and interaction logic, independent of React. React views
 * subscribe for re-renders; the canvas view calls `renderFrame` on every
 * animation frame and the editor only redraws what is dirty.
 */
export class Editor {
  readonly sync: SyncClient;
  scene: Scene;
  view: View = { x: -200, y: -150, zoom: 1 };
  size = { width: 800, height: 600 };
  tool: Tool = 'select';
  selection = new Set<NodeId>();
  hover: NodeId | null = null;
  textEdit: TextEditState | null = null;
  guides: Guide[] = [];
  following: string | null = null;
  toasts: Toast[] = [];
  cursor = 'default';
  spaceHeld = false;
  chat: { open: boolean; text: string } = { open: false, text: '' };
  /** Smoothed remote cursor positions (world). */
  readonly remoteCursors = new Map<string, Vec>();

  private drag: Drag | null = null;
  private contentDirty = true;
  private overlayDirty = true;
  private listeners = new Set<() => void>();
  private versionValue = 0;
  private notifyScheduled = false;
  private toastSeq = 0;
  private lastPointerWorld: Vec = { x: 0, y: 0 };
  private presenceTimer: number | null = null;
  private chatTimer: number | null = null;
  /** Fit the content once the canvas has its real size. */
  private awaitingLayout = true;
  private pendingPresence: Parameters<SyncClient['setPresence']>[0] = {};
  private clipboardFallback: ClipNode[] | null = null;
  private pasteCount = 0;
  private readonly disposers: Array<() => void> = [];

  constructor(sync: SyncClient) {
    this.sync = sync;
    this.scene = new Scene(sync.display);
    this.disposers.push(
      sync.changes.on((changed, source, author) => this.onDocChange(changed, source, author)),
      sync.peerChanges.on(() => this.onPeersChange()),
      sync.statusChanges.on(() => this.notify()),
      sync.pendingChanges.on(() => this.notify()),
      sync.rejections.on((_id, reason) =>
        this.toast(`A change was rejected by the server: ${reason}`, 'error'),
      ),
      sync.docRenamed.on(() => this.notify()),
    );
  }

  dispose(): void {
    for (const d of this.disposers) d();
    if (this.presenceTimer !== null) clearTimeout(this.presenceTimer);
  }

  // ----------------------------------------------------------------- React glue

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.versionValue;

  /** Coalesces UI notifications to one per microtask. */
  notify(): void {
    this.overlayDirty = true;
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      this.versionValue++;
      for (const fn of this.listeners) fn();
    });
  }

  get doc() {
    return this.sync.display;
  }

  get canEdit(): boolean {
    return this.sync.canEdit;
  }

  get isDragging(): boolean {
    return this.drag !== null;
  }

  get marquee(): Rect | null {
    return this.drag?.kind === 'marquee'
      ? rectFromPoints(this.drag.start, this.drag.current)
      : null;
  }

  peerName(clientId: string | undefined): string {
    return (clientId && this.sync.peers.get(clientId)?.name) || 'someone';
  }

  // ----------------------------------------------------------------- rendering

  renderFrame(
    content: CanvasRenderingContext2D,
    overlay: CanvasRenderingContext2D,
    dpr: number,
  ): void {
    const cursorsMoving = this.stepRemoteCursors();
    if (this.contentDirty) {
      this.contentDirty = false;
      drawScene(content, this.doc, this.scene, this.view, {
        dpr,
        width: this.size.width,
        height: this.size.height,
        hidden: this.textEdit ? new Set([this.textEdit.id]) : undefined,
        frameLabels: true,
        background: '#f5f5f5',
      });
    }
    if (this.overlayDirty || cursorsMoving) {
      this.overlayDirty = false;
      drawOverlay(this, overlay, dpr);
    }
  }

  invalidate(): void {
    this.contentDirty = true;
    this.overlayDirty = true;
  }

  setSize(width: number, height: number): void {
    const first = this.awaitingLayout;
    this.awaitingLayout = false;
    this.size = { width, height };
    if (first) this.fitAll();
    this.invalidate();
    this.queuePresence({ viewport: this.viewportPresence() });
  }

  // ----------------------------------------------------------------- coordinates

  toWorld(p: Vec): Vec {
    return { x: this.view.x + p.x / this.view.zoom, y: this.view.y + p.y / this.view.zoom };
  }

  toScreen(p: Vec): Vec {
    return { x: (p.x - this.view.x) * this.view.zoom, y: (p.y - this.view.y) * this.view.zoom };
  }

  visibleWorld(): Rect {
    return visibleWorldRect(this.view, this.size.width, this.size.height);
  }

  // ----------------------------------------------------------------- viewport

  setView(view: View, fromUser = true): void {
    this.view = { ...view, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom)) };
    if (fromUser && this.following) this.following = null;
    this.invalidate();
    this.queuePresence({ viewport: this.viewportPresence() });
    this.notify();
  }

  zoomAt(screen: Vec, factor: number): void {
    const before = this.toWorld(screen);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.view.zoom * factor));
    this.setView({ x: before.x - screen.x / zoom, y: before.y - screen.y / zoom, zoom });
  }

  zoomTo(zoom: number): void {
    this.zoomAt({ x: this.size.width / 2, y: this.size.height / 2 }, zoom / this.view.zoom);
  }

  panBy(dx: number, dy: number): void {
    this.setView({
      ...this.view,
      x: this.view.x + dx / this.view.zoom,
      y: this.view.y + dy / this.view.zoom,
    });
  }

  fitTo(rect: Rect | null, maxZoom = 1): void {
    if (!rect) return;
    const pad = 64;
    const zoom = Math.min(
      maxZoom,
      (this.size.width - pad * 2) / Math.max(rect.width, 1),
      (this.size.height - pad * 2) / Math.max(rect.height, 1),
    );
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    this.setView({
      x: rect.x + rect.width / 2 - this.size.width / 2 / z,
      y: rect.y + rect.height / 2 - this.size.height / 2 / z,
      zoom: z,
    });
  }

  fitAll(): void {
    this.fitTo(this.scene.boundsOfNodes(this.doc.childrenOf(ROOT_ID)));
  }

  fitSelection(): void {
    this.fitTo(this.scene.boundsOfNodes(this.selection), 4);
  }

  // ----------------------------------------------------------------- selection

  setSelection(ids: Iterable<NodeId>): void {
    const next = new Set([...ids].filter((id) => this.doc.has(id)));
    const same =
      next.size === this.selection.size && [...next].every((id) => this.selection.has(id));
    if (same) return;
    this.selection = next;
    this.queuePresence({ selection: [...next] });
    this.notify();
  }

  selectAll(): void {
    this.setSelection(
      this.doc
        .childrenOf(ROOT_ID)
        .filter((id) => this.scene.isShown(id) && !this.scene.isLocked(id)),
    );
  }

  setTool(tool: Tool): void {
    if (!this.canEdit && tool !== 'select' && tool !== 'hand') return;
    this.tool = tool;
    this.updateCursor();
    this.notify();
  }

  /** Box-space → world transform for the selection, plus its size. */
  selectionFrame(): { m: Mat; width: number; height: number; single: NodeId | null } | null {
    const ids = [...this.selection].filter((id) => this.doc.has(id));
    if (ids.length === 0) return null;
    if (ids.length === 1) {
      const id = ids[0]!;
      const props = this.doc.get(id)!;
      const g = this.scene.geometry(id);
      if (!g) return null;
      return { m: g.world, width: props.width, height: props.height, single: id };
    }
    const box = this.scene.boundsOfNodes(ids);
    if (!box) return null;
    return { m: translate(box.x, box.y), width: box.width, height: box.height, single: null };
  }

  /** Whether the selection shows resize handles. */
  canResizeSelection(): boolean {
    if (!this.canEdit || this.selection.size === 0) return false;
    if (this.selection.size === 1) {
      const p = this.doc.get([...this.selection][0]!);
      return !!p && p.type !== 'text';
    }
    return true;
  }

  handlePosition(handle: Handle, width: number, height: number): Vec {
    const x = handle.includes('w') ? 0 : handle.includes('e') ? width : width / 2;
    const y = handle.includes('n') ? 0 : handle.includes('s') ? height : height / 2;
    return { x, y };
  }

  /** Which selection control (if any) is under a screen point. */
  controlAt(screen: Vec): { kind: 'handle'; handle: Handle } | { kind: 'rotate' } | null {
    if (!this.canEdit) return null;
    const frame = this.selectionFrame();
    if (!frame) return null;
    const toScreen = (p: Vec) => this.toScreen(apply(frame.m, p));
    const top = toScreen({ x: frame.width / 2, y: 0 });
    const center = toScreen({ x: frame.width / 2, y: frame.height / 2 });
    const dir = { x: top.x - center.x, y: top.y - center.y };
    const len = Math.hypot(dir.x, dir.y) || 1;
    const rot = {
      x: top.x + (dir.x / len) * ROTATE_OFFSET_PX,
      y: top.y + (dir.y / len) * ROTATE_OFFSET_PX,
    };
    if (Math.hypot(screen.x - rot.x, screen.y - rot.y) <= HANDLE_PX) return { kind: 'rotate' };
    if (!this.canResizeSelection()) return null;
    for (const handle of HANDLES) {
      const p = toScreen(this.handlePosition(handle, frame.width, frame.height));
      if (Math.abs(screen.x - p.x) <= HANDLE_PX && Math.abs(screen.y - p.y) <= HANDLE_PX) {
        return { kind: 'handle', handle };
      }
    }
    return null;
  }

  // ----------------------------------------------------------------- pointer input

  pointerDown(e: PointerInput): void {
    const world = this.toWorld(e);
    this.lastPointerWorld = world;
    if (this.textEdit) this.endTextEdit();
    if (e.button === 1 || this.tool === 'hand' || this.spaceHeld) {
      this.drag = { kind: 'pan', startScreen: { x: e.x, y: e.y }, startView: { ...this.view } };
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;
    const tool = this.canEdit ? this.tool : 'select';

    if (tool === 'select') return this.selectDown(e, world);
    if (tool === 'text') return this.createText(world);
    if (tool === 'path') return this.startDraw(world);
    this.startCreate(tool, e, world);
  }

  pointerMove(e: PointerInput): void {
    const world = this.toWorld(e);
    this.lastPointerWorld = world;
    this.queuePresence({ cursor: { x: r2(world.x), y: r2(world.y) } });
    const drag = this.drag;
    if (!drag) {
      this.updateHover(e, world);
      return;
    }
    switch (drag.kind) {
      case 'pan':
        this.setView({
          ...drag.startView,
          x: drag.startView.x - (e.x - drag.startScreen.x) / this.view.zoom,
          y: drag.startView.y - (e.y - drag.startScreen.y) / this.view.zoom,
        });
        return;
      case 'marquee': {
        drag.current = world;
        const r = rectFromPoints(drag.start, world);
        const hits = this.scene
          .queryRect(r)
          .filter((id) => {
            const p = this.doc.get(id);
            return (
              p && p.parentId === ROOT_ID && this.scene.isShown(id) && !this.scene.isLocked(id)
            );
          })
          .filter((id) => containsRect(r, this.scene.geometry(id)!.bounds));
        this.setSelection([...drag.base, ...hits]);
        this.overlayDirty = true;
        return;
      }
      case 'move':
        return this.dragMove(drag, e, world);
      case 'resize': {
        const ops = drag.single
          ? resizeSingleOps(this.scene, drag.starts[0]!, drag.handle, world, e.shift, e.alt)
          : resizeMultiOps(this.scene, drag.starts, drag.box, drag.handle, world, e.shift, e.alt);
        this.sync.apply(ops);
        return;
      }
      case 'rotate': {
        let deg =
          ((Math.atan2(world.y - drag.pivot.y, world.x - drag.pivot.x) - drag.startAngle) * 180) /
          Math.PI;
        if (e.shift) deg = Math.round((drag.base + deg) / 15) * 15 - drag.base;
        this.sync.apply(rotateOps(this.scene, drag.starts, drag.pivot, deg));
        return;
      }
      case 'create':
        return this.dragCreate(drag, e, world);
      case 'draw':
        return this.dragDraw(drag, world);
    }
  }

  pointerUp(e: PointerInput): void {
    const drag = this.drag;
    this.drag = null;
    this.guides = [];
    if (!drag) return;
    switch (drag.kind) {
      case 'move':
        if (!drag.started && drag.narrowTo) this.setSelection([drag.narrowTo]);
        if (drag.started) this.reparentAfterMove(drag.ids, this.toWorld(e));
        this.sync.commitTransaction();
        break;
      case 'resize':
      case 'rotate':
        this.sync.commitTransaction();
        break;
      case 'create':
        this.finishCreate(drag, e);
        break;
      case 'draw':
        this.sync.commitTransaction();
        this.setSelection([drag.id]);
        this.setTool('select');
        break;
      default:
        break;
    }
    this.updateCursor();
    this.notify();
  }

  pointerLeave(): void {
    this.queuePresence({ cursor: null });
    if (this.hover) {
      this.hover = null;
      this.overlayDirty = true;
    }
  }

  doubleClick(e: PointerInput): void {
    if (!this.canEdit) return;
    const id = this.scene.hitTest(this.toWorld(e), { tolerance: 4 / this.view.zoom });
    if (id && this.doc.get(id)?.type === 'text') {
      this.setSelection([id]);
      this.startTextEdit(id, false);
    }
  }

  wheel(e: { x: number; y: number; dx: number; dy: number; zoom: boolean }): void {
    if (e.zoom) this.zoomAt(e, Math.exp(-e.dy * 0.01));
    else this.panBy(e.dx, e.dy);
  }

  private selectDown(e: PointerInput, world: Vec): void {
    const control = this.controlAt(e);
    if (control) return this.startTransform(control, world);
    const target = this.scene.hitTest(world, { tolerance: 4 / this.view.zoom });
    if (!target) {
      if (!e.shift) this.setSelection([]);
      this.drag = { kind: 'marquee', start: world, current: world, base: new Set(this.selection) };
      return;
    }
    if (e.shift) {
      const next = new Set(this.selection);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      this.setSelection(next);
      return;
    }
    const wasSelected = this.selection.has(target);
    if (!wasSelected) this.setSelection([target]);
    if (!this.canEdit) return;
    const ids = topLevel(this.doc, this.selection);
    this.drag = {
      kind: 'move',
      startScreen: { x: e.x, y: e.y },
      startWorld: world,
      ids,
      origins: moveOrigins(this.doc, this.scene, ids),
      box: this.scene.boundsOfNodes(ids) ?? { x: world.x, y: world.y, width: 0, height: 0 },
      started: false,
      narrowTo: wasSelected && this.selection.size > 1 ? target : null,
    };
  }

  private startTransform(
    control: { kind: 'handle'; handle: Handle } | { kind: 'rotate' },
    world: Vec,
  ): void {
    const ids = topLevel(this.doc, this.selection);
    const starts: ResizeStart[] = ids.map((id) => ({
      id,
      props: this.doc.get(id)!,
      world: worldOf(this.scene, id),
    }));
    this.sync.beginTransaction();
    if (control.kind === 'rotate') {
      const box = this.scene.boundsOfNodes(ids)!;
      const single = ids.length === 1 ? starts[0]! : null;
      const pivot = single
        ? apply(single.world, { x: single.props.width / 2, y: single.props.height / 2 })
        : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      this.drag = {
        kind: 'rotate',
        starts,
        pivot,
        startAngle: Math.atan2(world.y - pivot.y, world.x - pivot.x),
        base: single ? single.props.rotation : 0,
      };
    } else {
      this.drag = {
        kind: 'resize',
        handle: control.handle,
        starts,
        box: this.scene.boundsOfNodes(ids)!,
        single: ids.length === 1,
      };
    }
  }

  private dragMove(drag: Extract<Drag, { kind: 'move' }>, e: PointerInput, world: Vec): void {
    if (!drag.started) {
      if (Math.hypot(e.x - drag.startScreen.x, e.y - drag.startScreen.y) < DRAG_THRESHOLD_PX)
        return;
      drag.started = true;
      this.sync.beginTransaction();
    }
    let delta = { x: world.x - drag.startWorld.x, y: world.y - drag.startWorld.y };
    if (e.shift) {
      if (Math.abs(delta.x) > Math.abs(delta.y)) delta.y = 0;
      else delta.x = 0;
    }
    this.guides = [];
    if (!e.meta) {
      const moving = new Set(drag.ids);
      const snap = snapMove(
        this.scene,
        drag.box,
        delta,
        (id) => this.isInSubtreeOf(id, moving),
        expand(this.visibleWorld(), 0),
        SNAP_PX / this.view.zoom,
      );
      delta = snap.delta;
      this.guides = snap.guides;
    }
    this.sync.apply(moveOps(drag.origins, delta));
  }

  private isInSubtreeOf(id: NodeId, roots: Set<NodeId>): boolean {
    let cur: NodeId | undefined = id;
    while (cur && cur !== ROOT_ID) {
      if (roots.has(cur)) return true;
      cur = this.doc.get(cur)?.parentId;
    }
    return false;
  }

  /** Dropping onto a frame moves nodes into it; off a frame, out of it. */
  private reparentAfterMove(ids: NodeId[], pointer: Vec): void {
    const moving = new Set(ids);
    const target = this.scene.frameAt(pointer, moving);
    const ops: Op[] = [];
    for (const id of ids) {
      const props = this.doc.get(id);
      if (!props || props.parentId === target) continue;
      ops.push(...placeOps(this.doc, this.scene, id, worldOf(this.scene, id), target));
    }
    if (ops.length > 0) this.sync.apply(ops);
  }

  // ----------------------------------------------------------------- creation

  private nodeProps(type: NodeType, parentId: NodeId, overrides: Partial<NodeProps>): NodeProps {
    return defaultProps(type, { parentId, index: topIndex(this.doc, parentId), ...overrides });
  }

  private startCreate(
    tool: 'rect' | 'ellipse' | 'frame' | 'line' | 'arrow',
    e: PointerInput,
    world: Vec,
  ): void {
    // New frames go to the root; other shapes into the frame under the pointer.
    const parentId = tool === 'frame' ? ROOT_ID : this.scene.frameAt(world);
    const local = toLocal(this.scene, parentId, world);
    const id = this.sync.newNodeId();
    const isLine = tool === 'line' || tool === 'arrow';
    this.sync.beginTransaction();
    this.sync.apply([
      {
        t: 'create',
        id,
        props: this.nodeProps(tool, parentId, {
          x: r2(local.x),
          y: r2(local.y),
          width: isLine ? 0 : 1,
          height: isLine ? 0 : 1,
          points: isLine ? [0, 0, 0, 0] : [],
          name: `${this.nodeProps(tool, parentId, {}).name} ${this.doc.size + 1}`,
        }),
      },
    ]);
    this.drag = {
      kind: 'create',
      tool,
      id,
      parentId,
      start: local,
      startScreen: { x: e.x, y: e.y },
    };
    this.setSelection([id]);
  }

  private dragCreate(drag: Extract<Drag, { kind: 'create' }>, e: PointerInput, world: Vec): void {
    let p = toLocal(this.scene, drag.parentId, world);
    const { start } = drag;
    if (drag.tool === 'line' || drag.tool === 'arrow') {
      if (e.shift) {
        const angle =
          Math.round(Math.atan2(p.y - start.y, p.x - start.x) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(p.x - start.x, p.y - start.y);
        p = { x: start.x + Math.cos(angle) * len, y: start.y + Math.sin(angle) * len };
      }
      const r = rectFromPoints(start, p);
      this.sync.apply([
        { t: 'set', id: drag.id, key: 'x', value: r2(r.x) },
        { t: 'set', id: drag.id, key: 'y', value: r2(r.y) },
        { t: 'set', id: drag.id, key: 'width', value: r2(r.width) },
        { t: 'set', id: drag.id, key: 'height', value: r2(r.height) },
        {
          t: 'set',
          id: drag.id,
          key: 'points',
          value: [r2(start.x - r.x), r2(start.y - r.y), r2(p.x - r.x), r2(p.y - r.y)],
        },
      ]);
      return;
    }
    let dx = p.x - start.x;
    let dy = p.y - start.y;
    if (e.shift) {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      dx = s * Math.sign(dx || 1);
      dy = s * Math.sign(dy || 1);
    }
    const r = e.alt
      ? {
          x: start.x - Math.abs(dx),
          y: start.y - Math.abs(dy),
          width: Math.abs(dx) * 2,
          height: Math.abs(dy) * 2,
        }
      : rectFromPoints(start, { x: start.x + dx, y: start.y + dy });
    this.sync.apply([
      { t: 'set', id: drag.id, key: 'x', value: r2(r.x) },
      { t: 'set', id: drag.id, key: 'y', value: r2(r.y) },
      { t: 'set', id: drag.id, key: 'width', value: r2(r.width) },
      { t: 'set', id: drag.id, key: 'height', value: r2(r.height) },
    ]);
  }

  private finishCreate(drag: Extract<Drag, { kind: 'create' }>, e: PointerInput): void {
    const moved =
      Math.hypot(e.x - drag.startScreen.x, e.y - drag.startScreen.y) >= DRAG_THRESHOLD_PX;
    if (!moved) {
      // A click creates a default-sized shape centred on the pointer.
      const size = drag.tool === 'frame' ? 400 : 100;
      const isLine = drag.tool === 'line' || drag.tool === 'arrow';
      this.sync.apply([
        { t: 'set', id: drag.id, key: 'x', value: r2(drag.start.x - (isLine ? 0 : size / 2)) },
        { t: 'set', id: drag.id, key: 'y', value: r2(drag.start.y - (isLine ? 0 : size / 2)) },
        { t: 'set', id: drag.id, key: 'width', value: size },
        {
          t: 'set',
          id: drag.id,
          key: 'height',
          value: isLine ? 0 : drag.tool === 'frame' ? 300 : size,
        },
        ...(isLine
          ? [{ t: 'set' as const, id: drag.id, key: 'points' as const, value: [0, 0, size, 0] }]
          : []),
      ]);
    }
    this.sync.commitTransaction();
    this.setTool('select');
  }

  private createText(world: Vec): void {
    const parentId = this.scene.frameAt(world);
    const local = toLocal(this.scene, parentId, world);
    const id = this.sync.newNodeId();
    const fontSize = 24;
    const size = measureText('', fontSize);
    this.sync.beginTransaction();
    this.sync.apply([
      {
        t: 'create',
        id,
        props: this.nodeProps('text', parentId, {
          x: r2(local.x),
          y: r2(local.y - size.height / 2),
          width: size.width,
          height: size.height,
          fontSize,
        }),
      },
    ]);
    this.setSelection([id]);
    this.setTool('select');
    this.startTextEdit(id, true);
  }

  private startDraw(world: Vec): void {
    const parentId = this.scene.frameAt(world);
    const local = toLocal(this.scene, parentId, world);
    const id = this.sync.newNodeId();
    this.sync.beginTransaction();
    this.sync.apply([
      {
        t: 'create',
        id,
        props: this.nodeProps('path', parentId, {
          x: r2(local.x),
          y: r2(local.y),
          width: 0,
          height: 0,
          points: [0, 0],
        }),
      },
    ]);
    this.drag = { kind: 'draw', id, parentId, points: [local] };
  }

  private dragDraw(drag: Extract<Drag, { kind: 'draw' }>, world: Vec): void {
    const p = toLocal(this.scene, drag.parentId, world);
    const last = drag.points.at(-1)!;
    if (Math.hypot(p.x - last.x, p.y - last.y) < 2 / this.view.zoom) return;
    if (drag.points.length >= MAX_PATH_POINTS) return;
    drag.points.push(p);
    const r = rectFromPoints(
      { x: Math.min(...drag.points.map((q) => q.x)), y: Math.min(...drag.points.map((q) => q.y)) },
      { x: Math.max(...drag.points.map((q) => q.x)), y: Math.max(...drag.points.map((q) => q.y)) },
    );
    this.sync.apply([
      { t: 'set', id: drag.id, key: 'x', value: r2(r.x) },
      { t: 'set', id: drag.id, key: 'y', value: r2(r.y) },
      { t: 'set', id: drag.id, key: 'width', value: r2(r.width) },
      { t: 'set', id: drag.id, key: 'height', value: r2(r.height) },
      {
        t: 'set',
        id: drag.id,
        key: 'points',
        value: drag.points.flatMap((q) => [r2(q.x - r.x), r2(q.y - r.y)]),
      },
    ]);
  }

  // ----------------------------------------------------------------- text editing

  startTextEdit(id: NodeId, isNew: boolean): void {
    if (!this.canEdit) return;
    if (!isNew) this.sync.beginTransaction();
    this.textEdit = { id, isNew };
    this.invalidate();
    this.notify();
  }

  /** Called by the text overlay on every input event. */
  updateText(text: string): void {
    const edit = this.textEdit;
    const props = edit && this.doc.get(edit.id);
    if (!edit || !props) return;
    const size = measureText(text || ' ', props.fontSize);
    this.sync.apply([
      { t: 'set', id: edit.id, key: 'text', value: text },
      { t: 'set', id: edit.id, key: 'width', value: size.width },
      { t: 'set', id: edit.id, key: 'height', value: size.height },
    ]);
  }

  endTextEdit(): void {
    const edit = this.textEdit;
    if (!edit) return;
    this.textEdit = null;
    const props = this.doc.get(edit.id);
    if (props && props.text.trim() === '') {
      this.sync.apply([{ t: 'delete', id: edit.id }]);
      // A new text that ends empty leaves no trace in undo history.
      this.sync.commitTransaction({ discard: edit.isNew });
      this.setSelection([]);
    } else {
      this.sync.commitTransaction();
    }
    this.invalidate();
    this.notify();
  }

  // ----------------------------------------------------------------- commands

  /** Applies property values to every selected node (properties panel). */
  setProps(values: Partial<Record<PropKey, PropValue>>, ids: NodeId[] = [...this.selection]): void {
    const ops: Op[] = [];
    for (const id of ids) {
      const props = this.doc.get(id);
      if (!props) continue;
      for (const [key, value] of Object.entries(values) as Array<[PropKey, PropValue]>) {
        if (key === 'width' || key === 'height') {
          ops.push(...this.resizeTo(id, props, key, value as number));
        } else if (key === 'fontSize' && props.type === 'text') {
          const size = measureText(props.text || ' ', value as number);
          ops.push(
            { t: 'set', id, key, value },
            { t: 'set', id, key: 'width', value: size.width },
            { t: 'set', id, key: 'height', value: size.height },
          );
        } else {
          ops.push({ t: 'set', id, key, value });
        }
      }
    }
    this.sync.apply(ops);
  }

  private resizeTo(id: NodeId, props: NodeProps, key: 'width' | 'height', value: number): Op[] {
    const ops: Op[] = [{ t: 'set', id, key, value }];
    const old = props[key];
    if (props.points.length > 0 && old > 0) {
      const s = value / old;
      const axis = key === 'width' ? 0 : 1;
      ops.push({
        t: 'set',
        id,
        key: 'points',
        value: props.points.map((v, i) => (i % 2 === axis ? r2(v * s) : v)),
      });
    }
    return ops;
  }

  deleteSelection(): void {
    const ids = topLevel(this.doc, this.selection);
    if (ids.length === 0) return;
    this.sync.apply(ids.map((id) => ({ t: 'delete', id })));
    this.setSelection([]);
  }

  nudge(dx: number, dy: number): void {
    const ids = topLevel(this.doc, this.selection);
    if (ids.length > 0) this.sync.apply(moveByOps(this.doc, this.scene, ids, { x: dx, y: dy }));
  }

  reorder(how: 'forward' | 'backward' | 'front' | 'back'): void {
    const ids = this.scene.sortByOrder(topLevel(this.doc, this.selection));
    this.sync.apply(
      reorderOps(this.doc, how === 'forward' || how === 'front' ? ids.reverse() : ids, how),
    );
  }

  align(how: Alignment): void {
    this.sync.apply(alignOps(this.doc, this.scene, topLevel(this.doc, this.selection), how));
  }

  distribute(axis: 'x' | 'y'): void {
    this.sync.apply(distributeOps(this.doc, this.scene, topLevel(this.doc, this.selection), axis));
  }

  /** Wraps the selection in a new frame (Cmd+G). */
  frameSelection(): void {
    const ids = this.scene.sortByOrder(topLevel(this.doc, this.selection));
    if (ids.length === 0) return;
    const parentId = this.doc.get(ids[0]!)!.parentId;
    if (ids.some((id) => this.doc.get(id)!.parentId !== parentId)) {
      this.toast('Select layers that share a parent to frame them');
      return;
    }
    const box = this.scene.boundsOfNodes(ids)!;
    const frameId = this.sync.newNodeId();
    const topLeft = toLocal(this.scene, parentId, { x: box.x, y: box.y });
    // Place the frame where the bottom-most selected node was.
    const firstIndex = this.doc.get(ids[0]!)!.index;
    this.sync.beginTransaction();
    this.sync.apply([
      {
        t: 'create',
        id: frameId,
        props: defaultProps('frame', {
          parentId,
          index: firstIndex,
          x: r2(topLeft.x),
          y: r2(topLeft.y),
          width: r2(box.width),
          height: r2(box.height),
          fill: null,
          clipContent: false,
          name: `Frame ${this.doc.size + 1}`,
        }),
      },
    ]);
    const keys = keysBetween(null, null, ids.length);
    const ops: Op[] = [];
    ids.forEach((id, i) => {
      ops.push(...placeOps(this.doc, this.scene, id, worldOf(this.scene, id), frameId));
      ops.push({ t: 'set', id, key: 'index', value: keys[i]! });
    });
    this.sync.apply(ops);
    this.sync.commitTransaction();
    this.setSelection([frameId]);
  }

  /** Moves a frame's children to its parent and deletes it (Shift+Cmd+G). */
  unframeSelection(): void {
    const frames = [...this.selection].filter((id) => this.doc.get(id)?.type === 'frame');
    if (frames.length === 0) return;
    const freed: NodeId[] = [];
    this.sync.beginTransaction();
    for (const frameId of frames) {
      const frame = this.doc.get(frameId)!;
      const kids = [...this.doc.childrenOf(frameId)];
      const ops: Op[] = [];
      for (const id of kids)
        ops.push(...placeOps(this.doc, this.scene, id, worldOf(this.scene, id), frame.parentId));
      this.sync.apply(ops);
      this.sync.apply([{ t: 'delete', id: frameId }]);
      freed.push(...kids);
    }
    this.sync.commitTransaction();
    this.setSelection(freed);
  }

  undo(): void {
    this.cancelDrag();
    this.sync.undo();
    this.setSelection([...this.selection]);
  }

  redo(): void {
    this.cancelDrag();
    this.sync.redo();
    this.setSelection([...this.selection]);
  }

  copy(): string | null {
    const nodes = collect(this.doc, this.scene, this.selection);
    if (nodes.length === 0) return null;
    this.clipboardFallback = nodes;
    this.pasteCount = 0;
    return serialize(this.doc, this.scene, this.selection);
  }

  cut(): string | null {
    const text = this.copy();
    if (text) this.deleteSelection();
    return text;
  }

  /** Pastes clipboard text, or the in-app clipboard when text is absent. */
  paste(text: string | null): void {
    if (!this.canEdit) return;
    const nodes = (text && parse(text)) || this.clipboardFallback;
    if (!nodes || nodes.length === 0) return;
    this.pasteCount++;
    const { ops, roots } = pasteOps(
      this.doc,
      nodes,
      () => this.sync.newNodeId(),
      10 * this.pasteCount,
    );
    this.sync.apply(ops);
    this.setSelection(roots);
  }

  duplicate(): void {
    const nodes = collect(this.doc, this.scene, this.selection);
    if (nodes.length === 0) return;
    const { ops, roots } = pasteOps(this.doc, nodes, () => this.sync.newNodeId(), 10);
    this.sync.apply(ops);
    this.setSelection(roots);
  }

  /** Imports nodes from a JSON export, centred in the viewport. */
  importNodes(nodes: ClipNode[]): void {
    const { ops, roots } = pasteOps(this.doc, nodes, () => this.sync.newNodeId(), 0);
    this.sync.apply(ops);
    this.setSelection(roots);
    this.fitSelection();
  }

  exportNodes(): ClipNode[] {
    return collect(this.doc, this.scene, this.doc.childrenOf(ROOT_ID));
  }

  // ----------------------------------------------------------------- keyboard

  /** Returns true when the key was handled. */
  keyDown(e: KeyboardEvent): boolean {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (e.key === ' ') {
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        this.updateCursor();
      }
      return true;
    }
    if (e.key === 'Escape') {
      if (this.chat.open) this.closeChat();
      else if (this.drag) this.cancelDrag();
      else if (this.tool !== 'select') this.setTool('select');
      else this.setSelection([]);
      return true;
    }
    if (mod && key === 'z') {
      if (e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if (mod && key === 'y') {
      this.redo();
      return true;
    }
    if (mod && key === 'a') {
      this.selectAll();
      return true;
    }
    if (mod && key === 'd') {
      this.duplicate();
      return true;
    }
    if (mod && key === 'g') {
      if (e.shiftKey) this.unframeSelection();
      else this.frameSelection();
      return true;
    }
    if (mod && (key === '=' || key === '+')) {
      this.zoomTo(this.view.zoom * 1.25);
      return true;
    }
    if (mod && key === '-') {
      this.zoomTo(this.view.zoom / 1.25);
      return true;
    }
    if (e.key === ']' || e.key === '[') {
      const up = e.key === ']';
      this.reorder(mod ? (up ? 'front' : 'back') : up ? 'forward' : 'backward');
      return true;
    }
    if (e.shiftKey && (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit0')) {
      if (e.code === 'Digit1') this.fitAll();
      else if (e.code === 'Digit2') this.fitSelection();
      else this.zoomTo(1);
      return true;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.deleteSelection();
      return true;
    }
    if (e.key.startsWith('Arrow')) {
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      this.nudge(dx, dy);
      return true;
    }
    if (e.key === 'Enter' && this.selection.size === 1) {
      const id = [...this.selection][0]!;
      if (this.doc.get(id)?.type === 'text') {
        this.startTextEdit(id, false);
        return true;
      }
    }
    if (e.key === '/' && !mod) {
      this.chat = { open: true, text: '' };
      this.notify();
      return true;
    }
    if (!mod && !e.altKey) {
      if (e.shiftKey && key === 'l') {
        this.setTool('arrow');
        return true;
      }
      const tool = TOOL_KEYS[key];
      if (tool && !e.shiftKey) {
        this.setTool(tool);
        return true;
      }
    }
    return false;
  }

  keyUp(e: KeyboardEvent): void {
    if (e.key === ' ') {
      this.spaceHeld = false;
      this.updateCursor();
    }
  }

  // ----------------------------------------------------------------- presence

  setChat(text: string): void {
    this.chat = { open: true, text };
    this.queuePresence({ chat: text || null });
    this.notify();
  }

  closeChat(): void {
    if (this.chatTimer !== null) clearTimeout(this.chatTimer);
    this.chatTimer = null;
    this.chat = { open: false, text: '' };
    this.queuePresence({ chat: null });
    this.notify();
  }

  /** Hides the input but leaves the message beside the cursor for 5 s. */
  commitChat(): void {
    if (!this.chat.open) return;
    if (!this.chat.text) return this.closeChat();
    this.chat = { open: false, text: this.chat.text };
    if (this.chatTimer !== null) clearTimeout(this.chatTimer);
    this.chatTimer = window.setTimeout(() => this.closeChat(), 5000);
    this.notify();
  }

  follow(clientId: string | null): void {
    this.following = clientId;
    this.applyFollow();
    this.notify();
  }

  private viewportPresence() {
    return { x: r2(this.view.x), y: r2(this.view.y), zoom: this.view.zoom, ...this.size };
  }

  /** Batches presence updates to at most 20 per second. */
  private queuePresence(update: Parameters<SyncClient['setPresence']>[0]): void {
    Object.assign(this.pendingPresence, update);
    if (this.presenceTimer !== null) return;
    this.presenceTimer = window.setTimeout(() => {
      this.presenceTimer = null;
      const p = this.pendingPresence;
      this.pendingPresence = {};
      this.sync.setPresence(p);
    }, 50);
  }

  private applyFollow(): void {
    if (!this.following) return;
    const peer = this.sync.peers.get(this.following);
    const vp = peer?.presence.viewport;
    if (!peer) {
      this.following = null;
      return;
    }
    if (!vp) return;
    const zoom = vp.zoom;
    const cx = vp.x + vp.width / zoom / 2;
    const cy = vp.y + vp.height / zoom / 2;
    this.setView(
      { x: cx - this.size.width / zoom / 2, y: cy - this.size.height / zoom / 2, zoom },
      false,
    );
  }

  /** Eases remote cursors toward their latest position; true while moving. */
  private stepRemoteCursors(): boolean {
    let moving = false;
    for (const [id, peer] of this.sync.peers) {
      const target = peer.presence.cursor;
      if (!target) {
        this.remoteCursors.delete(id);
        continue;
      }
      const cur = this.remoteCursors.get(id);
      if (!cur) {
        this.remoteCursors.set(id, { ...target });
        continue;
      }
      const dx = target.x - cur.x;
      const dy = target.y - cur.y;
      if (Math.abs(dx) * this.view.zoom < 0.5 && Math.abs(dy) * this.view.zoom < 0.5) {
        cur.x = target.x;
        cur.y = target.y;
        continue;
      }
      cur.x += dx * 0.35;
      cur.y += dy * 0.35;
      moving = true;
    }
    for (const id of this.remoteCursors.keys())
      if (!this.sync.peers.has(id)) this.remoteCursors.delete(id);
    return moving;
  }

  peersList(): PeerInfo[] {
    return [...this.sync.peers.values()];
  }

  // ----------------------------------------------------------------- internals

  toast(text: string, kind: Toast['kind'] = 'info'): void {
    const toast = { id: ++this.toastSeq, text, kind };
    this.toasts = [...this.toasts, toast].slice(-4);
    this.notify();
    window.setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== toast.id);
      this.notify();
    }, 4000);
  }

  private cancelDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.guides = [];
    if (this.sync.inTransaction) this.sync.commitTransaction();
    this.updateCursor();
    this.notify();
  }

  private onDocChange(changed: Set<NodeId>, source: 'local' | 'remote', author?: string): void {
    this.scene.update(this.doc, changed);
    this.invalidate();
    if (source === 'remote') {
      const drag = this.drag;
      const ids =
        drag?.kind === 'move'
          ? drag.ids
          : drag?.kind === 'resize' || drag?.kind === 'rotate'
            ? drag.starts.map((s) => s.id)
            : drag?.kind === 'create' || drag?.kind === 'draw'
              ? [drag.id]
              : [];
      if (ids.some((id) => !this.doc.has(id))) {
        this.cancelDrag();
        this.toast(`This layer was deleted by ${this.peerName(author)}`);
      }
      if (this.textEdit && !this.doc.has(this.textEdit.id)) {
        this.textEdit = null;
        if (this.sync.inTransaction) this.sync.commitTransaction();
        this.toast(`This text was deleted by ${this.peerName(author)}`);
      }
      if ([...this.selection].some((id) => !this.doc.has(id))) {
        this.setSelection([...this.selection]);
      }
      if (this.hover && !this.doc.has(this.hover)) this.hover = null;
    }
    this.notify();
  }

  private onPeersChange(): void {
    this.applyFollow();
    this.overlayDirty = true;
    this.notify();
  }

  private updateHover(e: PointerInput, world: Vec): void {
    const control = this.controlAt(e);
    let cursor = 'default';
    if (this.tool === 'hand' || this.spaceHeld) cursor = 'grab';
    else if (this.tool !== 'select') cursor = 'crosshair';
    else if (control?.kind === 'rotate') cursor = 'grab';
    else if (control?.kind === 'handle') cursor = this.resizeCursor(control.handle);
    const hit =
      control || this.tool !== 'select'
        ? null
        : this.scene.hitTest(world, { tolerance: 4 / this.view.zoom });
    if (hit !== this.hover) {
      this.hover = hit;
      this.overlayDirty = true;
    }
    if (cursor !== this.cursor) {
      this.cursor = cursor;
      this.notify();
    }
  }

  private resizeCursor(handle: Handle): string {
    const frame = this.selectionFrame();
    const base = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 }[handle];
    const rot = frame?.single ? (this.doc.get(frame.single)?.rotation ?? 0) : 0;
    const a = (((base + rot) % 180) + 180) % 180;
    if (a < 22.5 || a >= 157.5) return 'ns-resize';
    if (a < 67.5) return 'nesw-resize';
    if (a < 112.5) return 'ew-resize';
    return 'nwse-resize';
  }

  private updateCursor(): void {
    const cursor =
      this.drag?.kind === 'pan'
        ? 'grabbing'
        : this.tool === 'hand' || this.spaceHeld
          ? 'grab'
          : this.tool === 'select'
            ? 'default'
            : 'crosshair';
    if (cursor !== this.cursor) {
      this.cursor = cursor;
      this.notify();
    }
  }

  /** The node under the pointer, for context menus. */
  nodeAt(screen: Vec): NodeId | null {
    return this.scene.hitTest(this.toWorld(screen), { tolerance: 4 / this.view.zoom });
  }

  get pointerWorld(): Vec {
    return this.lastPointerWorld;
  }

  /** Converts a node's box-space → screen transform, for DOM overlays. */
  nodeScreenMatrix(id: NodeId): Mat | null {
    const g = this.scene.geometry(id);
    if (!g) return null;
    const z = this.view.zoom;
    const view: Mat = { a: z, b: 0, c: 0, d: z, e: -this.view.x * z, f: -this.view.y * z };
    const m = g.world;
    return {
      a: view.a * m.a,
      b: view.d * m.b,
      c: view.a * m.c,
      d: view.d * m.d,
      e: view.a * m.e + view.e,
      f: view.d * m.f + view.f,
    };
  }
}
