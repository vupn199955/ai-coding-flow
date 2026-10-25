import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { TaskDefinition } from '@ai-flow/shared';
import { z } from 'zod';

const metadataSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/),
    title: z.string().trim().min(1).optional(),
    depends_on: z.array(z.string()).default([]),
  })
  .passthrough();

export function parseTask(markdown: string, sourcePath: string): TaskDefinition {
  if (Buffer.byteLength(markdown) > 512_000) throw new Error(`Task is too large: ${sourcePath}`);
  const { data, content } = matter(markdown);
  const metadata = metadataSchema.parse(data);
  const heading = content.match(/^#\s+(.+)$/m)?.[1];
  const title = metadata.title || heading?.trim();
  if (!title || !content.trim())
    throw new Error(`Task ${metadata.id} needs a title and description.`);
  return { id: metadata.id, title, markdown, dependsOn: metadata.depends_on, sourcePath };
}

export function sortTasks(tasks: TaskDefinition[]): TaskDefinition[] {
  const byId = new Map<string, TaskDefinition>();
  const portableIds = new Set<string>();
  for (const task of tasks) {
    if (byId.has(task.id)) throw new Error(`Duplicate task ID: ${task.id}`);
    if (portableIds.has(task.id.toLowerCase()))
      throw new Error(
        `Task IDs must be distinct ignoring case for portable workspaces: ${task.id}`,
      );
    portableIds.add(task.id.toLowerCase());
    byId.set(task.id, task);
  }
  const ordered: TaskDefinition[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`Dependency cycle detected at ${id}.`);
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error(`Missing dependency: ${id}`);
    visiting.add(id);
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(task);
  };
  tasks.forEach((task) => visit(task.id));
  return ordered;
}

export async function loadTasks(
  inputPath: string,
  selectedIds?: string[],
): Promise<TaskDefinition[]> {
  const source = await realpath(inputPath);
  const info = await stat(source);
  const files = info.isDirectory()
    ? (await readdir(source))
        .filter((file) => /\.md$/i.test(file))
        .sort()
        .map((file) => path.join(source, file))
    : [source];
  if (!files.length) throw new Error('No Markdown task files were found.');
  if (files.length > 200) throw new Error('A plan supports up to 200 task files.');
  const tasks = await Promise.all(
    files.map(async (file) => parseTask(await readFile(file, 'utf8'), file)),
  );
  const ordered = sortTasks(tasks);
  if (!selectedIds?.length) return ordered;
  const selected = new Set(selectedIds);
  const byId = new Map(ordered.map((task) => [task.id, task]));
  const includeDependencies = (id: string) => {
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown task ID: ${id}`);
    for (const dependency of task.dependsOn) {
      if (!selected.has(dependency)) {
        selected.add(dependency);
        includeDependencies(dependency);
      }
    }
  };
  selectedIds.forEach(includeDependencies);
  return ordered.filter((task) => selected.has(task.id));
}
