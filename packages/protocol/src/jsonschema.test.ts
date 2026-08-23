import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportJsonSchemas } from './jsonschema.js';

const DIR = join(import.meta.dirname, '..', 'schemas', 'json');

describe('committed JSON Schemas', () => {
  const generated = exportJsonSchemas();

  it('exist for the envelope, the Intent Mandate and every message type', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
    expect(files.sort()).toEqual(
      Object.keys(generated)
        .map((n) => `${n}.json`)
        .sort(),
    );
  });

  it.each(Object.keys(generated))(
    '%s.json matches the zod source (run `pnpm schemas` if not)',
    (name) => {
      const onDisk = JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));
      expect(onDisk).toEqual(generated[name]);
    },
  );
});
