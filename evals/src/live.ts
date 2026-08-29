import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAdapterFromEnv } from '@negotiator/llm';
import type { Adapters } from './session.js';

/**
 * Live mode (FEATURE-011 design #1): the same three adapters the Compose
 * services boot with, built from `.env` through the one factory the
 * adapter layer exposes (CONSTRAINTS #8 — no provider call outside
 * `@negotiator/llm`). A named provider without its key refuses here
 * exactly as a service would (D015: no silent downgrade to the stub).
 */

export type Env = Record<string, string | undefined>;

/** `.env` (Compose syntax: `$$` is a literal dollar) with the process environment winning. */
export function loadEnv(root: string): Env {
  const p = resolve(root, '.env');
  const out: Env = {};
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]!] = m[2]!.replaceAll('$$', '$');
    }
  }
  return { ...out, ...process.env };
}

export function liveAdapters(env: Env): Adapters {
  const buyer = createAdapterFromEnv('BUYER', { env });
  const seller = createAdapterFromEnv('SELLER', { env });
  const firewallProvider = (env['FIREWALL_LLM_PROVIDER'] ?? 'stub').toLowerCase();
  // Mirrors services/firewall verifierFromEnv: the verifier's own, smaller
  // budget (it runs inside the buyer's HTTP window in production).
  const budgetMs = env['FIREWALL_LLM_BUDGET_MS'] ?? '8000';
  const firewall =
    firewallProvider === 'stub'
      ? undefined
      : createAdapterFromEnv('FIREWALL', {
          env: {
            ...env,
            LLM_TOTAL_BUDGET_MS: budgetMs,
            LLM_CALL_TIMEOUT_MS: env['FIREWALL_LLM_CALL_TIMEOUT_MS'] ?? budgetMs,
          },
        });
  return {
    ...(buyer.provider === 'stub' ? {} : { buyer }),
    ...(seller.provider === 'stub' ? {} : { seller }),
    ...(firewall ? { firewall } : {}),
  };
}

/** Live pacing: sleep between sessions; back off harder after each consecutive rate-limited session. */
export function backoffMs(consecutiveRateLimited: number, baseMs = 30_000): number {
  return baseMs * 2 ** Math.max(0, consecutiveRateLimited - 1);
}

/** Stop cleanly after this many consecutive rate-limited sessions (report what ran). */
export const MAX_CONSECUTIVE_RATE_LIMITED = 3;
