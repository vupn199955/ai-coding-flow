import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentAttempt,
  AgentRole,
  CreatePlanInput,
  DashboardState,
  FlowConfig,
  PlanRecord,
  ProjectRecord,
  ReviewRecord,
  ReviewVerdict,
  RuntimeStatus,
  TaskRecord,
} from '@ai-flow/shared';
import { defaultConfig, parseConfig } from './config';
import { Store } from './store';
import { loadTasks, textTask } from './tasks';
import { CodexRuntime, DemoRuntime, createDemoProject, type AgentRuntime } from './runtime';
import { InterruptedError, git } from './process';
import {
  assertCleanCommit,
  checkpoint,
  integrateTask,
  preparePlanWorkspace,
  prepareTaskWorkspace,
  runChecks,
  validateRepository,
} from './workspace';
import { parseReview, renderReview } from './review';
import { canonicalPath, excludeRuntimeFiles, projectRecord, repositoryRoot } from './projects';
import { commitTitle } from './workspace';
import {
  assertCurrentBranch,
  assertCurrentBranchSnapshot,
  checkpointCurrentBranch,
} from './current-branch';

interface ActiveRun {
  plan: PlanRecord;
  abort: AbortController;
  stop: 'pause' | 'cancel' | 'budget' | null;
  stopMessage?: string;
  done: Promise<void>;
}

export class FlowController {
  private readonly active = new Map<string, ActiveRun>();
  private readonly removing = new Set<string>();
  private readonly removingProjects = new Set<string>();
  private readonly runtimeStatuses = new Map<string, RuntimeStatus>();
  private readonly runtimeRefreshes = new Map<string, Promise<RuntimeStatus>>();
  private runtimeStatus: RuntimeStatus | null = null;
  private readonly runtimeFactory: (config: FlowConfig) => AgentRuntime;

  constructor(
    readonly store: Store,
    readonly root: string,
    options: { runtimeFactory?: (config: FlowConfig) => AgentRuntime } = {},
  ) {
    this.runtimeFactory =
      options.runtimeFactory ??
      ((config) =>
        config.runtime === 'demo'
          ? new DemoRuntime()
          : new CodexRuntime(process.env.CODEX_BIN || 'codex', config.repositoryPath));
    // Parsing also drops legacy token limits from saved configurations.
    store.saveConfig(parseConfig(store.getConfig() || defaultConfig(root)));
    this.migrateProjects();
    store.recoverInterruptedRuns();
  }

  state(): DashboardState {
    return {
      config: this.config(),
      projects: this.store.listProjects(),
      plans: this.store.listPlans(),
      activePlanIds: [...this.active.keys()],
      activePlanId: this.active.keys().next().value ?? null,
      projectRuntimes: Object.fromEntries(this.runtimeStatuses),
      events: this.store.getEvents(undefined, 0, 200),
      runtime: this.runtimeStatus,
      dataDirectory: this.store.directory,
    };
  }

  config(): FlowConfig {
    return this.store.getConfig()!;
  }

  updateConfig(input: unknown): FlowConfig {
    const config = parseConfig(input);
    this.store.saveConfig(config);
    this.event(
      null,
      null,
      'controller',
      'state',
      'Default settings updated. Existing runs retain their captured configuration.',
    );
    return config;
  }

  private migrateProjects(): void {
    for (const project of this.store.listProjects()) {
      project.config = parseConfig(project.config);
      this.store.saveProject(project);
    }
    const byPath = new Map(
      this.store.listProjects().map((project) => [project.repositoryPath, project]),
    );
    for (const plan of this.store.listPlans()) {
      plan.config = parseConfig(plan.config);
      this.store.savePlan(plan);
      if (plan.projectId && this.store.getProject(plan.projectId)) continue;
      const repository = canonicalPath(plan.config.repositoryPath);
      let project = byPath.get(repository);
      if (!project) {
        project = projectRecord(repository, plan.config);
        this.store.saveProject(project);
        byPath.set(repository, project);
      }
      plan.projectId = project.id;
      // Retain captured configuration and legacy workspace/report paths for resume.
      this.store.savePlan(plan);
    }
  }

  requireProject(id: string): ProjectRecord {
    if (this.removingProjects.has(id)) throw new Error('This project is being removed.');
    const project = this.store.getProject(id);
    if (!project) throw new Error('Project not found.');
    return project;
  }

  async removeProject(id: string): Promise<{ removed: string }> {
    const project = this.requireProject(id);
    this.removingProjects.add(id);
    try {
      const runs = [...this.active.values()].filter((run) => run.plan.projectId === id);
      for (const run of runs) this.stop(run.plan.id, 'cancel');
      await Promise.all(runs.map((run) => run.done));
      this.store.removeProject(id);
      this.runtimeStatuses.delete(id);
      this.event(
        null,
        null,
        'controller',
        'state',
        `Project removed: ${project.name}, including all workflows and activity. Repository files and commits retained.`,
      );
      return { removed: id };
    } finally {
      this.removingProjects.delete(id);
    }
  }

  async createProject(input: { repositoryPath: string; name?: string }): Promise<ProjectRecord> {
    const repository = await repositoryRoot(input.repositoryPath);
    const existing = this.store
      .listProjects()
      .find((project) => project.repositoryPath === repository);
    if (existing) return this.requireProject(existing.id);
    await excludeRuntimeFiles(repository);
    const project = projectRecord(
      repository,
      { ...this.config(), taskPath: path.join(repository, 'tasks') },
      input.name,
    );
    // Recheck after asynchronous validation to handle two simultaneous requests.
    const duplicate = this.store.listProjects().find((item) => item.repositoryPath === repository);
    if (duplicate) return this.requireProject(duplicate.id);
    this.store.saveProject(project);
    this.event(
      null,
      null,
      'controller',
      'state',
      `Project added: ${project.name} (${repository}).`,
    );
    return project;
  }

  updateProject(id: string, input: { name?: string; config?: unknown }): ProjectRecord {
    const project = this.requireProject(id);
    if (input.name !== undefined) project.name = input.name.trim();
    if (input.config !== undefined) {
      const config = parseConfig(input.config);
      if (config.repositoryPath !== project.repositoryPath)
        throw new Error(
          'Repository path is owned by the project. Add another project to select a different repository.',
        );
      project.config = config;
    }
    this.store.saveProject(project);
    this.event(
      null,
      null,
      'controller',
      'state',
      `Project settings updated: ${project.name}. Existing workflows retain their captured configuration.`,
    );
    return project;
  }

  async refreshRuntime(projectId?: string): Promise<RuntimeStatus> {
    const key = projectId || 'global';
    const pending = this.runtimeRefreshes.get(key);
    if (pending) return pending;
    const cwd = projectId ? this.requireProject(projectId).repositoryPath : this.root;
    const refresh = new CodexRuntime(process.env.CODEX_BIN || 'codex', cwd)
      .inspect()
      .then((status) => {
        if (
          projectId &&
          (!this.store.getProject(projectId) || this.removingProjects.has(projectId))
        )
          return status;
        this.runtimeStatuses.set(key, status);
        this.runtimeStatus = status;
        return status;
      })
      .finally(() => this.runtimeRefreshes.delete(key));
    this.runtimeRefreshes.set(key, refresh);
    return refresh;
  }

  async previewTasks(taskPath?: string) {
    return loadTasks(taskPath || this.config().taskPath);
  }

  async createPlan(input: CreatePlanInput, override?: FlowConfig): Promise<PlanRecord> {
    if (
      input.taskText !== undefined &&
      (input.taskPath !== undefined || input.taskIds !== undefined)
    )
      throw new Error('Choose task text or Markdown files, not both.');
    let project = input.projectId ? this.requireProject(input.projectId) : undefined;
    if (
      project &&
      input.repositoryPath &&
      canonicalPath(input.repositoryPath) !== project.repositoryPath
    )
      throw new Error('Repository path must match the selected project.');
    const config = parseConfig({
      ...structuredClone(override || project?.config || this.config()),
      ...(input.repositoryPath ? { repositoryPath: input.repositoryPath } : {}),
      ...(input.taskPath ? { taskPath: input.taskPath } : {}),
      ...(input.useWorktree !== undefined ? { useWorktree: input.useWorktree } : {}),
    });
    config.repositoryPath = await repositoryRoot(config.repositoryPath);
    await excludeRuntimeFiles(config.repositoryPath);
    config.repositoryPath = await validateRepository(config.repositoryPath);
    if (!project) {
      project = this.store
        .listProjects()
        .find((item) => item.repositoryPath === config.repositoryPath);
      if (!project) {
        project = projectRecord(config.repositoryPath, config);
        this.store.saveProject(project);
      }
    }
    const definitions =
      input.taskText !== undefined
        ? [textTask(input.taskText)]
        : await loadTasks(config.taskPath, input.taskIds);
    const timestamp = new Date().toISOString();
    const plan: PlanRecord = {
      id: randomUUID(),
      name: input.name?.trim() || definitions[0]!.title,
      projectId: project.id,
      storageDirectory: path.join(config.repositoryPath, '.ai-flow'),
      status: 'queued',
      config,
      tasks: definitions.map((task) => ({
        ...task,
        status: 'queued',
        round: 0,
        fixAttempts: 0,
        checks: [],
        reviews: [],
      })),
      attempts: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      elapsedMs: 0,
      baseCommit: await git(config.repositoryPath, ['rev-parse', 'HEAD']),
      integrationChecks: [],
    };
    // Deletion may have started while repository/task validation was awaiting I/O.
    this.requireProject(project.id);
    plan.artifactsPath = path.join(plan.storageDirectory!, 'runs', plan.id);
    this.store.savePlan(plan);
    this.event(
      plan.id,
      null,
      'controller',
      'state',
      `Created ${plan.name} with ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}. Configuration and task content captured.`,
    );
    return plan;
  }

  async createDemo(): Promise<PlanRecord> {
    const project = await createDemoProject(this.store.directory);
    const config = structuredClone(this.config());
    config.repositoryPath = project.repositoryPath;
    config.taskPath = project.taskPath;
    config.runtime = 'demo';
    config.checks = [
      {
        id: 'unit',
        name: 'Node unit tests',
        command: 'node --test',
        kind: 'unit',
        timeoutSeconds: 30,
      },
    ];
    config.agents.implementer = { model: 'demo', effort: 'deterministic', instructions: '' };
    config.agents.reviewer = { model: 'demo', effort: 'deterministic', instructions: '' };
    const plan = await this.createPlan({ name: 'Greeting utilities · demo' }, config);
    return plan;
  }

  start(id: string): PlanRecord {
    if (this.removing.has(id)) throw new Error('This workflow is being removed.');
    const plan = this.requirePlan(id);
    if (plan.projectId) this.requireProject(plan.projectId);
    if (
      [...this.active.values()].some(
        (run) =>
          run.plan.projectId === plan.projectId ||
          run.plan.config.repositoryPath === plan.config.repositoryPath,
      )
    )
      throw new Error(
        'Another run is active in this project. Pause or finish it before starting this run.',
      );
    if (!['queued', 'paused', 'needs_attention'].includes(plan.status))
      throw new Error(`Cannot start a ${plan.status} run.`);
    if (plan.elapsedMs >= plan.config.limits.maxRunMinutes * 60_000)
      throw new Error('The time budget is exhausted. Increase this run’s limits before resuming.');
    plan.status = 'running';
    plan.error = undefined;
    plan.startedAt ||= new Date().toISOString();
    this.store.savePlan(plan);
    const run: ActiveRun = {
      plan,
      abort: new AbortController(),
      stop: null,
      done: Promise.resolve(),
    };
    this.active.set(id, run);
    this.event(
      id,
      null,
      'controller',
      'state',
      'Run started. The controller will implement, verify, review, and repair each task in dependency order.',
    );
    run.done = this.execute(run).finally(() => {
      if (this.active.get(id) === run) this.active.delete(id);
    });
    return plan;
  }

  stop(id: string, action: 'pause' | 'cancel'): PlanRecord {
    const plan = this.requirePlan(id);
    const active = this.active.get(id);
    if (active) {
      active.stop = action;
      active.abort.abort();
      this.event(
        id,
        null,
        'controller',
        'state',
        `${action === 'pause' ? 'Pausing' : 'Cancelling'} run; stopping active agent and check processes.`,
      );
      return active.plan;
    }
    if (action === 'cancel' && !['completed', 'cancelled'].includes(plan.status)) {
      plan.status = 'cancelled';
      this.store.savePlan(plan);
      this.event(
        id,
        null,
        'controller',
        'state',
        'Run cancelled. Workspaces and reports have been retained.',
      );
      return plan;
    }
    throw new Error('This run is not active.');
  }

  updateLimits(id: string, input: unknown): PlanRecord {
    const plan = this.requirePlan(id);
    if (!['queued', 'paused', 'needs_attention'].includes(plan.status))
      throw new Error('Pause this run before updating its limits.');
    const updated = parseConfig({ ...plan.config, limits: input });
    plan.config.limits = updated.limits;
    this.store.savePlan(plan);
    this.event(
      id,
      null,
      'controller',
      'state',
      `Run limits explicitly updated: ${JSON.stringify(updated.limits)}.`,
    );
    return plan;
  }

  requirePlan(id: string): PlanRecord {
    const plan = this.store.getPlan(id);
    if (!plan) throw new Error('Run not found.');
    return plan;
  }

  async removePlan(id: string): Promise<{ removed: string }> {
    this.requirePlan(id);
    if (this.removing.has(id)) throw new Error('This workflow is being removed.');
    this.removing.add(id);
    try {
      const active = this.active.get(id);
      if (active) {
        this.stop(id, 'cancel');
        await active.done;
      }
      this.store.removePlan(id);
      this.event(
        null,
        null,
        'controller',
        'state',
        'Workflow removed from the dashboard. Project files and commits retained.',
      );
      return { removed: id };
    } finally {
      this.removing.delete(id);
    }
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.active.values()].map((run) => run.done));
  }

  async shutdown(): Promise<void> {
    for (const run of this.active.values()) {
      run.stop = 'pause';
      run.abort.abort();
    }
    await this.waitForIdle();
    this.store.events.emit('shutdown');
  }

  private event(
    planId: string | null,
    taskId: string | null,
    role: AgentRole | 'controller' | 'verifier',
    type: 'state' | 'log' | 'usage' | 'review' | 'check' | 'error',
    message: string,
  ) {
    if (!message.trim()) return;
    this.store.addEvent({ planId, taskId, role, type, message: message.slice(0, 16_000) });
  }

  private enforceBudgets(run: ActiveRun): void {
    if (run.stop) return;
    const reason =
      run.plan.elapsedMs >= run.plan.config.limits.maxRunMinutes * 60_000
        ? 'Time budget reached.'
        : null;
    if (reason) {
      run.stop = 'budget';
      run.stopMessage = reason;
      run.abort.abort();
    }
  }

  private assertSnapshot(
    plan: PlanRecord,
    cwd: string,
    commit: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return plan.config.useWorktree
      ? assertCleanCommit(cwd, commit, signal)
      : assertCurrentBranchSnapshot(plan, commit, signal);
  }

  private checkpoint(
    plan: PlanRecord,
    cwd: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return plan.config.useWorktree
      ? checkpoint(cwd, message, signal)
      : checkpointCurrentBranch(plan, message, signal);
  }

  private checkSnapshot(plan: PlanRecord, commit: string, signal: AbortSignal) {
    return plan.config.useWorktree
      ? undefined
      : {
          tree: plan.currentBranchSnapshot!.tree,
          verify: () => this.assertSnapshot(plan, plan.workspacePath!, commit, signal),
        };
  }

  private async execute(run: ActiveRun): Promise<void> {
    const { plan } = run;
    const segmentStarted = Date.now();
    const previousElapsed = plan.elapsedMs;
    const heartbeat = setInterval(() => {
      plan.elapsedMs = previousElapsed + Date.now() - segmentStarted;
      this.store.savePlan(plan);
      this.enforceBudgets(run);
    }, 1000);
    try {
      const signal = run.abort.signal;
      await preparePlanWorkspace(plan, plan.storageDirectory || this.store.directory, signal);
      this.store.savePlan(plan);
      this.event(
        plan.id,
        null,
        'controller',
        'log',
        `${plan.config.useWorktree ? 'Integration worktree' : 'Current-branch workspace'}: ${plan.workspacePath}\nOutput branch: ${plan.branch}`,
      );
      for (const task of plan.tasks) {
        if (signal.aborted) throw new InterruptedError();
        if (task.status === 'approved') {
          await integrateTask(plan, task, signal);
          this.store.savePlan(plan);
          continue;
        }
        const missing = task.dependsOn.filter(
          (id) =>
            !plan.tasks.some(
              (candidate) =>
                candidate.id === id &&
                candidate.status === 'approved' &&
                candidate.integratedCommit,
            ),
        );
        if (missing.length)
          throw new Error(`Task ${task.id} is waiting for dependencies: ${missing.join(', ')}.`);
        await prepareTaskWorkspace(
          plan,
          task,
          plan.storageDirectory || this.store.directory,
          signal,
        );
        this.store.savePlan(plan);
        await this.executeTask(run, task);
      }
      await this.verifyPlan(run);
      if (signal.aborted) throw new InterruptedError();
      plan.status = 'completed';
      plan.completedAt = new Date().toISOString();
      plan.error = undefined;
      this.event(
        plan.id,
        null,
        'controller',
        'state',
        `Run approved. All tasks, combined checks, and the final review passed at ${plan.finalCommit}. Output branch: ${plan.branch}.`,
      );
    } catch (error) {
      if (run.stop === 'cancel') plan.status = 'cancelled';
      else if (run.stop === 'pause') plan.status = 'paused';
      else plan.status = 'needs_attention';
      plan.error = run.stopMessage || (error as Error).message;
      this.event(
        plan.id,
        null,
        'controller',
        run.stop === 'pause' || run.stop === 'cancel' ? 'state' : 'error',
        `${plan.status}: ${plan.error}`,
      );
    } finally {
      clearInterval(heartbeat);
      plan.elapsedMs = previousElapsed + Date.now() - segmentStarted;
      this.store.savePlan(plan);
    }
  }

  private async executeTask(run: ActiveRun, task: TaskRecord): Promise<void> {
    const { plan } = run;
    const signal = run.abort.signal;
    task.round ||= 1;
    task.error = undefined;
    while (task.status !== 'approved') {
      if (signal.aborted) throw new InterruptedError();
      if (task.round > plan.config.limits.maxReviewRounds)
        throw new Error(
          `${task.id} reached its review-round limit. Increase this run’s limits to continue.`,
        );
      if (task.fixAttempts > plan.config.limits.maxFixAttempts)
        throw new Error(
          `${task.id} reached its check-repair limit. Increase this run’s limits to continue.`,
        );
      if (
        !task.candidateCommit ||
        ['queued', 'implementing', 'fixing', 'blocked'].includes(task.status)
      ) {
        task.status = task.round === 1 && !task.candidateCommit ? 'implementing' : 'fixing';
        this.store.savePlan(plan);
        const feedback = task.reviews.at(-1);
        const failedChecks = task.checks.filter((check) => check.status !== 'passed');
        const prompt = [
          `Task ${task.id}: ${task.title}`,
          `Review round: ${task.round}`,
          `Repository workspace: ${task.workspacePath}`,
          'Investigate the repository, describe the solution, implement it, and add or update meaningful unit tests. Do not change the configured acceptance criteria or test commands to make failures disappear.',
          'Task definition:',
          task.markdown,
          feedback
            ? `Previous independent review (address every blocking finding and report finding IDs resolved):\n${JSON.stringify(feedback, null, 2)}`
            : '',
          failedChecks.length
            ? `Verifier failures to fix:\n${failedChecks.map((check) => `${check.command}\n${check.output}`).join('\n\n')}`
            : '',
          `Required checks: ${plan.config.checks.map((check) => check.command).join('; ')}`,
          'Read and follow the applicable project AGENTS.md, AGENTS.override.md, nested guidance, and local skills before changing files. Follow the project commit-message convention and finish with a concise summary plus a single line: Commit title: <short description of the actual change>.',
        ]
          .filter(Boolean)
          .join('\n\n');
        const implementation = await this.invoke(
          run,
          task.id,
          'implementer',
          task.round,
          task.workspacePath!,
          prompt,
        );
        task.candidateCommit = await this.checkpoint(
          plan,
          task.workspacePath!,
          commitTitle(task.title, implementation.text, Boolean(task.candidateCommit)),
          signal,
        );
        task.status = 'checking';
        this.store.savePlan(plan);
      }
      task.status = 'checking';
      this.store.savePlan(plan);
      this.event(
        plan.id,
        task.id,
        'verifier',
        'state',
        `Running required checks for ${task.id} at ${task.candidateCommit}.`,
      );
      task.checks = await runChecks(
        task.workspacePath!,
        plan.config.checks,
        task.candidateCommit!,
        signal,
        (message) => this.event(plan.id, task.id, 'verifier', 'log', message),
        this.checkSnapshot(plan, task.candidateCommit!, signal),
      );
      await this.saveChecks(plan, task.id, task.round, task.fixAttempts, task.checks);
      this.store.savePlan(plan);
      if (task.checks.some((check) => check.status !== 'passed')) {
        task.fixAttempts++;
        task.status = 'fixing';
        this.store.savePlan(plan);
        if (task.fixAttempts > plan.config.limits.maxFixAttempts)
          throw new Error(
            `${task.id} reached its check-repair limit. Review the failing checks or increase this run’s limits.`,
          );
        this.event(
          plan.id,
          task.id,
          'verifier',
          'check',
          'Checks failed. Sending actual command results to the implementer.',
        );
        continue;
      }
      this.event(
        plan.id,
        task.id,
        'verifier',
        'check',
        'All required checks passed. Starting independent review.',
      );
      task.status = 'reviewing';
      this.store.savePlan(plan);
      const prompt = this.reviewPrompt(
        task.id,
        task.markdown,
        task.baseCommit!,
        task.candidateCommit!,
        task.checks,
        task.reviews.at(-1),
      );
      const result = await this.invoke(
        run,
        task.id,
        'reviewer',
        task.round,
        task.workspacePath!,
        prompt,
      );
      await this.assertSnapshot(plan, task.workspacePath!, task.candidateCommit!, signal);
      const review = await this.saveReview(
        plan,
        task.id,
        task.round,
        task.candidateCommit!,
        parseReview(result.review),
      );
      task.reviews.push(review);
      if (review.verdict === 'approved') {
        task.approvedCommit = task.candidateCommit;
        task.status = 'approved';
        task.summary = review.summary;
        this.store.savePlan(plan);
        await integrateTask(plan, task, signal);
        this.store.savePlan(plan);
        this.event(
          plan.id,
          task.id,
          'controller',
          'state',
          `${task.id} approved ${plan.config.useWorktree ? 'and integrated into the plan branch' : 'on the current branch'}.`,
        );
      } else {
        task.status = 'fixing';
        task.round++;
        this.store.savePlan(plan);
        this.event(
          plan.id,
          task.id,
          'controller',
          'state',
          'Reviewer requested changes. Returning blocking findings to the implementer.',
        );
      }
    }
  }

  private async verifyPlan(run: ActiveRun): Promise<void> {
    const { plan } = run;
    const signal = run.abort.signal;
    if (
      plan.finalReview?.verdict === 'approved' &&
      plan.finalCommit === plan.finalReview.reviewedCommit &&
      plan.integrationChecks.length &&
      plan.integrationChecks.every(
        (check) => check.status === 'passed' && check.commit === plan.finalCommit,
      )
    ) {
      await this.assertSnapshot(plan, plan.workspacePath!, plan.finalCommit!, signal);
      return;
    }
    const allRequirements = plan.tasks.map((task) => `${task.id}:\n${task.markdown}`).join('\n\n');
    while (true) {
      if (signal.aborted) throw new InterruptedError();
      const completedReviews = plan.attempts.filter(
        (attempt) =>
          attempt.taskId === '__plan__' &&
          attempt.role === 'reviewer' &&
          attempt.status === 'completed',
      ).length;
      const round = completedReviews + 1;
      if (round > plan.config.limits.maxReviewRounds)
        throw new Error(
          'Final plan review reached its round limit. Increase this run’s limits to continue.',
        );
      const needsRepair =
        plan.finalReview?.verdict === 'changes_requested' ||
        plan.integrationChecks.some((check) => check.status !== 'passed');
      if (needsRepair) {
        const repairs = plan.attempts.filter(
          (attempt) => attempt.taskId === '__plan__' && attempt.role === 'implementer',
        ).length;
        if (repairs >= plan.config.limits.maxFixAttempts)
          throw new Error('Combined-plan checks reached their repair limit.');
        await this.invoke(
          run,
          '__plan__',
          'implementer',
          round,
          plan.workspacePath!,
          [
            'Repair integration defects in the combined plan. Preserve all task acceptance criteria and add unit regression tests.',
            allRequirements,
            `Latest final review:\n${JSON.stringify(plan.finalReview || null)}`,
            `Combined check results:\n${JSON.stringify(plan.integrationChecks)}`,
          ].join('\n\n'),
        );
        plan.finalCommit = await this.checkpoint(
          plan,
          plan.workspacePath!,
          commitTitle(`Repair ${plan.name}`, undefined, true),
          signal,
        );
        this.store.savePlan(plan);
      }
      plan.finalCommit = await git(plan.workspacePath!, ['rev-parse', 'HEAD'], signal);
      this.event(
        plan.id,
        '__plan__',
        'verifier',
        'state',
        'All tasks are integrated. Running the combined checks and final plan review.',
      );
      plan.integrationChecks = await runChecks(
        plan.workspacePath!,
        plan.config.checks,
        plan.finalCommit,
        signal,
        (message) => this.event(plan.id, '__plan__', 'verifier', 'log', message),
        this.checkSnapshot(plan, plan.finalCommit, signal),
      );
      await this.saveChecks(plan, '__plan__', round, plan.attempts.length, plan.integrationChecks);
      this.store.savePlan(plan);
      if (plan.integrationChecks.some((check) => check.status !== 'passed')) continue;
      const result = await this.invoke(
        run,
        '__plan__',
        'reviewer',
        round,
        plan.workspacePath!,
        this.reviewPrompt(
          '__plan__',
          allRequirements,
          plan.baseCommit!,
          plan.finalCommit,
          plan.integrationChecks,
          plan.finalReview,
        ),
      );
      await this.assertSnapshot(plan, plan.workspacePath!, plan.finalCommit, signal);
      plan.finalReview = await this.saveReview(
        plan,
        '__plan__',
        round,
        plan.finalCommit,
        parseReview(result.review),
      );
      this.store.savePlan(plan);
      if (plan.finalReview.verdict === 'approved') return;
    }
  }

  private reviewPrompt(
    taskId: string,
    markdown: string,
    base: string,
    candidate: string,
    checks: TaskRecord['checks'],
    previous?: ReviewRecord,
  ): string {
    return [
      `Independently review ${taskId === '__plan__' ? 'the entire integrated plan' : `task ${taskId}`}.`,
      `Base commit: ${base}\nCandidate commit: ${candidate}\nInspect git diff ${base} ${candidate} and surrounding files.`,
      'Task acceptance criteria:',
      markdown,
      'The controller ran these checks against the candidate snapshot:',
      JSON.stringify(
        checks.map((check) => ({
          command: check.command,
          status: check.status,
          exitCode: check.exitCode,
          ...(check.workspaceTree ? { workspaceTree: check.workspaceTree } : {}),
          output: check.output.slice(-16_000),
        })),
        null,
        2,
      ),
      previous
        ? `Previous review to verify, in addition to a fresh assessment:\n${JSON.stringify(previous)}`
        : '',
      'Verify that code behavior added or changed has meaningful unit tests, including edge and failure cases. Passing commands alone do not prove adequate tests. Do not request unrelated scope or stylistic preferences as blocking changes.',
      'Return approved only with no blocking findings. For changes_requested, include at least one concrete blocking finding with a requested change and validation. Optional suggestions must be non-blocking. Finding IDs must be unique. Return the supplied JSON schema.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private async invoke(
    run: ActiveRun,
    taskId: string,
    role: AgentRole,
    round: number,
    cwd: string,
    prompt: string,
  ) {
    const { plan } = run;
    if (!plan.config.useWorktree) await assertCurrentBranch(plan, run.abort.signal);
    this.enforceBudgets(run);
    if (run.abort.signal.aborted) throw new InterruptedError();
    const config = plan.config.agents[role];
    const attempt: AgentAttempt = {
      id: randomUUID(),
      taskId,
      role,
      round,
      model: config.model,
      effort: config.effort,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    plan.attempts.push(attempt);
    this.store.savePlan(plan);
    this.event(
      plan.id,
      taskId,
      role,
      'state',
      `${role === 'implementer' ? 'Implementer' : 'Reviewer'} started · ${config.model} · ${config.effort} · round ${round}.`,
    );
    try {
      const result = await this.runtimeFactory(plan.config).run({
        planId: plan.id,
        taskId,
        role,
        round,
        config,
        cwd,
        prompt: plan.config.useWorktree
          ? prompt
          : [
              'This workflow uses the repository’s current branch and working directory, without worktrees. Preserve existing local edits and staging. Do not change branches or commit; the controller commits only the delta from the workflow baseline. Checks include existing local edits; workspaceTree identifies the full tested files.',
              prompt,
            ].join('\n\n'),
        networkAccess: plan.config.networkAccess,
        signal: run.abort.signal,
        onLog: (message) => this.event(plan.id, taskId, role, 'log', message),
        onThread: (threadId) => {
          attempt.threadId = threadId;
          this.store.savePlan(plan);
        },
        onUsage: (usage) => {
          attempt.usage = usage;
          this.store.savePlan(plan);
          this.event(
            plan.id,
            taskId,
            role,
            'usage',
            `${usage.totalTokens.toLocaleString()} reported tokens for this invocation.`,
          );
          this.enforceBudgets(run);
        },
      });
      if (run.abort.signal.aborted) throw new InterruptedError();
      attempt.status = 'completed';
      attempt.summary = result.text.slice(0, 30_000);
      attempt.usage = result.usage || attempt.usage;
      return result;
    } catch (error) {
      attempt.status = run.abort.signal.aborted ? 'interrupted' : 'failed';
      attempt.error = (error as Error).message;
      throw error;
    } finally {
      attempt.completedAt = new Date().toISOString();
      this.store.savePlan(plan);
    }
  }

  private async saveReview(
    plan: PlanRecord,
    taskId: string,
    round: number,
    commit: string,
    verdict: ReviewVerdict,
  ): Promise<ReviewRecord> {
    const directory = plan.artifactsPath
      ? path.join(
          plan.artifactsPath,
          taskId === '__plan__' ? 'final' : path.join('tasks', taskId),
          'reports',
        )
      : path.join(this.store.directory, 'reports', plan.id, taskId);
    await mkdir(directory, { recursive: true });
    const id = randomUUID();
    const markdownPath = path.join(
      directory,
      `round-${String(round).padStart(2, '0')}-${id.slice(0, 8)}.md`,
    );
    const review: ReviewRecord = {
      ...verdict,
      id,
      taskId,
      round,
      reviewedCommit: commit,
      ...(!plan.config.useWorktree
        ? { reviewedWorkspaceTree: plan.currentBranchSnapshot!.tree }
        : {}),
      createdAt: new Date().toISOString(),
      markdownPath,
    };
    await writeFile(markdownPath, renderReview(review), 'utf8');
    await writeFile(
      markdownPath.replace(/\.md$/, '.json'),
      JSON.stringify(review, null, 2) + '\n',
      'utf8',
    );
    this.event(
      plan.id,
      taskId,
      'reviewer',
      'review',
      `${verdict.verdict}: ${verdict.summary}\nReport: ${markdownPath}`,
    );
    return review;
  }

  private async saveChecks(
    plan: PlanRecord,
    taskId: string,
    round: number,
    fix: number,
    checks: TaskRecord['checks'],
  ): Promise<void> {
    const directory = plan.artifactsPath
      ? path.join(
          plan.artifactsPath,
          taskId === '__plan__' ? 'final' : path.join('tasks', taskId),
          'reports',
        )
      : path.join(this.store.directory, 'reports', plan.id, taskId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `checks-round-${round}-attempt-${fix}-${randomUUID().slice(0, 8)}.json`),
      JSON.stringify(checks, null, 2) + '\n',
      'utf8',
    );
  }
}
