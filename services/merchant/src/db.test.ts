import { describe, expect, it } from 'vitest';
import { ReplayGuard } from '@negotiator/protocol';
import { openDb, SqliteReplayStore } from './db.js';
import { loadPolicy } from './policy.js';
import { seedIfEmpty } from './seed.js';

describe('merchant db', () => {
  it('migrates, seeds once, and loads a valid policy', () => {
    const db = openDb(':memory:');
    expect(seedIfEmpty(db)).toBe(true);
    expect(seedIfEmpty(db)).toBe(false); // idempotent
    const items = db.prepare('SELECT COUNT(*) AS n FROM catalog_items').get() as { n: number };
    expect(items.n).toBe(9);
    const policy = loadPolicy(db);
    expect(policy.max_rounds).toBeGreaterThan(0);
    // Demo invariants the seed must keep (FEATURE-004 amendment #3):
    const industrial = db
      .prepare("SELECT COUNT(*) AS n FROM catalog_items WHERE category = 'industrial'")
      .get() as { n: number };
    expect(industrial.n).toBeGreaterThanOrEqual(1);
    const nearFloor = db
      .prepare('SELECT COUNT(*) AS n FROM variants WHERE floor_price >= list_price * 0.95')
      .get() as { n: number };
    expect(nearFloor.n).toBeGreaterThanOrEqual(1);
  });

  it('SqliteReplayStore backs ReplayGuard across "restarts"', () => {
    const db = openDb(':memory:');
    const msg = {
      session_id: 'e8dc57ff-14a1-4f6b-9f57-6ac0602400c5',
      message_id: '0d4f34ce-2c85-49bd-8e5e-93e8bfe0a5b8',
      seq: 1,
      sender: { agent_id: 'buyer-1' },
    };
    expect(new ReplayGuard(new SqliteReplayStore(db)).accept(msg)).toEqual({ ok: true });
    // Fresh guard over the same db — same message must still be a replay.
    expect(new ReplayGuard(new SqliteReplayStore(db)).accept(msg)).toMatchObject({
      ok: false,
      code: 'REPLAY_DETECTED',
    });
  });
});
