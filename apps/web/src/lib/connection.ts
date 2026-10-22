import type { ErrorCode } from '@tandem/protocol';
import type { SyncClient } from '@tandem/sync-client';

/** Errors after which reconnecting cannot help. */
const FATAL: ReadonlySet<ErrorCode> = new Set([
  'unauthorized',
  'not_found',
  'links_rotated',
  'protocol_version',
]);

/**
 * Owns the WebSocket for a SyncClient: connects, forwards messages and
 * reconnects with exponential backoff (0.5 s doubling to 10 s, with jitter).
 */
export class Connection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: number | null = null;
  private pingTimer: number | null = null;
  private stopped = false;
  private offline = false;
  fatal: { code: ErrorCode; message: string } | null = null;
  onFatal: ((error: { code: ErrorCode; message: string }) => void) | null = null;

  constructor(
    private readonly sync: SyncClient,
    private readonly url: string = defaultUrl(),
  ) {
    sync.errors.on((err) => {
      if (FATAL.has(err.code)) {
        this.fatal = { code: err.code, message: err.message };
        this.stop();
        this.onFatal?.(this.fatal);
      }
    });
  }

  start(): void {
    this.stopped = false;
    window.addEventListener('online', this.reconnectNow);
    this.open();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.reconnectNow);
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  /**
   * Test hook: `true` drops the socket and holds off reconnecting, as a
   * network outage would; `false` lets it reconnect at once. Browser offline
   * emulation is not reliable for this (it ignores localhost in Chromium).
   */
  simulateOffline(offline: boolean): void {
    this.offline = offline;
    if (offline) this.ws?.close(4001, 'simulated outage');
    else this.reconnectNow();
  }

  private readonly reconnectNow = () => {
    if (this.stopped || this.ws) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.attempt = 0;
    this.open();
  };

  private open(): void {
    this.timer = null;
    if (this.offline) {
      this.timer = window.setTimeout(() => this.open(), 500);
      return;
    }
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.sync.connect((raw) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(raw);
      });
      this.pingTimer = window.setInterval(() => this.sync.ping(), 15_000);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') this.sync.receive(e.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer !== null) clearInterval(this.pingTimer);
      this.sync.disconnect();
      if (this.stopped) return;
      const delay = Math.min(10_000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
      this.timer = window.setTimeout(() => this.open(), delay);
    };
  }
}

function defaultUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
