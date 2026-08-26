import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from './db.js';
import { GENESIS_HASH, appendEvent, listEvents, verifyChain } from './events.js';

const NOW = () => new Date('2026-08-25T12:00:00.000Z');
const H = 'a'.repeat(64);

describe('settlement_events — append-only hash chain (Gate 5 in miniature)', () => {
  it('chains entries from genesis and verifies end to end', () => {
    const db = openDb(':memory:');
    const e1 = appendEvent(db, H, 'REQUEST_ACCEPTED', { x: 1 }, NOW);
    const e2 = appendEvent(db, H, 'SETTLEMENT_ATTEMPT', { attempt: 1 }, NOW);
    const e3 = appendEvent(db, H, 'ORDER_CREATED', { order_id: 'order_1' }, NOW);
    expect(e1.prev_hash).toBe(GENESIS_HASH);
    expect(e2.prev_hash).toBe(e1.entry_hash);
    expect(e3.prev_hash).toBe(e2.entry_hash);
    expect(verifyChain(db, H)).toEqual({ ok: true, length: 3 });
    expect(listEvents(db, H).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('tamper test: mutating one stored entry out-of-band breaks verification at exactly that entry', () => {
    const db = openDb(':memory:');
    appendEvent(db, H, 'REQUEST_ACCEPTED', {}, NOW);
    appendEvent(db, H, 'SETTLEMENT_ATTEMPT', { attempt: 1 }, NOW);
    appendEvent(db, H, 'ORDER_CREATED', { order_id: 'order_1' }, NOW);
    // Out-of-band: raw SQL, the only way to touch a row — no code path does this.
    db.prepare('UPDATE settlement_events SET payload = ? WHERE mandate_hash = ? AND seq = 2').run(
      JSON.stringify({ attempt: 99 }),
      H,
    );
    expect(verifyChain(db, H)).toEqual({ ok: false, break_at_seq: 2 });
  });

  it('chains are independent per mandate', () => {
    const db = openDb(':memory:');
    appendEvent(db, H, 'REQUEST_ACCEPTED', {}, NOW);
    const other = 'b'.repeat(64);
    const e = appendEvent(db, other, 'REQUEST_ACCEPTED', {}, NOW);
    expect(e.prev_hash).toBe(GENESIS_HASH);
    expect(verifyChain(db, other)).toEqual({ ok: true, length: 1 });
  });

  it('NO update/delete code path exists for settlement_events (source search, CONSTRAINTS #7)', () => {
    const dir = import.meta.dirname;
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const src = readFileSync(join(dir, f), 'utf8');
      if (/(UPDATE|DELETE\s+FROM)\s+settlement_events/i.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
