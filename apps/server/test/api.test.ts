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
