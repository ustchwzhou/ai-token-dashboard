import { test } from 'node:test';
import assert from 'node:assert/strict';
import { U } from '../src/client/shared/utils.js';

test('aggregateTotals sums cacheSavedUSD, defaulting missing values to 0', () => {
  const rows = [
    { totalTokens: 100, inputTokens: 10, outputTokens: 20, cacheReadTokens: 60,
      cacheCreationTokens: 10, reasoningOutputTokens: 0, costUSD: 1, cacheSavedUSD: 2.5 },
    { totalTokens: 50, inputTokens: 50, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, reasoningOutputTokens: 0, costUSD: 0.5 } // no cacheSavedUSD
  ];
  const t = U.aggregateTotals(rows);
  assert.equal(t.cacheSavedUSD, 2.5);
  assert.equal(t.totalTokens, 150);
});

test('providerOf classifies subscriptions, free models, and pay-as-you-go', () => {
  assert.equal(U.providerOf('Command Code'), '订阅-Commandcode');
  assert.equal(U.providerOf('OpenCode', 'opencode_go', 'glm-5.2'), '订阅-Opencode Go');
  assert.equal(U.providerOf('OpenCode', 'minimax_cn_coding_plan', 'minimax-m3'), '订阅-MiniMax');
  assert.equal(U.providerOf('Hermes Agent', 'agnes', 'agnes-2.0-flash'), '订阅-Agnes');
  assert.equal(U.providerOf('OpenCode', 'deepseek', 'deepseek-v4-flash'), '按量计费-DeepSeek');
  assert.equal(U.providerOf('OpenCode', 'opencode', 'mimo-v2.5-free'), '免费');
  assert.equal(U.providerOf('OpenCode', '', 'deepseek-v4-flash-free'), '免费');
  // sources without a subscription provider fall into "其他"
  assert.equal(U.providerOf('Claude Code', '', 'deepseek-v4-flash'), '其他');
  assert.equal(U.providerOf('Codex CLI', '', 'gpt-5.2'), '其他');
});

test('filterDaily applies the provider dimension even when a row has no provider', () => {
  const rows = [
    { usageDate: '2026-08-01', source: 'Command Code', provider: '', model: 'deepseek/deepseek-v4-flash', totalTokens: 10 },
    { usageDate: '2026-08-01', source: 'Claude Code', provider: '', model: 'deepseek-v4-flash', totalTokens: 100 },
    { usageDate: '2026-08-01', source: 'OpenCode', provider: 'opencode_go', model: 'deepseek-v4-pro', totalTokens: 50 },
    { usageDate: '2026-08-01', source: 'OpenCode', provider: 'deepseek', model: 'deepseek-v4-flash', totalTokens: 30 }
  ];
  const base = {
    startDate: '2026-08-01', endDate: '2026-08-01',
    sources: new Set(), devices: new Set(), models: new Set()
  };
  // Selecting the Command Code subscription must not leak Claude Code rows
  // (empty provider, classified 其他) into the result.
  const cc = U.filterDaily(rows, { ...base, providers: new Set(['订阅-Commandcode']) });
  assert.deepEqual(cc.map(r => r.source), ['Command Code']);
  const payg = U.filterDaily(rows, { ...base, providers: new Set(['按量计费-DeepSeek']) });
  assert.deepEqual(payg.map(r => r.model), ['deepseek-v4-flash']);
});

test('filterTime applies the provider dimension even when a row has no provider', () => {
  const rows = [
    { eventTime: '2026-08-01T10:00:00', source: 'Claude Code', provider: '', model: 'deepseek-v4-flash', totalTokens: 100 },
    { eventTime: '2026-08-01T10:00:00', source: 'OpenCode', provider: 'opencode_go', model: 'deepseek-v4-pro', totalTokens: 50 }
  ];
  const base = {
    startDateTime: '2026-08-01T00:00:00', endDateTime: '2026-08-01T23:59:00',
    sources: new Set(), devices: new Set(), models: new Set()
  };
  const sub = U.filterTime(rows, { ...base, providers: new Set(['订阅-Opencode Go']) });
  assert.deepEqual(sub.map(r => r.source), ['OpenCode']);
  const other = U.filterTime(rows, { ...base, providers: new Set(['其他']) });
  assert.deepEqual(other.map(r => r.source), ['Claude Code']);
});
