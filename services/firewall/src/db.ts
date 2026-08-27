import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { ReplayStore } from '@negotiator/protocol';

/**
 * Firewall persistence (D007). The trust root of the money path lives here:
 * `mandates` holds the principal-signed Intent Mandates deposited via
 * mandate_register — THE ONLY copies the firewall ever audits against
 * (D010, PROTOCOL.md §7.0). `carts` records every cart_mandate received
 * plus the visible dispatch state of its allow (amendment #4). `verdicts`
 * is APPEND-ONLY: a re-issued verdict (Day 9's human decision) appends a
 * new seq; nothing updates or deletes a row (CONSTRAINTS #7).
 */

export type FirewallDb = Database.Database;

export function openDb(
  path: string = process.env['FIREWALL_DB_PATH'] ?? 'data/firewall.db',
): FirewallDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: FirewallDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mandates (
      intent_mandate_ref   TEXT PRIMARY KEY,   -- sha256(JCS(mandate)), §7.1
      mandate_json         TEXT NOT NULL,      -- the principal-signed artifact, verbatim
      principal_id         TEXT NOT NULL,
      principal_public_key TEXT NOT NULL,
      buyer_agent_id       TEXT NOT NULL,
      buyer_public_key     TEXT NOT NULL,      -- pinned at registration; the only key a cart may carry
      register_session_id  TEXT NOT NULL,      -- the registration exchange's own session id
      registered_at        TEXT NOT NULL
    );
    -- One negotiation session binds to exactly one cart (§9: AGREED → COMPLIANCE_REVIEW once).
    CREATE TABLE IF NOT EXISTS sessions (
      session_id         TEXT PRIMARY KEY,
      intent_mandate_ref TEXT NOT NULL,
      cart_mandate_hash  TEXT NOT NULL,
      state              TEXT NOT NULL,        -- COMPLIANCE_REVIEW | SETTLING | BLOCKED
      created_at         TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS carts (
      cart_mandate_hash     TEXT PRIMARY KEY,
      session_id            TEXT NOT NULL,
      intent_mandate_ref    TEXT NOT NULL,
      principal_id          TEXT NOT NULL,     -- denormalized: velocity is keyed per principal
      seller_agent_id       TEXT NOT NULL,
      total                 INTEGER NOT NULL,
      cart_json             TEXT NOT NULL,     -- full buyer-signed envelope
      received_at           TEXT NOT NULL,
      -- Amendment #4: an allow whose settlement dispatch failed is still an
      -- allow; the failure is visible here and in the log, never silent.
      settlement_dispatched INTEGER NOT NULL DEFAULT 0,
      settlement_error      TEXT,
      seller_notified       INTEGER NOT NULL DEFAULT 0,
      seller_error          TEXT
    );
    -- APPEND-ONLY. The latest seq is the current verdict for a cart.
    CREATE TABLE IF NOT EXISTS verdicts (
      cart_mandate_hash TEXT NOT NULL,
      seq               INTEGER NOT NULL,
      verdict           TEXT NOT NULL,         -- allow | block | escalate
      layer             TEXT NOT NULL,         -- policy | intent_verifier | human
      reasons_json      TEXT NOT NULL,
      details_json      TEXT NOT NULL,         -- human-readable per reason (logs/dashboard)
      verdict_json      TEXT NOT NULL,         -- signed firewall_verdict envelope
      issued_at         TEXT NOT NULL,
      verifier_json     TEXT,                  -- layer-2 attribution: model, latency, raw recommendation / absence
      PRIMARY KEY (cart_mandate_hash, seq)
    );
    -- The human approval queue (FEATURE-009, §7.9). A row is DECIDED EXACTLY
    -- ONCE: the claim is "UPDATE ... WHERE status = 'pending'" inside the
    -- same transaction that appends the human verdict, so a human decision
    -- and the timeout sweep can never both produce one (amendment #1).
    CREATE TABLE IF NOT EXISTS escalations (
      cart_mandate_hash TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL,
      held_since        TEXT NOT NULL,
      expires_at        TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending', -- pending | decided
      decision          TEXT,                            -- approve | reject | timeout
      reviewer          TEXT,
      note              TEXT,
      decided_at        TEXT
    );
    -- Outbound seq per (session, receiver) — PROTOCOL.md §6 streams.
    CREATE TABLE IF NOT EXISTS streams (
      session_id TEXT NOT NULL,
      receiver   TEXT NOT NULL,
      seq        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, receiver)
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
  `);
  // Day 8 volumes predate layer 2; adding a nullable column is not an edit
  // of any existing verdict row (CONSTRAINTS #7).
  const cols = db.prepare('PRAGMA table_info(verdicts)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'verifier_json')) {
    db.exec('ALTER TABLE verdicts ADD COLUMN verifier_json TEXT');
  }
}

/** Next outbound seq on the (session, receiver) stream — §6. */
export function nextStreamSeq(db: FirewallDb, sessionId: string, receiver: string): number {
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO streams (session_id, receiver, seq) VALUES (?, ?, 1)
       ON CONFLICT(session_id, receiver) DO UPDATE SET seq = seq + 1`,
    ).run(sessionId, receiver);
    return (
      db
        .prepare('SELECT seq FROM streams WHERE session_id = ? AND receiver = ?')
        .get(sessionId, receiver) as { seq: number }
    ).seq;
  })();
}

/** SQLite-backed ReplayStore (duplicated per service by design, see buyer/db.ts). */
export class SqliteReplayStore implements ReplayStore {
  constructor(private readonly db: FirewallDb) {}

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
