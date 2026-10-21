# plugin · taiji 插件面（列表 / 启停 / 状态点位 / 挂载点）

本文件覆盖四个 capability id：

- `plugin.list`（P2）
- `plugin.toggle`（P2）
- `plugin.statusbar`（P2，**现行实现已退役**，见下）
- `plugin.mountpoints`（P2）

> **先分清三个「扩展」概念**，本文件只讲第 3 个：
> 1. **pi extension**（`@zhushanwen/pi-*`，跑在 pi 子进程内，注册工具/slash 命令）→ 归
>    `extension.load` / `interaction.*`；
> 2. **MCP server**（pi 侧 `--extension builtin:mcp` 装载的 server 清单）→ 归 `settings.mcp`；
> 3. **taiji plugin**（`PluginService`，跑在 Worker Thread / fork 子进程，经
>    `plugin.*` RPC 提供服务）→ **本文件**。

---

## 共享背景：PluginService 语义（四个 id 都建立在它上面）

出处：`packages/runtime/src/services/plugin-service/`（`plugin-host.ts` / `plugin-host-process.ts` /
`plugin-lifecycle.ts` / `plugin-activator.ts` / `plugin-rpc-server.ts` / `hook-api.ts` /
`hook-pipeline.ts`）。

| 维度 | 事实 | 出处（grep 锚点） |
|------|------|-------------------|
| 信任级别 | `trusted` / `sandbox`（manifest `taijiPlugin.trustLevel`） | `packages/plugin-sdk/src/types.ts` 的 `PluginDescriptor.trustLevel` |
| 执行体 | **trusted = Worker Thread 池（≤10 插件共享一个 Worker）**；**sandbox = 每插件独占 fork 子进程** | `plugin-host.ts` 文件头「trusted 插件共享 Worker（最多 10 个），sandbox 插件独占 Worker」；`plugin-host-process.ts` 的 `assignProcess`（`sandbox-<pluginId>` 一对一） |
| hook 顺序 | 按 `priority` **升序串行**（低值先执行），注册时排序 | `hook-api.ts` 的 `entries.sort((a,b)=>a.priority-b.priority)`；`hook-pipeline.ts` 文件头 |
| hook 超时 | **已退役**：原 `HOOK_HANDLER_TIMEOUT_MS`（5s）随 ADR-0122 删除——Worker 不回复时 pending 悬挂，由 dispose 收尾 | `plugin-rpc-server.ts` 的 `[ADR-0122 退役登记]` 注释 |
| 权限门 | `permissions.length > 0` 且未授权 → 广播 `plugin:permissionRequest`，等待用户审批（trusted / built-in **免审批**） | `plugin-activator.ts` 的 `gateOnPermissionApproval`；`plugin-permission.ts` 的 `descriptor.trustLevel === 'trusted' \|\| descriptor.source === 'built-in'` |
| 权限等待上限 | `PERMISSION_TIMEOUT_MS = 1_800_000`（30min，可用 env `TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS` 覆盖）；到期 = **取消激活**（不是判拒） | `plugin-activator.ts` |
| 崩溃取证 | worker stderr + 内存快照落 `<dataDir>/logs/plugin-crash-*.log` | `plugin-host.ts` 文件头 + `infra/logger.ts` 保留期白名单 |
| 仓库内插件 | **只有一个**：`resources/plugins/scheduler-manager`（trusted，`permissions:["sessions.readState"]`，built-in） | `resources/plugins/scheduler-manager/package.json` 的 `taijiPlugin` 段 |

> 「hook 5s 超时」是**旧事实**（AGENTS.md 规则 16 仍写着）。现行为以源码注释为准：
> 墙钟已删，ADR-0122「事实驱动、不用时间平抑」。本文件按现状写，报告里登记该文档漂移。

入口（用户 POV）：设置 → `settings-nav-extension` → `extension-contributions-entry`
→ `PluginContributionsPage`（内嵌 ui 包 `PluginSettingsPage`）
（出处：`packages/renderer/src/components/settings/extension/ExtensionPage.vue` 与
`PluginContributionsPage.vue`）。

---

## plugin.list · 插件清单

- **通道**：A（`plugin-settings-page` + `plugin-card`）/ B（`plugin.list` RPC → reply `config.plugins { plugins: PluginInfo[] }`）/ C（插件安装根目录 + `taijiPlugin` manifest）
- **前置**：`requires: none`（不需要 LLM）；依赖 `env.ready`
- **用于**：`p0-plugin-system`（矩阵口径；covers: `plugin.list`, `plugin.mountpoints`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：设置 → 扩展页 → 「插件贡献」入口 → 插件卡片列表。
- 协议：`plugin.list`（无参）→ reply type `config.plugins`，payload `{ plugins: PluginInfo[] }`
  （出处：`packages/shared/src/protocol.ts`，`'plugin.list': Record<string, never>` 与
  `'config.plugins': { plugins: PluginInfo[] }`；`PluginInfo` 形状见
  `packages/shared/src/plugin.ts` / runtime mapper）。
- 数据来源：`PluginRegistry` 扫描安装根（builtin 目录 + 用户安装目录），manifest 解析出
  `pluginId / version / trustLevel / status / permissions / contributes`。
- testid（源码：`packages/ui/src/extension-host/PluginSettingsPage.vue`）：
  页根 `plugin-settings-page`、卡片 `plugin-card`、`plugin-version`、`plugin-enabled`
  （文本「已启用/已禁用」）、`plugin-trust`（「受信任/沙箱」）、贡献项
  `contribution-item` / `contribution-unavailable`。
  **weak-anchor 登记**：卡片内没有「启用开关」的独立 testid（状态只能读 `plugin-enabled`
  文本）；插件行的启停动作锚点也不在源码里（开关控件由 `PluginSettingsPage` 内部渲染，
  grep `data-testid` 零命中）——真机操作时用 role/开关语义定位，不要臆造 testid。

### 驱动

1. 进插件页 → `expectVisible(testid=plugin-settings-page)`。
2. 断言 `plugin-card` 数 ≥ 1，且其中一张卡内有 `plugin-trust` 文本「受信任」
   （= 唯一 builtin 插件 scheduler-manager）。
3. B 通道交叉：`protocol.call('plugin.list', {})` → `plugins[]` 的 `pluginId` 集合与卡片数一致；
   逐条比对 `enabled` 与卡片 `plugin-enabled` 文本。
4. 贡献项：卡内 `contribution-item` 表示挂载点已注册；`contribution-unavailable` 的
   `title`/邻近文本应给出「挂载点 X 未注册」（出处：`useExtensionHostBridge.ts` 的
   `toContributionInfos`，`reason: 挂载点 ${c.placement} 未注册`）。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | B | `plugin.list` reply 至少含 `scheduler-manager`，`status` 非 `crashed` | 空列表 = 插件根未扫描/产物未构建（dev 需 `prepare-builtin-plugins.sh`） |
| 2 | A | `plugin-card` 数 = reply 的 `plugins.length` | 数不等 = 渲染层过滤或分页（不应发生） |
| 3 | A | 唯一卡片的 `plugin-trust` = 「受信任」，`plugin-enabled` = 「已启用」 | 显示「沙箱」= manifest trustLevel 被改 |
| 4 | C | 磁盘存在 `resources/plugins/scheduler-manager/package.json` 且 `taijiPlugin.trustLevel=trusted` | 缺产物 = 构建链问题（非功能缺陷） |

> 1 是 B 真相，2/3 是 A 呈现，4 是 C 根因定位。**只验 A 会把「前端 mock 数据」当真相**。

### 证据（A/B/C 各抓什么）

- **A**：`plugin-page.png` + `plugin-card` 的 `outerHTML` 摘要（含三个徽标文本）。
- **B**：`plugin.list` 完整 reply（截断 description）。
- **C**：`ls -R resources/plugins`（或用户安装根）+ 目标 manifest 的 `taijiPlugin` 段。

### 证不了

- **用户安装的第三方插件**：需要 `plugin.install`（npm spec / 本地目录），且安装后可能触发
  权限审批（sandbox）。无夹具 → `verified-unreachable`（前置 = 可安装的插件包）。
- **插件崩溃态（`crashed`）**：需要注入崩溃（杀掉 Worker / fork 进程），属故障注入，
  当前无脚本化通道（只能手工 kill，且要认准 PID）。

### Gotchas

- `plugin.list` 与 `extension.list` 是**两个不同 RPC**（前者 taiji 插件，后者 pi 扩展）。
  拿错会把「pi 扩展列表」当插件页面数据源，结论全错。
- 列表空不要立刻判 bug：dev 态 builtin 插件产物 `resources/plugins/**/index.js` 是 gitignored
  构建产物，`pnpm dev` 启动链会跑 `prepare-builtin-plugins.sh`；绕过 dev 链直接起 Electron 时
  需要手动跑。
- 页面来自 `@taiji/ui` 包（`PluginSettingsPage.vue`），testid 不在 `packages/renderer` 下。

---

## plugin.toggle · 启用 / 禁用（+ 权限回执）

- **通道**：A（`plugin-enabled` 文本切换）/ B（`plugin.toggle` / `plugin.approvePermissions` / `plugin.denyPermissions` / `plugin.revokePermissions`）/ C（插件状态持久化文件 + `<dataDir>/logs/runtime-*.log` 的 plugin 段）
- **前置**：`requires: none`；依赖 `plugin.list`
- **用于**：`p0-plugin-system`（矩阵口径）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：插件卡上的启用开关（`PluginSettingsPage` 的 toggle 控件；卡片内无独立 testid，
  开关通过 `plugin-enabled` 状态变化观察）。
- 协议（出处 `packages/shared/src/protocol.ts`）：
  - `plugin.toggle`：`{ pluginId, enabled, trustLevel? }` → reply `config.plugins`（全量列表）；
  - `plugin.approvePermissions`：`{ pluginId, permissions }` → reply `pong`；
  - `plugin.denyPermissions` / `plugin.revokePermissions`：`{ pluginId }` → reply `pong`。
- 副作用点：禁用 → 插件走 `DEACTIVATING → UNLOADED`（hook/命令/tool 全部摘除）；
  启用 → 走激活链（权限门 → 分配 Worker/进程 → `loadPlugin` → `onActivate`）。
- 权限审批 UI（sandbox 插件才触发）：`permission-dialog` 家族，见
  `capabilities/interaction.md` 的「B 体系」。

### 驱动

1. `plugin.list` 记录初始 `enabled`。
2. 关开关 → 等 reply / 广播 → 断言 `plugin-enabled` 变「已禁用」。
3. B 通道：再 `plugin.list` 确认 `plugins[i].enabled === false`（不依赖 UI 回显）。
4. 再开 → 恢复「已启用」，且若该插件有 headerAction，按钮重新出现（见 `plugin.statusbar`
   的 headerAction 段）。
5. 失败面（可选）：对不存在的 pluginId 发 `plugin.toggle` → 应得 error envelope，
   UI 不得停留在「已禁用」假象。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | B | `plugin.toggle` reply 的 `config.plugins` 中该条 `enabled` 已变 | reply 未变 = 写侧拒绝（权限/状态机） |
| 2 | A | `plugin-enabled` 文本随之变 | UI 变但 reply 未变 = 乐观更新（不应存在） |
| 3 | C | 状态持久化后重启实例仍为禁用（`plugin.list` 复查） | 重启后复活 = 未持久化 |
| 4 | C | 禁用后 runtime 日志出现 deactivate 行、无 crash 行 | 出现 `plugin-crash-*` = 禁用把 Worker 弄崩 |

> 1 是 B，2 是 A，3/4 是 C。**禁用是破坏性动作**，只在 verify 数据目录里做。

### 证据（A/B/C 各抓什么）

- **A**：`plugin-toggle-off.png`（`plugin-enabled` = 已禁用）。
- **B**：toggle 前后两次 `plugin.list` reply（只留 pluginId/enabled/status）。
- **C**：`<dataDir>/logs/runtime-<date>.log` grep `[plugin` 相关行；重启后再取一份
  `plugin.list` 证明持久化。

### 证不了

- **sandbox 插件的权限审批往返**（approve → 激活成功）：无 sandbox 夹具，见
  `interaction.permission` 的「证不了」。
- **hook 执行顺序的端到端证明**：需要两个注册了同 hook 的插件并观察副作用顺序；
  仓内只有一个插件 → 只能靠单测（`hook-pipeline` 有测试）。
- **`trustLevel` 热切换**：`plugin.toggle` 的 `trustLevel?` 字段存在，但切换执行体
  （Worker ↔ fork）无对应真机验证。

### Gotchas

- 禁用/启用会重建执行体，**进行中的插件调用会悬挂**（ADR-0122：无墙钟兜底）；
  脚本不要在插件调用在途时切开关。
- `plugin.toggle` reply 是**全量列表**（不是单条），断言时别指望 `plugin` 单对象。
- built-in 插件同样可以禁用（`PluginService` 层不拦），但 pi extension 的 mandatory 语义
  在另一套体系（`extension.load`），两者不要混。

---

## plugin.statusbar · 「状态点位」（现行已退役，改由 headerAction / tray widget 承接）

- **通道**：A（headerAction 按钮 / tray widget）/ B（`plugin.ui.snapshot`、`plugin:headerActionUpdate` 推送）/ C（runtime 日志 + 插件自身日志）
- **前置**：`requires: none`；依赖 `plugin.list`
- **用于**：`p0-plugin-system`（矩阵口径）

### 入口（用户 POV / 协议 / 副作用点）

**现状（必读）**：StatusBar 底栏已整体退役（**ADR-0141**「StatusBar 底栏整体退役」，
2026-10-17 用户裁决）。同批删除：`StatusBar.vue`、`status-bar-source`、`StatusBarController`、
bridge 的 `plugin:statusBarUpdate` / `plugin:statusSetUpdate` / `extension:status` 三解析器、
`statusBarItem` 贡献类型与 `statusbar` 挂载点、runtime 的 `StatusBarRegistry` 与
`plugin.ui.updateStatusBarItem` RPC、builtin statusline 插件。pi 扩展的 `ctx.ui.setStatus`
在 taiji 内被 `event-adapter` 翻成 **noop**（独立 pi CLI 下仍有意义）。

> 所以 `plugin.statusbar` **没有现行实现可验**。该 id 保留的语义 = 「插件/扩展的状态点位」，
> 现行三个真实点位：

| 点位 | 机制 | 锚点 | 出处 |
|------|------|------|------|
| **顶栏按钮（headerAction）** | 插件声明 `contributes.headerActions[]`（`placement` 复用 `panel.header`）+ 运行时 `updateHeaderAction(id,{sessionId,badge,disabled,hidden,tooltip})` | `data-testid = header-action-<pluginId>-<actionId 末段>`（**weak-anchor**：公式推导值，需实测核对一次） | `packages/core/src/extension-host/contribution-registry.ts`（`PLACEMENT_BY_TYPE.headerAction`）；`packages/renderer/src/components/extension/HeaderActionsHost.vue` 的 `actionTestId()`；`packages/plugin-sdk/src/types.ts` 的 `updateHeaderAction` JSDoc |
| **tray 协议 widget** | pi extension `setWidgetDual` → 托盘 widget 区 | `tray-widget-button` / `tray-widget-panel` | `docs/testing/01-chat-panel-composer.md` §3.1「任务托盘」段 |
| **modal / 简单对话框** | 插件 `ui.request` → `plugin:uiRequest` → CompanionBand | `companion-band` 家族 | `packages/ui/src/extension-host/CompanionBand.vue` |

仓内唯一消费样本 = `scheduler-manager`：
- headerAction id `scheduler-manager.open`（`resources/plugins/scheduler-manager/index.ts` 的
  `HEADER_ACTION_ID`），按公式得 testid `header-action-scheduler-manager-open`
  （pluginId 取 manifest 名；**需实测核对一次**，公式出处见上表）；
- 契约：`hidden=true` 时不渲染按钮（「无任务不显示」）、`disabled` 灰置、`badge` ≤4 字符
  （超出宿主截断）。

### 驱动

1. 起会话（headerAction 是 per-session 语义，需要 `sessionId`）。
2. 观察顶栏：`expectVisible(testid=header-action-scheduler-manager-open)`（会话内无任务时
   可能是 hidden，先用 `/schedule` 或插件命令造一条任务）。
3. hover → `header-action-tooltip` 有文案（禁用的原因 / 一般说明）。
4. 点击 → 应打开调度面板（`scheduler-quick-panel` 或 overlay 定时任务 tab，
   出处：`packages/renderer/src/components/extension/SchedulerQuickCard.vue`）。
5. B 通道：`plugin.ui.snapshot`（`{sessionId, viewId}`）取插件推送的视图与 headerAction 状态。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | `header-action-<...>` 按钮在场（或按 hidden 契约不在场） | 恒不在 = 插件未激活/声明未路由（查 `contribution-unavailable`） |
| 2 | A | `header-action-tooltip` 文本非空 | 有按钮无 tooltip = 声明缺 tooltip（宿主应有兜底文案） |
| 3 | B | `plugin.ui.snapshot` 返回该插件 view 树（`viewId` 命中） | 空 = 插件未推送 / 分区未挂载 |
| 4 | C | 插件日志（`<dataDir>/agent/logs/*scheduler*` 或 runtime 日志）有激活行 | 无激活行 = 插件停在 discovered |

### 证据（A/B/C 各抓什么）

- **A**：`header-action.png`（含按钮与 tooltip 同时可见的 hover 态）+ `scheduler-quick-panel.png`。
- **B**：`plugin.ui.snapshot` reply（截断树深度）+ `plugin.list` 的 `status`。
- **C**：runtime 日志 grep `scheduler-manager`（激活/推送失败 best-effort 日志）。

### 证不了

- **`setStatus` 在 taiji 内的可见呈现**：**已退役，不可验**（noop）。别再写「状态栏出现某文本」
  的断言——那是 2026-10-17 之前的形态。
- **badge 的 4 字符截断边界**：需要插件推超长 badge；现有插件不这么干 → 只能单测。
- **`updateHeaderAction` 回执 `{updated:false}` 分支**（渲染端未收到）：需要制造渲染端缺失，
  属故障注入。

### Gotchas

- AGENTS.md 与部分旧文档仍写「hook 5s 超时」「StatusBar 状态点位」——以本文件的 ADR 引用为准。
- headerAction 的 testid 由**公式**生成（`header-action-<pluginId>-<末段>`），不是 manifest 里
  手写的；写死猜测值会静默超时。先用 `grep -n "data-testid" HeaderActionsHost.vue` 确认公式，
  再用 `expectVisible` 试一次。
- headerAction 在非默认密度档会被聚合进托盘（`tray-aggregate-button`），
  窄窗口下直接找顶栏按钮可能找不到（`01-chat-panel-composer.md` §3.1 三步聚合）。
- `setWidget`（tray）与 `setStatus`（已 noop）是**两个不同 API**；托盘那条仍有效。

---

## plugin.mountpoints · 挂载点注册与贡献可用性

- **通道**：A（`contribution-item` / `contribution-unavailable`，**可用性真值在这里**）/ B（`plugin.mountPoints.sync` 上报帧）/ C（`packages/core/src/bootstrap.ts` 注册清单、插件 manifest 的 `placement`）

  > **[HISTORICAL] 可用性不在 `plugin.list` reply 里**（早期文档这么写，是错的）：
  > `PluginInfo`（`packages/shared/src/plugin.ts`）只有
  > `pluginId/version/displayName/description/status/trustLevel/enabled`，**没有 `contributions`**。
  > 可用性是 renderer 壳内现算的：`useExtensionHostBridge.ts` 的 `toContributionInfos(records, mountPoints)`
  > → `available: mountPoints.has(c.placement)`，再经 `PluginSettingsDataSourceKey` 注入 UI。
  > 且 `plugin.mountPoints.sync` 是 renderer → runtime **单向上报**（runtime 只存副本，从不回推）。
  > → 断言可用性**必须走 A 通道**（或抓 `plugin.mountPoints.sync` 的实际上报帧）；`plugin.list` 只给插件清单。
- **前置**：`requires: none`；依赖 `plugin.list`
- **用于**：`p0-plugin-system`（矩阵口径）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：插件页每条 contribution 显示「可用 / 不可用（原因）」。
- 协议：
  - renderer → runtime：`plugin.mountPoints.sync` `{ mountPoints: string[] }`
    （renderer 启动/重连时上报自己注册了哪些挂载点；非 OPEN 时静默丢弃、runtime 恒空）。
    **这是唯一与挂载点相关的 wire 通道**。
  - `plugin.list` reply **不含** contributions / available / reason（见上方 HISTORICAL 注）。
- 桌面壳注册的挂载点（**只有三个**，出处 `packages/core/src/bootstrap.ts` 的
  `registerMountPoints()`）：
  ```
  sidebar.tab
  panel.header
  composer.toolbar
  ```
  挂载点是**开放字符串**（非枚举），`MountPointRegistry` 允许任意名字注册
  （`packages/core/src/extension-host/mount-point-registry.ts`）；`drawer.tab` 在 SDK 注释里
  作为示例出现，但**桌面壳未注册** → 声明它的插件会得到
  `contribution-unavailable` + reason。
- 贡献类型 → 挂载点映射（`contribution-registry.ts` 的 `PLACEMENT_BY_TYPE`）：
  `views` 用声明里的 `placement`；`menus` 的键（`composer.toolbar` / `sidebar.footer`）；
  `headerAction` 恒 `panel.header`；`slashCommand` / `command` / `configuration` 不占挂载点。

### 驱动

1. **A 通道取真值**（可用性只能从这里读）：设置 → `settings-nav-extension` →
   `extension-contributions-entry` → 每条贡献项；可用 = `contribution-item`，
   不可用 = `contribution-unavailable`（文本/`title` 含 `挂载点 X 未注册`）。
2. **B 通道抓上报帧**：连 WS 后取 `plugin.mountPoints.sync` 的 payload（renderer 启动/
   重连时上报），排序后应为 `['composer.toolbar','panel.header','sidebar.tab']`。
   WS 抓帧不可行时退到 `plugin.list` 只验插件清单（**不要**指望它有 contributions）。
3. **C 通道对账**：`packages/core/src/bootstrap.ts` 的 `registerMountPoints()` 与实际集合一致。
4. 变更注入（可选）：**没有**「注册额外挂载点后 runtime 回推可用性」的通道——
   可用性由 renderer 现算，所以注入点必须在 renderer（测试钩子注册 mountPoint 后触发重渲染）。
   不要设计「再 `plugin.list` 看 available 翻转」的用例（永远不成立）。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | B | 挂载点集合 = 上述三个 | 多出 `statusbar` = 退役代码复活；缺 `panel.header` = headerAction 全不可用 |
| 2 | A | 不可用项的 reason 含 `挂载点 <name> 未注册` | reason 缺失 = 诊断信息丢失 |
| 3 | A | 不可用贡献渲染为置灰项且可读原因 | 直接不渲染 = 用户无法知道为何没生效 |
| 4 | C | `bootstrap.ts` 的 `registerMountPoints` 与实际集合一致 | 源码与实测劈叉 = 文档/实现漂移 |

> 1 是 B，2/3 是 A，4 是 C（根因对照）。挂载点是**壳侧注册制**，runtime 只存副本，
> 所以「B 通道一致」不等于「渲染真的有宿主组件」——第 3 条同时验呈现。

### 证据（A/B/C 各抓什么）

- **A**：`plugin-contributions.png`（含一项置灰 + 原因）。
- **B**：`plugin.mountPoints.sync` 帧原文（可用 CDP 抓 WS，或直接读 `plugin.list` 的
  contribution 列表）。
- **C**：`packages/core/src/bootstrap.ts` 的注册段（`attach` 源码片段）。

### 证不了

- **`sidebar.footer` 等「SDK 声明但壳未注册」的点位**：属开放字符串的设计余量，
  验它只能验「不可用 + 原因」，不能验「宿主渲染」——没有宿主。
- **移动壳的挂载点子集**：`MountPointRegistry` 注释说 mobile 只注册
  message-stream/slash/companion 子集；本层只覆盖桌面壳。
- **`plugin.mountPoints.sync` 的「非 OPEN 静默丢弃」分支**：需要断网/断 WS 时序，
  属故障注入（单测覆盖）。

### Gotchas

- 挂了 `statusbar` 挂载点的旧插件/文档已失效（ADR-0141 同批删除）。
- `contribution-unavailable` 的 reason 文案是运行时拼接的中文串（`挂载点 X 未注册`），
  跨语言环境可能变；断言用「包含 `挂载点`」+ testid，不写全等。
- 挂载点名字大小写敏感（`panel.header` 不是 `panelHeader`）。
- `contribution-unavailable` 的 reason 是运行时中文拼接串（weak-anchor）：断言只做
  「包含 `挂载点`」+ testid，不做全等；i18n 化之后要放宽。
- 别把「pi extension 的 tools 不可用」归到这里——那是 `extension.load` 的范围。
