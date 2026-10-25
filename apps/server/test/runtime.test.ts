import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexRuntime, type AgentRequest } from '../src/runtime';

describe('Codex JSON-RPC integration without model calls', () => {
  let directory: string;
  let binary: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'ai-flow-rpc-'));
    binary = path.join(directory, 'fake-codex');
    await writeFile(
      binary,
      `#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
const input = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
input.on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync('rpc-records.jsonl', JSON.stringify(message) + '\\n');
  if (!message.id) return;
  const reply = result => send({ id: message.id, result });
  switch(message.method) {
    case 'initialize': reply({}); break;
    case 'model/list': reply(message.params.cursor ? {data:[{model:'paged-model',displayName:'Paged',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null} : {data:[{model:'test-model',displayName:'Test',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:'page-two'}); break;
    case 'account/read': reply({account:{type:'apiKey'}}); break;
    case 'config/read': reply(fs.existsSync('blocked-config') ? {layers:[{name:{type:'project'},disabledReason:'The selected project must be trusted before its rules can load.'}]} : {layers:[]}); break;
    case 'thread/start': reply({thread:{id:'test-thread'}}); break;
    case 'turn/start': {
      reply({turn:{id:'test-turn'}});
      const usage = {totalTokens:150,inputTokens:100,cachedInputTokens:80,outputTokens:50,reasoningOutputTokens:20};
      send({method:'thread/tokenUsage/updated',params:{threadId:'test-thread',tokenUsage:{total:usage}}});
      send({method:'thread/tokenUsage/updated',params:{threadId:'test-thread',tokenUsage:{total:usage}}});
      const text = message.params.outputSchema ? JSON.stringify({verdict:'approved',summary:'Reviewed the actual snapshot.',findings:[]}) : 'Implemented with tests.';
      send({method:'item/completed',params:{threadId:'test-thread',item:{type:'agentMessage',phase:'final_answer',text}}});
      send({method:'turn/completed',params:{threadId:'test-thread',turn:{id:'test-turn',status:'completed'}}});
      break;
    }
    default: reply({});
  }
});
`,
    );
    await chmod(binary, 0o755);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const request = (cwd: string, role: AgentRequest['role'] = 'reviewer'): AgentRequest => ({
    planId: 'test-plan',
    taskId: 'test-task',
    role,
    round: 1,
    config: { model: 'test-model', effort: 'high', instructions: '' },
    cwd,
    prompt: 'Assess this task.',
    networkAccess: false,
    signal: new AbortController().signal,
    onLog: () => {},
    onUsage: () => {},
    onThread: () => {},
  });

  it('performs the handshake, discovers capabilities, and validates structured review output', async () => {
    const runtime = new CodexRuntime(binary, directory);
    const status = await runtime.inspect();
    expect(status.available).toBe(true);
    expect(status.authenticated).toBe(true);
    expect(status.models[0]?.efforts).toEqual(['high']);
    expect(status.models.map((model) => model.id)).toEqual(['test-model', 'paged-model']);
    const snapshots: number[] = [];
    const result = await runtime.run({
      ...request(directory),
      onUsage: (usage) => snapshots.push(usage.totalTokens),
    });
    expect(result.review?.verdict).toBe('approved');
    expect(result.threadId).toBe('test-thread');
    expect(result.usage?.totalTokens).toBe(150);
    expect(snapshots).toEqual([150, 150]);
    const messages = (await readFile(path.join(directory, 'rpc-records.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const thread = messages.find((message) => message.method === 'thread/start');
    expect(thread.params.cwd).toBe(directory);
    expect(thread.params.developerInstructions).toContain('AGENTS.override.md');
    expect(thread.params.sandbox).toBe('read-only');
  });

  it('rejects unsupported models and efforts rather than substituting settings', async () => {
    const runtime = new CodexRuntime(binary, directory);
    const input = request(directory, 'implementer');
    await expect(
      runtime.run({ ...input, config: { ...input.config, model: 'unknown' } }),
    ).rejects.toThrow(/not advertised/);
    await expect(
      runtime.run({ ...input, config: { ...input.config, effort: 'ultra' } }),
    ).rejects.toThrow(/not supported/);
  });

  it('reports missing executables and respects cancellation before invocation', async () => {
    expect(
      (await new CodexRuntime(path.join(directory, 'missing'), directory).inspect()).available,
    ).toBe(false);
    const abort = new AbortController();
    abort.abort();
    await expect(
      new CodexRuntime(binary, directory).run({ ...request(directory), signal: abort.signal }),
    ).rejects.toThrow(/interrupted/);
  });

  it('stops before a model turn when native Codex disables project configuration or rules', async () => {
    await writeFile(path.join(directory, 'blocked-config'), 'untrusted');
    const runtime = new CodexRuntime(binary, directory);
    expect((await runtime.inspect()).projectConfigError).toContain('must be trusted');
    await expect(runtime.run(request(directory, 'implementer'))).rejects.toThrow(
      /configuration\/rules are disabled/,
    );
    const messages = (await readFile(path.join(directory, 'rpc-records.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(messages.some((message) => message.method === 'thread/start')).toBe(false);
  });
});
