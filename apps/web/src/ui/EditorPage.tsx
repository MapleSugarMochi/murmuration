import { useEffect, useMemo, useState } from 'react';
import { SyncClient } from '@murmuration/sync-client';
import { Editor } from '../editor/editor.ts';
import { Connection } from '../lib/connection.ts';
import { displayName, forgetDoc, rememberDoc, setDisplayName, tokenFromHash } from '../lib/api.ts';
import { navigate } from '../App.tsx';
import { CanvasView } from './CanvasView.tsx';
import { HelpDialog } from './HelpDialog.tsx';
import { LayersPanel } from './LayersPanel.tsx';
import { PropertiesPanel } from './PropertiesPanel.tsx';
import { ShareDialog } from './ShareDialog.tsx';
import { TopBar } from './TopBar.tsx';
import { useEditor } from './useEditor.ts';

const ANIMALS = ['Otter', 'Heron', 'Lynx', 'Panda', 'Koala', 'Fox', 'Owl', 'Yak', 'Ibis', 'Seal'];

function guestName(): string {
  const name = `Guest ${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}`;
  setDisplayName(name);
  return name;
}

/**
 * At most one batch per 40 ms (25 Hz). The first edit after a pause goes out
 * at once; during a drag, set ops coalesce within each window, which keeps
 * upload under 5 KB/s (PF-08) at the cost of up to 40 ms extra latency.
 */
const MIN_FLUSH_INTERVAL_MS = 40;
let lastFlushAt = 0;

function scheduleFlush(flush: () => void): void {
  const wait = Math.max(0, lastFlushAt + MIN_FLUSH_INTERVAL_MS - performance.now());
  setTimeout(() => {
    lastFlushAt = performance.now();
    flush();
  }, wait);
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

export function EditorPage({ docId, hash }: { docId: string; hash: string }) {
  const link = useMemo(() => tokenFromHash(hash), [hash]);
  const [session, setSession] = useState<{ editor: Editor; conn: Connection } | null>(null);
  const [fatal, setFatal] = useState<{ code: string; message: string } | null>(null);

  useEffect(() => {
    if (!link) return;
    const sync = new SyncClient({
      docId,
      token: link.token,
      name: displayName() || guestName(),
      scheduleFlush,
    });
    const editor = new Editor(sync);
    const conn = new Connection(sync);
    conn.onFatal = (err) => {
      if (err.code === 'not_found') forgetDoc(docId);
      setFatal(err);
    };
    const offReady = sync.ready.on(() => {
      rememberDoc({
        id: docId,
        name: sync.docName,
        [link.role === 'edit' ? 'editToken' : 'viewToken']: link.token,
      });
    });
    const offRename = sync.docRenamed.on((name) => rememberDoc({ id: docId, name }));
    conn.start();
    setSession({ editor, conn });
    // Dev and e2e hook for inspecting the live editor.
    Object.assign(window, { __murmuration: editor, __murmurationConnection: conn });
    return () => {
      offReady();
      offRename();
      conn.stop();
      editor.dispose();
    };
  }, [docId, link]);

  if (!link) {
    return (
      <div className="center-screen">
        <div>
          <h1>This link is incomplete</h1>
          <p>Ask for a share link that includes its access token.</p>
          <button className="secondary" onClick={() => navigate('/')}>
            Go home
          </button>
        </div>
      </div>
    );
  }
  if (fatal) {
    const title =
      fatal.code === 'links_rotated'
        ? 'This link was reset'
        : fatal.code === 'not_found'
          ? 'Document not found'
          : fatal.code === 'protocol_version'
            ? 'Murmuration was updated'
            : 'You no longer have access';
    return (
      <div className="center-screen">
        <div>
          <h1>{title}</h1>
          <p>
            {fatal.code === 'protocol_version' ? 'Reload the page to continue.' : fatal.message}
          </p>
          <button
            className="secondary"
            onClick={() => (fatal.code === 'protocol_version' ? location.reload() : navigate('/'))}
          >
            {fatal.code === 'protocol_version' ? 'Reload' : 'Go home'}
          </button>
        </div>
      </div>
    );
  }
  if (!session) return null;
  return <EditorShell editor={session.editor} docId={docId} token={link.token} />;
}

function EditorShell({ editor, docId, token }: { editor: Editor; docId: string; token: string }) {
  useEditor(editor);
  const [shareOpen, setShareOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.key === '?') {
        setHelpOpen((v) => !v);
        e.preventDefault();
        return;
      }
      if (editor.keyDown(e)) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => editor.keyUp(e);
    const onCopy = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const text = editor.copy();
      if (text && e.clipboardData) {
        e.clipboardData.setData('text/plain', text);
        e.preventDefault();
      }
    };
    const onCut = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const text = editor.cut();
      if (text && e.clipboardData) {
        e.clipboardData.setData('text/plain', text);
        e.preventDefault();
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      editor.paste(e.clipboardData?.getData('text/plain') ?? null);
      e.preventDefault();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (editor.sync.pendingOpCount > 0) e.preventDefault();
    };
    const onBlur = () => (editor.spaceHeld = false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, [editor]);

  if (!editor.sync.isReady) {
    return (
      <div className="center-screen">
        <p>{editor.sync.status === 'offline' ? 'Connecting… (retrying)' : 'Opening document…'}</p>
      </div>
    );
  }

  return (
    <div className="editor">
      <TopBar
        editor={editor}
        docId={docId}
        token={token}
        onShare={() => setShareOpen(true)}
        onHelp={() => setHelpOpen(true)}
      />
      <LayersPanel editor={editor} />
      <CanvasView editor={editor} />
      <PropertiesPanel editor={editor} />
      {shareOpen && (
        <ShareDialog
          editor={editor}
          docId={docId}
          token={token}
          onClose={() => setShareOpen(false)}
        />
      )}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
