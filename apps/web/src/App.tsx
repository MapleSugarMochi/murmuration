import { useEffect, useState } from 'react';
import { BenchPage } from './ui/BenchPage.tsx';
import { EditorPage } from './ui/EditorPage.tsx';
import { HomePage } from './ui/HomePage.tsx';

export function navigate(path: string): void {
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function useLocation() {
  const [loc, setLoc] = useState(() => ({ path: location.pathname, hash: location.hash }));
  useEffect(() => {
    const onChange = () => setLoc({ path: location.pathname, hash: location.hash });
    window.addEventListener('popstate', onChange);
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('popstate', onChange);
      window.removeEventListener('hashchange', onChange);
    };
  }, []);
  return loc;
}

export function App() {
  const { path, hash } = useLocation();
  const docMatch = /^\/d\/([^/]+)\/?$/.exec(path);
  if (docMatch) {
    const id = decodeURIComponent(docMatch[1]!);
    return <EditorPage key={`${id}${hash}`} docId={id} hash={hash} />;
  }
  if (path === '/bench') return <BenchPage />;
  return <HomePage />;
}
