import type { ErrorCode } from './errors.js';
import { BODY_SCHEMAS, type MessageType } from './schemas/bodies.js';
import { PROTOCOL_NAME, SUPPORTED_MAJOR_VERSIONS } from './schemas/common.js';
import { EnvelopeSchema, type Message } from './schemas/envelope.js';

/**
 * First thing every receiving boundary does with bytes off the wire
 * (PROTOCOL.md §3, §12). Order matters and is normative:
 *   1. shape of the envelope       → SCHEMA_INVALID
 *   2. major version supported     → VERSION_UNSUPPORTED (fatal)
 *   3. known message type          → SCHEMA_INVALID
 *   4. body matches type's schema  → SCHEMA_INVALID
 * Signature, replay and state checks happen AFTER this, in the service, and
 * only on a message that parsed — so nothing unparseable ever reaches them.
 */
export type ParseResult =
  | { ok: true; message: Message }
  | {
      ok: false;
      code: Extract<ErrorCode, 'SCHEMA_INVALID' | 'VERSION_UNSUPPORTED'>;
      detail: string;
    };

export function parseMessage(raw: unknown): ParseResult {
  const env = EnvelopeSchema.safeParse(raw);
  if (!env.success) {
    // Report version problems as such even when other fields are also bad —
    // a peer on the wrong major version should learn that first.
    const v = (raw as { version?: unknown } | null)?.version;
    if (typeof v === 'string' && !majorSupported(v)) {
      return { ok: false, code: 'VERSION_UNSUPPORTED', detail: `version ${v}` };
    }
    return { ok: false, code: 'SCHEMA_INVALID', detail: issues(env.error) };
  }
  if (!majorSupported(env.data.version)) {
    return { ok: false, code: 'VERSION_UNSUPPORTED', detail: `version ${env.data.version}` };
  }
  if (!isMessageType(env.data.type)) {
    return { ok: false, code: 'SCHEMA_INVALID', detail: `unknown type ${env.data.type}` };
  }
  const body = BODY_SCHEMAS[env.data.type].safeParse(env.data.body);
  if (!body.success) {
    return { ok: false, code: 'SCHEMA_INVALID', detail: `body: ${issues(body.error)}` };
  }
  return { ok: true, message: { ...env.data, type: env.data.type, body: body.data } as Message };
}

export function isMessageType(t: string): t is MessageType {
  return Object.prototype.hasOwnProperty.call(BODY_SCHEMAS, t);
}

function majorSupported(version: string): boolean {
  const major = version.split('.')[0] ?? '';
  return (SUPPORTED_MAJOR_VERSIONS as readonly string[]).includes(major);
}

// Compact, secret-free summary suitable for an `error.detail` field.
function issues(err: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join('.') || '$'}: ${i.message}`)
    .join('; ');
}

export { PROTOCOL_NAME };
