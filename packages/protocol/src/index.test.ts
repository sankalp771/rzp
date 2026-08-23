import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './index.js';

describe('protocol package', () => {
  it('exposes the pinned protocol version', () => {
    expect(PROTOCOL_VERSION).toBe('acnp/0.1');
  });
});
