import { parseMessage } from './validate.js';
import { verifyObject } from './sign.js';
import { ReplayGuard, type ReplayStore } from './replay.js';
import type { ErrorCode } from './errors.js';
import type { Message } from './schemas/envelope.js';

/**
 * The normative receive pipeline (PROTOCOL.md §3–§6, FLOW F5):
 *   parse/schema → clock skew → key resolution → signature → replay check.
 * Shared by every service (merchant Day 4, buyer Day 5, firewall Day 8) —
 * moved here from services/merchant once a second service needed it. Pure
 * logic: no I/O, no persistence beyond the injected ReplayStore.
 *
 * The replay seq is NOT consumed here: the caller runs its state-machine
 * check on the returned message and calls `commit()` only when the message
 * is fully accepted, so rejected messages never burn sequence numbers.
 */

/** A resolver may name the rejection instead of the generic SESSION_UNKNOWN. */
export interface KeyRejection {
  code: ErrorCode;
  detail: string;
}

export interface BoundaryConfig {
  /**
   * Resolve the public key a message must verify against, or null if the
   * sender is unknown. For TOFU messages (session_init/session_ack) return
   * the key embedded in the body — the pipeline verifies self-signature.
   * Returning a `KeyRejection` rejects with that code in the same pipeline
   * position as null (before signature verification) — e.g. the firewall
   * answers a cart for an unregistered mandate with MANDATE_UNKNOWN (§7.8)
   * rather than SESSION_UNKNOWN. Either way nothing has been authenticated,
   * so the reply is advisory and no seq is consumed.
   */
  resolveKey(msg: Message): string | null | KeyRejection;
  replayStore: ReplayStore;
  /** Max |now - msg.timestamp| in seconds. Spec default 120 (§4). */
  clockSkewSec?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export type BoundaryResult =
  | { ok: true; message: Message; commit: () => void }
  | { ok: false; code: ErrorCode; detail: string };

export function makeBoundary(cfg: BoundaryConfig) {
  const guard = new ReplayGuard(cfg.replayStore);
  const skewMs = (cfg.clockSkewSec ?? 120) * 1000;
  const now = cfg.now ?? (() => new Date());

  return function receive(raw: unknown): BoundaryResult {
    const parsed = parseMessage(raw);
    if (!parsed.ok) return { ok: false, code: parsed.code, detail: parsed.detail };
    const msg = parsed.message;

    const drift = Math.abs(now().getTime() - Date.parse(msg.timestamp));
    if (drift > skewMs) {
      return {
        ok: false,
        code: 'CLOCK_SKEW',
        detail: `timestamp ${msg.timestamp} outside ±${skewMs / 1000}s`,
      };
    }

    const key = cfg.resolveKey(msg);
    if (key === null) {
      return { ok: false, code: 'SESSION_UNKNOWN', detail: `no key for session ${msg.session_id}` };
    }
    if (typeof key !== 'string') return { ok: false, code: key.code, detail: key.detail };
    const sig = verifyObject(msg, key);
    if (!sig.ok) {
      return { ok: false, code: 'SIG_INVALID', detail: sig.reason };
    }

    const replay = guard.check(msg);
    if (!replay.ok) return { ok: false, code: replay.code, detail: replay.detail };

    return { ok: true, message: msg, commit: () => guard.commit(msg) };
  };
}
