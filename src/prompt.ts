import type { PolicyMode, RoundRecord, RunState, StartRequest } from './types.js';

function bulletList(values: string[]): string {
  if (values.length === 0) {
    return '- none';
  }
  return values.map((value) => `- ${value}`).join('\n');
}

function buildHardDeniedCommandsSection(hardDeniedCommands: string[]): string[] {
  if (hardDeniedCommands.length === 0) {
    return [];
  }

  return [
    'Bridge hard-denied shell command basenames:',
    bulletList(hardDeniedCommands),
    '',
    'Never invoke these commands. The bridge will terminate the round if they appear, even in full-access mode.',
  ];
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

function buildAllowedCommandsSection(
  spec: StartRequest,
  policyMode: PolicyMode,
  hardDeniedCommands: string[],
): string[] {
  if (policyMode === 'off') {
    return [
      'Bridge policy mode:',
      '- off (full access)',
      '',
      'Allowed shell command basenames from the supervisor:',
      bulletList(spec.allowed_commands),
      '',
      'These allowed_commands are advisory metadata only in full-access mode. They are not enforced by the bridge and should not block necessary work.',
      '',
      ...buildHardDeniedCommandsSection(hardDeniedCommands),
    ];
  }

  return [
    'Bridge policy mode:',
    `- ${policyMode}`,
    '',
    'Allowed shell command basenames:',
    bulletList(spec.allowed_commands),
    '',
    ...buildHardDeniedCommandsSection(hardDeniedCommands),
  ];
}

function buildExecutionContract(policyMode: PolicyMode, hardDeniedCommands: string[]): string[] {
  const lines = [
    'Execution contract:',
    '- Do the work directly in the repository.',
    '- Stay inside the target repository rooted at the workspace path above.',
    '- Do not inspect or rely on bootstrap, memory, or session files outside the target repository.',
    '- Do not create commits, amend commits, or switch branches.',
  ];

  if (policyMode === 'off') {
    lines.push('- Bridge policy mode is off. Use whatever non-destructive shell commands are needed to complete the task safely.');
    lines.push('- The allowed_commands list is advisory in this mode. Do not stop only because a needed command is absent from that list.');
  } else if (policyMode === 'warn') {
    lines.push('- Prefer to stay within the allowed_commands list when practical. The bridge will audit commands but will not interrupt the round.');
    lines.push('- If you use a command outside the allowed list, mention it briefly in the final summary.');
  } else {
    lines.push('- If you need a command outside the allowed list, stop and state that explicitly instead of using it.');
  }

  if (hardDeniedCommands.length > 0) {
    lines.push(
      `- Never invoke hard-denied commands in this environment: ${hardDeniedCommands.join(', ')}.`,
    );
  }

  lines.push('- Before finishing this round, provide a concise summary of what changed, what remains, and what verification ran.');
  lines.push('- If you need a human or supervisor decision, ask the question explicitly in the final message.');
  return lines;
}

export function buildInitialPrompt(
  spec: StartRequest,
  policyMode: PolicyMode,
  hardDeniedCommands: string[],
): string {
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
    ...buildAllowedCommandsSection(spec, policyMode, hardDeniedCommands),
    '',
    'Stop conditions:',
    bulletList(spec.stop_conditions),
    '',
    ...buildExecutionContract(policyMode, hardDeniedCommands),
  ].join('\n');
}

export function buildContinuationPrompt(
  spec: StartRequest,
  state: RunState,
  policyMode: PolicyMode,
  hardDeniedCommands: string[],
): string {
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
    ...buildAllowedCommandsSection(spec, policyMode, hardDeniedCommands),
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
    ...(policyMode === 'off'
      ? ['- Full-access mode is enabled. Use the commands you need to finish the task safely instead of treating allowed_commands as a hard limit.']
      : policyMode === 'warn'
        ? ['- Prefer the allowed_commands list when practical, but the bridge will only audit and warn in this mode.']
        : ['- Treat allowed_commands as a hard limit in this mode.']),
    ...(hardDeniedCommands.length > 0
      ? [`- Never invoke hard-denied commands in this environment: ${hardDeniedCommands.join(', ')}.`]
      : []),
    '- If code is still incomplete, finish it first.',
    '- Run at least one key verification command successfully before claiming completion.',
    '- If you are done, give a concise closing summary that states changed files and verification results.',
    '- If a decision is required, ask one explicit question and stop.',
  ].join('\n');
}
