import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store';
import { defaultConfig } from '../src/config';
import type { PlanRecord } from '@ai-flow/shared';

describe('durable store', () => {
  let directory: string;
  let store: Store;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'ai-flow-store-'));
    store = new Store(directory);
  });
  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('persists configuration and run events across connections without mutating stored snapshots', () => {
    const config = defaultConfig('/tmp/project');
    store.saveConfig(config);
    const event = store.addEvent({
      planId: 'run-1',
      taskId: null,
      role: 'controller',
      type: 'state',
      message: 'started',
    });
    store.addEvent({
      planId: 'run-2',
      taskId: null,
      role: 'controller',
      type: 'state',
      message: 'other',
    });
    expect(store.getEvents('run-1')).toEqual([event]);
    expect(store.getEvents(undefined, event.id)).toHaveLength(1);
    store.close();
    store = new Store(directory);
    expect(store.getConfig()).toEqual(config);
    expect(store.getEvents('run-1')[0]?.message).toBe('started');
  });

  it('recovers active runs as paused and marks unfinished invocations interrupted', () => {
    const now = new Date().toISOString();
    const plan: PlanRecord = {
      id: 'run-1',
      name: 'Interrupted',
      status: 'running',
      config: defaultConfig('/tmp/project'),
      tasks: [],
      createdAt: now,
      updatedAt: now,
      elapsedMs: 1000,
      integrationChecks: [],
      attempts: [
        {
          id: 'attempt-1',
          taskId: 'task-1',
          role: 'implementer',
          round: 1,
          model: 'model',
          effort: 'high',
          status: 'running',
          startedAt: now,
        },
      ],
    };
    store.savePlan(plan);
    expect(store.recoverInterruptedRuns()).toBe(1);
    expect(store.getPlan('run-1')?.status).toBe('paused');
    expect(store.getPlan('run-1')?.attempts[0]?.status).toBe('interrupted');
    expect(store.recoverInterruptedRuns()).toBe(0);
    plan.name = 'Mutated outside store';
    expect(store.getPlan('run-1')?.name).toBe('Interrupted');
  });
});
