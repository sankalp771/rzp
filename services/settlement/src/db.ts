import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { ReplayStore } from '@negotiator/protocol';

/**
 * Settlement persistence (D007). `settlements` is keyed by the cart
 * mandate hash — the idempotency key (PROTOCOL.md §6, §7.8): one row per
 * cart, so at most one Razorpay order can ever be created for it.
 * `settlement_events` is APPEND-ONLY and hash-chained (see events.ts);
 * no code path anywhere may update or delete a row of it (CONSTRAINTS #7).
 */

export type SettlementDb = Database.Database;

export function openDb(
  path: string = process.env['SETTLEMENT_DB_PATH'] ?? 'data/settlement.db',
): SettlementDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: SettlementDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settlements (
      mandate_hash        TEXT PRIMARY KEY,   -- idempotency key (§7.8)
      session_id          TEXT NOT NULL,      -- negotiation session the cart closed
      status              TEXT NOT NULL,      -- accepted | order_created | paid | failed
      amount              INTEGER NOT NULL,   -- minor units
      currency            TEXT NOT NULL,
      receipt_ref         TEXT NOT NULL,      -- Razorpay 'receipt' (≤40 chars) for correlation
      razorpay_order_id   TEXT,
      razorpay_payment_id TEXT,
      attempts            INTEGER NOT NULL DEFAULT 0,
      failure_code        TEXT,
      cart_mandate_json   TEXT NOT NULL,      -- full buyer-signed envelope
      verdict_json        TEXT NOT NULL,      -- full firewall-signed envelope
      receipt_json        TEXT,               -- latest signed settlement_receipt
      receipt_seq         INTEGER NOT NULL DEFAULT 0,  -- our outbound seq in this session
      paid_at             TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );
    -- APPEND-ONLY hash chain per mandate (events.ts). The receipt's
    -- ledger_entry_hash is the entry_hash of the confirming event; Day 10's
    -- ledger absorbs this table instead of inventing a placeholder.
    CREATE TABLE IF NOT EXISTS settlement_events (
      mandate_hash TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      type         TEXT NOT NULL,
      payload      TEXT NOT NULL,             -- JSON
      at           TEXT NOT NULL,
      prev_hash    TEXT NOT NULL,
      entry_hash   TEXT NOT NULL,
      PRIMARY KEY (mandate_hash, seq)
    );
    -- Replay guard memory (PROTOCOL.md §6) for inbound settlement_requests.
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
  `);
}

/** SQLite-backed ReplayStore (duplicated per service by design, see buyer/db.ts). */
export class SqliteReplayStore implements ReplayStore {
  constructor(private readonly db: SettlementDb) {}

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
