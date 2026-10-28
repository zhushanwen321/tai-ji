# Renderer 插件化改造扫描报告

> **性质**：一次性扫描分析（供裁决，不是设计文档）。产出候选清单 + 依赖关系 + 落地顺序建议。
> **基线**：分支 `refactor-plugin-implement` @ `7c8548d67`，扫描范围 `packages/renderer/src` + `packages/ui/src` + `packages/core/src`（含跨层落点）。
> **前置**：架构与扩展点全景见 [architecture.md](architecture.md) / [extension-points.md](extension-points.md)。
>
> **口径**：判「固定特殊实现」的标准不是「有没有 if-else」，而是——**新增一个同类能力时，是否必须改 taiji 源码**。必须改 = 固定实现；改 manifest / 改插件代码即可 = 插件化。按这个口径，本仓 renderer 侧几乎全部界面区域仍是固定实现。

---

## §0 结论先行

### 0.1 三个必须先解决的前提（否则改什么都白改）

| # | 前提 | 为什么是前提 |
|---|---|---|
| **P1** | **`contributes` 从 runtime 到 renderer 的通路（G1）** | 现在的 renderer 只认 `builtin-contributions.ts` 里写死的三条。插件声明再多，也进不了界面。这是**所有 renderer 插件化改造的地基** |
| **P2** | **容器抽象：从「枚举联合类型」改为「注册表」** | 抽屉 tab / 浮层 tab / 托盘面板 / 设置分区四处的共同形态是「core 里一个写死的联合类型 + 壳里一条 `v-if` 链」。不先抽出统一容器，每个区域都要单独发明一套注册机制 |
| **P3** | **`custom` GuiComponent 注册表接上 provide（G15/G19）** | 现有原语只有 11 个（布局 + action-bar + text-input）。像「Git 变更集面板」「终端」「用量图表」这类富交互，用原语拼不出来。要么补原语（成本高、通用性存疑），要么让 builtin 用 custom 注册（机制已存在，缺一个 provide） |

**没有 P2 的后果**：G4~G14 十一处会演化出十一套不同的注册表实现。

### 0.2 候选总览（24 项，分四档）

| 档 | 含义 | 项数 |
|---|---|---|
| **A 纯 renderer 改造** | 不动 runtime/pi，改注册机制 + 把固定实现搬成「内置插件形态」 | 7 |
| **B 需 runtime 配合** | 需要新 RPC / 协议字段 / 快照扩展 | 8 |
| **C 需 pi extension 配合** | 需要 pi 侧投递通道变更（marker / tool / widget） | 6 |
| **D 不建议插件化** | 扫描中发现但改造收益 < 成本或会破坏设计约束 | 3 |

---

## §1 全面扫描：renderer 固定实现清单

按「界面区域」分区，每项标注：现状锚点 → 固定在哪 → 改造候选编号。

### 1.1 侧栏（Sidebar）

| 区域 | 现状锚点 | 固定点 |
|---|---|---|
| L1 tab 集 | `packages/renderer/src/stores/sidebar.ts` `SidebarTab = 'sessions' \| 'files' \| 'plugins'`；`components/sidebar/SegmentedTab.vue` `tabs` computed 写死三项 + i18n 直取 | tab 数量/标识/顺序/文案全部硬编码；新增一个「任务」tab 需改两处 + 三个 i18n key |
| 次操作 nav | `Sidebar.vue` 内「导入会话 / 搜索」两个 `Button` 手写 | 入口不可扩展 |
| 会话列表 / 项目分组 | `SessionList.vue` / `ProjectGroup.vue` | 业务域固定（合理，不建议插件化） |
| Plugins tab 内容 | `Sidebar.vue` → `ui/src/extension-host/PluginViewContainer.vue` → `ViewHost` | **已插件化**（R1），但 `VIEWS_SOURCE_KEY` 只读静态声明，当前无插件产出 |

### 1.2 卡头（PanelHeader）

| 区域 | 现状锚点 | 固定点 |
|---|---|---|
| 左侧 chrome 槽 | `PanelHeader.vue` 三个手写 `Button`（收起/后退/前进）+ 新建任务 | 硬编码 |
| 状态图标 | `STATUS_ICON` 映射（`composables/logic/sessionStatus.ts`） | 会话状态 → 图标固定表 |
| 会话名 | 内联 `span` | 硬编码 |
| JSONL 文件名按钮 | 内联 `Button` + `formatShortSessionFile` | 硬编码 |
| 对话/Trace 切换 | `TraceViewToggle` 组件 | 固定两段 |
| 终端开关 / 抽屉开关 | `TerminalToggleButton` / 内联 Button | 硬编码 |
| 插件按钮区 | `HeaderActionsHost.vue` | **已插件化**（R2/R7），但内含 `activation === 'scheduler-overlay'` 特例（G12） |
| 插件信息条 | `ViewHost view-id="panel.header"` | **已插件化**（R2），无产出 |

### 1.3 输入框工具条（Composer）

| 区域 | 现状锚点 | 固定点 |
|---|---|---|
| `+` 附加菜单 | `AddMenuPopover.vue` `ITEMS` 常量三条（attach / image / slash） | 常量数组，无注册入口 |
| btw 旁路提问入口 | `ComposerBtwButton.vue` 专用组件 + `openDrawerTab('btw')` | 专属业务组件，非通用按钮位 |
| 任务托盘 | `ComposerTray.vue` + `tray/TrayAggregatePanel.vue` | 面板族固定（见 1.6） |
| 插件 toolbar | `ViewHost view-id="composer.toolbar"` | **已插件化**（R3），无产出 |
| 指标簇 | `ComposerMetricsAggregate` / `GenStatsTriggers` / `ContextCapacityPopover` | 硬编码四件 |
| 模型 + 思考档 | `ModelSelectPopover` / `ThinkingLevelPopover` | 硬编码 |
| 发送位 | 内联 | 硬编码 |

> 注：Composer 底栏是**密度状态机**驱动的（`use-composer-bar-density.ts` 按实测宽度决定各簇 expanded/aggregated/absent）。任何新增工具条项**必须接入这套退化序**，否则会挤爆布局——这是插件化此区域最容易被忽略的约束。

### 1.4 右抽屉（DrawerPanel）

| 区域 | 现状锚点 | 固定点 |
|---|---|---|
| **tab 集** | `packages/core/src/domain/drawer/types.ts` `RightDrawerTab = 'git' \| 'doc' \| 'detail' \| 'subagent' \| 'bashTask' \| 'plan' \| 'btw' \| 'trace'`（8 员）<br>`core/src/domain/drawer/registry.ts` `RIGHT_DRAWER_REGISTRY`（8 条元信息） | **编译期联合类型**。新增一个抽屉 tab = 改联合类型 + 加注册表条目 + 加 `PanelContainer.vue` 的 `v-else-if` 分支 + 加面板组件 |
| tab 内容 | `packages/renderer/src/components/workspace/PanelContainer.vue` 8 分支 `v-else-if`（`GitPanel` / `CommandDocPanel` / `DetailPane` / `SubagentTab` / `BackgroundTaskDetailPanel` / `PlanDocsPanel` / `BtwPanel` / `TraceInspector`） | 分支硬编码在壳里 |
| 未读徽标 | `PanelContainer.vue` `#header-extra` slot 内联 | 硬编码 |

### 1.5 底抽屉 / 浮层（bottom-drawer / overlay）

| 区域 | 现状锚点 | 固定点 |
|---|---|---|
| 底抽屉内容 | `PanelContainer.vue` 直接 `<TerminalView>`，`BOTTOM_DRAWER_REGISTRY` 只 1 员（terminal，注释自述「不预设 tab 枚举，§7.1 YAGNI」） | 单内容写死 |
| 浮层内容 | `core/src/domain/overlay/types.ts` `OverlayContent` 4 员（browser / workflow / scheduler / canvas）；`OVERLAY_REGISTRY` 只有 2 条 | 联合类型 |
| 浮层 tab 集 | `renderer/src/components/panel/workflow-viz/overlay/workflow-viz-overlay.ts` `OverlayTab = 'runs' \| 'scheduler' \| 'canvas'`；`WorkflowVizOverlay.vue` `tabSegments` 写死三项 + 三个 `v-if` 标题分支 | 硬编码 |
| 浮层 opener | `core/src/domain/overlay/coordination.ts` 三个专用函数：`openOverlay` / `openSchedulerOverlay` / `openCanvasOverlay` | 每个新内容加一个 opener |

### 1.6 托盘（composer task tray）

| 区域 | 现状锚点 | 固定点 |
|---|---|---|
| 面板族 | `panel/tray/useTrayCounts.ts` `TrayBuiltinKind = 'bash' \| 'subagent' \| 'workflow' \| 'session' \| 'canvas'` | 联合类型 |
| 面板分派 | `TrayAggregatePanel.vue`：`kind !== 'session' && kind !== 'canvas'` → `TrayNativePanel`，否则 `TraySessionPanel` / `TrayCanvasPanel` | 三分支写死 |
| widget 排序 | `tray-order.ts` `TRAY_WIDGET_KNOWN_ORDER = ['todo', 'goal']` | 硬编码顺序 |
| 段标题/图标 | `TRAY_BUCKETS` / i18n key `panel.tray.title.${kind}` | 每个 kind 需同步 i18n |

### 1.7 对话流（MessageStream / Turn）

| 区域 | 现状锚点 | 固定点 |
|---|---|---|
| 渲染项分派 | `panel/message-stream/stream-view-items.ts` `StreamViewItem` 联合 5 员（turn / bashExecution / systemNotice / skillNotice / broken）；`MessageStream.vue` 5 分支 | 联合类型 + 分支 |
| tool 详情富渲染 | `panel/detail-renderers/ToolDetailRenderer.vue` 按 `toolName === 'edit' / 'write' / 'read'` 三分支 | **按 tool 名硬编码**（G9）。旁证：`ui/src/features/chat/ToolRow.vue` 的 `chatViewDeps.toolDetailRenderer` 已经是**注入式单槽**（`chat-view-deps.ts:168`），说明「容器注入渲染器」范式已有先例，只是渲染器内部写死 |
| system / custom 消息 | `ui/src/features/chat/SystemNotice.vue` 按 `customType === SUBAGENT_DIRECTIVE_CUSTOM_TYPE / PI_RESPAWN_NOTICE_CUSTOM_TYPE` 分支 | **按 customType 硬编码**（G10） |
| turn 边界行 | `ui/src/features/chat/Turn.vue` `turn.trigger === 'bg-notify'` 分支 | 硬编码 |
| 虚拟滚动 / 消息归并 | `stream-view-items.ts` / `virtua` 接线 | 不建议动（性能契约） |

### 1.8 设置页（SettingsModal）

| 区域 | 现状锚点 | 固定点 |
|---|---|---|
| nav 分组 | `SettingsModal.vue` `navGroups` 硬编码 17 项 × 三分组（resources / inputAppearance / envSystem）+ 每项 lucide 图标 + i18n key | **硬编码**（G7） |
| 分区内容 | `SettingsModal.vue` keyed `v-show` 渲染表 → 17 个手写页面组件（`provider/ProviderPage.vue` 552 行等） | 每页手写 |
| 内容列限宽 | `contentMaxWidth` 三态按分区 id 判断（`usage` wide / `mcp`·`system-prompt`·`rename-session` 860px） | 分区 id 硬编码 |
| 扩展管理子视图 | `extensionView = 'main' \| 'contributions'` | 两层写死 |
| 插件贡献页 | `settings/extension/PluginContributionsPage.vue`（经 `PluginSettingsDataSourceKey`） | **半插件化**：能展示贡献，但仅展示，不能渲染 |

### 1.9 其它

| 区域 | 现状锚点 | 固定点 |
|---|---|---|
| 全局快捷键 | `composables/features/app/key-orchestrator/` + `panel/composer-shortcut-actions.ts`（注释自述「P1 注册表化时的迁移锚点」） | 硬编码表，`command.keybinding` 声明无人消费（G21） |
| 新增任务落地页 | `components/new-task/Landing.vue`（458 行） | 硬编码 |
| 画布 | `components/canvas/*`（10 个 `.vue`，约 1900 行） | 完整业务实现（走 `agent-canvas` 工具的 schema 驱动，非插件渲染） |
| 归档视图 | `components/archive/*` + `settings/...` | 硬编码 |
| 搜索 / 查找条 | `components/find/FindBar.vue`、`SearchModal` | 硬编码 |
| Toast / 通知 | `components/ui/ToastContainer.vue` | 硬编码 |

---

## §2 改造候选（A / B / C / D 分档）

> **改造形态说明**：本仓的「插件化」有两种落法——
> **(a) 声明式**：manifest `contributes` 新增字段，壳读声明渲染。适合「内容由插件提供」。
> **(b) 内置插件形态**：把现有固定实现抽成 `resources/plugins/` 下的内置插件，用同一套 API 工作。适合「这块本来就该是插件，只是历史原因写在壳里」。
> 下表标注推荐落法。

### A 档：纯 renderer 改造（7 项）

| # | 候选 | 现状 → 目标 | 落法 | 难度 | 风险 |
|---|---|---|---|---|---|
| **A1** | **抽屉 tab 注册表化** | `RightDrawerTab` 联合类型 + `PanelContainer` 8 分支 → `MountPointRegistry.register('drawer.tab')` + `views` 声明 + `ViewHost` 渲染；`RIGHT_DRAWER_REGISTRY` 保留为「内置 tab 的默认声明表」 | (a) | 中 | 8 个现有面板要逐个搬到注册表；抽屉 tab 有 per-session 选中态（core drawer 域），注册表化后选中态语义要重新定义 |
| **A2** | **浮层 tab 注册表化** | `OverlayTab` 3 员 + `tabSegments` 写死 + 3 个标题分支 → 声明驱动 tab 集；`OverlayContent` 从联合类型改为 `{ kind: string, payload }` 开放形态 | (a) | 中 | `OverlayContent` 是 core 域状态机的一部分（`state.ts` / `coordination.ts`），开放 kind 会削弱类型安全；需要保留「内置 kind」清单做校验 |
| **A3** | **侧栏 tab 集注册表化** | `SidebarTab` 联合 + `SegmentedTab` 三项 → tab 声明表（标识/文案/图标/顺序） | (a) | 低 | `activeTab` 持久化值需迁移；`SidebarTab` 被多处类型引用 |
| **A4** | **tool 详情渲染器注册表** | `ToolDetailRenderer` 三分支 → `toolName → Component` 注册表（内置三条 + 插件可注册）；复用已有 `chatViewDeps.toolDetailRenderer` 单槽范式 | (a)+(b) | 低 | 低。注意 `ToolRow.vue` 的富渲染谓词也要改为查表 |
| **A5** | **custom 消息渲染器注册表** | `SystemNotice` `customType` 分支 → `customType → Component` 注册表 | (a)+(b) | 低 | `SystemNotice` 还承担 background-bash 等形态，需先分清哪些是 `customType` 驱动、哪些是 message 类型驱动 |
| **A6** | **`custom` GuiComponent provide 接通**（P3） | 仓库内无 `GUI_CUSTOM_REGISTRY_KEY` 的 provide → 壳装配时提供 builtin 注册表 | — | 低 | 与 C3 约束（custom 仅 builtin）一致；要防止误开给 external |
| **A7** | **快捷键注册表化** | key-orchestrator 硬编码表 → `contributes.commands.keybinding` 真正生效 | (a) | 中 | 与 pi keybindings 语义重叠（`composer-shortcut-actions.ts` 注释已提示「P1 注册表化」）；需与 pi 侧键位对齐 |

### B 档：需 runtime 配合（8 项）

| # | 候选 | 需 runtime 提供什么 | 难度 | 备注 |
|---|---|---|---|---|
| **B0** | **`contributes` 透传通路**（P1，前置） | `PluginInfo` 加 `contributes`（shared 协议）+ `plugin-info-mapper` 透传 + 安装/启用时广播 | 中 | **所有声明式改造的前置**。同时应补齐 `contributes` 的 schema 校验（当前 runtime 对 contributes 零校验） |
| **B1** | **设置页分区注册** | 无新 RPC，但需 `contributes.configuration` 的 `placement` 字段（现在只有 `title` + `properties`） | 中 | 现在 `configuration` 是「JSON Schema 驱动表单」，本仓没有表单生成器；两条路：补 schema→表单生成器，或改为「插件提供 GuiComponent 树」（`text-input` 原语已具备） |
| **B2** | **设置分区内容插件化（GuiComponent 方案）** | `views.update` 的全局域 scope 已支持（`mountId`）；需新增 `mountId = 'settings.<section>'` 的分区约定 | 中 | 比 schema→表单生成器更符合现有架构（GuiComponent 已在用）；代价是设置页丧失统一表单视觉 |
| **B3** | **托盘面板族注册** | `views.update` 的会话域 scope 已够用；需新增「面板声明」（kind / 标题 / 图标 / 计数来源）供托盘外壳构建段 | 中 | 现在 `TRAY_BUCKETS` / `panel.tray.title.${kind}` 要求每个 kind 有 i18n key，插件无法提供 i18n → 需改为插件自带文案 |
| **B4** | **抽屉 tab 选中态协议化** | core drawer 域的 `activeTab: RightDrawerTab` 是编译期联合；开放后需 runtime 侧无状态（选中态是纯 renderer 关注点） | 中 | 与 A1 同批 |
| **B5** | **侧栏 L1 tab 声明** | `PluginInfo.contributes` 加 `sidebarTabs` 段（或复用 `views` 的 placement） | 低 | 与 A3 同批 |
| **B6** | **插件 tool 进 pi**（G2） | pi RPC 无运行时注册 tool 的帧；需评估 pi 是否支持（**未核实**） | 高 | 若不支持，则「插件提供 tool」这条能力应当撤掉，改为引导用 pi extension |
| **B7** | **懒激活闭环**（G3） | 新增 `plugin.triggerActivation` RPC + `ActivationManager` 真实 trigger 适配 + bootstrap 填激活注册表 | 中 | 与插件化改造弱耦合，但 `activationEvents` 是声明体系的一部分，声明化改造会依赖它 |

### C 档：需 pi extension 配合（6 项）

| # | 候选 | 需 pi 侧做什么 | 难度 | 备注 |
|---|---|---|---|---|
| **C1** | **`customType` 渲染器协商** | 现在 `customType` → 渲染器是硬编码；若改为注册表，插件的 `customType` 仍需**预先**在壳侧有渲染器。→ pi 侧应改为「投递 GuiComponent 树」而不是依赖 `registerMessageRenderer` | 中 | `registerMessageRenderer` 在 taiji 内本来就无法真正执行（pi 的 renderer 是 TUI 概念）；`details.__gui__` 才是正路 |
| **C2** | **`registerEntryRenderer` 承接** | pi 有 `registerEntryRenderer`（custom entry 渲染），taiji **零承接**（P6）。若要把 custom entry 渲染进对话流，需 pi 投递 + taiji 消费 | 高 | 现状：custom entry 存进 session jsonl 但不渲染。需先确认产品是否要这个能力 |
| **C3** | **`registerMarkdownTransformer` 承接** | 同上（P7） | 高 | 优先级低（markdown 渲染管线有安全模型，不宜开放变换） |
| **C4** | **widget 顺序声明**（G11） | pi 侧 `setWidget(key, ...)` 无顺序语义；需在 GuiComponent `WidgetMeta` 加 `order` 字段 | 低 | 现 `WidgetMeta` 已有 meta 通道，加一个字段即可 |
| **C5** | **`ctx.ui.setStatus` 复活？** | 状态栏退役（ADR-0141）是有意裁决，不建议改 | — | 见 D2 |
| **C6** | **画布 / plan / scheduler 的专属 UI 收敛** | 这三块目前在 renderer 是**完整业务实现**（canvas 10 组件约 1900 行、workflow-viz overlay、tray 三面板）。若要插件化，需 pi 侧从「投 schema」改为「投完整 GuiComponent 树」 | 高 | 收益存疑：这三块的 UI 复杂度远超 GuiComponent 原语表达能力（见 D1） |

### D 档：不建议插件化（3 项）

| # | 项 | 不做的理由 |
|---|---|---|
| **D1** | **画布 / workflow-viz / 托盘面板内容** | 这三处是**重交互 + 高度定制视觉**（拖拽画布、DAG 布局、甘特图）。GuiComponent 原语只有 11 个布局/文本原语，用它们表达等于重写一套 UI DSL。真要做，成本远超收益，且会撞 C3 约束（原语不足时补原语而非放开 custom） |
| **D2** | **状态栏**（`ctx.ui.setStatus`） | ADR-0141 已裁决整体退役，数据链已删。不应以「插件化」名目复活 |
| **D3** | **会话列表 / 项目分组 / 消息流归并 / 虚拟滚动** | 属于产品核心域与性能契约（virtua 稳定 key、消息归并算法），插件化会破坏「三视角测试」（构建者/使用者/观察者）的可验证性与既有优化范式 |

---

## §3 依赖关系与落地顺序

```
P1 (B0 contributes 透传)  ←── 所有声明式改造的地基
   │
   ├─→ P2 (A1 抽屉 tab 注册表)  ──→ B4 (选中态协议化)
   ├─→ P2 (A2 浮层 tab 注册表)
   ├─→ A3 侧栏 tab 注册表 ──→ B5
   ├─→ A4 tool 详情注册表      ← 唯一可独立完成的高价值项
   ├─→ A5 customType 注册表 ──→ C1
   ├─→ A6 custom GuiComponent provide ← P3，解锁富渲染
   ├─→ A7 快捷键注册表
   └─→ B1/B2 设置页分区 ──→ B3 托盘面板
```

### 建议批次

| 批次 | 内容 | 为什么这个顺序 |
|---|---|---|
| **第 0 批** | B0（contributes 透传）+ A6（custom provide） | 地基。做完这两项，后续每一项都能独立验证「插件声明 → 界面出现」 |
| **第 1 批** | A4 + A5（两个渲染器注册表） | 最独立、风险最低、收益直接（tool 详情与 custom 消息是扩展生态最想插手的地方）。不依赖 P2 |
| **第 2 批** | P2 抽容器抽象 + A1 + A2 | 抽屉/浮层 tab 是同一形态，一起做能验证抽象是否够用。做完后 A3/B3 是同一机制的不同落点 |
| **第 3 批** | A3 + B5（侧栏 tab）+ B1/B2（设置分区） | 复用第 2 批的容器抽象 |
| **第 4 批** | B3（托盘面板）+ A7（快捷键）+ C4（widget order） | 长尾 |
| **独立线** | B6（插件 tool 进 pi）/ B7（懒激活）/ C2 / C3 | 与 renderer 解耦，可并行评估；B6 需先核实 pi 能力 |

---

## §4 需要你裁决的三个问题

### Q1：容器抽象一次做到什么程度？

三个选项：

- **最小**：只做 A1 + A2（抽屉 + 浮层 tab 注册表），各自一套实现，接受两处相似代码。
- **中等（推荐）**：抽一个通用 `ContentSlotRegistry`（tab 声明 + 选中态 + 渲染分派），抽屉/浮层/托盘/设置四处都用它。前期多花约 1.5 倍成本，后面 A3/B3/B1 便宜很多。
- **最大**：连 L1 侧栏 tab、Composer 工具条、卡头按钮区都统一进同一个容器模型。收益边际、改动面大。

### Q2：设置页走「schema 生成表单」还是「GuIComponent 树」？

- **schema 生成表单**：设置页视觉统一、插件作者只写 JSON。代价：要自研表单生成器（或引入），且 `contributes.configuration` 的 schema 表达能力有限（`PluginConfigurationProperty` 只有 5 种 type + enum）。
- **GuiComponent 树（推荐）**：复用现有渲染管道（`views.update` + 全局域 scope），`text-input` 原语已具备。代价：设置页视觉由插件决定，插件质量参差会影响整体观感。

### Q3：插件 tool（B6）这条能力怎么办？

`api.tools.register` 已实装但模型看不见（G2）。三个方向：

- **补齐**：核实 pi 是否支持运行时注册 tool；支持则接线。
- **撤掉**：明确「插件不提供 tool，要 tool 请写 pi extension」，删除 `api.tools.register`（减少误导）。
- **保持现状但标注**：在 SDK 标 `@experimental` + 文档写明限制。

> 我倾向「撤掉」——因为「模型可见能力归 pi extension」是两层机制划分的清晰边界（见 [architecture.md](architecture.md) §6），保留一个不通的能力只会诱导错误设计。

---

## §5 扫描中发现的附带问题（与插件化无关但值得登记）

| # | 问题 | 位置 |
|---|---|---|
| S1 | `PluginContributesHeaderAction` 两版定义不一致（SDK 必填 `commandId` 且无 `activation`；core 可选 + 有 `activation`） | `packages/plugin-sdk/src/types.ts` vs `packages/core/src/extension-host/types.ts` |
| S2 | runtime 对 `contributes` 零 schema 校验（任意形状原样落 `PluginDescriptor`） | `plugin-registry.ts` `buildDescriptor` |
| S3 | `contributes.hooks` 只在 `inferActivationEvents` 中被读，产出 `onSlashCommand:` 之外的事件名（hook 类型名当激活事件），语义可疑 | `plugin-registry.ts:315` |
| S4 | `PluginUiSnapshotStore` 快照恢复依赖 `connected` 边沿，但 `ViewHost` 自举补拉是「分区为空才拉」——若某分区被推送过空树，快照不会再拉 | `ui/src/extension-host/ViewHost.vue` + `useExtensionHostBridge.ts` |
| S5 | `mountPoints.sync` 上报只发一次（`connected` 边沿重放），若挂载点集合在运行中变化（如按窗口尺寸动态注册）不会重报 | `useExtensionHostBridge.ts` |

---

## §6 附：扫描方法与可信度

- **扫描方式**：读源码（不是 grep 关键词推断）。每个「固定点」都定位到具体行并核对过消费链。
- **已核实但未写入文档的边界**：
  - `packages/renderer/src` 约 8.9 万行 / `packages/ui/src` 约 2.9 万行 / `packages/core/src` 约 5 万行（不含测试）。
  - 托盘面板族 `TRAY_BUCKETS` 只覆盖三个 task kind（bash/subagent/workflow），`session`/`canvas` 走独立面板。
  - `RIGHT_DRAWER_REGISTRY` 8 员与 `PanelContainer.vue` 的 8 分支严格一一对应（有单测 `packages/core/src/domain/drawer/__tests__/registry.test.ts` 锚定）。
- **未核实（明确标注）**：
  - B6：pi 是否支持运行时注册 tool —— **未核实**，需查 `@earendil-works/pi-coding-agent` 的 RPC 命令帧族（`packages/pi-rpc/src/commands.ts` 里没有，但 pi 主包可能有别的通道）。
  - 各候选的**工时估算**：本报告刻意不给工时，因为未经设计阶段无法可靠估算。
