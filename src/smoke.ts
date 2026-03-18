import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { sleep } from './utils.js';

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return text.trim().length > 0 ? JSON.parse(text) : null;
}

async function prepareToyRepo(projectRoot: string): Promise<string> {
  const fixtureRoot = join(projectRoot, 'fixtures', 'toy-repo');
  const tempRoot = join(projectRoot, '.tmp', `smoke-${Date.now()}`);
  const repoRoot = join(tempRoot, 'repo');
  await fs.mkdir(tempRoot, { recursive: true });
  await fs.cp(fixtureRoot, repoRoot, { recursive: true });

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  await execFileAsync('git', ['init'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.name', 'Codex Bridge Smoke'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: repoRoot });
  await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
  await execFileAsync('git', ['commit', '-m', 'baseline'], { cwd: repoRoot });
  return repoRoot;
}

async function waitForQuery(
  baseUrl: string,
  runId: string,
  predicate: (query: Record<string, unknown>) => boolean,
  timeoutMs = 240000,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const query = (await fetchJson(`${baseUrl}/query?run_id=${runId}`)) as Record<string, unknown>;
    if (predicate(query)) {
      return query;
    }
    await sleep(1500);
  }
  throw new Error(`timed out waiting for run ${runId}`);
}

export async function runSmoke(projectRoot: string, port: number): Promise<void> {
  const broadAllowedCommands = [
    'git',
    'npm',
    'node',
    'rg',
    'ls',
    'cat',
    'sed',
    'find',
    'pwd',
    'mkdir',
    'mv',
    'cp',
    'touch',
    'zsh',
    'bash',
    'sh',
    'sort',
    'head',
    'tail',
    'grep',
    'cut',
    'tr',
    'echo',
    'printf',
    'wc',
    'xargs',
    'awk',
    'perl',
    'python',
    'python3',
  ];

  const daemonProcess = spawn('node', [join(projectRoot, 'dist', 'cli.js'), 'daemon', '--port', String(port)], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let daemonOutput = '';
  daemonProcess.stdout.on('data', (chunk) => {
    daemonOutput += chunk.toString('utf8');
  });
  daemonProcess.stderr.on('data', (chunk) => {
    daemonOutput += chunk.toString('utf8');
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const readyDeadline = Date.now() + 30000;
  while (Date.now() < readyDeadline) {
    try {
      await fetchJson(`${baseUrl}/health`);
      break;
    } catch {
      await sleep(500);
    }
  }

  try {
    const repoRoot = await prepareToyRepo(projectRoot);

    const startResponse = (await fetchJson(`${baseUrl}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task_prompt:
          'Inspect the toy repo, make the minimal code change required so the tests would pass, but do not run tests in this first round. Stop after the code change and summarize what remains.',
        cwd: repoRoot,
        acceptance: [
          'src/status.js returns "bridge-ok"',
          'npm test passes',
        ],
        allowed_commands: broadAllowedCommands,
        stop_conditions: [
          'Pause after the first round and wait for continue before running verification.',
          'Require at least 2 rounds before completion.',
        ],
      }),
    })) as {
      run_id: string;
      query: Record<string, unknown>;
    };

    assert.equal(typeof startResponse.run_id, 'string');
    const runId = startResponse.run_id;

    const firstRound = await waitForQuery(
      baseUrl,
      runId,
      (query) => query.status === 'waiting' || query.status === 'needs_guidance' || query.status === 'blocked' || query.status === 'done',
      240000,
    );
    assert.equal(firstRound.status, 'waiting');

    await fetchJson(`${baseUrl}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: runId }),
    });

    let settled = await waitForQuery(
      baseUrl,
      runId,
      (query) => query.status === 'waiting' || query.status === 'needs_guidance' || query.status === 'blocked' || query.status === 'done',
      240000,
    );

    let continueCount = 0;
    while (settled.status === 'waiting' && continueCount < 4) {
      continueCount += 1;
      await fetchJson(`${baseUrl}/continue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ run_id: runId }),
      });
      settled = await waitForQuery(
        baseUrl,
        runId,
        (query) =>
          query.status === 'waiting' ||
          query.status === 'needs_guidance' ||
          query.status === 'blocked' ||
          query.status === 'done',
        240000,
      );
    }

    assert.equal(
      settled.status,
      'done',
      `expected the run to reach done after auto-continues, got ${String(settled.status)}`,
    );
    assert.equal(settled.test_results, 'passed');

    const finalized = (await fetchJson(`${baseUrl}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: runId }),
    })) as {
      query: Record<string, unknown>;
    };

    assert.equal(finalized.query.judgement, 'finalized');

    const interruptRepo = await prepareToyRepo(projectRoot);
    const interruptStart = (await fetchJson(`${baseUrl}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task_prompt:
          'Run the shell command `node -e "setTimeout(() => process.exit(0), 15000)"` first, do not make code changes, and do not summarize until the command completes.',
        cwd: interruptRepo,
        acceptance: ['No acceptance for interrupt probe'],
        allowed_commands: broadAllowedCommands,
        stop_conditions: [],
      }),
    })) as {
      run_id: string;
    };

    const interruptRunId = interruptStart.run_id;
    await waitForQuery(baseUrl, interruptRunId, (query) => query.status === 'running', 30000).catch(
      () => undefined,
    );

    const interrupted = (await fetchJson(`${baseUrl}/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: interruptRunId }),
    })) as {
      query: Record<string, unknown>;
    };

    assert.equal(interrupted.query.status, 'blocked');
    assert.equal(interrupted.query.last_error, 'interrupted_by_user');
  } finally {
    daemonProcess.kill('SIGTERM');
    await sleep(1000);
    if (!daemonProcess.killed) {
      daemonProcess.kill('SIGKILL');
    }
  }

  if (daemonProcess.exitCode && daemonProcess.exitCode !== 0) {
    throw new Error(`daemon exited unexpectedly: ${daemonOutput}`);
  }
}
