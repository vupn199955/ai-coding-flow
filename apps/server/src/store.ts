import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { FlowConfig, FlowEvent, PlanRecord, ProjectRecord } from '@ai-flow/shared';
import { writePlanDocuments } from './documents';

export type EventInput = Omit<FlowEvent, 'id' | 'createdAt'>;

export class Store {
  private readonly db: DatabaseSync;
  readonly events = new EventEmitter();

  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'flow.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, repository_path TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_plan_idx ON events(plan_id, id);
    `);
  }

  getConfig(): FlowConfig | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE id = 1').get() as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as FlowConfig) : null;
  }

  saveConfig(config: FlowConfig): void {
    this.db
      .prepare(
        'INSERT INTO settings (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
      )
      .run(JSON.stringify(config));
  }

  savePlan(plan: PlanRecord): void {
    plan.updatedAt = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO plans (id, value, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
      )
      .run(plan.id, JSON.stringify(plan), plan.createdAt);
    writePlanDocuments(plan);
  }

  listProjects(): ProjectRecord[] {
    return (
      this.db.prepare('SELECT value FROM projects ORDER BY rowid').all() as { value: string }[]
    ).map((row) => JSON.parse(row.value) as ProjectRecord);
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.db.prepare('SELECT value FROM projects WHERE id = ?').get(id) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as ProjectRecord) : null;
  }

  saveProject(project: ProjectRecord): void {
    project.updatedAt = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO projects (id, repository_path, value) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET repository_path = excluded.repository_path, value = excluded.value',
      )
      .run(project.id, project.repositoryPath, JSON.stringify(project));
  }

  removePlan(id: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM events WHERE plan_id = ?').run(id);
      this.db.prepare('DELETE FROM plans WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getPlan(id: string): PlanRecord | null {
    const row = this.db.prepare('SELECT value FROM plans WHERE id = ?').get(id) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as PlanRecord) : null;
  }

  listPlans(): PlanRecord[] {
    const rows = this.db.prepare('SELECT value FROM plans ORDER BY created_at DESC').all() as {
      value: string;
    }[];
    return rows.map((row) => JSON.parse(row.value) as PlanRecord);
  }

  addEvent(input: EventInput): FlowEvent {
    const value: FlowEvent = { ...input, id: 0, createdAt: new Date().toISOString() };
    const result = this.db
      .prepare('INSERT INTO events (plan_id, value) VALUES (?, ?)')
      .run(input.planId, JSON.stringify(value));
    value.id = Number(result.lastInsertRowid);
    this.events.emit('event', value);
    return value;
  }

  getEvents(planId?: string, after = 0, limit = 500): FlowEvent[] {
    const bounded = Math.max(1, Math.min(limit, 2000));
    const rows = (
      planId
        ? this.db
            .prepare(
              'SELECT id, value FROM events WHERE plan_id = ? AND id > ? ORDER BY id DESC LIMIT ?',
            )
            .all(planId, after, bounded)
        : this.db
            .prepare('SELECT id, value FROM events WHERE id > ? ORDER BY id DESC LIMIT ?')
            .all(after, bounded)
    ) as { id: number; value: string }[];
    return rows.reverse().map((row) => ({ ...(JSON.parse(row.value) as FlowEvent), id: row.id }));
  }

  recoverInterruptedRuns(): number {
    let recovered = 0;
    for (const plan of this.listPlans()) {
      if (plan.status !== 'running') continue;
      plan.status = 'paused';
      plan.error =
        'Controller restarted. Run paused at its last durable checkpoint; resume to continue.';
      for (const attempt of plan.attempts) {
        if (attempt.status === 'running') {
          attempt.status = 'interrupted';
          attempt.completedAt = new Date().toISOString();
          attempt.error = 'Controller restarted.';
        }
      }
      this.savePlan(plan);
      this.addEvent({
        planId: plan.id,
        taskId: null,
        role: 'controller',
        type: 'state',
        message: plan.error,
      });
      recovered++;
    }
    return recovered;
  }

  close(): void {
    this.db.close();
  }
}
