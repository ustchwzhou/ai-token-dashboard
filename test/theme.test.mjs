import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, chartPalette } from '../src/client/shared/theme.js';

test('resolveTheme follows the OS when nothing is stored', () => {
  assert.equal(resolveTheme(null, true), 'dark');
  assert.equal(resolveTheme(null, false), 'light');
});

test('resolveTheme lets a stored choice override the OS', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('resolveTheme ignores junk in storage and falls back to the OS', () => {
  assert.equal(resolveTheme('', true), 'dark');
  assert.equal(resolveTheme('midnight', false), 'light');
  assert.equal(resolveTheme(undefined, true), 'dark');
});

test('both chart palettes define the same keys', () => {
  const light = chartPalette('light');
  const dark = chartPalette('dark');
  assert.deepEqual(Object.keys(light).sort(), Object.keys(dark).sort());
  for (const [key, value] of Object.entries(dark)) {
    assert.notEqual(value, light[key], `${key} should differ between themes`);
  }
});

test('chartPalette falls back to light for an unknown theme', () => {
  assert.equal(chartPalette('nope'), chartPalette('light'));
});
