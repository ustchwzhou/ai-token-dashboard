/* =============================================================
   Seed a self-contained demo database for screenshots and local
   UI work. Deterministic: the same seed always paints the same
   dashboard, so screenshots only change when the UI changes.

   Writes to its own file (data/demo.sqlite by default) and never
   touches a real usage database.

     node scripts/seed-demo.mjs [--db path] [--days 60] [--seed 42]
   ============================================================= */

import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../src/db.mjs';
import { batchUpsertDaily, batchUpsertSession, batchUpsertTimeUsage } from '../src/db-batch.mjs';
import { recordRun } from '../src/db.mjs';

const DEVICE = 'demo-mac';

// Each source gets a weight (share of overall traffic) and its own model mix.
const SOURCES = [
  { name: 'Claude Code',  weight: 0.34, models: [['claude-sonnet-5', 0.6], ['claude-opus-4-8', 0.3], ['claude-haiku-4-5', 0.1]] },
  { name: 'Codex CLI',    weight: 0.26, models: [['gpt-5.6-sol', 0.55], ['gpt-5.5', 0.45]] },
  { name: 'OpenCode',     weight: 0.14, models: [['claude-sonnet-5', 0.5], ['gpt-5.5', 0.5]] },
  { name: 'Gemini CLI',   weight: 0.11, models: [['gemini-2.5-pro', 0.7], ['gemini-2.5-flash', 0.3]] },
  { name: 'Hermes Agent', weight: 0.09, models: [['claude-opus-4-8', 0.6], ['claude-sonnet-5', 0.4]] },
  { name: 'OpenClaw',     weight: 0.06, models: [['claude-sonnet-5', 1]] }
];

// Generic paths — a demo database must not leak anyone's real projects.
const PROJECTS = [
  '~/work/web-app', '~/work/api-gateway', '~/work/data-pipeline',
  '~/work/mobile-client', '~/side/blog', '~/side/homelab'
];

// Rough $/token, only used so the demo's cost column looks plausible.
const MODEL_RATES = {
  'claude-opus-4-8':  { in: 15e-6, out: 75e-6, cacheRead: 1.5e-6, cacheWrite: 18.75e-6 },
  'claude-sonnet-5':  { in: 3e-6,  out: 15e-6, cacheRead: 0.3e-6, cacheWrite: 3.75e-6 },
  'claude-haiku-4-5': { in: 0.8e-6, out: 4e-6, cacheRead: 0.08e-6, cacheWrite: 1e-6 },
  'gpt-5.6-sol':      { in: 1.25e-6, out: 10e-6, cacheRead: 0.125e-6, cacheWrite: 0 },
  'gpt-5.5':          { in: 1.25e-6, out: 10e-6, cacheRead: 0.125e-6, cacheWrite: 0 },
  'gemini-2.5-pro':   { in: 1.25e-6, out: 10e-6, cacheRead: 0.31e-6, cacheWrite: 0 },
  'gemini-2.5-flash': { in: 0.3e-6, out: 2.5e-6, cacheRead: 0.075e-6, cacheWrite: 0 }
};

// mulberry32 — small deterministic PRNG so runs are reproducible.
function makeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

function pickWeighted(entries, rnd) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let roll = rnd() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

function isoDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Working hours peak late morning and again in the evening; weekends are quiet.
function hourWeight(hour) {
  const morning = Math.exp(-((hour - 11) ** 2) / 8);
  const evening = Math.exp(-((hour - 21) ** 2) / 6);
  return 0.04 + morning + 0.85 * evening;
}

function costOf(model, t) {
  const rate = MODEL_RATES[model] || MODEL_RATES['claude-sonnet-5'];
  return t.inputTokens * rate.in
    + t.outputTokens * rate.out
    + t.cacheReadTokens * rate.cacheRead
    + t.cacheCreationTokens * rate.cacheWrite;
}

async function main() {
  const dbPath = resolve(arg('--db', 'data/demo.sqlite'));
  const days = Number(arg('--days', 60));
  const rnd = makeRandom(Number(arg('--seed', 42)));

  // Start clean so re-seeding cannot accumulate rows across runs.
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(dbPath + suffix, { force: true });
  }

  const db = await openDb(dbPath);
  const dailyRows = [];
  const timeRows = [];
  const sessionTotals = new Map();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let back = days - 1; back >= 0; back--) {
    const day = new Date(today);
    day.setDate(day.getDate() - back);
    const usageDate = isoDate(day);
    const weekend = day.getDay() === 0 || day.getDay() === 6;

    // Gentle upward trend plus day-to-day noise, so the trend chart has shape.
    const trend = 0.55 + 0.9 * ((days - back) / days);
    const dayScale = trend * (weekend ? 0.35 : 1) * (0.6 + 0.8 * rnd());
    if (rnd() < 0.05) continue; // the occasional day off

    for (const source of SOURCES) {
      if (rnd() > 0.55 + source.weight) continue;
      const perModel = new Map();

      const events = Math.max(1, Math.round(dayScale * source.weight * 90 * (0.5 + rnd())));
      for (let e = 0; e < events; e++) {
        const hour = pickWeighted(Array.from({ length: 24 }, (_, h) => [h, hourWeight(h)]), rnd);
        const model = pickWeighted(source.models, rnd);
        const project = PROJECTS[Math.floor(rnd() * PROJECTS.length)];

        const inputTokens = Math.round(400 + rnd() * 5200);
        const outputTokens = Math.round(200 + rnd() * 3400);
        const cacheReadTokens = Math.round(inputTokens * (6 + rnd() * 26));
        const cacheCreationTokens = Math.round(inputTokens * (0.3 + rnd() * 2.2));
        const reasoningOutputTokens = model.startsWith('gpt') ? Math.round(outputTokens * rnd() * 0.7) : 0;
        const tokens = {
          inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, reasoningOutputTokens,
          // Total = input + output only (cache/reasoning shown as separate detail columns)
          totalTokens: inputTokens + outputTokens
        };
        const costUSD = costOf(model, tokens);

        const minute = Math.floor(rnd() * 60);
        const second = Math.floor(rnd() * 60);
        const p = n => String(n).padStart(2, '0');
        const eventTime = `${usageDate}T${p(hour)}:${p(minute)}:${p(second)}`;
        const sessionId = `${project.split('/').pop()}-${usageDate}-${Math.floor(rnd() * 4)}`;

        timeRows.push({
          device: DEVICE, source: source.name,
          eventKey: `${usageDate}-${source.name}-${e}`,
          eventTime, usageDate, model, projectPath: project, sessionId, ...tokens, costUSD
        });

        const key = `${source.name}::${model}`;
        const agg = perModel.get(key) || { ...zeroTokens(), costUSD: 0, model };
        perModel.set(key, addTokens(agg, tokens, costUSD));

        const sKey = `${source.name}::${sessionId}`;
        const sess = sessionTotals.get(sKey)
          || { ...zeroTokens(), costUSD: 0, projectPath: project, sessionId, source: source.name, lastActivity: eventTime };
        sess.lastActivity = eventTime;
        sessionTotals.set(sKey, addTokens(sess, tokens, costUSD));
      }

      for (const agg of perModel.values()) {
        dailyRows.push({
          device: DEVICE, source: source.name, usageDate, model: agg.model,
          inputTokens: agg.inputTokens, outputTokens: agg.outputTokens,
          cacheCreationTokens: agg.cacheCreationTokens, cacheReadTokens: agg.cacheReadTokens,
          reasoningOutputTokens: agg.reasoningOutputTokens, totalTokens: agg.totalTokens,
          costUSD: agg.costUSD
        });
      }
    }
  }

  const sessionRows = [...sessionTotals.values()].map(s => ({ device: DEVICE, ...s }));

  await batchUpsertDaily(db, dailyRows);
  await batchUpsertTimeUsage(db, timeRows);
  await batchUpsertSession(db, sessionRows);
  for (const source of SOURCES) {
    await recordRun(db, {
      device: DEVICE, source: source.name, status: 'ok',
      message: 'demo data', collectedAt: new Date().toISOString(), command: 'seed-demo'
    });
  }

  const tokens = dailyRows.reduce((s, r) => s + r.totalTokens, 0);
  const cost = dailyRows.reduce((s, r) => s + r.costUSD, 0);
  console.log(`seeded ${dbPath}`);
  console.log(`  ${days} days · ${dailyRows.length} daily rows · ${timeRows.length} events · ${sessionRows.length} sessions`);
  console.log(`  ${(tokens / 1e8).toFixed(2)} 亿 tokens · $${cost.toFixed(2)}`);
  await db.close?.();
}

function zeroTokens() {
  return {
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0,
    cacheReadTokens: 0, reasoningOutputTokens: 0, totalTokens: 0
  };
}

function addTokens(agg, t, costUSD) {
  for (const key of Object.keys(zeroTokens())) agg[key] += t[key];
  agg.costUSD += costUSD;
  return agg;
}

await main();
