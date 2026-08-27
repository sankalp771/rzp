import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ENTRY_TYPES, GENESIS_HASH, Ledger, entryHash } from './ledger.js';

/** Gate 5 in the library: verify, tamper, gap, and the no-update/delete search. */
const NOW = () => new Date('2026-08-28T10:00:00.000Z');
const S1 = 'a1a1a1a1-0000-4000-8000-000000000001';
const S2 = 'b2b2b2b2-0000-4000-8000-000000000002';

function seeded() {
  const db = new Database(':memory:');
  const ledger = new Ledger(db, NOW);
  // Two sessions interleaved, like a real service.
  ledger.append('MESSAGE_IN', { type: 'session_init', message_id: 'm1' }, { session_id: S1 });
  ledger.append('MESSAGE_OUT', { type: 'session_ack', message_id: 'm2' }, { session_id: S1 });
  ledger.append('MESSAGE_IN', { type: 'session_init', message_id: 'm3' }, { session_id: S2 });
  ledger.append('BOUNDARY_REJECTED', { code: 'SIG_INVALID' }, {});
  ledger.append('VERDICT', { verdict: 'allow' }, { session_id: S1, ref: 'c'.repeat(64) });
  return { db, ledger };
}

describe('ledger chain (PROTOCOL §11, Gate 5)', () => {
  it('links every entry to the previous one from genesis and verifies end to end', () => {
    const { ledger } = seeded();
    const all = ledger.list();
    expect(all.map((e) => e.entry_seq)).toEqual([1, 2, 3, 4, 5]);
    expect(all[0]!.prev_entry_hash).toBe(GENESIS_HASH);
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.prev_entry_hash).toBe(all[i - 1]!.entry_hash);
      expect(all[i]!.entry_hash).toBe(
        entryHash(all[i - 1]!.entry_hash, {
          entry_seq: all[i]!.entry_seq,
          at: all[i]!.at,
          entry_type: all[i]!.entry_type,
          session_id: all[i]!.session_id,
          ref: all[i]!.ref,
          payload: all[i]!.payload,
        }),
      );
    }
    expect(ledger.verify()).toEqual({ ok: true, length: 5, head: all[4]!.entry_hash });
    expect(ledger.head()?.entry_seq).toBe(5);
    expect(ledger.count()).toBe(5);
  });

  it('filters are views over the verified ledger, never a sub-chain', () => {
    const { ledger } = seeded();
    const s1 = ledger.list({ session_id: S1 });
    expect(s1.map((e) => e.entry_seq)).toEqual([1, 2, 5]);
    // Entry 5's prev points at entry 4 (another session's / no session) —
    // a single-session slice cannot be hash-verified on its own (amendment #3).
    expect(s1[2]!.prev_entry_hash).not.toBe(s1[1]!.entry_hash);
    expect(ledger.list({ ref: 'c'.repeat(64) })).toHaveLength(1);
    expect(ledger.list({ entry_type: 'BOUNDARY_REJECTED' })).toHaveLength(1);
    expect(ledger.list({ after: 3 }).map((e) => e.entry_seq)).toEqual([4, 5]);
    expect(ledger.list({ limit: 2 })).toHaveLength(2);
  });

  it('TAMPER: an out-of-band edit of entry k is reported at exactly k', () => {
    const { db, ledger } = seeded();
    // Out-of-band: this is what an attacker with DB access does; no code
    // path in any workspace does it (see the source search below).
    db.prepare(
      'UPDATE ledger_entries SET payload_json = \'{"verdict":"block"}\' WHERE entry_seq = 3',
    ).run();
    expect(ledger.verify()).toEqual({
      ok: false,
      break_at_seq: 3,
      reason: 'entry_hash_mismatch',
      length: 2,
    });
  });

  it('TAMPER: re-hashing the edited entry moves the break to k+1 (the chain, not the row, is the evidence)', () => {
    const { db, ledger } = seeded();
    const rows = ledger.list();
    const forged = { ...rows[2]!, payload: { type: 'session_init', message_id: 'FORGED' } };
    const forgedHash = entryHash(rows[1]!.entry_hash, {
      entry_seq: forged.entry_seq,
      at: forged.at,
      entry_type: forged.entry_type,
      session_id: forged.session_id,
      ref: forged.ref,
      payload: forged.payload,
    });
    db.prepare(
      'UPDATE ledger_entries SET payload_json = ?, entry_hash = ? WHERE entry_seq = 3',
    ).run(JSON.stringify(forged.payload), forgedHash);
    expect(ledger.verify()).toMatchObject({
      ok: false,
      break_at_seq: 4,
      reason: 'prev_hash_mismatch',
    });
  });

  it('TAMPER: deleting entry k is a sequence gap at k+1; deleting the tail shortens the chain visibly', () => {
    const { db, ledger } = seeded();
    db.prepare('DELETE FROM ledger_entries WHERE entry_seq = 2').run();
    expect(ledger.verify()).toMatchObject({ ok: false, break_at_seq: 3, reason: 'sequence_gap' });
    const { db: db2, ledger: l2 } = seeded();
    const headBefore = l2.head()!.entry_hash;
    db2.prepare('DELETE FROM ledger_entries WHERE entry_seq = 5').run();
    const v = l2.verify();
    expect(v.ok).toBe(true);
    expect(v.ok && v.head).not.toBe(headBefore); // a receipt/verdict citing the old head no longer matches
  });

  it('refuses non-JCS payloads (floats) instead of hashing something unreproducible', () => {
    const { ledger } = seeded();
    expect(() => ledger.append('LLM_MOVE', { latency_ms: 1.5 }, {})).toThrow();
    expect(ledger.count()).toBe(5);
  });

  it('a read-only copy can be verified: opening an existing ledger never writes', () => {
    const { db } = seeded();
    // Simulate the auditor: same file, opened read-only (in-memory stand-in:
    // a second Ledger over the same db after a readonly pragma would still
    // work because migrate is skipped when the table exists).
    db.pragma('query_only = ON');
    const auditor = new Ledger(db, NOW);
    expect(auditor.verify()).toMatchObject({ ok: true, length: 5 });
    expect(() => auditor.append('LLM_MOVE', {}, {})).toThrow(); // read-only stays read-only
  });

  it('every entry type is spelled once', () => {
    expect(new Set(ENTRY_TYPES).size).toBe(ENTRY_TYPES.length);
  });
});

/**
 * Gate 5 item 3 — no update/delete code path for ledger entries exists in
 * ANY workspace (CONSTRAINTS #7): packages, services, dashboard, evals.
 * Test files are excluded (the tamper tests above are the attacker).
 */
describe('no update/delete path for ledger_entries anywhere (source search)', () => {
  const root = join(import.meta.dirname, '..', '..', '..');
  const roots = ['packages', 'services', 'dashboard', 'evals'].map((d) => join(root, d));

  function* sources(dir: string): Generator<string> {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === 'node_modules' || name === 'dist') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) yield* sources(p);
      else if (/\.(ts|mjs|js)$/.test(name) && !/\.test\.ts$/.test(name)) yield p;
    }
  }

  it('greps every non-test source file', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const dir of roots) {
      for (const f of sources(dir)) {
        scanned += 1;
        if (
          /(UPDATE|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE)\s+ledger_entries/i.test(
            readFileSync(f, 'utf8'),
          )
        ) {
          offenders.push(f.slice(root.length));
        }
      }
    }
    expect(scanned).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
