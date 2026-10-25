import { z } from 'zod';
import type { ReviewRecord, ReviewVerdict } from '@ai-flow/shared';

export const reviewSchema = z
  .object({
    verdict: z.enum(['approved', 'changes_requested']),
    summary: z.string().min(1).max(20_000),
    findings: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            severity: z.enum(['critical', 'high', 'medium', 'low']),
            blocking: z.boolean(),
            file: z.string().max(2000),
            line: z.number().int().positive().nullable(),
            problem: z.string().min(1).max(20_000),
            requestedChange: z.string().min(1).max(20_000),
            requiredTest: z.string().max(20_000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export const reviewOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['approved', 'changes_requested'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'severity',
          'blocking',
          'file',
          'line',
          'problem',
          'requestedChange',
          'requiredTest',
        ],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          blocking: { type: 'boolean' },
          file: { type: 'string' },
          line: { type: ['integer', 'null'] },
          problem: { type: 'string' },
          requestedChange: { type: 'string' },
          requiredTest: { type: 'string' },
        },
      },
    },
  },
};

export function parseReview(input: unknown): ReviewVerdict {
  const value = reviewSchema.parse(input);
  const blocking = value.findings.some((finding) => finding.blocking);
  if (value.verdict === 'approved' && blocking)
    throw new Error('Invalid review: an approval cannot contain blocking findings.');
  if (value.verdict === 'changes_requested' && !blocking)
    throw new Error(
      'Invalid review: changes_requested must include an actionable blocking finding.',
    );
  if (new Set(value.findings.map((finding) => finding.id)).size !== value.findings.length)
    throw new Error('Review finding IDs must be unique.');
  return value;
}

export function renderReview(review: ReviewRecord): string {
  const lines = [
    `# Review: ${review.taskId} — round ${review.round}`,
    '',
    `- **Status:** ${review.verdict}`,
    `- **Reviewed commit:** \`${review.reviewedCommit}\``,
    ...(review.reviewedWorkspaceTree
      ? [
          `- **Working files snapshot (includes existing local edits):** \`${review.reviewedWorkspaceTree}\``,
        ]
      : []),
    `- **Recorded:** ${review.createdAt}`,
    '',
    review.summary,
    '',
  ];
  if (!review.findings.length) lines.push('No findings.', '');
  for (const finding of review.findings) {
    lines.push(
      `## ${finding.id}: ${finding.blocking ? 'Change request' : 'Suggestion'} (${finding.severity})`,
      '',
      `**Location:** ${finding.file}${finding.line === null ? '' : `:${finding.line}`}`,
      '',
      finding.problem,
      '',
      `**Requested change:** ${finding.requestedChange}`,
      '',
      `**Validation:** ${finding.requiredTest || 'Review the updated implementation.'}`,
      '',
    );
  }
  return lines.join('\n');
}
