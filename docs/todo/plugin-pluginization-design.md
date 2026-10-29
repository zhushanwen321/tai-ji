# 插件化改造整体设计（subagent / workflow / scheduler 三域收敛）

状态：设计草案（2026-10-24；待裁决）

本文是三个分域分析的汇总收敛。分册取证在这里：[subagent.md](plugin/subagent.md) / [workflow.md](plugin/workflow.md) / [scheduler.md](plugin/scheduler.md)。父索引：[plugin-pluginization.md](plugin-pluginization.md)。

---

## 0 一句话结论

三个域的「插件化」不是三个独立工程，而是**同一组六个缺口的三种投影**。把缺口补掉，三域同时收敛；按域分别改，会把同一套容器逻辑实现三遍。

最重要的判断：**先把容器层抽象出来，再谈内容插件化**。因为三域分析独立得出的结论高度一致——内容面（数据、部分轻量视图）多数已经可以插件化，卡住的全部是容器层（tab 位写死、点击无归宿、activation 靠字面量）。

---

## 1 三域判定收敛表

| 维度 | subagent | workflow | scheduler |
|---|---|---|---|
| 分域判定（父索引） | C 完全写死 | C 完全写死 | B 半插件化 |
| **修正后判定** | 数据 A / 轻量视图 B / **对话流 D（不可插件化）** | 数据 A / 轻量视图 B / **重可视化 D** | 数据 A / 内容 A / **容器位 C** |
| 层 1 composer 固定点 | 6 处 / 1834 行 | 19 处 / 1065 行 | 8 处（2 整件） |
| 层 2 对话流固定点 | 5 处 / 3572 行 | 13 处 | 6 处（含 494 行表单） |
| 层 3 drawer tab | 10 处 / 3137 行（L3-1/L3-5 已随容器统一批次消解） | 0 处（已裁决删除） | 0 处（不应有） |
| 层 4 overlay tab | 5 处 / 1541 行（L4-1 已消解） | 6 处（其中 OverlayTab 联合项已消解，逐项重测未做） | 16 处（全容器层；L4-1/L4-18 已消解） |
| 合计固定点 | 26 处 / 10084 行 | 38 处 | 30 处 |

> 固定点计数为 2026-10-24 实测口径；容器统一批次（743f82e6f）与结构化 activation 落地后，跨域消解的固定点 = `RightDrawerTab` 联合与 `PanelContainer` 分支链（subagent L3-1/L3-5）、`OverlayTab` 联合（三域层 4 各 1 项）、`OVERLAY_REGISTRY` 缺员（scheduler L4-18）、activation 契约字面量与 SDK 漂移（scheduler L1-5 部分消解 / L1-8 消解）。各分册清单内已逐条标注。
| 内容已插件化的部分 | `__gui__` 已产出但**宿主丢弃** | journal 数据面 100%，渲染 0% | 树已产、渲染已通（`ViewHost`） |
| 用户可见缺口 | 对话流无法树化 | DAG/甘特无法树化 | 宿主知道 "scheduler" 这个词 |

### 修正后的分类学（取代父索引的 A/B/C 单一档）

原来的 A/B/C 是按「有多少代码在宿主」判的，粒度不够——同一个域在不同层的判定完全不同。修正为**按层判定**：

| 档 | 定义 | 处置 |
|---|---|---|
| **A 已插件化** | 插件产树，宿主通用渲染，零业务认知 | 无需改造 |
| **B 可插件化** | 数据结构简单，现有原语表达得了，宿主有接缝 | 改造目标 |
| **C 容器位写死** | 内容已插件化，但「放在哪」宿主写死 | 本设计的核心议题 |
| **D 不可插件化** | 需要宿主独有能力（对话流渲染树 / 坐标系可视化） | 明确画边界，不做 |

---

## 2 六个共性缺口（三域交叉验证得出）

三份分析独立得出、高度重合的缺口。按「阻塞了几个域」排序。

### GAP-1 容器导航原语缺失（阻塞 3/3 域）

所有「点击某条目 → 打开宿主容器」的诉求都没有通道：

| 域 | 具体诉求 | 现状归宿 |
|---|---|---|
| subagent | 托盘行点击 → 打开该 subagent 的 drawer tab | `TrayNativePanel.vue:522` → `openSubagent` |
| workflow | 托盘行 / 对话流块点击 → 打开该 run 的 overlay | `TrayNativePanel.vue:522` / `WorkflowRow.vue:107` → `openWorkflow` |
| scheduler | headerAction 点击 → 打开 overlay scheduler tab | `HeaderActionsHost.vue:233` 的 `activation === 'scheduler-overlay'` |

`GuiComponent` 11 个原语里**没有任何「request host container」语义**。`action-bar` 只能走 `commandId` → `CommandRegistry.execute` → 插件 command，而插件 command 无法改 core 的容器状态。

**这是三个域共同的真正阻塞点**。workflow 分册把它列为 R1「不解决则层 1/层 2 只能做到可看不可点」。

**设计要求**：新增一个统一的容器导航声明形态，让插件能表达「点击后打开哪个容器的哪个 tab，带什么参数」。三个域共用一套，不要各造一个。

### GAP-2 容器 tab 集写死（阻塞 3/3 域的层 4）

三处同构问题：

| 容器 | 写死位置 | 成员数 | 已有注册表？ |
|---|---|---|---|
| 右抽屉 | `core/domain/drawer/types.ts:24` `RightDrawerTab`——已开放 `string`（容器统一批次，`RIGHT_DRAWER_TAB_IDS` 8 已知值 + `isKnownRightDrawerTab` 判别） | 8（内置） | `RIGHT_DRAWER_REGISTRY` 有，类型面已开放 |
| 浮层 | `workflow-viz-overlay.ts:68` `OverlayTab`——已开放 `string`（`OVERLAY_TAB_IDS` 3 已知值 + `isKnownOverlayTab` 判别） | 3（内置） | `OVERLAY_REGISTRY` 已补齐 4 条（browser/workflow/scheduler/canvas） |
| 浮层内容 | `core/domain/overlay/types.ts:55` `OverlayContent` | 4 | `OVERLAY_REGISTRY` 已与类型同步（容器统一批次消除 G5 不一致） |

类型面的 tab 位封闭已由容器统一批次拆除（三容器统一去枚举 + 已知值判别）；剩余缺口 = tab 元信息（label/icon/空态）与内容渲染的注册表派生。workflow 分册指出新增一个 overlay tab 要改 6 个文件 18 个点（其中类型面 2 点已消解，余 16）：`shared 词表 → core 类型 → core 协调 → core barrel → renderer 控制器 → renderer 壳模板 → renderer 壳宿主`。scheduler 分册独立数出同样的 18 处（现余 16）。

**设计要求**：统一 tab 声明形态 + 注册表派生。三处容器共用同一个 `ContentSlotRegistry` 抽象（声明项 = `{ id, label, icon, order, renderer }`，`renderer` 可以是 `{kind:'view', viewId}` 或 `{kind:'host', component}`）。

### GAP-3 `activation` 单值字面量（契约面已结构化，分派分支待换）

`scheduler` 分册：`activation?: 'scheduler-overlay'` 本质是「渲染端存在一个同名 if 分支」的镜像。加一个 tab 就要加一个字面量 + 一个 if 分支。

契约面已落地（容器扩展点统一 §6.3/§6.11）：`activation` 已结构化为 `HeaderActionActivation`（`{ kind: 'command' | 'overlay' | 'drawer' }` 成员，`core/extension-host/types.ts:205-218`），SDK 版已对齐补齐 `activation?`——原契约双版本漂移已消除。`'scheduler-overlay'` 作为迁移期兼容值保留（注释自证「下一版本删除」），`HeaderActionsHost.vue:235` 的同名 if 分支仍按字面量分派。

**剩余工作**：渲染端分派改按 `activation.kind` 消费（overlay/drawer 走容器导航），随后退役 `'scheduler-overlay'` 兼容值与声明本体。这同时是 GAP-1 在 headerAction 上的落地形态。

### GAP-4 交互回传缺口（阻塞 subagent 层 1/层 3、workflow 行内操作）

| 原语 | 缺什么 |
|---|---|
| `list-tree` | `TreeItem` 无 `onClick` / `commandId` / `id` → **行不可点** |
| `action-bar` | 只有 `commandId` 单向执行，**执行后无回执给插件**；无二段确认；`args` 只标量 |
| `text-input` | 只有值变更回传（`onUiEvent`），**无提交语义** |
| 无下拉原语 | subagent 模型切换、任何 select 交互都做不了 |

**设计要求**：这批是「插件要做完整交互」的前置。但要注意——不是所有都该补。判断标准：**有多个潜在生产者 + 形状稳定 + 渲染需宿主能力**（scheduler 分册给出了这条三判据，用来论证 `ScheduleQuestion` 该是协议原语而非插件贡献点）。

按此判据：
- `TreeItem` 加 `commandId`（行可点）— **该补**，三个域都要
- `action-bar` 执行回执 — **该补**，否则插件无法做状态机
- `select` 原语 — **存疑**，可能只有 subagent 一个消费者
- `text-input` 提交语义 — **存疑**，同上

### GAP-5 `custom` 逃生口是死通道（阻塞所有「重 UI 表达不了」的降级路）

三份分册独立确认：`GUI_CUSTOM_REGISTRY_KEY` 全仓**零 provide**，只有两处 inject。`custom-registry.ts` 注释说「provide 留在 ui 层（builtin 编译期 provide 是 ui 职责）」，但 ui 层没实装。

含义：**即便内置插件也不能注册自定义组件**，A 类样板的极限就是那 10 个可用原语。

**设计要求**：这个缺口要不要补，取决于 GAP-6 的裁决——如果接受「重 UI 永远留宿主」，就不必补；如果要给内置插件一条重 UI 逃生路，就必须补 provide 点（且严格 builtin-only，符合既有 C3 约束）。

### GAP-6 重 UI 不可原语化（明确不可行，要画边界）

两域独立得出同一结论：

| 视图 | 为什么不可原语化 |
|---|---|
| subagent 对话流 | `MessageStream` 576 行 + `ui/features/chat/` 27 文件 6414 行，含 markdown 管线 / shiki / KaTeX / mermaid / 图片 / virtua 虚拟滚动 / 查找。`ansi-text` 会把全部富交互降级成字符。**重写它 = 重写整个对话流** |
| workflow DAG | 需绝对定位节点坐标 + 正交边路由（`dag/layout.ts` 506 行）+ 缩放平移手势 + 六态着色。原语只有流式布局，无坐标系/连线/手势任何一项 |
| workflow 甘特 | 需时间轴百分比定位 + phase 全高背景带 + attempt 分段 + 运行游标。`progress-bar` 只能表达单条 current/total |

**设计要求**：明确**不做**，并在容器抽象里留出 `renderer: { kind: 'host', component }` 这个逃生舱——让宿主组件能作为一种「注册项」参与统一 tab 体系，但不声称它已插件化。

---

## 3 整体设计

### 3.1 分层目标态

```
┌ 内容层 ──────────────────────────────────────────────┐
│ A 类（插件产树）    todo / goal / scheduler 面板      │
│ B 类（改造目标）    subagent 托盘列表 / workflow 轻量行 │
│ D 类（宿主保留）    subagent 对话流 / DAG / 甘特       │
└──────────────────────────────────────────────────────┘
                    ▲ renderer 引用（声明 or host 组件）
┌ 容器层（本次设计核心）────────────────────────────────┐
│ ContentSlotRegistry  统一 tab 声明 + 选中态 + 分派     │
│   ├ sidebar.tab     （已有）                          │
│   ├ panel.header    （已有）                          │
│   ├ composer.toolbar（已有）                          │
│   ├ drawer.tab      （新增）                          │
│   └ overlay.tab     （新增）                          │
│ ContainerNavigation  统一「点击开容器」通道（GAP-1）    │
└──────────────────────────────────────────────────────┘
                    ▲ contributes 声明
┌ 契约层 ──────────────────────────────────────────────┐
│ PluginContributes.views / headerActions.activation      │
│ GuiComponent（+ TreeItem.commandId / action 回执）      │
└──────────────────────────────────────────────────────┘
```

### 3.2 核心抽象：`ContentSlotRegistry`

一个抽象覆盖四处容器（抽屉 / 浮层 / 侧栏 / 设置分区）。声明项形状：

```ts
interface ContentSlotDeclaration {
  id: string                    // slot id（如 'scheduler'）
  placement: string             // 'drawer.tab' | 'overlay.tab' | 'sidebar.tab' | 'settings.section'
  label: string                 // 显示名（插件自带，宿主不再查 i18n）
  icon?: string                 // lucide 名
  order?: number
  pluginId: string              // 归属（用于清理 + 内置/外部区分）
  renderer:
    | { kind: 'view'; viewId: string }               // 插件推 GuiComponent 树
    | { kind: 'host'; component: string }            // 宿主内置组件（D 类逃生舱）
  openableWithoutData?: boolean  // 空态是否可进入（替代 runs 的禁用规则硬编码）
  emptyState?: { text?: string; hint?: string }      // 插件自带文案
}
```

关键设计取舍：

| 取舍 | 决定 | 理由 |
|---|---|---|
| 选中态归谁 | **渲染侧**（不进 runtime） | 选中态是 UI 维度；core 的 `activeTab` 从联合类型降为 `string`，只做校验不枚举 |
| `renderer.kind='host'` 是否算插件化 | **不算** | 它是逃生舱，让宿主组件参与统一 tab 体系，但明确标注「内容归宿主」 |
| 空态文案 | **插件自带**（`emptyState`） | 现状每加一个 tab 要改 zh-CN + en-US 两份 i18n（scheduler 分册层 1 固定点 19 就是这个） |
| tab 与 content kind 的关系 | **保持解耦**（不要在改造中合并） | workflow 分册 R4：`setOverlayTab` 只改展示维度不改 core kind，会话删除级联按 kind 判。合并会让级联判定失效 |

### 3.3 核心抽象：`ContainerNavigation`（GAP-1 的解）

三个域、四个入口形态（托盘行 / 对话流块 / headerAction / 树内按钮）都要「点击开容器」。统一成两种表达：

**（a）声明式（headerAction）**：`activation` 结构化
```ts
activation?:
  | { kind: 'command' }                                        // 走命令链
  | { kind: 'overlay'; tabId: string; params?: Record<string, string> }
  | { kind: 'drawer'; tabId: string; params?: Record<string, string> }
```

**（b）树内（GuiComponent 内点击）**：给 `action-bar` 的 item 加 `hostAction` 字段
```ts
interface ActionBarItem {
  id: string
  label: string
  commandId?: string    // 已有：走命令链
  hostAction?: { kind: 'overlay' | 'drawer'; tabId: string; params?: Record<string, string> }  // 新增
  args?: Record<string, string | number | boolean>
}
```

同样给 `TreeItem` 加同形字段（解决 `list-tree` 行不可点）：
```ts
interface TreeItem {
  // 已有：icon / label / status / depth / children
  action?: { commandId?: string; hostAction?: {...} }
}
```

**设计要求**：`params` 只允许标量 map，宿主据此做分区/定位；不做任意对象透传（避免插件把 renderer 状态塞进来）。

### 3.4 D 类边界的画法

三份分册一致：某些 UI 不该插件化。设计上要给它们一个**正当归属**，而不是「留在宿主成为遗留」：

| D 类 | 归属 | 表达方式 |
|---|---|---|
| subagent 对话流 | 宿主渲染树，复用（不要重写） | 作为 `renderer: {kind:'host', component:'MessageStream'}` 参与容器体系；**内容数据仍从插件/RPC 来** |
| workflow DAG / 甘特 | 同上 | `renderer: {kind:'host', component:'WorkflowVizDag'}` |
| 消息流归并 / 虚拟滚动 | 纯宿主（不进容器体系） | 不动 |

这样 D 类不是「没改」，而是「显式登记为宿主渲染器」，将来若原语族补上了坐标系能力，只需把 `kind:'host'` 换成 `kind:'view'`——容器层不用动。

---

## 4 落地顺序

三份分册各自给了步骤，合并去重后的全局顺序（**按「解除阻塞数」排，不按域排**）：

### 阶段 0：清障（无行为变化，可立即做）

| # | 动作 | 出处 |
|---|---|---|
| 0.1 | 已完成：`OVERLAY_REGISTRY` 已补 scheduler/canvas（现 4 条，容器统一批次） | scheduler 步骤 2 / workflow R3 |
| 0.2 | 已完成：`PluginContributesHeaderAction` 两版契约已对齐（SDK 已补 `activation?: HeaderActionActivation`，`commandId` 已可选，容器扩展点统一 §6.11 阶段 0） | scheduler 步骤 1 |
| 0.3 | 已完成：`SubagentTab.degraded.test.ts` 已随测试合并批次 c2422d971 整删；OV3/OV5 断言已改写 `wf-viz-agent-drawer-tab-*`（e2e 全目录 `l2-tab-agent` 零命中） | workflow 步骤 1 |
| 0.4 | 已完成：死 i18n 键 `panel.sideDrawer.tabWorkflow/noWorkflow/workflowHint` 已删（i18n 目录 grep 零命中） | workflow 步骤 1 |
| 0.5 | 补 `bot` 图标到 `WIDGET_ICON_ENTRIES` | subagent 步骤 2 |

**为什么先做 0.1**：workflow 分册明确警告——注册表化之前不修这个不一致，「注册表驱动」会立刻以错误基线推进。

### 阶段 1：契约与容器抽象（解除 3 域的共同阻塞）

| # | 动作 | 解除 |
|---|---|---|
| 1.1 | `activation` 结构化 + 两版契约对齐 | GAP-3 |
| 1.2 | `TreeItem.action` + `action-bar.hostAction` + `ActionBarItem` 回执 | GAP-1 / GAP-4 |
| 1.3 | `ContentSlotRegistry` 抽象落地 + 注册 `drawer.tab` / `overlay.tab` 挂载点 | GAP-2 |
| 1.4 | `openOverlayTab(tabId, sessionId, params)` 通用 opener（现有 `openSchedulerOverlay` 等改薄壳） | GAP-1 |
| 1.5 | 容器导航执行器：声明式与树内两条路径统一到同一个宿主执行器 | GAP-1 |

**这一阶段完成后，三域的「容器位」问题一次性解决**，后续各域只是填声明。

### 阶段 2：低成本高收益的域改造（验证抽象）

| # | 动作 | 收益 | 依据 |
|---|---|---|---|
| 2.1 | **subagent 层 2 接上 `__gui__`** | 全仓最典型的「插件做了、宿主不接」断点——插件已产 GuiComponent，宿主 `SubagentRow` 从不读 | subagent 步骤 1（改 2 个文件） |
| 2.2 | **scheduler 层 4 tab 声明化** | tab 位已随容器统一批次开放（`OverlayTab = string`），沿用已跑通的 `ViewHost` 路径，剩 tab 元信息与内容渲染的注册表派生 | scheduler 步骤 5 |
| 2.3 | **scheduler 层 1 activation 泛化** | 消除 `HeaderActionsHost:233` 特例 | scheduler 步骤 3 |
| 2.4 | scheduler 预览面泛化（`SchedulerQuickCard` → 通用组件） | 消除 213 行专属组件 | scheduler 步骤 6（可选） |

**为什么 2.1 排这么前**：改两个文件、零协议变更、立即可见。它能验证「插件产树 → 宿主渲染」这条链在对话流里也成立。

### 阶段 3：托盘统一（三域共性最大的一块）

托盘现在并存两套机制：built-in 件（`TrayTaskKind = 'bash'|'subagent'|'workflow'` + 专属面板）与协议 widget 区（插件推树 + 通用渲染）。**同一外壳里两套语义**。

| # | 动作 | 依据 |
|---|---|---|
| 3.1 | pi 侧补 `setWidgetDual(ctx, 'workflow', ...)` 与 `setWidgetDual(ctx, 'subagent', ...)` | workflow 步骤 3 / subagent E1 |
| 3.2 | 宿主删 built-in workflow / subagent 件（`useTrayCounts` 槽、`BUILTIN_ORDER`/`BUILTIN_ICONS`、`TrayNativePanel` 组、`tray-tone` 函数、i18n 键） | workflow 步骤 4 / subagent K3 |
| 3.3 | 行点击走 `TreeItem.action.hostAction`（阶段 1.2 已备） | GAP-1 |

**风险**：subagent 分册 K3 指出 L1 测试 3094 行 4 文件全针对 built-in 三件，迁移需重写。**建议分两 commit：先加 widget 推送并行跑，再删 built-in 分支 + 迁移测试**。

**保留**：`bash` 件。它的数据源是 runtime 后台任务服务（`background-task-service.ts`），不是插件推送，且 `base-tool-enhance` 是 pi 侧覆盖内置 bash 工具——形态与 subagent/workflow 不同，不在本批。

### 阶段 4：subagent 层 3 与其它

| # | 动作 | 说明 |
|---|---|---|
| 4.1 | `SubagentTab` 保持宿主（D 类，对话流不可树化），但**改为 `drawer.tab` 的 `renderer:{kind:'host'}` 声明项** | 从「写死分支」变成「登记项」，至少容器层统一了 |
| 4.2 | workflow 层 2 恢复 `__gui__`（撤 D8 裁决 `tool-workflow.ts:328/404`） | 依赖阶段 1.2 的点击通道 |
| 4.3 | 四个 extension 配置页改插件自渲染（父索引遗留项） | 独立线，不急 |

---

## 5 明确不做（要写进设计文档防回潮）

| 项 | 理由 | 出处 |
|---|---|---|
| subagent 对话流原语化 | 重写它 = 重写整个对话流（6000+ 行） | subagent X1 |
| subagent 进 overlay 一级 tab | 语义层级错配（tab = 视角切换 vs 实体钻取）+ 制造第三套容器 | subagent X3 / §5.3 |
| scheduler / workflow 补 drawer tab | 2026-10-19「浮层是唯一形态」裁决；scheduler 与 workflow 同属单一入口管理面板 | scheduler §4.3 / workflow §4 |
| DAG / 甘特原语化 | 需坐标系原语族（absolute/line/shape/gesture），成本远超收益 | workflow R2 |
| 插件侧复刻 `isRunningProjection` | 判定权 SSOT 在 renderer（`subagent-bucket.ts:40`），复刻即造第二口径 | subagent X4 |
| 单域改完成通知折叠行 | `FoldedNoticeType` 四员共享 4 张映射表与视觉规范，单域改会分裂 | workflow R5 |
| 把「每域一个 drawer tab」当插件化目标 | 插件化 ≠ 给每个域补 tab | workflow §0.5 |

---

## 6 需你裁决的三个问题

### Q1：GAP-1 的落地形态选哪个？

| 选项 | 说明 | 代价 |
|---|---|---|
| **A（推荐）** 扩展 `action-bar.hostAction` + `TreeItem.action` | 声明式，插件不接触宿主 API；宿主统一执行 | 需扩 `extension-protocol` 类型 + 渲染组件 + 执行器三处 |
| B 宿主内置命令（如 `workflow.openRun`） | 插件走 `commandId`，宿主注册一批容器命令 | 每加一个容器就要加命令，且命令要带参数——回到 GAP-3 的问题 |
| C 让插件 command 能改容器状态 | 开放 core 容器 API 给插件 command | 插件（Worker/fork）无 renderer 上下文，需跨进程；破坏分层 |

### Q2：`custom` 逃生口（GAP-5）补不补？

- **补**：内置插件可注册重 UI 组件，D 类（对话流/DAG）有插件化出路。代价：要严格 builtin-only 校验，且一旦开了口，后续「原语不够就上 custom」的诱导会强。
- **不补（倾向）**：保持「补原语而非放开 custom」的纪律（既有 C3 约束）。D 类用 `renderer:{kind:'host'}` 登记，明确它不是插件化。

### Q3：托盘 `bash` 件要不要一起迁？

- **不迁（倾向）**：数据源是 runtime 服务不是插件，形态不同，且 `base-tool-enhance` 是 pi 内置工具覆盖，迁它需要新协议。
- **迁**：托盘彻底统一成一套机制。

---

## 7 包整合与多挂载点能力（2026-10-24 追加，用户裁决采纳）

本节回答两个连带问题：① 22 个 pi extension 包要不要整合；② 一个 plugin 能否声明多个同类挂载点（多个 drawer tab / 多个 composer ICON）。

### 7.1 结论先行

| 问题 | 结论 |
|---|---|
| 是否大面积整合 extension | **不整合**。功能耦合只有 4 条边，其中 3 条是测试引用或 `Symbol.for` 跨包槽（设计上刻意不共享模块） |
| 是否可包内配置禁用能力 | pi 侧**已可行**（`pi.setActiveTools` 有先例）；taiji plugin 侧需新增抽象。但**不构成整合理由**——会造出包内 if 堆积 |
| 微型包整合 | **只并 2 个**：`agent-ext` + `msg-id-mapper`（同 group 同 tier 同子域）。原方案的 cache-probe 不能并（见 7.3） |
| 一个 plugin 多 composer ICON | **已支持，无需改动** |
| 一个 plugin 多 drawer tab | **机制已备，容器不肯读**——需补挂载点（GAP-2 具象化） |

### 7.2 为什么不整合：实测证据

**共享包被误读为耦合**。`extension-logger` 被 21/22 个包依赖、`ext-guards` 被 16/22 依赖——这是**横切基础设施**，不是功能耦合。合并它们等于把日志/守卫实现散进各包。

**真实功能耦合只有 4 条边**：

| 边 | 性质 | 是否该合并 |
|---|---|---|
| `plan → goal` | 仅 `import type { GoalInitFn }` + 一行 `Symbol.for('@zhushanwen/pi-goal.goalInit')` 跨包槽；`execution-notice.ts:37` 注释明写「两侧不共享运行时模块」 | **不该**。这是用约定替代依赖的标准做法 |
| `base-tool-enhance → pending-notifications` | 运行时通路的 pi 引用刷新 | 不并（分属不同职责，且都在 infrastructure） |
| `subagent-workflow → pending-notifications` | 仅测试文件引用 | **不该** |
| `subagent-workflow → structured-output` | 仅测试注释提及 | **不该** |

**规模极度不均**（实测生产行数，排除测试）：

| 包 | 行数 | 包 | 行数 |
|---|---:|---|---:|
| `subagent-workflow` | 15501 | `ask-user` | 2261 |
| `session-reader` | 9897 | `canvas` | 1564 |
| `permission` | 6204 | `smart-context` | 1572 |
| `scheduler` | 5401 | `todo` | 1326 |
| `structured-output` | 4426 | `rename-session` | 1276 |
| `goal` | 3825 | `session-manager` | 1079 |
| `plan` | 3402 | `network-proxy` | 1014 |
| `base-tool-enhance` | 2918 | `pending-notifications` | 948 |
| | | `provider-live-sync` | 859 |
| | | `system-prompt-trace` | 573 |
| | | `system-prompt` | 495 |
| | | `cache-probe` | 302 |
| | | `msg-id-mapper` | 144 |
| | | `agent-ext` | 84 |

**硬约束：强制清单分层会被破坏**。`mandatory-extensions.json` 两层：infrastructure（8 个，不可禁）/ feature（13 个，可禁）。按「功能相关性」合并（如 todo+goal+plan）会**跨层合并**，导致无法单独禁用其中一个。

**判据**（取代「有没有共用代码」）：

1. 能否独立禁用——用户想关 A 留 B，合并后做不到
2. 是否共享跨包状态——用 `Symbol.for()` 跨包槽说明设计上刻意不共享模块
3. 生命周期是否一致——permission 的审批与 todo 的列表完全无关，只是都挂 `on()`

### 7.3 可合并清单（实测后修正）

原初稿列了 3 个微型包，实测发现 **`cache-probe` 不能并入 taiji 组**——它 `taiji.role=universal` 且不在 `mandatory-extensions.json`；而 `role=taiji` 的包必须在该清单里（`scripts/check-extension-dependencies.mjs:161-163` 强制）。并组会直接违反分组约束。

**最终只并 1 组**：

| 动作 | 内容 | 收益 | 约束核对 |
|---|---|---|---|
| **合并** | `taiji/agent-ext`（84 行）+ `taiji/msg-id-mapper`（144 行）→ `taiji/host-internals`（约 230 行） | 22 包 → 21 包 | 同 group（taiji）、同 tier（都是 infrastructure）、同子域（都是「pi 侧 taiji 内部协议设施」）、无互相依赖 |

**合并需同批改的引用点**（漏改即断）：

| 引用位置 | 内容 |
|---|---|
| `packages/shared/src/mandatory-extensions.json:53,63` | 两条清单条目 → 一条 |
| `scripts/check-publish-surface.mjs:79-80` | 包名白名单两条 → 一条 |
| `packages/shared/src/pi-preset.ts:20` | 注释举例里的包名 |
| `packages/runtime/src/infra/pi/entry-tree-builder.ts:25,56,58,70` | 4 处注释引用 `pi-msg-id-mapper`（customType 契约说明） |
| `packages/core/src/domain/chat/store.ts:680` | 注释引用包名 |
| `extension-dependencies.json` | 依赖登记表重生成 |

**明确不并（即使看起来相关）**：

| 包对 | 不并理由 |
|---|---|
| `system-prompt` + `system-prompt-trace` | **跨 tier**（前者 infrastructure 不可禁、后者 feature 可禁）。合并后无法单独禁用 trace 留痕 |
| `todo` + `goal` + `plan` | `plan→goal` 是刻意的 `Symbol.for()` 跨包槽；todo 与二者零耦合；且三者都属 feature 但独立可禁 |
| `ask-user` + `permission` | 都属「拦截/交互」类但职责正交（提问 vs 审批），合并后 `on()` handler 会互相干扰 |
| `session-reader` / `structured-output` 等大包 | 9900 / 4400 行，内部已有清晰子域；`structured-output` 还有独立跨包契约测试 |
| `cache-probe` | role/tier 不匹配（见上）；且它是零影响诊断探针，与 taiji 集成包职责无关 |

### 7.4 包内能力开关：能做什么、不能替代什么

**pi 侧（可行，有先例）**：

```ts
// pi SDK 真实能力（dist/core/extensions/types.d.ts:1236-1246）
getActiveTools(): string[]
getAllTools(): ToolInfo[]
setActiveTools(toolNames: string[]): void
```

`ToolExposure` 五档中 `hidden` = 注册但不可达（激活也无效）。现有先例两处：

| 先例 | 位置 | 做法 |
|---|---|---|
| ask-user 条件禁用 | `ask-user/src/index.ts:51` | `pi.setActiveTools(pi.getActiveTools().filter(n => n !== 'ask_user'))` |
| plan 模式工具收拢 | `plan/src/state.ts:237-251` | `getActiveTools()` 快照 → 进入时 `setActiveTools(PLAN_MODE_TOOLS)` → 退出恢复 |

**taiji plugin 侧（需新增抽象）**：`contributes` 是 manifest 静态声明，现在只有整包开关（`disabled-packages.json`）。运行时撤回机制存在但不统一——`views.update(id, [], …)` 推空树 / `updateHeaderAction(id, {hidden:true})` / `commands.unregister`。若要做「单条贡献可关」，需引入统一的 capability 开关层。

**为什么不因此整合**：包内 if 堆积与本设计 §2 要消除的「固定特殊实现」是同一种坏味道，只是从宿主搬到了 extension 内部。

### 7.5 多挂载点能力矩阵（实测）

| 挂载点 | 一个 plugin 能声明几个 | 机制现状 | 缺什么 |
|---|---|---|---|
| `panel.header`（headerAction，composer ICON） | **任意多个** | `headerActions?: [...]` 数组；`ContributionRegistry` key = `(pluginId, type, contributionId)` 不互相覆盖；渲染端 `buttons` computed 循环；`order` 排序 | **无** |
| `composer.toolbar` | 任意多个 view | `views?: [...]` 数组；`ViewHost` 按 viewId 渲染 | **无**（如要多个 tool 条需各自 viewId） |
| `sidebar.tab` | 任意多个 view | 已注册；`getViews` 过滤 `placement === 'sidebar.tab'` 后 map 全部 | **`icon` 字段缺失**——`PluginContributesView` 无 `icon`，`useExtensionHostBridge.ts:447` 硬编码 `icon: undefined` |
| `drawer.tab` | **0（不支持）** | 挂载点未注册；`RightDrawerTab` 是 core 写死联合类型（8 员）；`PanelContainer.vue:146-176` 是 8 分支 `v-else-if` | **挂载点注册 + 类型去联合化 + 分支改 ViewHost**（本文阶段 1.3） |
| `overlay.tab` | **0（不支持）** | 同上；`OverlayTab` 三员写死 | 同上 |
| `settings.section` | **0（不支持）** | `SettingsModal.vue` `navGroups` 硬编码 17 项 | 同上 |

**关键判断**：用户问的「一个 plugin 多个 drawer tab / 多个 ICON」——**ICON 已支持，drawer tab 卡在容器层而非数量层**。`views` 契约本来就是数组，`ContributionRegistry` 本来就支持一个 plugin 多 view，`ViewHost` 本来就能按 viewId 渲染任意树。**缺的只是「drawer 容器肯不肯读注册表」**。

**顺带发现的真实缺口**：`PluginContributesView` 缺 `icon` / `order` / `emptyState` 三个字段（`packages/plugin-sdk/src/types.ts` 与 core 版都没有）。这正是 §3.2 `ContentSlotDeclaration` 要补的——补上后 sidebar / drawer / overlay / settings 四处 tab 才能有自己的图标与排序。

### 7.6 落地顺序修正

原 §4 阶段划分不变，但在**阶段 1.3 前插入一个前置**：

| 新步骤 | 内容 | 为什么在前 |
|---|---|---|
| **1.3-pre** | `PluginContributesView` 补 `icon` / `order` / `emptyState`（两版契约同步） | 挂载点接上后若无图标字段，tab 全是默认图标——先补字段再接容器，避免改两遍 |
| **1.3** | `ContentSlotRegistry` + 注册 `drawer.tab` / `overlay.tab` | 原计划 |
| **阶段 5（新增，可选）** | 微型包合并 `agent-ext` + `msg-id-mapper` → `host-internals` | 与插件化主链无依赖，可作为独立清理项 |

---

## 8 与既有文档的关系

| 文档 | 需要更新什么 |
|---|---|
| [plugin-pluginization.md](plugin-pluginization.md) | A/B/C 三档改为按层判定（本文 §1）；补三域分册链接 |
| [../plugins/extension-points.md](../plugins/extension-points.md) | R36/R37/G5/G8 判定细化；G4/G5 的「可插件化方向」按本文更新 |
| [../plugins/renderer-pluginization-scan.md](../plugins/renderer-pluginization-scan.md) | C6/D1 结论细化：workflow 从「C 完全写死」改为「数据 A + 轻量视图 B + 重可视化 D」；subagent 同理 |
| [../plugins/architecture.md](../plugins/architecture.md) | §7 缺口 7（headerAction 契约漂移）在 0.2 修复后关闭 |

---

## 附：三域分册导航

| 分册 | 最有价值的独有发现 |
|---|---|
| [subagent.md](plugin/subagent.md) | 「插件已产出 `__gui__`，宿主把它丢掉了改用专属组件重画」——全仓最典型的断点，改造成本最低 |
| [workflow.md](plugin/workflow.md) | 数据面 100% 插件化、渲染面 0%；DAG/甘特是「补原语也解决不了」的硬边界 |
| [scheduler.md](plugin/scheduler.md) | 距离完全插件化只差 3 步；`activation` 字面量的结构化泛化方案（三域共用） |
