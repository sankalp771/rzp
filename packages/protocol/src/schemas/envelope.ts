import { z } from 'zod';
import { BODY_SCHEMAS, type BodyOf, type MessageType } from './bodies.js';
import { AgentId, PROTOCOL_NAME, Rfc3339, Role, SignatureSchema, Uuid } from './common.js';

/**
 * Message envelope, PROTOCOL.md §4. `EnvelopeSchema` checks the frame only
 * (any `type` string, any `body` object) so that version and type problems
 * can be reported with their own error codes before the body is looked at;
 * `messageSchema(type)` then binds the right body schema.
 */
export const EnvelopeSchema = z.strictObject({
  protocol: z.literal(PROTOCOL_NAME),
  version: z.string().regex(/^\d+\.\d+$/),
  type: z.string().min(1),
  message_id: Uuid,
  session_id: Uuid,
  seq: z.number().int().positive(),
  in_reply_to: Uuid.optional(),
  sender: z.object({ agent_id: AgentId, role: Role }),
  timestamp: Rfc3339,
  body: z.record(z.string(), z.unknown()),
  signature: SignatureSchema,
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** Fully-typed message of a given type. */
export type Message<T extends MessageType = MessageType> = Omit<Envelope, 'type' | 'body'> & {
  type: T;
  body: BodyOf<T>;
};

export function messageSchema<T extends MessageType>(type: T) {
  return EnvelopeSchema.extend({ type: z.literal(type), body: BODY_SCHEMAS[type] });
}
