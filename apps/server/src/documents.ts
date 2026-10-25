import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PlanRecord } from '@ai-flow/shared';

const lastContent = new Map<string, string>();

function write(directory: string, filename: string, content: string, immutable = false): void {
  const target = path.join(directory, filename);
  if ((immutable || lastContent.get(target) === content) && existsSync(target)) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${target}.tmp`, content, 'utf8');
  renameSync(`${target}.tmp`, target);
  if (!immutable) lastContent.set(target, content);
}

export function writePlanDocuments(plan: PlanRecord): void {
  if (!plan.artifactsPath) return;
  const directory = plan.artifactsPath;
  write(
    directory,
    'plan.md',
    [
      `# ${plan.name}`,
      '',
      `- Project: ${plan.config.repositoryPath}`,
      `- Workflow: ${plan.id}`,
      `- Created: ${plan.createdAt}`,
      '',
      '## Tasks',
      '',
      ...plan.tasks.map(
        (task) =>
          `- **${task.id}**: ${task.title}${task.dependsOn.length ? ` (after ${task.dependsOn.join(', ')})` : ''}`,
      ),
      '',
    ].join('\n'),
    true,
  );
  write(
    directory,
    'progress.md',
    [
      `# ${plan.name} — progress`,
      '',
      `- Status: ${plan.status}`,
      `- Updated: ${plan.updatedAt}`,
      `- Branch: ${plan.branch || 'pending'}`,
      `- Workspace: ${plan.workspacePath || 'pending'}`,
      `- Final commit: ${plan.finalCommit || 'pending'}`,
      ...(plan.error ? [`- Attention: ${plan.error}`] : []),
      '',
      ...plan.tasks.map(
        (task) =>
          `- **${task.id}**: ${task.status} · round ${task.round}${task.approvedCommit ? ` · ${task.approvedCommit}` : ''}`,
      ),
      '',
    ].join('\n'),
  );
  for (const task of plan.tasks) {
    const taskDirectory = path.join(directory, 'tasks', task.id);
    write(taskDirectory, 'task.md', task.markdown, true);
    write(
      taskDirectory,
      'progress.md',
      [
        `# ${task.title}`,
        '',
        `- Status: ${task.status}`,
        `- Round: ${task.round}`,
        `- Commit: ${task.approvedCommit || task.candidateCommit || 'pending'}`,
        '',
        ...(task.summary ? ['## Summary', '', task.summary, ''] : []),
        ...(task.error ? ['## Attention', '', task.error, ''] : []),
        '## Checks',
        '',
        ...task.checks.map((check) => `- ${check.name}: ${check.status} (${check.commit})`),
        '',
        '## Reviews',
        '',
        ...task.reviews.map(
          (review) => `- Round ${review.round}: ${review.verdict} — ${review.summary}`,
        ),
        '',
      ].join('\n'),
    );
  }
}
