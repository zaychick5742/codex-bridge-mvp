# Installation

This project is intended for local development on a machine that can already run `codex exec`.

## Prerequisites

You need:

- Node.js 20+ and `npm`
- A working `codex` CLI on your `PATH`
- A local environment where `codex exec --json` can authenticate successfully

Quick checks:

```bash
node -v
npm -v
codex --help
codex exec --json --help
```

If `codex exec --json` fails because of auth, API key, quota, or usage limits, the bridge will surface that failure, but it will not fix it for you.

## Clone And Install

```bash
git clone https://github.com/zaychick5742/codex-bridge-mvp.git
cd codex-bridge-mvp
npm install
npm run build
```

## Start The Daemon

Default:

```bash
npm run daemon
```

With explicit host, port, and full-access mode:

```bash
node dist/cli.js daemon --host 127.0.0.1 --port 4545 --policy-mode off
```

With full-access mode but `rm` hard-blocked:

```bash
node dist/cli.js daemon --host 127.0.0.1 --port 4545 --policy-mode off --deny-commands rm
```

## Verify The Daemon

In another terminal:

```bash
curl -sS http://127.0.0.1:4545/health
```

Expected response:

```json
{
  "ok": true
}
```

## Optional Validation

Run unit tests:

```bash
npm run unit
```

Run the end-to-end smoke test:

```bash
npm run smoke
```

The smoke test starts a separate daemon, runs a toy repo task, and verifies the `start/query/continue/interrupt/finalize` flow.
