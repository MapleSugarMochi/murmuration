import { useEffect, useState } from 'react';
import {
  normalizeRotation,
  type NodeProps,
  type PropKey,
  type PropValue,
} from '@murmuration/doc-model';
import { cssColor } from '@murmuration/renderer';
import type { Editor } from '../editor/editor.ts';
import { r2 } from '../editor/transforms.ts';
import { evaluate } from './expr.ts';
import { Icons } from './icons.tsx';
import { useEditor } from './useEditor.ts';

const MIXED = Symbol('mixed');
type Value<T> = T | typeof MIXED;

function common<K extends keyof NodeProps>(nodes: NodeProps[], key: K): Value<NodeProps[K]> {
  const first = nodes[0]![key];
  return nodes.every((n) => n[key] === first) ? first : MIXED;
}

/**
 * Number input: Enter or blur commits, arrows step by 1 (Shift: 10), and
 * simple arithmetic like "100+20" is evaluated.
 */
function NumberField({
  label,
  value,
  onCommit,
  min,
  max,
  disabled,
  suffix,
}: {
  label: string;
  value: Value<number>;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  suffix?: string;
}) {
  const shown = value === MIXED ? 'Mixed' : String(r2(value));
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commit = (raw: string) => {
    const v = evaluate(raw);
    if (v === null) return setText(shown);
    onCommit(clamp(r2(v)));
  };
  return (
    <div className="field" title={label}>
      <label>{label}</label>
      <input
        aria-label={label}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => text !== shown && commit(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit(text);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setText(shown);
            (e.target as HTMLInputElement).blur();
          } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value !== MIXED) {
            e.preventDefault();
            const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
            onCommit(clamp(r2((evaluate(text) ?? value) + step)));
          }
        }}
      />
      {suffix && <span style={{ color: 'var(--faint)' }}>{suffix}</span>}
    </div>
  );
}

/** Colour swatch + hex + opacity for a `#RRGGBBAA` (or null) property. */
function ColorField({
  label,
  value,
  onCommit,
  disabled,
}: {
  label: string;
  value: Value<string | null>;
  onCommit: (v: string | null) => void;
  disabled?: boolean;
}) {
  if (value === null) {
    return (
      <div className="color-row">
        <button
          className="secondary"
          style={{ height: 26 }}
          disabled={disabled}
          onClick={() => onCommit('#d9d9d9ff')}
        >
          + Add {label.toLowerCase()}
        </button>
      </div>
    );
  }
  const hex = value === MIXED ? null : value.slice(1, 7);
  const alpha = value === MIXED ? MIXED : Math.round((parseInt(value.slice(7, 9), 16) / 255) * 100);
  const withAlpha = (rgb: string, a: number) =>
    `#${rgb}${Math.round((a / 100) * 255)
      .toString(16)
      .padStart(2, '0')}`;
  return (
    <div className="color-row">
      <span className="swatch">
        <span style={{ background: value === MIXED ? '#ccc' : cssColor(value) }} />
        <input
          type="color"
          aria-label={`${label} colour`}
          disabled={disabled}
          value={hex ? `#${hex}` : '#cccccc'}
          onChange={(e) =>
            onCommit(withAlpha(e.target.value.slice(1), alpha === MIXED ? 100 : alpha))
          }
        />
      </span>
      <HexField
        value={hex}
        disabled={disabled}
        onCommit={(rgb) => onCommit(withAlpha(rgb, alpha === MIXED ? 100 : alpha))}
      />
      <div style={{ width: 70 }}>
        <NumberField
          label="%"
          value={alpha}
          min={0}
          max={100}
          disabled={disabled || hex === null}
          onCommit={(a) => hex && onCommit(withAlpha(hex, a))}
        />
      </div>
      <button
        className="icon-button"
        title={`Remove ${label.toLowerCase()}`}
        disabled={disabled}
        onClick={() => onCommit(null)}
      >
        −
      </button>
    </div>
  );
}

function HexField({
  value,
  onCommit,
  disabled,
}: {
  value: string | null;
  onCommit: (rgb: string) => void;
  disabled?: boolean;
}) {
  const shown = value === null ? 'Mixed' : value.toUpperCase();
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  return (
    <div className="field" style={{ flex: 1 }}>
      <input
        aria-label="Hex colour"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => {
          const v = text.replace('#', '').trim();
          if (/^[0-9a-fA-F]{6}$/.test(v)) onCommit(v.toLowerCase());
          else setText(shown);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
}

export function PropertiesPanel({ editor }: { editor: Editor }) {
  useEditor(editor);
  const ids = [...editor.selection].filter((id) => editor.doc.has(id));
  const nodes = ids.map((id) => editor.doc.get(id)!);
  const ro = !editor.canEdit;
  const set = (values: Partial<Record<PropKey, PropValue>>) => editor.setProps(values, ids);

  if (nodes.length === 0) {
    return (
      <aside className="panel right" aria-label="Properties">
        <div className="section">
          <div className="section-title">Design</div>
          <p className="hint">
            Select a layer to edit it. Share the link to invite others — you&apos;ll see their
            cursors and edits live.
          </p>
          <p className="hint">
            Press <b>?</b> for keyboard shortcuts.
          </p>
        </div>
      </aside>
    );
  }

  const anyText = nodes.some((n) => n.type === 'text');
  const allText = nodes.every((n) => n.type === 'text');
  const hasCorners = nodes.every((n) => n.type === 'rect' || n.type === 'frame');
  const lineOnly = nodes.every((n) => n.type === 'line' || n.type === 'arrow' || n.type === 'path');
  const frames = nodes.filter((n) => n.type === 'frame');

  return (
    <aside className="panel right" aria-label="Properties">
      {nodes.length > 1 && (
        <div className="section">
          <div className="section-title">
            Align <span className="badge">{nodes.length} selected</span>
          </div>
          <div className="align-row">
            {(
              [
                ['left', 'alignLeft', 'Align left'],
                ['hcenter', 'alignHCenter', 'Align horizontal centres'],
                ['right', 'alignRight', 'Align right'],
                ['top', 'alignTop', 'Align top'],
                ['vcenter', 'alignVCenter', 'Align vertical centres'],
                ['bottom', 'alignBottom', 'Align bottom'],
              ] as const
            ).map(([how, icon, label]) => {
              const Icon = Icons[icon];
              return (
                <button
                  key={how}
                  className="icon-button"
                  title={label}
                  aria-label={label}
                  disabled={ro}
                  onClick={() => editor.align(how)}
                >
                  <Icon />
                </button>
              );
            })}
            <button
              className="icon-button"
              title="Distribute horizontally"
              aria-label="Distribute horizontally"
              disabled={ro || nodes.length < 3}
              onClick={() => editor.distribute('x')}
            >
              <Icons.distributeH />
            </button>
            <button
              className="icon-button"
              title="Distribute vertically"
              aria-label="Distribute vertically"
              disabled={ro || nodes.length < 3}
              onClick={() => editor.distribute('y')}
            >
              <Icons.distributeV />
            </button>
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-title">{nodes.length === 1 ? nodes[0]!.name : 'Layout'}</div>
        <div className="grid2">
          <NumberField
            label="X"
            value={common(nodes, 'x')}
            disabled={ro}
            onCommit={(v) => set({ x: v })}
          />
          <NumberField
            label="Y"
            value={common(nodes, 'y')}
            disabled={ro}
            onCommit={(v) => set({ y: v })}
          />
          <NumberField
            label="W"
            value={common(nodes, 'width')}
            min={0}
            disabled={ro || anyText}
            onCommit={(v) => set({ width: v })}
          />
          <NumberField
            label="H"
            value={common(nodes, 'height')}
            min={0}
            disabled={ro || anyText}
            onCommit={(v) => set({ height: v })}
          />
          <NumberField
            label="°"
            value={common(nodes, 'rotation')}
            disabled={ro}
            onCommit={(v) => set({ rotation: normalizeRotation(v) })}
          />
          {hasCorners && (
            <NumberField
              label="R"
              value={common(nodes, 'cornerRadius')}
              min={0}
              disabled={ro}
              onCommit={(v) => set({ cornerRadius: v })}
            />
          )}
        </div>
        {frames.length > 0 && (
          <label style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' }}>
            <input
              type="checkbox"
              disabled={ro}
              checked={frames.every((f) => f.clipContent)}
              onChange={(e) =>
                editor.setProps(
                  { clipContent: e.target.checked },
                  ids.filter((id) => editor.doc.get(id)?.type === 'frame'),
                )
              }
            />
            Clip content
          </label>
        )}
      </div>

      {allText && (
        <div className="section">
          <div className="section-title">Text</div>
          <NumberField
            label="Size"
            value={common(nodes, 'fontSize')}
            min={1}
            max={999}
            disabled={ro}
            onCommit={(v) => set({ fontSize: v })}
          />
        </div>
      )}

      <div className="section">
        <div className="section-title">Layer</div>
        <NumberField
          label="Opacity"
          suffix="%"
          value={(() => {
            const o = common(nodes, 'opacity');
            return o === MIXED ? MIXED : Math.round(o * 100);
          })()}
          min={0}
          max={100}
          disabled={ro}
          onCommit={(v) => set({ opacity: v / 100 })}
        />
      </div>

      {!lineOnly && (
        <div className="section">
          <div className="section-title">Fill</div>
          <ColorField
            label="Fill"
            value={common(nodes, 'fill')}
            disabled={ro}
            onCommit={(v) => set({ fill: v })}
          />
        </div>
      )}

      {!allText && (
        <div className="section">
          <div className="section-title">Stroke</div>
          <ColorField
            label="Stroke"
            value={common(nodes, 'stroke')}
            disabled={ro}
            onCommit={(v) => set({ stroke: v })}
          />
          {common(nodes, 'stroke') !== null && (
            <NumberField
              label="Weight"
              value={common(nodes, 'strokeWidth')}
              min={0}
              max={100}
              disabled={ro}
              onCommit={(v) => set({ strokeWidth: v })}
            />
          )}
        </div>
      )}
    </aside>
  );
}
