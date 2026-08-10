import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAUGE, GAUGE_PATH, GAUGE_LENGTH, gaugeDash } from '../src/client/shared/gauge.js';

const dashOf = percent => Number(gaugeDash(percent).split(' ')[0]);

test('the path and the dash length come from the same radius', () => {
  // Regression: the arc was drawn at r=80 while the dash used pi*70, so the
  // gauge silently under-filled by 12.5% and could never reach 100%.
  const [, rx, ry] = GAUGE_PATH.match(/A (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)/);
  assert.equal(Number(rx), GAUGE.radius);
  assert.equal(Number(ry), GAUGE.radius);
  assert.equal(GAUGE_LENGTH, Math.PI * GAUGE.radius);
});

test('the path spans the full half-circle around the centre', () => {
  assert.equal(GAUGE_PATH, 'M 10 90 A 80 80 0 0 1 170 90');
});

test('gaugeDash fills the arc in proportion to the percentage', () => {
  assert.equal(dashOf(0), 0);
  assert.equal(dashOf(100), GAUGE_LENGTH);
  assert.equal(dashOf(50), GAUGE_LENGTH / 2);
  assert.ok(Math.abs(dashOf(95.9) / GAUGE_LENGTH - 0.959) < 1e-9);
});

test('gaugeDash clamps out-of-range and non-numeric input', () => {
  assert.equal(dashOf(150), GAUGE_LENGTH);
  assert.equal(dashOf(-20), 0);
  assert.equal(dashOf(NaN), 0);
  assert.equal(dashOf(undefined), 0);
});

test('the unfilled remainder always covers the rest of the arc', () => {
  for (const percent of [0, 12.5, 50, 87.5, 100]) {
    const [drawn, gap] = gaugeDash(percent).split(' ').map(Number);
    assert.ok(drawn + gap >= GAUGE_LENGTH, `${percent}% leaves a repeat gap`);
  }
});
