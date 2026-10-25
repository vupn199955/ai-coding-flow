import { spawn } from 'node:child_process';

export class InterruptedError extends Error {
  constructor(message = 'Execution interrupted.') {
    super(message);
    this.name = 'InterruptedError';
  }
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export function safeEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      /^(OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|ACCESS_TOKEN|AWS_|GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|CI_JOB_TOKEN)/i.test(
        key,
      )
    )
      delete environment[key];
  }
  return environment;
}

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
    onOutput?: (chunk: string) => void;
  },
): Promise<ProcessResult> {
  if (options.signal?.aborted) return Promise.reject(new InterruptedError());
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let interrupted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? safeEnvironment(),
      shell: options.shell ?? false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Process already exited. */
      }
    };
    const stop = () => {
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    const onAbort = () => {
      interrupted = true;
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? 60_000);
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const append = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const value = chunk.toString('utf8');
      if (stream === 'stdout') stdout = (stdout + value).slice(-256_000);
      else stderr = (stderr + value).slice(-256_000);
      options.onOutput?.(value.slice(0, 16_000));
    };
    child.stdout.on('data', (chunk) => append(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => append(chunk, 'stderr'));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (interrupted) reject(new InterruptedError());
      else resolve({ stdout, stderr, exitCode, durationMs: Date.now() - started, timedOut });
    });
    if (options.signal?.aborted) onAbort();
  });
}

export async function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await runProcess('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    signal,
    timeoutMs: 60_000,
    ...(environment ? { env: { ...safeEnvironment(), ...environment } } : {}),
  });
  if (result.exitCode !== 0)
    throw new Error(`Git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}
