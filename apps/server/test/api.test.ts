import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/api';

describe('local controller API', () => {
  let application: Awaited<ReturnType<typeof createApp>>;
  let directory: string;
  let origin: string;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'ai-flow-api-'));
    application = await createApp({ root: process.cwd(), dataDirectory: directory, logger: false });
    await application.app.listen(0, '127.0.0.1');
    origin = await application.app.getUrl();
  });
  afterAll(async () => {
    if (application) {
      await application.flow.shutdown();
      await application.app.close();
      application.store.close();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('serves health and validates configuration and task input', async () => {
    expect((await (await fetch(origin + '/api/health')).json()).status).toBe('ok');
    const response = await fetch(origin + '/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('repositoryPath');
    const malformed = await fetch(origin + '/api/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(malformed.status).toBe(400);
  });

  it('blocks requests from unrelated browser origins', async () => {
    const response = await fetch(origin + '/api/config', {
      method: 'PUT',
      headers: { Origin: 'https://unrelated.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  it('registers projects, browses directories, captures project settings, and removes workflows over HTTP', async () => {
    const plan = await application.flow.createDemo();
    const post = (url: string, value: unknown, method = 'POST') =>
      fetch(origin + '/api' + url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
    const projects = await (await fetch(origin + '/api/projects')).json();
    expect(projects.some((project: { id: string }) => project.id === plan.projectId)).toBe(true);
    const duplicate = await post('/projects', {
      repositoryPath: plan.config.repositoryPath,
      name: 'Same project',
    });
    expect((await duplicate.json()).id).toBe(plan.projectId);
    const listing = await (
      await fetch(
        origin +
          '/api/directories?path=' +
          encodeURIComponent(path.dirname(plan.config.repositoryPath)),
      )
    ).json();
    expect(listing.directories.some((item: { name: string }) => item.name === 'repository')).toBe(
      true,
    );
    expect((await post('/projects', { repositoryPath: 'relative' })).status).toBe(400);
    const saved = await post(
      `/projects/${plan.projectId}`,
      { name: 'Updated project', config: plan.config },
      'PUT',
    );
    expect((await saved.json()).name).toBe('Updated project');
    const captured = await post('/plans', {
      name: 'Project workflow',
      projectId: plan.projectId,
      taskIds: ['greeting'],
    });
    const created = await captured.json();
    expect(captured.status).toBe(201);
    expect(created.projectId).toBe(plan.projectId);
    expect(created.config).toEqual(plan.config);
    expect((await post('/plans', { name: 'Invalid project', projectId: 'missing' })).status).toBe(
      400,
    );
    expect((await fetch(origin + `/api/plans/${created.id}`, { method: 'DELETE' })).status).toBe(
      200,
    );
    expect((await fetch(origin + `/api/plans/${created.id}`)).status).toBe(400);
    const state = await (await fetch(origin + '/api/state')).json();
    expect(state.plans.some((item: { id: string }) => item.id === created.id)).toBe(false);
    expect(Array.isArray(state.activePlanIds)).toBe(true);
  });

  it('creates a run, exposes logs, cancels queued work, and prevents starting cancelled work', async () => {
    const created = await fetch(origin + '/api/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(201);
    const plan = await created.json();
    const events = await (await fetch(origin + '/api/events?planId=' + plan.id)).json();
    expect(events.length).toBeGreaterThan(0);
    const cancelled = await fetch(origin + `/api/plans/${plan.id}/cancel`, { method: 'POST' });
    expect((await cancelled.json()).status).toBe('cancelled');
    expect((await fetch(origin + `/api/plans/${plan.id}/start`, { method: 'POST' })).status).toBe(
      400,
    );
  });

  it('closes live event streams when the controller shuts down', async () => {
    const response = await fetch(origin + '/api/stream');
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: connected');
    await application.flow.shutdown();
    expect((await reader.read()).done).toBe(true);
  });
});
