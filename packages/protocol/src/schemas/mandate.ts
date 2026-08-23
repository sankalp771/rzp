import { z } from 'zod';
import {
  AgentId,
  Base64Key,
  Hex64,
  MinorUnits,
  Rfc3339,
  SignatureSchema,
  UntrustedText,
} from './common.js';

/**
 * Intent Mandate (PROTOCOL.md §8): authored and signed by the PRINCIPAL,
 * never by an agent. `signature` covers the JCS form of everything else.
 */
export const IntentMandate = z.object({
  goal: UntrustedText.min(1),
  budget_ceiling: MinorUnits,
  constraints: z.object({
    max_quantity: z.number().int().positive(),
    categories_allowed: z.array(z.string().min(1)).min(1),
    deadline: Rfc3339,
    delivery_max_days: z.number().int().nonnegative(),
  }),
  /** Soft preferences: LLM reasoning input only, never enforced. */
  preferences: z.array(UntrustedText).default([]),
  max_rounds: z.number().int().positive().max(50),
  valid_until: Rfc3339,
  principal_id: z.string().min(1),
  principal_public_key: Base64Key,
  issued_at: Rfc3339,
  signature: SignatureSchema,
});
export type IntentMandate = z.infer<typeof IntentMandate>;

/** Cart Mandate body (§7.8). Signed by the buyer via the envelope. */
export const CartMandateBody = z.object({
  intent_mandate_ref: Hex64,
  accepted_message_id: z.string().min(1),
  line_items: z
    .array(
      z.object({
        item_id: z.string().min(1),
        variant_id: z.string().min(1),
        quantity: z.number().int().positive(),
        unit_price: MinorUnits,
        catalog_hash: Hex64,
      }),
    )
    .min(1),
  total: MinorUnits,
  currency: z.literal('INR'),
  seller_agent_id: AgentId,
  buyer_agent_id: AgentId,
  /** Hash of this body minus `mandate_hash`; also the settlement idempotency key. */
  mandate_hash: Hex64,
});
export type CartMandateBody = z.infer<typeof CartMandateBody>;
