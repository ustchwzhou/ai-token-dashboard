# AI Token Dashboard 通用化改造计划

## 背景

用户要求项目具备通用性（非个人定制），三大目标：
1. **token 计算正确性**（input/缓存命中率/output/总token）
2. **按官方最新计费计算流量花费**（美元/人民币双单位）
3. **路径变量化**（不硬编码 D 盘等特定路径）

已用 3 个并行 explore 代理完成全量核查，以下为核查结论 + 修改计划。

---

## 一、核查结论

### 1. Token 计算（大部分已正确 ✅）

| 项 | 现状 | 结论 |
|---|---|---|
| `tokenTotal`（utils.mjs L105）| `input + output`（不含 cache/reasoning）| ✅ 正确 |
| 缓存命中率（shared/utils.js L224）| `cacheRead/(cacheRead+input)` | ✅ 正确 |
| Claude/Codex/Gemini/Hermes/cmdc 的 input 语义 | 均已从 cache 拆分 | ✅ 正确 |
| opencode 的 input | 实测 `input:855, cache.read:24192`，**不含 cache** | ✅ 正确（无需拆分）|
| openclaw 的 input | `usage.input` 原值，**语义待验证**（可能含 cacheRead）| ⚠️ 需实测 |
| reasoning 计费 | 按 output 价（`(output+reasoning)*p.output`）| ✅ 各源独立字段 |
| `seed-demo.mjs` L139 | demo totalTokens 含 cache+reasoning | ⚠️ 与生产不一致 |

### 2. 计费（有明确问题 ⚠️）

| 项 | 现状 | 结论 |
|---|---|---|
| 定价单位 | per-token（$），公式 `input×p + (out+reason)×p_out + cr×p_cr + cw×p_cw` | ✅ 正确 |
| `DEEPSEEK_OVERRIDES`（pricing.mjs L65-70）| deepseek-chat $0.14/$0.28 过时，官方 V3.2 是 $0.28/$0.42（低估一半）；缓存 $0.0028 vs 官方 $0.028（低估 10 倍）| ❌ **需修** |
| reasoning 专用价 | `output_cost_per_reasoning_token` 字段存在但未映射 | ⚠️ 用户选定：支持 |
| 价格时效性 | 依赖本地缓存 `data/pricing-*.json`（fetchedAt≈2026-07-15），`npm run pricing:update` 才刷新 | ⚠️ 用户选定：加按钮 |
| **USD→CNY 换算** | **完全缺失**（全链路 USD）| ❌ 用户选定：环境变量汇率 + 前端切换 |

### 3. 路径通用性（有硬编码 ❌）

| 项 | 现状 | 结论 |
|---|---|---|
| `config/collectors.json` L47 | **`D:\WSL2Backup\cache_mv\.commandcode` 唯一硬编码绝对路径** | ❌ 需修 |
| `~/.data/opencode`（L34）| 非标准默认，**压过 XDG_DATA_HOME** | ⚠️ 需恢复标准 |
| gemini.mjs | 路径写死 `~/.gemini/tmp`，**零可配置** | ⚠️ 需加 env/config |
| openclaw.mjs | 无 env、无代码内默认值（缺配置静默采 0）| ⚠️ 需加默认+env |
| XDG 支持 | 仅 opencode 认 XDG_DATA_HOME | ⚠️ 需推广 |
| quota.mjs | 3 处 homedir 拼接不走统一解析 | ⚠️ 需统一 |
| `expandPath` | 已支持 `${VAR}`/`$VAR`、`~` | ✅ 复用 |
| `AI_TOKEN_DASHBOARD_COLLECTOR_HOME` | 已有（Docker 用），可作统一根 | ✅ 复用 |

---

## 二、修改计划

### 任务 1：修正 DeepSeek 价格覆盖 + 支持 reasoning 专用价（`src/pricing.mjs`）

1. **`DEEPSEEK_OVERRIDES` 更新为官方最新价**（2026-07 验证）：
   - `deepseek-chat`（V3.2）：input $0.28/M、output $0.42/M、cacheRead $0.028/M
   - `deepseek-reasoner`（R1）：input $0.55/M、output $2.19/M、cacheRead $0.14/M
   - `deepseek-v4-flash` / `deepseek-v4-pro`：保留现有值（flash $0.14/$0.28、pro $0.435/$0.87），注释标注来源
2. **`litellmEntryToRates` 增加 `reasoning` 字段映射**（`output_cost_per_reasoning_token`）
3. **`calculateCost` 中 `reasoning * (p.reasoning ?? p.output)`**（有专用价用专用价，否则回退 output 价）

### 任务 2：价格更新按钮（后端 + 前端）

**后端 `src/server.mjs`**：
1. 新增 `pricingState`（仿 `collectionState`）：`{ status, message, startedAt, finishedAt, fetchedAt, exitCode, stdout }`
2. 新增 `startPricingUpdate()`：spawn `node src/update-pricing.mjs`（设置 `PRICING_REFRESH=1`），完成后重载 `pricingData`（重新 `loadPricing`）
3. 新增端点：
   - `POST /api/pricing/update`（loopback 校验，同 /api/collect）→ 启动更新，返回 202
   - `GET /api/pricing/status` → 返回 `pricingState` + 当前缓存 `fetchedAt`
4. `/api/data` 响应附带 `pricingFetchedAt`（从定价文件读）

**前端**：
5. `src/client/dashboard/components-top.jsx` Topbar 加"更新单价"按钮（仿"采集"按钮，显示状态：更新中/上次更新 X）
6. `src/client/dashboard/App.jsx` 加 `pricingStatus` state + `loadPricingStatus()` + 按钮 handler；更新成功后 `loadData()` 重拉（费用自动重算）
7. `usage` 页顶部同样加按钮（可选，若组件复用 Topbar 则自动有）

**记录更新时间**：`data/pricing-*.json` 的 `fetchedAt` 已是时间戳，前端展示为"单价更新于 2026-07-15"。

### 任务 3：人民币换算（前端 + 配置）

1. `src/client/shared/utils.js`：
   - `USD_CNY_RATE`：从 `window.__ENV__?.USD_CNY_RATE || 7.15` 读取（服务端注入），或直接读 `localStorage` 可覆盖
   - 新增 `fmtCNY`（`Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY'})`）
   - 新增 `fmtCost(usd)` → 根据当前货币设置返回 `fmtUS` 或 `fmtCNY`（乘汇率）
2. **汇率注入**：`src/server.mjs` 在 index.html 里注入 `<script>window.__ENV__={USD_CNY_RATE:...}</script>`（读 `process.env.USD_CNY_RATE || 7.15`）
3. 前端加货币切换：Topbar 或设置区加"$/¥"切换按钮，存 localStorage，所有 `U.fmtUS`/`U.fmtUS4` 展示费用的地方换成 `U.fmtCost`（App.jsx KPI、表格、TopModels、Gauge、review 页、usage 页）
4. `.env.example` 加 `USD_CNY_RATE=7.15` 注释说明

### 任务 4：路径全面变量化

1. **`config/collectors.json`**：
   - commandcode `roots` 改为 `["${AI_TOKEN_DASHBOARD_COLLECTOR_HOME}\\.commandcode"]`（无该 env 时 fallback 到 `~/.commandcode`——需在 collector 里做 fallback）
   - opencode `dataDir` **删除**（恢复 XDG_DATA_HOME → `~/.local/share/opencode` 逻辑）
   - 其余保持 `~` 相对路径
2. **`src/collectors/command-code.mjs`**：`getCommandCodeRoots()` 改为 env 优先 → config → `${AI_TOKEN_DASHBOARD_COLLECTOR_HOME}/.commandcode` → `~/.commandcode`
3. **`src/collectors/opencode.mjs`**：config dataDir 缺省时按 `XDG_DATA_HOME` → `~/.local/share/opencode`（已有，确认逻辑）
4. **`src/collectors/gemini.mjs`**：加 `GEMINI_HOME` env + `gemini.tmpDir` config（默认 `~/.gemini/tmp`）
5. **`src/collectors/openclaw.mjs`**：加 `OPENCLAW_HOME` env + 代码内默认 `~/.openclaw/agents`
6. **`src/quota.mjs`**：3 处 `homedir()` 拼接改走 `expandPath`（认 `${AI_TOKEN_DASHBOARD_COLLECTOR_HOME}`）
7. **`src/collector-config.mjs`**：`expandPath` 对未定义变量 warn（`console.warn`），避免静默空串
8. **README.md / README.en.md**：加"路径配置矩阵"（env/config/XDG 优先级），说明 `AI_TOKEN_DASHBOARD_COLLECTOR_HOME` 用法

### 任务 5：openclaw input 语义验证 + 修复

1. 实测 `~/.openclaw/agents/**/sessions/*.jsonl` 的 `usage` 结构（input 是否含 cacheRead）
2. 若含：`openclaw.mjs` 加拆分逻辑（`input = max(0, input - cacheRead)`，仿 codex）
3. 若不含：无需改，补测试断言

### 任务 6：seed-demo 对齐 + 测试更新

1. `scripts/seed-demo.mjs` L139：totalTokens 改为 `inputTokens + outputTokens`（对齐生产语义）
2. 更新 `test/pricing.test.mjs`：DeepSeek 新价、reasoning 专用价用例
3. 更新 `test/config.test.mjs`：`${AI_TOKEN_DASHBOARD_COLLECTOR_HOME}` 展开用例
4. 新增 `test/usage-page.test.mjs`（可选）：/api/usage 分页/过滤

### 任务 7：README 更新

- 数据源表补 gemini/openclaw 的 env/config 说明
- 价格更新按钮用法
- 货币切换说明

---

## 三、验证方式

1. `npm test` 全过（含新用例）
2. `npm run build` 成功
3. `npm run collect`：opencode/cmdc 仍正常采集（路径变量化后）
4. 启动服务：
   - 点"更新单价"按钮 → 状态变化 → 完成 → 费用重算 → 显示"更新于 X"
   - 切换 $/¥ → 所有费用显示人民币
   - 检查 DeepSeek 模型费用 = 官方价计算
5. 设置 `AI_TOKEN_DASHBOARD_COLLECTOR_HOME=D:\WSL2Backup\cache_mv` + 清空 commandcode 配置 → 仍能采集（验证变量化）

## 四、涉及文件清单

| 文件 | 改动 |
|---|---|
| `src/pricing.mjs` | DeepSeek 新价、reasoning 专用价、fetchedAt 暴露 |
| `src/server.mjs` | /api/pricing/update + status、__ENV__ 注入、fetchedAt 附带 |
| `src/update-pricing.mjs` | （已存在，供按钮 spawn）|
| `src/client/shared/utils.js` | fmtCNY、fmtCost、货币状态 |
| `src/client/dashboard/components-top.jsx` | 更新单价按钮、货币切换 |
| `src/client/dashboard/App.jsx` | pricingStatus、切换 handler |
| `src/client/review/*`、`src/client/usage/*` | 费用展示换 fmtCost |
| `config/collectors.json` | commandcode ${VAR}、opencode 删 dataDir |
| `src/collectors/command-code.mjs` | COLLECTOR_HOME fallback |
| `src/collectors/gemini.mjs` | GEMINI_HOME + config |
| `src/collectors/openclaw.mjs` | OPENCLAW_HOME + 默认值 + input 拆分（若需）|
| `src/collectors/opencode.mjs` | 确认 XDG 逻辑 |
| `src/quota.mjs` | expandPath 统一 |
| `src/collector-config.mjs` | 未定义变量 warn |
| `scripts/seed-demo.mjs` | totalTokens 对齐 |
| `test/*` | 新用例 |
| `README.md` / `README.en.md` / `.env.example` | 文档 |
