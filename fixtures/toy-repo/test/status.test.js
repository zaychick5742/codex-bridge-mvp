import test from 'node:test';
import assert from 'node:assert/strict';

import { getStatus } from '../src/status.js';

test('getStatus returns bridge-ok', () => {
  assert.equal(getStatus(), 'bridge-ok');
});
