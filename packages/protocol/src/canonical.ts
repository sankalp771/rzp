/**
 * JSON Canonicalization Scheme (RFC 8785) for the ACNP value subset.
 *
 * PROTOCOL.md §3 requires every signature and hash to be computed over the
 * JCS form, so two implementations that disagree on whitespace or key order
 * still agree on bytes. For the values ACNP allows — strings, integers,
 * booleans, null, arrays, objects — JCS is exactly `JSON.stringify` with
 * object keys sorted by UTF-16 code units at every level (D012). Floats are
 * prohibited by the spec (money is in minor units) and rejected here so a
 * float can never sneak into a signed payload with ambiguous formatting.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export class CanonicalizationError extends Error {
  override readonly name = 'CanonicalizationError';
}

/** Serialize `value` to its RFC 8785 canonical form. */
export function canonicalize(value: unknown): string {
  return emit(value, '');
}

/** Canonical form as bytes — what gets signed and hashed. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), 'utf8');
}

// Hand-written emitter rather than "sort keys, then JSON.stringify": JS
// engines iterate integer-like keys ("1", "42") before all other keys no
// matter the insertion order, which silently breaks RFC 8785 ordering
// (BUG-002). Emitting the text ourselves removes that dependency entirely.
// `path` only serves error messages.
function emit(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value); // RFC 8785 §3.2.2.2 == ES JSON string escaping
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalizationError(`non-integer number at ${path || '$'}: ${value}`);
      }
      return value === 0 ? '0' : String(value); // normalise -0
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => emit(v, `${path}[${i}]`)).join(',')}]`;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) {
        throw new CanonicalizationError(`non-plain object at ${path || '$'}`);
      }
      const obj = value as Record<string, unknown>;
      const members = Object.keys(obj)
        .filter((k) => obj[k] !== undefined) // JSON.stringify drops undefined; JCS has no such value
        .sort(compareUtf16)
        .map((k) => `${JSON.stringify(k)}:${emit(obj[k], path ? `${path}.${k}` : k)}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new CanonicalizationError(`unsupported ${typeof value} at ${path || '$'}`);
  }
}

// RFC 8785 §3.2.3: sort by UTF-16 code units, which is JS default string
// comparison — spelled out so nobody "fixes" it to localeCompare.
function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
