import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDemoProject } from '../src/runtime';
import { assertCleanCommit, checkpoint, runChecks, validateRepository } from '../src/workspace';
import { git, InterruptedError, runProcess } from '../src/process';

describe('independent checks and commit integrity', () => {
  let directory: string;
  let repository: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'ai-flow-workspace-'));
    repository = (await createDemoProject(directory)).repositoryPath;
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('rejects dirty source repositories and changed snapshots', async () => {
    expect(await validateRepository(repository)).toBe(await realpath(repository));
    const commit = await git(repository, ['rev-parse', 'HEAD']);
    await writeFile(path.join(repository, 'new.js'), 'export const value = 1;\n');
    await expect(validateRepository(repository)).rejects.toThrow(/uncommitted/);
    await expect(assertCleanCommit(repository, commit)).rejects.toThrow(/changed/);
    const next = await checkpoint(repository, 'Add new value');
    expect(next).not.toBe(commit);
    await expect(assertCleanCommit(repository, next)).resolves.toBeUndefined();
  });

  it('records actual command exit codes and binds checks to their commit', async () => {
    const commit = await git(repository, ['rev-parse', 'HEAD']);
    const logs: string[] = [];
    const results = await runChecks(
      repository,
      [
        {
          id: 'pass',
          name: 'Pass',
          command: 'node -e "console.log(42)"',
          kind: 'unit',
          timeoutSeconds: 5,
        },
        {
          id: 'fail',
          name: 'Fail',
          command: 'node -e "process.exit(3)"',
          kind: 'custom',
          timeoutSeconds: 5,
        },
      ],
      commit,
      new AbortController().signal,
      (message) => logs.push(message),
    );
    expect(results.map((result) => result.status)).toEqual(['passed', 'failed']);
    expect(results.map((result) => result.exitCode)).toEqual([0, 3]);
    expect(results.every((result) => result.commit === commit)).toBe(true);
    expect(results[0]?.output).toContain('42');
    expect(logs.length).toBeGreaterThan(2);
  });

  it('detects commands that mutate tracked source after validation', async () => {
    const commit = await git(repository, ['rev-parse', 'HEAD']);
    await expect(
      runChecks(
        repository,
        [
          {
            id: 'mutate',
            name: 'Mutate',
            command: "node -e \"require('fs').writeFileSync('README.md', 'changed')\"",
            kind: 'unit',
            timeoutSeconds: 5,
          },
        ],
        commit,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow(/changed/);
  });

  it('times out long commands and interrupts active process trees', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: repository,
      timeoutMs: 60,
    });
    expect(result.timedOut).toBe(true);
    const abort = new AbortController();
    const running = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: repository,
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 60);
    await expect(running).rejects.toBeInstanceOf(InterruptedError);
  });
});
