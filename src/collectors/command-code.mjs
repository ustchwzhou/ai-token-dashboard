/**
 * Pure-JavaScript Command Code (cmdc) data collector.
 *
 * Reads JSONL session files from the Command Code projects directory
 * (~/.commandcode/projects) and returns data in the common collector shape
 * consumed by collect.mjs.
 *
 * Session file format (verified against real transcripts):
 *   line 1: {"type":"session","version":3,"id":"...","timestamp":"...","cwd":"..."}
 *   later:  {"type":"message","id":"...","timestamp":"...","message":{...},
 *            "usage":{"inputTokens":N,"outputTokens":N,"cacheReadTokens":N,
 *                     "cacheWriteTokens":N,"costUsd":0.0045},
 *            "model":"deepseek/deepseek-v4-flash"}
 * Usage and model live at the message top level (camelCase), not inside
 * message.usage like Claude Code.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { configuredPaths, envPathList } from '../collector-config.mjs';
import { calculateCost } from '../pricing.mjs';
import { localDateFromTimestamp, normalizeModelForGrouping } from './utils.mjs';
import { cachedParse, flushCache } from './parse-cache.mjs';

export const CLIENT_KEY = 'commandcode';
export const SOURCE_LABEL = 'Command Code';
const CACHE_VERSION = 1;   // bump when parseSessionFile output shape changes
const EVENT_HISTORY_DAYS = Number(process.env.TIME_USAGE_HISTORY_DAYS || 90);
const EVENT_CUTOFF_MS = Date.now() - EVENT_HISTORY_DAYS * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Return Command Code data roots. COMMANDCODE_HOME / CMDC_HOME (comma-
 * separated) win; then the commandcode.roots config block; then fall back to
 * ${AI_TOKEN_DASHBOARD_COLLECTOR_HOME}/.commandcode (for relocated home
 * setups) and finally ~/.commandcode. Each root is expected to contain a
 * projects/ directory.
 */
export function getCommandCodeRoots() {
  const envRoots = envPathList(process.env.COMMANDCODE_HOME || process.env.CMDC_HOME);
  if (envRoots.length) return envRoots;

  // Config roots may use ${AI_TOKEN_DASHBOARD_COLLECTOR_HOME} — skip roots
  // whose variable segment expanded to empty (i.e. the env var is unset).
  const configured = configuredPaths('commandcode', 'roots')
    .filter(root => !/^[/\\]/.test(root) || (root.length > 1 && !/^[/\\]+$/.test(root)));
  if (configured.length) return configured;

  const collectorHome = process.env.AI_TOKEN_DASHBOARD_COLLECTOR_HOME;
  if (collectorHome) {
    return [join(collectorHome, '.commandcode')];
  }

  return ['~/.commandcode'];
}

async function collectJsonlFiles(dir) {
  const results = [];
  const entries = await safeReaddir(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      // Skip sidecar transcript files — only the raw session transcript counts
      if (!entry.name.endsWith('.checkpoints.jsonl')) results.push(fullPath);
    }
  }
  return results;
}

/**
 * Attempt to decode a project directory name into a human-readable path.
 * Command Code slugs the working directory, e.g. "d-work-000-ai-ai-token-
 * dashboard". Fall back to the raw name when decoding fails.
 */
function decodeWorkspaceLabel(dirName) {
  try {
    const decoded = decodeURIComponent(dirName);
    if (decoded.startsWith('/') || /^[A-Za-z]:\\/.test(decoded)) {
      return decoded;
    }
  } catch {
    // ignore
  }
  return dirName;
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

/**
 * Read one session JSONL file and return an array of assistant-turn records.
 * Each record carries { timestamp, model, usage, costUSD }.
 *
 * Command Code may write multiple usage snapshots for the same streamed
 * response; collapse message.id duplicates and keep the largest token value
 * seen for each field.
 */
export async function parseSessionFile(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const records = [];
  const dedupIndex = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Only assistant turns carry usage information; usage lives at top level
    if (obj.type !== 'message' || obj.message?.role !== 'assistant' || !obj.usage) continue;

    const record = {
      timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : null,
      model: obj.model || obj.message?.model || 'unknown',
      usage: obj.usage,
      costUSD: typeof obj.usage.costUsd === 'number' ? obj.usage.costUsd : 0,
    };

    const dedupKey = obj.id ? `message:${obj.id}` : null;

    if (dedupKey && dedupIndex.has(dedupKey)) {
      const existing = records[dedupIndex.get(dedupKey)];
      mergeUsageMax(existing.usage, record.usage);
      existing.costUSD = Math.max(existing.costUSD || 0, record.costUSD || 0);
      if (!existing.timestamp && record.timestamp) existing.timestamp = record.timestamp;
      if (existing.model === 'unknown' && record.model !== 'unknown') existing.model = record.model;
      continue;
    }

    if (dedupKey) dedupIndex.set(dedupKey, records.length);
    records.push(record);
  }

  return records;
}

function mergeUsageMax(target, source) {
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens'
  ]) {
    target[key] = Math.max(Number(target[key] || 0), Number(source[key] || 0));
  }
}

// ---------------------------------------------------------------------------
// Safe directory helpers
// ---------------------------------------------------------------------------

async function safeReaddir(dirPath) {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function zeroTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function extractTokens(usage) {
  return {
    input: usage.inputTokens || 0,
    output: usage.outputTokens || 0,
    cacheRead: usage.cacheReadTokens || 0,
    cacheWrite: usage.cacheWriteTokens || 0,
    // Not emitted by Command Code today; kept for forward compatibility
    reasoning: usage.reasoningTokens || 0
  };
}

function addInto(target, tokens) {
  target.input += tokens.input;
  target.output += tokens.output;
  target.cacheRead += tokens.cacheRead;
  target.cacheWrite += tokens.cacheWrite;
  target.reasoning += tokens.reasoning;
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

/**
 * Scan the Command Code projects directory and return the common daily and
 * workspace/model objects consumed by collect.mjs.
 *
 * @returns {{ graphJson: object, modelsJson: object, eventsJson: object }}
 */
export async function collect(pricingData = null) {
  const dailyMap = new Map();
  const wmMap = new Map();
  const events = [];

  for (const root of getCommandCodeRoots()) {
    const projectsDir = join(root, 'projects');
    const filePaths = await collectJsonlFiles(projectsDir);
    for (const filePath of filePaths) {
      const workspaceKey = workspaceKeyFromPath(projectsDir, filePath);
      const workspaceLabel = decodeWorkspaceLabel(workspaceKey);
      const records = await cachedParse(CLIENT_KEY, CACHE_VERSION, filePath, parseSessionFile);

      for (const record of records) {
        const tokens = extractTokens(record.usage);
        aggregateRecord({ ...record, tokens, workspaceKey, workspaceLabel, filePath }, dailyMap, wmMap, pricingData, events);
      }
    }
  }

  const byDate = new Map();
  for (const row of dailyMap.values()) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const contributions = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => ({
      date,
      clients: rows.map((row) => ({
        client: CLIENT_KEY,
        modelId: row.model,
        tokens: {
          input: row.input,
          output: row.output,
          cacheRead: row.cacheRead,
          cacheWrite: row.cacheWrite,
          reasoning: row.reasoning
        },
        cost: row.cost
      }))
    }));

  const graphJson = { contributions };

  const entries = [...wmMap.values()].map((wm) => ({
    client: CLIENT_KEY,
    workspaceKey: wm.workspace,
    workspaceLabel: wm.workspaceLabel,
    model: wm.model,
    input: wm.input,
    output: wm.output,
    cacheRead: wm.cacheRead,
    cacheWrite: wm.cacheWrite,
    reasoning: wm.reasoning,
    cost: wm.cost
  }));

  const modelsJson = { entries };

  await flushCache(CLIENT_KEY);
  return { graphJson, modelsJson, eventsJson: { events } };
}

function workspaceKeyFromPath(projectsDir, filePath) {
  const rel = relative(projectsDir, filePath);
  const firstSegment = rel.split(/[\\/]/).find(Boolean);
  return firstSegment || filePath;
}

function aggregateRecord(record, dailyMap, wmMap, pricingData, events) {
  const date = localDateFromTimestamp(record.timestamp);
  const model = normalizeModelForGrouping(record.model);
  const tokens = record.tokens || extractTokens(record.usage);
  // Prefer the actual billed cost recorded by Command Code; fall back to
  // pricing-table estimation when it is missing.
  const calculatedCost = calculateCost(model, tokens, pricingData);
  const costUSD = record.costUSD > 0 ? record.costUSD : calculatedCost;

  if (keepTimeEvent(record.timestamp)) {
    events.push({
      client: CLIENT_KEY,
      eventKey: `${record.filePath || record.workspaceKey}:${record.timestamp || ''}:${model}:${JSON.stringify(tokens)}`,
      eventTime: record.timestamp,
      usageDate: date,
      sessionId: record.filePath,
      workspaceKey: record.workspaceKey,
      workspaceLabel: record.workspaceLabel,
      model,
      tokens,
      cost: costUSD
    });
  }

  const dk = `${date}::${model}`;
  if (!dailyMap.has(dk)) {
    dailyMap.set(dk, { date, model, ...zeroTokens(), cost: 0 });
  }
  const dayAgg = dailyMap.get(dk);
  addInto(dayAgg, tokens);
  dayAgg.cost += costUSD;

  const wmk = `${record.workspaceKey}::${model}`;
  if (!wmMap.has(wmk)) {
    wmMap.set(wmk, {
      workspace: record.workspaceKey,
      workspaceLabel: record.workspaceLabel,
      model,
      ...zeroTokens(),
      cost: 0
    });
  }
  const wmAgg = wmMap.get(wmk);
  addInto(wmAgg, tokens);
  wmAgg.cost += costUSD;
}

function keepTimeEvent(timestamp) {
  const ms = Date.parse(timestamp || '');
  return Number.isFinite(ms) && ms >= EVENT_CUTOFF_MS;
}
