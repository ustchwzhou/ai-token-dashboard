# Changes After Forking the Upstream: Feature Additions and Technical Implementation

> This repository is forked from [`fengguanghuai/ai-token-dashboard`](https://github.com/fengguanghuai/ai-token-dashboard). The fork point is `c0d6b4e` (upstream main HEAD); the fork is strictly ahead with no divergence. This document is a **technical / feature-expansion record** — it distills "what the fork adds over upstream and how it's implemented", with commit details relegated to the appendix.

---

## 1. Feature Additions (vs. the Upstream README)

### 1.1 Data sources: 6 → 8

Upstream supports 6 tools; this fork expands to 8:

| Status | Tool | Data location | Notes |
| --- | --- | --- | --- |
| Upstream | Claude Code | `~/.claude/projects/` | JSONL session transcripts |
| Upstream | Codex CLI | `~/.codex/sessions/` | JSONL session transcripts |
| Upstream | OpenCode | `~/.local/share/opencode/` | Fixed: honours `XDG_DATA_HOME`, supports a configurable `dataDir` |
| Upstream | Gemini CLI | `~/.gemini/tmp/` | — |
| Upstream | Hermes Agent | `~/.hermes/state.db` | Enhanced: scans `profiles/*/state.db`, derives provider from `billing_base_url` |
| Upstream | OpenClaw | `~/.openclaw/agents/` | — |
| **New** | **Command Code** | `~/.commandcode/projects/` | JSONL session transcripts; usage fields are camelCase at the message top level |
| **New** | **CC-Switch** | `~/.cc-switch/cc-switch.db` | Reads `proxy_request_logs` to recover traffic agent databases no longer cover (e.g. pruned/cleared Codex sessions); dedups by request id and aggregates per session |

### 1.2 Frontend

- **New per-call usage feed page `/usage`**: paged per-call detail (`GET /api/usage`), filterable by `source` / `model`, newest first — a third view the upstream does not have.
- **New provider/subscription filter dimension on the dashboard**: orthogonal filtering by subscription bucket; each subscription pill inline-shows that bucket's token volume and estimated cost under the current filter.
- **New "refresh pricing" button**: `POST /api/pricing/update` triggers an online LiteLLM + OpenRouter refresh, exposing `pricing/status` / `fetchedAt`; in-memory pricing hot-reloads and costs are recomputed.
- **New `$ / ¥` currency toggle**: `USD_CNY_RATE` (injected by the server via `window.__ENV__`) or a browser localStorage override, default rate 7.15, shared across both pages.
- **Refined token detail display**: the dashboard table and the usage feed both show `Input(total)` and `Input(uncached)` columns; the review CSV gains `input_total`.

### 1.3 Collection enhancements

- **Hermes**: scans `profiles/*/state.db` in addition to the main db (recovers 200M+ MiniMax tokens from a single profile); derives provider from `billing_base_url`; per-db session-id prefixes to avoid cross-db mixups; skips unreadable profile dbs instead of aborting the whole collection.
- **Path generalization**: `${AI_TOKEN_DASHBOARD_COLLECTOR_HOME}` points to a unified migration root (e.g. when all agent data moves to another drive); `GEMINI_HOME` / `OPENCLAW_HOME` and other env overrides. Resolution priority is fixed: **tool's own env vars → `config/collectors.json` → `${AI_TOKEN_DASHBOARD_COLLECTOR_HOME}` → `~` default**; paths support `~`, `${VAR}`, and `$VAR` expansion.

### 1.4 Billing & token semantics

- **Unified token semantics across the project** (see "Token accounting strategy" below).
- **Command Code billed at official three-tier rates**: its unreliable `costUsd` is dropped; costs are always recomputed from official rates (deepseek-v4-flash: miss `$0.14/M`, cache hit `$0.0028/M`, output `$0.28/M`); verified against the official usage feed over a 38-row window with 0.1% aggregate deviation.
- **DeepSeek billed at official V4 rates**: `deepseek-v4-flash` (miss `$0.14/M`, output `$0.28/M`, cache hit `$0.0028/M`) and `deepseek-v4-pro` (miss `$0.435/M`, output `$0.87/M`, cache hit `$0.003625/M`), from the official pricing page (priced in CNY; USD values converted at an approximate FX rate). It also fixes the upstream bug that had set the legacy `deepseek-chat` (V3.2) / `deepseek-reasoner` (R1) rates to v4-flash prices, and splits reasoning out of output with a dedicated `output_cost_per_reasoning_token` rate.
- **Historical-date price lock**: once a past date's `cost_usd` and `pricing_locked_at` are locked, re-running collection does not recompute; only `--full` deletes and rebuilds historical cost at current prices.

### 1.5 Data model

- `daily_usage` / `time_usage` gain a **`provider` column** (all three schemas — sqlite / postgres / mysql — plus upsert paths).
- **Subscription classification** (frontend `providerOf`): usage is split into orthogonal billing buckets by API endpoint —
  - `opencode_go` → `订阅-Opencode Go`
  - `minimax_cn` / `minimax_cn_coding_plan` → `订阅-MiniMax`
  - `agnes` → `订阅-Agnes`
  - `-free`-suffixed models, `opencode` provider → `免费` (free)
  - `deepseek` → `按量计费-DeepSeek` (pay-as-you-go)
  - everything else (incl. Claude Code / Codex CLI without a provider) → `其他` (other)

---

## 2. Token Accounting Strategy

### 2.1 Multi-source collection & normalization

Each tool has its own collector (`src/collectors/*.mjs`) that reads only local log files. Every collector exports a uniform `collect(pricingData)` returning three kinds of structured data:

- `graphJson` (per-day aggregated usage)
- `modelsJson` (per-session / per-workspace model ranking)
- `eventsJson` (per-event detail)

The three JSONs feed `normalizeDailyRows` / `normalizeSessionRows` / `normalizeTimeRows`; field names are normalized uniformly by `collect.mjs`. **As long as the structure is correct, raw field differences across sources are flattened.**

### 2.2 Token semantics (project-wide)

- **Total tokens = input + cacheRead + output** (i.e. "total input + output").
- Every source's `input` means **cache miss**; cacheWrite and reasoning are shown as separate columns and **not double-counted in the total**.
- **Cache hit rate = cacheRead / (cacheRead + input)**.
- **Command Code special case**: its log `inputTokens` is **total input** (including cache hits), so `extractTokens` must split it into `input = totalInput − cacheRead`, otherwise cache reads would be counted as input a second time.

### 2.3 Incremental collection, watermark, and dedup

- **Watermark**: per `(device, source)`, `MAX(event_time)` is the watermark; only events after the `watermark − 48h` overlap window are written; historical rows are never rewritten.
- **`dedupeEventKeys` must run on the full batch (before any watermark filtering)**, otherwise the `#n` sequence drifts across runs.
- Only `--full` deletes and rebuilds (per-device time_usage deletion and historical cost recomputation at current prices).

### 2.4 Parse cache

- A **file fingerprint (mtime + size)** skips unchanged session files for fast incremental parsing.
- **Caches raw parse records only, never cost** — cost is always recomputed from tokens, so a pricing refresh immediately affects historical fees.
- Bump the `CACHE_VERSION` at the top of a collector when its parsing logic changes, or the old cache will be hit.

---

## 3. Token Cost Calculation Strategy

> **Note: all costs are estimates** — computed as "official rate × token usage", not vendor invoices. Cost precision is not a hard requirement, and a few known deviations exist: ① some models (e.g. DeepSeek) are officially priced in CNY only; the USD constants in code are converted at approximate FX rates — v4-flash at ≈7.14, v4-pro at ≈6.9, which don't exactly match the dashboard display rate `USD_CNY_RATE` (default 7.15), giving ~3–4% deviation in CNY display; ② historical-date costs are price-locked and don't drift with refreshes (see 3.3); ③ aggregated rows use single-tier rates, only per-event rows use tiered rates.

### 3.1 Pricing data-source priority

`loadPricing` resolves prices in this order (the normal path is **offline**; `npm run collect` never touches the network):

1. In-memory singleton;
2. Bundled `data/pricing-litellm.json` local cache;
3. Only when `PRICING_REFRESH=1` (the "refresh pricing" button / `npm run pricing:update`) does it fetch LiteLLM online, persisting to disk on success to overwrite the local cache;
4. Falls back to a stale disk cache if the network fetch fails;
5. Hardcoded Cursor / DeepSeek official overrides;
6. Otherwise 0 cost.

### 3.2 Tiered billing

`calculateCost(model, tokens, pricingData, provider, options)` estimates cost using each model's official per-token rate, with separate rates for input / output / cache-read / cache-write / reasoning:

- **Aggregated rows pass `{ tiered: false }`** — single-tier rate multiplied directly;
- **Per-event rows use tiered rates** — discounted above thresholds: input / output / reasoning have four tiers at 128k / 200k / 256k / 272k, cache-read has two tiers at 200k / 272k, cache-write one tier at 200k.

### 3.3 Historical price lock

A past date's `cost_usd` and `pricing_locked_at` in `daily_usage` are locked once set; re-running collection **does not recompute** (the upsert CASE logic), keeping the dashboard's historical fees stable and immune to pricing-refresh drift; only `--full` rebuilds.

### 3.4 Subscription-bucket billing

The provider/subscription dimension is split orthogonally into subscription buckets (see 1.5). Each bucket bills with its own rates, and the dashboard-top pills inline-show each subscription's token volume and cost under the current filter (time / source / device / model) — selecting one subscription does not zero out the others, preserving comparison.

---

## Appendix: Commit History

All commits after the fork point (`git diff --stat origin/main..main`: 4 commits, 47 files, +2477 / −186).

### Commit 1 — `2e06fe3` feat: add Command Code collector, pricing refresh, CNY display and path generalization

Adds the Command Code collector, the `/usage` per-call feed and its paged endpoint, online pricing refresh with status APIs, USD/CNY toggle, DeepSeek official-rate corrections (legacy V3.2/R1 mispricing) plus a dedicated reasoning rate, `AI_TOKEN_DASHBOARD_COLLECTOR_HOME` path generalization, OpenCode XDG/`dataDir` fixes, the first token-semantics fix, seed-demo alignment, and tests.

### Commit 2 — `ccf7800` fix: correct Command Code token semantics and align cost with official billing

Splits Command Code's `inputTokens` (total input) into uncached input + cache reads; drops the unreliable `costUsd` and recomputes at official three-tier rates; `tokenTotal = input + cacheRead + output`; adds `Input(total)` and `Input(uncached)` columns to the tables / usage feed; tests updated (62 passing).

### Commit 3 — `c90dfd7` feat: endpoint-based subscription classification, cc-switch collector and orthogonality fixes

Adds the CC-Switch collector; classifies subscriptions by API endpoint (`providerOf`); adds the `provider` column to `daily_usage` / `time_usage` (all three schemas); Hermes `profiles/*/state.db` scanning and provider derivation; daily/time filter orthogonality fixes.

### Commit 4 — `640a3f6` fix: orthogonal subscription filter, live provider pills, natural-month comparison

All previously uncommitted working-tree changes were finalized in this commit:

- **Subscription-filter orthogonality** (`src/client/shared/utils.js`): removes the `!r.provider` short-circuit in `filterDaily`/`filterTime` — previously rows without a provider (Claude Code / Codex CLI) passed the filter unconditionally no matter which subscription was selected, leaving the first Top-model entry frozen. Now every row is classified by `providerOf` and filtered accordingly.
- **Live subscription-pill numbers** (`src/client/dashboard/App.jsx`): `providerStats` now aggregates rows filtered by every dimension except the subscription one, so pill numbers track the active date/source/device/model filters in real time.
- **Previous-period comparison fix** (`src/client/dashboard/App.jsx`): for "本月" (this month), `compareData` now compares against the **full previous natural month** instead of an equal-length look-back (e.g. this month 08-01~08-13 → previous 07-01~07-31); "today → yesterday" and "N days → adjacent previous N days" are unchanged.
- **New "本月" (this month) time-filter chip** (`components-top.jsx`): filters from the 1st of the current month to today.
- **KPI label tweak** (`App.jsx`): "估算费用" → "按量计费估算费用", making clear the cost is an estimate, not a vendor invoice.
- **Currency button rate hint** (`components-top.jsx` / `styles.css`): the button shows `汇率按 {USD_CNY_RATE} 估算` (exchange-rate estimate), the value following `window.__ENV__` injection or a localStorage override.
- **Command Code taste note** (`components-top.jsx` / `styles.css`): the subscription pill gains a hover hint — local stats exclude taste flows, so actual billed usage is expected to be higher. Display-only.
- **Regression tests** (`test/client-utils.test.mjs`): adds cases for `providerOf` classification and for `filterDaily`/`filterTime` filtering empty-provider rows by subscription.
- **Adds `docs/fork-changes.md`**; updates the OpenRouter pricing cache (+3 models: qwen3.8-2.4t / grok-4.6 / deepseek-v4-pro-0813).

### Current working tree

> Clean — no uncommitted changes; all previous working-tree changes were fixed in Commit 4.
