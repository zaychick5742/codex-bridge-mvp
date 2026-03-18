import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateAfterRound } from './analyze.js';
import type { RoundRecord, RunState, StartRequest } from './types.js';

function buildRound(overrides: Partial<RoundRecord> = {}): RoundRecord {
  return {
    round: 2,
    prompt: 'prompt',
    started_at: '2026-03-18T00:00:00.000Z',
    ended_at: '2026-03-18T00:01:00.000Z',
    worker_exit_code: 0,
    worker_signal: null,
    summary: 'Acceptance criteria are met. No remaining work for the stated task.',
    last_message: 'Acceptance criteria are met. No remaining work for the stated task.',
    guidance_detected: false,
    diff_status: 'changed',
    diff_fingerprint: 'fp-current',
    diff_summary: 'M src/status.js',
    test_results: 'passed',
    verification_status: 'passed',
    verification_commands: ['/bin/zsh -lc npm test'],
    commands: [],
    stderr_lines: 0,
    non_json_stdout_lines: 0,
    progress: true,
    open_items: [],
    policy_violation: null,
    policy_warnings: [],
    force_continue_reason: null,
    ...overrides,
  };
}

function buildState(round: RoundRecord): RunState {
  return {
    run_id: 'run-1',
    created_at: '2026-03-18T00:00:00.000Z',
    updated_at: '2026-03-18T00:01:00.000Z',
    status: 'running',
    judgement: 'working',
    summary: '',
    diff_status: 'changed',
    test_results: 'passed',
    round: round.round,
    stall_count: 0,
    last_error: null,
    policy_mode: 'warn',
    hard_denied_commands: [],
    finalized: false,
    finalized_at: null,
    thread_id: null,
    active_round: round.round,
    active_worker_pid: null,
    rounds: [
      buildRound({
        round: 1,
        summary: 'Changed src/status.js. Remaining: run npm test.',
        last_message: 'Changed src/status.js. Remaining: run npm test.',
        diff_fingerprint: 'fp-previous',
        test_results: 'not_run',
        verification_status: 'not_run',
      }),
      round,
    ],
  };
}

const spec: StartRequest = {
  task_prompt: 'Fix the toy repo and verify it.',
  cwd: '/tmp/repo',
  acceptance: ['src/status.js returns bridge-ok', 'npm test passes'],
  allowed_commands: ['git', 'npm', 'cat'],
  stop_conditions: [],
};

test('evaluateAfterRound marks completed summary with no remaining work as done', () => {
  const round = buildRound();
  const outcome = evaluateAfterRound(spec, buildState(round), round, {
    interrupted: false,
    startupFailure: false,
  });

  assert.equal(outcome.status, 'done');
  assert.equal(outcome.judgement, 'ready_to_finalize');
  assert.deepEqual(outcome.open_items, []);
});

test('evaluateAfterRound still keeps explicit remaining work open', () => {
  const round = buildRound({
    summary: 'Verification passed. Remaining: update docs.',
    last_message: 'Verification passed. Remaining: update docs.',
  });

  const outcome = evaluateAfterRound(spec, buildState(round), round, {
    interrupted: false,
    startupFailure: false,
  });

  assert.equal(outcome.status, 'waiting');
  assert.match(outcome.open_items.join('\n'), /unfinished work|missing closure/i);
});

test('evaluateAfterRound blocks on non-zero worker exit', () => {
  const round = buildRound({
    worker_exit_code: 1,
    summary: '',
    last_message: '',
    test_results: 'not_run',
    verification_status: 'not_run',
  });

  const outcome = evaluateAfterRound(spec, buildState(round), round, {
    interrupted: false,
    startupFailure: false,
  });

  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.judgement, 'blocked');
  assert.equal(outcome.last_error, 'worker_exit_1');
  assert.match(outcome.open_items.join('\n'), /non-zero code 1/i);
});
