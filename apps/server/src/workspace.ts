import {
  mkdir,
  realpath,
  access,
  readdir,
  readFile,
  writeFile,
  appendFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { CheckDefinition, CheckResult, PlanRecord, TaskRecord } from '@ai-flow/shared';
import { git, runProcess, safeEnvironment } from './process';

/** Keep ignored local Codex guidance available without staging it as delivery code. */
export async function preserveProjectGuidance(
  repository: string,
  workspace: string,
): Promise<string[]> {
  const ignoredDirectories = new Set([
    '.git',
    '.ai-flow',
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.next',
    '.cache',
    '.venv',
    'vendor',
  ]);
  const files: string[] = [];
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(path.join(repository, relative), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const name = path.join(relative, entry.name);
      const portable = name.split(path.sep).join('/');
      const codexResource =
        /(?:^|\/)\.codex\/(?:config\.toml|rules\/.*\.rules|agents\/.*\.toml)$/.test(portable);
      const skillResource = /(?:^|\/)(?:\.agents|\.codex)\/skills\//.test(portable);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(name);
      } else if (
        entry.isFile() &&
        (/^AGENTS(?:\.override)?\.md$/.test(entry.name) || codexResource || skillResource)
      ) {
        if (files.length >= 1000) throw new Error('Too many project guidance files (limit 1000).');
        files.push(name);
      }
    }
  }
  await visit('');
  const exclusions: string[] = [];
  for (const relative of files) {
    const target = path.join(workspace, relative);
    try {
      await access(target);
      continue; // Tracked guidance already comes from the captured source commit.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(repository, relative)), { flag: 'wx' });
    exclusions.push(
      '/' +
        relative
          .split(path.sep)
          .join('/')
          .replace(/[\\*?\[\]#! ]/g, '\\$&'),
    );
  }
  if (exclusions.length) {
    const exclude = path.resolve(
      repository,
      await git(repository, ['rev-parse', '--git-path', 'info/exclude']),
    );
    await mkdir(path.dirname(exclude), { recursive: true });
    await appendFile(
      exclude,
      '\n# Local guidance copied into AI Flow worktrees\n' + exclusions.join('\n') + '\n',
    );
  }
  return files;
}

export function commitTitle(taskTitle: string, summary?: string, repair = false): string {
  const suggested = summary?.match(/^Commit title:\s*(.+)$/im)?.[1];
  const title = (suggested || taskTitle)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#+\s*/, '');
  if (suggested && title)
    return title
      .replace(/^[`"']+|[`"']+$/g, '')
      .slice(0, 72)
      .trim();
  if (/^[a-z]+(?:\([^)]+\))?!?:\s+\S/.test(title)) return title.slice(0, 72).trim();
  const prefix =
    repair || /^(fix|repair|resolve)\b/i.test(title)
      ? 'fix'
      : /^(document|docs)\b/i.test(title)
        ? 'docs'
        : /^(refactor)\b/i.test(title)
          ? 'refactor'
          : 'feat';
  const description = title ? title[0]!.toLowerCase() + title.slice(1) : 'update implementation';
  return `${prefix}: ${description}`.slice(0, 72).trim();
}

export async function validateRepository(repositoryPath: string): Promise<string> {
  const directory = await realpath(repositoryPath);
  const root = await git(directory, ['rev-parse', '--show-toplevel']);
  if ((await realpath(root)) !== directory) throw new Error(`Choose the repository root: ${root}`);
  await git(directory, ['rev-parse', '--verify', 'HEAD']);
  return directory;
}

export async function preparePlanWorkspace(
  plan: PlanRecord,
  dataDirectory: string,
  signal?: AbortSignal,
): Promise<void> {
  const expected = path.join(dataDirectory, 'worktrees', plan.id, 'integration');
  if (plan.workspacePath) {
    if (plan.workspacePath !== expected)
      throw new Error('Stored plan workspace does not match its managed directory.');
    await access(path.join(expected, '.git'));
    await preserveProjectGuidance(plan.config.repositoryPath, expected);
    return;
  }
  await mkdir(path.dirname(expected), { recursive: true });
  const base =
    plan.baseCommit ?? (await git(plan.config.repositoryPath, ['rev-parse', 'HEAD'], signal));
  const branch = `ai-flow/${plan.id}`;
  // Recover a worktree created just before a controller crash but not yet persisted.
  try {
    await access(path.join(expected, '.git'));
    if ((await git(expected, ['branch', '--show-current'], signal)) !== branch)
      throw new Error('Unexpected branch in managed workspace.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await git(
      plan.config.repositoryPath,
      ['worktree', 'add', '-b', branch, expected, base],
      signal,
    );
  }
  plan.workspacePath = expected;
  plan.branch = branch;
  plan.baseCommit = base;
  await preserveProjectGuidance(plan.config.repositoryPath, expected);
}

export async function prepareTaskWorkspace(
  plan: PlanRecord,
  task: TaskRecord,
  dataDirectory: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!plan.workspacePath) throw new Error('Plan workspace has not been prepared.');
  const expected = path.join(dataDirectory, 'worktrees', plan.id, 'tasks', task.id);
  await mkdir(path.dirname(expected), { recursive: true });
  if (task.workspacePath) {
    if (task.workspacePath !== expected)
      throw new Error('Stored task workspace does not match its managed directory.');
    await access(path.join(expected, '.git'));
    await preserveProjectGuidance(plan.config.repositoryPath, expected);
    return;
  }
  const base = await git(plan.workspacePath, ['rev-parse', 'HEAD'], signal);
  const branch = `ai-flow-tasks/${plan.id}/${task.id}`;
  try {
    await access(path.join(expected, '.git'));
    if ((await git(expected, ['branch', '--show-current'], signal)) !== branch)
      throw new Error('Unexpected branch in managed workspace.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await git(
      plan.config.repositoryPath,
      ['worktree', 'add', '-b', branch, expected, base],
      signal,
    );
  }
  task.baseCommit = base;
  task.workspacePath = expected;
  task.branch = branch;
  await preserveProjectGuidance(plan.config.repositoryPath, expected);
}

export async function checkpoint(
  cwd: string,
  message: string,
  signal?: AbortSignal,
): Promise<string> {
  await git(cwd, ['add', '--all'], signal);
  if (await git(cwd, ['status', '--porcelain'], signal)) {
    await git(
      cwd,
      [
        '-c',
        'user.name=AI Flow',
        '-c',
        'user.email=ai-flow@localhost',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        message,
      ],
      signal,
    );
  }
  return git(cwd, ['rev-parse', 'HEAD'], signal);
}

export async function assertCleanCommit(
  cwd: string,
  commit: string,
  signal?: AbortSignal,
): Promise<void> {
  const actual = await git(cwd, ['rev-parse', 'HEAD'], signal);
  if (actual !== commit || (await git(cwd, ['status', '--porcelain'], signal))) {
    throw new Error(
      'The workspace changed after its snapshot. Approval and checks must refer to the same clean commit.',
    );
  }
}

export async function integrateTask(
  plan: PlanRecord,
  task: TaskRecord,
  signal?: AbortSignal,
): Promise<void> {
  if (!plan.workspacePath || !task.approvedCommit || !task.baseCommit)
    throw new Error('Task has no approved snapshot to integrate.');
  const current = await git(plan.workspacePath, ['rev-parse', 'HEAD'], signal);
  if (task.integratedCommit) {
    if (task.integratedCommit !== task.approvedCommit)
      throw new Error('Stored integration does not match its approved commit.');
    await git(
      plan.workspacePath,
      ['merge-base', '--is-ancestor', task.integratedCommit, current],
      signal,
    );
    return;
  }
  if (current === task.approvedCommit) {
    task.integratedCommit = current;
    return;
  }
  await assertCleanCommit(plan.workspacePath, task.baseCommit, signal);
  await git(plan.workspacePath, ['merge', '--ff-only', task.approvedCommit], signal);
  task.integratedCommit = await git(plan.workspacePath, ['rev-parse', 'HEAD'], signal);
}

export async function runChecks(
  cwd: string,
  checks: CheckDefinition[],
  commit: string,
  signal: AbortSignal,
  onLog: (message: string) => void,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    onLog(`$ ${check.command}`);
    const startedAt = new Date().toISOString();
    const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
    const args =
      process.platform === 'win32' ? ['/d', '/s', '/c', check.command] : ['-c', check.command];
    const result = await runProcess(shell, args, {
      cwd,
      signal,
      timeoutMs: check.timeoutSeconds * 1000,
      env: { ...safeEnvironment(), CI: 'true', FORCE_COLOR: '0' },
      onOutput: onLog,
    });
    const output = [
      result.stdout,
      result.stderr,
      result.timedOut ? `Timed out after ${check.timeoutSeconds}s.` : '',
    ]
      .filter(Boolean)
      .join('\n');
    results.push({
      id: check.id,
      name: check.name,
      command: check.command,
      kind: check.kind,
      status: result.exitCode === 0 && !result.timedOut ? 'passed' : 'failed',
      exitCode: result.exitCode,
      output,
      durationMs: result.durationMs,
      commit,
      startedAt,
    });
    onLog(`${check.name}: ${results.at(-1)!.status} (${result.durationMs}ms)`);
  }
  await assertCleanCommit(cwd, commit, signal);
  return results;
}

export async function getDiff(
  cwd: string,
  baseCommit: string,
  candidateCommit: string,
): Promise<string> {
  return git(cwd, ['diff', '--no-ext-diff', '--stat', baseCommit, candidateCommit]);
}
