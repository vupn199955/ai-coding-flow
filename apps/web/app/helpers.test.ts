import { describe, expect, it } from 'vitest';
import { formatDuration, usageSummary } from './helpers';
import type { AgentAttempt } from '@ai-flow/shared';

describe('dashboard usage and duration', () => {
  it('distinguishes unreported usage from zero and does not add cached or reasoning tokens twice', () => {
    const attempt: AgentAttempt = {
      id: '1',
      taskId: 'task',
      role: 'implementer',
      round: 1,
      model: 'model',
      effort: 'high',
      status: 'completed',
      startedAt: '2026-10-25T00:00:00Z',
    };
    expect(usageSummary([attempt]).available).toBe(false);
    const usage = {
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 50,
      reasoningOutputTokens: 40,
      totalTokens: 150,
      source: 'reported' as const,
    };
    expect(usageSummary([{ ...attempt, usage }])).toMatchObject({
      available: true,
      total: 150,
      input: 100,
      cached: 80,
      output: 50,
      missing: 0,
    });
  });
  it('formats elapsed time without rounding a partial minute upward', () => {
    expect(formatDuration(-1)).toBe('0s');
    expect(formatDuration(59_999)).toBe('59s');
    expect(formatDuration(61_000)).toBe('1m 1s');
    expect(formatDuration(3_661_000)).toBe('1h 1m');
  });
});
