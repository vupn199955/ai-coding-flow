import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FlowController } from '../src/orchestrator';
import { Store } from '../src/store';
import { createDemoProject } from '../src/runtime';
import { git } from '../src/process';
import { listDirectories } from '../src/projects';
import { commitTitle } from '../src/workspace';

describe('project workflows', () => {
  let directory: string;
  let store: Store;
  let flow: FlowController;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'ai-flow-projects-'));
    store = new Store(path.join(directory, 'controller'));
    flow = new FlowController(store, process.cwd());
  });
  afterEach(async () => {
    await flow.shutdown();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('registers external folders once, including symlink aliases, and keeps settings independent', async () => {
    const source = await createDemoProject(directory);
    const alias = path.join(directory, 'project alias');
    await symlink(source.repositoryPath, alias);
    const project = await flow.createProject({
      repositoryPath: source.repositoryPath,
      name: 'Shop',
    });
    expect((await flow.createProject({ repositoryPath: alias })).id).toBe(project.id);
    expect(project.repositoryPath).toBe(await realpath(source.repositoryPath));
    expect(project.config.taskPath).toBe(path.join(project.repositoryPath, 'tasks'));
    flow.updateProject(project.id, {
      config: {
        ...project.config,
        taskPath: source.taskPath,
        limits: { ...project.config.limits, maxTokens: 4321 },
      },
    });
    expect(flow.config().limits.maxTokens).not.toBe(4321);
    const plan = await flow.createPlan({ name: 'Project run', projectId: project.id });
    expect(plan.config.limits.maxTokens).toBe(4321);
    flow.updateProject(project.id, { config: project.config });
    expect(flow.requirePlan(plan.id).config.limits.maxTokens).toBe(4321);
    await expect(
      flow.createPlan({
        name: 'Wrong repository',
        projectId: project.id,
        repositoryPath: directory,
      }),
    ).rejects.toThrow(/selected project/);
    expect(() =>
      flow.updateProject(project.id, { config: { ...project.config, repositoryPath: directory } }),
    ).toThrow(/owned by the project/);
    expect(await git(project.repositoryPath, ['status', '--porcelain'])).toBe('');
  });

  it('runs different projects concurrently, with independent controls, documents, and commits', async () => {
    const a = await flow.createDemo();
    const b = await flow.createDemo();
    const queued = await flow.createPlan({ name: 'Second workflow', projectId: a.projectId! });
    expect(a.projectId).not.toBe(b.projectId);
    flow.start(a.id);
    flow.start(b.id);
    expect(flow.state().activePlanIds.sort()).toEqual([a.id, b.id].sort());
    expect(() => flow.start(queued.id)).toThrow(/in this project/);
    flow.stop(a.id, 'pause');
    await flow.waitForIdle();
    expect(flow.requirePlan(a.id).status).toBe('paused');
    expect(flow.requirePlan(b.id).status).toBe('completed');
    flow.start(a.id);
    await flow.waitForIdle();
    for (const original of [a, b]) {
      const result = flow.requirePlan(original.id);
      expect(result.status, result.error).toBe('completed');
      expect(result.workspacePath).toContain(
        path.join(result.config.repositoryPath, '.ai-flow', 'worktrees'),
      );
      expect(await readFile(path.join(result.artifactsPath!, 'progress.md'), 'utf8')).toContain(
        'Status: completed',
      );
      expect(
        await readFile(path.join(result.artifactsPath!, 'tasks/greeting/task.md'), 'utf8'),
      ).toBe(result.tasks[0]!.markdown);
      expect(result.tasks[0]!.reviews[0]!.markdownPath).toContain(result.artifactsPath);
      expect(await git(result.workspacePath!, ['log', '-1', '--format=%s'])).toBe(
        'feat: add a farewell utility',
      );
      expect(await git(result.config.repositoryPath, ['status', '--porcelain'])).toBe('');
      expect(result.finalReview?.reviewedCommit).toBe(result.finalCommit);
    }
  });

  it('copies ignored Codex guidance and skills into task and integration worktrees without committing them', async () => {
    const plan = await flow.createDemo();
    const repository = plan.config.repositoryPath;
    await appendFile(
      path.join(repository, '.git/info/exclude'),
      '\nAGENTS.md\n.codex/\n.agents/\n',
    );
    await mkdir(path.join(repository, '.codex/rules'), { recursive: true });
    await mkdir(path.join(repository, '.agents/skills/example'), { recursive: true });
    await mkdir(path.join(repository, 'src'), { recursive: true });
    await writeFile(path.join(repository, 'AGENTS.md'), 'Use the project conventions.\n');
    await writeFile(path.join(repository, 'src/AGENTS.md'), 'Scoped instructions.\n');
    await writeFile(path.join(repository, '.codex/config.toml'), 'project_doc_max_bytes = 65536\n');
    await writeFile(
      path.join(repository, '.codex/rules/project.rules'),
      'prefix_rule(pattern = ["npm", "test"], decision = "allow")\n',
    );
    await writeFile(path.join(repository, '.agents/skills/example/SKILL.md'), '# Example skill\n');
    flow.start(plan.id);
    await flow.waitForIdle();
    const result = flow.requirePlan(plan.id);
    expect(result.status, result.error).toBe('completed');
    for (const workspace of [
      result.workspacePath!,
      ...result.tasks.map((task) => task.workspacePath!),
    ]) {
      expect(await readFile(path.join(workspace, 'src/AGENTS.md'), 'utf8')).toContain(
        'Scoped instructions',
      );
      await access(path.join(workspace, '.codex/config.toml'));
      await access(path.join(workspace, '.codex/rules/project.rules'));
      await access(path.join(workspace, '.agents/skills/example/SKILL.md'));
      expect(
        await git(workspace, ['ls-files', 'AGENTS.md', 'src/AGENTS.md', '.codex', '.agents']),
      ).toBe('');
    }
  });

  it('stops before removal, retains project files, and does not restore removed workflows on restart', async () => {
    const plan = await flow.createDemo();
    flow.start(plan.id);
    await flow.removePlan(plan.id);
    expect(flow.state().activePlanIds).toEqual([]);
    expect(store.getPlan(plan.id)).toBeNull();
    expect(store.getEvents(plan.id)).toEqual([]);
    await access(path.join(plan.config.repositoryPath, '.git'));
    expect(await readFile(path.join(plan.artifactsPath!, 'progress.md'), 'utf8')).toContain(
      'cancelled',
    );
    store.close();
    store = new Store(path.join(directory, 'controller'));
    flow = new FlowController(store, process.cwd());
    expect(flow.state().plans).toEqual([]);
    expect(flow.state().projects).toHaveLength(1);
  });

  it('migrates legacy workflows by repository without relocating their workspaces or changing captured settings', async () => {
    const source = await flow.createDemo();
    const legacy = {
      ...source,
      id: 'legacy-one',
      projectId: undefined,
      artifactsPath: undefined,
      storageDirectory: undefined,
      workspacePath: '/legacy/workspace',
    };
    store.removePlan(source.id);
    store.savePlan(legacy);
    store.savePlan({ ...legacy, id: 'legacy-two' });
    flow = new FlowController(store, process.cwd());
    expect(flow.state().projects).toHaveLength(1);
    expect(flow.requirePlan('legacy-one').projectId).toBe(flow.requirePlan('legacy-two').projectId);
    expect(flow.requirePlan('legacy-one').workspacePath).toBe('/legacy/workspace');
    expect(flow.requirePlan('legacy-one').config).toEqual(source.config);
    expect(flow.requirePlan('legacy-one').storageDirectory).toBeUndefined();
  });

  it('browses absolute directories with spaces and rejects non-directory paths', async () => {
    const folder = path.join(directory, 'project with spaces');
    await mkdir(folder);
    await writeFile(path.join(directory, 'file.md'), '# task');
    const listing = await listDirectories(directory);
    expect(listing.directories).toContainEqual({
      name: 'project with spaces',
      path: path.join(listing.path, 'project with spaces'),
    });
    expect((await listDirectories(folder)).parent).toBe(listing.path);
    await expect(listDirectories(path.join(directory, 'file.md'))).rejects.toThrow(/directory/);
  });

  it('uses short commit titles from project conventions with a deterministic fallback', () => {
    expect(
      commitTitle('Add users', 'Done.\nCommit title: feat(api): add user creation\nTests pass.'),
    ).toBe('feat(api): add user creation');
    expect(commitTitle('Add users')).toBe('feat: add users');
    expect(commitTitle('Add users', undefined, true)).toBe('fix: add users');
    expect(commitTitle('x'.repeat(200))).toHaveLength(72);
  });
});
