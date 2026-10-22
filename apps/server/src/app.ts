import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { CLOSE } from '@tandem/room';
import { hashToken, hmacIdentity, newDocId, newToken, roleForToken } from './auth.ts';
import type { Config } from './config.ts';
import { createMetrics, type Metrics } from './metrics.ts';
import { KeyedLimiter } from './rate-limit.ts';
import { RoomManager } from './rooms.ts';
import type { DocMeta, Store } from './store.ts';
import { attachWebSockets } from './ws.ts';

export interface App {
  fastify: FastifyInstance;
  rooms: RoomManager;
  metrics: Metrics;
  /** Graceful shutdown: refuse new work, drain and snapshot every room. */
  shutdown(): Promise<void>;
}

const nameSchema = z.string().trim().min(1).max(100);
const createBody = z.object({ name: nameSchema.optional() }).default({});
const renameBody = z.object({ name: nameSchema });

const CSP = [
  "default-src 'self'",
  "connect-src 'self' ws: wss:",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

export async function buildApp(config: Config, store: Store): Promise<App> {
  const fastify = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 64 * 1024,
    trustProxy: true,
    disableRequestLogging: true,
  });
  const metrics = createMetrics();
  const rooms = new RoomManager({
    store,
    identity: hmacIdentity(config.sessionSecret),
    metrics,
    log: fastify.log,
    idleSeconds: config.roomIdleSeconds,
    snapshotEvery: config.snapshotEvery,
    commitDelayMs: config.commitDelayMs,
  });
  const sockets = attachWebSockets({
    store,
    rooms,
    metrics,
    log: fastify.log,
    allowedOrigins: config.allowedOrigins,
    maxConnectionsPerIp: config.maxConnectionsPerIp,
    joinsPerSecondPerIp: config.joinsPerSecondPerIp,
  });
  fastify.server.on('upgrade', sockets.handleUpgrade);
  const createLimiter = new KeyedLimiter(0.2, 10);
  let shuttingDown = false;

  fastify.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ code: 'bad_request', message: err.issues[0]?.message });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) fastify.log.error({ err }, 'request failed');
    return reply
      .code(status)
      .send({ code: status >= 500 ? 'internal' : 'bad_request', message: err.message });
  });

  fastify.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    const type = reply.getHeader('content-type');
    if (typeof type === 'string' && type.startsWith('text/html')) {
      reply.header('Content-Security-Policy', CSP);
    }
  });

  /** Loads the doc and checks the bearer token, replying 401/404 if not. */
  async function authorize(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const doc = await store.getDoc(req.params.id);
    if (!doc) {
      reply.code(404).send({ code: 'not_found', message: 'document not found' });
      return null;
    }
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const role = token ? roleForToken(doc, token) : null;
    if (!role) {
      reply.code(401).send({ code: 'unauthorized', message: 'invalid or expired link' });
      return null;
    }
    return { doc, role };
  }

  fastify.post('/api/docs', async (req, reply) => {
    if (!createLimiter.take(req.ip)) {
      return reply.code(429).send({ code: 'rate_limited', message: 'too many documents created' });
    }
    const body = createBody.parse(req.body ?? {});
    const editToken = newToken();
    const viewToken = newToken();
    const now = new Date();
    const meta: DocMeta = {
      id: newDocId(),
      name: body.name ?? 'Untitled',
      editTokenHash: hashToken(editToken),
      viewTokenHash: hashToken(viewToken),
      createdAt: now,
      updatedAt: now,
    };
    await store.createDoc(meta);
    return reply.code(201).send({ id: meta.id, name: meta.name, editToken, viewToken });
  });

  fastify.get<{ Params: { id: string } }>('/api/docs/:id', async (req, reply) => {
    const auth = await authorize(req, reply);
    if (!auth) return;
    return { id: auth.doc.id, name: auth.doc.name, role: auth.role };
  });

  fastify.patch<{ Params: { id: string } }>('/api/docs/:id', async (req, reply) => {
    const auth = await authorize(req, reply);
    if (!auth) return;
    if (auth.role !== 'edit')
      return reply.code(403).send({ code: 'read_only', message: 'read only' });
    const { name } = renameBody.parse(req.body);
    await store.renameDoc(auth.doc.id, name);
    rooms.get(auth.doc.id)?.server.rename(name);
    return { id: auth.doc.id, name };
  });

  fastify.post<{ Params: { id: string } }>('/api/docs/:id/rotate-links', async (req, reply) => {
    const auth = await authorize(req, reply);
    if (!auth) return;
    if (auth.role !== 'edit')
      return reply.code(403).send({ code: 'read_only', message: 'read only' });
    const editToken = newToken();
    const viewToken = newToken();
    await store.setTokenHashes(auth.doc.id, hashToken(editToken), hashToken(viewToken));
    // Everyone, including the caller, must rejoin with a new link.
    rooms.get(auth.doc.id)?.server.closeAll(CLOSE.policy, {
      code: 'links_rotated',
      message: 'share links were reset',
    });
    return { editToken, viewToken };
  });

  fastify.get('/healthz', async () => ({ ok: true }));

  fastify.get('/readyz', async (_req, reply) => {
    if (shuttingDown) return reply.code(503).send({ ok: false });
    await store.ping();
    return { ok: true };
  });

  let metricsServer: Server | null = null;
  if (config.metricsPort === null) {
    fastify.get('/metrics', async (_req, reply) => {
      reply.header('content-type', metrics.registry.contentType);
      return metrics.registry.metrics();
    });
  } else {
    metricsServer = createServer((req, res) => {
      if (req.url !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      metrics.registry.metrics().then(
        (body) => res.writeHead(200, { 'content-type': metrics.registry.contentType }).end(body),
        () => res.writeHead(500).end(),
      );
    });
    metricsServer.listen(config.metricsPort, config.host);
  }

  if (config.publicDir && existsSync(config.publicDir)) {
    const root = resolve(config.publicDir);
    await fastify.register(fastifyStatic, { root, wildcard: false });
    // Client-side routes all serve the app shell.
    fastify.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ code: 'not_found', message: 'not found' });
    });
  }

  return {
    fastify,
    rooms,
    metrics,
    async shutdown() {
      shuttingDown = true;
      await rooms.shutdown();
      await sockets.close();
      await fastify.close();
      metricsServer?.close();
      await store.close();
    },
  };
}
