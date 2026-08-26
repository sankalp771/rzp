import { z } from 'zod';

/** Building blocks shared by envelope, bodies and mandates (PROTOCOL.md §3). */

export const PROTOCOL_NAME = 'ACNP' as const;
export const PROTOCOL_VERSION = '0.1' as const;
/** Major versions this implementation will talk to (§12). */
export const SUPPORTED_MAJOR_VERSIONS = ['0'] as const;

export const Hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'lowercase hex sha-256');
export const Base64Key = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'raw 32-byte key, base64');
export const Base64Sig = z.string().regex(/^[A-Za-z0-9+/]{86}==$/, 'raw 64-byte signature, base64');
export const Uuid = z.uuid({ version: 'v4' });
export const Rfc3339 = z.iso.datetime({ precision: 3, offset: false }); // "...sss Z"
/** Money is integer minor units (paise); floats are prohibited. */
export const MinorUnits = z.number().int().nonnegative().safe();
export const Currency = z.literal('INR'); // v0.1 fixes INR (§3)
export const Role = z.enum(['buyer', 'seller', 'firewall', 'settlement']);
export const AgentId = z.string().min(1).max(128);
/** Free text from a counterparty or an LLM: bounded, never trusted. */
export const UntrustedText = z.string().max(4000);

export const SignatureSchema = z.object({
  alg: z.literal('Ed25519'),
  key_id: Hex64,
  value: Base64Sig,
});

export const LineItem = z.object({
  item_id: z.string().min(1),
  variant_id: z.string().min(1),
  quantity: z.number().int().positive(),
  proposed_unit_price: MinorUnits,
});
export type LineItem = z.infer<typeof LineItem>;

export const Terms = z.object({
  delivery_days: z.number().int().nonnegative().optional(),
  notes: UntrustedText.optional(),
});

export const CatalogVariant = z.object({
  variant_id: z.string().min(1),
  attributes: z.record(z.string(), z.union([z.string().max(200), z.number().int(), z.boolean()])),
  list_price: MinorUnits,
  stock: z.number().int().nonnegative(),
});

/**
 * The seller's exact item snapshot (§7.4 minus `catalog_hash`). It is what
 * `catalog_hash` is computed over, and — since Day 8 — what a cart mandate
 * line item carries (§7.8) so the firewall can read the seller-declared
 * `category` and recompute the hash without ever seeing the catalog.
 */
export const CatalogSnapshot = z.object({
  item_id: z.string().min(1),
  title: UntrustedText,
  description: UntrustedText,
  category: z.string().min(1),
  variants: z.array(CatalogVariant).min(1),
});
export type CatalogSnapshot = z.infer<typeof CatalogSnapshot>;
