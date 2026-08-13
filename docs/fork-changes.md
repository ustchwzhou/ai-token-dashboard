# Fork 上游后的改动：功能扩充与技术实现

> 本仓库 fork 自 [`fengguanghuai/ai-token-dashboard`](https://github.com/fengguanghuai/ai-token-dashboard)，fork 点为 `c0d6b4e`（上游主线 HEAD），fork 仅领先、无落后。本文档为**技术/功能扩充记录**，旨在提炼"比上游多了什么、怎么实现的"，提交明细仅作附录。

---

## 一、功能扩充（对照上游 README）

### 1.1 数据源：6 → 8

上游支持 6 个工具，本 fork 扩充到 8 个：

| 状态 | 工具 | 数据位置 | 说明 |
| --- | --- | --- | --- |
| 上游已有 | Claude Code | `~/.claude/projects/` | JSONL 会话记录 |
| 上游已有 | Codex CLI | `~/.codex/sessions/` | JSONL 会话记录 |
| 上游已有 | OpenCode | `~/.local/share/opencode/` | 已修复：尊重 `XDG_DATA_HOME`、支持可配置 `dataDir` |
| 上游已有 | Gemini CLI | `~/.gemini/tmp/` | — |
| 上游已有 | Hermes Agent | `~/.hermes/state.db` | 已增强：扫描 `profiles/*/state.db`、从 `billing_base_url` 推导 provider |
| 上游已有 | OpenClaw | `~/.openclaw/agents/` | — |
| **新增** | **Command Code** | `~/.commandcode/projects/` | JSONL 会话记录，usage 字段为 camelCase、位于消息顶层 |
| **新增** | **CC-Switch** | `~/.cc-switch/cc-switch.db` | 读取 `proxy_request_logs`，回收 agent 数据库已不含的流量（如被裁剪/清空的 Codex 会话），按 request id 去重、按会话聚合 |

### 1.2 前端

- **新增逐调用流水页 `/usage`**：分页展示逐调用明细（`GET /api/usage`），支持按 `source` / `model` 过滤，新记录在前——这是上游没有的第三视图。
- **看板新增「供应商/订阅」筛选维度**：按订阅桶正交过滤；每个订阅 pill 直接内联该订阅在当前筛选下的 Token 量与估算费用。
- **新增「更新单价」按钮**：`POST /api/pricing/update` 拉起 LiteLLM + OpenRouter 联网刷新，暴露 `pricing/status` / `fetchedAt`，内存定价热重载后重算费用。
- **新增 `$ / ¥` 货币切换**：`USD_CNY_RATE`（服务端 `window.__ENV__` 注入）或浏览器 localStorage 覆盖，汇率默认 7.15，两页共用。
- **Token 明细展示细化**：看板表格与流水页同时展示 `Input(total)` 与 `Input(uncached)` 两列，复盘 CSV 增加 `input_total`。

### 1.3 采集能力增强

- **Hermes**：除主库外扫描 `profiles/*/state.db`（回收单个 profile 的 2 亿 + MiniMax tokens）；从 `billing_base_url` 推导 provider；per-db 加 session-id 前缀避免串库；跳过不可读的 profile db 而非中断整个采集。
- **路径泛化**：引入 `${AI_TOKEN_DASHBOARD_COLLECTOR_HOME}` 统一指向迁移根（如换盘后全部 agent 数据搬走）；`GEMINI_HOME` / `OPENCLAW_HOME` 等环境变量覆盖。解析优先级固定为：**工具自身环境变量 → `config/collectors.json` → `${AI_TOKEN_DASHBOARD_COLLECTOR_HOME}` → `~` 默认路径**；路径支持 `~`、`${VAR}`、`$VAR` 展开。

### 1.4 计费与口径

- **Token 语义全项目统一**（见下文「Token 统计策略」）。
- **Command Code 按官方三档单价计费**：弃用其自身不可靠的 `costUsd`，一律按官方单价重算（deepseek-v4-flash：未命中 `$0.14/M`、缓存命中 `$0.0028/M`、输出 `$0.28/M`），与官方 usage 接口 38 行窗口比对聚合偏差 0.1%。
- **DeepSeek 按官方 V4 单价计费**：`deepseek-v4-flash`（未命中输入 `$0.14/M`、输出 `$0.28/M`、缓存命中 `$0.0028/M`）、`deepseek-v4-pro`（未命中输入 `$0.435/M`、输出 `$0.87/M`、缓存命中 `$0.003625/M`），源自官方定价页（官方以人民币计价，美元价按汇率折算）。同时修正了上游把 legacy 的 `deepseek-chat` (V3.2) / `deepseek-reasoner` (R1) 错配为 v4-flash 价格的历史错误，并把推理（reasoning）从 output 中拆出，支持独立的 `output_cost_per_reasoning_token` 费率。
- **历史日期费用锁定**：过去的 `cost_usd` 与 `pricing_locked_at` 一旦锁定，重跑采集不重算；仅 `--full` 才删表按当前价格重算历史成本。

### 1.5 数据模型

- `daily_usage` / `time_usage` 增加 **`provider` 列**（sqlite / postgres / mysql 三套 schema + upsert 路径）。
- **订阅分类**（前端 `providerOf`）：按 API 端点把用量归到正交的计费桶——
  - `opencode_go` → `订阅-Opencode Go`
  - `minimax_cn` / `minimax_cn_coding_plan` → `订阅-MiniMax`
  - `agnes` → `订阅-Agnes`
  - `-free` 后缀模型、`opencode` provider → `免费`
  - `deepseek` → `按量计费-DeepSeek`
  - 其余（含无 provider 的 Claude Code / Codex CLI）→ `其他`

---

## 二、Token 统计策略

### 2.1 多源采集与归一化

每个工具一个 collector（`src/collectors/*.mjs`），只读本机日志文件。所有 collector 导出统一的 `collect(pricingData)`，返回三种结构化数据：

- `graphJson`（按天聚合的用量）
- `modelsJson`（按会话/工作区的模型排行）
- `eventsJson`（逐事件明细）

三个 JSON 分别交给 `normalizeDailyRows` / `normalizeSessionRows` / `normalizeTimeRows`，字段名由 `collect.mjs` 统一归一。**只要结构正确，各源日志的原始字段差异被全部抹平。**

### 2.2 Token 口径（全项目统一）

- **总 Token = input + cacheRead + output**（即"总输入 + 输出"）。
- 各数据源的 `input` 统一为**缓存未命中**语义；cacheWrite 与 reasoning 作为独立列展示，**不重复计入总数**。
- **缓存命中率 = cacheRead / (cacheRead + input)**。
- **Command Code 特例**：其日志的 `inputTokens` 是**总输入**（含缓存命中），必须在 `extractTokens` 里拆成 `input = totalInput − cacheRead`，否则会把缓存读重复计一次输入。

### 2.3 增量采集、水位线与去重

- **水位线**：按 `(device, source)` 取 `MAX(event_time)` 作为水位线，只写入 `watermark − 48h 重叠窗口` 之后的事件，历史行永不改写。
- **`dedupeEventKeys` 必须在全量批次上运行（任何水位线过滤之前）**，否则 `#n` 序号会跨次漂移。
- `--full` 才允许删表重算（按设备删除 time_usage 并按当前价格重算历史成本）。

### 2.4 解析缓存（parse-cache）

- 按**文件指纹（mtime + 大小）**跳过未变化的会话文件，增量解析快。
- **只缓存原始解析记录，绝不缓存成本**——成本永远从 token 重算，这样定价刷新后历史费用能即时反映新单价。
- collector 解析逻辑变化时需 bump 文件顶部 `CACHE_VERSION`，否则命中旧缓存。

---

## 三、Token 花费计算策略

> **注意：所有费用都是估算值**，按"官方单价 × token 用量"估算，并非厂商账单。成本计算对精度要求不高，存在几类已知偏差：① 个别模型（如 DeepSeek）官方仅以人民币计价，代码内美元常量按近似汇率折算——v4-flash 按 ≈7.14、v4-pro 按 ≈6.9，与看板展示汇率 `USD_CNY_RATE`（默认 7.15）不完全一致，CNY 展示时约有 3%~4% 偏差；② 历史日期费用被价格锁定，不随刷新漂移（见 3.3）；③ 聚合行用单档单价、逐事件才用分级单价。

### 3.1 定价数据源优先级

`loadPricing` 按以下顺序取价（正常路径**离线**，`npm run collect` 不联网）：

1. 内存单例；
2. 随仓库的 `data/pricing-litellm.json` 本地缓存；
3. 仅当 `PRICING_REFRESH=1`（即「更新单价」按钮 / `npm run pricing:update`）时联网拉 LiteLLM，成功后落盘覆盖本地缓存；
4. 联网失败时用 stale 磁盘缓存兜底；
5. 硬编码的 Cursor / DeepSeek 官方覆盖；
6. 都取不到则按 0 成本。

### 3.2 分级计费

`calculateCost(model, tokens, pricingData, provider, options)` 按模型官方 per-token 单价估算，输入/输出/缓存读/缓存写/推理各有独立单价：

- **聚合后的行传 `{ tiered: false }`**，用单档单价直接相乘；
- **逐事件用分级（tiered）单价**，超阈值降档——输入/输出/推理有 12.8 万 / 20 万 / 25.6 万 / 27.2 万四档，缓存读有 20 万 / 27.2 万两档，缓存写有 20 万一档。

### 3.3 历史价格锁定

`daily_usage` 上过去日期的 `cost_usd` 与 `pricing_locked_at` 一旦锁定，重跑采集**不重算**（upsert 的 CASE 逻辑），保证看板历史费用稳定、不随定价刷新漂移；`--full` 才允许删表重算。

### 3.4 订阅分类计价

订阅/供应商维度按「订阅桶」正交切分（见 1.5）。每个桶按各自口径计价，看板顶部 pill 内联显示各订阅在当前筛选（时间/来源/设备/模型）下的 token 量与费用——选中某个订阅不会清零其他订阅的数字，便于对比。

---

## 附录：提交记录

以下为 fork 点之后的所有提交（`git diff --stat origin/main..main`：4 个提交，47 文件，+2477 / -186）。

### 提交 1 — `2e06fe3` feat: add Command Code collector, pricing refresh, CNY display and path generalization

新增 Command Code 采集器、`/usage` 逐调用流水页及分页接口、联网定价刷新与状态接口、USD/CNY 切换、DeepSeek 官方费率修正（legacy V3.2/R1 错价）+ 独立推理费率、`AI_TOKEN_DASHBOARD_COLLECTOR_HOME` 路径泛化、OpenCode 的 XDG/`dataDir` 修复、token 语义首次修正、seed-demo 对齐与测试。

### 提交 2 — `ccf7800` fix: correct Command Code token semantics and align cost with official billing

Command Code 的 `inputTokens`（总输入）拆分为未命中 input + cache read；弃用不可靠的 `costUsd`、按官方三档单价重算；`tokenTotal = input + cacheRead + output`；表格/流水页增加 `Input(total)` 与 `Input(uncached)` 双列；测试同步更新（62 个通过）。

### 提交 3 — `c90dfd7` feat: endpoint-based subscription classification, cc-switch collector and orthogonality fixes

新增 CC-Switch 采集器；按 API 端点做订阅分类（`providerOf`）；`daily_usage`/`time_usage` 增加 `provider` 列（三套 schema）；Hermes `profiles/*/state.db` 扫描与 provider 推导；daily/time 过滤的正交性修复。

### 提交 4 — `640a3f6` fix: orthogonal subscription filter, live provider pills, natural-month comparison

此前工作区的全部改动在本提交固化：

- **订阅过滤正交化**（`src/client/shared/utils.js`）：去掉 `filterDaily`/`filterTime` 中 provider 过滤的 `!r.provider` 短路——原先空 provider 的行（Claude Code / Codex CLI）在选中任何订阅时都无条件通过，导致 Top 模型第一条永远不变。修复后每行统一按 `providerOf` 归类再过滤。
- **订阅 pill 数字联动**（`src/client/dashboard/App.jsx`）：`providerStats` 改由"排除订阅外所有维度过滤后"的行聚合，随日期/来源/设备/模型筛选实时变化。
- **对比上一周期修复**（`src/client/dashboard/App.jsx`）：`compareData` 对「本月」由"等长前推"改为**完整上个自然月**（如本月 08-01~08-13 → 上一周期 07-01~07-31）；「今天→昨天」「N 天→紧邻前 N 天」保持不变。
- **时间筛选新增「本月」**（`components-top.jsx`）：点击自动筛选本月 1 日至今。
- **KPI 文案调整**（`App.jsx`）：「估算费用」→「按量计费估算费用」，明确是估算、非厂商账单。
- **货币切换按钮加汇率提示**（`components-top.jsx` / `styles.css`）：按钮显示 `汇率按 {USD_CNY_RATE} 估算`，数值随 `window.__ENV__` 注入或 localStorage 覆盖变化。
- **Command Code taste 提示**（`components-top.jsx` / `styles.css`）：订阅 pill 加 hover 提示——本地统计未含 taste 流水，实际耗费用量预计偏低。纯展示层。
- **回归测试**（`test/client-utils.test.mjs`）：新增 `providerOf` 分类、`filterDaily`/`filterTime` 对空 provider 行的订阅过滤用例。
- **新增 `docs/fork-changes.md`**；更新 OpenRouter 定价缓存（+3 模型：qwen3.8-2.4t / grok-4.6 / deepseek-v4-pro-0813）。

### 当前工作区

> 干净，无未提交改动；此前工作区改动均已随提交 4 固化。