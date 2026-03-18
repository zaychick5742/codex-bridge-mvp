import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createWriteStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import {
  buildQueryResponse,
  captureDiffSnapshot,
  captureVerificationSnapshot,
  detectGuidance,
  evaluateAfterRound,
} from './analyze.js';
import { buildContinuationPrompt, buildInitialPrompt } from './prompt.js';
import { annotateCommand, auditCommandAgainstPolicy } from './shell.js';
import type {
  CommandExecutionRecord,
  LoadedRun,
  NormalizedEvent,
  PolicyMode,
  QueryRequest,
  QueryResponse,
  RoundRecord,
  RunState,
  StartRequest,
} from './types.js';
import {
  appendJsonl,
  ensureDir,
  fileExists,
  nowIso,
  parseJsonLine,
  readJson,
  sleep,
  truncate,
  writeJson,
  writeText,
} from './utils.js';

interface ActiveProcess {
  child: ChildProcessByStdio<null, Readable, Readable>;
  run_id: string;
  round: number;
  command_records: Map<string, CommandExecutionRecord>;
  interrupted: boolean;
  startup_failed: boolean;
  policy_violation: string | null;
  policy_warnings: string[];
  stderr_lines: number;
  non_json_stdout_lines: number;
  last_message: string;
  line_queue: Promise<void>;
  exit_promise: Promise<void>;
  resolve_exit: () => void;
}

interface JsonRequest {
  path: string;
  method: string;
  body: unknown;
}

function isStartRequest(value: unknown): value is StartRequest {
  const candidate = value as Partial<StartRequest>;
  return (
    typeof candidate?.task_prompt === 'string' &&
    typeof candidate?.cwd === 'string' &&
    Array.isArray(candidate?.acceptance) &&
    Array.isArray(candidate?.allowed_commands) &&
    Array.isArray(candidate?.stop_conditions)
  );
}

function isQueryRequest(value: unknown): value is QueryRequest {
  return typeof (value as Partial<QueryRequest>)?.run_id === 'string';
}

async function parseRequest(req: IncomingMessage): Promise<JsonRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');
  let body: unknown = {};
  if (rawBody.trim().length > 0) {
    body = JSON.parse(rawBody);
  }

  return {
    path: req.url ?? '/',
    method: req.method ?? 'GET',
    body,
  };
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

export class BridgeDaemon {
  private readonly root_dir: string;

  private readonly state_root: string;

  private readonly host: string;

  private readonly port: number;

  private readonly policy_mode: PolicyMode;

  private readonly runs = new Map<string, LoadedRun>();

  private readonly active_processes = new Map<string, ActiveProcess>();

  private server: Server | null = null;

  constructor(options: { root_dir: string; host: string; port: number; policy_mode: PolicyMode }) {
    this.root_dir = options.root_dir;
    this.host = options.host;
    this.port = options.port;
    this.policy_mode = options.policy_mode;
    this.state_root = join(this.root_dir, '.bridge-state');
  }

  async init(): Promise<void> {
    await ensureDir(this.state_root);
    await this.loadExistingRuns();
  }

  async listen(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (error) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    await new Promise<void>((resolve) => {
      this.server?.listen(this.port, this.host, resolve);
    });
  }

  async close(): Promise<void> {
    for (const active of this.active_processes.values()) {
      active.child.kill('SIGTERM');
    }

    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.server = null;
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this.host}:${this.port}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/query') {
      const runId = url.searchParams.get('run_id');
      if (!runId) {
        sendJson(res, 400, { error: 'run_id is required' });
        return;
      }
      sendJson(res, 200, this.queryRun(runId));
      return;
    }

    const parsed = await parseRequest(req);

    if (parsed.method === 'POST' && url.pathname === '/start') {
      if (!isStartRequest(parsed.body)) {
        sendJson(res, 400, { error: 'invalid start payload' });
        return;
      }

      const result = await this.startRun(parsed.body);
      sendJson(res, 200, result);
      return;
    }

    if (parsed.method === 'POST' && url.pathname === '/query') {
      if (!isQueryRequest(parsed.body)) {
        sendJson(res, 400, { error: 'invalid query payload' });
        return;
      }
      sendJson(res, 200, this.queryRun(parsed.body.run_id));
      return;
    }

    if (parsed.method === 'POST' && url.pathname === '/continue') {
      if (!isQueryRequest(parsed.body)) {
        sendJson(res, 400, { error: 'invalid continue payload' });
        return;
      }
      const result = await this.continueRun(parsed.body.run_id);
      sendJson(res, 200, result);
      return;
    }

    if (parsed.method === 'POST' && url.pathname === '/interrupt') {
      if (!isQueryRequest(parsed.body)) {
        sendJson(res, 400, { error: 'invalid interrupt payload' });
        return;
      }
      const result = await this.interruptRun(parsed.body.run_id);
      sendJson(res, 200, result);
      return;
    }

    if (parsed.method === 'POST' && url.pathname === '/finalize') {
      if (!isQueryRequest(parsed.body)) {
        sendJson(res, 400, { error: 'invalid finalize payload' });
        return;
      }
      const result = await this.finalizeRun(parsed.body.run_id);
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  private async loadExistingRuns(): Promise<void> {
    const entries = await fs.readdir(this.state_root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const dir = join(this.state_root, entry.name);
      const spec = await readJson<StartRequest>(join(dir, 'spec.json'));
      const state = await readJson<RunState>(join(dir, 'state.json'));

      if (!spec || !state) {
        continue;
      }

      state.policy_mode = state.policy_mode ?? this.policy_mode;
      for (const round of state.rounds) {
        round.policy_warnings = round.policy_warnings ?? [];
      }

      if (state.status === 'running' && state.active_worker_pid) {
        try {
          process.kill(state.active_worker_pid, 0);
        } catch {
          state.status = 'blocked';
          state.judgement = 'blocked';
          state.last_error = 'daemon_restarted_during_active_round';
          state.active_round = null;
          state.active_worker_pid = null;
          state.updated_at = nowIso();
          await writeJson(join(dir, 'state.json'), state);
        }
      }

      this.runs.set(state.run_id, { dir, spec, state });
    }
  }

  private assertNoActiveWorker(): void {
    if (this.active_processes.size > 0) {
      throw new Error('a worker is already running');
    }
  }

  private getRun(runId: string): LoadedRun {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`run not found: ${runId}`);
    }
    return run;
  }

  private buildRunDir(runId: string): string {
    return join(this.state_root, runId);
  }

  private buildEvent(
    runId: string,
    round: number | null,
    type: string,
    payload: Record<string, unknown>,
  ): NormalizedEvent {
    return {
      ts: nowIso(),
      run_id: runId,
      round,
      type,
      payload,
    };
  }

  private async appendEvent(
    run: LoadedRun,
    round: number | null,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await appendJsonl(join(run.dir, 'events.jsonl'), this.buildEvent(run.state.run_id, round, type, payload));
  }

  private async persistRun(run: LoadedRun): Promise<void> {
    run.state.updated_at = nowIso();
    await writeJson(join(run.dir, 'state.json'), run.state);
    if (run.state.active_worker_pid) {
      await writeText(join(run.dir, 'pid'), `${run.state.active_worker_pid}\n`);
    } else {
      await writeText(join(run.dir, 'pid'), '\n');
    }
  }

  private queryRun(runId: string): QueryResponse {
    const run = this.getRun(runId);
    return buildQueryResponse(run.state);
  }

  async startRun(spec: StartRequest): Promise<{ run_id: string; query: QueryResponse }> {
    this.assertNoActiveWorker();

    const run_id = crypto.randomUUID();
    const dir = this.buildRunDir(run_id);
    await ensureDir(dir);

    const state: RunState = {
      run_id,
      created_at: nowIso(),
      updated_at: nowIso(),
      status: 'running',
      judgement: 'working',
      summary: 'Worker round 1 is starting.',
      diff_status: 'error',
      test_results: 'not_run',
      round: 0,
      stall_count: 0,
      last_error: null,
      policy_mode: this.policy_mode,
      finalized: false,
      finalized_at: null,
      thread_id: null,
      active_round: null,
      active_worker_pid: null,
      rounds: [],
    };

    const run: LoadedRun = { dir, spec, state };
    this.runs.set(run_id, run);

    await writeJson(join(dir, 'spec.json'), spec);
    await writeJson(join(dir, 'state.json'), state);
    await this.appendEvent(run, null, 'run.created', {
      cwd: spec.cwd,
      acceptance: spec.acceptance,
      allowed_commands: spec.allowed_commands,
      stop_conditions: spec.stop_conditions,
      policy_mode: this.policy_mode,
    });

    await this.launchRound(run, buildInitialPrompt(spec));
    return {
      run_id,
      query: this.queryRun(run_id),
    };
  }

  async continueRun(runId: string): Promise<{ run_id: string; query: QueryResponse }> {
    this.assertNoActiveWorker();
    const run = this.getRun(runId);
    if (run.state.finalized) {
      throw new Error('run already finalized');
    }
    if (run.state.status !== 'waiting') {
      throw new Error(`run is not waiting: ${run.state.status}`);
    }

    await this.launchRound(run, buildContinuationPrompt(run.spec, run.state));
    return {
      run_id: runId,
      query: this.queryRun(runId),
    };
  }

  async interruptRun(runId: string): Promise<{ run_id: string; query: QueryResponse }> {
    const run = this.getRun(runId);
    const active = this.active_processes.get(runId);
    if (!active) {
      throw new Error('run has no active worker');
    }

    active.interrupted = true;
    run.state.status = 'blocked';
    run.state.judgement = 'blocked';
    run.state.last_error = 'interrupted_by_user';
    run.state.summary = `Round ${run.state.active_round ?? run.state.round} interrupted by user.`;
    await this.persistRun(run);

    active.child.kill('SIGINT');
    await Promise.race([active.exit_promise, sleep(3000)]);
    if (this.active_processes.has(runId)) {
      active.child.kill('SIGTERM');
      await Promise.race([active.exit_promise, sleep(2000)]);
    }

    return {
      run_id: runId,
      query: this.queryRun(runId),
    };
  }

  async finalizeRun(runId: string): Promise<{ run_id: string; query: QueryResponse }> {
    const run = this.getRun(runId);
    if (run.state.status !== 'done') {
      throw new Error(`run is not done: ${run.state.status}`);
    }
    if (run.state.finalized) {
      throw new Error('run already finalized');
    }

    run.state.finalized = true;
    run.state.finalized_at = nowIso();
    run.state.judgement = 'finalized';
    await this.persistRun(run);

    const finalPayload = {
      run_id: run.state.run_id,
      finalized_at: run.state.finalized_at,
      status: run.state.status,
      judgement: run.state.judgement,
      summary: run.state.summary,
      diff_status: run.state.diff_status,
      test_results: run.state.test_results,
      round: run.state.round,
      stall_count: run.state.stall_count,
      last_error: run.state.last_error,
      policy_mode: run.state.policy_mode,
    };

    await writeJson(join(run.dir, 'final.json'), finalPayload);
    await this.appendEvent(run, run.state.round, 'run.finalized', finalPayload);

    return {
      run_id: runId,
      query: this.queryRun(runId),
    };
  }

  private async launchRound(run: LoadedRun, prompt: string): Promise<void> {
    this.assertNoActiveWorker();

    const roundNumber = run.state.round + 1;
    const roundRecord: RoundRecord = {
      round: roundNumber,
      prompt,
      started_at: nowIso(),
      ended_at: null,
      worker_exit_code: null,
      worker_signal: null,
      summary: '',
      last_message: '',
      guidance_detected: false,
      diff_status: 'error',
      diff_fingerprint: null,
      diff_summary: null,
      test_results: 'not_run',
      verification_status: 'not_run',
      verification_commands: [],
      commands: [],
      stderr_lines: 0,
      non_json_stdout_lines: 0,
      progress: false,
      open_items: [],
      policy_violation: null,
      policy_warnings: [],
      force_continue_reason: null,
    };

    run.state.status = 'running';
    run.state.judgement = 'working';
    run.state.round = roundNumber;
    run.state.active_round = roundNumber;
    run.state.summary = `Round ${roundNumber} is running.`;
    run.state.last_error = null;
    run.state.rounds.push(roundRecord);

    const child = spawn(
      'codex',
      ['exec', '--json', '--full-auto', '--cd', run.spec.cwd, prompt],
      {
        cwd: this.root_dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    run.state.active_worker_pid = child.pid ?? null;
    await this.persistRun(run);
    await this.appendEvent(run, roundNumber, 'worker.started', {
      pid: child.pid ?? null,
      cwd: run.spec.cwd,
      policy_mode: this.policy_mode,
      argv: ['codex', 'exec', '--json', '--full-auto', '--cd', run.spec.cwd, '<prompt>'],
    });

    const stdoutStream = createWriteStream(join(run.dir, 'stdout.log'), { flags: 'a' });
    const stderrStream = createWriteStream(join(run.dir, 'stderr.log'), { flags: 'a' });
    stdoutStream.write(`\n=== round ${roundNumber} ${nowIso()} ===\n`);
    stderrStream.write(`\n=== round ${roundNumber} ${nowIso()} ===\n`);
    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);

    let resolveExit = () => {};
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const active: ActiveProcess = {
      child,
      run_id: run.state.run_id,
      round: roundNumber,
      command_records: new Map(),
      interrupted: false,
      startup_failed: false,
      policy_violation: null,
      policy_warnings: [],
      stderr_lines: 0,
      non_json_stdout_lines: 0,
      last_message: '',
      line_queue: Promise.resolve(),
      exit_promise: exitPromise,
      resolve_exit: resolveExit,
    };
    this.active_processes.set(run.state.run_id, active);

    const stdoutReader = createInterface({ input: child.stdout });
    const stderrReader = createInterface({ input: child.stderr });

    stdoutReader.on('line', (line) => {
      active.line_queue = active.line_queue
        .then(() => this.handleStdoutLine(run, active, roundNumber, line))
        .catch(async (error) => {
          run.state.status = 'blocked';
          run.state.judgement = 'blocked';
          run.state.last_error = error instanceof Error ? error.message : String(error);
          run.state.summary = `Worker stream handling failed in round ${roundNumber}.`;
          await this.persistRun(run);
        });
    });

    stderrReader.on('line', (line) => {
      active.line_queue = active.line_queue.then(() =>
        this.handleStderrLine(run, active, roundNumber, line),
      );
    });

    child.once('error', async (error) => {
      active.startup_failed = true;
      run.state.status = 'blocked';
      run.state.judgement = 'blocked';
      run.state.last_error = error.message;
      run.state.summary = `Worker failed to start in round ${roundNumber}.`;
      await this.persistRun(run);
    });

    child.once('close', async (code, signal) => {
      await active.line_queue;
      stdoutReader.close();
      stderrReader.close();
      stdoutStream.end();
      stderrStream.end();

      const latestRound = run.state.rounds.at(-1);
      if (!latestRound) {
        active.resolve_exit();
        this.active_processes.delete(run.state.run_id);
        return;
      }

      latestRound.worker_exit_code = code;
      latestRound.worker_signal = signal;
      latestRound.ended_at = nowIso();
      latestRound.last_message = active.last_message.trim();
      latestRound.summary = active.last_message.trim();
      latestRound.guidance_detected = detectGuidance(latestRound.last_message);
      latestRound.stderr_lines = active.stderr_lines;
      latestRound.non_json_stdout_lines = active.non_json_stdout_lines;
      latestRound.policy_violation = active.policy_violation;
      latestRound.policy_warnings = [...active.policy_warnings];
      latestRound.commands = [...active.command_records.values()];

      const diffSnapshot = await captureDiffSnapshot(run.spec.cwd);
      latestRound.diff_status = diffSnapshot.status;
      latestRound.diff_fingerprint = diffSnapshot.fingerprint;
      latestRound.diff_summary = diffSnapshot.summary;

      const verificationSnapshot = captureVerificationSnapshot(latestRound);
      latestRound.test_results = verificationSnapshot.test_results;
      latestRound.verification_status = verificationSnapshot.verification_status;
      latestRound.verification_commands = verificationSnapshot.verification_commands;

      const outcome = evaluateAfterRound(run.spec, run.state, latestRound, {
        interrupted: active.interrupted,
        startupFailure: active.startup_failed,
      });
      latestRound.progress = outcome.progress;
      latestRound.open_items = outcome.open_items;
      latestRound.force_continue_reason = outcome.force_continue_reason;

      run.state.status = outcome.status;
      run.state.judgement = outcome.judgement;
      run.state.summary =
        latestRound.summary || `Round ${roundNumber} completed without a final summary message.`;
      run.state.diff_status = latestRound.diff_status;
      run.state.test_results = latestRound.test_results;
      run.state.stall_count = outcome.stall_count;
      run.state.last_error = outcome.last_error;
      run.state.active_round = null;
      run.state.active_worker_pid = null;
      await this.persistRun(run);

      await this.appendEvent(run, roundNumber, 'worker.exited', {
        code,
        signal,
        interrupted: active.interrupted,
        policy_violation: active.policy_violation,
      });
      await this.appendEvent(run, roundNumber, 'diff.snapshot', {
        status: diffSnapshot.status,
        fingerprint: diffSnapshot.fingerprint,
        summary: diffSnapshot.summary,
        error: diffSnapshot.error,
      });
      await this.appendEvent(run, roundNumber, 'tests.snapshot', {
        ...verificationSnapshot,
      });
      await this.appendEvent(run, roundNumber, 'judgement.updated', {
        ...buildQueryResponse(run.state),
        verification_status: latestRound.verification_status,
        open_items: latestRound.open_items,
        policy_warnings: latestRound.policy_warnings,
      });

      this.active_processes.delete(run.state.run_id);
      active.resolve_exit();
    });
  }

  private async handleStdoutLine(
    run: LoadedRun,
    active: ActiveProcess,
    roundNumber: number,
    line: string,
  ): Promise<void> {
    const parsed = parseJsonLine(line);
    if (!parsed || typeof parsed !== 'object') {
      active.non_json_stdout_lines += 1;
      await this.appendEvent(run, roundNumber, 'worker.stdout', { line });
      return;
    }

    const event = parsed as Record<string, unknown>;
    await this.appendEvent(run, roundNumber, 'worker.event', event);

    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      run.state.thread_id = event.thread_id;
      await this.persistRun(run);
      return;
    }

    const item = event.item as Record<string, unknown> | undefined;
    if (!item || typeof item !== 'object') {
      return;
    }

    if (item.type === 'agent_message' && typeof item.text === 'string') {
      active.last_message = item.text;
      return;
    }

    if (item.type !== 'command_execution' || typeof item.id !== 'string') {
      return;
    }

    const command = typeof item.command === 'string' ? item.command : '';
    const existing = active.command_records.get(item.id);
    const merged: CommandExecutionRecord = {
      id: item.id,
      command: command || existing?.command || '',
      extracted_commands: existing?.extracted_commands ?? [],
      status: item.status === 'completed' ? 'completed' : existing?.status ?? 'in_progress',
      exit_code: typeof item.exit_code === 'number' ? item.exit_code : existing?.exit_code ?? null,
      started_at: existing?.started_at ?? nowIso(),
      completed_at:
        item.status === 'completed' ? nowIso() : existing?.completed_at ?? null,
      output_excerpt:
        typeof item.aggregated_output === 'string' && item.aggregated_output.length > 0
          ? truncate(item.aggregated_output)
          : existing?.output_excerpt ?? '',
      is_test: existing?.is_test ?? false,
      is_verification: existing?.is_verification ?? false,
    };

    const annotated = annotateCommand(merged);
    active.command_records.set(item.id, annotated);

    if (this.policy_mode === 'off') {
      return;
    }

    const audit = auditCommandAgainstPolicy(annotated.command, run.spec.allowed_commands);
    annotated.extracted_commands = audit.extracted;
    active.command_records.set(item.id, annotated);

    if (audit.violating.length > 0) {
      const warning = `command(s) outside allowed_commands: ${audit.violating.join(', ')}`;
      const firstSeen = !active.policy_warnings.includes(warning);
      if (firstSeen) {
        active.policy_warnings.push(warning);
        await this.appendEvent(run, roundNumber, this.policy_mode === 'enforce' ? 'policy.violation' : 'policy.warning', {
          mode: this.policy_mode,
          command: annotated.command,
          extracted: audit.extracted,
          violating: audit.violating,
        });
      }

      if (this.policy_mode === 'enforce' && !active.policy_violation) {
        active.policy_violation = warning;
        run.state.status = 'blocked';
        run.state.judgement = 'blocked';
        run.state.last_error = `blocked_policy: ${active.policy_violation}`;
        run.state.summary = `Policy violation detected in round ${roundNumber}.`;
        await this.persistRun(run);
        active.child.kill('SIGTERM');
      }
    }
  }

  private async handleStderrLine(
    run: LoadedRun,
    active: ActiveProcess,
    roundNumber: number,
    line: string,
  ): Promise<void> {
    active.stderr_lines += 1;
    await this.appendEvent(run, roundNumber, 'worker.stderr', { line });
  }
}
