import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PlanRecord } from '@ai-flow/shared';
import { Store } from '../src/store';
import { FlowController } from '../src/orchestrator';
import { git } from '../src/process';
import { checkpoint, preparePlanWorkspace, prepareTaskWorkspace } from '../src/workspace';
import {
  assertCurrentBranchSnapshot,
  checkpointCurrentBranch,
  prepareCurrentBranch,
} from '../src/current-branch';
import { DemoRuntime, type AgentRuntime } from '../src/runtime';

describe('current-branch workflows', () => {
  let directory: string;
  let store: Store;
  let flow: FlowController;
  let plan: PlanRecord;
  let repository: string;
  const original = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') + '\n';

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'ai-flow-current-'));
    store = new Store(path.join(directory, 'controller'));
    flow = new FlowController(store, process.cwd());
    const fixture = await flow.createDemo();
    repository = fixture.config.repositoryPath;
    await writeFile(path.join(repository, 'shared.txt'), original);
    await checkpoint(repository, 'Add shared fixture');
    plan = await flow.createPlan({ projectId: fixture.projectId, useWorktree: false });
  });
  afterEach(async () => {
    await flow.shutdown();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('uses the existing folder and branch, separating workflow edits even within a partially staged file', async () => {
    const staged = original.replace('line 1\n', 'user staged\n');
    const baseline = staged.replace('line 20\n', 'user unstaged\n');
    await writeFile(path.join(repository, 'shared.txt'), staged);
    await git(repository, ['add', 'shared.txt']);
    await writeFile(path.join(repository, 'shared.txt'), baseline);
    await writeFile(path.join(repository, 'user notes.txt'), 'Keep untracked.\n');
    await preparePlanWorkspace(plan, plan.storageDirectory!);
    await prepareTaskWorkspace(plan, plan.tasks[0]!, plan.storageDirectory!);
    const before = plan.currentBranchSnapshot!.head;
    expect(plan.workspacePath).toBe(repository);
    expect(plan.tasks[0]!.workspacePath).toBe(repository);
    expect(plan.branch).toBe('main');
    await writeFile(
      path.join(repository, 'shared.txt'),
      baseline.replace('line 50\n', 'workflow edit\n'),
    );
    await writeFile(path.join(repository, 'new file.bin'), Buffer.from([0, 1, 200, 255]));
    const commit = await checkpointCurrentBranch(plan, 'feat: update shared behavior');
    expect(commit).not.toBe(before);
    expect(await git(repository, ['rev-parse', 'HEAD'])).toBe(commit);
    expect(await git(repository, ['show', 'HEAD:shared.txt'])).toBe(
      original.replace('line 50\n', 'workflow edit\n').trim(),
    );
    expect(await git(repository, ['show', ':shared.txt'])).toBe(
      staged.replace('line 50\n', 'workflow edit\n').trim(),
    );
    expect(await readFile(path.join(repository, 'shared.txt'), 'utf8')).toBe(
      baseline.replace('line 50\n', 'workflow edit\n'),
    );
    expect(await git(repository, ['ls-files', 'user notes.txt'])).toBe('');
    expect(await git(repository, ['diff', '--name-only', before, commit])).toBe(
      'new file.bin\nshared.txt',
    );
    await expect(assertCurrentBranchSnapshot(plan, commit)).resolves.toBeUndefined();
    expect(await checkpointCurrentBranch(plan, 'Nothing new')).toBe(commit);
    expect(
      (await git(repository, ['worktree', 'list', '--porcelain'])).match(/^worktree /gm),
    ).toHaveLength(1);
  });

  it('leaves files, index, and HEAD intact when workflow edits cannot be separated from existing edits', async () => {
    await writeFile(
      path.join(repository, 'shared.txt'),
      original.replace('line 20\n', 'user edit\n'),
    );
    await git(repository, ['add', 'shared.txt']);
    await prepareCurrentBranch(plan);
    const index = path.resolve(
      repository,
      await git(repository, ['rev-parse', '--git-path', 'index']),
    );
    const staged = await readFile(index);
    const head = plan.currentBranchSnapshot!.head;
    const changed = original.replace('line 20\n', 'agent edit\n');
    await writeFile(path.join(repository, 'shared.txt'), changed);
    await expect(checkpointCurrentBranch(plan, 'Overlapping edit')).rejects.toThrow(
      /overlap existing local changes/,
    );
    expect(await git(repository, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await readFile(index)).toEqual(staged);
    expect(await readFile(path.join(repository, 'shared.txt'), 'utf8')).toBe(changed);
  });

  it('recovers a checkpoint interrupted between updating HEAD and replacing the index', async () => {
    await prepareCurrentBranch(plan);
    const stored = structuredClone(plan);
    const index = path.resolve(
      repository,
      await git(repository, ['rev-parse', '--git-path', 'index']),
    );
    const originalIndex = await readFile(index);
    await writeFile(path.join(repository, 'new.txt'), 'Workflow change.\n');
    const commit = await checkpointCurrentBranch(plan, 'feat: new file');
    // Recreate the on-disk state at the ref/index boundary; the lock inode is
    // the same inode recorded in the durable journal.
    await rename(index, `${index}.lock`);
    await writeFile(index, originalIndex);
    await prepareCurrentBranch(stored);
    expect(stored.currentBranchSnapshot).toEqual(plan.currentBranchSnapshot);
    expect(await git(repository, ['show', ':new.txt'])).toBe('Workflow change.');
    await expect(assertCurrentBranchSnapshot(stored, commit)).resolves.toBeUndefined();
    // Recovery can repeat before the new snapshot is saved to SQLite.
    await prepareCurrentBranch(stored);
  });

  it('detects changed files, changed branches, and detached HEAD without creating worktrees', async () => {
    await prepareCurrentBranch(plan);
    const snapshot = plan.currentBranchSnapshot!;
    await writeFile(path.join(repository, 'unrelated.txt'), 'Changed after checks.\n');
    await expect(assertCurrentBranchSnapshot(plan, snapshot.head)).rejects.toThrow(
      /changed after its snapshot/,
    );
    await git(repository, ['checkout', '-b', 'another-branch']);
    await expect(prepareCurrentBranch(plan)).rejects.toThrow(/branch/);
    await git(repository, ['checkout', '--detach']);
    const fresh = { ...plan, workspacePath: undefined, currentBranchSnapshot: undefined };
    await expect(prepareCurrentBranch(fresh)).rejects.toThrow(/checked-out branch/);
  });

  it('runs dependent tasks on the current branch and resumes partial implementation across controller restart', async () => {
    const demo = new DemoRuntime();
    let pauseOnce = true;
    const runtime: AgentRuntime = {
      inspect: () => demo.inspect(),
      run: async (request) => {
        expect(request.cwd).toBe(repository);
        expect(request.prompt).toContain('without worktrees');
        if (pauseOnce && request.role === 'implementer') {
          pauseOnce = false;
          await writeFile(path.join(request.cwd, 'partial.txt'), 'In-progress workflow work.\n');
          flow.stop(plan.id, 'pause');
          return { text: 'Interrupted after partial work.' };
        }
        return demo.run(request);
      },
    };
    flow = new FlowController(store, process.cwd(), { runtimeFactory: () => runtime });
    await writeFile(path.join(repository, 'user notes.txt'), 'Keep this local.\n');
    flow.start(plan.id);
    await flow.waitForIdle();
    expect(flow.requirePlan(plan.id).status).toBe('paused');
    flow = new FlowController(store, process.cwd(), { runtimeFactory: () => runtime });
    flow.start(plan.id);
    await flow.waitForIdle();
    const result = flow.requirePlan(plan.id);
    expect(result.status, result.error).toBe('completed');
    expect(result.config.useWorktree).toBe(false);
    expect(result.workspacePath).toBe(repository);
    expect(
      result.tasks.every(
        (task) =>
          task.workspacePath === repository && task.integratedCommit === task.approvedCommit,
      ),
    ).toBe(true);
    expect(result.tasks[1]!.baseCommit).toBe(result.tasks[0]!.approvedCommit);
    expect(await git(repository, ['rev-parse', 'HEAD'])).toBe(result.finalCommit);
    expect(await git(repository, ['show', 'HEAD:partial.txt'])).toBe('In-progress workflow work.');
    expect(await git(repository, ['ls-files', 'user notes.txt'])).toBe('');
    expect(
      result.integrationChecks.every(
        (check) => check.workspaceTree === result.currentBranchSnapshot!.tree,
      ),
    ).toBe(true);
    expect(result.finalReview?.reviewedCommit).toBe(result.finalCommit);
    expect(result.finalReview?.reviewedWorkspaceTree).toBe(result.currentBranchSnapshot!.tree);
  });
});
