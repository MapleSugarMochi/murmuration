import type { ReactNode } from 'react';

const Svg = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const Icons = {
  select: () => (
    <Svg>
      <path d="M3.5 2.5l9 4.2-4 1.2-1.6 4z" />
    </Svg>
  ),
  hand: () => (
    <Svg>
      <path d="M5 8V4a1 1 0 012 0v3m0-3.5a1 1 0 012 0V7m0-2.5a1 1 0 012 0V8m0-2a1 1 0 012 0v3.5A4.5 4.5 0 018.5 14 4 4 0 015 12l-2-3a1 1 0 011.7-1L5 8.5" />
    </Svg>
  ),
  rect: () => (
    <Svg>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
    </Svg>
  ),
  ellipse: () => (
    <Svg>
      <ellipse cx="8" cy="8" rx="5.5" ry="5" />
    </Svg>
  ),
  line: () => (
    <Svg>
      <path d="M3 13L13 3" />
    </Svg>
  ),
  arrow: () => (
    <Svg>
      <path d="M3 13L13 3M7.5 3H13v5.5" />
    </Svg>
  ),
  text: () => (
    <Svg>
      <path d="M3.5 4V3h9v1M8 3v10M6 13h4" />
    </Svg>
  ),
  path: () => (
    <Svg>
      <path d="M2.5 11c2-5 4-6 5-3s2.5 3 6-3" />
    </Svg>
  ),
  frame: () => (
    <Svg>
      <path d="M5 2v12M11 2v12M2 5h12M2 11h12" />
    </Svg>
  ),
  eye: () => (
    <Svg>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </Svg>
  ),
  eyeOff: () => (
    <Svg>
      <path d="M2 2l12 12M6.5 4a6 6 0 011.5-.5c4 0 6.5 4.5 6.5 4.5a12 12 0 01-1.8 2.3M4.2 5.2A12 12 0 001.5 8S4 12.5 8 12.5a6 6 0 002.5-.5" />
    </Svg>
  ),
  lock: () => (
    <Svg>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </Svg>
  ),
  unlock: () => (
    <Svg>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 014.8-1" />
    </Svg>
  ),
  chevronRight: () => (
    <Svg size={12}>
      <path d="M6 4l4 4-4 4" />
    </Svg>
  ),
  chevronDown: () => (
    <Svg size={12}>
      <path d="M4 6l4 4 4-4" />
    </Svg>
  ),
  undo: () => (
    <Svg>
      <path d="M4 6h6a3.5 3.5 0 010 7H7M4 6l3-3M4 6l3 3" />
    </Svg>
  ),
  redo: () => (
    <Svg>
      <path d="M12 6H6a3.5 3.5 0 000 7h3M12 6L9 3M12 6L9 9" />
    </Svg>
  ),
  logo: () => (
    <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#18181b" />
      <circle cx="12" cy="16" r="6" fill="#0d99ff" />
      <circle cx="20" cy="16" r="6" fill="#f24e1e" fillOpacity="0.9" />
    </svg>
  ),
  alignLeft: () => (
    <Svg>
      <path d="M2.5 2v12M5 5h8M5 11h5" />
    </Svg>
  ),
  alignHCenter: () => (
    <Svg>
      <path d="M8 2v12M3.5 5h9M5 11h6" />
    </Svg>
  ),
  alignRight: () => (
    <Svg>
      <path d="M13.5 2v12M3 5h8M6 11h5" />
    </Svg>
  ),
  alignTop: () => (
    <Svg>
      <path d="M2 2.5h12M5 5v8M11 5v5" />
    </Svg>
  ),
  alignVCenter: () => (
    <Svg>
      <path d="M2 8h12M5 3.5v9M11 5v6" />
    </Svg>
  ),
  alignBottom: () => (
    <Svg>
      <path d="M2 13.5h12M5 3v8M11 6v5" />
    </Svg>
  ),
  distributeH: () => (
    <Svg>
      <path d="M2 2v12M14 2v12M6.5 5v6M9.5 5v6" />
    </Svg>
  ),
  distributeV: () => (
    <Svg>
      <path d="M2 2h12M2 14h12M5 6.5h6M5 9.5h6" />
    </Svg>
  ),
};

export type IconName = keyof typeof Icons;
