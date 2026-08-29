import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionRecord } from './types.js';

/**
 * `evals/runs/<run-id>/sessions.jsonl` — one line per finished session,
 * appended the moment it finishes. Resumability (BUILD_PLAN standing risk)
 * is nothing more than "skip the (scenario, index) pairs already on disk".
 */
export class RunStore {
  readonly path: string;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'sessions.jsonl');
  }

  load(): SessionRecord[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SessionRecord);
  }

  append(record: SessionRecord): void {
    appendFileSync(this.path, JSON.stringify(record) + '\n');
  }

  static key(r: Pick<SessionRecord, 'scenario' | 'index'>): string {
    return `${r.scenario}:${r.index}`;
  }
}
