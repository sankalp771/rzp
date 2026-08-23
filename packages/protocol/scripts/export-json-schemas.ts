import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportJsonSchemas } from '../src/jsonschema.js';

// Writes schemas/json/<name>.json. Run via `pnpm --filter @negotiator/protocol schemas`.
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'json');
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(exportJsonSchemas())) {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(schema, null, 2) + '\n');
}
console.log(`wrote ${Object.keys(exportJsonSchemas()).length} schemas to ${dir}`);
