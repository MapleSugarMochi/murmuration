import { apply, corners, pointsOf, isLineLike, FONT_FAMILY, type Vec } from '@murmuration/renderer';
import type { NodeId } from '@murmuration/doc-model';
import { HANDLES } from './transforms.ts';
import type { Editor } from './editor.ts';

export const ACCENT = '#0d99ff';
const GUIDE = '#f24822';

/** Draws selection, hover, remote presence, marquee and guides in CSS px. */
export function drawOverlay(editor: Editor, ctx: CanvasRenderingContext2D, dpr: number): void {
  const { width, height } = editor.size;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width * dpr, height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const toScreen = (p: Vec) => editor.toScreen(p);

  // Other people's selections, in their colours.
  for (const peer of editor.peersList()) {
    for (const id of peer.presence.selection) outlineNode(editor, ctx, id, peer.color, 1.5);
  }

  if (editor.hover && !editor.selection.has(editor.hover) && !editor.isDragging) {
    outlineNode(editor, ctx, editor.hover, ACCENT, 1.5);
  }

  for (const id of editor.selection) outlineNode(editor, ctx, id, ACCENT, 1);

  const frame = editor.selectionFrame();
  if (frame && !editor.textEdit) {
    const pts = corners(frame.m, frame.width, frame.height).map(toScreen);
    if (!frame.single || editor.selection.size > 1) polygon(ctx, pts, ACCENT, 1);
    if (editor.canEdit) {
      if (editor.canResizeSelection()) {
        for (const h of HANDLES) {
          const p = toScreen(apply(frame.m, editor.handlePosition(h, frame.width, frame.height)));
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = ACCENT;
          ctx.lineWidth = 1;
          ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
          ctx.strokeRect(p.x - 4 + 0.5, p.y - 4 + 0.5, 7, 7);
        }
      }
      // Rotation knob above the top edge.
      const top = toScreen(apply(frame.m, { x: frame.width / 2, y: 0 }));
      const center = toScreen(apply(frame.m, { x: frame.width / 2, y: frame.height / 2 }));
      const len = Math.hypot(top.x - center.x, top.y - center.y) || 1;
      const knob = {
        x: top.x + ((top.x - center.x) / len) * 22,
        y: top.y + ((top.y - center.y) / len) * 22,
      };
      ctx.strokeStyle = ACCENT;
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(knob.x, knob.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(knob.x, knob.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.stroke();
    }
    // Size label under the selection.
    const bottom = pts.reduce((a, b) => (b.y > a.y ? b : a));
    const label = `${round(frame.width)} × ${round(frame.height)}`;
    ctx.font = `11px ${FONT_FAMILY}`;
    const w = ctx.measureText(label).width + 10;
    const lx = (pts[0]!.x + pts[1]!.x + pts[2]!.x + pts[3]!.x) / 4 - w / 2;
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.roundRect(lx, bottom.y + 8, w, 18, 3);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + 5, bottom.y + 17);
  }

  const marquee = editor.marquee;
  if (marquee) {
    const a = toScreen({ x: marquee.x, y: marquee.y });
    const z = editor.view.zoom;
    ctx.fillStyle = 'rgba(13,153,255,0.08)';
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    ctx.fillRect(a.x, a.y, marquee.width * z, marquee.height * z);
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, marquee.width * z, marquee.height * z);
  }

  for (const g of editor.guides) {
    ctx.strokeStyle = GUIDE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (g.axis === 'x') {
      const a = toScreen({ x: g.at, y: g.from });
      const b = toScreen({ x: g.at, y: g.to });
      ctx.moveTo(Math.round(a.x) + 0.5, a.y);
      ctx.lineTo(Math.round(b.x) + 0.5, b.y);
    } else {
      const a = toScreen({ x: g.from, y: g.at });
      const b = toScreen({ x: g.to, y: g.at });
      ctx.moveTo(a.x, Math.round(a.y) + 0.5);
      ctx.lineTo(b.x, Math.round(b.y) + 0.5);
    }
    ctx.stroke();
  }

  // Remote cursors with name tags and chat bubbles.
  for (const peer of editor.peersList()) {
    const pos = editor.remoteCursors.get(peer.clientId);
    if (!pos) continue;
    const p = toScreen(pos);
    if (p.x < -40 || p.y < -40 || p.x > width + 40 || p.y > height + 40) continue;
    drawCursor(ctx, p, peer.color);
    const text = peer.presence.chat ? peer.presence.chat : peer.name;
    ctx.font = `${peer.presence.chat ? 13 : 11}px ${FONT_FAMILY}`;
    const w = Math.min(240, ctx.measureText(text).width + 12);
    const h = peer.presence.chat ? 24 : 18;
    ctx.fillStyle = peer.color;
    ctx.beginPath();
    ctx.roundRect(p.x + 10, p.y + 16, w, h, peer.presence.chat ? 12 : 4);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, p.x + 16, p.y + 16 + h / 2, w - 12);
  }
}

function outlineNode(
  editor: Editor,
  ctx: CanvasRenderingContext2D,
  id: NodeId,
  color: string,
  lineWidth: number,
) {
  const props = editor.doc.get(id);
  const g = editor.scene.geometry(id);
  if (!props || !g) return;
  const toScreen = (p: Vec) => editor.toScreen(apply(g.world, p));
  if (isLineLike(props)) {
    const pts = pointsOf(props).map(toScreen);
    if (pts.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    return;
  }
  polygon(
    ctx,
    corners(g.world, props.width, props.height).map((p) => editor.toScreen(p)),
    color,
    lineWidth,
  );
}

function polygon(ctx: CanvasRenderingContext2D, pts: Vec[], color: string, lineWidth: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
}

function drawCursor(ctx: CanvasRenderingContext2D, p: Vec, color: string) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 16);
  ctx.lineTo(4.5, 12);
  ctx.lineTo(8, 19);
  ctx.lineTo(10.5, 18);
  ctx.lineTo(7, 11);
  ctx.lineTo(12.5, 11);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function round(v: number): string {
  return String(Math.round(v * 100) / 100);
}
