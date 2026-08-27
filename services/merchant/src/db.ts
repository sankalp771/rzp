import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { ReplayStore } from '@negotiator/protocol';

/**
 * Merchant persistence (D007): one SQLite file holds catalog, policy,
 * session state and the replay guard's memory, so a merchant restart never
 * re-accepts an already-seen message (PROTOCOL.md §6) and never forgets a
 * pinned buyer key (§5).
 */

export type MerchantDb = Database.Database;

export function openDb(
  path: string = process.env['MERCHANT_DB_PATH'] ?? 'data/merchant.db',
): MerchantDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: MerchantDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_items (
      item_id     TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT NOT NULL,
      category    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS variants (
      variant_id  TEXT PRIMARY KEY,
      item_id     TEXT NOT NULL REFERENCES catalog_items(item_id),
      attributes  TEXT NOT NULL,           -- JSON object
      list_price  INTEGER NOT NULL,        -- minor units
      floor_price INTEGER NOT NULL,        -- absolute floor, minor units (never on the wire)
      stock       INTEGER NOT NULL
    );
    -- Single-row policy table; the dashboard edits it later (Day 10).
    CREATE TABLE IF NOT EXISTS merchant_policy (
      id     INTEGER PRIMARY KEY CHECK (id = 1),
      config TEXT NOT NULL                 -- JSON, validated by policy.ts on read
    );
    CREATE TABLE IF NOT EXISTS sessions (
      session_id        TEXT PRIMARY KEY,
      state             TEXT NOT NULL,     -- PROTOCOL.md §9
      buyer_agent_id    TEXT NOT NULL,
      buyer_public_key  TEXT NOT NULL,     -- pinned at session_init (TOFU)
      seller_agent_id   TEXT NOT NULL,
      seller_public_key TEXT NOT NULL,     -- per-session seller key
      seller_private_key TEXT NOT NULL,
      chosen_version    TEXT NOT NULL,
      seller_seq        INTEGER NOT NULL DEFAULT 0,  -- our outbound counter
      round             INTEGER NOT NULL DEFAULT 0,
      last_offer_json   TEXT,              -- our latest outbound offer body (echo checks)
      created_at        TEXT NOT NULL
    );
    -- Replay guard memory (PROTOCOL.md §6), inbound only.
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
    -- Per-round model attribution (FEATURE-006 amendment #3): which model
    -- proposed, or why the deterministic curve was used instead. Feeds the
    -- evals' unusable-output rate per provider.
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
  // Day 6 column on a Day 4 table: named volumes persist merchant.db across
  // image rebuilds, so additive migrations must be idempotent.
  ensureColumn(db, 'sessions', 'seller_model', 'TEXT');
  // Day 8 columns (FEATURE-008): the seller's side of the compliance and
  // settlement legs. served_hashes_json = item_id → catalog_hash as served
  // in THIS session, so a cart copy is checked against what we actually
  // said, not against whatever the catalog looks like now.
  ensureColumn(db, 'sessions', 'served_hashes_json', 'TEXT');
  ensureColumn(db, 'sessions', 'accept_message_id', 'TEXT');
  ensureColumn(db, 'sessions', 'agreed_json', 'TEXT'); // {line_items, total} at AGREED
  ensureColumn(db, 'sessions', 'cart_mandate_hash', 'TEXT');
  ensureColumn(db, 'sessions', 'verdict', 'TEXT');
  // Day 9 (FEATURE-009): who decided — policy | intent_verifier | human — and why.
  ensureColumn(db, 'sessions', 'verdict_layer', 'TEXT');
  ensureColumn(db, 'sessions', 'verdict_reasons_json', 'TEXT');
  ensureColumn(db, 'sessions', 'settlement_status', 'TEXT');
  ensureColumn(db, 'sessions', 'razorpay_order_id', 'TEXT');
}

function ensureColumn(db: MerchantDb, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

/** SQLite-backed ReplayStore (interface from @negotiator/protocol). */
export class SqliteReplayStore implements ReplayStore {
  constructor(private readonly db: MerchantDb) {}

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
