import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PlanRecord } from '@ai-flow/shared';
import { git } from './process';

type Snapshot = NonNullable<PlanRecord['currentBranchSnapshot']>;
interface CheckpointJournal {
  previousHead: string;
  next: Snapshot;
  indexLock: { dev: number; ino: number };
}

const identity = [
  '-c',
  'user.name=AI Flow',
  '-c',
  'user.email=ai-flow@localhost',
  '-c',
  'commit.gpgsign=false',
];
const journalPath = (plan: PlanRecord) => path.join(plan.artifactsPath!, 'branch-checkpoint.json');

async function temporaryIndex<T>(
  run: (directory: string, index: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-flow-index-'));
  try {
    return await run(directory, path.join(directory, 'index'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Hash the live files without staging anything in the user's index. */
export async function workingTreeSnapshot(
  repository: string,
  signal?: AbortSignal,
): Promise<string> {
  return temporaryIndex(async (_, index) => {
    const environment = { GIT_INDEX_FILE: index };
    await git(repository, ['read-tree', 'HEAD'], signal, environment);
    await git(repository, ['add', '--all'], signal, environment);
    return git(repository, ['write-tree'], signal, environment);
  });
}

async function pinSnapshot(
  plan: PlanRecord,
  snapshot: Snapshot,
  signal?: AbortSignal,
): Promise<void> {
  const repository = plan.config.repositoryPath;
  const ref = `refs/ai-flow-snapshots/${plan.id}`;
  const previous = await git(repository, ['rev-parse', '--verify', ref], signal).catch(
    () => snapshot.head,
  );
  const commit = await git(
    repository,
    [
      ...identity,
      'commit-tree',
      snapshot.tree,
      '-p',
      previous,
      '-m',
      'AI Flow working-directory snapshot',
    ],
    signal,
  );
  await git(repository, ['update-ref', ref, commit], signal);
}

export async function assertCurrentBranch(plan: PlanRecord, signal?: AbortSignal): Promise<void> {
  const repository = plan.config.repositoryPath;
  const branch = await git(repository, ['branch', '--show-current'], signal);
  const head = await git(repository, ['rev-parse', 'HEAD'], signal);
  if (branch !== plan.branch || head !== plan.currentBranchSnapshot?.head)
    throw new Error(
      'The current branch or HEAD changed outside this workflow. Return to its recorded branch and commit before resuming.',
    );
}

async function recoverCheckpoint(plan: PlanRecord, signal?: AbortSignal): Promise<void> {
  const pending = await readFile(journalPath(plan), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    },
  );
  if (!pending) return;
  const journal = JSON.parse(pending) as CheckpointJournal;
  const repository = plan.config.repositoryPath;
  if ((await git(repository, ['branch', '--show-current'], signal)) !== plan.branch)
    throw new Error('Return to the workflow’s recorded branch before resuming.');
  const head = await git(repository, ['rev-parse', 'HEAD'], signal);
  const index = path.resolve(
    repository,
    await git(repository, ['rev-parse', '--git-path', 'index'], signal),
  );
  const lock = await stat(`${index}.lock`).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const ownsLock = lock && lock.dev === journal.indexLock.dev && lock.ino === journal.indexLock.ino;
  if (head === journal.next.head) {
    if (ownsLock) await rename(`${index}.lock`, index);
    plan.currentBranchSnapshot = journal.next;
  } else if (head === journal.previousHead) {
    if (ownsLock) await rm(`${index}.lock`);
  }
  // Keep the journal until the next checkpoint so recovery is itself repeatable
  // even if the controller exits before persisting the recovered plan.
}

export async function prepareCurrentBranch(plan: PlanRecord, signal?: AbortSignal): Promise<void> {
  const repository = plan.config.repositoryPath;
  if (plan.workspacePath && plan.workspacePath !== repository)
    throw new Error('Stored current-branch workspace does not match the project repository.');
  if (plan.currentBranchSnapshot) {
    await recoverCheckpoint(plan, signal);
    await assertCurrentBranch(plan, signal);
    return;
  }
  const branch = await git(repository, ['branch', '--show-current'], signal);
  if (!branch)
    throw new Error(
      'Current-branch mode needs a checked-out branch. Check out a branch before starting.',
    );
  const snapshot = {
    head: await git(repository, ['rev-parse', 'HEAD'], signal),
    tree: await workingTreeSnapshot(repository, signal),
  };
  await pinSnapshot(plan, snapshot, signal);
  plan.branch = branch;
  plan.workspacePath = repository;
  plan.baseCommit = snapshot.head;
  plan.currentBranchSnapshot = snapshot;
  await assertCurrentBranch(plan, signal);
}

export async function assertCurrentBranchSnapshot(
  plan: PlanRecord,
  commit: string,
  signal?: AbortSignal,
): Promise<void> {
  await assertCurrentBranch(plan, signal);
  if (
    plan.currentBranchSnapshot!.head !== commit ||
    (await workingTreeSnapshot(plan.config.repositoryPath, signal)) !==
      plan.currentBranchSnapshot!.tree
  )
    throw new Error(
      'The workspace changed after its snapshot. Run checks and review again for the current files.',
    );
}

/** Apply only the delta since the last durable baseline, preserving user staging. */
export async function checkpointCurrentBranch(
  plan: PlanRecord,
  message: string,
  signal?: AbortSignal,
): Promise<string> {
  await assertCurrentBranch(plan, signal);
  const repository = plan.config.repositoryPath;
  const previous = plan.currentBranchSnapshot!;
  const tree = await workingTreeSnapshot(repository, signal);
  if (tree === previous.tree) return previous.head;
  return temporaryIndex(async (directory, candidateIndex) => {
    const patch = path.join(directory, 'changes.patch');
    await git(
      repository,
      [
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-textconv',
        `--output=${patch}`,
        previous.tree,
        tree,
      ],
      signal,
    );
    const index = path.resolve(
      repository,
      await git(repository, ['rev-parse', '--git-path', 'index'], signal),
    );
    const indexLock = await open(`${index}.lock`, 'wx');
    let journalWritten = false;
    let committed = false;
    try {
      const stagedIndex = path.join(directory, 'staged-index');
      await copyFile(index, stagedIndex);
      const environment = { GIT_INDEX_FILE: candidateIndex };
      await git(repository, ['read-tree', previous.head], signal, environment);
      try {
        await git(
          repository,
          ['apply', '--cached', '--3way', '--whitespace=nowarn', patch],
          signal,
          environment,
        );
        await git(
          repository,
          ['apply', '--cached', '--3way', '--whitespace=nowarn', patch],
          signal,
          { GIT_INDEX_FILE: stagedIndex },
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(
          'Workflow edits overlap existing local changes and cannot be committed separately. Your files and staging are preserved. Separate the overlapping edits before resuming.',
        );
      }
      const commitTree = await git(repository, ['write-tree'], signal, environment);
      const commit = await git(
        repository,
        [...identity, 'commit-tree', commitTree, '-p', previous.head, '-m', message],
        signal,
      );
      const next = { head: commit, tree };
      await pinSnapshot(plan, next, signal);
      await indexLock.writeFile(await readFile(stagedIndex));
      const lock = await indexLock.stat();
      await assertCurrentBranch(plan, signal);
      const journal: CheckpointJournal = {
        previousHead: previous.head,
        next,
        indexLock: { dev: lock.dev, ino: lock.ino },
      };
      await mkdir(path.dirname(journalPath(plan)), { recursive: true });
      await writeFile(`${journalPath(plan)}.tmp`, JSON.stringify(journal));
      await rename(`${journalPath(plan)}.tmp`, journalPath(plan));
      journalWritten = true;
      // Do not interrupt the ref/index update halfway through. The journal lets
      // startup finish it if the process itself exits between these operations.
      await git(repository, [
        'update-ref',
        '-m',
        message,
        `refs/heads/${plan.branch}`,
        commit,
        previous.head,
      ]);
      committed = true;
      await indexLock.close();
      await rename(`${index}.lock`, index);
      plan.currentBranchSnapshot = next;
      return commit;
    } finally {
      await indexLock.close();
      if (!committed) {
        await rm(`${index}.lock`, { force: true });
        if (journalWritten) await rm(journalPath(plan), { force: true });
      }
    }
  });
}
