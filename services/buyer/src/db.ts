import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { ReplayStore } from '@negotiator/protocol';

/**
 * Buyer persistence (D007): sessions (with the per-session buyer keypair and
 * the seller key pinned from session_ack) and the replay guard's memory for
 * inbound seller replies — a buyer restart never re-accepts a reply it has
 * already seen (PROTOCOL.md §6) and never forgets a pinned seller key (§5).
 */

export type BuyerDb = Database.Database;

export function openDb(path: string = process.env['BUYER_DB_PATH'] ?? 'data/buyer.db'): BuyerDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: BuyerDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id        TEXT PRIMARY KEY,
      state             TEXT NOT NULL,     -- PROTOCOL.md §9
      merchant_url      TEXT NOT NULL,
      buyer_agent_id    TEXT NOT NULL,
      buyer_public_key  TEXT NOT NULL,     -- per-session buyer key
      buyer_private_key TEXT NOT NULL,
      seller_agent_id   TEXT,              -- learned from session_ack
      seller_public_key TEXT,              -- pinned at session_ack (TOFU, §5)
      chosen_version    TEXT,
      buyer_seq         INTEGER NOT NULL DEFAULT 0,  -- our outbound counter
      round             INTEGER NOT NULL DEFAULT 0,
      mandate_ref       TEXT NOT NULL,     -- intent_mandate_ref (§7.1)
      -- Amendment #3 / D010: 0 until mandate_register is delivered to the
      -- firewall. No firewall exists until Day 8, so every Day 5 session
      -- carries a visible 0 here and the runner logs it on every run — the
      -- integration point is a TODO in the data, not a memory.
      mandate_registered INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL
    );
    -- Replay guard memory (PROTOCOL.md §6), inbound (seller replies) only.
    CREATE TABLE IF NOT EXISTS replay_seqs (
      session_id TEXT NOT NULL,
      agent_id   TEXT NOT NULL,
      highest    INTEGER NOT NULL,
      PRIMARY KEY (session_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS replay_message_ids (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (session_id, message_id)
    );
    -- Per-round model attribution (FEATURE-006 amendment #3), buyer side.
    CREATE TABLE IF NOT EXISTS llm_moves (
      session_id      TEXT NOT NULL,
      round           INTEGER NOT NULL,
      role            TEXT NOT NULL,
      model_id        TEXT NOT NULL,
      used_llm        INTEGER NOT NULL,
      fallback_reason TEXT,
      latency_ms      INTEGER NOT NULL,
      PRIMARY KEY (session_id, round, role)
    );
  `);
  // Day 6 column on a Day 5 table (buyer.db persists on a named volume).
  ensureColumn(db, 'sessions', 'buyer_model', 'TEXT');
}

function ensureColumn(db: BuyerDb, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

/**
 * SQLite-backed ReplayStore. Deliberately duplicated from the merchant
 * (~30 lines): each service owns its schema, and the protocol package must
 * stay free of the better-sqlite3 dependency.
 */
export class SqliteReplayStore implements ReplayStore {
  constructor(private readonly db: BuyerDb) {}

  highestSeq(sessionId: string, agentId: string): number {
    const row = this.db
      .prepare('SELECT highest FROM replay_seqs WHERE session_id = ? AND agent_id = ?')
      .get(sessionId, agentId) as { highest: number } | undefined;
    return row?.highest ?? 0;
  }

  hasMessageId(sessionId: string, messageId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM replay_message_ids WHERE session_id = ? AND message_id = ?')
        .get(sessionId, messageId) !== undefined
    );
  }

  record(sessionId: string, agentId: string, seq: number, messageId: string): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO replay_seqs (session_id, agent_id, highest) VALUES (?, ?, ?)
           ON CONFLICT(session_id, agent_id) DO UPDATE SET highest = excluded.highest`,
        )
        .run(sessionId, agentId, seq);
      this.db
        .prepare('INSERT INTO replay_message_ids (session_id, message_id) VALUES (?, ?)')
        .run(sessionId, messageId);
    });
    tx();
  }
}
