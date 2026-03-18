import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BridgeDaemon } from './daemon.js';
import { runSmoke } from './smoke.js';
import type { PolicyMode } from './types.js';

function parseOption(name: string, defaultValue: string): string {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return defaultValue;
}

function parsePolicyMode(rawValue: string): PolicyMode {
  if (rawValue === 'off' || rawValue === 'warn' || rawValue === 'enforce') {
    return rawValue;
  }
  throw new Error(`invalid policy mode: ${rawValue}`);
}

async function main(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const projectRoot = resolve(dirname(__filename), '..');
  const command = process.argv[2] ?? 'daemon';
  const host = parseOption('host', '127.0.0.1');
  const port = Number.parseInt(parseOption('port', '4545'), 10);
  const policyMode = parsePolicyMode(parseOption('policy-mode', process.env.BRIDGE_POLICY_MODE ?? 'warn'));

  if (command === 'daemon') {
    const daemon = new BridgeDaemon({ root_dir: projectRoot, host, port, policy_mode: policyMode });
    await daemon.init();
    await daemon.listen();
    process.stdout.write(`bridge daemon listening on http://${host}:${port} (policy_mode=${policyMode})\n`);

    const shutdown = async () => {
      await daemon.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  if (command === 'smoke') {
    await runSmoke(projectRoot, port);
    process.stdout.write('smoke passed\n');
    return;
  }

  process.stderr.write(`unknown command: ${command}\n`);
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
