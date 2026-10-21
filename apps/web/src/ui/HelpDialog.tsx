const mod = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';

const SHORTCUTS: Array<[string, string]> = [
  ['Select / Hand', 'V / H'],
  ['Rectangle / Ellipse / Frame', 'R / O / F'],
  ['Line / Arrow', 'L / ⇧L'],
  ['Text / Draw', 'T / P'],
  ['Pan', 'Space + drag'],
  ['Zoom', `${mod} + scroll`],
  ['Zoom to fit / selection / 100%', '⇧1 / ⇧2 / ⇧0'],
  ['Undo / Redo', `${mod}Z / ⇧${mod}Z`],
  ['Copy / Paste / Duplicate', `${mod}C / ${mod}V / ${mod}D`],
  ['Delete', 'Delete'],
  ['Nudge (1 px / 10 px)', 'Arrows / ⇧ Arrows'],
  ['Bring forward / Send backward', '] / ['],
  ['Bring to front / Send to back', `${mod}] / ${mod}[`],
  ['Frame selection / Remove frame', `${mod}G / ⇧${mod}G`],
  ['Keep proportions / From centre', '⇧ / Alt while dragging'],
  ['Disable snapping', `Hold ${mod} while moving`],
  ['Cursor chat', '/'],
  ['This help', '?'],
];

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="dialog-backdrop" onPointerDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2>Keyboard shortcuts</h2>
        <div className="shortcuts">
          {SHORTCUTS.map(([label, keys]) => (
            <div key={label} style={{ display: 'contents' }}>
              <span>{label}</span>
              <kbd>{keys}</kbd>
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <span />
          <button className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
