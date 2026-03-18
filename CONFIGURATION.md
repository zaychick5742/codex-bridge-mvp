# Configuration

This project has a small configuration surface. Most behavior is controlled by daemon startup flags and the `start` request payload.

## Daemon Flags

Start the daemon with:

```bash
node dist/cli.js daemon --host 127.0.0.1 --port 4545 --policy-mode warn
```

Available flags:

- `--host`
  Bind address. Default: `127.0.0.1`
- `--port`
  Listen port. Default: `4545`
- `--policy-mode`
  One of `off`, `warn`, `enforce`
- `--deny-commands`
  Comma-separated command basenames that are always blocked, even in `off`

You can also set:

```bash
BRIDGE_POLICY_MODE=off
BRIDGE_DENY_COMMANDS=rm
```

and then run:

```bash
npm run daemon
```

## Policy Modes

- `off`
  Full-access mode. The bridge does not enforce `allowed_commands[]`. Use this for trusted local coding workflows.
- `warn`
  The bridge records out-of-policy commands as warnings but does not terminate the round.
- `enforce`
  The bridge treats `allowed_commands[]` as a hard policy and blocks on violations.

## Hard-Denied Commands

Use `--deny-commands` when you want one or more commands to stay forbidden across every policy mode.

Example:

```bash
node dist/cli.js daemon --host 127.0.0.1 --port 4545 --policy-mode off --deny-commands rm
```

Or with environment variables:

```bash
BRIDGE_POLICY_MODE=off
BRIDGE_DENY_COMMANDS=rm
npm run daemon
```

Current behavior:

- Hard-denied commands are blocked in `off`, `warn`, and `enforce`
- The worker prompt is told not to use them
- The bridge also prepends wrapper binaries to `PATH` for those basenames

This is still not a sandbox. Blocking `rm` does not stop deletion through other tools such as Python, Node.js, Git, or custom scripts.

## Security And Safety Warning

`policy_mode=off` is not a sandboxed mode.

In that mode the worker may run commands that:

- delete files or directories
- overwrite source code
- rewrite local databases or generated assets
- leave a repository half-modified if the run fails

That means:

- do not use `off` mode against sensitive directories
- do not use it on machines or paths you would not trust with a full local coding agent
- do not assume the bridge will prevent dangerous shell behavior

If you want a safer starting point, use `warn` or `enforce`.

## Start Payload

`POST /start` expects:

```json
{
  "task_prompt": "Fix the bug and run tests.",
  "cwd": "/absolute/path/to/repo",
  "acceptance": ["Tests pass"],
  "allowed_commands": ["git", "npm", "node"],
  "stop_conditions": []
}
```

Field meaning:

- `task_prompt`
  The actual worker task
- `cwd`
  Absolute path to the target repository
- `acceptance`
  Human-readable completion targets
- `allowed_commands`
  Advisory or enforced command list depending on `policy_mode`
- `stop_conditions`
  Extra supervisor constraints, such as “pause after round 1”

## State Directory

The daemon stores run state under:

```text
.bridge-state/<run_id>/
```

Each run contains:

- `spec.json`
- `state.json`
- `events.jsonl`
- `stdout.log`
- `stderr.log`
- `final.json`
- `pid`

## Recommended Local Setup

For trusted local development:

```bash
node dist/cli.js daemon --host 127.0.0.1 --port 4545 --policy-mode off
```

For full access with `rm` blocked:

```bash
node dist/cli.js daemon --host 127.0.0.1 --port 4545 --policy-mode off --deny-commands rm
```

For audit without interruption:

```bash
node dist/cli.js daemon --host 127.0.0.1 --port 4545 --policy-mode warn
```

For strict policy experiments:

```bash
node dist/cli.js daemon --host 127.0.0.1 --port 4545 --policy-mode enforce
```

## Troubleshooting

- If a run ends with `worker_exit_1`, check `stderr.log` and `events.jsonl` for upstream auth, quota, or API errors.
- If `/health` fails, make sure the daemon is running and the selected port is free.
- If the worker appears too restricted, make sure you are not accidentally running in `enforce` mode.
- If you expected `rm` to work and it does not, check whether `--deny-commands` or `BRIDGE_DENY_COMMANDS` is set.
