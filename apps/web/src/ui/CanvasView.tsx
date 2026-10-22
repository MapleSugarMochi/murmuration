import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Editor, PointerInput } from '../editor/editor.ts';
import { ContextMenu } from './ContextMenu.tsx';
import { TextEditor } from './TextEditor.tsx';
import { useEditor } from './useEditor.ts';

function input(
  e: {
    clientX: number;
    clientY: number;
    button: number;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
  },
  el: HTMLElement,
): PointerInput {
  const r = el.getBoundingClientRect();
  return {
    x: e.clientX - r.left,
    y: e.clientY - r.top,
    button: e.button,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey || e.ctrlKey,
  };
}

export function CanvasView({ editor }: { editor: Editor }) {
  useEditor(editor);
  const wrapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // Size the backing stores and run the render loop.
  useEffect(() => {
    const wrap = wrapRef.current!;
    const content = contentRef.current!;
    const overlay = overlayRef.current!;
    const cctx = content.getContext('2d', { alpha: false })!;
    const octx = overlay.getContext('2d')!;
    let dpr = window.devicePixelRatio || 1;

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      const { width, height } = wrap.getBoundingClientRect();
      for (const c of [content, overlay]) {
        c.width = Math.max(1, Math.round(width * dpr));
        c.height = Math.max(1, Math.round(height * dpr));
      }
      editor.setSize(width, height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    let raf = 0;
    const loop = () => {
      editor.renderFrame(cctx, octx, dpr);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // React's onWheel is passive; zooming needs preventDefault.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = overlay.getBoundingClientRect();
      const scale = e.deltaMode === 1 ? 16 : 1;
      editor.wheel({
        x: e.clientX - r.left,
        y: e.clientY - r.top,
        dx: e.deltaX * scale,
        dy: e.deltaY * scale,
        zoom: e.ctrlKey || e.metaKey,
      });
    };
    overlay.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      overlay.removeEventListener('wheel', onWheel);
    };
  }, [editor]);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button === 2) return;
    // Keep the browser from moving focus on mousedown: it would blur the
    // text editor that this very click may open.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    (document.activeElement as HTMLElement | null)?.blur?.();
    setMenu(null);
    editor.pointerDown(input(e, e.currentTarget));
  };

  const pointer = editor.chat.open ? editor.toScreen(editor.pointerWorld) : null;
  // Keep the chat input inside the canvas, beside the pointer.
  const chatPos = pointer && {
    x: Math.max(4, Math.min(pointer.x + 12, editor.size.width - 228)),
    y: Math.max(4, Math.min(pointer.y + 14, editor.size.height - 36)),
  };

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas ref={contentRef} aria-hidden="true" />
      <canvas
        ref={overlayRef}
        role="application"
        aria-label="Canvas"
        data-testid="canvas"
        style={{ cursor: editor.cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => editor.pointerMove(input(e, e.currentTarget))}
        onPointerUp={(e) => editor.pointerUp(input(e, e.currentTarget))}
        onPointerCancel={(e) => editor.pointerUp(input(e, e.currentTarget))}
        onPointerLeave={() => editor.pointerLeave()}
        onDoubleClick={(e) => editor.doubleClick(input(e, e.currentTarget))}
        onContextMenu={(e) => {
          e.preventDefault();
          const p = input(e, e.currentTarget);
          const hit = editor.nodeAt(p);
          if (hit && !editor.selection.has(hit)) editor.setSelection([hit]);
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {editor.textEdit && <TextEditor editor={editor} />}
      {chatPos && (
        <input
          className="chat-input"
          // Plain autoFocus would scroll the canvas container to reveal it.
          ref={(el) => el?.focus({ preventScroll: true })}
          placeholder="Say something"
          maxLength={140}
          style={{ left: chatPos.x, top: chatPos.y, background: editor.sync.color }}
          value={editor.chat.text}
          onChange={(e) => editor.setChat(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              editor.closeChat();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              editor.commitChat();
            }
          }}
          onBlur={() => editor.commitChat()}
        />
      )}
      <div className="toasts" role="status" aria-live="polite">
        {editor.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
      <div className="zoom-badge">{Math.round(editor.view.zoom * 100)}%</div>
      {menu && <ContextMenu editor={editor} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
}
