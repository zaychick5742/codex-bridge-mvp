import test from 'node:test';
import assert from 'node:assert/strict';

import { auditCommandAgainstPolicy, extractCommandNames } from './shell.js';

test('extractCommandNames identifies rm in a shell payload', () => {
  const command = "/bin/zsh -lc 'rm -rf tmp/cache'";
  assert.deepEqual(extractCommandNames(command), ['rm']);
});

test('extractCommandNames identifies absolute-path rm invocations', () => {
  const command = '/bin/zsh -lc "/bin/rm -rf tmp/cache"';
  assert.deepEqual(extractCommandNames(command), ['rm']);
});

test('extractCommandNames keeps regex alternation inside quoted rg patterns', () => {
  const command = '/bin/zsh -lc "rg -n \\"real|quickstart|summary\\" README.md"';
  assert.deepEqual(extractCommandNames(command), ['rg']);
});

test('extractCommandNames keeps pipelines and wrapper commands intact', () => {
  const command = "/usr/bin/env bash -lc 'cat README.md | sed -n \"1,40p\"'";
  assert.deepEqual(extractCommandNames(command), ['cat', 'sed']);
});

test('auditCommandAgainstPolicy does not flag quoted rg alternatives as commands', () => {
  const command = '/bin/zsh -lc "rg -n \\"real|quickstart|summary\\" README.md"';
  assert.deepEqual(auditCommandAgainstPolicy(command, ['rg', 'cat']).violating, []);
});
