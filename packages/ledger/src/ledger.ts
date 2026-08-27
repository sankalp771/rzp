import type Database from 'better-sqlite3';
import { canonicalize, sha256Hex, type JsonValue } from '@negotiator/protocol';

/**
 * Entry format (PROTOCOL.md §11, D018 generalised):
 *
 *   entry_hash = sha256( prev_entry_hash ‖ JCS({entry_seq, at, entry_type, session_id, ref, payload}) )
 *
 * with the genesis prev_entry_hash = 64 zero nibbles. `entry_seq` is the
 * service-wide sequence (sessions interleave), so a single session's
 * entries are NOT a verifiable chain on their own — verification is
 * always whole-ledger; a session view is a filter over a verified ledger
 * plus a cross-party envelope comparison (FEATURE-010 amendment #3).
 */

export const GENESIS_HASH = '0'.repeat(64);

export const ENTRY_TYPES = [
  'MESSAGE_IN', // accepted at the boundary and handed to a handler
  'MESSAGE_OUT', // signed and sent (or replied)
  'BOUNDARY_REJECTED', // F5: failed signature/schema/replay/skew; session untouched
  'HANDLER_REJECTED', // authenticated but refused (error reply, seq consumed)
  'BOUNDS_CLAMPED', // §7.5: the policy engine altered an LLM proposal
  'LLM_MOVE', // per-round model attribution (advisory)
  'VERDICT', // firewall: every verdict issued (any layer)
  'VERIFIER_ABSENT', // firewall: layer 2 configured but no usable recommendation
  'ESCALATION_DECIDED', // firewall: approve | reject | timeout claimed
  'ESCALATION_TIMEOUT', // firewall: T10 auto-block
  'SETTLEMENT_EVENT', // settlement: D018 money-chain event, imported verbatim
  'SESSION_STATE', // a party's own state transition (§9 divergence detection)
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export interface LedgerEntry {
  entry_seq: number;
  at: string;
  entry_type: EntryType;
  session_id: string | null;
  /** Secondary key: mandate hash, cart hash, etc. */
  ref: string | null;
  payload: Record<string, JsonValue>;
  prev_entry_hash: string;
  entry_hash: string;
}

type HashedFields = Pick<
  LedgerEntry,
  'entry_seq' | 'at' | 'entry_type' | 'session_id' | 'ref' | 'payload'
>;

export function entryHash(prevEntryHash: string, fields: HashedFields): string {
  return sha256Hex(prevEntryHash + canonicalize(fields as unknown as JsonValue));
}

export type ChainVerdict =
  | { ok: true; length: number; head: string }
  | {
      ok: false;
      break_at_seq: number;
      reason: 'sequence_gap' | 'prev_hash_mismatch' | 'entry_hash_mismatch';
      length: number;
    };

export interface ListOptions {
  session_id?: string;
  ref?: string;
  entry_type?: EntryType;
  /** Entries with entry_seq > after. */
  after?: number;
  limit?: number;
}

interface Row {
  entry_seq: number;
  at: string;
  entry_type: EntryType;
  session_id: string | null;
  ref: string | null;
  payload_json: string;
  prev_entry_hash: string;
  entry_hash: string;
}

export function migrateLedger(db: Database.Database): void {
  // An auditor verifies a COPY of a database opened read-only: never write
  // to a ledger that already exists (also keeps `verify` side-effect free).
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_entries'")
    .get();
  if (exists) return;
  db.exec(`
    -- APPEND-ONLY (CONSTRAINTS #7). No code path anywhere may UPDATE or
    -- DELETE here; packages/ledger/src/ledger.test.ts greps every workspace.
    CREATE TABLE IF NOT EXISTS ledger_entries (
      entry_seq       INTEGER PRIMARY KEY,
      at              TEXT NOT NULL,
      entry_type      TEXT NOT NULL,
      session_id      TEXT,
      ref             TEXT,
      payload_json    TEXT NOT NULL,          -- JCS form, exactly what was hashed
      prev_entry_hash TEXT NOT NULL,
      entry_hash      TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS ledger_session ON ledger_entries (session_id, entry_seq);
    CREATE INDEX IF NOT EXISTS ledger_ref ON ledger_entries (ref, entry_seq);
  `);
}

export class Ledger {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    migrateLedger(db);
  }

  /** Append one entry; the head read and the insert are one transaction. */
  append(
    entryType: EntryType,
    payload: Record<string, JsonValue>,
    keys: { session_id?: string | null; ref?: string | null } = {},
  ): LedgerEntry {
    return this.db.transaction((): LedgerEntry => {
      const head = this.db
        .prepare('SELECT entry_seq, entry_hash FROM ledger_entries ORDER BY entry_seq DESC LIMIT 1')
        .get() as { entry_seq: number; entry_hash: string } | undefined;
      const fields: HashedFields = {
        entry_seq: (head?.entry_seq ?? 0) + 1,
        at: this.now().toISOString(),
        entry_type: entryType,
        session_id: keys.session_id ?? null,
        ref: keys.ref ?? null,
        payload,
      };
      const prev_entry_hash = head?.entry_hash ?? GENESIS_HASH;
      const entry: LedgerEntry = {
        ...fields,
        prev_entry_hash,
        entry_hash: entryHash(prev_entry_hash, fields),
      };
      this.db
        .prepare(
          `INSERT INTO ledger_entries (entry_seq, at, entry_type, session_id, ref, payload_json, prev_entry_hash, entry_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.entry_seq,
          entry.at,
          entry.entry_type,
          entry.session_id,
          entry.ref,
          canonicalize(payload as unknown as JsonValue),
          entry.prev_entry_hash,
          entry.entry_hash,
        );
      return entry;
    })();
  }

  list(opts: ListOptions = {}): LedgerEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.session_id) {
      where.push('session_id = ?');
      args.push(opts.session_id);
    }
    if (opts.ref) {
      where.push('ref = ?');
      args.push(opts.ref);
    }
    if (opts.entry_type) {
      where.push('entry_type = ?');
      args.push(opts.entry_type);
    }
    if (opts.after !== undefined) {
      where.push('entry_seq > ?');
      args.push(opts.after);
    }
    const sql = `SELECT * FROM ledger_entries${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY entry_seq LIMIT ?`;
    args.push(Math.min(opts.limit ?? 1000, 10_000));
    return (this.db.prepare(sql).all(...args) as Row[]).map(toEntry);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number }).n;
  }

  head(): LedgerEntry | null {
    const row = this.db
      .prepare('SELECT * FROM ledger_entries ORDER BY entry_seq DESC LIMIT 1')
      .get() as Row | undefined;
    return row ? toEntry(row) : null;
  }

  /**
   * Walk the WHOLE chain recomputing every hash; report the first break
   * (Gate 5). Streams rows so a long ledger does not need to fit in memory.
   */
  verify(): ChainVerdict {
    let prev = GENESIS_HASH;
    let expectedSeq = 1;
    let length = 0;
    for (const row of this.db
      .prepare('SELECT * FROM ledger_entries ORDER BY entry_seq')
      .iterate() as IterableIterator<Row>) {
      const e = toEntry(row);
      if (e.entry_seq !== expectedSeq) {
        return { ok: false, break_at_seq: e.entry_seq, reason: 'sequence_gap', length };
      }
      if (e.prev_entry_hash !== prev) {
        return { ok: false, break_at_seq: e.entry_seq, reason: 'prev_hash_mismatch', length };
      }
      const expected = entryHash(prev, {
        entry_seq: e.entry_seq,
        at: e.at,
        entry_type: e.entry_type,
        session_id: e.session_id,
        ref: e.ref,
        payload: e.payload,
      });
      if (expected !== e.entry_hash) {
        return { ok: false, break_at_seq: e.entry_seq, reason: 'entry_hash_mismatch', length };
      }
      prev = e.entry_hash;
      expectedSeq += 1;
      length += 1;
    }
    return { ok: true, length, head: prev };
  }
}

function toEntry(r: Row): LedgerEntry {
  return {
    entry_seq: r.entry_seq,
    at: r.at,
    entry_type: r.entry_type,
    session_id: r.session_id,
    ref: r.ref,
    payload: JSON.parse(r.payload_json) as Record<string, JsonValue>,
    prev_entry_hash: r.prev_entry_hash,
    entry_hash: r.entry_hash,
  };
}
