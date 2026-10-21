# settings · 设置写侧面（provider / 系统提示词 / 预设 / MCP / 网络代理 / 主题）

本文件覆盖六个 capability id：

- `settings.provider`（P0）
- `settings.system-prompt`（P1）
- `settings.preset`（P2）
- `settings.mcp`（P2）
- `settings.network-proxy`（P1）
- `settings.theme`（P2）

共同形态：**设置页 UI 动作 → WS RPC → runtime service 写盘 → reply/广播 → UI 回读**。
断言纪律：**写盘为准**（UI 显示成功不算成功；UI 回显一致 + 文件对照才成立）。
设置模态的公共锚点：`settings-close-btn` / `settings-back-btn` / `settings-nav-<id>`
（出处：`packages/renderer/src/components/settings/SettingsModal.vue`，grep `data-testid`；
nav id 清单同文件 `MENU` 常量：`provider` / `skill` / `agent` / `extension` / `mcp` /
`preset` / `appearance` / `system-prompt` / `rename-session` / `tts` / `terminal` /
`worktree` / `update` / `remote-access` / `network-proxy` / `system` / `usage`）。
打开设置的用户入口：侧栏底部设置按钮（`sidebar-settings`，`Sidebar.vue`）。

---

## settings.provider · 模型 provider 管理

- **通道**：A（设置页 provider 列表）/ B（`config.getProviders` reply + `config.providerUpdated` 广播）/ C（`<dataDir>/agent/models.json`、`<dataDir>/agent/config/providers.json`、`<dataDir>/agent/auth.json`）
- **前置**：`requires: none`（常规实例或 faux 实例都可；faux 实例列表里只有 `faux` 一个 provider）
- **用于**：`p0-settings-provider`（covers: `settings.provider`, `env.ready`）；现有用户剧本
  `features/settings-provider.md`（本文件与它对齐，不重复其步骤）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：`sidebar-settings` → 设置 modal → `settings-nav-provider` → provider 列表。
- 协议：`config.getProviders` / `config.setProvider` / `config.toggleProviderEnabled` /
  `config.removeProviderByKind` / `config.deleteProvider` / `config.setDefaultModel` /
  `config.discoverModels` / `config.revealProviderApiKey` / `config.oauthLogin`
  （出处：`packages/shared/src/protocol.ts` 的 ClientMessageMap，grep `config.getProviders`）。
- 写盘落点（三文件，按字段域划分）：
  - `models.json`：pi schema 内字段（providers/models/apiKey/baseURL）；跨进程锁 + 字段域合并；
  - `config/providers.json`：taiji 私有 extras（`remoteSource`、quota、authMethod、modelStates）；
  - `auth.json`：OAuth 凭据。
  路径出处：`packages/shared/src/paths.ts` 的 `getPiAgentDir`（=`<dataDir>/agent`）+
  `packages/runtime/src/infra/pi/pi-paths.ts` 的 `getProviderExtrasPath`。
- 现有 testid（**权威清单 = `features/settings-provider.md` 的 Sub-features 段**）：
  `provider-list-header` / `provider-card` / `provider-expand-body` / `provider-default-pill` /
  `provider-delete-btn`（自建，`kind !== 'catalog'`）/ `provider-remove-btn`（catalog 来源）/
  `provider-action-error` / `provider-auth-badge` / `provider-dirty-badge` /
  `provider-catalogs-stale`（出处：`packages/renderer/src/components/settings/provider/ProviderPage.vue`）。

### 驱动

1. 打开设置 → `settings-nav-provider` → `expectVisible(testid=provider-list-header)`。
2. 列表一致性：`provider-card` 计数 = 计数徽标数（同页 header 文本）。
3. 展开/收起：点某行 → `provider-expand-body` 可见 → 再点收起。
4. 设默认：展开非默认 provider → 点设默认动作 → `provider-default-pill` 迁移到目标行。
5. 启用开关 → reply 后行内 `provider-dirty-badge` 消失（保存成功信号）。
6. 删除：自建走 `provider-delete-btn`，catalog 来源走 `provider-remove-btn`；该行消失、计数 -1。
7. 失败面：断开 runtime（不推荐）或写只读文件后可复现 `provider-action-error`；
   **更稳的失败注入 = 把 `models.json` 改成非法 JSON**（runtime 侧拒绝写入），
   然后做一次保存动作。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | `provider-card` 数 = 计数徽标值 | 两者不等 = 去重/过滤逻辑或列表未刷新 |
| 2 | A | 设默认后 `provider-default-pill` 唯一且随目标行 | 出现两个 pill = 迁移未做（旧默认未清） |
| 3 | C | `models.json` 的 `defaultProvider` 字段 = 目标 id；providers 条目数随增删变化 | 文件没变 = RPC 未落盘（只看 UI 会假绿） |
| 4 | C | `config/providers.json` 的 extras 未被整表覆盖（前后 diff 只剩目标字段变化） | 其它 provider 的 `remoteSource`/quota 丢失 = 字段域合并退化 |
| 5 | B | `config.setProvider` 的 reply 为成功信封（非 error envelope） | reply error = 写侧拒绝（锁/校验） |

> 3/4 是 C 的核心：**provider 配置是首次使用必经路径，写坏 `models.json` 会让 pi 整表拒载**。
> 任何写动作都必须做「文件前后对照」，不能只截图。

### 证据（A/B/C 各抓什么）

- **A**：`provider-list.png`、`provider-expanded.png`、`provider-error.png`；DOM 抓
  `provider-card` 数量 + `provider-default-pill` 的宿主行 title。
- **B**：`config.getProviders` 前后 reply（截断 providers 名与 enabled 状态）。
- **C**：`models.json` / `config/providers.json` 的前后副本（`attach` 两个文件全文，
  敏感字段 apiKey 用占位替换）；`ls -l` 展示文件 mtime 变化。

### 证不了

- **真实 provider 连通性**（发一条真实模型请求）：需要 `custom-provider` 凭证，
  与设置页写侧无关；本 capability 只验配置面。→ 连通性归 `model.list` / `chat.send`。
- **OAuth 登录全链**：`config.oauthLogin` 会拉起浏览器授权，CDP 不可驱动 → 记
  `verified-unreachable`（前置 = 真实授权码回调）。
- **远程清单合并语义**（`remoteSource` 的「同 id 覆盖 / 新 id 追加 / 不删除本地」）：
  需要改 `configs/remote/builtin-providers.json` 并等 raw CDN，验收成本高，
  当前只登记为「设计约定，未真机验」。

### Gotchas

- faux 实例的 provider 列表 = `faux` 一个（`seed-faux.mjs` 写入）；要验多 provider 形态
  用常规实例（模板种子）或手工预置 `models.json`。
- 删除按钮按来源二分（`provider-delete-btn` vs `provider-remove-btn`），拿错 testid 会
  「点了没反应」。
- 「返回」是 `settings-back-btn`（移动形态），桌面关 modal 用 `settings-close-btn`。
- 该页失败常驻错误条是 `provider-action-error`，不是 toast；断言要等元素出现而非等 toast。
- `provider-action-error` 出现后一次成功动作会清错；别把「错误条消失」当成功证明
  ——成功证明是文件。

---

## settings.system-prompt · 系统提示词替换 / 追加

- **通道**：A（SystemPromptPage 两张卡）/ B（`config.getSystemPrompt` / `setSystemPrompt` + `config.systemPrompt` 广播）/ C（`<dataDir>/system-prompt.json`、pi session 的 `taiji:system-prompt` trace entry）
- **前置**：`requires: faux`（要验「生效」必须让 agent 跑一轮）+ 依赖 `chat.send` / `chat.wait` / `extension.load`
- **用于**：`p1-settings-system-prompt`（covers: `settings.system-prompt`, `chat.send`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：设置 → `settings-nav-system-prompt` → `system-prompt-page`。
- testid 权威：`docs/testing/03-runtime-extensions.md` §3（13 个 testid：`system-prompt-replace-switch`
  / `-input` / `-discard` / `-reset` / `-save`、`system-prompt-default-toggle` / `-copy` / `-content`、
  `system-prompt-append-switch` / `-input` / `-discard` / `-save`，外加页根 `system-prompt-page`）。
  **本文件不复刻该表**；`system-prompt-capability-row` / `system-prompt-capability-switch`
  是源码新增的第三卡（出处：`packages/renderer/src/components/settings/system/SystemPromptPage.vue`），
  `03-runtime-extensions.md` **尚未登记**（见报告「查证失败」）。
- 协议：`config.getSystemPrompt` / `config.setSystemPrompt`（payload `{ config: SystemPromptConfig }`；
  reply `config.systemPrompt`，出处 `packages/shared/src/protocol.ts`）。
- 写盘：`<dataDir>/system-prompt.json`（**不是** config.json，独立文件；
  出处：`packages/runtime/src/services/system-prompt-config-helper.ts` 文件头 + `systemPromptPath`）。
- 生效链：`replace.prompt` 走 pi `--system-prompt`（启动期注入），`append.prompt` 走
  `--append-system-prompt` / 每轮 `before_agent_start`；长度上限 `SYSTEM_PROMPT_MAX_LENGTH = 16000`
  （`packages/shared/src/constants.ts`）。**改动对已存在 session 的生效时机 =
  下一轮/下次 spawn**，不要断言「立刻改变当前 system prompt」。

### 驱动

1. `settings-nav-system-prompt` → `system-prompt-page`。
2. 替换卡：`system-prompt-replace-switch` 打开 → `system-prompt-replace-input` 可编辑 →
   `pressSequentially` 输入哨兵串（如 `SENTINEL-REPLACE-9137`）→ `system-prompt-replace-save`
   变可用 → 点击。
3. 断言保存成功：`system-prompt-replace-save` 回到 disabled（dirty=false）+ 文件对照。
4. 追加卡：`system-prompt-append-switch` → `system-prompt-append-input` → save。
5. 参考区：`system-prompt-default-toggle` 展开 → `system-prompt-default-content` 含
   `DEFAULT_PI_SYSTEM_PROMPT` 常量文本；`system-prompt-default-copy` 可点（剪贴板断言可跳过）。
6. 生效验证（关键）：新起一个 session 发一轮 → C 通道 grep session jsonl 的
   `taiji:system-prompt` entry（`@zhushanwen/pi-system-prompt-trace` 产出）。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | save 后按钮回 disabled；switch 与 input 状态一致（关闭时 input disabled） | 一直 dirty = 保存失败（看 `provider-action-error` 同族错误条是否存在） |
| 2 | C | `system-prompt.json` 的 `replace.enabled/prompt`、`append.enabled/prompt` 与 UI 一致 | 文件无变化 = RPC 未落盘 |
| 3 | C | 新 session 的 pi jsonl 出现 `taiji:system-prompt` entry，内容含哨兵串 | 无 trace entry = 扩展未装载 / 替换未生效 |
| 4 | B | `config.getSystemPrompt` reply 与文件同源（同一字段值） | reply 与文件不一致 = 读侧缓存/合并问题 |

> 1 是 A（可伪造），2/3/4 才是真相。**「生效」必须由 3 证明**——设置页保存成功 ≠
> pi 拿到了新提示词。

### 证据（A/B/C 各抓什么）

- **A**：`system-prompt-replace-card.png`（保存后 disabled 态）、`system-prompt-append-card.png`。
- **B**：`config.getSystemPrompt` 前后 reply（prompt 只留前 200 字 + sha256）。
- **C**：`system-prompt.json` 全文（哨兵串保留）+ 新 session 的 `taiji:system-prompt`
  grep 行（`pi-<date>.jsonl`）。

### 证不了

- **「实时快照」卡**：已随 builtin→npm 迁移删除（`03-runtime-extensions.md` 第 38 行
  `[HISTORICAL]`）。不要找「当前生效提示词」入口——不存在。
- **corrupted 警告条**：把 `system-prompt.json` 写成非法 JSON 可触发 `corrupted: true`，
  但警告条无独立 testid（只有页面级容器），只能按文本锚点断言 → weak-anchor。
- **append 注入的每轮时机**：trace entry 只证明「建立/变更」，无法逐轮证明 append 文本
  出现在每轮请求里 → 需真实 provider 抓请求体，超出本层能力。

### Gotchas

- 两个卡是**独立保存**（replace / append 各有 save），别指望一次保存同时生效。
- `system-prompt-replace-reset` 是「清空文本 + 关开关（编辑态）」，不是「恢复默认」；
  恢复默认 = 关 switch 后保存（语义按页面文案）。
- 文案变更频繁；testid 稳定、文本不稳定，断言优先 testid + disabled 状态。
- 设置页是 `v-show` 常挂载：切走再切回会重新拉取，别把「切回后值变了」误判为丢数据。

---

## settings.preset · 启动预设（模型 / 提示词 / 工具面）

- **通道**：A（`PiPresetsPage` + landing `chip-preset` + 对话态 `preset-chip`）/ B（`preset.list` / `preset.getDefault` / `preset.setDefault` / `preset.create` / `preset.update` / `preset.delete` / `preset.export` / `preset.import`）/ C（`<dataDir>/pi-presets.json`、session 的 `.preset.json` sidecar）
- **前置**：`requires: none`（纯配置面）；要验「预设影响会话」再叠 `requires: faux`
- **用于**：`p2-settings-preset`（covers: `settings.preset`）；对话态可见性归
  `docs/testing/01-chat-panel-composer.md` §3.1「模式可见性」段

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：
  - 设置 → `settings-nav-preset` → `PiPresetsPage`（`preset-prompt-*` 家族 testid，
    见下）；
  - 新建任务 landing 首行第三个 chip：`chip-preset`（有选中 id 才渲染）→ 点开选择；
  - 会话内只读 chip：`preset-chip`（仅**非默认模式**渲染，判据 `launchPresetId !== (defaultPresetId || 'builtin:full')`）
    → hover 出 `preset-chip-popover`（模式详情 + 锁定说明 + 新建会话出口）。
- 协议：`preset.*` 全族（出处：`packages/shared/src/protocol.ts`，grep `preset.list`）。
- 写盘：`<dataDir>/pi-presets.json`（出处：`packages/runtime/src/services/preset-service.ts`
  的 `presetsPath()` = `join(configStore.getConfigDir(), 'pi-presets.json')`；
  `getConfigDir()` = `<dataDir>`，见 `packages/runtime/src/infra/pi/pi-paths.ts`）。
- 会话侧锁：session 创建时把 preset id 写 `.preset.json` sidecar，**建会话后不可换预设**
  （chip 变只读 `preset-chip-locked`）。
- 页面 testid（源码，`packages/renderer/src/components/settings/preset/PiPresetsPage.vue`）：
  `preset-prompt-section` / `preset-prompt-replace-switch` / `-input` / `-discard` / `-reset` /
  `-save` / `-append-switch` / `-append-input` / `-append-discard` / `-append-save` /
  `preset-prompt-combined-count` / `preset-prompt-replace-warning`。
  **页根与 preset 列表行无 testid**（`data-testid` 只有 prompt 段）→ 选择 preset 只能靠
  文本锚点或 `chip-preset` 路径（weak-anchor）。

### 驱动

1. 设默认：`settings-nav-preset` → 页面内选择目标模式 → 设默认动作（无 testid，
   用行内按钮文本锚点）→ `preset.setDefault` 成功。
2. 回 landing（⌘N）→ `chip-preset` 显示的默认值与设置一致。
3. 建 session → 对话态出现 `preset-chip`（非默认模式才有）+ `mode-declaration-row`
   （消息流顶部派生声明行，出处 `01-chat-panel-composer.md` §3.1）。
4. hover chip → `preset-chip-popover` 含模式详情与「锁定」说明。
5. 文件对照：`pi-presets.json` 的 default 字段 + `<dataDir>/agent/sessions/<encodeCwd>/<file>.preset.json`
   （sidecar 路径按 pi session 文件同目录，命名由 runtime 写入；见 `preset-service` 与
   `session-create` 链路）。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | C | `pi-presets.json` 的 default 指向目标 id | 文件没变 = 设默认未落盘 |
| 2 | A | landing `chip-preset` 文本 = 目标模式 shortName | chip 不渲染 = 默认模式（`builtin:full`）不显示 |
| 3 | A | 建 session 后 `preset-chip` 出现且 hover 有锁定说明 | 出现 `chip-preset-locked` 在 landing（说明选目录前就该锁） |
| 4 | C | 会话 `.preset.json` sidecar 的 id = 目标 id | 无 sidecar = 未走预设通道（回落全局默认） |

> 2/3 是 A，1/4 是 C。**「预设生效」至少要有 4**；只有 chip 显示不算。

### 证据（A/B/C 各抓什么）

- **A**：`preset-landing-chip.png`、`preset-chip-popover.png`。
- **B**：`preset.list` / `preset.getDefault` 前后 reply。
- **C**：`pi-presets.json` 前后 diff（只截 preset 名与 default 键）+ `.preset.json` 全文。

### 证不了

- **preset 列表行 / 页根的稳定 testid**：当前源码没有 → 只能文本锚点，标 `weak-anchor`。
  **建议补**：`preset-row-<id>` / `preset-page`（登记在此，等实现）。
- **preset 对工具面/提示词的实际影响**：需要真实 provider 抓请求或对比 system prompt trace；
  faux 下只能验 sidecar 与 chip 可见性。
- **preset 导入导出（export/import）的文件对话框**：走 OS 原生对话框 → CDP 不可驱动 →
  `verified-unreachable`。

### Gotchas

- `preset-chip` 的渲染判据用 `||` 不是 `??`：store 未加载时空串会让 `??` 穿透成
  `custom:xxxx` 裸文本。脚本里不要用「chip 不出现」判断未选中——先等 `preset.list` 到达。
- 三种 chip 各有 testid（`chip-preset` / `chip-preset-locked` / `preset-chip`），
  它们在**不同生命周期**出现，拿错会一直 `expectVisible` 超时。
- 换预设要新建会话；对已建会话换预设的期望是错误的。

---

## settings.mcp · MCP 服务器管理

- **通道**：A（MCP 分区 / 表单 / 列表行）/ B（`mcp.list` / `mcp.add` / `mcp.update` / `mcp.setEnabled` / `mcp.remove` / `mcp.test` / `mcp.testCancel`）/ C（`<dataDir>/agent/mcp.json`）
- **前置**：`requires: none`（管理面）；要验「工具真的出现在 agent 侧」需新会话 + `extension.load`
- **用于**：`p2-settings-mcp`（covers: `settings.mcp`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：设置 → `settings-nav-mcp` → `mcp-section` → `mcp-add-btn` → 表单 `mcp-form-dialog`。
- 协议：`mcp.*` 七 RPC（出处：`packages/shared/src/protocol.ts`，grep `mcp.list`）。
- 写盘：`<dataDir>/agent/mcp.json`（出处：`packages/runtime/src/infra/pi/pi-mcp-store.ts`
  文件头 + `packages/runtime/src/infra/pi/pi-paths.ts` 的 `getMcpConfigPath()`）。
- 生效：`--extension builtin:mcp` 在**会话启动时**读 mcp.json → 改动**对新会话/重连生效**，
  页面以 `mcp-effect-notice` / `mcp-scope-notice` / `mcp-snapshot-notice` 明示
  （出处：`packages/renderer/src/components/settings/mcp/McpSection.vue`）。
- testid 家族（源码：`mcp/McpSection.vue`、`mcp/McpServerList.vue`、`mcp/McpServerForm.vue`）：
  分区 `mcp-section` / 三条 notice / `mcp-add-btn` / `mcp-load-error` / `mcp-load-retry` /
  `mcp-corruption-*`（坏文件指引）；行 `mcp-server-list`、`mcp-list-empty`、`mcp-row-<name>`、
  `mcp-toggle-<name>`、`mcp-test-<name>`、`mcp-edit-<name>`、`mcp-remove-<name>`、
  `mcp-remove-confirm`、`mcp-badge-<name>`、`mcp-badge-config-<name>`、`mcp-config-error-<name>`、
  `mcp-error-detail-toggle-<name>` / `mcp-error-detail-<name>`、`mcp-login-cmd-<name>` /
  `mcp-login-copy-<name>`；表单 `mcp-form-dialog` / `mcp-form-tabs` / `mcp-form-tab-<tab>` /
  `mcp-form-fields` / `mcp-form-name` / `-name-error` / `-transport` / `-command` /
  `-command-error` / `-args` / `-env` / `-env-error` / `-cwd` / `-url` / `-url-error` /
  `-headers` / `-headers-error` / `-description` / `-exposure` / `-exposure-hint` /
  `-server-error` / `-server-error-code` / `-code` / `-code-text` / `-code-error` /
  `-cancel` / `-save`。

### 驱动

1. `settings-nav-mcp` → `mcp-section`；记录 `mcp-row-*` 数与 `mcp-list-empty` 是否在。
2. 新增 stdio server：`mcp-add-btn` → `mcp-form-tab-stdio` → 填 `mcp-form-name`
   （如 `faux-mcp`）+ `mcp-form-command`（如 `node`）+ `mcp-form-args`（如 `-e "0"`）→
   `mcp-form-save`。
3. 断言列表：`mcp-row-faux-mcp` 出现；`mcp-badge-config-faux-mcp` 显示配置态。
4. 开关：`mcp-toggle-faux-mcp` → `mcp-badge-faux-mcp` 文本变化。
5. 测试连接：`mcp-test-faux-mcp` → 状态从进行中到结果（`mcp-error-detail-*` 可展开错误）。
6. 删除：`mcp-remove-faux-mcp` → 确认 `mcp-remove-confirm` → 行消失。
7. 文件对照：每一步后读 `mcp.json`（`mcpServers` 键的条目与 enabled）。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | C | `mcp.json` 的 `mcpServers.<name>` 字段与表单一致（command/args/env/url） | 文件没变 = RPC 未落盘 |
| 2 | A | 行 testid 以 name 为后缀出现/消失，与文件同步 | 行在但文件无 = 乐观更新（不应发生，UI 跟随事实） |
| 3 | A | 保存失败时 `mcp-form-server-error` / `mcp-config-error-<name>` 就地呈现 | 无错误但也没写入 = 静默吞错 |
| 4 | C | 坏 JSON 时 `mcp.json.corrupt` 副本存在 + 页面 `mcp-corruption-path` 显示路径 | 直接覆盖坏文件 = 违反「损坏隔离」 |

> 3 的失败注入：把 `mcp.json` 写成非法 JSON（页面应走 `mcp-corruption-*` 指引而不是崩）。

### 证据（A/B/C 各抓什么）

- **A**：`mcp-section.png`、`mcp-form.png`、`mcp-row-after-save.png`。
- **B**：`mcp.list` 前后 reply（`entries[].name/config/enabled/state`）。
- **C**：`mcp.json` 前后全文（脱敏 env 值）+ `ls` 目录清单（确认 `.corrupt` 副本）。

### 证不了

- **MCP 工具被 agent 真正调用**：需要新会话 + 一个能连上的 MCP server；仓内无 MCP fixture。
  → 记 `verified-unreachable`（前置 = 可用 MCP server 进程）。
- **OAuth 型 MCP 登录**（`mcp-login-cmd-*` 只是展示登录命令）：需要浏览器授权 → 不可驱动。
- **MCP 连接超时/重连语义**：属 runtime 服务层，需单测或日志断言；本层只验状态徽标。

### Gotchas

- 页面明示「改动对新会话生效」：在当前会话里看不到新工具是**预期**，不要判缺陷。
- tsid 大量以 name 为后缀（`mcp-row-<name>`），name 含点号/斜杠时选择器要转义；
  建 fixture server 时用纯 ASCII 无点号名（如 `faux-mcp`）。
- `mcp-test-*` 会真的起进程；测试用的 command 要能立即退出（`node -e "0"`），
  否则留下子进程。
- `mcp.json` 是 **pi 的** 配置文件，写侧有锁；验收结束时删掉自建条目，别污染模板种子。

---

## settings.network-proxy · LLM 网络代理（规则分流 + 统计）

- **通道**：A（NetworkPage 三卡）/ B（`config.getNetworkProxy` / `setNetworkProxy` / `testNetworkProxy` / `getNetworkProxyStats` / `resetNetworkProxyStats`）/ C（`<dataDir>/agent/config/network-proxy-ext-config.json`、`<dataDir>/agent/network-proxy-stats.jsonl`）
- **前置**：`requires: none`（配置面）；「代理真的生效」需真实出站请求（`live`）
- **用于**：`p1-settings-network-proxy`（covers: `settings.network-proxy`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：设置 → `settings-nav-network-proxy` → `network-page`。
- testid（源码：`packages/renderer/src/components/settings/network/*.vue`）：
  页 `network-page` / `network-lower-cards` / `network-rules-dim`；
  服务器卡 `network-server-card` / `network-enabled-switch` / `network-protocol-select` /
  `network-protocol-trigger` / `network-protocol-option-<p>` / `network-host-input` /
  `network-port-input` / `network-username-input` / `network-password-input` /
  `network-noproxy-input` / `network-test-btn` / `network-test-testing` / `network-test-result` /
  `network-save-btn`；
  规则卡 `network-rules-card` / `network-chip-<id>` / `network-rule-row-<i>` /
  `network-rule-input-<i>` / `network-rule-del-<i>` / `network-rules-empty` / `network-add-rule`；
  统计卡 `network-stats-card` / `network-stats-range` / `network-stats-range-<24h|7d|all>` /
  `network-stats-refresh` / `network-stats-reset` / `network-stats-rows` /
  `network-stats-row-<host>` / `network-stats-empty` / `network-stats-error` /
  `network-stats-truncated-note`。
- 写盘：`<dataDir>/agent/config/network-proxy-ext-config.json`（0600，出处
  `packages/runtime/src/services/network-proxy-config.ts` 的 `NETWORK_PROXY_CONFIG_REL`）；
  统计 `<dataDir>/agent/network-proxy-stats.jsonl`（`NETWORK_PROXY_STATS_REL`，追加式 JSONL，
  读侧聚合，截断保尾 —— ADR-0149）。
- 生效：extension `@zhushanwen/pi-network-proxy` 在 pi 进程内装 undici 全局
  dispatcher，**turn 粒度热生效**（设计 ADR-0147）。

### 驱动

1. `settings-nav-network-proxy` → `network-page`。
2. 开启：`network-enabled-switch` → 选协议 `network-protocol-trigger` →
   `network-protocol-option-http` → 填 `network-host-input` / `network-port-input`
   （用本地 socks/http 代理或 `127.0.0.1:9` 触发失败面）。
3. 规则：`network-add-rule` → `network-rule-input-0` 填主机名规则 → 保存。
4. `network-save-btn` → 等 reply → 断言文件。
5. 测试连接：`network-test-btn` → `network-test-testing` 出现再消失 → `network-test-result`
   有文本（成功或失败都要有结果；无结果 = 挂起）。
6. 统计：`network-stats-refresh` → `network-stats-rows` 或 `network-stats-empty`；
   `network-stats-range-7d` 切换档位。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | C | 配置文件含 `enabled/protocol/host/port/rules` 且 mode = 0600 | 文件缺字段 = 表单未映射；权限 644 = 凭据泄露 |
| 2 | A | 保存后开关/输入框回显 = 文件值 | UI 与文件不一致 = 读侧未回读（先看 runtime 存活） |
| 3 | A | `network-test-result` 有明确结果（成功/失败文案） | 一直 `network-test-testing` = RPC 未回（挂起） |
| 4 | C | 统计文件按行追加，reset 后行数归零（或新基线） | reset 无效 = 读侧没截断 |

> 1/4 是 C，2/3 是 A。**代理是否真的分流**本层不证（见「证不了」）。

### 证据（A/B/C 各抓什么）

- **A**：`network-page.png`、`network-test-failed.png`、`network-stats.png`。
- **B**：`config.getNetworkProxy` 前后 reply（password 用占位）+ `getNetworkProxyStats` 聚合结果。
- **C**：配置文件全文（password 脱敏）+ `ls -l` 权限位 + stats jsonl 头尾各 3 行。

### 证不了

- **真实代理分流生效**（proxied vs direct 的实际走向）：需要真实代理 + 真实 LLM 出站，
  `requires: live`。本层只验配置落盘与 extension 装载（`extension.load` 覆盖装载）。
- **统计数字的业务正确性**：只能验「有行 / 有聚合」，不能验「计数与实际请求一一对应」
  （需要对照真实请求数）。
- **`network-test` 的失败原因分类**：结果文本由 runtime 生成，无结构化字段暴露到协议
  （只 `network-test-result` 文本）→ weak-anchor。

### Gotchas

- 配置文件权限是 0600（含代理凭据）；验收脚本读它做 diff 时注意不要把它复制到共享目录。
- `network-test-*` 会真的发起连接，可能等待 DNS；用 `127.0.0.1` 目标避免外网依赖，
  但仍要用带超时的可见性断言而不是 sleep。
- 统计文件是**追加式**：reset 后可能保留截断基线，不要断言「文件不存在」。
- 规则行的 testid 带索引（`network-rule-row-<i>`），删行会让后续索引位移；
  断言用「规则文本」而不是固定索引。

---

## settings.theme · 外观（主题 / 字号 / 终端字体）

- **通道**：A（AppearancePage + `<html>` 属性）/ B（无 WS RPC——**这是纯前端 KV 存储**）/ C（CDP `localStorage['taiji:system-settings']`）
- **前置**：`requires: none`；不依赖 runtime 存活（但设置页本身需要壳）
- **用于**：`p2-settings-theme`（covers: `settings.theme`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：设置 → `settings-nav-appearance` → 模式段 / 字体档位 / 主题行 / 终端字号；
  侧栏快捷面板 `sidebar-quick-appearance` → `sidebar-quick-appearance-panel` →
  `sidebar-quick-theme-<preset||theme>` / `sidebar-quick-chat-<tier>`。
- **没有 WS 协议**：system 偏好经 core `settings-store.setSystem` → `KVStorage`
  （renderer 注入 `LocalStorageAdapter`），key = `taiji:system-settings`
  （出处：`packages/core/src/domain/settings/system-storage.ts`，`SYSTEM_KEY`）。
- DOM 落点：`applySystemToDom` 写 `<html data-theme>` + `<html data-theme-preset>`
  （出处：`packages/renderer/src/composables/useTaijiThemes.ts` 文件头；`style.css` 的
  `[data-theme-preset="dailan"/"nuanmo"/"qingmo"/"zhuyin"]` 规则覆盖 token）。
- 六主题清单（`TAIJI_THEMES`，同文件）：玄青（dark, preset=''）、黛蓝（dailan）、暖墨（nuanmo）、
  皓（light, ''）、青墨（qingmo）、朱印（zhuyin）。
- testid（源码：`packages/renderer/src/components/settings/appearance/AppearancePage.vue`）：
  `appearance-mode-seg` / `appearance-mode-<light|dark|system>` /
  `appearance-fs-global-seg` / `appearance-fs-global-<tier>` /
  `appearance-fs-<region>-trigger>`（region = sidebar/chat/drawer）/
  `appearance-terminal-font-size-input` / **`appearance-theme-<preset || theme>`**
  （注意：默认玄青的 testid 是 `appearance-theme-dark`，因为 preset 为空串）。

### 驱动

1. `settings-nav-appearance` → 等 `appearance-mode-seg`。
2. 切深浅：点 `appearance-mode-light` → 断言 `<html data-theme="light">`。
3. 切配色：点 `appearance-theme-dailan` → 断言 `<html data-theme-preset="dailan">`
   （`dataset.themePreset` 精确值）。
4. 字号：点 `appearance-fs-global-large` → 断言 `document.documentElement` 上字号相关
   属性/计算样式变化（`--text-*` 变量或根 font-size，按实际实现取值）。
5. 终端字号：`appearance-terminal-font-size-input` 填 16 → blur → 断言
   `config.getTerminalConfig`（这是唯一走 RPC 的子项）。
6. C 通道：`localStorage.getItem('taiji:system-settings')` 的 `theme` / `themePreset` /
   `fontSize` / `fontScales`。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | `<html data-theme>` = 目标（light/dark） | 属性不变 = `applySystemToDom` 没跑（HISTORICAL：曾因只在 init 时应用） |
| 2 | A | `<html data-theme-preset>` = 目标 preset（默认主题为空串） | 恒空 = 只改了 theme 没写 preset |
| 3 | C | localStorage 的 `themePreset` 与 DOM 一致 | 不一致 = 写侧与 DOM 应用分叉 |
| 4 | A | 刷新/重开窗口后主题保持（localStorage 读回） | 回默认 = 写入失败（quota / 序列化） |

> 1/2/4 是 A，3 是 C。**A 单独不够**（可能只是 CSS 变量没生效但属性对）；要同时断言
> 至少一个可见的颜色证据（截图或计算样式 `getComputedStyle(...).backgroundColor`）。

### 证据（A/B/C 各抓什么）

- **A**：`theme-dailan.png` / `theme-haobai.png` 全窗截图（能看出底色差异）；
  同时 attach `<html>` 的 `outerHTML` 前 200 字符（含两个 data 属性）。
- **B**：无（本域不经 WS）。若验终端字号，附 `config.getTerminalConfig` reply。
- **C**：`localStorage['taiji:system-settings']` 全文（脱敏无敏感项）。

### 证不了

- **主题 token 的完整视觉一致性**（每个 token 都在目标主题下正确）：属视觉回归，
  归 `e2e-visual` 像素轨，不在本层。
- **终端字号对 xterm 渲染的实际影响**：xterm 画布不走 CSS，字号经 `config.setTerminalConfig`
  生效于**新开/重挂**的终端；只验配置值，不验字形像素。
- **`system`（跟随系统）模式**：依赖 OS 外观切换（macOS 深色模式），CDP 不能改系统设置 →
  `verified-unreachable`（可用 `--force-dark-mode` 之类启动参数另说，但会污染实例）。

### Gotchas

- 默认主题（玄青）的 testid 是 `appearance-theme-dark`，**不是** `appearance-theme-`；
  空 preset 用 `th.preset || th.theme` 兜底（源码同款表达式）。
- 设置页是 `v-show` 常挂载，切走切回会重新拉终端配置；别把「切回后字体尺寸跳回」判成保存失败
  （失焦兜底保存逻辑在 `isActive` 信号里）。
- 主题切换即时写 DOM + localStorage，**不经过 runtime**；因此不能拿 B 通道证明它。
- 亮色下 shiki 代码块有专用覆盖规则（`[data-theme="light"] .shiki span`），
  验 render.shiki 时如果主题是亮色，颜色断言要按亮色 token 取。
