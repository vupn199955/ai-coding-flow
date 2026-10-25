import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FlowController } from '../src/orchestrator';
import { Store } from '../src/store';
import { DemoRuntime, type AgentRuntime } from '../src/runtime';
import { InterruptedError, git } from '../src/process';
import type { PlanRecord } from '@ai-flow/shared';

describe('implementation / review controller', () => {
  let directory: string;
  let store: Store;
  let controller: FlowController;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'ai-flow-loop-'));
    store = new Store(directory);
    controller = new FlowController(store, process.cwd());
  });
  afterEach(async () => {
    await controller.shutdown();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('completes a dependent plan, repairs a rejection, and delivers a reviewed branch without changing the source branch', async () => {
    const plan = await controller.createDemo();
    const sourceHead = await git(plan.config.repositoryPath, ['rev-parse', 'HEAD']);
    controller.start(plan.id);
    await controller.waitForIdle();
    const result = controller.requirePlan(plan.id);
    expect(result.status, result.error).toBe('completed');
    expect(result.tasks.map((task) => task.status)).toEqual(['approved', 'approved']);
    expect(result.tasks[0]?.reviews.map((review) => review.verdict)).toEqual([
      'changes_requested',
      'approved',
    ]);
    expect(result.tasks[1]?.baseCommit).toBe(result.tasks[0]?.approvedCommit);
    expect(result.finalReview?.verdict).toBe('approved');
    expect(result.finalReview?.reviewedCommit).toBe(result.finalCommit);
    expect(
      result.integrationChecks.every(
        (check) => check.status === 'passed' && check.commit === result.finalCommit,
      ),
    ).toBe(true);
    expect(await git(plan.config.repositoryPath, ['rev-parse', 'HEAD'])).toBe(sourceHead);
    expect(await git(plan.config.repositoryPath, ['branch', '--show-current'])).toBe('main');
    expect(await readFile(result.tasks[0]!.reviews[0]!.markdownPath, 'utf8')).toContain(
      '**Status:** changes_requested',
    );
    expect(await readFile(result.tasks[0]!.reviews[1]!.markdownPath, 'utf8')).toContain(
      '**Status:** approved',
    );
    expect(result.attempts.every((attempt) => !attempt.usage)).toBe(true);
  });

  it('stops at the review limit and resumes from durable progress after an explicit limit increase', async () => {
    const plan = await controller.createDemo();
    controller.updateLimits(plan.id, { ...plan.config.limits, maxReviewRounds: 1 });
    controller.start(plan.id);
    await controller.waitForIdle();
    const stopped = controller.requirePlan(plan.id);
    expect(stopped.status).toBe('needs_attention');
    expect(stopped.tasks[0]?.reviews).toHaveLength(1);
    expect(stopped.error).toMatch(/review-round limit/);
    controller.updateLimits(plan.id, { ...plan.config.limits, maxReviewRounds: 5 });
    controller.start(plan.id);
    await controller.waitForIdle();
    expect(controller.requirePlan(plan.id).status).toBe('completed');
    expect(controller.requirePlan(plan.id).tasks[0]?.reviews).toHaveLength(2);
  });

  it('pauses an agent and resumes without running duplicate controllers', async () => {
    const plan = await controller.createDemo();
    controller.start(plan.id);
    expect(() => controller.start(plan.id)).toThrow(/Another run/);
    controller.stop(plan.id, 'pause');
    await controller.waitForIdle();
    expect(controller.requirePlan(plan.id).status).toBe('paused');
    controller.start(plan.id);
    await controller.waitForIdle();
    expect(controller.requirePlan(plan.id).status).toBe('completed');
  });

  it('keeps captured configuration independent of later default edits', async () => {
    const plan = await controller.createDemo();
    const defaults = controller.config();
    controller.updateConfig({
      ...defaults,
      agents: {
        ...defaults.agents,
        implementer: { ...defaults.agents.implementer, effort: 'ultra' },
      },
    });
    expect(controller.requirePlan(plan.id).config.agents.implementer.effort).toBe('deterministic');
  });

  it('reports cumulative usage without imposing a token limit, including across resume', async () => {
    const demo = new DemoRuntime();
    const runtime: AgentRuntime = {
      inspect: () => demo.inspect(),
      run: async (request) => {
        const usage = {
          inputTokens: 900_000_000,
          cachedInputTokens: 800_000_000,
          outputTokens: 200_000_000,
          reasoningOutputTokens: 50_000_000,
          totalTokens: 1_100_000_000,
          source: 'reported' as const,
        };
        request.onUsage(usage);
        request.onUsage(usage);
        return { ...(await demo.run(request)), usage };
      },
    };
    controller = new FlowController(store, process.cwd(), { runtimeFactory: () => runtime });
    const plan = await controller.createDemo();
    controller.updateLimits(plan.id, {
      ...plan.config.limits,
      maxReviewRounds: 1,
      maxTokens: 1000,
    });
    controller.start(plan.id);
    await controller.waitForIdle();
    const stopped = controller.requirePlan(plan.id);
    expect(stopped.error).toMatch(/review-round limit/);
    expect(stopped.attempts[0]?.usage?.totalTokens).toBe(1_100_000_000);
    controller.updateLimits(plan.id, { ...plan.config.limits, maxReviewRounds: 5 });
    controller.start(plan.id);
    await controller.waitForIdle();
    const result = controller.requirePlan(plan.id);
    expect(result.status, result.error).toBe('completed');
    expect(result.attempts.every((attempt) => attempt.usage?.totalTokens === 1_100_000_000)).toBe(
      true,
    );
  });

  it('runs direct instructions without task files and commits only workflow edits when the source has local changes', async () => {
    const instructions = 'Add a value utility and a unit test. Follow this plain text exactly.';
    const runtime: AgentRuntime = {
      inspect: () => new DemoRuntime().inspect(),
      run: async (request) => {
        expect(request.prompt).toContain(instructions);
        if (request.role === 'reviewer')
          return {
            text: 'Approved',
            review: { verdict: 'approved', summary: 'Value is tested.', findings: [] },
          };
        await writeFile(path.join(request.cwd, 'value.js'), 'export const value = 42;\n');
        await writeFile(
          path.join(request.cwd, 'value.test.js'),
          "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './value.js';\ntest('value', () => assert.equal(value, 42));\n",
        );
        return { text: 'Implemented.\nCommit title: feat: add value utility' };
      },
    };
    controller = new FlowController(store, process.cwd(), { runtimeFactory: () => runtime });
    const fixture = await controller.createDemo();
    const repository = fixture.config.repositoryPath;
    const sourceHead = await git(repository, ['rev-parse', 'HEAD']);
    await writeFile(path.join(repository, 'README.md'), 'User edits, keep these.\n');
    await git(repository, ['add', 'README.md']);
    await writeFile(path.join(repository, 'README.md'), 'More user edits, keep these too.\n');
    await writeFile(path.join(repository, 'user-notes.txt'), 'Untracked user work.\n');
    const staged = await git(repository, ['diff', '--cached']);
    const project = controller.requireProject(fixture.projectId!);
    controller.updateProject(project.id, { config: { ...project.config, taskPath: '' } });
    const plan = await controller.createPlan({
      name: '',
      projectId: project.id,
      taskText: instructions,
    });
    expect(plan.name).toBe(instructions);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]?.markdown).toBe(instructions);
    expect(plan.tasks[0]?.sourcePath).toBe('');
    controller.start(plan.id);
    await controller.waitForIdle();
    const result = controller.requirePlan(plan.id);
    expect(result.status, result.error).toBe('completed');
    expect(await git(repository, ['rev-parse', 'HEAD'])).toBe(sourceHead);
    expect(await git(repository, ['diff', '--cached'])).toBe(staged);
    expect(await readFile(path.join(repository, 'README.md'), 'utf8')).toContain('More user edits');
    expect(await readFile(path.join(repository, 'user-notes.txt'), 'utf8')).toContain(
      'Untracked user work',
    );
    expect(
      await git(result.workspacePath!, ['diff', '--name-only', sourceHead, result.finalCommit!]),
    ).toBe('value.js\nvalue.test.js');
    expect(await readFile(path.join(plan.artifactsPath!, 'tasks/task/task.md'), 'utf8')).toBe(
      instructions,
    );
  });

  it('repairs failed independent checks before requesting a review', async () => {
    const demo = new DemoRuntime();
    let initialImplementation = true;
    const runtime: AgentRuntime = {
      inspect: () => demo.inspect(),
      run: async (request) => {
        const result = await demo.run(request);
        if (
          initialImplementation &&
          request.role === 'implementer' &&
          request.taskId === 'greeting'
        ) {
          initialImplementation = false;
          await writeFile(
            path.join(request.cwd, 'greeting.js'),
            "export function greet() { return 'incorrect'; }\n",
          );
        }
        return result;
      },
    };
    controller = new FlowController(store, process.cwd(), { runtimeFactory: () => runtime });
    const plan = await controller.createDemo();
    controller.updateLimits(plan.id, { ...plan.config.limits, maxFixAttempts: 1 });
    controller.start(plan.id);
    await controller.waitForIdle();
    const result = controller.requirePlan(plan.id);
    expect(result.status, result.error).toBe('completed');
    expect(result.tasks[0]?.fixAttempts).toBe(1);
    expect(
      result.attempts.filter(
        (attempt) => attempt.taskId === 'greeting' && attempt.role === 'implementer',
      ),
    ).toHaveLength(3);
    expect(result.tasks[0]?.checks.every((check) => check.status === 'passed')).toBe(true);
  });

  it('repairs a final plan change request and reviews the new combined commit', async () => {
    const demo = new DemoRuntime();
    const runtime: AgentRuntime = {
      inspect: () => demo.inspect(),
      run: async (request) => {
        if (request.taskId === '__plan__' && request.role === 'reviewer' && request.round === 1) {
          const review = {
            verdict: 'changes_requested' as const,
            summary: 'Document the utility usage.',
            findings: [
              {
                id: 'P-001',
                severity: 'medium' as const,
                blocking: true,
                file: 'README.md',
                line: null,
                problem: 'Usage is missing.',
                requestedChange: 'Document both utilities.',
                requiredTest: 'Verify documented exports exist.',
              },
            ],
          };
          return { text: JSON.stringify(review), review };
        }
        if (request.taskId === '__plan__' && request.role === 'implementer') {
          await writeFile(
            path.join(request.cwd, 'README.md'),
            '# Utility usage\n\nImport greet from greeting.js and farewell from farewell.js. Both functions normalize names and default to world.\n',
          );
          return { text: 'Addressed P-001 by documenting the two existing, tested utilities.' };
        }
        return demo.run(request);
      },
    };
    controller = new FlowController(store, process.cwd(), { runtimeFactory: () => runtime });
    const plan = await controller.createDemo();
    controller.start(plan.id);
    await controller.waitForIdle();
    const result = controller.requirePlan(plan.id);
    expect(result.status, result.error).toBe('completed');
    expect(result.finalReview?.round).toBe(2);
    expect(result.finalReview?.reviewedCommit).toBe(result.finalCommit);
    expect(result.finalCommit).not.toBe(result.tasks[1]?.approvedCommit);
    expect(await readFile(path.join(result.workspacePath!, 'README.md'), 'utf8')).toContain(
      'Utility usage',
    );
  });

  it('resumes after all tasks are integrated without trying to integrate an earlier task again', async () => {
    const demo = new DemoRuntime();
    let interrupted = false;
    const runtime: AgentRuntime = {
      inspect: () => demo.inspect(),
      run: async (request) => {
        if (!interrupted && request.taskId === '__plan__') {
          interrupted = true;
          controller.stop(request.planId, 'pause');
          throw new InterruptedError();
        }
        return demo.run(request);
      },
    };
    controller = new FlowController(store, process.cwd(), { runtimeFactory: () => runtime });
    const plan = await controller.createDemo();
    controller.start(plan.id);
    await controller.waitForIdle();
    expect(controller.requirePlan(plan.id).status).toBe('paused');
    expect(controller.requirePlan(plan.id).tasks.every((task) => task.integratedCommit)).toBe(true);
    controller.start(plan.id);
    await controller.waitForIdle();
    expect(controller.requirePlan(plan.id).status).toBe('completed');
  });

  it('does not integrate code when a runtime fails or review output is invalid', async () => {
    const demo = new DemoRuntime();
    const runtime: AgentRuntime = {
      inspect: () => demo.inspect(),
      run: (request) =>
        request.role === 'reviewer'
          ? Promise.resolve({
              text: '{}',
              review: {
                verdict: 'approved',
                summary: 'Invalid approval',
                findings: [
                  {
                    id: 'R-1',
                    severity: 'high',
                    blocking: true,
                    file: 'greeting.js',
                    line: 1,
                    problem: 'Defect.',
                    requestedChange: 'Fix it.',
                    requiredTest: 'Test it.',
                  },
                ],
              },
            })
          : demo.run(request),
    };
    controller = new FlowController(store, process.cwd(), { runtimeFactory: () => runtime });
    const plan = await controller.createDemo();
    controller.start(plan.id);
    await controller.waitForIdle();
    const stopped = controller.requirePlan(plan.id);
    expect(stopped.status).toBe('needs_attention');
    expect(stopped.error).toMatch(/blocking/);
    expect(stopped.tasks.every((task) => !task.integratedCommit)).toBe(true);
  });
});
