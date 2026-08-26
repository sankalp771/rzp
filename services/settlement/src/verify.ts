import {
  hashCanonical,
  messageSchema,
  verifyObject,
  type ErrorCode,
  type Message,
} from '@negotiator/protocol';

/**
 * PROTOCOL.md §7.10 — what settlement MUST check itself, independently of
 * the transport boundary (which already verified the firewall's envelope
 * signature (a) and replay state):
 *   (b) the embedded firewall_verdict's own signature (firewall key);
 *   (c) verdict == allow AND verdict.cart_mandate_hash == the mandate hash
 *       RECOMPUTED here from the cart body (VERDICT_MISMATCH otherwise);
 *   (d) the cart mandate's buyer signature, against `buyer_public_key`
 *       attested by the firewall in the request body (§7.10). The cart's
 *       signature.key_id must equal sha256(that key) — verifyObject checks
 *       it — so a forwarded key cannot be swapped without breaking the
 *       cart's own signature. Defense in depth: even a compromised firewall
 *       host cannot make settlement accept a mandate the buyer never signed.
 */

export type VerifiedRequest =
  | {
      ok: true;
      cart: Message<'cart_mandate'>;
      verdict: Message<'firewall_verdict'>;
      mandateHash: string;
    }
  | { ok: false; code: ErrorCode; detail: string };

export function verifySettlementRequest(
  msg: Message<'settlement_request'>,
  firewallPublicKey: string,
): VerifiedRequest {
  const body = msg.body;

  // Re-validate the embedded envelopes as full messages of their types.
  const verdictParsed = messageSchema('firewall_verdict').safeParse(body.firewall_verdict);
  if (!verdictParsed.success) {
    return { ok: false, code: 'SCHEMA_INVALID', detail: 'embedded firewall_verdict is malformed' };
  }
  const cartParsed = messageSchema('cart_mandate').safeParse(body.cart_mandate);
  if (!cartParsed.success) {
    return { ok: false, code: 'SCHEMA_INVALID', detail: 'embedded cart_mandate is malformed' };
  }
  const verdict = verdictParsed.data as unknown as Message<'firewall_verdict'>;
  const cart = cartParsed.data as unknown as Message<'cart_mandate'>;

  // (b) verdict signed by the firewall key.
  const vSig = verifyObject(verdict, firewallPublicKey);
  if (!vSig.ok) return { ok: false, code: 'SIG_INVALID', detail: `verdict: ${vSig.reason}` };

  // (c) allow + hash agreement, recomputed here — never trusted from the body.
  const { mandate_hash, ...cartBodyMinusHash } = cart.body;
  const recomputed = hashCanonical(cartBodyMinusHash);
  if (recomputed !== mandate_hash) {
    return {
      ok: false,
      code: 'VERDICT_MISMATCH',
      detail: 'cart mandate_hash does not match its body',
    };
  }
  if (verdict.body.verdict !== 'allow') {
    return { ok: false, code: 'VERDICT_MISMATCH', detail: `verdict is ${verdict.body.verdict}` };
  }
  if (verdict.body.cart_mandate_hash !== recomputed) {
    return { ok: false, code: 'VERDICT_MISMATCH', detail: 'verdict is for a different cart' };
  }

  // (d) buyer signature on the cart, against the attested buyer key.
  const cSig = verifyObject(cart, body.buyer_public_key);
  if (!cSig.ok) return { ok: false, code: 'SIG_INVALID', detail: `cart: ${cSig.reason}` };

  // Arithmetic sanity (§7.5 spirit): the total must equal the line items.
  const sum = cart.body.line_items.reduce((s, li) => s + li.quantity * li.unit_price, 0);
  if (sum !== cart.body.total) {
    return {
      ok: false,
      code: 'TOTAL_MISMATCH',
      detail: `computed ${sum}, claimed ${cart.body.total}`,
    };
  }
  return { ok: true, cart, verdict, mandateHash: recomputed };
}
