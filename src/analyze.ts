import type {
  DiffSnapshot,
  EvaluatedOutcome,
  QueryResponse,
  RoundRecord,
  RunState,
  StartRequest,
  VerificationSnapshot,
  VerificationStatus,
} from './types.js';
import { dedupe, runExecFile, sha1 } from './utils.js';

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function verificationRank(status: VerificationStatus): number {
  switch (status) {
    case 'passed':
      return 3;
    case 'failed':
      return 2;
    case 'error':
      return 1;
    case 'not_run':
    default:
      return 0;
  }
}

export async function captureDiffSnapshot(cwd: string): Promise<DiffSnapshot> {
  const insideRepo = await runExecFile(cwd, 'git', ['rev-parse', '--is-inside-work-tree']);
  if (insideRepo.code !== 0 || !insideRepo.stdout.includes('true')) {
    return {
      status: 'no_repo',
      fingerprint: null,
      summary: null,
      error: insideRepo.stderr.trim() || null,
    };
  }

  const statusResult = await runExecFile(cwd, 'git', ['status', '--porcelain']);
  if (statusResult.code !== 0) {
    return {
      status: 'error',
      fingerprint: null,
      summary: null,
      error: statusResult.stderr.trim() || 'git status failed',
    };
  }

  const cleaned = statusResult.stdout.trim();
  if (!cleaned) {
    return {
      status: 'clean',
      fingerprint: 'clean',
      summary: null,
      error: null,
    };
  }

  return {
    status: 'changed',
    fingerprint: sha1(cleaned),
    summary: cleaned.split('\n').slice(0, 20).join('\n'),
    error: null,
  };
}

export function captureVerificationSnapshot(round: RoundRecord): VerificationSnapshot {
  const verificationCommands = round.commands
    .filter((command) => command.status === 'completed' && command.is_verification)
    .map((command) => command.command);
  const testCommands = round.commands.filter(
    (command) => command.status === 'completed' && command.is_test,
  );

  let verificationStatus: VerificationStatus = 'not_run';
  if (verificationCommands.length > 0) {
    if (round.commands.some((command) => command.is_verification && command.exit_code === null)) {
      verificationStatus = 'error';
    } else if (round.commands.some((command) => command.is_verification && (command.exit_code ?? 1) !== 0)) {
      verificationStatus = 'failed';
    } else {
      verificationStatus = 'passed';
    }
  }

  let testResults: VerificationSnapshot['test_results'] = 'not_run';
  if (testCommands.length > 0) {
    if (testCommands.some((command) => command.exit_code === null)) {
      testResults = 'error';
    } else if (testCommands.some((command) => (command.exit_code ?? 1) !== 0)) {
      testResults = 'failed';
    } else {
      testResults = 'passed';
    }
  }

  return {
    test_results: testResults,
    verification_status: verificationStatus,
    verification_commands: verificationCommands,
  };
}

export function detectGuidance(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }

  return (
    /\b(needs? guidance|need your input|need your decision|please decide|awaiting guidance|question for supervisor|unclear requirement|which option|which approach|should i)\b/.test(
      normalized,
    ) ||
    (normalized.includes('?') && /\b(should|which|what|do you want|would you like)\b/.test(normalized))
  );
}

function mentionsUnfinishedWork(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) {
    return true;
  }

  if (
    /\b(no remaining work|nothing remaining|no obvious unfinished work|nothing left to do|no unfinished work|no work remains|remaining: nothing|what remains: nothing|acceptance criteria are met|acceptance criteria are satisfied)\b/.test(
      normalized,
    )
  ) {
    return false;
  }

  return /\b(todo|remaining|still need|next step|left to|unfinished|could not|unable to|blocked|not yet)\b/.test(
    normalized,
  );
}

function forceContinueReason(stopConditions: string[], round: number): string | null {
  const combined = stopConditions.join('\n').toLowerCase();
  if (round < 2) {
    if (
      /wait for continue|wait for supervisor|pause after the first round|require at least 2 rounds|at least two rounds|at least 2 rounds/.test(
        combined,
      )
    ) {
      return 'Stop conditions require another supervisor-controlled round before completion.';
    }
  }
  return null;
}

function inferOpenItems(
  spec: StartRequest,
  round: RoundRecord,
  verificationStatus: VerificationStatus,
  forcedContinue: string | null,
): string[] {
  const openItems: string[] = [];

  if (round.diff_status !== 'changed') {
    openItems.push('No code changes detected in the target repository.');
  }

  if (verificationStatus !== 'passed') {
    openItems.push('No passing key verification command has been recorded yet.');
  }

  if (round.policy_violation) {
    openItems.push(`Policy violation: ${round.policy_violation}`);
  }

  if (mentionsUnfinishedWork(round.last_message)) {
    openItems.push('Worker summary still suggests unfinished work or missing closure.');
  }

  if (forcedContinue) {
    openItems.push(forcedContinue);
  }

  if (!round.last_message.trim()) {
    openItems.push('Worker did not produce a final summary message.');
  }

  if (spec.acceptance.length > 0 && round.summary.trim().length === 0) {
    openItems.push('Acceptance progress is not yet clear from the worker summary.');
  }

  return dedupe(openItems);
}

function didProgress(previousRound: RoundRecord | undefined, currentRound: RoundRecord): boolean {
  if (!previousRound) {
    return true;
  }

  if (previousRound.diff_fingerprint !== currentRound.diff_fingerprint) {
    return true;
  }

  if (
    verificationRank(currentRound.verification_status) >
    verificationRank(previousRound.verification_status)
  ) {
    return true;
  }

  if (normalizeText(previousRound.summary) !== normalizeText(currentRound.summary)) {
    return true;
  }

  return false;
}

export function evaluateAfterRound(
  spec: StartRequest,
  state: RunState,
  round: RoundRecord,
  options: {
    interrupted: boolean;
    startupFailure: boolean;
  },
): EvaluatedOutcome {
  const previousRound = state.rounds.at(-2);
  const progress = didProgress(previousRound, round);
  const stallCount = progress ? 0 : state.stall_count + 1;
  const forcedContinue = forceContinueReason(spec.stop_conditions, round.round);
  const openItems = inferOpenItems(spec, round, round.verification_status, forcedContinue);

  if (round.policy_violation) {
    return {
      status: 'blocked',
      judgement: 'blocked',
      stall_count: stallCount,
      last_error: `blocked_policy: ${round.policy_violation}`,
      open_items: openItems,
      progress,
      force_continue_reason: forcedContinue,
    };
  }

  if (options.interrupted) {
    return {
      status: 'blocked',
      judgement: 'blocked',
      stall_count: stallCount,
      last_error: 'interrupted_by_user',
      open_items: dedupe([...openItems, 'Run was interrupted manually.']),
      progress,
      force_continue_reason: forcedContinue,
    };
  }

  if (options.startupFailure) {
    return {
      status: 'blocked',
      judgement: 'blocked',
      stall_count: stallCount,
      last_error: round.worker_exit_code === null ? 'worker_start_failed' : `worker_exit_${round.worker_exit_code}`,
      open_items: dedupe([...openItems, 'Worker process failed before a normal round completion.']),
      progress,
      force_continue_reason: forcedContinue,
    };
  }

  if (round.worker_exit_code !== null && round.worker_exit_code !== 0) {
    return {
      status: 'blocked',
      judgement: 'blocked',
      stall_count: stallCount,
      last_error: `worker_exit_${round.worker_exit_code}`,
      open_items: dedupe([
        ...openItems,
        `Worker exited with non-zero code ${round.worker_exit_code}.`,
      ]),
      progress,
      force_continue_reason: forcedContinue,
    };
  }

  if (stallCount >= 3) {
    return {
      status: 'blocked',
      judgement: 'blocked',
      stall_count: stallCount,
      last_error: 'blocked_stalled: 3 consecutive rounds without substantive progress',
      open_items: dedupe([...openItems, 'Three consecutive rounds produced no substantive progress.']),
      progress,
      force_continue_reason: forcedContinue,
    };
  }

  if (round.guidance_detected || stallCount >= 2) {
    return {
      status: 'needs_guidance',
      judgement: 'needs_guidance',
      stall_count: stallCount,
      last_error:
        stallCount >= 2
          ? 'needs_guidance: 2 consecutive rounds without substantive progress'
          : null,
      open_items: dedupe([
        ...openItems,
        round.guidance_detected ? 'Worker explicitly requested guidance.' : '',
      ]),
      progress,
      force_continue_reason: forcedContinue,
    };
  }

  if (
    round.diff_status === 'changed' &&
    round.verification_status === 'passed' &&
    openItems.length === 0
  ) {
    return {
      status: 'done',
      judgement: 'ready_to_finalize',
      stall_count: stallCount,
      last_error: null,
      open_items: [],
      progress,
      force_continue_reason: forcedContinue,
    };
  }

  return {
    status: 'waiting',
    judgement: 'acceptance_partial',
    stall_count: stallCount,
    last_error:
      round.worker_exit_code && round.worker_exit_code !== 0
        ? `worker exited with code ${round.worker_exit_code}`
        : null,
    open_items: openItems,
    progress,
    force_continue_reason: forcedContinue,
  };
}

export function buildQueryResponse(state: RunState): QueryResponse {
  return {
    status: state.status,
    judgement: state.judgement,
    summary: state.summary,
    diff_status: state.diff_status,
    test_results: state.test_results,
    round: state.round,
    stall_count: state.stall_count,
    last_error: state.last_error,
  };
}
