import { useEffect, useRef } from 'react';
import type { Editor } from '../editor/editor.ts';

const mod = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+';

interface Item {
  label: string;
  keys?: string;
  disabled?: boolean;
  run: () => void;
}

export function ContextMenu({
  editor,
  x,
  y,
  onClose,
}: {
  editor: Editor;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const has = editor.selection.size > 0;
  const ro = !editor.canEdit;
  const groups: Item[][] = [
    [
      { label: 'Copy', keys: `${mod}C`, disabled: !has, run: () => document.execCommand('copy') },
      { label: 'Paste', keys: `${mod}V`, disabled: ro, run: () => editor.paste(null) },
      { label: 'Duplicate', keys: `${mod}D`, disabled: !has || ro, run: () => editor.duplicate() },
      { label: 'Delete', keys: 'Del', disabled: !has || ro, run: () => editor.deleteSelection() },
    ],
    [
      {
        label: 'Bring to front',
        keys: `${mod}]`,
        disabled: !has || ro,
        run: () => editor.reorder('front'),
      },
      {
        label: 'Bring forward',
        keys: ']',
        disabled: !has || ro,
        run: () => editor.reorder('forward'),
      },
      {
        label: 'Send backward',
        keys: '[',
        disabled: !has || ro,
        run: () => editor.reorder('backward'),
      },
      {
        label: 'Send to back',
        keys: `${mod}[`,
        disabled: !has || ro,
        run: () => editor.reorder('back'),
      },
    ],
    [
      {
        label: 'Frame selection',
        keys: `${mod}G`,
        disabled: !has || ro,
        run: () => editor.frameSelection(),
      },
      {
        label: 'Remove frame',
        keys: `⇧${mod}G`,
        disabled: !has || ro,
        run: () => editor.unframeSelection(),
      },
      { label: 'Zoom to selection', keys: '⇧2', disabled: !has, run: () => editor.fitSelection() },
    ],
  ];

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={{
        left: Math.min(x, window.innerWidth - 220),
        top: Math.min(y, window.innerHeight - 340),
      }}
    >
      {groups.map((items, i) => (
        <div key={i}>
          {i > 0 && <hr />}
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                item.run();
                onClose();
              }}
            >
              <span>{item.label}</span>
              {item.keys && <kbd>{item.keys}</kbd>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
