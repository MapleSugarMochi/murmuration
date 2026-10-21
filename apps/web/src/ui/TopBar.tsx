import { useEffect, useRef, useState } from 'react';
import { ROOT_ID } from '@tandem/doc-model';
import { renderToCanvas } from '@tandem/renderer';
import { navigate } from '../App.tsx';
import { parseNodes } from '../editor/clipboard.ts';
import type { Editor, Tool } from '../editor/editor.ts';
import { renameDoc } from '../lib/api.ts';
import { Icons, type IconName } from './icons.tsx';
import { useEditor } from './useEditor.ts';

const TOOLS: Array<{ tool: Tool; label: string; key: string }> = [
  { tool: 'select', label: 'Move', key: 'V' },
  { tool: 'hand', label: 'Hand', key: 'H' },
  { tool: 'frame', label: 'Frame', key: 'F' },
  { tool: 'rect', label: 'Rectangle', key: 'R' },
  { tool: 'ellipse', label: 'Ellipse', key: 'O' },
  { tool: 'line', label: 'Line', key: 'L' },
  { tool: 'arrow', label: 'Arrow', key: '⇧L' },
  { tool: 'path', label: 'Draw', key: 'P' },
  { tool: 'text', label: 'Text', key: 'T' },
];

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function TopBar({
  editor,
  docId,
  token,
  onShare,
  onHelp,
}: {
  editor: Editor;
  docId: string;
  token: string;
  onShare: () => void;
  onHelp: () => void;
}) {
  useEditor(editor);
  const { sync } = editor;
  const [menuOpen, setMenuOpen] = useState(false);
  const [name, setName] = useState(sync.docName);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setName(sync.docName), [sync.docName]);

  const commitName = async () => {
    const next = name.trim();
    if (!next || next === sync.docName) return setName(sync.docName);
    try {
      await renameDoc(docId, token, next);
    } catch (err) {
      editor.toast(err instanceof Error ? err.message : 'Rename failed', 'error');
      setName(sync.docName);
    }
  };

  const exportPng = (scale: number) => {
    const ids =
      editor.selection.size > 0 ? [...editor.selection] : [...editor.doc.childrenOf(ROOT_ID)];
    const canvas = renderToCanvas(editor.doc, editor.scene, ids, scale, null);
    if (!canvas) return editor.toast('Nothing to export');
    canvas.toBlob(
      (blob) => blob && download(`${sync.docName || 'tandem'}@${scale}x.png`, blob),
      'image/png',
    );
  };

  const exportJson = () => {
    const json = JSON.stringify({ version: 1, name: sync.docName, nodes: editor.exportNodes() });
    download(`${sync.docName || 'tandem'}.json`, new Blob([json], { type: 'application/json' }));
  };

  const importJson = async (file: File) => {
    const nodes = parseNodes(await file.text());
    if (!nodes) return editor.toast('That file is not a Tandem export', 'error');
    editor.importNodes(nodes);
  };

  const pending = sync.pendingOpCount;
  const statusText =
    sync.status === 'connected'
      ? pending > 0
        ? 'Saving…'
        : 'Saved'
      : sync.status === 'connecting'
        ? 'Reconnecting…'
        : `Offline${pending > 0 ? ` · ${pending} unsynced` : ''}`;
  const peers = editor.peersList();

  const menuItems: Array<{ label: string; run: () => void; disabled?: boolean }> = [
    { label: 'Back to files', run: () => navigate('/') },
    { label: 'Export PNG (1x)', run: () => exportPng(1) },
    { label: 'Export PNG (2x)', run: () => exportPng(2) },
    { label: 'Export JSON', run: exportJson },
    { label: 'Import JSON…', run: () => fileRef.current?.click(), disabled: !editor.canEdit },
    { label: 'Keyboard shortcuts', run: onHelp },
  ];

  return (
    <header className="topbar">
      <div style={{ position: 'relative' }}>
        <button
          className="menu-button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-label="Main menu"
        >
          <Icons.logo />
          <Icons.chevronDown />
        </button>
        {menuOpen && (
          <div
            className="menu"
            role="menu"
            style={{ position: 'absolute', top: 38, left: 0 }}
            onMouseLeave={() => setMenuOpen(false)}
          >
            {menuItems.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setMenuOpen(false);
                  item.run();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importJson(file);
            e.target.value = '';
          }}
        />
      </div>
      <input
        className="doc-name"
        aria-label="Document name"
        value={name}
        readOnly={!editor.canEdit}
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {!editor.canEdit && <span className="badge">View only</span>}
      <div className="spacer" />
      <nav className="toolbar" aria-label="Tools">
        {TOOLS.map(({ tool, label, key }) => {
          const Icon = Icons[tool as IconName];
          const disabled = !editor.canEdit && tool !== 'select' && tool !== 'hand';
          return (
            <button
              key={tool}
              className={`tool ${editor.tool === tool ? 'active' : ''}`}
              title={`${label} (${key})`}
              aria-label={label}
              aria-pressed={editor.tool === tool}
              disabled={disabled}
              onClick={() => editor.setTool(tool)}
            >
              <Icon />
            </button>
          );
        })}
      </nav>
      <button
        className="icon-button"
        title="Undo"
        aria-label="Undo"
        disabled={!sync.canUndo}
        onClick={() => editor.undo()}
      >
        <Icons.undo />
      </button>
      <button
        className="icon-button"
        title="Redo"
        aria-label="Redo"
        disabled={!sync.canRedo}
        onClick={() => editor.redo()}
      >
        <Icons.redo />
      </button>
      <div className="spacer" />
      <div className="status" title={statusText} data-testid="status">
        <span className={`status-dot ${sync.status}`} />
        <span className="status-text">{statusText}</span>
      </div>
      <div className="avatars" aria-label="People here">
        {peers.slice(0, 5).map((p) => (
          <button
            key={p.clientId}
            className={`avatar ${editor.following === p.clientId ? 'following' : ''}`}
            style={{ background: p.color }}
            title={
              editor.following === p.clientId
                ? `Following ${p.name} — click to stop`
                : `Follow ${p.name}`
            }
            aria-label={`Follow ${p.name}`}
            onClick={() => editor.follow(editor.following === p.clientId ? null : p.clientId)}
          >
            {initials(p.name)}
          </button>
        ))}
        {peers.length > 5 && (
          <span
            className="avatar"
            style={{ background: '#6b6b6b' }}
            title={peers
              .slice(5)
              .map((p) => p.name)
              .join(', ')}
          >
            +{peers.length - 5}
          </span>
        )}
        <span
          className="avatar self"
          style={{ background: sync.color }}
          title={`${sync.name} (you)`}
        >
          {initials(sync.name)}
        </span>
      </div>
      <button className="primary" onClick={onShare}>
        Share
      </button>
    </header>
  );
}
