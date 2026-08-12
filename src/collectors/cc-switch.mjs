/**
 * cc-switch data collector (pure JS).
 *
 * cc-switch (https://github.com/farion1231/cc-switch) is a provider switcher
 * that can route agent traffic through a local proxy.  When its proxy is
 * enabled, every forwarded request is recorded in proxy_request_logs with
 * per-call token usage and cost.  These records may cover periods that the
 * agent's own session storage has already pruned (e.g. old Codex sessions),
 * so they are an independent supplementary source.
 *
 * Source db:
 *   ~/.cc-switch/cc-switch.db   (or ${AI_TOKEN_DASHBOARD_COLLECTOR_HOME}/.cc-switch/cc-switch.db)
 *
 * Mapping: app_type in {codex, claude, gemini, opencode, hermes} → agent source.
 * The provider column from proxy_request_logs is preserved so the endpoint
 * dimension can classify subscription traffic correctly.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { calculateCost } from '../pricing.mjs';
import { canonicalProvider, localDateFromTimestamp, normalizeModelForGrouping } from './utils.mjs';

export const CLIENT_KEY = 'ccswitch';
export const SOURCE_LABEL = 'CC-Switch';

const EVENT_HISTORY_DAYS = Number(process.env.TIME_USAGE_HISTORY_DAYS || 90);
const EVENT_CUTOFF_MS = Date.now() - EVENT_HISTORY_DAYS * 24 * 60 * 60 * 1000;

// cc-switch app_type → agent source label (must match the source labels used
// by the primary collectors so the agent dimension stays orthogonal).
const APP_TYPE_CLIENT = {
  codex: 'codex',
  claude: 'claude',
  gemini: 'gemini',
  opencode: 'opencode',
  hermes: 'hermes'
};

function dbCandidates() {
  const roots = [];
  const home = homedir();
  roots.push(join(home, '.cc-switch', 'cc-switch.db'));
  const collectorHome = process.env.AI_TOKEN_DASHBOARD_COLLECTOR_HOME;
  if (collectorHome) roots.push(join(collectorHome, '.cc-switch', 'cc-switch.db'));
  return roots.filter(Boolean);
}

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function add(agg, t) {
  agg.input += t.input;
  agg.output += t.output;
  agg.cacheRead += t.cacheRead;
  agg.cacheWrite += t.cacheWrite;
  agg.reasoning += t.reasoning;
}

function pos(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function posFloat(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Convert a cc-switch epoch timestamp (s or ms) to epoch ms. */
function toEpochMs(ts) {
  if (ts == null || ts === '') return null;
  const n = Number(ts);
  if (!Number.isFinite(n)) {
    // ISO string fallback
    const d = Date.parse(String(ts));
    return Number.isFinite(d) ? d : null;
  }
  return n < 10_000_000_000 ? n * 1000 : n;
}

function tsToDate(ts) {
  const ms = toEpochMs(ts);
  return ms == null ? 'unknown' : localDateFromTimestamp(ms);
}

function keepTimeEvent(ts) {
  const ms = toEpochMs(ts);
  return ms != null && ms >= EVENT_CUTOFF_MS;
}

/**
 * Map a cc-switch proxy request to the collector record shape.
 * app_type determines the agent source; the provider id is normalised so the
 * endpoint dimension can classify it (e.g. opencode-go → opencode_go).
 */
function recordFromLog(row) {
  const model = normalizeModelForGrouping(row.model || row.request_model || 'unknown');
  const tokens = {
    input: pos(row.input_tokens),
    output: pos(row.output_tokens),
    cacheRead: pos(row.cache_read_tokens),
    cacheWrite: pos(row.cache_creation_tokens),
    reasoning: 0
  };
  const provider = canonicalProvider(row.provider_id) || String(row.provider_id || '');
  const costFromLog = posFloat(row.total_cost_usd);
  const date = tsToDate(row.created_at);
  const ts = toEpochMs(row.created_at);
  const eventKey = `ccswitch:${row.request_id || `${row.app_type}:${model}:${String(row.created_at ?? '')}`}:${ts ?? ''}`;
  return {
    client: APP_TYPE_CLIENT[row.app_type] || CLIENT_KEY,
    source: APP_TYPE_CLIENT[row.app_type] ? null : SOURCE_LABEL,
    model,
    provider,
    tokens,
    costFromLog,
    date,
    ts,
    sessionId: row.session_id || String(row.request_id || ''),
    eventKey
  };
}

/**
 * @returns {{ graphJson: object, modelsJson: object, eventsJson: object }}
 */
export async function collect(pricingData = null) {
  const empty = { graphJson: { contributions: [] }, modelsJson: { entries: [] }, eventsJson: { events: [] } };

  const dbPath = dbCandidates().find(p => existsSync(p));
  if (!dbPath) return empty;

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return empty;
  }

  let rows;
  try {
    rows = db.prepare(`
      SELECT request_id, app_type, provider_id, model, request_model,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        total_cost_usd, session_id, created_at
      FROM proxy_request_logs
      WHERE input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0
      ORDER BY created_at
    `).all();
  } catch {
    try { db.close(); } catch { /* ignore */ }
    return empty;
  }
  try { db.close(); } catch { /* ignore */ }

  if (!rows.length) return empty;

  const dailyMap = new Map();   // "date::source::model::provider"
  const wmMap = new Map();
  const events = [];
  const seenEventKeys = new Set();

  for (const row of rows) {
    const rec = recordFromLog(row);
    const date = rec.date;
    if (date === 'unknown' || rec.ts == null) continue;   // skip unusable rows
    const client = rec.client;
    const dk = `${date}::${client}::${rec.model}::${rec.provider}`;
    if (!dailyMap.has(dk)) {
      dailyMap.set(dk, { date, client, model: rec.model, provider: rec.provider, ...zero(), cost: 0 });
    }
    const day = dailyMap.get(dk);
    add(day, rec.tokens);
    // Trust the log's recorded cost when present; otherwise estimate.
    day.cost += rec.costFromLog > 0
      ? rec.costFromLog
      : calculateCost(rec.model, rec.tokens, pricingData, rec.provider);

    if (keepTimeEvent(rec.ts) && !seenEventKeys.has(rec.eventKey)) {
      seenEventKeys.add(rec.eventKey);
      const cost = rec.costFromLog > 0
        ? rec.costFromLog
        : calculateCost(rec.model, rec.tokens, pricingData, rec.provider);
      events.push({
        client,
        eventKey: rec.eventKey,
        eventTime: rec.ts,        // epoch ms — normalized downstream
        usageDate: date,
        sessionId: rec.sessionId,
        workspaceKey: client,
        workspaceLabel: client,
        model: rec.model,
        provider: rec.provider,
        tokens: rec.tokens,
        cost
      });
    }

    // Per-session aggregate: accumulate across requests of the same session
    const wmKey = rec.sessionId || rec.eventKey;
    if (!wmMap.has(wmKey)) {
      wmMap.set(wmKey, {
        workspace: wmKey,
        workspaceLabel: client,
        model: rec.model,
        provider: rec.provider,
        ...zero(),
        cost: 0
      });
    }
    const wm = wmMap.get(wmKey);
    add(wm, rec.tokens);
    wm.cost += rec.costFromLog > 0
      ? rec.costFromLog
      : calculateCost(rec.model, rec.tokens, pricingData, rec.provider);
  }

  // eventTime must be a full timestamp string for normalization
  for (const ev of events) {
    ev.eventTime = new Date(ev.eventTime).toISOString();
  }

  // Build graphJson contributions grouped by date
  const byDate = new Map();
  for (const row of dailyMap.values()) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }
  const contributions = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => ({
      date,
      clients: rows.map(row => ({
        client: row.client,
        modelId: row.model,
        provider: row.provider,
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

  const entries = [...wmMap.values()].map(wm => ({
    client: wm.workspaceLabel,
    workspaceKey: wm.workspace,
    workspaceLabel: wm.workspaceLabel,
    model: wm.model,
    provider: wm.provider,
    input: wm.input,
    output: wm.output,
    cacheRead: wm.cacheRead,
    cacheWrite: wm.cacheWrite,
    reasoning: wm.reasoning,
    cost: wm.cost
  }));

  return { graphJson: { contributions }, modelsJson: { entries }, eventsJson: { events } };
}
