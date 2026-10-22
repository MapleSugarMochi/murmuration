import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return {
    registry,
    activeRooms: new Gauge({
      name: 'murmuration_active_rooms',
      help: 'Rooms loaded in memory',
      registers: [registry],
    }),
    connections: new Gauge({
      name: 'murmuration_connections',
      help: 'Open WebSocket connections',
      registers: [registry],
    }),
    opsApplied: new Counter({
      name: 'murmuration_ops_applied_total',
      help: 'Ops in committed batches',
      registers: [registry],
    }),
    batchesCommitted: new Counter({
      name: 'murmuration_batches_committed_total',
      help: 'Batches persisted',
      registers: [registry],
    }),
    rejects: new Counter({
      name: 'murmuration_batches_rejected_total',
      help: 'Rejected batches by reason',
      labelNames: ['reason'],
      registers: [registry],
    }),
    persistSeconds: new Histogram({
      name: 'murmuration_persist_seconds',
      help: 'Time to persist one group commit',
      buckets: [0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1],
      registers: [registry],
    }),
    backpressureDisconnects: new Counter({
      name: 'murmuration_backpressure_disconnects_total',
      help: 'Connections closed because they fell too far behind',
      registers: [registry],
    }),
    rateLimited: new Counter({
      name: 'murmuration_rate_limited_total',
      help: 'Messages dropped by rate limits',
      labelNames: ['kind'],
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
