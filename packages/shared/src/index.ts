export type AgentRole = 'implementer' | 'reviewer';
export type RuntimeMode = 'codex' | 'demo';
export type PlanStatus =
  'queued' | 'running' | 'paused' | 'needs_attention' | 'completed' | 'cancelled';
export type TaskStatus =
  'queued' | 'implementing' | 'checking' | 'reviewing' | 'fixing' | 'approved' | 'blocked';
export type CheckKind = 'unit' | 'lint' | 'typecheck' | 'build' | 'integration' | 'custom';

export interface AgentConfig {
  model: string;
  effort: string;
  instructions: string;
}

export interface CheckDefinition {
  id: string;
  name: string;
  command: string;
  kind: CheckKind;
  timeoutSeconds: number;
}

export interface FlowConfig {
  repositoryPath: string;
  taskPath: string;
  runtime: RuntimeMode;
  agents: Record<AgentRole, AgentConfig>;
  checks: CheckDefinition[];
  limits: {
    maxReviewRounds: number;
    maxFixAttempts: number;
    maxRunMinutes: number;
  };
  networkAccess: boolean;
}

export interface ProjectRecord {
  id: string;
  name: string;
  repositoryPath: string;
  config: FlowConfig;
  createdAt: string;
  updatedAt: string;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
}

export interface TaskDefinition {
  id: string;
  title: string;
  markdown: string;
  dependsOn: string[];
  sourcePath: string;
}

export interface CheckResult {
  id: string;
  name: string;
  command: string;
  kind: CheckKind;
  status: 'passed' | 'failed' | 'cancelled';
  exitCode: number | null;
  output: string;
  durationMs: number;
  commit: string;
  startedAt: string;
}

export interface ReviewFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  blocking: boolean;
  file: string;
  line: number | null;
  problem: string;
  requestedChange: string;
  requiredTest: string;
}

export interface ReviewVerdict {
  verdict: 'approved' | 'changes_requested';
  summary: string;
  findings: ReviewFinding[];
}

export interface ReviewRecord extends ReviewVerdict {
  id: string;
  taskId: string;
  round: number;
  reviewedCommit: string;
  createdAt: string;
  markdownPath: string;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  source: 'reported' | 'simulated';
}

export interface AgentAttempt {
  id: string;
  taskId: string;
  role: AgentRole;
  round: number;
  model: string;
  effort: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: string;
  completedAt?: string;
  threadId?: string;
  usage?: TokenUsage;
  summary?: string;
  error?: string;
}

export interface TaskRecord extends TaskDefinition {
  status: TaskStatus;
  round: number;
  fixAttempts: number;
  baseCommit?: string;
  candidateCommit?: string;
  approvedCommit?: string;
  integratedCommit?: string;
  workspacePath?: string;
  branch?: string;
  checks: CheckResult[];
  reviews: ReviewRecord[];
  summary?: string;
  error?: string;
}

export interface PlanRecord {
  id: string;
  /** Populated for legacy runs during startup migration. */
  projectId?: string;
  /** New runs use project-local storage; absent on legacy workspaces. */
  storageDirectory?: string;
  artifactsPath?: string;
  name: string;
  status: PlanStatus;
  config: FlowConfig;
  tasks: TaskRecord[];
  attempts: AgentAttempt[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  elapsedMs: number;
  branch?: string;
  workspacePath?: string;
  baseCommit?: string;
  finalCommit?: string;
  integrationChecks: CheckResult[];
  finalReview?: ReviewRecord;
  error?: string;
}

export interface FlowEvent {
  id: number;
  planId: string | null;
  taskId: string | null;
  role: AgentRole | 'controller' | 'verifier';
  type: 'state' | 'log' | 'usage' | 'review' | 'check' | 'error';
  message: string;
  createdAt: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort: string;
}

export interface RuntimeStatus {
  available: boolean;
  authenticated: boolean;
  models: ModelInfo[];
  message: string;
  checkedAt: string;
  projectConfigError?: string;
}

export interface DashboardState {
  config: FlowConfig;
  projects: ProjectRecord[];
  plans: PlanRecord[];
  activePlanIds: string[];
  activePlanId: string | null;
  events: FlowEvent[];
  runtime: RuntimeStatus | null;
  projectRuntimes: Record<string, RuntimeStatus>;
  dataDirectory: string;
}

export interface CreatePlanInput {
  name?: string;
  projectId?: string;
  repositoryPath?: string;
  taskPath?: string;
  taskText?: string;
  taskIds?: string[];
}
