import { canonicalize, sha256Hex, type JsonValue } from '@negotiator/protocol';
import { Ledger } from '@negotiator/ledger';
import type { SettlementDb } from './db.js';

/**
 * Append-only, hash-chained settlement events (ARCHITECTURE S5, F6 in
 * miniature). Each entry commits to the previous one:
 *
 *   entry_hash = sha256( prev_hash ‖ JCS({mandate_hash, seq, type, payload, at}) )
 *
 * with the genesis prev_hash = 64 zero nibbles. `verifyChain` recomputes
 * the whole chain for a mandate and reports the first break. This module
 * deliberately exports NO update and NO delete (CONSTRAINTS #7); the test
 * suite greps the source tree to keep it that way.
 */

export const GENESIS_HASH = '0'.repeat(64);

/**
 * The service-wide audit ledger (FEATURE-010, D023) over the same database.
 * D018 pre-committed that the global ledger "absorbs rather than re-derives"
 * the money chain: every settlement event below is also appended to it
 * VERBATIM — including its own entry_hash — as a SETTLEMENT_EVENT entry, so
 * the receipt's `ledger_entry_hash` is findable in both chains. One Ledger
 * per db (the migration is idempotent; the cache just avoids re-running it).
 */
const ledgers = new WeakMap<SettlementDb, Ledger>();
export function ledgerFor(db: SettlementDb, now: () => Date): Ledger {
  let l = ledgers.get(db);
  if (!l) {
    l = new Ledger(db, now);
    ledgers.set(db, l);
  }
  return l;
}

export type SettlementEventType =
  | 'REQUEST_ACCEPTED'
  | 'ORDER_RECOVERED'
  | 'SETTLEMENT_ATTEMPT'
  | 'ORDER_CREATED'
  | 'SETTLEMENT_RETRY_EXHAUSTED'
  | 'WEBHOOK_SIG_INVALID'
  | 'PAYMENT_CONFIRMED'
  | 'PAYMENT_FAILED'
  | 'RECEIPT_ISSUED';

export interface SettlementEvent {
  mandate_hash: string;
  seq: number;
  type: SettlementEventType;
  payload: Record<string, unknown>;
  at: string;
  prev_hash: string;
  entry_hash: string;
}

export function entryHash(
  prevHash: string,
  fields: Pick<SettlementEvent, 'mandate_hash' | 'seq' | 'type' | 'payload' | 'at'>,
): string {
  return sha256Hex(prevHash + canonicalize(fields));
}

export function appendEvent(
  db: SettlementDb,
  mandateHash: string,
  type: SettlementEventType,
  payload: Record<string, unknown>,
  now: () => Date,
): SettlementEvent {
  const tx = db.transaction((): SettlementEvent => {
    const head = db
      .prepare(
        'SELECT seq, entry_hash FROM settlement_events WHERE mandate_hash = ? ORDER BY seq DESC LIMIT 1',
      )
      .get(mandateHash) as { seq: number; entry_hash: string } | undefined;
    const seq = (head?.seq ?? 0) + 1;
    const prev_hash = head?.entry_hash ?? GENESIS_HASH;
    const fields = { mandate_hash: mandateHash, seq, type, payload, at: now().toISOString() };
    const entry: SettlementEvent = {
      ...fields,
      prev_hash,
      entry_hash: entryHash(prev_hash, fields),
    };
    db.prepare(
      `INSERT INTO settlement_events (mandate_hash, seq, type, payload, at, prev_hash, entry_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.mandate_hash,
      entry.seq,
      entry.type,
      JSON.stringify(entry.payload),
      entry.at,
      entry.prev_hash,
      entry.entry_hash,
    );
    // Absorb into the service ledger inside the same transaction (D018).
    const row = db
      .prepare('SELECT session_id FROM settlements WHERE mandate_hash = ?')
      .get(mandateHash) as { session_id: string } | undefined;
    ledgerFor(db, now).append('SETTLEMENT_EVENT', entry as unknown as Record<string, JsonValue>, {
      session_id: row?.session_id ?? null,
      ref: mandateHash,
    });
    return entry;
  });
  return tx();
}

export function listEvents(db: SettlementDb, mandateHash: string): SettlementEvent[] {
  return (
    db
      .prepare('SELECT * FROM settlement_events WHERE mandate_hash = ? ORDER BY seq')
      .all(mandateHash) as (Omit<SettlementEvent, 'payload'> & { payload: string })[]
  ).map((r) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown> }));
}

export type ChainVerdict = { ok: true; length: number } | { ok: false; break_at_seq: number };

/** Walk the chain recomputing every hash; report the first break (Gate 5). */
export function verifyChain(db: SettlementDb, mandateHash: string): ChainVerdict {
  let prev = GENESIS_HASH;
  const events = listEvents(db, mandateHash);
  for (const [i, e] of events.entries()) {
    const expected = entryHash(prev, {
      mandate_hash: e.mandate_hash,
      seq: e.seq,
      type: e.type,
      payload: e.payload,
      at: e.at,
    });
    if (e.seq !== i + 1 || e.prev_hash !== prev || e.entry_hash !== expected) {
      return { ok: false, break_at_seq: e.seq };
    }
    prev = e.entry_hash;
  }
  return { ok: true, length: events.length };
}
