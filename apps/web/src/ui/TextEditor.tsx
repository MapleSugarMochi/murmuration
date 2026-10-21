import { useEffect, useRef, useState } from 'react';
import { cssColor } from '@tandem/renderer';
import type { Editor } from '../editor/editor.ts';

/**
 * A textarea laid exactly over the text node being edited. Changes stream
 * to the document on every input, so collaborators see typing live; IME
 * composition never ends the edit early.
 */
export function TextEditor({ editor }: { editor: Editor }) {
  const edit = editor.textEdit!;
  const props = editor.doc.get(edit.id);
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [value, setValue] = useState(props?.text ?? '');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const m = editor.nodeScreenMatrix(edit.id);
  if (!props || !m) return null;

  return (
    <textarea
      ref={ref}
      className="text-editor"
      aria-label="Edit text"
      spellCheck={false}
      value={value}
      style={{
        transform: `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`,
        width: Math.max(props.width, 4) + props.fontSize,
        height: props.height,
        fontSize: props.fontSize,
        color: props.fill ? cssColor(props.fill) : '#1e1e1e',
      }}
      onChange={(e) => {
        setValue(e.target.value);
        editor.updateText(e.target.value);
      }}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={() => (composing.current = false)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (composing.current || e.nativeEvent.isComposing) return;
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          editor.endTextEdit();
        }
      }}
      onBlur={() => {
        if (!composing.current) editor.endTextEdit();
      }}
    />
  );
}
