/** Explicit, opt-in smoke test. Makes real Codex calls using the local login. */
import './environment.mjs';
import path from 'node:path';
import { createDemoProject } from '../apps/server/src/runtime';
import type { FlowConfig, PlanRecord } from '@ai-flow/shared';

const origin = `http://127.0.0.1:${process.env.FLOW_API_PORT || '4310'}/api`;
async function request<T>(route: string, method = 'GET', value?: unknown): Promise<T> {
  const response = await fetch(origin + route, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function main() {
  const config = await request<FlowConfig>('/config');
  const project = await createDemoProject(path.resolve('.ai-flow/live-verification'));
  const smoke: FlowConfig = {
    ...structuredClone(config),
    ...project,
    runtime: 'codex',
    checks: [
      {
        id: 'unit',
        name: 'Node unit tests',
        command: 'node --test',
        kind: 'unit',
        timeoutSeconds: 30,
      },
    ],
    limits: { maxReviewRounds: 3, maxFixAttempts: 3, maxRunMinutes: 10, maxTokens: 400_000 },
  };
  smoke.agents.implementer = { ...smoke.agents.implementer, model: 'gpt-6.1-sol', effort: 'low' };
  smoke.agents.reviewer = { ...smoke.agents.reviewer, model: 'gpt-6.1-sol', effort: 'low' };
  let plan: PlanRecord;
  // Capture the smoke configuration in the new run, then restore user defaults before starting it.
  try {
    await request('/config', 'PUT', smoke);
    plan = await request<PlanRecord>('/plans', 'POST', {
      name: 'Live Codex verification · greeting',
      taskIds: ['greeting'],
    });
  } finally {
    await request('/config', 'PUT', config);
  }
  await request(`/plans/${plan.id}/start`, 'POST', {});
  console.log(`Live run ${plan.id} started. Real model calls; follow it in the dashboard.`);
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const result = await request<PlanRecord>(`/plans/${plan.id}`);
    if (result.status === 'running') continue;
    console.log(
      JSON.stringify(
        {
          id: result.id,
          status: result.status,
          error: result.error,
          tasks: result.tasks.map((task) => ({
            id: task.id,
            status: task.status,
            reviews: task.reviews.map((review) => review.verdict),
          })),
          finalReview: result.finalReview?.verdict,
          tokens: result.attempts.reduce(
            (sum, attempt) => sum + (attempt.usage?.totalTokens || 0),
            0,
          ),
          branch: result.branch,
        },
        null,
        2,
      ),
    );
    if (result.status !== 'completed') process.exitCode = 1;
    break;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
