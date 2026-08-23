import { z } from 'zod';
import { BODY_SCHEMAS, type MessageType } from './schemas/bodies.js';
import { EnvelopeSchema, messageSchema } from './schemas/envelope.js';
import { IntentMandate } from './schemas/mandate.js';

/**
 * JSON Schema (draft 2020-12) views of the zod schemas, PROTOCOL.md §3
 * ("validate against the JSON Schema for its type"). zod is the single
 * source; these are derived, committed under schemas/json/ for readers and
 * other-language implementers, and a test fails if they drift.
 */
export function exportJsonSchemas(): Record<string, unknown> {
  const out: Record<string, unknown> = {
    envelope: toJson(EnvelopeSchema, 'envelope'),
    intent_mandate: toJson(IntentMandate, 'intent_mandate'),
  };
  for (const type of Object.keys(BODY_SCHEMAS) as MessageType[]) {
    out[`message.${type}`] = toJson(messageSchema(type), `message/${type}`);
  }
  return out;
}

function toJson(schema: z.ZodType, name: string): unknown {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
  return { $id: `https://negotiator.dev/schemas/acnp/0.1/${name}.json`, ...json };
}
