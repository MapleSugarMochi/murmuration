import type { NodeId } from '@tandem/doc-model';
import type { Rect, Scene, Vec } from '@tandem/renderer';

export interface Guide {
  axis: 'x' | 'y';
  /** World coordinate of the guide line. */
  at: number;
  from: number;
  to: number;
}

export interface SnapResult {
  delta: Vec;
  guides: Guide[];
}

const xs = (r: Rect) => [r.x, r.x + r.width / 2, r.x + r.width];
const ys = (r: Rect) => [r.y, r.y + r.height / 2, r.y + r.height];

/**
 * Snaps a moving box's edges and centre lines to those of nearby nodes.
 * `threshold` is in world units (callers pass 4 screen px / zoom).
 */
export function snapMove(
  scene: Scene,
  moving: Rect,
  delta: Vec,
  exclude: (id: NodeId) => boolean,
  search: Rect,
  threshold: number,
): SnapResult {
  const box = { ...moving, x: moving.x + delta.x, y: moving.y + delta.y };
  const targets: Rect[] = [];
  for (const id of scene.queryRect(search)) {
    if (exclude(id) || !scene.isShown(id)) continue;
    targets.push(scene.geometry(id)!.bounds);
    if (targets.length > 300) break;
  }
  let bestX: { d: number; at: number } | null = null;
  let bestY: { d: number; at: number } | null = null;
  for (const t of targets) {
    for (const tx of xs(t)) {
      for (const mx of xs(box)) {
        const d = tx - mx;
        if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d)))
          bestX = { d, at: tx };
      }
    }
    for (const ty of ys(t)) {
      for (const my of ys(box)) {
        const d = ty - my;
        if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d)))
          bestY = { d, at: ty };
      }
    }
  }
  const snapped = { x: delta.x + (bestX?.d ?? 0), y: delta.y + (bestY?.d ?? 0) };
  const final = { ...moving, x: moving.x + snapped.x, y: moving.y + snapped.y };
  const guides: Guide[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  if (bestX) {
    const hits = targets.filter((t) => xs(t).some((v) => near(v, bestX!.at)));
    const all = [final, ...hits];
    guides.push({
      axis: 'x',
      at: bestX.at,
      from: Math.min(...all.map((r) => r.y)),
      to: Math.max(...all.map((r) => r.y + r.height)),
    });
  }
  if (bestY) {
    const hits = targets.filter((t) => ys(t).some((v) => near(v, bestY!.at)));
    const all = [final, ...hits];
    guides.push({
      axis: 'y',
      at: bestY.at,
      from: Math.min(...all.map((r) => r.x)),
      to: Math.max(...all.map((r) => r.x + r.width)),
    });
  }
  return { delta: snapped, guides };
}
