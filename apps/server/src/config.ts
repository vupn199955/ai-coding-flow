import path from 'node:path';
import { z } from 'zod';
import type { FlowConfig } from '@ai-flow/shared';

const agentSchema = z.object({
  model: z.string().trim().min(1).max(200),
  effort: z.string().trim().min(1).max(40),
  instructions: z.string().max(30_000).default(''),
});

export const configSchema = z
  .object({
    repositoryPath: z.string().trim().min(1),
    taskPath: z.string().trim().default(''),
    runtime: z.enum(['codex', 'demo']),
    agents: z.object({ implementer: agentSchema, reviewer: agentSchema }),
    checks: z
      .array(
        z.object({
          id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
          name: z.string().trim().min(1).max(200),
          command: z.string().trim().min(1).max(4000),
          kind: z.enum(['unit', 'lint', 'typecheck', 'build', 'integration', 'custom']),
          timeoutSeconds: z.number().int().min(1).max(7200),
        }),
      )
      .min(1)
      .max(20)
      .refine(
        (checks) => checks.some((check) => check.kind === 'unit'),
        'At least one unit-test check is required.',
      )
      .refine(
        (checks) => new Set(checks.map((check) => check.id)).size === checks.length,
        'Check IDs must be unique.',
      ),
    limits: z.object({
      maxReviewRounds: z.number().int().min(1).max(50),
      maxFixAttempts: z.number().int().min(1).max(50),
      maxRunMinutes: z.number().int().min(1).max(1440),
    }),
    networkAccess: z.boolean(),
  })
  .strict();

export function defaultConfig(root: string): FlowConfig {
  return {
    repositoryPath: root,
    taskPath: path.join(root, 'examples', 'tasks'),
    runtime: 'codex',
    agents: {
      implementer: {
        model: 'gpt-6.1-sol',
        effort: 'high',
        instructions:
          'Follow the existing architecture and conventions. Add meaningful unit tests for all behavior added or changed. Keep changes focused on the task.',
      },
      reviewer: {
        model: 'gpt-6.1-sol',
        effort: 'high',
        instructions:
          'Review correctness, acceptance criteria, regression risks, and unit-test quality. Block on concrete defects and missing behavior tests. Keep optional suggestions non-blocking.',
      },
    },
    checks: [
      {
        id: 'unit',
        name: 'Unit tests',
        command: 'npm test -- --run',
        kind: 'unit',
        timeoutSeconds: 300,
      },
      {
        id: 'types',
        name: 'Type check',
        command: 'npm run typecheck',
        kind: 'typecheck',
        timeoutSeconds: 180,
      },
    ],
    limits: { maxReviewRounds: 5, maxFixAttempts: 5, maxRunMinutes: 120 },
    networkAccess: true,
  };
}

export function parseConfig(input: unknown): FlowConfig {
  const value = configSchema.parse(input);
  if (
    !path.isAbsolute(value.repositoryPath) ||
    (value.taskPath && !path.isAbsolute(value.taskPath))
  ) {
    throw new Error('Repository and task paths must be absolute paths.');
  }
  return value;
}
