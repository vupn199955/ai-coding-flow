import type { AgentAttempt, PlanRecord } from '@ai-flow/shared';

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function compactNumber(value: number): string {
  if (value < 1000) return value.toLocaleString();
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}m`;
}

export function usageSummary(attempts: AgentAttempt[]) {
  const reported = attempts.filter((attempt) => attempt.usage?.source === 'reported');
  return {
    available: reported.length > 0,
    input: reported.reduce((sum, attempt) => sum + attempt.usage!.inputTokens, 0),
    cached: reported.reduce((sum, attempt) => sum + attempt.usage!.cachedInputTokens, 0),
    output: reported.reduce((sum, attempt) => sum + attempt.usage!.outputTokens, 0),
    total: reported.reduce((sum, attempt) => sum + attempt.usage!.totalTokens, 0),
    missing: attempts.length - reported.length,
  };
}

export function planProgress(plan: PlanRecord) {
  const approved = plan.tasks.filter((task) => task.status === 'approved').length;
  return {
    approved,
    total: plan.tasks.length,
    percent: plan.tasks.length ? Math.round((approved / plan.tasks.length) * 100) : 0,
  };
}

export function statusLabel(status: string): string {
  return status.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

export function modelLabel(model: string): string {
  return model === 'gpt-6.1-sol' ? 'GPT-6.1 Sol' : model === 'demo' ? 'Demo agent' : model;
}
