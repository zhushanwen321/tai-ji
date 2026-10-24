# plugin · taiji 插件面（列表 / 启停 / 状态点位 / 挂载点）

本文件覆盖四个 capability id：

- `plugin.list`（P2）
- `plugin.toggle`（P2）
- `plugin.statusbar`（P2，**现行实现已退役**，见下）
- `plugin.mountpoints`（P2）

另有文末「Provider 插件化」一节：2026-10-24 D3 交付的插件 Provider 接入功能面（清单驱动家族卡 /
安装生命周期 / 凭据命名空间 / 条目扩展区交互），15 个场景剧本索引、共享设施与坑登记见该节。

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

---

## Provider 插件化 · 插件 Provider 接入（2026-10-24 D3 交付登记）

上面四节是插件体系的既有四个 capability id。本节登记 provider-plugin-access 交付新增的插件 Provider
功能面：sandbox 插件经远程清单出现在 Provider 页「插件 Provider」家族卡，安装确认后以自身命名空间向
`models.json` 写 provider 条目（`providers.write`），并在条目扩展区挂载位（`provider.detail-extra` /
`provider.authorize`，ProviderRowCard 容器内消费）推送 guiTree 交互树（text-input / action-bar /
凭据状态标记）。

涉及 capability：`plugin.list` `plugin.toggle`（既有，见上）+ `plugin.invoke`（宿主 → 插件方法调用）、
`plugin.listAvailable`（远程清单读取，fail-safe 链见坑 3）。后两个 id 是 D3 剧本 `covers` 的实测引用，
已录入 API-CONTRACT §6（2026-10-25 维护 pass 补录）。

### 剧本索引（15 个，全部实跑交付；verdict 证据与矩阵行见 P0-P1-COVERAGE.md 第六节）

| 剧本 | 场景 | verdict（断言数） | 覆盖要点 |
|---|---|---|---|
| `p1-plugin-a1-family-cards` | A1 家族卡 | pass（16） | 「添加供应商 ▾」三入口并列（`add-menu-builtin/custom/plugin`）；`plugin.listAvailable` 清单与本地已装比对 → 家族卡两态（已装徽标 / 「需要先安装插件」引导）；卡数 = 清单条目数 |
| `p1-plugin-a5-no-status-guessing` | A5 状态默认态 | pass（15） | 从不上报状态的插件条目零标记（`provider-plugin-status` 零 DOM 条件轮询）+ 状态点非失效配色 + 常驻「重新授权」按钮（D5） |
| `p1-plugin-a6-detail-sections` | A6 条目两区 | pass（15） | 唯一 `provider-detail-extra-boundary` 分界；宿主字段不溢入插件区、插件哨兵串不溢入宿主区；`plugin.ui.snapshot` 与渲染同源 |
| `p1-plugin-a7-text-input` | A7 输入回传 | pass（14） | `gui-text-input-field-<id>` 原生 input change 即回传；确认命令（`gui-action-bar-item-<id>` → `plugin.executeCommand`）触发重推；插件重推 value 回显覆盖本地镜像（输入状态保持） |
| `p1-plugin-crash` | A13 崩溃隔离 | pass（19） | SIGKILL sandbox fork → `plugin:crashed` 广播 + `plugin.list status=crashed` + crash journal 三证；builtin 邻居与宿主 RPC 不受影响；崩溃 toast 呈现（4s 消失窗）；管理面对 crashed 插件零呈现的缺口照录（不判失败） |
| `p1-plugin-a14-install-neighbors` | A14 邻居不变量（连续装卸 + 重启） | pass（51） | 安装/卸载 5 轮（中途重启）：邻居 provider 条目与凭据零污染、无孤儿条目（命名空间前缀全清含 apiKey）、插件目录 / `.staging` / installed.json 无残留、启动日志无 warn 洪水 |
| `p1-plugin-a26-update-chain` | A26 更新链 | pass（31） | 清单版本翻转 → 家族卡更新徽标两级提示 → 两段式确认提交：磁盘/注册表/激活面换新、条目凭据保留；正向 1.1.0 更新后沙箱 fork 进程更替（旧 fork terminate 再激活，新模块代码即时生效）+ displayName 切新版本；2.0.0 激活必败包 → `plugin-install-error` 呈现 + 回滚幸存（磁盘/注册表回 1.1.0、凭据保留、重激活达 active，非等宿主重启） |
| `p1-plugin-a23a-dual-artifact` | A23a 双产物闭环 | pass（24） | 清单条目 `piExtensionVersion` 双产物：安装 → 插件目录 + installed.json + pi 扩展（npm 布局）+ settings.json packages[] + models.json 条目五处落盘；`plugin.uninstall` 卸载五处完整清除 |
| `p1-plugin-install-confirm` | A27 安装确认知情面 | pass（21） | 确认卡提交前全量展示 capabilities 与 readPaths（展示物与暂存解压物 manifest 同源核对）；未确认不落盘（取消清暂存、正式目录不出现）；清单安装与包名直装双路径 |
| `p1-plugin-a15-manifest-unreachable` | A15 清单不可达 | pass（17） | fail-safe 链两态：曾拉取后远程不可用 → 回退缓存渲染；从未拉取（删缓存文件）→ 空态 + 重试入口；两态下既有 provider 管理均不受影响 |
| `p1-plugin-a16-invalid-tree` | A16 非法树降级 | pass（16） | 插件推送含 3 类非法组件的 guiTree：快照保真（runtime 不改写不拒绝）→ 渲染端降级（未知 type / 裸字符串 → ansi-text 序列化；props 非对象单条丢弃 + console.warn）不断链、不白屏；其他 provider 条目照常 |
| `p1-plugin-a17-status-report` | A17 状态上报 | pass（18） | 凭据状态双通道：`plugin:event`（channel `provider.credentialStatus`）推送 → 标记出现；推送丢失后重新展开拉取（invoke getStatus）收敛到新文案；未上报条目零标记（S5 语义同页复认） |
| `p1-plugin-a25-mount-isolation` | A25 同挂载位隔离 | pass（16） | 双插件交替推送：快照分区键 `global:<mountId>:<pluginId>` 正交；行卡只渲染自己插件的分区；交替重推互不覆盖，UI 与快照同源 |
| `p1-plugin-a21-credential-deny` | A21 凭据越权 | pass（16） | 跨命名空间回读 → NAMESPACE_MISMATCH；未声明 network.http 能力 → PERMISSION_DENIED（能力前提先于命名空间检查）；正向对照（自己命名空间 + 已声明能力）成功回读；两个拒绝 reply 均无凭据外泄 |
| `p1-plugin-a19-oauth-interrupt` | A19 OAuth 中断 | pass（30） | 宿主 OAuth 通道（非插件授权 UI）三段：关授权页取消可重发起、浏览器回调拒绝 auth.error 可理解、回调端口 53692 预占文案含恢复动作；每段无残留监听、auth.json 无凭据残留 |

A10b（provider 写侧回归）复用既有剧本 `p0-settings-provider`，不另立剧本；D3 复跑证据见
P0-P1-COVERAGE.md P0-13 行。

### 共享设施（写插件 Provider 剧本前必读）

| 设施 | 作用 |
|---|---|
| `scenarios/lib-plugin-fixtures.mjs` | launch 前 seed：fixture 插件目录写入 `<dataDir>/plugins/`（`PluginRegistry.scan` 发现，external 一律 sandbox fork）+ 清单 envelope 写入 `<dataDir>/remote-config/v2-plugins.json`（见坑 3）；`pluginFixture` 生成零 import 纯 ESM 插件（动作全走 ctx.api 的 RPC） |
| `scenarios/lib/plugin-provider-fixture.mjs` | fixture 实例装配（`launchFixtureInstance`）、多插件 seed、权限预批（`plugin.approvePermissions` 落盘后免审批）、Provider 页打开与条目展开驱动 |
| `scenarios/lib/plugin-flow-helper.mjs` | 插件 Provider 流程 UI 助手：`openPluginFlow` / `directInstallToConfirm` / `assertConfirmFields` / `closePluginFlow`（设置 → Provider → 添加供应商 → 家族卡 / 直装 → 确认卡的锚点链见文件头） |
| `scenarios/lib/mock-npm-registry.mjs` | 本机 HTTPS mock npm registry（固定端口 47820，自签证书）：packument + tarball 两端点；registry 地址经 NODE_OPTIONS 预载注入（NPM_* 不在 main→runtime env 白名单），证书经 NODE_EXTRA_CA_CERTS 信任 |
| `fixtures/plugin-provider/` | demo 插件夹具（`demo-wool`：getStatus 恒 null、从不 events.report——A5/A6/A7 的「未上报」契约源）与 demo 清单 |
| `fixtures/plugin-pkgs/` | npm tarball 夹具（`npm pack` 产物）、自签证书、registry 预载脚本、wool-manifest 本地清单（A23a 经 opt-in fetch 拦截折到本地文件，走真实版本配对校验） |

### Gotchas（D3 实跑登记，写插件 Provider 剧本前必读）

1. **action-bar 命令执行器是容器级 provide，不是 app 级**：条目扩展区 action-bar 的命令活在插件
   fork（不在宿主命令表），`ProviderRowCard.vue` 在容器内
   `provide(ACTION_EXECUTOR_KEY, createPluginActionExecutor(...))` 直发 `plugin.executeCommand`，
   覆盖 app 级 pi 扩展命令执行器（源码注释同文）。插件树内 action-bar 断言失败先查容器 provide
   是否随条目组件生效，不要去 app 级命令表找插件命令。
2. **fixture 插件 manifest 不声明 `permissions` 时 `providers.write` 被拒（激活必败）**：sandbox
   插件权限走 `plugin-permission-map` 直申通道，manifest `permissions` 必须声明完整 RPC 方法名
   （如 `providers.write`）；不声明 = 该 RPC 恒拒（PERMISSION_DENIED，fail-closed），activate 即调
   写侧的 fixture 会激活失败。声明了 = 首次激活停在权限审批门，需 `plugin.approvePermissions`
   批准（批准落盘 `permissions.json`，后续轮次与重启后免审批）——装配序列见
   `lib-plugin-fixtures.mjs` 的 `pluginFixture` / `waitPluginActive`。
3. **清单缓存 seed 形态（`remote-config/v2-plugins.json` 的 checkedAt 4h 节流窗）**：清单读取链
   （`remote-config-fetch`）每次先读 `<dataDir>/remote-config/v2-plugins.json` 缓存 envelope，
   `checkedAt` 在 4h 节流窗内不发网络直接返回缓存。推论：launch 前 seed 清单 = 确定性注入
   （runtime 直读缓存，不发网络）；把 `checkedAt` 拨旧到窗外 = 强制走网络。当前 GitHub main 尚无
   `configs/remote/v2-plugins.json`（404 与网络失败同走 fail-safe 回退分支）——远程清单发布后，
   依赖「远程 404」作断网前提的剧本（A15）会按剧本头注释的演化路径改用网络层手段。
4. **更新链的进程边界与清单两态元数据（D3 实跑发现的缺陷已修复，机制见 skill-data 侧
   `provider-plugin-access.acceptance/ISSUES.md`）**：
   ① **沙箱 fork 复用 + 同 URL ESM 模块缓存 = 「换磁盘文件 ≠ 换运行代码」**——`assignProcess`
   对同 id 活跃进程直接复用，`handleLoad` 的 `await import` 命中模块缓存；更新提交与回滚重激活
   都必须先 terminate 旧 sandbox fork 再激活（进程即模块边界，宿主侧 `plugin-update-activation.ts`
   承载）。排障信号：更新后版本号变了但行为还是旧的 = 进程没换。A26 剧本断言正向更新 fork PID
   更替、激活必败包失败呈现、回滚重激活达 active；
   ② **`plugin.listAvailable` reply 自 2026-10-24 R-2 修复起携带 `available/stale/reason` 三字段**，
   renderer 按 stale 渲染提示条、按 available=false 区分报错态与空清单并回退本地已装条目——
   判定「拉取失败 vs 确实为空」用 reply 字段，不要用 `catalogLoaded` 首拉标记推断。
