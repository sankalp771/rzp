import { describe, expect, it } from 'vitest';
import { MemoryReplayStore, type Message } from '@negotiator/protocol';
import { buildMessage, makePrincipal, sampleBodies } from '@negotiator/protocol/fixtures';
import { generateKeyPair } from '@negotiator/protocol';
import { makeBoundary } from './boundary.js';

const principal = makePrincipal();
const buyer = generateKeyPair();
const seller = generateKeyPair();
const bodies = sampleBodies(principal, buyer, seller);
const NOW = () => new Date('2026-08-23T10:00:00.500Z'); // 500ms after FIXED_TIME

function boundary(overrides: Partial<Parameters<typeof makeBoundary>[0]> = {}) {
  return makeBoundary({
    resolveKey: () => buyer.publicKey,
    replayStore: new MemoryReplayStore(),
    now: NOW,
    ...overrides,
  });
}

const wire = (m: unknown) => JSON.parse(JSON.stringify(m));

describe('ACNP boundary (F5)', () => {
  it('accepts a valid signed message and commits only when asked', () => {
    const receive = boundary();
    const msg = wire(buildMessage('offer', 'buyer', bodies.offer, buyer));
    const first = receive(msg);
    expect(first.ok).toBe(true);
    // Not committed yet → same message passes again.
    expect(receive(msg).ok).toBe(true);
    if (first.ok) first.commit();
    expect(receive(msg)).toMatchObject({ ok: false, code: 'REPLAY_DETECTED' });
  });

  it('schema-invalid input → SCHEMA_INVALID', () => {
    expect(boundary()({ nonsense: true })).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });
  });

  it('tampered payload → SIG_INVALID', () => {
    const msg = wire(buildMessage('offer', 'buyer', bodies.offer, buyer)) as Message<'offer'>;
    msg.body.total = 1;
    (msg.body.line_items[0] as { proposed_unit_price: number }).proposed_unit_price = 1;
    expect(boundary()(msg)).toMatchObject({ ok: false, code: 'SIG_INVALID' });
  });

  it('message signed by a different key than resolved → SIG_INVALID', () => {
    const intruder = generateKeyPair();
    const msg = wire(buildMessage('offer', 'buyer', bodies.offer, intruder));
    expect(boundary()(msg)).toMatchObject({ ok: false, code: 'SIG_INVALID' });
  });

  it('unknown session (resolveKey null) → SESSION_UNKNOWN', () => {
    const receive = boundary({ resolveKey: () => null });
    const msg = wire(buildMessage('offer', 'buyer', bodies.offer, buyer));
    expect(receive(msg)).toMatchObject({ ok: false, code: 'SESSION_UNKNOWN' });
  });

  it('sequence gap → SEQUENCE_GAP; stale timestamp → CLOCK_SKEW', () => {
    const receive = boundary();
    const gap = wire(buildMessage('offer', 'buyer', bodies.offer, buyer, { seq: 3 }));
    expect(receive(gap)).toMatchObject({ ok: false, code: 'SEQUENCE_GAP' });
    const stale = wire(
      buildMessage('offer', 'buyer', bodies.offer, buyer, {
        timestamp: '2026-08-23T09:00:00.000Z', // 1h before NOW
      }),
    );
    expect(receive(stale)).toMatchObject({ ok: false, code: 'CLOCK_SKEW' });
  });

  it('clock-skew window is configurable (amendment #4)', () => {
    const receive = boundary({ clockSkewSec: 7200 });
    const stale = wire(
      buildMessage('offer', 'buyer', bodies.offer, buyer, {
        timestamp: '2026-08-23T09:00:00.000Z',
      }),
    );
    expect(receive(stale).ok).toBe(true);
  });
});
