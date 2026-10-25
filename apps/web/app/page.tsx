'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Bot,
  Boxes,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Clock3,
  Code2,
  FileCode2,
  FileText,
  FlaskConical,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Layers3,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import type {
  AgentRole,
  CheckDefinition,
  DashboardState,
  FlowConfig,
  FlowEvent,
  PlanRecord,
  ProjectRecord,
  ReviewRecord,
  TaskDefinition,
} from '@ai-flow/shared';
import {
  compactNumber,
  formatDuration,
  modelLabel,
  planProgress,
  statusLabel,
  usageSummary,
} from './helpers';

import { FolderPicker } from './folder-picker';

type View = 'workflows' | 'agents' | 'settings' | 'guide';
type Tab = 'activity' | 'reviews' | 'checks' | 'changes' | 'usage';

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${url}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    cache: 'no-store',
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || result.message || `Request failed (${response.status}).`);
  return result as T;
}

function Status({ status, small = false }: { status: string; small?: boolean }) {
  const spinning = ['running', 'implementing', 'checking', 'reviewing', 'fixing'].includes(status);
  return (
    <span className={`status status-${status} ${small ? 'status-small' : ''}`}>
      {spinning ? (
        <LoaderCircle size={12} className="spin" />
      ) : ['approved', 'completed', 'passed'].includes(status) ? (
        <Check size={12} />
      ) : (
        <span className="status-dot" />
      )}
      {statusLabel(status)}
    </span>
  );
}

export default function Home() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [view, setView] = useState<View>('workflows');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showAddProject, setShowAddProject] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const requestedCatalogs = useRef(new Set<string>());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('activity');
  const [draft, setDraft] = useState<FlowConfig | null>(null);
  const [showNewRun, setShowNewRun] = useState(false);
  const [showLimits, setShowLimits] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [offline, setOffline] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const [events, setEvents] = useState<FlowEvent[]>([]);
  const [filter, setFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [follow, setFollow] = useState(true);
  const logEnd = useRef<HTMLDivElement>(null);
  const refreshing = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (showNewRun || showAddProject || removeId) setNotice(null);
  }, [showNewRun, showAddProject, removeId]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.error ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const result = await api<DashboardState>('/state');
      setState(result);
      setOffline(false);
      setDraft((current) => current || structuredClone(result.config));
      setSelectedId((current) => current || result.plans[0]?.id || null);
    } catch {
      setOffline(true);
    } finally {
      refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const polling = setInterval(() => {
      void refresh();
    }, 5000);
    const source = new EventSource('/api/stream');
    source.addEventListener('connected', () => setStreamConnected(true));
    source.addEventListener('flow', () => {
      if (refreshTimer.current) return;
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        void refresh();
      }, 450);
    });
    source.onerror = () => setStreamConnected(false);
    source.onopen = () => setStreamConnected(true);
    return () => {
      clearInterval(polling);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      source.close();
    };
  }, [refresh]);

  const project =
    selectedProjectId === 'global'
      ? undefined
      : state?.projects.find((item) => item.id === selectedProjectId) || state?.projects[0];
  const plans = state?.plans.filter((item) => item.projectId === project?.id) || [];
  const projectActive = plans.some((item) => state?.activePlanIds.includes(item.id));
  const plan = plans.find((item) => item.id === selectedId) || plans[0];
  const savedConfig = project?.config || state?.config;
  const runtime = project
    ? state?.projectRuntimes[project.id] || null
    : state?.projectRuntimes.global || null;

  const selectProject = (next: ProjectRecord) => {
    setSelectedProjectId(next.id);
    setSelectedId(null);
    setDraft(structuredClone(next.config));
    setView('workflows');
  };
  useEffect(() => {
    setDraft(savedConfig ? structuredClone(savedConfig) : null);
    setSelectedId(null);
  }, [project?.id]);
  useEffect(() => {
    if (!state) return;
    const key = project?.id || 'global';
    if (runtime || requestedCatalogs.current.has(key)) return;
    requestedCatalogs.current.add(key);
    void api<NonNullable<DashboardState['runtime']>>(
      `/runtime/refresh${project ? `?projectId=${encodeURIComponent(project.id)}` : ''}`,
      { method: 'POST', body: '{}' },
    )
      .then(() => void refresh())
      .catch(() => {});
  }, [project?.id, runtime, state, refresh]);
  const selectedTask = plan?.tasks.find((task) => task.id === selectedTaskId);
  const runningTask = plan?.tasks.find((task) =>
    ['implementing', 'checking', 'reviewing', 'fixing'].includes(task.status),
  );
  const activeAttempt = [...(plan?.attempts || [])]
    .reverse()
    .find((attempt) => attempt.status === 'running');
  const progress = plan ? planProgress(plan) : null;
  const usage = usageSummary(plan?.attempts || []);
  const allAttempts = plans.flatMap((item) => item.attempts) || [];
  const allUsage = usageSummary(allAttempts);
  const completedTasks =
    plans.reduce(
      (sum, item) => sum + item.tasks.filter((task) => task.status === 'approved').length,
      0,
    ) || 0;
  const reviews = plan
    ? [
        ...plan.tasks.flatMap((task) => task.reviews),
        ...(plan.finalReview ? [plan.finalReview] : []),
      ]
    : [];
  const filteredReviews = selectedTaskId
    ? reviews.filter((review) => review.taskId === selectedTaskId)
    : reviews;
  const visibleChecks = selectedTask
    ? selectedTask.checks
    : plan?.integrationChecks.length
      ? plan.integrationChecks
      : runningTask?.checks ||
        [...(plan?.tasks || [])].reverse().find((task) => task.checks.length)?.checks ||
        [];
  const dirty = Boolean(draft && state && JSON.stringify(draft) !== JSON.stringify(savedConfig));

  useEffect(() => {
    setSelectedTaskId(null);
  }, [plan?.id]);
  useEffect(() => {
    if (!plan) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    void api<FlowEvent[]>(`/events?planId=${encodeURIComponent(plan.id)}`)
      .then((result) => {
        if (!cancelled) setEvents(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [plan?.id, plan?.updatedAt]);
  useEffect(() => {
    if (follow && tab === 'activity') logEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [events.length, follow, tab]);

  const act = async (label: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(label);
    try {
      await action();
      if (success) setNotice({ text: success });
      await refresh();
    } catch (error) {
      setNotice({ text: (error as Error).message, error: true });
    } finally {
      setBusy(null);
    }
  };

  const startDemo = () =>
    void act(
      'demo',
      async () => {
        const created = await api<PlanRecord>('/demo', {
          method: 'POST',
          body: JSON.stringify({ start: true }),
        });
        setSelectedId(created.id);
        setSelectedProjectId(created.projectId || null);
        setView('workflows');
        setTab('activity');
      },
      'Demo started. No model calls are made; files, tests, and commits are real.',
    );

  const control = (action: string) =>
    plan &&
    void act(action, () => api(`/plans/${plan.id}/${action}`, { method: 'POST', body: '{}' }));
  const refreshModels = () =>
    void act(
      'models',
      async () => {
        const runtime = await api<DashboardState['runtime']>(
          `/runtime/refresh${project ? `?projectId=${encodeURIComponent(project.id)}` : ''}`,
          {
            method: 'POST',
            body: '{}',
          },
        );
        await refresh();
        if (!runtime?.available || !runtime.authenticated || runtime.projectConfigError)
          throw new Error(runtime?.message || 'Codex is unavailable.');
      },
      'Codex model catalog refreshed.',
    );

  const filteredEvents = events.filter(
    (event) =>
      (!selectedTaskId || event.taskId === selectedTaskId) &&
      (roleFilter === 'all' || event.role === roleFilter) &&
      (!filter || event.message.toLowerCase().includes(filter.toLowerCase())),
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="AI Flow home">
          <span className="brand-icon">
            <Workflow size={22} strokeWidth={2.3} />
          </span>
          <span>
            AI Flow<span className="brand-period">.</span>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">{project?.name[0]?.toUpperCase() || 'L'}</span>
          <div>
            {project?.name || 'Local workspace'}
            <small>{project ? 'Project workspace' : 'Add a project to begin'}</small>
          </div>
          <span className="local-dot" />
        </div>
        <div className="project-list">
          <div className="project-list-heading">
            <span>PROJECTS</span>
            <button
              className="icon-button"
              aria-label="Add project"
              onClick={() => setShowAddProject(true)}
            >
              <Plus size={16} />
            </button>
          </div>
          {state?.projects.map((item) => {
            const workflows = state.plans.filter((flow) => flow.projectId === item.id);
            const running = workflows.filter((flow) => flow.status === 'running').length;
            return (
              <button
                key={item.id}
                title={item.repositoryPath}
                aria-pressed={project?.id === item.id}
                className={`project-item ${project?.id === item.id ? 'selected' : ''}`}
                onClick={() => selectProject(item)}
              >
                <FolderGit2 size={16} />
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {running ? `${running} running · ` : ''}
                    {workflows.length} workflows
                  </small>
                </span>
                {running > 0 && <span className="local-dot" />}
              </button>
            );
          })}
          {!state?.projects.length && (
            <button className="project-item" onClick={() => setShowAddProject(true)}>
              <Plus size={16} />
              Add your first project
            </button>
          )}
        </div>
        <button
          className="global-defaults"
          onClick={() => {
            setSelectedProjectId('global');
            setDraft(state ? structuredClone(state.config) : null);
            setView('settings');
          }}
        >
          <Settings2 size={13} />
          Global defaults
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          <button
            className={`nav-item ${view === 'workflows' ? 'active' : ''}`}
            onClick={() => setView('workflows')}
          >
            <Workflow size={18} />
            Workflows<span className="nav-count">{plans.length}</span>
          </button>
          <button
            className={`nav-item ${view === 'agents' ? 'active' : ''}`}
            onClick={() => setView('agents')}
          >
            <Bot size={18} />
            Agents<span className="nav-subtle">2</span>
          </button>
          <button
            className={`nav-item ${view === 'settings' ? 'active' : ''}`}
            onClick={() => setView('settings')}
          >
            <Settings2 size={18} />
            Settings
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="loop-note">
            <span className="tiny-overline">BUILT TO FOLLOW THROUGH</span>
            <div className="loop-glyph">
              <Code2 size={19} />
              <span /> <ShieldCheck size={19} />
              <span />
              <CheckCheck size={19} />
            </div>
            <p>
              Implement. Verify.
              <br />
              Review. Improve.
            </p>
          </div>
          <button
            className={`nav-item ${view === 'guide' ? 'active' : ''}`}
            onClick={() => setView('guide')}
          >
            <BookOpen size={18} />
            Getting started
            <ArrowUpRight size={14} className="push-right" />
          </button>
          <div className="sidebar-footer">
            <span className="small-logo">AF</span>
            <div>
              Your local controller<small>v0.1.0 · Runs on your machine</small>
            </div>
          </div>
        </div>
      </aside>

      <div className="workspace-main">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>{project?.name || 'Workspace'}</span>
            <ChevronRight size={13} />
            <strong>{view === 'workflows' ? 'Workflows' : statusLabel(view)}</strong>
          </div>
          <div className="topbar-right">
            <span className={`connection ${!offline && streamConnected ? 'connected' : ''}`}>
              <span />
              {offline ? 'Controller offline' : streamConnected ? 'Live connection' : 'Connecting'}
            </span>
            <span className="topbar-divider" />
            <span className="local-chip">
              <Terminal size={13} />
              localhost
            </span>
          </div>
        </header>

        <main>
          {offline && (
            <div className="error-banner">
              <Radio size={17} />
              <span>
                Can’t reach the local controller. Start it with <code>npm run dev</code>.
                Reconnecting automatically.
              </span>
              <button onClick={() => void refresh()}>
                <RefreshCw size={14} />
                Retry
              </button>
            </div>
          )}
          {!state ? (
            <div className="initial-loading">
              <div className="brand-icon">
                <Workflow size={25} />
              </div>
              <h1>Opening your workspace</h1>
              <p>{offline ? 'Waiting for the local controller…' : 'Connecting to AI Flow…'}</p>
              <LoaderCircle className="spin" size={20} />
            </div>
          ) : (
            <>
              {view === 'workflows' && (
                <>
                  <section className="page-heading">
                    <div>
                      <div className="eyebrow">
                        <span />
                        AGENT WORKSPACE
                      </div>
                      <h1>Good code is a team effort.</h1>
                      <p>
                        {project
                          ? project.repositoryPath
                          : 'Add a project folder to start creating workflows.'}
                      </p>
                    </div>
                    <div className="heading-actions">
                      <button
                        className="button secondary"
                        onClick={startDemo}
                        disabled={Boolean(busy)}
                      >
                        {busy === 'demo' ? (
                          <LoaderCircle size={15} className="spin" />
                        ) : (
                          <FlaskConical size={16} />
                        )}
                        Try a demo
                      </button>
                      <button
                        className="button primary"
                        onClick={() => (project ? setShowNewRun(true) : setShowAddProject(true))}
                      >
                        <Plus size={17} />
                        {project ? 'New workflow' : 'Add project'}
                      </button>
                    </div>
                  </section>

                  <section className="stats-grid" aria-label="Workspace metrics">
                    <Metric
                      icon={<Layers3 size={17} />}
                      label="Total runs"
                      value={String(plans.length)}
                      detail={`${plans.filter((item) => item.status === 'running').length} active right now`}
                    />
                    <Metric
                      icon={<CheckCheck size={17} />}
                      label="Tasks approved"
                      value={String(completedTasks)}
                      detail="Independent review complete"
                      green
                    />
                    <Metric
                      icon={<Zap size={17} />}
                      label="Tokens reported"
                      value={allUsage.available ? compactNumber(allUsage.total) : '—'}
                      detail={
                        allUsage.available
                          ? 'Across recorded model invocations'
                          : 'Usage appears after a model call'
                      }
                    />
                    <Metric
                      icon={<GitPullRequest size={17} />}
                      label="Review rounds"
                      value={String(
                        plans.reduce(
                          (sum, item) =>
                            sum +
                            item.tasks.reduce((count, task) => count + task.reviews.length, 0) +
                            (item.finalReview ? 1 : 0),
                          0,
                        ),
                      )}
                      detail="Every finding gets a resolution"
                    />
                  </section>

                  <section className="workspace-section">
                    <div className="section-title">
                      <div>
                        <h2>
                          Workflow runs <span className="count-tag">{plans.length}</span>
                        </h2>
                        <p>A clear view of what’s happening, and what happens next.</p>
                      </div>
                      <button
                        className="text-button"
                        onClick={() => void refresh()}
                        aria-label="Refresh workflows"
                      >
                        <RefreshCw size={14} />
                        Refresh
                      </button>
                    </div>
                    {!plan ? (
                      <EmptyWorkspace
                        onDemo={startDemo}
                        onCreate={() => (project ? setShowNewRun(true) : setShowAddProject(true))}
                        busy={Boolean(busy)}
                      />
                    ) : (
                      <div className="run-layout">
                        <div className="runs-list">
                          {plans.map((item) => (
                            <div className="run-card-wrapper" key={item.id}>
                              <button
                                className={`run-card ${item.id === plan.id ? 'selected' : ''}`}
                                key={item.id}
                                onClick={() => setSelectedId(item.id)}
                              >
                                <div className="run-card-top">
                                  <span className="run-mini-icon">
                                    <Workflow size={15} />
                                  </span>
                                  <Status status={item.status} small />
                                </div>
                                <strong>{item.name}</strong>
                                <div className="run-card-meta">
                                  {item.config.runtime === 'demo' ? (
                                    <FlaskConical size={12} />
                                  ) : (
                                    <FolderGit2 size={12} />
                                  )}
                                  <span>
                                    {item.config.runtime === 'demo'
                                      ? 'Isolated demo'
                                      : item.config.repositoryPath
                                          .split('/')
                                          .filter(Boolean)
                                          .at(-1)}
                                  </span>
                                </div>
                                <div className="run-card-bottom">
                                  <span>
                                    {planProgress(item).approved}/{item.tasks.length} tasks
                                  </span>
                                  <span>
                                    {new Date(item.createdAt).toLocaleDateString(undefined, {
                                      month: 'short',
                                      day: 'numeric',
                                    })}
                                  </span>
                                </div>
                                <div className="mini-progress">
                                  <span style={{ width: `${planProgress(item).percent}%` }} />
                                </div>
                              </button>
                              <button
                                className="icon-button run-remove danger-text"
                                aria-label={`Remove ${item.name}`}
                                title="Remove workflow"
                                disabled={Boolean(busy)}
                                onClick={() => setRemoveId(item.id)}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          ))}
                        </div>

                        <div className="run-detail">
                          <div className="run-detail-heading">
                            <div>
                              <div className="run-id">
                                RUN / {plan.id.slice(0, 8).toUpperCase()}{' '}
                                {plan.config.runtime === 'demo' && (
                                  <span className="demo-label">DEMO · NO MODEL CALLS</span>
                                )}
                              </div>
                              <h3>{plan.name}</h3>
                              <div className="run-description">
                                <GitBranch size={13} />
                                <span title={plan.branch || plan.config.repositoryPath}>
                                  {plan.branch || 'Workspace will be created when the run starts'}
                                </span>
                              </div>
                            </div>
                            <div className="run-controls">
                              <Status status={plan.status} />
                              {plan.status === 'running' ? (
                                <>
                                  <button
                                    className="icon-button"
                                    title="Pause run"
                                    aria-label="Pause run"
                                    disabled={Boolean(busy)}
                                    onClick={() => control('pause')}
                                  >
                                    <Pause size={16} />
                                  </button>
                                  <button
                                    className="icon-button"
                                    title="Cancel run"
                                    aria-label="Cancel run"
                                    disabled={Boolean(busy)}
                                    onClick={() => control('cancel')}
                                  >
                                    <Square size={14} />
                                  </button>
                                </>
                              ) : ['queued', 'paused', 'needs_attention'].includes(plan.status) ? (
                                <>
                                  <button
                                    className="button primary small"
                                    disabled={Boolean(busy) || projectActive}
                                    onClick={() => control('start')}
                                  >
                                    <Play size={14} />
                                    {plan.status === 'queued' ? 'Start' : 'Resume'}
                                  </button>
                                  <button
                                    className="icon-button"
                                    title="Adjust run limits"
                                    aria-label="Adjust run limits"
                                    onClick={() => setShowLimits(true)}
                                  >
                                    <Settings2 size={16} />
                                  </button>
                                  <button
                                    className="icon-button"
                                    title="Cancel run"
                                    aria-label="Cancel run"
                                    disabled={Boolean(busy)}
                                    onClick={() => control('cancel')}
                                  >
                                    <Square size={14} />
                                  </button>
                                </>
                              ) : null}
                              <button
                                className="icon-button danger-text"
                                title="Remove workflow"
                                aria-label="Remove workflow"
                                disabled={Boolean(busy)}
                                onClick={() => setRemoveId(plan.id)}
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </div>
                          <div className="project-paths">
                            <span>
                              Project: <code>{plan.config.repositoryPath}</code>
                            </span>
                            {plan.workspacePath && (
                              <span>
                                Execution workspace: <code>{plan.workspacePath}</code>
                              </span>
                            )}
                            {plan.artifactsPath && (
                              <span>
                                Documents: <code>{plan.artifactsPath}</code>
                              </span>
                            )}
                          </div>
                          {plan.error && (
                            <div
                              className={`run-alert ${plan.status === 'paused' ? 'neutral' : ''}`}
                            >
                              <CircleDot size={16} />
                              <span>{plan.error}</span>
                            </div>
                          )}
                          <div className="run-overview">
                            <div>
                              <span className="field-label">PROGRESS</span>
                              <strong>
                                {progress!.approved}
                                <span> / {progress!.total} tasks approved</span>
                              </strong>
                              <div className="progress-track">
                                <span style={{ width: `${progress!.percent}%` }} />
                              </div>
                            </div>
                            <div>
                              <span className="field-label">ELAPSED</span>
                              <strong>
                                <Clock3 size={16} />
                                {formatDuration(plan.elapsedMs)}
                              </strong>
                            </div>
                            <div>
                              <span className="field-label">TOKENS</span>
                              <strong>
                                <Zap size={16} />
                                {usage.available ? compactNumber(usage.total) : '—'}
                              </strong>
                            </div>
                            <div>
                              <span className="field-label">CURRENT STEP</span>
                              <strong className="current-step">
                                {plan.status === 'completed'
                                  ? 'All checks approved'
                                  : activeAttempt
                                    ? `${statusLabel(activeAttempt.role)} · round ${activeAttempt.round}`
                                    : runningTask
                                      ? statusLabel(runningTask.status)
                                      : plan.status === 'running'
                                        ? 'Preparing workspace'
                                        : 'Ready when you are'}
                              </strong>
                            </div>
                          </div>
                          <div className="loop-strip">
                            {[
                              { name: 'Investigate', icon: Search, match: 'implementing' },
                              { name: 'Implement', icon: Code2, match: 'fixing' },
                              { name: 'Verify', icon: CheckCheck, match: 'checking' },
                              { name: 'Review', icon: ShieldCheck, match: 'reviewing' },
                            ].map((stage, index) => (
                              <div
                                className={`loop-stage ${plan.status === 'completed' ? 'done' : plan.status === 'running' && (runningTask?.status === stage.match || (!runningTask && activeAttempt?.role === 'reviewer' && index === 3)) ? 'current' : ''}`}
                                key={stage.name}
                              >
                                <span>
                                  <stage.icon size={15} />
                                </span>
                                {stage.name}
                                {index < 3 && <ArrowRight size={13} className="stage-arrow" />}
                              </div>
                            ))}
                            <div className="loop-return">
                              <RefreshCw size={13} />
                              Until approved
                            </div>
                          </div>
                          <div className="task-list-heading">
                            <span>TASKS IN THIS PLAN</span>
                            <span>DEPENDENCIES · CHECKS · REVIEW</span>
                          </div>
                          <div className="task-list">
                            {plan.tasks.map((task, index) => (
                              <button
                                className={`task-row ${selectedTaskId === task.id ? 'task-selected' : ''}`}
                                onClick={() =>
                                  setSelectedTaskId((current) =>
                                    current === task.id ? null : task.id,
                                  )
                                }
                                key={task.id}
                              >
                                <span
                                  className={`task-number ${task.status === 'approved' ? 'complete' : ''}`}
                                >
                                  {task.status === 'approved' ? (
                                    <Check size={14} />
                                  ) : (
                                    String(index + 1).padStart(2, '0')
                                  )}
                                </span>
                                <div className="task-title">
                                  <strong>{task.title}</strong>
                                  <span>
                                    {task.id}
                                    {task.dependsOn.length > 0 && (
                                      <>
                                        {' '}
                                        <span className="meta-separator">/</span> after{' '}
                                        {task.dependsOn.join(', ')}
                                      </>
                                    )}
                                  </span>
                                </div>
                                <span className="task-checks">
                                  {task.checks.length ? (
                                    <>
                                      <CheckCheck size={13} />
                                      {
                                        task.checks.filter((check) => check.status === 'passed')
                                          .length
                                      }
                                      /{task.checks.length}
                                    </>
                                  ) : (
                                    '—'
                                  )}
                                </span>
                                <Status status={task.status} small />
                                <ChevronRight size={15} className="task-chevron" />
                              </button>
                            ))}
                          </div>
                          {plan.status === 'completed' && (
                            <div className="delivery-note">
                              <CheckCircle2 size={17} />
                              <div>
                                <strong>Reviewed and ready.</strong> Changes are on{' '}
                                <code>{plan.branch}</code>. Your source branch is unchanged.
                                <small>Final commit: {plan.finalCommit}</small>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </section>

                  {plan && (
                    <>
                      <div className="agents-strip">
                        {(['implementer', 'reviewer'] as const).map((role) => {
                          const isActive =
                            plan.status === 'running' && activeAttempt?.role === role;
                          return (
                            <div
                              className={`agent-card ${isActive ? 'agent-active' : ''}`}
                              key={role}
                            >
                              <div className={`agent-avatar ${role}`}>
                                {role === 'implementer' ? (
                                  <Code2 size={20} />
                                ) : (
                                  <ShieldCheck size={20} />
                                )}
                              </div>
                              <div>
                                <div className="agent-title">
                                  {statusLabel(role)}
                                  <span className={`agent-presence ${isActive ? 'working' : ''}`}>
                                    {isActive ? 'Working' : 'Standby'}
                                  </span>
                                </div>
                                <span className="agent-model">
                                  {modelLabel(plan.config.agents[role].model)}
                                  <span>·</span>
                                  {statusLabel(plan.config.agents[role].effort)}
                                </span>
                              </div>
                              <button
                                className="text-button push-right"
                                onClick={() => setView('agents')}
                                aria-label={`Configure ${role}`}
                              >
                                <Settings2 size={15} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                      <section className="inspector">
                        <div className="inspector-top">
                          <div className="tabs" role="tablist" aria-label="Run details">
                            {(
                              [
                                { id: 'activity', label: 'Activity', icon: Activity },
                                { id: 'reviews', label: 'Reviews', icon: GitPullRequest },
                                { id: 'checks', label: 'Checks', icon: CheckCheck },
                                { id: 'changes', label: 'Changes', icon: FileCode2 },
                                { id: 'usage', label: 'Usage', icon: Zap },
                              ] as const
                            ).map((item) => (
                              <button
                                role="tab"
                                aria-selected={tab === item.id}
                                className={tab === item.id ? 'tab active' : 'tab'}
                                onClick={() => setTab(item.id)}
                                key={item.id}
                              >
                                <item.icon size={15} />
                                {item.label}
                                {item.id === 'reviews' && reviews.length > 0 && (
                                  <span>{reviews.length}</span>
                                )}
                              </button>
                            ))}
                          </div>
                          <select
                            className="task-filter"
                            aria-label="Filter details by task"
                            value={selectedTaskId || ''}
                            onChange={(event) => setSelectedTaskId(event.target.value || null)}
                          >
                            <option value="">Entire run</option>
                            {plan.tasks.map((task) => (
                              <option value={task.id} key={task.id}>
                                {task.id}
                              </option>
                            ))}
                          </select>
                        </div>
                        {tab === 'activity' && (
                          <>
                            <div className="log-toolbar">
                              <div className="log-search">
                                <Search size={13} />
                                <input
                                  placeholder="Filter activity…"
                                  aria-label="Filter activity"
                                  value={filter}
                                  onChange={(event) => setFilter(event.target.value)}
                                />
                              </div>
                              <select
                                aria-label="Filter activity by role"
                                value={roleFilter}
                                onChange={(event) => setRoleFilter(event.target.value)}
                              >
                                <option value="all">All roles</option>
                                <option value="controller">Controller</option>
                                <option value="implementer">Implementer</option>
                                <option value="reviewer">Reviewer</option>
                                <option value="verifier">Verifier</option>
                              </select>
                              <label className="follow-toggle">
                                <input
                                  type="checkbox"
                                  checked={follow}
                                  onChange={(event) => setFollow(event.target.checked)}
                                />
                                Follow logs
                              </label>
                              <span className="log-count">{filteredEvents.length} events</span>
                            </div>
                            <div className="log-view" aria-label="Run activity">
                              {!filteredEvents.length ? (
                                <div className="panel-empty">
                                  <Terminal size={24} />
                                  <p>
                                    {filter || selectedTaskId
                                      ? 'No activity matches this filter.'
                                      : 'Activity will appear when the run starts.'}
                                  </p>
                                </div>
                              ) : (
                                filteredEvents.map((event) => (
                                  <div className={`log-row log-${event.type}`} key={event.id}>
                                    <time>
                                      {new Date(event.createdAt).toLocaleTimeString([], {
                                        hour12: false,
                                      })}
                                    </time>
                                    <span className={`log-role role-${event.role}`}>
                                      {event.role}
                                    </span>
                                    <pre>{event.message}</pre>
                                  </div>
                                ))
                              )}
                              <div ref={logEnd} />
                            </div>
                          </>
                        )}
                        {tab === 'reviews' && (
                          <div className="reviews-panel">
                            {!filteredReviews.length ? (
                              <PanelEmpty
                                icon={<ShieldCheck size={25} />}
                                text="Independent reviews will appear here after checks pass."
                              />
                            ) : (
                              filteredReviews.map((review) => (
                                <ReviewCard key={review.id} review={review} planId={plan.id} />
                              ))
                            )}
                          </div>
                        )}
                        {tab === 'checks' && (
                          <div className="checks-panel">
                            {!visibleChecks.length ? (
                              <PanelEmpty
                                icon={<CheckCheck size={25} />}
                                text="The verifier hasn’t run checks for this selection yet."
                              />
                            ) : (
                              visibleChecks.map((check, index) => (
                                <details className="check-card" key={`${check.id}-${index}`}>
                                  <summary>
                                    <span className={`check-result-icon ${check.status}`}>
                                      {check.status === 'passed' ? (
                                        <Check size={16} />
                                      ) : (
                                        <X size={16} />
                                      )}
                                    </span>
                                    <div>
                                      <strong>{check.name}</strong>
                                      <code>{check.command}</code>
                                    </div>
                                    <span className="muted">
                                      {formatDuration(check.durationMs)}
                                    </span>
                                    <Status status={check.status} small />
                                    <ChevronDown size={15} />
                                  </summary>
                                  <div className="check-output">
                                    <div>
                                      Commit {check.commit.slice(0, 12)} · exit{' '}
                                      {check.exitCode ?? 'none'}
                                    </div>
                                    <pre>{check.output || 'Command completed without output.'}</pre>
                                  </div>
                                </details>
                              ))
                            )}
                          </div>
                        )}
                        {tab === 'changes' && <DiffPanel plan={plan} taskId={selectedTaskId} />}
                        {tab === 'usage' && (
                          <div className="usage-panel">
                            <div className="usage-note">
                              <Zap size={16} />
                              <span>
                                {plan.config.runtime === 'demo'
                                  ? 'Demo agents make no model calls. Token usage and billing are not simulated.'
                                  : 'Usage comes from runtime reports. Cached input is included in input; reasoning is included in output. Unreported usage is shown as unknown.'}
                              </span>
                            </div>
                            <div className="usage-metrics">
                              <div>
                                <small>Input tokens</small>
                                <strong>
                                  {usage.available ? usage.input.toLocaleString() : '—'}
                                </strong>
                              </div>
                              <div>
                                <small>Cached input</small>
                                <strong>
                                  {usage.available ? usage.cached.toLocaleString() : '—'}
                                </strong>
                              </div>
                              <div>
                                <small>Output tokens</small>
                                <strong>
                                  {usage.available ? usage.output.toLocaleString() : '—'}
                                </strong>
                              </div>
                              <div>
                                <small>Total reported</small>
                                <strong>
                                  {usage.available ? usage.total.toLocaleString() : '—'}
                                </strong>
                              </div>
                            </div>
                            <div className="table-scroll">
                              <table className="usage-table">
                                <thead>
                                  <tr>
                                    <th>Agent / task</th>
                                    <th>Model</th>
                                    <th>Effort</th>
                                    <th>Tokens</th>
                                    <th>Duration</th>
                                    <th>Status</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {plan.attempts
                                    .filter(
                                      (attempt) =>
                                        !selectedTaskId || attempt.taskId === selectedTaskId,
                                    )
                                    .map((attempt) => (
                                      <tr key={attempt.id}>
                                        <td>
                                          <strong>{statusLabel(attempt.role)}</strong>
                                          <small>
                                            {attempt.taskId === '__plan__'
                                              ? 'Final plan review'
                                              : attempt.taskId}{' '}
                                            · round {attempt.round}
                                          </small>
                                        </td>
                                        <td>{modelLabel(attempt.model)}</td>
                                        <td>{statusLabel(attempt.effort)}</td>
                                        <td>
                                          {attempt.usage?.source === 'reported'
                                            ? attempt.usage.totalTokens.toLocaleString()
                                            : '—'}
                                        </td>
                                        <td>
                                          {attempt.completedAt
                                            ? formatDuration(
                                                Date.parse(attempt.completedAt) -
                                                  Date.parse(attempt.startedAt),
                                              )
                                            : 'In progress'}
                                        </td>
                                        <td>
                                          <Status status={attempt.status} small />
                                        </td>
                                      </tr>
                                    ))}
                                </tbody>
                              </table>
                            </div>
                            <div className="budget-line">
                              <span>Reported token budget</span>
                              <strong>
                                {usage.available ? compactNumber(usage.total) : '—'} /{' '}
                                {compactNumber(plan.config.limits.maxTokens)}
                              </strong>
                            </div>
                            <div className="progress-track">
                              <span
                                style={{
                                  width: `${Math.min(100, (usage.total / plan.config.limits.maxTokens) * 100)}%`,
                                }}
                              />
                            </div>
                            <p className="footnote">
                              Token limits are enforced as usage arrives and may overshoot during an
                              in-flight request. This view is an activity ledger, not an invoice;
                              subscription credits and API billing differ. Nested-agent usage
                              depends on what the runtime reports.
                            </p>
                          </div>
                        )}
                      </section>
                      <div className="run-footer">
                        <span>
                          <ShieldCheck size={13} />
                          Approvals are bound to exact commits.
                        </span>
                        <span>
                          <FolderGit2 size={13} />
                          Workspaces and reports stay on your machine.
                        </span>
                      </div>
                    </>
                  )}
                </>
              )}

              {(view === 'settings' || view === 'agents') && draft && (
                <SettingsView
                  draft={draft}
                  onChange={setDraft}
                  view={view}
                  state={{ ...state, runtime }}
                  project={project}
                  busy={busy}
                  onRefreshModels={refreshModels}
                  onSave={() =>
                    void act(
                      'save',
                      async () => {
                        const result = project
                          ? (
                              await api<ProjectRecord>(`/projects/${project.id}`, {
                                method: 'PUT',
                                body: JSON.stringify({ config: draft }),
                              })
                            ).config
                          : await api<FlowConfig>('/config', {
                              method: 'PUT',
                              body: JSON.stringify(draft),
                            });
                        setDraft(structuredClone(result));
                      },
                      'Settings saved for new runs.',
                    )
                  }
                  dirty={dirty}
                />
              )}
              {view === 'guide' && (
                <Guide
                  onSettings={() => setView('settings')}
                  onDemo={startDemo}
                  busy={Boolean(busy)}
                />
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              AI Flow <span className="footer-dot">/</span> A little structure. Better software.
            </span>
            <span>
              LOCAL FIRST <span className="footer-dot">·</span> TYPESCRIPT
            </span>
          </footer>
        </main>
      </div>

      {notice && (
        <div
          className={`toast ${notice.error ? 'toast-error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          <span>{notice.error ? <CircleDot size={17} /> : <CheckCircle2 size={17} />}</span>
          <p>{notice.text}</p>
          <button onClick={() => setNotice(null)} aria-label="Dismiss notification">
            <X size={16} />
          </button>
        </div>
      )}
      {showAddProject && (
        <AddProjectModal
          busy={busy === 'project'}
          onClose={() => setShowAddProject(false)}
          onAdd={async (input) => {
            await act(
              'project',
              async () => {
                const added = await api<ProjectRecord>('/projects', {
                  method: 'POST',
                  body: JSON.stringify(input),
                });
                selectProject(added);
                setShowAddProject(false);
              },
              'Project ready. Configure its checks and task path in Settings.',
            );
          }}
        />
      )}
      {removeId && (
        <Modal
          title="Remove workflow"
          description="Remove this workflow from the dashboard. Project documents, code, and Git commits stay on disk. An active workflow will be stopped first."
          onClose={() => setRemoveId(null)}
        >
          <div className="modal-actions">
            <button className="button secondary" onClick={() => setRemoveId(null)}>
              Keep workflow
            </button>
            <button
              className="button primary"
              disabled={Boolean(busy)}
              onClick={() =>
                void act(
                  'remove',
                  async () => {
                    await api(`/plans/${removeId}`, { method: 'DELETE' });
                    setSelectedId(null);
                    setRemoveId(null);
                  },
                  'Workflow removed. Project files and commits retained.',
                )
              }
            >
              <Trash2 size={15} />
              Remove workflow
            </button>
          </div>
        </Modal>
      )}
      {showNewRun && state && project && (
        <NewRunModal
          config={project.config}
          active={projectActive}
          project={project}
          onClose={() => setShowNewRun(false)}
          onCreate={async (input) => {
            let created: PlanRecord | null = null;
            await act('create', async () => {
              created = await api<PlanRecord>('/plans', {
                method: 'POST',
                body: JSON.stringify({
                  name: input.name,
                  projectId: project.id,
                  taskPath: input.taskPath,
                  ...(input.taskIds ? { taskIds: input.taskIds } : {}),
                }),
              });
              setSelectedId(created.id);
              setView('workflows');
              setTab('activity');
              setShowNewRun(false);
              if (input.start)
                await api(`/plans/${created.id}/start`, { method: 'POST', body: '{}' });
            });
          }}
          busy={busy === 'create'}
        />
      )}
      {showLimits && plan && (
        <LimitsModal
          plan={plan}
          onClose={() => setShowLimits(false)}
          onSave={(limits) =>
            void act(
              'limits',
              async () => {
                await api(`/plans/${plan.id}/limits`, {
                  method: 'PATCH',
                  body: JSON.stringify(limits),
                });
                setShowLimits(false);
              },
              'Run limits updated. Resume when ready.',
            )
          }
          busy={busy === 'limits'}
        />
      )}
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  detail,
  green,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  green?: boolean;
}) {
  return (
    <div className="metric-card">
      <div className="metric-label">
        {label}
        <span className={green ? 'metric-icon green' : 'metric-icon'}>{icon}</span>
      </div>
      <strong className="metric-value">{value}</strong>
      <div className="metric-detail">
        {green && <span className="green-dot" />}
        {detail}
      </div>
    </div>
  );
}

function EmptyWorkspace({
  onDemo,
  onCreate,
  busy,
}: {
  onDemo: () => void;
  onCreate: () => void;
  busy: boolean;
}) {
  return (
    <div className="empty-workspace">
      <div className="empty-copy">
        <span className="empty-tag">
          <span />
          YOUR NEXT CHANGE STARTS HERE
        </span>
        <h2>
          Give your task
          <br />a second pair of eyes.
        </h2>
        <p>
          An implementer writes the code and tests. A separate reviewer checks the work. The loop
          continues until it’s approved.
        </p>
        <div className="empty-actions">
          <button className="button primary" onClick={onCreate}>
            <Plus size={16} />
            Create your first run
          </button>
          <button className="text-button" onClick={onDemo} disabled={busy}>
            See it in action
            <ArrowRight size={15} />
          </button>
        </div>
        <span className="empty-note">
          <FolderGit2 size={13} />
          Works with your existing local Git repositories
        </span>
      </div>
      <div className="flow-illustration" aria-label="Task to implementation to review to approval">
        <div className="flow-top">
          <FileText size={16} />
          <div>
            <strong>task.md</strong>
            <small>Clear acceptance criteria</small>
          </div>
          <span className="flow-file-lines">≡</span>
        </div>
        <div className="flow-connector" />
        <div className="flow-agent implementer">
          <span>
            <Code2 size={20} />
          </span>
          <div>
            <strong>Implementer</strong>
            <small>Code + meaningful tests</small>
          </div>
          <span className="flow-pill">01</span>
        </div>
        <div className="flow-connector">
          <span className="flow-check">
            <CheckCheck size={12} />
            Checks pass
          </span>
        </div>
        <div className="flow-agent reviewer">
          <span>
            <ShieldCheck size={20} />
          </span>
          <div>
            <strong>Reviewer</strong>
            <small>An independent perspective</small>
          </div>
          <span className="flow-pill">02</span>
        </div>
        <div className="flow-connector" />
        <div className="flow-approved">
          <CheckCircle2 size={15} />
          Reviewed. Tested. Ready.
        </div>
        <div className="flow-loop">
          <RefreshCw size={13} />
          <span>
            Feedback becomes
            <br />
            the next improvement
          </span>
        </div>
      </div>
    </div>
  );
}

function PanelEmpty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="panel-empty">
      {icon}
      <p>{text}</p>
    </div>
  );
}

function ReviewCard({ review, planId }: { review: ReviewRecord; planId: string }) {
  return (
    <article className="review-card">
      <div className="review-heading">
        <span className={`review-icon ${review.verdict}`}>
          {review.verdict === 'approved' ? <ShieldCheck size={19} /> : <GitPullRequest size={19} />}
        </span>
        <div>
          <strong>
            {review.taskId === '__plan__' ? 'Final plan review' : review.taskId}
            <span>Round {review.round}</span>
          </strong>
          <small>
            Commit {review.reviewedCommit.slice(0, 12)} ·{' '}
            {new Date(review.createdAt).toLocaleString()}
          </small>
        </div>
        <Status status={review.verdict} small />
        <a
          className="icon-button"
          title="Download Markdown review"
          aria-label={`Download ${review.taskId} round ${review.round} review`}
          href={`/api/plans/${planId}/reviews/${review.id}`}
        >
          <ArrowDownToLine size={16} />
        </a>
      </div>
      <p className="review-summary">{review.summary}</p>
      {review.findings.map((finding) => (
        <div className={`finding ${finding.blocking ? 'blocking' : ''}`} key={finding.id}>
          <div className="finding-meta">
            <span>{finding.id}</span>
            <span>{finding.severity}</span>
            <span>{finding.blocking ? 'Change request' : 'Suggestion'}</span>
            <code>
              {finding.file}
              {finding.line !== null ? `:${finding.line}` : ''}
            </code>
          </div>
          <p>{finding.problem}</p>
          <div>
            <strong>Requested change</strong>
            <p>{finding.requestedChange}</p>
          </div>
          {finding.requiredTest && (
            <div>
              <strong>Required validation</strong>
              <p>{finding.requiredTest}</p>
            </div>
          )}
        </div>
      ))}
    </article>
  );
}

function DiffPanel({ plan, taskId }: { plan: PlanRecord; taskId: string | null }) {
  const [diff, setDiff] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const candidate = taskId
    ? plan.tasks.find((task) => task.id === taskId)?.candidateCommit
    : plan.finalCommit;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void api<{ diff: string; message?: string; truncated?: boolean }>(
      `/plans/${plan.id}/diff${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`,
    )
      .then((result) => {
        if (!cancelled) setDiff(result.diff || result.message || 'No changes in this snapshot.');
      })
      .catch((cause) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [plan.id, taskId, candidate]);
  if (loading)
    return (
      <PanelEmpty
        icon={<LoaderCircle size={23} className="spin" />}
        text="Loading the recorded diff…"
      />
    );
  if (error) return <PanelEmpty icon={<CircleDot size={23} />} text={error} />;
  return (
    <div className="diff-view">
      {diff.split('\n').map((line, index) => (
        <div
          className={
            line.startsWith('+')
              ? 'diff-add'
              : line.startsWith('-')
                ? 'diff-remove'
                : line.startsWith('@@')
                  ? 'diff-hunk'
                  : ''
          }
          key={index}
        >
          <span>{index + 1}</span>
          <code>{line || ' '}</code>
        </div>
      ))}
    </div>
  );
}

function SettingsView({
  project,
  draft,
  onChange,
  view,
  state,
  busy,
  onRefreshModels,
  onSave,
  dirty,
}: {
  project?: ProjectRecord;
  draft: FlowConfig;
  onChange: (config: FlowConfig) => void;
  view: 'agents' | 'settings';
  state: DashboardState;
  busy: string | null;
  onRefreshModels: () => void;
  onSave: () => void;
  dirty: boolean;
}) {
  const update = <K extends keyof FlowConfig>(key: K, value: FlowConfig[K]) =>
    onChange({ ...draft, [key]: value });
  const updateAgent = (role: AgentRole, key: string, value: string) => {
    const agent = { ...draft.agents[role], [key]: value };
    if (key === 'model') {
      const model = state.runtime?.models.find((item) => item.id === value);
      if (model && !model.efforts.includes(agent.effort)) agent.effort = model.defaultEffort;
    }
    update('agents', { ...draft.agents, [role]: agent });
  };
  const updateCheck = (index: number, value: Partial<CheckDefinition>) =>
    update(
      'checks',
      draft.checks.map((check, i) => (i === index ? { ...check, ...value } : check)),
    );
  return (
    <div className="settings-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow">
            <span />
            {view === 'agents' ? 'TWO ROLES. INDEPENDENT CONTEXTS.' : 'MAKE IT YOUR WORKFLOW'}
          </div>
          <h1>
            {view === 'agents' ? 'Meet your coding team.' : 'A solid foundation for every run.'}
          </h1>
          <p>
            {project ? `Settings for ${project.name}.` : 'Global defaults for new projects.'}{' '}
            Existing workflows retain their captured settings.
          </p>
        </div>
        <button className="button secondary" onClick={onRefreshModels} disabled={Boolean(busy)}>
          {busy === 'models' ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <RefreshCw size={15} />
          )}
          Refresh Codex catalog
        </button>
      </section>
      <div
        className={`runtime-banner ${state.runtime?.authenticated && !state.runtime.projectConfigError ? 'ready' : ''}`}
      >
        <Terminal size={19} />
        <div>
          <strong>
            {state.runtime?.projectConfigError
              ? 'Project rules need attention'
              : state.runtime?.authenticated
                ? 'Codex connected'
                : 'Connect your local Codex runtime'}
          </strong>
          <p>
            {state.runtime?.message ||
              'Install Codex, run codex login, then refresh the catalog. Models and efforts are checked against your runtime before each invocation.'}
          </p>
        </div>
        {state.runtime?.checkedAt && (
          <small>
            Checked{' '}
            {new Date(state.runtime.checkedAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </small>
        )}
      </div>
      <div className="agent-settings-grid">
        {(['implementer', 'reviewer'] as const).map((role) => {
          const agent = draft.agents[role];
          const model = state.runtime?.models.find((item) => item.id === agent.model);
          const efforts = model?.efforts.length ? model.efforts : [];
          return (
            <section className="settings-card" key={role}>
              <div className="settings-card-title">
                <div className={`agent-avatar ${role}`}>
                  {role === 'implementer' ? <Code2 size={22} /> : <ShieldCheck size={22} />}
                </div>
                <div>
                  <h2>{statusLabel(role)}</h2>
                  <p>
                    {role === 'implementer'
                      ? 'Investigates, implements, and writes tests.'
                      : 'Checks the work with a fresh perspective.'}
                  </p>
                </div>
              </div>
              <label className="form-field">
                <span>Model</span>
                <select
                  value={agent.model}
                  disabled={!state.runtime?.models.length}
                  onChange={(event) => updateAgent(role, 'model', event.target.value)}
                >
                  {!model && (
                    <option value={agent.model} disabled>
                      {!state.runtime
                        ? 'Loading Codex models…'
                        : state.runtime.models.length
                          ? `${agent.model} (unavailable — select a model)`
                          : 'Models unavailable — refresh catalog'}
                    </option>
                  )}
                  {state.runtime?.models.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span>Reasoning effort</span>
                <select
                  value={agent.effort}
                  disabled={!efforts.length}
                  onChange={(event) => updateAgent(role, 'effort', event.target.value)}
                >
                  {!efforts.includes(agent.effort) && (
                    <option value={agent.effort} disabled>
                      {agent.effort} (unavailable)
                    </option>
                  )}
                  {efforts.map((effort) => (
                    <option value={effort} key={effort}>
                      {statusLabel(effort)}
                    </option>
                  ))}
                </select>
                <small>
                  Ultra is available only when the selected runtime and model advertise it.
                </small>
              </label>
              <label className="form-field">
                <span>Additional instructions</span>
                <textarea
                  value={agent.instructions}
                  rows={4}
                  onChange={(event) => updateAgent(role, 'instructions', event.target.value)}
                />
              </label>
              <div className="role-permission">
                <ShieldCheck size={14} />
                {role === 'implementer'
                  ? 'Can edit its isolated workspace. Controller owns commits.'
                  : 'Read-only repository access. Cannot change implementation files.'}
              </div>
            </section>
          );
        })}
      </div>
      {view === 'settings' && (
        <>
          <section className="settings-card">
            <div className="section-title compact">
              <div>
                <h2>Repository & tasks</h2>
                <p>Use absolute paths to a Git repository and a Markdown task file or directory.</p>
              </div>
              <FolderGit2 size={20} />
            </div>
            <div className="form-grid">
              <label className="form-field">
                <span>Repository path</span>
                <input
                  value={draft.repositoryPath}
                  readOnly={Boolean(project)}
                  onChange={(event) => update('repositoryPath', event.target.value)}
                />
                <small>
                  {project
                    ? 'This is the selected project folder. Add another project to work in a different repository.'
                    : 'Add a project from the sidebar to select its repository folder.'}
                </small>
              </label>
              <label className="form-field">
                <span>Task file or directory</span>
                <input
                  value={draft.taskPath}
                  onChange={(event) => update('taskPath', event.target.value)}
                  placeholder="/Users/you/projects/my-app/tasks"
                />
              </label>
            </div>
            <div className="form-grid">
              <label className="form-field">
                <span>Runtime</span>
                <select
                  value={draft.runtime}
                  onChange={(event) =>
                    update('runtime', event.target.value as FlowConfig['runtime'])
                  }
                >
                  <option value="codex">Codex · real coding agents</option>
                  <option value="demo">Demo · only for generated example repositories</option>
                </select>
              </label>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={draft.networkAccess}
                  onChange={(event) => update('networkAccess', event.target.checked)}
                />
                <div>
                  Allow implementer network access
                  <small>For dependency installation and development tools.</small>
                </div>
              </label>
            </div>
          </section>
          <section className="settings-card">
            <div className="section-title compact">
              <div>
                <h2>Required checks</h2>
                <p>
                  Run in each task workspace and again on the combined plan. A unit-test check is
                  mandatory.
                </p>
              </div>
              <button
                className="button secondary small"
                onClick={() =>
                  update('checks', [
                    ...draft.checks,
                    {
                      id: `check-${Date.now()}`,
                      name: 'New check',
                      command: '',
                      kind: 'custom',
                      timeoutSeconds: 300,
                    },
                  ])
                }
              >
                <Plus size={14} />
                Add check
              </button>
            </div>
            <div className="check-editor-header">
              <span>Name</span>
              <span>Command</span>
              <span>Type</span>
              <span>Timeout (s)</span>
              <span />
            </div>
            {draft.checks.map((check, index) => (
              <div className="check-editor-row" key={check.id}>
                <input
                  aria-label={`Check ${index + 1} name`}
                  value={check.name}
                  onChange={(event) => updateCheck(index, { name: event.target.value })}
                />
                <input
                  aria-label={`Check ${index + 1} command`}
                  className="mono-input"
                  value={check.command}
                  onChange={(event) => updateCheck(index, { command: event.target.value })}
                  placeholder="npm test"
                />
                <select
                  aria-label={`Check ${index + 1} type`}
                  value={check.kind}
                  onChange={(event) =>
                    updateCheck(index, { kind: event.target.value as CheckDefinition['kind'] })
                  }
                >
                  {['unit', 'lint', 'typecheck', 'build', 'integration', 'custom'].map((kind) => (
                    <option value={kind} key={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`Check ${index + 1} timeout`}
                  type="number"
                  min={1}
                  value={check.timeoutSeconds}
                  onChange={(event) =>
                    updateCheck(index, { timeoutSeconds: Number(event.target.value) })
                  }
                />
                <button
                  className="icon-button danger-text"
                  aria-label={`Remove ${check.name}`}
                  onClick={() =>
                    update(
                      'checks',
                      draft.checks.filter((_, i) => i !== index),
                    )
                  }
                >
                  <X size={15} />
                </button>
              </div>
            ))}
          </section>
          <section className="settings-card">
            <div className="section-title compact">
              <div>
                <h2>Run limits</h2>
                <p>
                  Bound automatic retries and spending. Reaching a limit preserves progress and asks
                  for attention.
                </p>
              </div>
              <Clock3 size={20} />
            </div>
            <LimitsFields limits={draft.limits} onChange={(limits) => update('limits', limits)} />
            <div className="storage-note">
              <Boxes size={15} />
              <span>
                {project ? 'Project documents:' : 'Controller data:'}{' '}
                <code>{project ? `${project.repositoryPath}/.ai-flow` : state.dataDirectory}</code>
              </span>
            </div>
          </section>
        </>
      )}
      <div className="save-bar">
        <span>
          {dirty ? (
            <>
              <span className="unsaved-dot" />
              You have unsaved changes
            </>
          ) : (
            <>
              <CheckCircle2 size={15} />
              Settings are up to date
            </>
          )}
        </span>
        <button className="button primary" disabled={Boolean(busy) || !dirty} onClick={onSave}>
          {busy === 'save' ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}Save
          settings
        </button>
      </div>
    </div>
  );
}

function LimitsFields({
  limits,
  onChange,
}: {
  limits: FlowConfig['limits'];
  onChange: (limits: FlowConfig['limits']) => void;
}) {
  return (
    <div className="limits-grid">
      {(
        [
          { key: 'maxReviewRounds', label: 'Review rounds per task', min: 1, max: 50 },
          { key: 'maxFixAttempts', label: 'Check repair limit', min: 1, max: 50 },
          { key: 'maxRunMinutes', label: 'Active runtime (minutes)', min: 1, max: 1440 },
          { key: 'maxTokens', label: 'Reported token budget', min: 1000, max: 100000000 },
        ] as const
      ).map((field) => (
        <label className="form-field" key={field.key}>
          <span>{field.label}</span>
          <input
            type="number"
            min={field.min}
            max={field.max}
            value={limits[field.key]}
            onChange={(event) => onChange({ ...limits, [field.key]: Number(event.target.value) })}
          />
        </label>
      ))}
    </div>
  );
}

function Modal({
  children,
  title,
  description,
  onClose,
}: {
  children: React.ReactNode;
  title: string;
  description: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = dialog.current?.querySelector<HTMLElement>('input, button');
    first?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      if (event.key === 'Tab') {
        const elements = dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]',
        );
        if (!elements?.length) return;
        const first = elements[0]!;
        const last = elements[elements.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="modal-heading">
          <div>
            <span className="modal-icon">
              <Workflow size={22} />
            </span>
            <h2 id="modal-title">{title}</h2>
            <p>{description}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AddProjectModal({
  busy,
  onClose,
  onAdd,
}: {
  busy: boolean;
  onClose: () => void;
  onAdd: (input: { repositoryPath: string; name?: string }) => Promise<void>;
}) {
  const [repositoryPath, setRepositoryPath] = useState('');
  const [name, setName] = useState('');
  return (
    <Modal
      title="Add a project"
      description="Choose the Git repository folder where your workflows will work."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onAdd({ repositoryPath, ...(name.trim() ? { name: name.trim() } : {}) });
        }}
      >
        <div className="modal-body">
          <label className="form-field">
            <span>Project name (optional)</span>
            <input
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
              placeholder="Defaults to the folder name"
            />
          </label>
          <FolderPicker value={repositoryPath} onChange={setRepositoryPath} />
          <small>
            Use a Git repository with at least one commit. Each project keeps its own workflows,
            settings, and documents.
          </small>
        </div>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !repositoryPath.trim()}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}Add project
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NewRunModal({
  project,
  config,
  active,
  onClose,
  onCreate,
  busy,
}: {
  project: ProjectRecord;
  config: FlowConfig;
  active: boolean;
  onClose: () => void;
  onCreate: (input: {
    name: string;
    repositoryPath: string;
    taskPath: string;
    taskIds?: string[];
    start: boolean;
  }) => Promise<void>;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const repositoryPath = project.repositoryPath;
  const [taskPath, setTaskPath] = useState(config.taskPath);
  const [start, setStart] = useState(!active);
  const [tasks, setTasks] = useState<TaskDefinition[] | null>(null);
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      title="Start a new workflow"
      description={`Create a workflow in ${project.name} from a Markdown task or connected plan.`}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (tasks && !taskIds.length) {
            setError('Select at least one task.');
            return;
          }
          void onCreate({ name, repositoryPath, taskPath, start, ...(tasks ? { taskIds } : {}) });
        }}
      >
        <div className="modal-body">
          <label className="form-field">
            <span>Run name</span>
            <input
              required
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Add user management"
            />
          </label>
          <label className="form-field">
            <span>Repository path</span>
            <input required value={repositoryPath} readOnly />
            <small>
              The repository belongs to the selected project. Its working tree must be clean.
            </small>
          </label>
          <label className="form-field">
            <span>Markdown task file or directory</span>
            <input
              required
              value={taskPath}
              onChange={(event) => {
                setTaskPath(event.target.value);
                setTasks(null);
              }}
            />
          </label>
          <button
            className="button secondary small"
            type="button"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setError('');
              void api<TaskDefinition[]>(`/tasks?path=${encodeURIComponent(taskPath)}`)
                .then((result) => {
                  setTasks(result);
                  setTaskIds(result.map((task) => task.id));
                })
                .catch((cause) => setError(cause.message))
                .finally(() => setLoading(false));
            }}
          >
            {loading ? <LoaderCircle size={14} className="spin" /> : <FileText size={14} />}Preview
            tasks
          </button>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {tasks && (
            <div className="task-preview">
              {tasks.map((task) => (
                <label key={task.id}>
                  <input
                    type="checkbox"
                    checked={taskIds.includes(task.id)}
                    onChange={(event) =>
                      setTaskIds((current) =>
                        event.target.checked
                          ? [...current, task.id]
                          : current.filter((id) => id !== task.id),
                      )
                    }
                  />
                  <div>
                    <strong>{task.title}</strong>
                    <small>
                      {task.id}
                      {task.dependsOn.length ? ` · after ${task.dependsOn.join(', ')}` : ''}
                    </small>
                  </div>
                </label>
              ))}
              <p>Required dependencies are included automatically.</p>
            </div>
          )}
          <div className="run-config-note">
            <Bot size={16} />
            <span>
              {modelLabel(config.agents.implementer.model)} ·{' '}
              {statusLabel(config.agents.implementer.effort)} <ArrowRight size={12} />{' '}
              {modelLabel(config.agents.reviewer.model)} ·{' '}
              {statusLabel(config.agents.reviewer.effort)}
            </span>
          </div>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={start}
              disabled={active}
              onChange={(event) => setStart(event.target.checked)}
            />
            <div>
              Start immediately
              <small>
                {active
                  ? 'Another workflow is active in this project. This workflow will be created in the queue.'
                  : 'Otherwise, create it in the queue and start when ready.'}
              </small>
            </div>
          </label>
        </div>
        <div className="modal-footer">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
            {start ? 'Create & start' : 'Create run'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function LimitsModal({
  plan,
  onClose,
  onSave,
  busy,
}: {
  plan: PlanRecord;
  onClose: () => void;
  onSave: (limits: FlowConfig['limits']) => void;
  busy: boolean;
}) {
  const [limits, setLimits] = useState({ ...plan.config.limits });
  return (
    <Modal
      title="Adjust this run’s limits"
      description="Changes are recorded in the activity log. Agent settings and task content stay unchanged."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave(limits);
        }}
      >
        <div className="modal-body">
          <LimitsFields limits={limits} onChange={setLimits} />
        </div>
        <div className="modal-footer">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={busy}>
            <Check size={15} />
            Update limits
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Guide({
  onSettings,
  onDemo,
  busy,
}: {
  onSettings: () => void;
  onDemo: () => void;
  busy: boolean;
}) {
  return (
    <div className="guide-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow">
            <span />
            FROM IDEA TO APPROVED CHANGE
          </div>
          <h1>A dependable loop, on your machine.</h1>
          <p>Set up once. Give each run a task. Follow the evidence.</p>
        </div>
        <button className="button primary" onClick={onDemo} disabled={busy}>
          <FlaskConical size={16} />
          Try the working demo
        </button>
      </section>
      <div className="guide-grid">
        <section className="settings-card guide-card">
          <span className="guide-number">01</span>
          <h2>Connect Codex</h2>
          <p>
            Install the Codex CLI and authenticate in your terminal. AI Flow uses a separate session
            for each role.
          </p>
          <pre>codex login</pre>
          <p>
            Then refresh the model catalog in Agents. Choose a model and supported effort
            independently for implementation and review.
          </p>
        </section>
        <section className="settings-card guide-card">
          <span className="guide-number">02</span>
          <h2>Prepare the repository</h2>
          <p>
            Use a local Git repository with a clean working tree and at least one commit. Configure
            the real test and validation commands for that repository.
          </p>
          <pre>npm test -- --run{'\n'}npm run typecheck</pre>
          <p>
            The controller creates isolated worktrees. All delivery changes stay on an{' '}
            <code>ai-flow/…</code> branch.
          </p>
        </section>
        <section className="settings-card guide-card">
          <span className="guide-number">03</span>
          <h2>Write a Markdown task</h2>
          <p>
            A single file is one task. A directory is a plan. Use dependencies to define the order.
          </p>
          <pre>
            {
              '---\nid: add-users\ndepends_on: []\n---\n\n# Add user creation\n\n## Acceptance criteria\n- Validate the request.\n- Reject duplicate emails.\n- Cover new behavior with unit tests.'
            }
          </pre>
        </section>
        <section className="settings-card guide-card">
          <span className="guide-number">04</span>
          <h2>Follow the loop</h2>
          <p>
            The implementer investigates and codes. The verifier runs checks. An independent
            reviewer either approves or writes change requests.
          </p>
          <p>
            Requested changes return to the implementer. Combined tests and a final review check the
            full plan before completion.
          </p>
          <div className="guide-callout">
            <ShieldCheck size={18} />
            An approval only applies to the exact commit reviewed.
          </div>
          <button className="button secondary" onClick={onSettings}>
            Configure your workspace
            <ArrowRight size={15} />
          </button>
        </section>
      </div>
      <section className="settings-card">
        <h2>When a run needs attention</h2>
        <p>
          Open Activity and Checks to see the evidence. Runtime errors, missing information, retry
          limits, and usage limits preserve the work instead of silently continuing. Adjust the run
          limits when appropriate, then resume. After a controller restart, active runs return
          paused.
        </p>
        <p className="muted">
          The demo makes no model calls. For real runs, reported token usage is an activity measure;
          it does not represent an API or subscription invoice. The controller executes local code
          and commands, so use it with repositories you trust.
        </p>
      </section>
    </div>
  );
}
