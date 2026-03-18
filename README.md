# Codex Bridge MVP

`codex-bridge-mvp` is a local bridge daemon for running `codex exec --json` behind a small, structured control plane.

It is designed for a supervisor such as `openclaw` to:

- start a worker round
- query structured state instead of scraping a terminal
- continue with a fresh prompt in the next round
- interrupt or finalize explicitly

The bridge owns worker lifecycle, event normalization, run state, diff snapshots, verification snapshots, and supervisor-facing status transitions. The supervisor does not need AppleScript, TTY injection, or screen reading.

## Docs

- [Installation](./INSTALL.md)
- [Configuration](./CONFIGURATION.md)
- [Publishing](./PUBLISHING.md)

## What This Project Is

- A local daemon on `localhost`
- A round-based wrapper around `codex exec --json --full-auto --cd <cwd> <prompt>`
- A state store under `.bridge-state/<run_id>/`
- A control plane with `start`, `query`, `continue`, `interrupt`, and `finalize`
- A thin orchestration layer, not a replacement for the worker itself

## What This Project Is Not

- Not a sandbox
- Not a security boundary
- Not multi-tenant
- Not a remote service with auth, TLS, or isolation
- Not a long-lived shared Codex session manager
- Not a terminal watcher

## Important Safety Note

This project can run Codex in a mode that has effectively full shell access to the target repository.

If you use `policy_mode=off`, the bridge will not enforce `allowed_commands[]`. In that mode the worker may:

- read and edit files in the target repository
- run build, test, and helper commands
- invoke additional shell tools that are not listed in `allowed_commands[]`

That is intentional for trusted local development, but it means:

- only use this against repositories you trust
- do not treat the bridge as a sandbox
- do not point it at sensitive directories unless you accept that the worker can operate there
- do not expose this daemon beyond `localhost`

## MVP Scope

- Single local daemon on `localhost`
- Single active worker at a time
- Round-based execution only
- `continue` launches a fresh `codex exec`
- `resume` and `fork` are intentionally out of scope for this MVP

## Quick Start

```bash
npm install
npm run build
npm run daemon
```

The foreground daemon listens on `http://127.0.0.1:4545` by default.

## Policy Modes

Policy mode is daemon-level and defaults to `warn`.

```bash
npm run daemon -- --policy-mode warn
npm run daemon -- --policy-mode off
npm run daemon -- --policy-mode enforce
```

- `off`
  Full-access mode. The bridge does not enforce `allowed_commands[]`. The list is still accepted from the supervisor and preserved in run metadata, but it is advisory only.
- `warn`
  The bridge audits commands against `allowed_commands[]` and records warnings, but it does not kill the worker mid-round.
- `enforce`
  The bridge treats `allowed_commands[]` as a hard policy and blocks the round on out-of-policy commands.

## Full-Access Mode

If you want CLI Codex to behave like a real local coding worker, use:

```bash
npm run daemon -- --policy-mode off
```

In `off` mode:

- Bridge-side command enforcement is disabled
- The worker prompt explicitly treats `allowed_commands[]` as advisory instead of mandatory
- You still get structured events, state snapshots, interrupt/finalize controls, and diff/test summaries

This is the recommended mode for trusted local development when you want Codex to actually write code and run the commands it needs.

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

## Status Model

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

Typical meaning:

- `running`
  The worker process is still active, or the bridge is finishing round analysis.
- `waiting`
  The round ended normally, but the bridge does not think the task is fully closed yet.
- `needs_guidance`
  The worker asked a concrete question, or the bridge detected repeated lack of progress.
- `blocked`
  The run hit a hard stop such as policy enforcement, manual interrupt, startup failure, or non-zero worker exit.
- `done`
  The bridge believes the work is complete and ready for `finalize`.

## Runtime State

Each run persists to `.bridge-state/<run_id>/`:

- `spec.json`
- `state.json`
- `events.jsonl`
- `stdout.log`
- `stderr.log`
- `final.json`
- `pid`

`stdout` and `stderr` are captured separately:

- JSON lines from `stdout` become normalized `worker.event` records
- non-JSON `stdout` becomes diagnostic `worker.stdout`
- `stderr` becomes diagnostic `worker.stderr`

This separation means mixed output does not break the event stream.

## Worker Contract

- The worker edits the target repository directly
- The worker should not create commits, amend commits, or switch branches
- The worker should stay inside the target repository and not depend on external bootstrap/session files
- `allowed_commands[]` is always included in the task contract, but its enforcement depends on daemon `policy_mode`

## Validation

Run the end-to-end smoke test:

```bash
npm run smoke
```

Run unit tests:

```bash
npm run unit
```

The smoke test starts the daemon, runs a toy repo task through `start/query/continue/interrupt/finalize`, verifies mixed JSON and diagnostic capture, checks automatic continuation, and confirms interrupt handling.

## Known Limitations

- Single active worker only
- Local-only daemon with no built-in authentication
- Round-based execution only; no long-lived shared worker session
- Completion is still heuristic and depends on worker summaries plus diff/test signals
- Upstream Codex failures such as auth issues, invalid API keys, quota exhaustion, or usage limits are surfaced by the bridge, but they are not fixed by the bridge

## Recommended Use

Use this project when you want:

- structured state around `codex exec --json`
- supervisor control over start/query/continue/interrupt/finalize
- local runs without scraping terminals
- an explicit choice between audited mode and full-access mode

Use `policy_mode=off` only when the repository and environment are trusted.
