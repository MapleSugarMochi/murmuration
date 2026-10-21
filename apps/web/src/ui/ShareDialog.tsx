import { useState } from 'react';
import { docLink, recentDocs, rememberDoc, rotateLinks } from '../lib/api.ts';
import { navigate } from '../App.tsx';
import type { Editor } from '../editor/editor.ts';

export function ShareDialog({
  editor,
  docId,
  token,
  onClose,
}: {
  editor: Editor;
  docId: string;
  token: string;
  onClose: () => void;
}) {
  const known = recentDocs().find((d) => d.id === docId);
  const canEdit = editor.canEdit;
  const [links, setLinks] = useState({
    edit: canEdit ? (known?.editToken ?? token) : null,
    view: known?.viewToken ?? (canEdit ? null : token),
  });
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const copy = async (kind: 'edit' | 'view', url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      editor.toast('Could not access the clipboard; copy the link manually', 'error');
    }
  };

  const reset = async () => {
    if (!confirm('Reset both links? Everyone currently in the document will be disconnected.'))
      return;
    setBusy(true);
    try {
      const fresh = await rotateLinks(docId, token);
      rememberDoc({
        id: docId,
        name: editor.sync.docName,
        editToken: fresh.editToken,
        viewToken: fresh.viewToken,
      });
      setLinks({ edit: fresh.editToken, view: fresh.viewToken });
      // Our own connection was closed too; rejoin with the new link.
      navigate(`/d/${encodeURIComponent(docId)}#edit=${encodeURIComponent(fresh.editToken)}`);
    } catch (err) {
      editor.toast(err instanceof Error ? err.message : 'Could not reset links', 'error');
      setBusy(false);
    }
  };

  const row = (kind: 'edit' | 'view', label: string, value: string | null) =>
    value && (
      <>
        <label>{label}</label>
        <div className="link-row">
          <input
            readOnly
            value={docLink(docId, kind, value)}
            onFocus={(e) => e.target.select()}
            aria-label={label}
          />
          <button className="secondary" onClick={() => copy(kind, docLink(docId, kind, value))}>
            {copied === kind ? 'Copied' : 'Copy'}
          </button>
        </div>
      </>
    );

  return (
    <div className="dialog-backdrop" onPointerDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-label="Share"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2>Share “{editor.sync.docName}”</h2>
        <p>
          Anyone with a link can open this document. Links are secret: share them only with people
          you trust.
        </p>
        {row('edit', 'Can edit', links.edit)}
        {row('view', 'Can view', links.view)}
        {!links.view && canEdit && <p className="hint">Reset the links to get a view-only link.</p>}
        <div className="dialog-actions">
          {canEdit ? (
            <button
              className="secondary"
              onClick={reset}
              disabled={busy}
              style={{ color: 'var(--danger)' }}
            >
              Reset links
            </button>
          ) : (
            <span />
          )}
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
