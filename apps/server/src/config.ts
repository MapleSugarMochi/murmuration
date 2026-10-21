import { randomBytes } from 'node:crypto';

export interface Config {
  host: string;
  port: number;
  /** Postgres connection string; when unset, documents live in memory. */
  databaseUrl: string | null;
  /** Secret for signing resume tokens. Must be stable across restarts. */
  sessionSecret: string;
  /** Allowed WebSocket origins; empty means same-origin only is not enforced. */
  allowedOrigins: string[];
  /** Directory with the built web app, served when present. */
  publicDir: string | null;
  /** Seconds a room stays loaded after its last connection leaves. */
  roomIdleSeconds: number;
  /** Write a snapshot every this many committed batches. */
  snapshotEvery: number;
  /** Milliseconds to wait while grouping batches into one transaction. */
  commitDelayMs: number;
  logLevel: string;
  /** Abuse limits; raise them for load tests run from one machine. */
  maxConnectionsPerIp: number;
  joinsPerSecondPerIp: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const secret = env.SESSION_SECRET;
  if (production && (!secret || secret.length < 32)) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters in production');
  }
  return {
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 8080),
    databaseUrl: env.DATABASE_URL || null,
    sessionSecret: secret ?? randomBytes(32).toString('hex'),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    publicDir: env.PUBLIC_DIR || null,
    roomIdleSeconds: Number(env.ROOM_IDLE_SECONDS ?? 60),
    snapshotEvery: Number(env.SNAPSHOT_EVERY ?? 1000),
    commitDelayMs: Number(env.COMMIT_DELAY_MS ?? 5),
    logLevel: env.LOG_LEVEL ?? (production ? 'info' : 'debug'),
    maxConnectionsPerIp: Number(env.MAX_CONNECTIONS_PER_IP ?? 50),
    joinsPerSecondPerIp: Number(env.JOINS_PER_SECOND_PER_IP ?? 5),
  };
}
