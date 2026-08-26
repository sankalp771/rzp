import { z } from 'zod';
import { ERROR_CODES } from '../errors.js';
import {
  AgentId,
  Base64Key,
  Currency,
  Hex64,
  LineItem,
  MinorUnits,
  Rfc3339,
  SignatureSchema,
  Terms,
  UntrustedText,
} from './common.js';
import { CartMandateBody, IntentMandate } from './mandate.js';

/** One zod schema per message body, PROTOCOL.md §7. Keys = `type` values. */

const Capabilities = z.object({
  bundling: z.boolean(),
  quantity_discounts: z.boolean(),
  delivery_sla_negotiation: z.boolean(),
  max_rounds: z.number().int().positive().max(50),
  currency: Currency,
});

const CatalogVariant = z.object({
  variant_id: z.string().min(1),
  attributes: z.record(z.string(), z.union([z.string().max(200), z.number().int(), z.boolean()])),
  list_price: MinorUnits,
  stock: z.number().int().nonnegative(),
});

const CatalogItem = z.object({
  item_id: z.string().min(1),
  title: UntrustedText,
  description: UntrustedText,
  category: z.string().min(1),
  variants: z.array(CatalogVariant).min(1),
  catalog_hash: Hex64,
});
export type CatalogItem = z.infer<typeof CatalogItem>;

const OfferBody = z.object({
  line_items: z.array(LineItem).min(1),
  total: MinorUnits,
  terms: Terms.optional(),
  round: z.number().int().positive(),
  rationale: UntrustedText.optional(),
});
export type OfferBody = z.infer<typeof OfferBody>;

const FirewallVerdictBody = z.object({
  cart_mandate_hash: Hex64,
  verdict: z.enum(['allow', 'block', 'escalate']),
  layer: z.enum(['policy', 'intent_verifier', 'human']),
  reasons: z.array(z.string().regex(/^[A-Z_]+$/)),
  verifier_summary: UntrustedText.optional(),
});
export type FirewallVerdictBody = z.infer<typeof FirewallVerdictBody>;

export const BODY_SCHEMAS = {
  mandate_register: z.object({
    intent_mandate: IntentMandate,
    buyer_public_key: Base64Key,
  }),
  mandate_ack: z.object({ intent_mandate_ref: Hex64 }),
  session_init: z.object({
    buyer_public_key: Base64Key,
    supported_versions: z.array(z.string().regex(/^\d+\.\d+$/)).min(1),
    intent_mandate_ref: Hex64,
  }),
  session_ack: z.object({
    seller_public_key: Base64Key,
    chosen_version: z.string().regex(/^\d+\.\d+$/),
    capabilities: Capabilities,
  }),
  catalog_request: z.object({
    query: UntrustedText.optional(),
    category: z.string().min(1).optional(),
    max_items: z.number().int().positive().max(100).optional(),
  }),
  catalog_offer: z.object({ items: z.array(CatalogItem) }),
  offer: OfferBody,
  counter_offer: OfferBody,
  bundle_proposal: z.object({
    bundles: z
      .array(
        z.object({
          bundle_id: z.string().min(1),
          line_items: z.array(LineItem).min(1),
          bundle_price: MinorUnits,
          expires_at: Rfc3339,
        }),
      )
      .min(1),
  }),
  accept: z.object({
    accepted_message_id: z.string().min(1),
    line_items: z.array(LineItem).min(1),
    total: MinorUnits,
  }),
  reject: z.object({
    rejected_message_id: z.string().min(1),
    rationale: UntrustedText.optional(),
  }),
  walk_away: z.object({
    reason_code: z.enum([
      'budget_exhausted',
      'rounds_exhausted',
      'no_acceptable_terms',
      'deadline',
      'policy',
    ]),
  }),
  cart_mandate: CartMandateBody,
  firewall_verdict: FirewallVerdictBody,
  settlement_request: z.object({
    /** The buyer's full signed cart_mandate envelope (§7.10). */
    cart_mandate: z.looseObject({ signature: SignatureSchema }),
    /** The firewall's full signed firewall_verdict envelope. */
    firewall_verdict: z.looseObject({ signature: SignatureSchema }),
    /**
     * The buyer session key the firewall pinned at mandate_register, so
     * settlement can verify the cart's signature itself (§7.10 d). The
     * cart's signature.key_id must equal sha256(this key).
     */
    buyer_public_key: Base64Key,
  }),
  settlement_receipt: z.object({
    mandate_hash: Hex64,
    razorpay_order_id: z.string().min(1),
    status: z.enum(['paid', 'failed', 'refunded']),
    amount: MinorUnits,
    currency: Currency,
    timestamp_paid: Rfc3339.optional(),
    ledger_entry_hash: Hex64,
  }),
  error: z.object({
    code: z.enum(ERROR_CODES),
    detail: z.string().max(1000),
    offending_message_id: z.string().optional(),
  }),
} as const;

export type MessageType = keyof typeof BODY_SCHEMAS;
export const MESSAGE_TYPES = Object.keys(BODY_SCHEMAS) as MessageType[];
export type BodyOf<T extends MessageType> = z.infer<(typeof BODY_SCHEMAS)[T]>;

// Re-exported so services can type agent ids consistently.
export { AgentId };
