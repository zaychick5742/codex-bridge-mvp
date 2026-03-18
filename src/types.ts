export type BridgeStatus = 'running' | 'waiting' | 'needs_guidance' | 'blocked' | 'done';
export type PolicyMode = 'off' | 'warn' | 'enforce';

export type BridgeJudgement =
  | 'working'
  | 'acceptance_partial'
  | 'ready_to_finalize'
  | 'needs_guidance'
  | 'blocked'
  | 'finalized';

export type DiffStatus = 'clean' | 'changed' | 'no_repo' | 'error';

export type TestResults = 'passed' | 'failed' | 'not_run' | 'error';

export type VerificationStatus = 'passed' | 'failed' | 'not_run' | 'error';

export interface StartRequest {
  task_prompt: string;
  cwd: string;
  acceptance: string[];
  allowed_commands: string[];
  stop_conditions: string[];
}

export interface QueryRequest {
  run_id: string;
}

export interface QueryResponse {
  status: BridgeStatus;
  judgement: BridgeJudgement;
  summary: string;
  diff_status: DiffStatus;
  test_results: TestResults;
  round: number;
  stall_count: number;
  last_error: string | null;
}

export interface CommandExecutionRecord {
  id: string;
  command: string;
  extracted_commands: string[];
  status: 'in_progress' | 'completed';
  exit_code: number | null;
  started_at: string;
  completed_at: string | null;
  output_excerpt: string;
  is_test: boolean;
  is_verification: boolean;
}

export interface RoundRecord {
  round: number;
  prompt: string;
  started_at: string;
  ended_at: string | null;
  worker_exit_code: number | null;
  worker_signal: NodeJS.Signals | null;
  summary: string;
  last_message: string;
  guidance_detected: boolean;
  diff_status: DiffStatus;
  diff_fingerprint: string | null;
  diff_summary: string | null;
  test_results: TestResults;
  verification_status: VerificationStatus;
  verification_commands: string[];
  commands: CommandExecutionRecord[];
  stderr_lines: number;
  non_json_stdout_lines: number;
  progress: boolean;
  open_items: string[];
  policy_violation: string | null;
  policy_warnings: string[];
  force_continue_reason: string | null;
}

export interface RunState {
  run_id: string;
  created_at: string;
  updated_at: string;
  status: BridgeStatus;
  judgement: BridgeJudgement;
  summary: string;
  diff_status: DiffStatus;
  test_results: TestResults;
  round: number;
  stall_count: number;
  last_error: string | null;
  policy_mode: PolicyMode;
  hard_denied_commands: string[];
  finalized: boolean;
  finalized_at: string | null;
  thread_id: string | null;
  active_round: number | null;
  active_worker_pid: number | null;
  rounds: RoundRecord[];
}

export interface NormalizedEvent {
  ts: string;
  run_id: string;
  round: number | null;
  type: string;
  payload: Record<string, unknown>;
}

export interface DiffSnapshot {
  status: DiffStatus;
  fingerprint: string | null;
  summary: string | null;
  error: string | null;
}

export interface VerificationSnapshot {
  test_results: TestResults;
  verification_status: VerificationStatus;
  verification_commands: string[];
}

export interface EvaluatedOutcome {
  status: BridgeStatus;
  judgement: BridgeJudgement;
  stall_count: number;
  last_error: string | null;
  open_items: string[];
  progress: boolean;
  force_continue_reason: string | null;
}

export interface LoadedRun {
  dir: string;
  spec: StartRequest;
  state: RunState;
}
