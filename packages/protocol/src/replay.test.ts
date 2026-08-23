import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ReplayGuard } from './replay.js';

const session = randomUUID();
const msg = (seq: number, agent = 'buyer-1', message_id = randomUUID()) => ({
  session_id: session,
  message_id,
  seq,
  sender: { agent_id: agent },
});

describe('ReplayGuard (PROTOCOL.md §6)', () => {
  it('accepts a strictly increasing sequence', () => {
    const g = new ReplayGuard();
    expect(g.accept(msg(1))).toEqual({ ok: true });
    expect(g.accept(msg(2))).toEqual({ ok: true });
    expect(g.accept(msg(3))).toEqual({ ok: true });
  });

  it('rejects a replayed message (same seq, same id) as REPLAY_DETECTED', () => {
    const g = new ReplayGuard();
    const m = msg(1);
    expect(g.accept(m)).toEqual({ ok: true });
    expect(g.accept(m)).toMatchObject({ ok: false, code: 'REPLAY_DETECTED' });
  });

  it('rejects an old seq even with a fresh message_id', () => {
    const g = new ReplayGuard();
    g.accept(msg(1));
    g.accept(msg(2));
    expect(g.accept(msg(1))).toMatchObject({ ok: false, code: 'REPLAY_DETECTED' });
  });

  it('rejects a reused message_id even with a fresh seq (second barrier)', () => {
    const g = new ReplayGuard();
    const id = randomUUID();
    g.accept(msg(1, 'buyer-1', id));
    expect(g.accept(msg(2, 'buyer-1', id))).toMatchObject({ ok: false, code: 'REPLAY_DETECTED' });
    // ...and across senders within the session too.
    expect(g.accept(msg(1, 'seller-1', id))).toMatchObject({ ok: false, code: 'REPLAY_DETECTED' });
  });

  it('rejects a gap as SEQUENCE_GAP and does not advance', () => {
    const g = new ReplayGuard();
    g.accept(msg(1));
    expect(g.accept(msg(3))).toMatchObject({ ok: false, code: 'SEQUENCE_GAP' });
    expect(g.accept(msg(2))).toEqual({ ok: true });
  });

  it('first message must be seq 1', () => {
    const g = new ReplayGuard();
    expect(g.accept(msg(2))).toMatchObject({ ok: false, code: 'SEQUENCE_GAP' });
    expect(g.accept(msg(0))).toMatchObject({ ok: false, code: 'REPLAY_DETECTED' });
  });

  it('tracks seq per sender independently within a session', () => {
    const g = new ReplayGuard();
    expect(g.accept(msg(1, 'buyer-1'))).toEqual({ ok: true });
    expect(g.accept(msg(1, 'seller-1'))).toEqual({ ok: true });
    expect(g.accept(msg(2, 'seller-1'))).toEqual({ ok: true });
    expect(g.accept(msg(2, 'buyer-1'))).toEqual({ ok: true });
  });

  it('tracks sessions independently', () => {
    const g = new ReplayGuard();
    const other = { ...msg(1), session_id: randomUUID() };
    g.accept(msg(1));
    expect(g.accept(other)).toEqual({ ok: true });
  });

  it('check() does not consume the seq; only commit() does', () => {
    const g = new ReplayGuard();
    const m = msg(1);
    expect(g.check(m)).toEqual({ ok: true });
    expect(g.check(m)).toEqual({ ok: true }); // still fine: nothing committed
    g.commit(m);
    expect(g.check(m)).toMatchObject({ ok: false, code: 'REPLAY_DETECTED' });
  });
});
