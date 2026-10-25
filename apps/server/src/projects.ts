import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DirectoryListing, FlowConfig, ProjectRecord } from '@ai-flow/shared';
import { git } from './process';

export function canonicalPath(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    // Keep unavailable legacy projects visible so their history remains accessible.
    return path.resolve(directory);
  }
}

export async function repositoryRoot(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new Error('Choose an absolute project path.');
  const resolved = await realpath(directory);
  const root = await realpath(await git(resolved, ['rev-parse', '--show-toplevel']));
  if (resolved !== root) throw new Error(`Choose the repository root: ${root}`);
  await git(root, ['rev-parse', '--verify', 'HEAD']);
  return root;
}

export function projectRecord(
  repositoryPath: string,
  config: FlowConfig,
  name?: string,
): ProjectRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: name?.trim() || path.basename(repositoryPath),
    repositoryPath,
    config: { ...structuredClone(config), repositoryPath },
    createdAt: now,
    updatedAt: now,
  };
}

export async function excludeRuntimeFiles(repository: string): Promise<void> {
  const location = await git(repository, ['rev-parse', '--git-path', 'info/exclude']);
  const file = path.resolve(repository, location);
  const content = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  if (content.split(/\r?\n/).includes('/.ai-flow/')) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, '\n# AI Flow project runtime files\n/.ai-flow/\n');
}

export async function listDirectories(input?: string): Promise<DirectoryListing> {
  const directory = await realpath(input || os.homedir());
  if (!(await stat(directory)).isDirectory()) throw new Error('Choose a directory.');
  const entries = await readdir(directory, { withFileTypes: true });
  const directories = (
    await Promise.all(
      entries
        .filter((entry) => entry.name !== '.git')
        .map(async (entry) => {
          if (
            entry.isDirectory() ||
            (entry.isSymbolicLink() &&
              (await stat(path.join(directory, entry.name)).catch(() => null))?.isDirectory())
          )
            return { name: entry.name, path: path.join(directory, entry.name) };
          return null;
        }),
    )
  )
    .filter((entry): entry is { name: string; path: string } => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(directory);
  return { path: directory, parent: parent === directory ? null : parent, directories };
}
