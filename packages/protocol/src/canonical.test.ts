import { describe, expect, it } from 'vitest';
import { CanonicalizationError, canonicalize } from './canonical.js';

describe('canonicalize (RFC 8785)', () => {
  it('sorts keys recursively and emits no whitespace', () => {
    expect(canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('matches the RFC 8785 §3.2.3 key-ordering test vector', () => {
    // The RFC example, minus its float members (prohibited in ACNP) — the
    // ordering assertion is the point: by UTF-16 code unit, so "\r" < "1" <
    // "10" < "2" < "A" < "a" < "\u20ac" < "\ud800\udf00" (surrogate pair
    // sorts by its first unit, below U+FB33 etc).
    const input = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    };
    expect(canonicalize(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it('is idempotent and key-order independent', () => {
    const a = canonicalize({ x: 1, y: [true, null, 'z'] });
    const b = canonicalize({ y: [true, null, 'z'], x: 1 });
    expect(a).toBe(b);
    expect(canonicalize(JSON.parse(a))).toBe(a);
  });

  it('drops undefined members like JSON.stringify', () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('rejects floats, NaN and unsafe integers (money is minor units)', () => {
    for (const bad of [1.5, NaN, Infinity, 2 ** 53]) {
      expect(() => canonicalize({ amount: bad })).toThrow(CanonicalizationError);
    }
  });

  it('rejects non-plain objects and functions', () => {
    expect(() => canonicalize({ d: new Date(0) })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ f: () => 1 })).toThrow(CanonicalizationError);
  });
});

describe('canonicalize — BUG-002 regression', () => {
  it('orders integer-like keys by code unit, not by engine array-index rule', () => {
    // JS would iterate "10" and "2" before "a" and before "\r"; JCS must not.
    expect(canonicalize({ a: 1, '10': 2, '2': 3, '\r': 4 })).toBe('{"\\r":4,"10":2,"2":3,"a":1}');
  });
});
