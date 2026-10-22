import pg from 'pg';
import type { CommittedBatch, RoomSnapshot } from '@murmuration/room';
import type { DocMeta, Store, StoredRoom } from './store.ts';

/**
 * Ordered schema migrations. Append only: never edit a migration that has
 * shipped. Each runs in its own transaction under an advisory lock.
 */
const MIGRATIONS: Array<{ id: number; name: string; sql: string }> = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE documents (
        id              text PRIMARY KEY,
        name            text NOT NULL,
        edit_token_hash text NOT NULL,
        view_token_hash text NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE ops (
        doc_id     text   NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        seq        bigint NOT NULL,
        client_id  text   NOT NULL,
        batch_id   bigint NOT NULL,
        ops        jsonb  NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (doc_id, seq)
      );
      CREATE TABLE snapshots (
        doc_id     text   NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        seq        bigint NOT NULL,
        data       jsonb  NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (doc_id, seq)
      );
    `,
  },
];

const MIGRATION_LOCK = 742_031;
/** Concurrent append statements; the rest queue and merge. */
const MAX_WRITES_IN_FLIGHT = 4;

interface DocRow {
  id: string;
  name: string;
  edit_token_hash: string;
  view_token_hash: string;
  created_at: Date;
  updated_at: Date;
}

export class PgStore implements Store {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
    // bigint columns hold seqs well below 2^53.
    pg.types.setTypeParser(20, (v) => Number(v));
  }

  async migrate(): Promise<number[]> {
    const client = await this.pool.connect();
    const applied: number[] = [];
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        id integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      const { rows } = await client.query<{ id: number }>('SELECT id FROM schema_migrations');
      const done = new Set(rows.map((r) => r.id));
      for (const m of MIGRATIONS) {
        if (done.has(m.id)) continue;
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [
            m.id,
            m.name,
          ]);
          await client.query('COMMIT');
          applied.push(m.id);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
      client.release();
    }
    return applied;
  }

  async createDoc(meta: DocMeta): Promise<void> {
    await this.pool.query(
      `INSERT INTO documents (id, name, edit_token_hash, view_token_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [meta.id, meta.name, meta.editTokenHash, meta.viewTokenHash, meta.createdAt, meta.updatedAt],
    );
  }

  async getDoc(id: string): Promise<DocMeta | null> {
    const { rows } = await this.pool.query<DocRow>('SELECT * FROM documents WHERE id = $1', [id]);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      editTokenHash: r.edit_token_hash,
      viewTokenHash: r.view_token_hash,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async renameDoc(id: string, name: string): Promise<void> {
    await this.pool.query('UPDATE documents SET name = $2, updated_at = now() WHERE id = $1', [
      id,
      name,
    ]);
  }

  async setTokenHashes(id: string, editTokenHash: string, viewTokenHash: string): Promise<void> {
    await this.pool.query(
      'UPDATE documents SET edit_token_hash = $2, view_token_hash = $3, updated_at = now() WHERE id = $1',
      [id, editTokenHash, viewTokenHash],
    );
  }

  async loadRoom(id: string): Promise<StoredRoom> {
    const snap = await this.pool.query<{ data: RoomSnapshot }>(
      'SELECT data FROM snapshots WHERE doc_id = $1 ORDER BY seq DESC LIMIT 1',
      [id],
    );
    const snapshot = snap.rows[0]?.data ?? null;
    const { rows } = await this.pool.query<{
      seq: number;
      client_id: string;
      batch_id: number;
      ops: CommittedBatch['ops'];
    }>(
      'SELECT seq, client_id, batch_id, ops FROM ops WHERE doc_id = $1 AND seq > $2 ORDER BY seq',
      [id, snapshot?.seq ?? 0],
    );
    return {
      snapshot,
      batches: rows.map((r) => ({
        seq: r.seq,
        clientId: r.client_id,
        batchId: r.batch_id,
        ops: r.ops,
      })),
    };
  }

  /**
   * Appends go through a store-wide writer that merges pending appends from
   * every document into one INSERT, with at most a few statements in flight.
   * With many active documents this turns thousands of tiny commits per
   * second, all competing for pool connections, into a handful of larger
   * ones. A room never has two appends outstanding, so per-document order
   * holds.
   */
  appendBatches(id: string, batches: CommittedBatch[]): Promise<void> {
    if (batches.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      for (const b of batches) {
        this.pendingRows.push({
          doc_id: id,
          seq: b.seq,
          client_id: b.clientId,
          batch_id: b.batchId,
          ops: b.ops,
        });
      }
      this.pendingWaiters.push({ resolve, reject });
      this.writeNext();
    });
  }

  private pendingRows: Array<{
    doc_id: string;
    seq: number;
    client_id: string;
    batch_id: number;
    ops: CommittedBatch['ops'];
  }> = [];
  private pendingWaiters: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];
  private writesInFlight = 0;

  private writeNext(): void {
    if (this.writesInFlight >= MAX_WRITES_IN_FLIGHT || this.pendingRows.length === 0) return;
    const rows = this.pendingRows;
    const waiters = this.pendingWaiters;
    this.pendingRows = [];
    this.pendingWaiters = [];
    this.writesInFlight++;
    // One statement, so each write is atomic. The primary key rejects a
    // second writer that tries to reuse a seq.
    this.pool
      .query(
        `INSERT INTO ops (doc_id, seq, client_id, batch_id, ops)
         SELECT x.doc_id, x.seq, x.client_id, x.batch_id, x.ops
         FROM jsonb_to_recordset($1::jsonb)
           AS x(doc_id text, seq bigint, client_id text, batch_id bigint, ops jsonb)`,
        [JSON.stringify(rows)],
      )
      .then(
        () => waiters.forEach((w) => w.resolve()),
        (err: unknown) => waiters.forEach((w) => w.reject(err)),
      )
      .finally(() => {
        this.writesInFlight--;
        this.writeNext();
      });
  }

  async saveSnapshot(id: string, snapshot: RoomSnapshot): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO snapshots (doc_id, seq, data) VALUES ($1, $2, $3) ON CONFLICT (doc_id, seq) DO NOTHING',
        [id, snapshot.seq, JSON.stringify(snapshot)],
      );
      // Keep the latest two snapshots; the op log is kept in full.
      await client.query(
        `DELETE FROM snapshots WHERE doc_id = $1 AND seq < (
           SELECT seq FROM snapshots WHERE doc_id = $1 ORDER BY seq DESC OFFSET 1 LIMIT 1)`,
        [id],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
