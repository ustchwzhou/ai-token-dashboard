# 新增 Command Code (cmdc) Token 统计 Collector + 路径核查

## 背景与核查结论

### 1. 目录迁移方式核查（用户问题 2）

用户将各 agent 配置/数据移到 `D:\WSL2Backup\cache_mv`，实际机制是 **junction 目录联接（目录）+ symlink（文件）**，不是环境变量：

- 迁移脚本：`D:\WSL2Backup\cache_mv\migrate-dotfiles.ps1`（目录 → Junction，文件 → SymbolicLink 到 `dotfiles/`）
- 清单：`D:\WSL2Backup\cache_mv\.junction-manifest.json`（2026-05-19，`homeDir: C:\Users\smart`）
- 已 junction 的目录：`.claude`、`.codex`、`.config`、`.cache`、`.data`、`.local`、`.commandcode`（部分）、`.agents` 等
- **环境变量只设了 6 个**：`XDG_CONFIG_HOME`、`XDG_CACHE_HOME`、`XDG_DATA_HOME`、`NVM_HOME`、`PNPM_HOME`、`HF_HOME`（均为 D:\WSL2Backup\cache_mv 下）
- 各 agent 实际数据落点：
  - Claude Code：`D:\WSL2Backup\cache_mv\.claude\projects\`（junction）— collector 默认 `~/.claude` 走 junction 自动生效
  - Codex：`D:\WSL2Backup\cache_mv\.codex\`（junction）— collector 默认 `~/.codex` 自动生效
  - OpenCode：`D:\WSL2Backup\cache_mv\.data\opencode\` + `.local\share\opencode\`（junction，XDG_DATA_HOME）
  - Command Code：`D:\WSL2Backup\cache_mv\.commandcode\`（**真实目录**，C 盘 `C:\Users\smart\.commandcode` 是残留空壳，仅含 auth.json/config.json 等少量文件；实际会话文件全在 D 盘）
  - **Hermes：`C:\Users\smart\.hermes\` 是真实目录，未迁移到 D 盘**（junction manifest 中无 `.hermes`，D 盘无此目录）。hermes collector 默认 `~/.hermes/state.db` 仍正常，**本次不动它，仅说明**
  - OpenClaw：`C:\Users\smart\.openclaw\` 真实目录，未迁移（collector 默认路径自动生效）

**对 dashboard 的影响**：现有 collector 全部用 `~` 展开（`os.homedir()`），junction 对应用透明，**无需改任何现有 collector 路径配置**。唯一需要新增的是 cmdc。

### 2. Command Code 数据格式核查（用户问题 1）

cmdc 会话文件位置：`~/.commandcode/projects/<project-slug>/<session-id>.jsonl`

JSONL 结构（已实测验证）：
```
{"type":"session","version":3,"id":"...","timestamp":"...","cwd":"D:\\..."}          ← 首行
{"type":"message","id":"...","parentId":...,"timestamp":"...","message":{...},"usage":{"inputTokens":31967,"outputTokens":314,"cacheReadTokens":7936,"cacheWriteTokens":0,"costUsd":0.0045855208},"model":"deepseek/deepseek-v4-flash","effort":"max"}   ← assistant 消息
```

关键点：
- usage 挂在**消息对象顶层**（`obj.usage`），不是 `obj.message.usage`（与 claude 不同）
- 字段为**驼峰命名**：`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`costUsd`
- **无 reasoning 字段**；`costUsd` 是实际计费金额（精度高，优先采用）
- `model` 在消息顶层（如 `deepseek/deepseek-v4-flash`）
- `cwd` 在首行 session 记录中，作为 workspace 标签
- 仅 `type === 'message'` 且 `message.role === 'assistant'` 且带 `usage` 的行是有效记录

---

## 实施步骤

### 1. 新建 `src/collectors/command-code.mjs`

以 `src/collectors/claude-code.mjs` 为模板（JSONL 结构最接近），关键差异：

**路径解析**（用户选定：环境变量优先）：
```js
export function getCommandCodeRoots() {
  // 支持 COMMANDCODE_HOME 或 CMDC_HOME 环境变量（逗号分隔多根）
  const envRoots = envPathList(process.env.COMMANDCODE_HOME || process.env.CMDC_HOME);
  if (envRoots.length) return envRoots;
  // 配置块：config/collectors.json 的 commandcode.roots，默认 ~/.commandcode
  return configuredPaths('commandcode', 'roots', ['~/.commandcode']);
}
```
- 扫描 `<root>/projects/*/<session>.jsonl`（递归收集 `.jsonl`，跳过 `.checkpoints.jsonl`）
- workspace 标签：project 目录名（如 `d-work-000-ai-ai-token-dashboard`），可仿 claude 的 `decodeWorkspaceLabel` 解码

**usage 解析**（驼峰 → 通用结构）：
```js
function extractTokens(usage = {}) {
  return {
    input: usage.inputTokens || 0,
    output: usage.outputTokens || 0,
    cacheRead: usage.cacheReadTokens || 0,
    cacheWrite: usage.cacheWriteTokens || 0,
    reasoning: usage.reasoningTokens || 0   // 通常为 0
  };
}
```

**去重**：同一 assistant 消息可能被追加/覆盖，用 `obj.id` 去重、按字段取最大（复用 claude 的 `mergeUsageMax` 思路，改为驼峰字段）。

**成本**（用户选定：优先 costUsd）：
```js
const costUSD = record.costUsd > 0 ? record.costUsd : calculateCost(model, tokens, pricingData);
```

**导出**：
- `CLIENT_KEY = 'commandcode'`、`SOURCE_LABEL = 'Command Code'`
- `collect(pricingData)` 返回 `{ graphJson, modelsJson, eventsJson }`，聚合逻辑完全复用 claude collector 的 `aggregateRecord`/`dailyMap`/`wmMap` 模式

### 2. 注册 collector — `src/collect.mjs`

`COLLECTORS` 数组（L10-17）加入：
```js
{ module: './collectors/command-code.mjs', label: 'Command Code' }
```

`sourceLabel()`（L230-240）加入映射：
```js
commandcode: 'Command Code'
```

### 3. 配置块 — `config/collectors.json`

`collectors` 下新增：
```json
"commandcode": {
  "roots": ["~/.commandcode"]
}
```
（用户 D 盘场景通过 junction 自动生效；如需显式指向可配 `["D:\\WSL2Backup\\cache_mv\\.commandcode"]`）

### 4. 前端显示

- `src/client/dashboard/source-icons.js`：加 `commandcode` 图标（复用 claude 风格或新增）
- `src/client/shared/utils.js` `PALETTE`：加一种颜色（可选，有 fallback）

### 5. 测试 — `test/command-code.test.mjs`

仿 `test/codex.test.mjs`：构造临时 JSONL 会话文件（含 session 首行 + assistant 带驼峰 usage 的消息），验证：
- 路径解析（环境变量优先 / 配置 / 默认）
- usage 字段映射正确
- costUsd 优先于计算成本
- 输出 graphJson/modelsJson 结构符合通用格式

### 6. 文档 — `README.md` / `README.en.md`

"支持的数据源"表加一行 Command Code，注明 `~/.commandcode/projects` 与 `COMMANDCODE_HOME`/`CMDC_HOME` 环境变量覆盖。

---

## 无需改动

- 数据库 schema（`source` 自由文本列，4 张表通用）
- `src/server.mjs` API、前端聚合逻辑（source 无关）
- `src/pricing.mjs` 主流程（cmdc 用自带 costUsd）
- 现有 6 个 collector（junction 机制透明）

## 验证方式

1. `npm test`（新增测试通过，旧测试不回归）
2. `npm run collect`，确认输出含 `[Command Code] daily=..., time=..., workspace_model=...`
3. 打开 `npm run dev` 看板，确认 Command Code 出现在 source 列表、daily/time/session 数据正确
4. 检查 `data/usage.sqlite` 中 `daily_usage`/`time_usage`/`session_usage` 出现 `source='Command Code'` 行
5. 验证增量：再跑一次 `npm run collect`，确认无重复累计（水位线 + event key 去重生效）

## 参考文件

- 模板：`src/collectors/claude-code.mjs`（JSONL 解析 + 聚合 + parse-cache）
- 配置层：`src/collector-config.mjs`（`envPathList`/`configuredPaths`/`expandPath`）
- 注册：`src/collect.mjs`（COLLECTORS、normalize*、sourceLabel）
- 缓存：`src/collectors/parse-cache.mjs`（`cachedParse`/`flushCache`）
- 定价：`src/pricing.mjs`（`calculateCost`）
- 测试参考：`test/codex.test.mjs`
