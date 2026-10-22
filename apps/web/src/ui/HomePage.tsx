import { useState } from 'react';
import { navigate } from '../App.tsx';
import { createDoc, displayName, recentDocs, rememberDoc, setDisplayName } from '../lib/api.ts';
import { Icons } from './icons.tsx';

export function HomePage() {
  const [name, setName] = useState(displayName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recent = recentDocs();

  async function onCreate() {
    setBusy(true);
    setError(null);
    try {
      if (name.trim()) setDisplayName(name);
      const doc = await createDoc();
      rememberDoc({
        id: doc.id,
        name: doc.name,
        editToken: doc.editToken,
        viewToken: doc.viewToken,
      });
      navigate(`/d/${encodeURIComponent(doc.id)}#edit=${encodeURIComponent(doc.editToken)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a document');
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="hero">
        <div style={{ marginBottom: 16 }}>
          <Icons.logo />
        </div>
        <h1>Murmuration</h1>
        <p>
          A multiplayer vector canvas. Draw together in real time — share a link and everyone sees
          each other&apos;s cursors and changes instantly.
        </p>
      </div>
      <div className="home-actions">
        <input
          className="name-input"
          placeholder="Your name"
          aria-label="Your name"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="primary" onClick={onCreate} disabled={busy}>
          {busy ? 'Creating…' : 'New document'}
        </button>
      </div>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {recent.length > 0 && (
        <section className="recent">
          <h2>Recent</h2>
          {recent.map((d) => {
            const token = d.editToken ?? d.viewToken;
            const role = d.editToken ? 'edit' : 'view';
            if (!token) return null;
            const href = `/d/${encodeURIComponent(d.id)}#${role}=${encodeURIComponent(token)}`;
            return (
              <a
                key={d.id}
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(href);
                }}
              >
                <span>{d.name}</span>
                <span className="badge">{role === 'edit' ? 'Can edit' : 'Can view'}</span>
              </a>
            );
          })}
        </section>
      )}
    </main>
  );
}
