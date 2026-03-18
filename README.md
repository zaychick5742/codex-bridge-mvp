# Codex Bridge MVP

`codex-bridge-mvp` is a local bridge daemon that lets an `openclaw`-style supervisor drive round-based `codex exec --json` workers through a structured control plane.

The bridge owns worker lifecycle, event normalization, run state, diff and test snapshots, and supervisor-facing control actions. The supervisor reads structured state only. It does not read terminal screen contents, inject into a shared TTY, or depend on AppleScript.

## MVP Scope

- Single local daemon on `localhost`
- Single active worker at a time
- Round-based execution only
- Worker entrypoint fixed to `codex exec --json --full-auto --cd <cwd> <prompt>`
- `continue` launches a fresh round with a synthesized continuation prompt
- `resume` and `fork` are explicitly out of scope for this MVP

## Quick Start

```bash
npm install
npm run build
npm run daemon
```

The foreground daemon listens on `http://127.0.0.1:4545` by default.

Policy mode is daemon-level and defaults to `warn`.

```bash
npm run daemon -- --policy-mode warn
npm run daemon -- --policy-mode off
npm run daemon -- --policy-mode enforce
```

- `off`: full-access worker execution, no `allowed_commands` enforcement, logs still flow normally
- `warn`: audit `allowed_commands` but never kill the worker mid-round
- `enforce`: block immediately on out-of-policy commands

## Control Plane

Example `start` call:

```bash
curl -sS http://127.0.0.1:4545/start \
  -H 'content-type: application/json' \
  -d '{
    "task_prompt": "Fix the bug and run tests.",
    "cwd": "/path/to/repo",
    "acceptance": ["Tests pass"],
    "allowed_commands": ["git", "npm", "node", "rg", "ls", "cat", "sed"],
    "stop_conditions": []
  }'
```

Supported endpoints:

- `POST /start`
  Input: `task_prompt`, `cwd`, `acceptance[]`, `allowed_commands[]`, `stop_conditions[]`
- `GET /query?run_id=<id>` or `POST /query`
  Output: `status`, `judgement`, `summary`, `diff_status`, `test_results`, `round`, `stall_count`, `last_error`
- `POST /continue`
  Input: `run_id`
- `POST /interrupt`
  Input: `run_id`
- `POST /finalize`
  Input: `run_id`

Bridge statuses:

- `running`
- `waiting`
- `needs_guidance`
- `blocked`
- `done`

Bridge judgements:

- `working`
- `acceptance_partial`
- `ready_to_finalize`
- `needs_guidance`
- `blocked`
- `finalized`

## Runtime State

Each run persists to `.bridge-state/<run_id>/`:

- `spec.json`
- `state.json`
- `events.jsonl`
- `stdout.log`
- `stderr.log`
- `final.json`
- `pid`

`stdout` and `stderr` are captured separately. JSON lines from `stdout` become normalized worker events. Non-JSON `stdout` and all `stderr` lines are recorded as diagnostics without breaking event parsing.

## Worker Contract

- The worker edits the repository directly.
- The worker should not create commits, amend commits, or switch branches.
- `allowed_commands[]` is treated as a task contract in the prompt and audited after the fact from command events.
- In `warn` mode, policy mismatches are recorded but do not block the run.
- In `enforce` mode, policy violations immediately block the run.

## Validation

Run the end-to-end smoke test:

```bash
npm run smoke
```

The smoke test starts the daemon, runs a toy repo task through `start/query/continue/interrupt/finalize`, verifies mixed JSON and diagnostic capture, checks automatic continuation, and confirms interrupt handling.
