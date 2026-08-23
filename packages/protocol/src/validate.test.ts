import { describe, expect, it } from 'vitest';
import { buildMessage, makePrincipal, sampleBodies } from './fixtures/index.js';
import { generateKeyPair } from './keys.js';
import { MESSAGE_TYPES, type MessageType } from './schemas/bodies.js';
import { verifyObject } from './sign.js';
import { parseMessage } from './validate.js';

const principal = makePrincipal();
const buyer = generateKeyPair();
const seller = generateKeyPair();
const bodies = sampleBodies(principal, buyer, seller);

// Round-trip through JSON so tests see exactly what the wire would carry.
const wire = (m: unknown) => JSON.parse(JSON.stringify(m));

describe('parseMessage — valid fixtures', () => {
  it.each(MESSAGE_TYPES)('accepts a well-formed %s', (type) => {
    const msg = buildMessage(type, 'buyer', bodies[type as MessageType] as never, buyer);
    const res = parseMessage(wire(msg));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (res.ok) expect(res.message.type).toBe(type);
  });

  it('a parsed message still verifies (parse is lossless)', () => {
    const msg = buildMessage('offer', 'buyer', bodies.offer, buyer);
    const res = parseMessage(wire(msg));
    expect(res.ok && verifyObject(res.message, buyer.publicKey)).toEqual({ ok: true });
  });

  it('covers every message type in PROTOCOL.md §7 (16 + error)', () => {
    expect(MESSAGE_TYPES).toHaveLength(17);
  });
});

describe('parseMessage — invalid fixtures (Gate 1)', () => {
  const good = () => wire(buildMessage('offer', 'buyer', bodies.offer, buyer));

  it('missing envelope field -> SCHEMA_INVALID', () => {
    const m = good();
    delete m.session_id;
    expect(parseMessage(m)).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });
  });

  it('missing body field -> SCHEMA_INVALID naming the path', () => {
    const m = good();
    delete m.body.total;
    const r = parseMessage(m);
    expect(r).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });
    expect(!r.ok && r.detail).toContain('total');
  });

  it('wrong type (float money) -> SCHEMA_INVALID', () => {
    const m = good();
    m.body.total = 4200.5;
    expect(parseMessage(m)).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });
  });

  it('unknown major version -> VERSION_UNSUPPORTED even when the rest is broken', () => {
    const m = good();
    m.version = '2.0';
    delete m.body;
    expect(parseMessage(m)).toMatchObject({ ok: false, code: 'VERSION_UNSUPPORTED' });
  });

  it('unknown minor version of a supported major is accepted (§12)', () => {
    const m = good();
    m.version = '0.7';
    expect(parseMessage(m).ok).toBe(true);
  });

  it('unknown message type -> SCHEMA_INVALID', () => {
    const m = good();
    m.type = 'bribe';
    expect(parseMessage(m)).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });
  });

  it('unknown envelope field -> SCHEMA_INVALID (envelope is strict)', () => {
    const m = good();
    m.extra = 1;
    expect(parseMessage(m)).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });
  });

  it('wrong protocol literal or non-object input -> SCHEMA_INVALID, never throws', () => {
    expect(parseMessage({ ...good(), protocol: 'AP2' })).toMatchObject({
      ok: false,
      code: 'SCHEMA_INVALID',
    });
    expect(parseMessage(null)).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });
    expect(parseMessage('string')).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });
  });

  it('error code outside §10 -> SCHEMA_INVALID', () => {
    const m = wire(buildMessage('error', 'seller', bodies.error, seller));
    m.body.code = 'MADE_UP';
    expect(parseMessage(m)).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });
  });

  it('firewall verdict with an unknown verdict value -> SCHEMA_INVALID', () => {
    const m = wire(buildMessage('firewall_verdict', 'firewall', bodies.firewall_verdict, seller));
    m.body.verdict = 'maybe';
    expect(parseMessage(m)).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });
  });
});
