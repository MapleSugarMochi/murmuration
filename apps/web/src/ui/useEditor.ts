import { useSyncExternalStore } from 'react';
import type { Editor } from '../editor/editor.ts';

/** Re-renders the calling component whenever the editor notifies. */
export function useEditor(editor: Editor): number {
  return useSyncExternalStore(editor.subscribe, editor.getVersion);
}
