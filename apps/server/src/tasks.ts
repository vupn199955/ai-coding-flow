import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import type { TaskDefinition } from '@ai-flow/shared';
import { z } from 'zod';

const taskIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);

function fileTaskId(sourcePath: string): string {
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  if (taskIdSchema.safeParse(stem).success) return stem;
  const slug = stem
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .slice(0, 80);
  return `${slug || 'task'}-${createHash('sha256').update(stem).digest('hex').slice(0, 8)}`;
}

export function parseTask(markdown: string, sourcePath: string): TaskDefinition {
  if (Buffer.byteLength(markdown) > 512_000) throw new Error(`Task is too large: ${sourcePath}`);
  if (!markdown.trim()) throw new Error(`Task is empty: ${sourcePath || 'direct input'}`);
  let data: Record<string, unknown> = {};
  let content = markdown;
  try {
    // Only parse ordinary YAML frontmatter. Language-tagged fences are task text;
    // gray-matter's JavaScript engine would otherwise evaluate instructions.
    if (/^---\r?\n/.test(markdown)) {
      const parsed = matter(markdown);
      if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data))
        data = parsed.data;
      content = parsed.content;
    }
  } catch {
    // Arbitrary text (including YAML-looking text) is still a valid task.
  }
  const id = taskIdSchema.safeParse(data.id);
  const metadataTitle = z.string().trim().min(1).safeParse(data.title);
  const dependencies = z.array(taskIdSchema).safeParse(data.depends_on);
  const heading = content.match(/^#\s+(.+)$/m)?.[1];
  const firstLine = (content.trim() || markdown.trim()).split(/\r?\n/)[0]!;
  const title = metadataTitle.success
    ? metadataTitle.data.slice(0, 200)
    : (heading?.trim() || firstLine).slice(0, 200);
  return {
    id: id.success ? id.data : fileTaskId(sourcePath || 'task.md'),
    title,
    markdown,
    dependsOn: dependencies.success ? dependencies.data : [],
    sourcePath,
  };
}

export function textTask(text: string): TaskDefinition {
  // Direct input is one task; metadata-looking instructions remain literal text.
  const task = parseTask(text, '');
  return { ...task, id: 'task', dependsOn: [] };
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
  if (!inputPath.trim())
    throw new Error('Enter a task file or directory, or use direct task text.');
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
