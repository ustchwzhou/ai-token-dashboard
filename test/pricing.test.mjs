import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCacheSavings, calculateCost } from '../src/pricing.mjs';

test('calculateCost returns 0 when pricing data is missing', () => {
  assert.equal(calculateCost('gpt-4o', { input: 1000, output: 500 }, null), 0);
  assert.equal(calculateCost('gpt-4o', { input: 1000 }, undefined), 0);
});

test('calculateCost returns 0 for an unknown model', () => {
  assert.equal(calculateCost('no-such-model-zzz-123', { input: 1000, output: 500 }, {}), 0);
});

test('calculateCost has no cost for zero tokens', () => {
  assert.equal(calculateCost('gpt-4o', { input: 0, output: 0 }, {}), 0);
});

const CACHE_PRICING_FIXTURE = {
  'test-cache-model': {
    mode: 'chat',
    litellm_provider: 'anthropic',
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6
  }
};

test('calculateCacheSavings = uncached cost minus actual cost', () => {
  const tokens = { input: 1000, output: 500, cacheRead: 100_000, cacheWrite: 2000 };
  // uncached: (1000+100000+2000)*1e-6 + 500*2e-6                    = 0.104
  // actual:   1000*1e-6 + 500*2e-6 + 100000*1e-7 + 2000*1.25e-6     = 0.0145
  const saved = calculateCacheSavings('test-cache-model', tokens, CACHE_PRICING_FIXTURE);
  assert.ok(Math.abs(saved - 0.0895) < 1e-9, `got ${saved}`);
});

test('calculateCacheSavings is 0 with no cache tokens or unknown model', () => {
  assert.equal(calculateCacheSavings('test-cache-model', { input: 1000, output: 500 }, CACHE_PRICING_FIXTURE), 0);
  assert.equal(calculateCacheSavings('no-such-model-zzz-123', { input: 1, cacheRead: 1000 }, {}), 0);
});

test('DeepSeek pricing matches official V3.2 / R1 rates', () => {
  // deepseek-chat (V3.2): $0.28/$0.42 per 1M, cache hit $0.028 per 1M
  const chat = calculateCost('deepseek-chat', { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }, {});
  assert.ok(Math.abs(chat - 0.728) < 1e-9, `got ${chat}`); // 0.28 + 0.42 + 0.028

  // deepseek-reasoner (R1): $0.55/$2.19 per 1M, cache hit $0.14 per 1M
  const r1 = calculateCost('deepseek-reasoner', { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }, {});
  assert.ok(Math.abs(r1 - 2.88) < 1e-9, `got ${r1}`); // 0.55 + 2.19 + 0.14
});

test('reasoning tokens use the dedicated reasoning price when present', () => {
  const fixture = {
    'reason-model': {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6,
      output_cost_per_reasoning_token: 1.5e-6
    }
  };
  const cost = calculateCost('reason-model', { input: 1000, output: 500, reasoning: 200 }, fixture, null, { tiered: false });
  // 1000*1e-6 + 500*2e-6 + 200*1.5e-6 = 0.001 + 0.001 + 0.0003 = 0.0023
  assert.ok(Math.abs(cost - 0.0023) < 1e-12, `got ${cost}`);
});

test('reasoning tokens fall back to output price without a dedicated rate', () => {
  const fixture = {
    'plain-model': {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6
    }
  };
  const cost = calculateCost('plain-model', { input: 1000, output: 500, reasoning: 200 }, fixture, null, { tiered: false });
  // 1000*1e-6 + (500+200)*2e-6 = 0.001 + 0.0014 = 0.0024
  assert.ok(Math.abs(cost - 0.0024) < 1e-12, `got ${cost}`);
});
