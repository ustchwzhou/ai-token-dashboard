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

test('collect aggregates daily, workspace/model and events with costUsd priority', async () => {
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
        input: 65554,
        output: 440,
        cacheRead: 40960,
        cacheWrite: 0,
        reasoning: 0
      });
      // costUsd summed, not re-estimated (pricingData is null → estimate would be 0)
      assert.ok(Math.abs(graphJson.contributions[0].clients[0].cost - 0.009415448) < 1e-9);

      assert.equal(modelsJson.entries.length, 1);
      assert.equal(modelsJson.entries[0].workspaceKey, 'd-work-000-ai-ai-token-dashboard');
      assert.equal(modelsJson.entries[0].input, 65554);

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
