import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCommandCodeRoots, parseSessionFile, collect } from '../src/collectors/command-code.mjs';

function withSession(lines, work) {
  const dir = mkdtempSync(join(tmpdir(), 'command-code-session-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return Promise.resolve(work(file)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function sessionHeader() {
  return {
    type: 'session',
    version: 3,
    id: 'a1b2c3d4',
    timestamp: '2026-08-11T02:36:17.018Z',
    cwd: 'D:\\WORK\\ai-token-dashboard'
  };
}

function assistantMessage(id, overrides = {}) {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-08-11T02:48:56.806Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    usage: {
      inputTokens: 31967,
      outputTokens: 314,
      cacheReadTokens: 7936,
      cacheWriteTokens: 0,
      costUsd: 0.0045855208
    },
    model: 'deepseek/deepseek-v4-flash',
    effort: 'max',
    ...overrides
  };
}

test('parseSessionFile extracts camelCase usage from assistant messages only', async () => {
  await withSession([
    sessionHeader(),
    { type: 'message', id: 'u1', timestamp: '2026-08-11T02:48:56.000Z', message: { role: 'user', content: [] } },
    assistantMessage('a1'),
    { type: 'message', id: 'x1', timestamp: '2026-08-11T02:48:57.000Z', message: { role: 'assistant', content: [] } } // no usage
  ], async (file) => {
    const records = await parseSessionFile(file);
    assert.equal(records.length, 1);
    assert.equal(records[0].model, 'deepseek/deepseek-v4-flash');
    assert.equal(records[0].usage.inputTokens, 31967);
    assert.equal(records[0].usage.outputTokens, 314);
    assert.equal(records[0].usage.cacheReadTokens, 7936);
    assert.equal(records[0].costUSD, 0.0045855208);
  });
});

test('parseSessionFile collapses duplicate message ids keeping max usage', async () => {
  await withSession([
    sessionHeader(),
    assistantMessage('a1'),
    assistantMessage('a1', {
      timestamp: '2026-08-11T02:48:57.000Z',
      usage: { inputTokens: 40000, outputTokens: 400, cacheReadTokens: 8000, cacheWriteTokens: 5, costUsd: 0.006 }
    })
  ], async (file) => {
    const records = await parseSessionFile(file);
    assert.equal(records.length, 1);
    assert.equal(records[0].usage.inputTokens, 40000);
    assert.equal(records[0].usage.outputTokens, 400);
    assert.equal(records[0].usage.cacheWriteTokens, 5);
    assert.equal(records[0].costUSD, 0.006);
  });
});

test('collect aggregates daily, workspace/model and events with split input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'command-code-projects-'));
  try {
    const projectDir = join(dir, 'projects', 'd-work-000-ai-ai-token-dashboard');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'a1.jsonl'), [
      JSON.stringify(sessionHeader()),
      JSON.stringify(assistantMessage('a1')),
      JSON.stringify(assistantMessage('a2', {
        timestamp: '2026-08-11T02:49:10.000Z',
        usage: { inputTokens: 33587, outputTokens: 126, cacheReadTokens: 33024, cacheWriteTokens: 0, costUsd: 0.0048299272 }
      }))
    ].join('\n') + '\n');

    const original = process.env.COMMANDCODE_HOME;
    process.env.COMMANDCODE_HOME = dir;
    try {
      const { graphJson, modelsJson, eventsJson } = await collect(null);
      assert.equal(graphJson.contributions.length, 1);
      assert.equal(graphJson.contributions[0].date, '2026-08-11');
      assert.equal(graphJson.contributions[0].clients[0].client, 'commandcode');
      assert.equal(graphJson.contributions[0].clients[0].modelId, 'deepseek/deepseek-v4-flash');
      assert.deepEqual(graphJson.contributions[0].clients[0].tokens, {
        // inputTokens is TOTAL input; input = total - cacheReadTokens
        // a1: 31967-7936=24031, a2: 33587-33024=563 → 24031+563=24594
        input: 24594,
        output: 440,
        cacheRead: 40960,
        cacheWrite: 0,
        reasoning: 0
      });
      // cost computed from official prices (input=miss $0.14/M, hit $0.0028/M,
      // output $0.28/M); cmdc's own costUsd is deliberately ignored.
      // a1: 24031*1.4e-7 + 7936*2.8e-9 + 314*2.8e-7 = 0.00347448
      // a2: 563*1.4e-7 + 33024*2.8e-9 + 126*2.8e-7 = 0.00020657
      // total = 0.003681048
      assert.ok(Math.abs(graphJson.contributions[0].clients[0].cost - 0.003681048) < 1e-9);

      assert.equal(modelsJson.entries.length, 1);
      assert.equal(modelsJson.entries[0].workspaceKey, 'd-work-000-ai-ai-token-dashboard');
      assert.equal(modelsJson.entries[0].input, 24594);

      assert.equal(eventsJson.events.length, 2);
      assert.equal(eventsJson.events[0].sessionId.endsWith('a1.jsonl'), true);
    } finally {
      if (original === undefined) delete process.env.COMMANDCODE_HOME;
      else process.env.COMMANDCODE_HOME = original;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractTokens treats inputTokens as total input (miss = total - cacheRead)', async () => {
  // Mirrors the official dashboard: Input Tokens column is TOTAL input and the
  // billed miss portion is input - cacheReadTokens.  The 450,458-token request
  // from the official ledger had cacheReadTokens=450,432 → miss=26.
  const { extractTokens } = await import('../src/collectors/command-code.mjs');
  const usage = { inputTokens: 450458, outputTokens: 113, cacheReadTokens: 450432, cacheWriteTokens: 0 };
  const t = extractTokens(usage);
  assert.deepEqual(t, { input: 26, output: 113, cacheRead: 450432, cacheWrite: 0, reasoning: 0 });
});

test('getCommandCodeRoots prefers env vars over config defaults', () => {
  const originalHome = process.env.COMMANDCODE_HOME;
  const originalCmd = process.env.CMDC_HOME;
  process.env.COMMANDCODE_HOME = 'D:\\cmdc\\home';
  try {
    assert.deepEqual(getCommandCodeRoots(), ['D:\\cmdc\\home']);
  } finally {
    if (originalHome === undefined) delete process.env.COMMANDCODE_HOME;
    else process.env.COMMANDCODE_HOME = originalHome;
    if (originalCmd === undefined) delete process.env.CMDC_HOME;
    else process.env.CMDC_HOME = originalCmd;
  }
});

test('getCommandCodeRoots falls back to AI_TOKEN_DASHBOARD_COLLECTOR_HOME', () => {
  const originalHome = process.env.COMMANDCODE_HOME;
  const originalCmd = process.env.CMDC_HOME;
  const originalColl = process.env.AI_TOKEN_DASHBOARD_COLLECTOR_HOME;
  delete process.env.COMMANDCODE_HOME;
  delete process.env.CMDC_HOME;
  process.env.AI_TOKEN_DASHBOARD_COLLECTOR_HOME = 'D:\\relocated\\home';
  try {
    // The config root "${AI_TOKEN_DASHBOARD_COLLECTOR_HOME}/.commandcode"
    // expands to the relocated path once the env var is set.
    assert.deepEqual(getCommandCodeRoots(), ['D:\\relocated\\home/.commandcode']);
  } finally {
    if (originalHome === undefined) delete process.env.COMMANDCODE_HOME;
    else process.env.COMMANDCODE_HOME = originalHome;
    if (originalCmd === undefined) delete process.env.CMDC_HOME;
    else process.env.CMDC_HOME = originalCmd;
    if (originalColl === undefined) delete process.env.AI_TOKEN_DASHBOARD_COLLECTOR_HOME;
    else process.env.AI_TOKEN_DASHBOARD_COLLECTOR_HOME = originalColl;
  }
});
