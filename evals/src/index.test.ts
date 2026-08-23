import { expect, it } from 'vitest';
import { EVALS_PLACEHOLDER } from './index.js';
it('evals package loads', () => expect(EVALS_PLACEHOLDER).toBe(true));
