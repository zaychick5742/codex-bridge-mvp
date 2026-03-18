import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCallback);

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function writeText(filePath: string, value: string): Promise<void> {
  await ensureDir(dirname(filePath));
  await fs.writeFile(filePath, value, 'utf8');
}

export async function appendText(filePath: string, value: string): Promise<void> {
  await ensureDir(dirname(filePath));
  await fs.appendFile(filePath, value, 'utf8');
}

export async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await appendText(filePath, `${JSON.stringify(value)}\n`);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

export function truncate(value: string, limit = 2000): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n...[truncated]`;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function runExecFile(
  cwd: string,
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(file, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      code: 0,
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? execError.message,
      code: typeof execError.code === 'number' ? execError.code : 1,
    };
  }
}

export function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function parseJsonLine(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
