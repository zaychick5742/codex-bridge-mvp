import { basename } from 'node:path';

import type { CommandExecutionRecord } from './types.js';

const WRAPPER_COMMANDS = new Set(['command', 'builtin', 'env', 'nohup', 'time']);

function trimOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function unescapeDoubleQuotedShell(value: string): string {
  let result = '';
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (!escaped) {
      if (char === '\\') {
        escaped = true;
        continue;
      }

      result += char;
      continue;
    }

    if (char === '"' || char === '\\' || char === '$' || char === '`') {
      result += char;
    } else if (char === '\n') {
      result += '\n';
    } else {
      result += `\\${char}`;
    }

    escaped = false;
  }

  if (escaped) {
    result += '\\';
  }

  return result;
}

function splitTopLevelShellSegments(input: string): string[] {
  const segments: string[] = [];
  let current = '';
  let singleQuote = false;
  let doubleQuote = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1] ?? '';

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && !singleQuote) {
      current += char;
      escaped = true;
      continue;
    }

    if (char === "'" && !doubleQuote) {
      singleQuote = !singleQuote;
      current += char;
      continue;
    }

    if (char === '"' && !singleQuote) {
      doubleQuote = !doubleQuote;
      current += char;
      continue;
    }

    if (!singleQuote && !doubleQuote) {
      if (char === '\n' || char === ';') {
        if (current.trim()) {
          segments.push(current.trim());
        }
        current = '';
        continue;
      }

      if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
        if (current.trim()) {
          segments.push(current.trim());
        }
        current = '';
        index += 1;
        continue;
      }

      if (char === '|') {
        if (current.trim()) {
          segments.push(current.trim());
        }
        current = '';
        continue;
      }
    }

    current += char;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

function firstToken(segment: string): { token: string; consumed: number } | null {
  let token = '';
  let singleQuote = false;
  let doubleQuote = false;
  let escaped = false;
  let started = false;

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];

    if (!started && /\s/.test(char)) {
      continue;
    }

    started = true;

    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && !singleQuote) {
      token += char;
      escaped = true;
      continue;
    }

    if (char === "'" && !doubleQuote) {
      singleQuote = !singleQuote;
      token += char;
      continue;
    }

    if (char === '"' && !singleQuote) {
      doubleQuote = !doubleQuote;
      token += char;
      continue;
    }

    if (!singleQuote && !doubleQuote && /\s/.test(char)) {
      return { token, consumed: index + 1 };
    }

    token += char;
  }

  return started ? { token, consumed: segment.length } : null;
}

function stripAssignments(segment: string): string {
  let remaining = segment.trim();

  while (remaining.length > 0) {
    const tokenInfo = firstToken(remaining);
    if (!tokenInfo) {
      return '';
    }

    const normalized = trimOuterQuotes(tokenInfo.token);
    const isAssignment =
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(normalized) && !normalized.startsWith('./');

    if (!isAssignment) {
      return remaining;
    }

    remaining = remaining.slice(tokenInfo.consumed).trimStart();
  }

  return remaining;
}

function unwrapShellPayload(command: string): string {
  const match = command.match(/\s-(?:lc|c)\s+(.+)$/);
  if (!match) {
    return command.trim();
  }

  const rawPayload = match[1].trim();
  const quote = rawPayload[0];
  const payload = trimOuterQuotes(rawPayload);
  if (quote === '"') {
    return unescapeDoubleQuotedShell(payload);
  }
  return payload;
}

function normalizeCommandName(token: string): string {
  return basename(trimOuterQuotes(token)).trim();
}

export function extractCommandNames(command: string): string[] {
  const shellPayload = unwrapShellPayload(command);
  const segments = splitTopLevelShellSegments(shellPayload);
  const names: string[] = [];

  for (const rawSegment of segments) {
    let remaining = stripAssignments(rawSegment);
    let tokenInfo = firstToken(remaining);

    while (tokenInfo) {
      const name = normalizeCommandName(tokenInfo.token);

      if (WRAPPER_COMMANDS.has(name)) {
        remaining = remaining.slice(tokenInfo.consumed).trimStart();
        tokenInfo = firstToken(remaining);
        continue;
      }

      if (name.length > 0) {
        names.push(name);
      }
      break;
    }
  }

  return [...new Set(names)];
}

export function auditCommandAgainstPolicy(
  command: string,
  allowedCommands: string[],
): { extracted: string[]; violating: string[] } {
  const extracted = extractCommandNames(command);
  const allowedSet = new Set(allowedCommands.map((value) => value.toLowerCase()));
  const violating = extracted.filter((value) => !allowedSet.has(value.toLowerCase()));
  return { extracted, violating };
}

export function isTestCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    /\b(pytest|jest|vitest|ava|tap)\b/.test(normalized) ||
    /\b(node\s+--test|cargo\s+test|go\s+test|npm\s+test|pnpm\s+test|yarn\s+test|bun\s+test)\b/.test(
      normalized,
    ) ||
    /\b(playwright\s+test|cypress\s+run|rspec|phpunit|mvn\s+test|gradle\s+test)\b/.test(normalized)
  );
}

export function isVerificationCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    isTestCommand(command) ||
    /\b(eslint|ruff|flake8|mypy|tsc|typecheck|lint|build|check|verify)\b/.test(normalized) ||
    /\b(npm\s+run\s+(lint|build|typecheck|check)|pnpm\s+run\s+(lint|build|typecheck|check)|yarn\s+(lint|build|typecheck|check))\b/.test(
      normalized,
    )
  );
}

export function annotateCommand(record: CommandExecutionRecord): CommandExecutionRecord {
  return {
    ...record,
    extracted_commands: extractCommandNames(record.command),
    is_test: isTestCommand(record.command),
    is_verification: isVerificationCommand(record.command),
  };
}
