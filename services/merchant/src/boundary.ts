import {
  parseMessage,
  verifyObject,
  ReplayGuard,
  type ErrorCode,
  type Message,
  type ReplayStore,
} from '@negotiator/protocol';

/**
 * The normative receive pipeline (PROTOCOL.md §3–§6, FLOW F5):
 *   parse/schema → clock skew → key resolution → signature → replay check.
 * Deliberately service-agnostic — no merchant imports — because the buyer
 * (Day 5) and firewall (Day 8) run the identical boundary; it moves to a
 * shared package the moment a second service needs it.
 *
 * The replay seq is NOT consumed here: the caller runs its state-machine
 * check on the returned message and calls `commit()` only when the message
 * is fully accepted, so rejected messages never burn sequence numbers.
 */

export interface BoundaryConfig {
  /**
   * Resolve the public key a message must verify against, or null if the
   * sender is unknown. For TOFU messages (session_init/session_ack) return
   * the key embedded in the body — the pipeline verifies self-signature.
   */
  resolveKey(msg: Message): string | null;
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
    const sig = verifyObject(msg, key);
    if (!sig.ok) {
      return { ok: false, code: 'SIG_INVALID', detail: sig.reason };
    }

    const replay = guard.check(msg);
    if (!replay.ok) return { ok: false, code: replay.code, detail: replay.detail };

    return { ok: true, message: msg, commit: () => guard.commit(msg) };
  };
}
