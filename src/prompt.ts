import type { RoundRecord, RunState, StartRequest } from './types.js';

function bulletList(values: string[]): string {
  if (values.length === 0) {
    return '- none';
  }
  return values.map((value) => `- ${value}`).join('\n');
}

function summarizeCommands(round: RoundRecord | undefined): string {
  if (!round || round.commands.length === 0) {
    return '- none';
  }
  return round.commands
    .filter((command) => command.status === 'completed')
    .slice(-10)
    .map((command) => {
      const suffix = command.exit_code === null ? 'exit=unknown' : `exit=${command.exit_code}`;
      return `- ${command.command} (${suffix})`;
    })
    .join('\n');
}

export function buildInitialPrompt(spec: StartRequest): string {
  return [
    'You are working as a non-interactive worker for a bridge daemon.',
    `Workspace root: ${spec.cwd}`,
    '',
    'Primary task:',
    spec.task_prompt,
    '',
    'Acceptance criteria:',
    bulletList(spec.acceptance),
    '',
    'Allowed shell command basenames:',
    bulletList(spec.allowed_commands),
    '',
    'Stop conditions:',
    bulletList(spec.stop_conditions),
    '',
    'Execution contract:',
    '- Do the work directly in the repository.',
    '- Stay inside the target repository rooted at the workspace path above.',
    '- Do not inspect or rely on bootstrap, memory, or session files outside the target repository.',
    '- Do not create commits, amend commits, or switch branches.',
    '- If you need a command outside the allowed list, stop and state that explicitly instead of using it.',
    '- Before finishing this round, provide a concise summary of what changed, what remains, and what verification ran.',
    '- If you need a human or supervisor decision, ask the question explicitly in the final message.',
  ].join('\n');
}

export function buildContinuationPrompt(spec: StartRequest, state: RunState): string {
  const lastRound = state.rounds.at(-1);
  const unfinishedItems =
    lastRound?.open_items.length && lastRound.open_items.length > 0
      ? lastRound.open_items
      : ['Close remaining gaps against the original acceptance criteria.'];

  return [
    `This is supervisor-approved continuation round ${state.round + 1}.`,
    `Workspace root: ${spec.cwd}`,
    '',
    'Original task:',
    spec.task_prompt,
    '',
    'Acceptance criteria:',
    bulletList(spec.acceptance),
    '',
    'Allowed shell command basenames:',
    bulletList(spec.allowed_commands),
    '',
    'Stop conditions:',
    bulletList(spec.stop_conditions),
    '',
    'Previous round summary:',
    lastRound?.summary || '(no prior summary)',
    '',
    'Current snapshot:',
    `- diff_status: ${state.diff_status}`,
    `- test_results: ${state.test_results}`,
    `- stall_count: ${state.stall_count}`,
    '',
    'Recent commands:',
    summarizeCommands(lastRound),
    '',
    'Unfinished items:',
    bulletList(unfinishedItems),
    '',
    'Continuation priorities:',
    '- Continue from the current working tree instead of redoing prior analysis.',
    '- Stay inside the target repository and ignore external bootstrap or memory conventions.',
    '- Do not create commits, amend commits, or switch branches.',
    '- If code is still incomplete, finish it first.',
    '- Run at least one key verification command successfully before claiming completion.',
    '- If you are done, give a concise closing summary that states changed files and verification results.',
    '- If a decision is required, ask one explicit question and stop.',
  ].join('\n');
}
