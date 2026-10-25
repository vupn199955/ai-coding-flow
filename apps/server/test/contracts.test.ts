import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, parseConfig } from '../src/config';
import { loadTasks, parseTask, sortTasks } from '../src/tasks';
import { parseReview, renderReview } from '../src/review';
import { mapModels, normalizeUsage } from '../src/runtime';

describe('configuration contracts', () => {
  it('requires a unit-test gate and unique check IDs', () => {
    const config = defaultConfig('/tmp/project');
    expect(parseConfig(config).agents.reviewer.effort).toBe('high');
    expect(() =>
      parseConfig({ ...config, checks: config.checks.filter((check) => check.kind !== 'unit') }),
    ).toThrow(/unit-test/);
    expect(() => parseConfig({ ...config, checks: [config.checks[0], config.checks[0]] })).toThrow(
      /unique/,
    );
  });

  it('rejects invalid limits, unknown properties, and relative paths', () => {
    const config = defaultConfig('/tmp/project');
    expect(() =>
      parseConfig({ ...config, limits: { ...config.limits, maxReviewRounds: 0 } }),
    ).toThrow();
    expect(() => parseConfig({ ...config, repositoryPath: 'relative' })).toThrow(/absolute/);
    expect(() => parseConfig({ ...config, hiddenCommand: 'something' })).toThrow();
  });

  it('accepts settings without a task path or token budget and ignores legacy token limits', () => {
    const config = defaultConfig('/tmp/project');
    expect(parseConfig({ ...config, taskPath: '' }).taskPath).toBe('');
    expect(
      parseConfig({ ...config, limits: { ...config.limits, maxTokens: 1000 } }).limits,
    ).toEqual(config.limits);
    expect(config.limits).not.toHaveProperty('maxTokens');
  });
});

describe('Markdown task loading and dependency order', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'ai-flow-tasks-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const task = (id: string, dependsOn: string[] = []) =>
    parseTask(
      `---\nid: ${id}\ndepends_on: ${JSON.stringify(dependsOn)}\n---\n# Task ${id}\nImplement behavior and tests.`,
      `${id}.md`,
    );

  it('sorts dependencies before dependents and includes selected dependencies', async () => {
    await writeFile(path.join(directory, 'a.md'), task('dependent', ['foundation']).markdown);
    await writeFile(path.join(directory, 'z.md'), task('foundation').markdown);
    await writeFile(path.join(directory, 'other.md'), task('other').markdown);
    const loaded = await loadTasks(directory, ['dependent']);
    expect(loaded.map((item) => item.id)).toEqual(['foundation', 'dependent']);
    expect(await loadTasks(path.join(directory, 'z.md'))).toHaveLength(1);
  });

  it('rejects duplicate IDs, missing dependencies, and cycles', () => {
    expect(() => sortTasks([task('a'), task('a')])).toThrow(/Duplicate/);
    expect(() => sortTasks([task('a'), task('A')])).toThrow(/ignoring case/);
    expect(() => sortTasks([task('a', ['missing'])])).toThrow(/Missing dependency/);
    expect(() => sortTasks([task('a', ['b']), task('b', ['a'])])).toThrow(/cycle/);
  });

  it('accepts plain text, headings, optional metadata, and YAML-looking instructions unchanged', async () => {
    const plain = 'Fix the login redirect and cover it with a regression test.';
    expect(parseTask(plain, 'fix-login.md')).toMatchObject({
      id: 'fix-login',
      title: plain,
      markdown: plain,
      dependsOn: [],
    });
    expect(parseTask('# Login fix\n\nDo the work.', 'login.md').title).toBe('Login fix');
    expect(parseTask('---\ntitle: Login fix\n---\nDo the work.', 'login.md')).toMatchObject({
      id: 'login',
      title: 'Login fix',
    });
    const arbitrary = '---\nthis: [is not valid YAML\n---\nFollow these instructions.';
    expect(parseTask(arbitrary, 'notes.md').markdown).toBe(arbitrary);
    const languageTagged = '---javascript\n({ title: "Not metadata" })\n---\nDo the work.';
    expect(parseTask(languageTagged, 'notes.md').title).toBe('---javascript');
    expect(
      parseTask('---\nid: ../escape\ndepends_on: not-a-list\n---\nDo the work.', 'safe.md'),
    ).toMatchObject({ id: 'safe', dependsOn: [] });
    const unusual = parseTask(plain, 'Sửa đăng nhập!.md');
    expect(unusual.id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
    expect(parseTask(plain, 'Sửa đăng nhập!.md').id).toBe(unusual.id);
    expect(() => parseTask(' \n ', 'empty.md')).toThrow(/empty/);
    await writeFile(path.join(directory, 'one.md'), plain);
    await writeFile(path.join(directory, 'two.md'), '# Another task\nDo this too.');
    expect((await loadTasks(directory)).map((item) => item.id)).toEqual(['one', 'two']);
  });

  it('does not silently accept an empty task directory or unknown selection', async () => {
    await expect(loadTasks(directory)).rejects.toThrow(/No Markdown/);
    await writeFile(path.join(directory, 'a.md'), task('a').markdown);
    await expect(loadTasks(directory, ['missing'])).rejects.toThrow(/Unknown task/);
  });
});

describe('review verdict contract', () => {
  const finding = {
    id: 'R-001',
    severity: 'high',
    blocking: true,
    file: 'src/user.ts',
    line: 7,
    problem: 'Incorrect response.',
    requestedChange: 'Return a conflict.',
    requiredTest: 'Assert conflict response.',
  };
  it('requires actionable findings for rejection and forbids blocking approvals', () => {
    expect(() =>
      parseReview({ verdict: 'approved', summary: 'Looks fine.', findings: [finding] }),
    ).toThrow(/blocking/);
    expect(() =>
      parseReview({ verdict: 'changes_requested', summary: 'Fix it.', findings: [] }),
    ).toThrow(/actionable/);
    expect(() =>
      parseReview({
        verdict: 'changes_requested',
        summary: 'Fix it.',
        findings: [finding, finding],
      }),
    ).toThrow(/unique/);
    expect(
      parseReview({
        verdict: 'approved',
        summary: 'Good.',
        findings: [{ ...finding, blocking: false }],
      }).verdict,
    ).toBe('approved');
  });

  it('renders commit-bound Markdown with requested changes and validation', () => {
    const verdict = parseReview({
      verdict: 'changes_requested',
      summary: 'A defect needs repair.',
      findings: [finding],
    });
    const markdown = renderReview({
      ...verdict,
      id: 'review-1',
      taskId: 'task-1',
      round: 2,
      reviewedCommit: 'abc123',
      createdAt: '2026-10-25T10:00:00Z',
      markdownPath: '/tmp/report.md',
    });
    expect(markdown).toContain('**Status:** changes_requested');
    expect(markdown).toContain('`abc123`');
    expect(markdown).toContain('src/user.ts:7');
    expect(markdown).toContain('**Requested change:** Return a conflict.');
    expect(markdown).toContain('**Validation:** Assert conflict response.');
  });
});

describe('runtime capability and usage mapping', () => {
  it('preserves runtime-supported efforts including Ultra', () => {
    const models = mapModels([
      {
        model: 'gpt-6.1-sol',
        displayName: 'GPT-6.1 Sol',
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }],
      },
    ]);
    expect(models[0]).toEqual({
      id: 'gpt-6.1-sol',
      name: 'GPT-6.1 Sol',
      defaultEffort: 'high',
      efforts: ['high', 'ultra'],
    });
  });

  it('does not double-count cached or reasoning tokens', () => {
    expect(
      normalizeUsage({
        inputTokens: 100,
        cachedInputTokens: 80,
        outputTokens: 40,
        reasoningOutputTokens: 30,
        totalTokens: 140,
      }),
    ).toEqual({
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 40,
      reasoningOutputTokens: 30,
      totalTokens: 140,
      source: 'reported',
    });
    expect(normalizeUsage({ inputTokens: 100, outputTokens: 40 }).totalTokens).toBe(140);
    expect(normalizeUsage({ inputTokens: -1, outputTokens: NaN }).totalTokens).toBe(0);
  });
});
