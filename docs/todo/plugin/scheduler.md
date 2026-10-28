# scheduler 域全链路现状分析

状态：分析完成（2026-10-24；待裁决）

范围：本文件只做现状侦查，不改源码。所有路径/行号均已实测核对（`grep -n` / `wc -l` / `sed -n`）。

背景索引：横向缺口登记见 [docs/plugins/extension-points.md](../../plugins/extension-points.md) 的 G5 / G12 / G13 与 R36；分域总表见 [docs/todo/plugin-pluginization.md](../plugin-pluginization.md)；分层扫描见 [docs/plugins/renderer-pluginization-scan.md](../../plugins/renderer-pluginization-scan.md)。

---

## 0 结论摘要（含：距离完全插件化还差哪几步）

scheduler 是全仓唯一「数据面已完全插件化、内容渲染已用通用宿主、但容器位与入口分派仍写死」的域。拆成两半看，结论截然不同。

已在插件侧（且是全仓最干净的样板）：

1. 数据生产：`@zhushanwen/pi-scheduler`（`extensions/universal/scheduler/src/`，19 个生产文件 5393 行）把任务写成 pi custom entry（`TASK_ENTRY_TYPE = 'pi-scheduler:task'`，`packages/extension-protocol/src/extensions/scheduler/types.ts:65`；写侧 `extensions/universal/scheduler/src/backend.ts:188`）。
2. 数据消费与折叠：builtin plugin `scheduler-manager`（`resources/plugins/scheduler-manager/index.ts`，706 行）经插件 API 拉取 entry、折叠成任务集、组装 `GuiComponent[]`（`buildModalTree`，`index.ts:199`），再 `api.views.update` 推给宿主。
3. 渲染：`packages/ui/src/extension-host/ViewHost.vue:48-53` 从 `ViewHostStore` 取分区树，交 `GuiComponentRenderer` 递归渲染；调度器业务语义在宿主侧为零。
4. 写操作：树内 `action-bar` → `ACTION_EXECUTOR_KEY`（`packages/ui/src/rendering-protocol/action-executor-key.ts:22`，壳层 provide 于 `packages/renderer/src/composables/shell/useExtensionHostBridge.ts:559-567`）→ `CommandRegistry.execute` → `plugin.executeCommand` → 插件 handler。宿主只当执行器。

写死在宿主（三层共 8 类）：

| # | 写死物 | 位置 |
|---|---|---|
| W1 | `activation === 'scheduler-overlay'` 专属分派分支 | `packages/renderer/src/components/extension/HeaderActionsHost.vue:233-247` |
| W2 | `SchedulerQuickCard.vue` 整个 hover 快捷面板组件（213 行） | `packages/renderer/src/components/extension/SchedulerQuickCard.vue` 全文件 |
| W3 | 声明类型里 `activation?: 'scheduler-overlay'` 单值枚举 | `packages/core/src/extension-host/types.ts:132`、`:205-221` |
| W4 | `OverlayTab = 'runs' \| 'scheduler' \| 'canvas'` 联合类型 + `overlayTab` 初值 | `packages/renderer/src/components/panel/workflow-viz/overlay/workflow-viz-overlay.ts:63`、`:67` |
| W5 | 浮层 tab 条三段写死（label/icon/顺序） | `WorkflowVizOverlay.vue:428-432`、模板 `:142-164` |
| W6 | 浮层标题三态分支 + 内容三态分支 | `WorkflowVizOverlay.vue:65-136`（标题）、`:168`/`:308`/`:319-327`（内容） |
| W7 | `SchedulerOverlayPayload` + `openSchedulerOverlay` 专用 opener | `packages/core/src/domain/overlay/types.ts:40-42`、`coordination.ts:67-69` |
| W8 | SDK 侧 `PluginContributesHeaderAction` 无 `activation` 字段（契约双版本漂移） | `packages/plugin-sdk/src/types.ts:252-259` vs `packages/core/src/extension-host/types.ts:205-221` |

距离完全插件化还差 **3 步**（不含可选优化）：

- **第 1 步：结构化 activation 声明**。消除 W1+W3+W8。当前 `activation` 是单值字面量，本质是「渲染端存在一个同名 if 分支」的镜像；改成 `{ kind: 'overlay', tabId, viewId, preview? }` 后，渲染端只剩一个通用的「打开该 tab」动作，宿主无需知道 `scheduler` 这个词。
- **第 2 步：overlay tab 注册表**。消除 W4+W5+W6+W7。tab 元信息（title/icon/order/空态/内容 viewId）由声明提供，`OverlayTab` 从联合类型退化为 `string`，`tabSegments` 从常量变为注册表派生，标题/内容分支收敛为单条 `<ViewHost>`。
- **第 3 步：headerAction hover 预览面泛化**。消除 W2。QuickCard 里除「底部直开 overlay 条」外全是通用机制（hover 160ms 开、pin、ViewHost 渲染、disabled 挡开合）；把底部动作条改成声明字段后，任意插件都能声明「我的 headerAction 有 hover 预览面板」。

做完这 3 步，宿主对 scheduler 的专属认知 = 0 行（`SCHEDULER_MODAL_VIEW_ID` 常量被声明内 viewId 取代）。对照 todo/goal 已达成的 A 级形态（`extensions/universal/todo/src/model.ts` 的 `buildGui()`，前端零专属代码），差距恰好就是这三步。

另需登记一个既有事实（非缺陷，属冗余入口）：scheduler 同时存在两条显示通道——headerAction 的 clock 按钮（`core/extension-host/builtin-contributions.ts:59`）与 pi extension 推的协议 widget（`extensions/universal/scheduler/src/widget.ts:151` 的 `setWidgetDual(ctx, 'scheduler', ...)`，key = `'scheduler'`）。后者经 `ViewHostStore` 出现在托盘 widget 区（`packages/renderer/src/components/panel/tray/ComposerTray.vue:425-432` 无任何 key 过滤），与左簇 clock 在有任务时同时可见。两者数据源不同（widget 由 pi extension 直推、headerAction 树由插件再次拉取折叠），语义重叠，插件化时可一并裁决是否保留双通道。

---

## 1 数据链路全景

### 1.1 生产侧（pi extension 写盘）

```
@zhushanwen/pi-scheduler (extensions/universal/scheduler/)
  service.create / toggle / delete / run       service.ts
    → backend.appendEntry(op)                  backend.ts:38/58/188
      → pi.appendEntry(TASK_ENTRY_TYPE, op)    pi SDK（同步落盘 session JSONL）
```

- entry 类型常量：`packages/extension-protocol/src/extensions/scheduler/types.ts:65`（`'pi-scheduler:task'`），op 联合类型同文件 `:91`。
- 这是唯一持久化面：调度器状态无独立文件，全部是 session JSONL 的 custom entry（event sourcing + 折叠恢复）。撤销（`taiji:revoked`）后靠 pi 活跃路径裁剪重建，`scheduler-manager/index.ts:87` 的 `REVOKED_SIGNAL_CUSTOM_TYPE`（注释 `:85-90` 说明三侧同串）。
- 展示侧另有独立通道（不进对话流、不进 entry）：`widget.ts:150-152` `setSchedulerWidget` → `setWidgetDual(ctx, 'scheduler', ...)`（`packages/extension-protocol/src/core/helpers.ts:105-121`）→ GUI 分支 `guiSetWidget`（`:65-78`，单行 NUL marker + JSON）。

### 1.2 中转侧（runtime）

widget 通道（协议 widget）：

```
pi ui.setWidget(key='scheduler', [GUI_WIDGET_MARKER + JSON])
  → runtime/src/infra/pi/event-adapter.ts:675 tryDecodeWidgetGui()
  → :704 payload { sessionId, widgetKey, gui }
  → extension:widgetGui（message-bus state 类，message-bus.ts:158）
  → core/src/extension-host/message-bus-bridge.ts:258-279 parseExtensionWidget
      （widgetKey → viewId，guiTree = [payload.gui]，meta 透传）
  → 内部事件 extension-widget → ViewHostStore
```

插件视图通道（scheduler-manager 树）：

```
resources/plugins/scheduler-manager/index.ts:497
  api.views.update(SCHEDULER_MODAL_VIEW_ID, tree, { sessionId })
  → Worker RPC 'plugin.views.update'（runtime/services/plugin-service/api/views-api.ts:127-130 代理）
  → registerViewRpcHandlers（views-api.ts:76-103）
      · asSafeKey 窄化 viewId（:80）
      · resolveViewScope 归属二选一（:91）
      · guiTree 必须为数组，否则 INVALID_GUI_TREE（:93-98）
      · service.handleViewUpdate（:100）
  → runtime/services/plugin-service/plugin-rpc-setup.ts:460-476
      · uiSnapshotStore.setView（快照写入，:465-472）
      · 返回 stored → publishViewUpdate（:473-475）
  → runtime/services/plugin-service/plugin-broadcast.ts:72-95
      · 会话域：messageBus.publish(sessionId, { type: 'plugin:viewUpdate', id: 'vu_N', payload })
      · transient 类（message-bus.ts:223），不入 ring、无重放
  → core/src/coordination/route-inbound.ts:376（crossSession: true）
  → core/src/extension-host/message-bus-bridge.ts:206-225 parseViewUpdate
  → core/src/extension-host/view-host-store.ts:55-57 subscribe → consumeWidget（:120-）
      · per-scope 分区：sessionId → (viewId → ViewCacheEntry)
```

可靠性由 ADR-0097 两条腿保证（功能域零补偿代码）：

- 推送（transient，可丢）：上述 `plugin:viewUpdate`。
- 拉取（收敛）：`plugin.ui.snapshot`（`runtime/src/transport/plugin-message-handler.ts:172-177` → `pluginService.getUiSnapshot`），renderer 侧 connected 边沿全量恢复（`useExtensionHostBridge.ts:187` 的 `ensurePluginUiSnapshot`）+ ViewHost 挂载分区缺失自举补拉（`packages/ui/src/extension-host/ViewHost.vue:58-66`，仅 `empty='placeholder'` 才拉）。

一个精确语义差异：`SCHEDULER_MODAL_VIEW_ID` 两个消费点 `empty` 不同——overlay tab 用 `empty="hidden"`（`WorkflowVizOverlay.vue:326`），QuickCard 用 `empty="placeholder"`（`SchedulerQuickCard.vue:80`）。因此**只有 QuickCard 路径具备挂载自举补拉**；overlay tab 在推送丢失且快照未命中时零 DOM（不拉取、无占位）。这是 ADR-0097 拉取通道在本域的覆盖缺口，与插件化改造无关但应同批处理。

### 1.3 消费侧（renderer）

```
ViewHostStore（core）
  → ViewHostSource（packages/ui/src/extension-host/view-host-source.ts:39 getViewIds / getView）
  → ViewHost.vue:48-53 computed getView(sessionId, viewId)
  → GuiComponentRenderer 递归
      stats-line / list-tree / action-bar → packages/ui/src/rendering-protocol/primitives/*
```

三个消费点读同一分区：

| 消费点 | 位置 | empty |
|---|---|---|
| overlay 定时任务 tab | `WorkflowVizOverlay.vue:326` | `hidden` |
| composer 左簇 hover 面板 | `SchedulerQuickCard.vue:76-82` | `placeholder` |
| 托盘聚合面板（widget 通道，key='scheduler'） | `ComposerTray.vue:266-270` / `TrayAggregatePanel.vue:78-82` | 有 entry 即渲染 |

---

## 2 层 1：composer 入口

### 2.1 现状

声明（静态形状，core 侧）：

- `packages/core/src/extension-host/builtin-contributions.ts:52-66`：`pluginId: 'scheduler-manager'`，`headerActions: [{ id: 'scheduler-manager.open', title: '定时任务', icon: 'clock', order: 20, activation: 'scheduler-overlay' }]`（`:59`），`commands: [toggle, run, delete]`（`:61-65`）。
- `packages/core/src/extension-host/types.ts:116-133`：`ContributionRecord.headerAction` 形状；`:205-221` 的 `PluginContributesHeaderAction` 带 `activation?: 'scheduler-overlay'` 与可选 `commandId`。
- 解析：`packages/core/src/extension-host/contribution-registry.ts:124-137`（`parseHeaderActionContributions`），`placement: 'panel.header'`（`:33`）。

运行时状态（徽标 / 显隐 / 灰置）：

- 插件侧计算：`resources/plugins/scheduler-manager/index.ts:474-505` `pushTreeAndBadge`（badge = 启用任务数，`:490-491`；`hidden = tasks.length === 0`，`:494`）；`:506-522` `pushHeaderAction` → `api.ui.updateHeaderAction`（`:508`）。
- 中转：`runtime/src/services/plugin-service/plugin-service.ts`（广播）；`core/src/extension-host/message-bus-bridge.ts:235-254` `parseHeaderActionUpdate`。
- 写入：`core/src/extension-host/header-action-store.ts:70` `set(sessionId, headerActionId, input)`，per-session 分区；清理 `:86` `clearForSession` / `:95` `clearForPlugin`。
- 装配：`useExtensionHostBridge.ts:513-517` 建 store + subscribe；`:521-529` 声明镜像 `shallowRef`；`:568-583` provide `HEADER_ACTIONS_SOURCE_KEY`。

渲染与分派：

- 挂载两处：`packages/renderer/src/components/panel/Composer.vue:140`（左簇 expanded）、`packages/renderer/src/components/panel/tray/ComposerTray.vue:141`（L2 聚合面板首段）。
- 可见性单点：`useExtensionHostBridge.ts:259-269` `isVisibleHeaderAction`（无 headerAction 段 / 运行时状态未推送 / `hidden=true` / 非 overlay 直开且无 commandId 四者不可见）。
- 按钮构建：`HeaderActionsHost.vue:225-263` `toHeaderActionButton`。
  - **特例分支 `:233-247`**：`if (ha.activation === 'scheduler-overlay')` → 直接返回 `schedulerCard: true`、`onClick: () => {}`，跳过 `resolveCommandAvailability`（E13 三态）与 `dispatchHeaderAction`（E3 簿记）。灰置唯一来源 = 运行时镜像 `entry.disabled`（`:242`）。
  - 常规分支 `:248-262`：必须有 `commandId`，走可用性三态 + `CommandRegistry.execute`。
- 模板分派：`HeaderActionsHost.vue:39-46` `v-if="b.schedulerCard"` → `<SchedulerQuickCard>`；`:47-77` 否则走通用 `Tooltip + Button`。
- 图标：`:114-116` `HEADER_ACTION_ICONS = { clock: Clock }`，未命中 fallback `Puzzle`（`:240`/`:256`）。

QuickCard（宿主专属 213 行）：

- hover 开合：`SchedulerQuickCard.vue:126-127`（`HOVER_OPEN_MS = 160` / `HOVER_CLOSE_MS = 240`），状态机 `:129-204`（`panelOpen`/`pinned` 双 ref 于 `:129-130`，`close()` `:141`、`onAnchorEnter()` `:147`、`onTogglePin()` `:183` + `openTimer`/`closeTimer`）。
- 内容：`:76-82` `<ViewHost :view-id="SCHEDULER_MODAL_VIEW_ID" :scope="{kind:'session',sessionId}" empty="placeholder">`。
- 底部动作条：`:83-94`，`data-testid="scheduler-quick-open-overlay"`（`:87`），点击 `openOverlay()`（`:206-210`）→ `openSchedulerTab(props.sessionId)`（`:209`，import 自 `:107`）。
- reka 层外点击拦截：`:201-204`（`data-scheduler-quick-root` 锚点于 `:36`）。

### 2.2 固定点清单

| # | 固定点 | 文件:行 | 性质 |
|---|---|---|---|
| L1-1 | `activation === 'scheduler-overlay'` 专属分支 | `HeaderActionsHost.vue:233-247` | 15 行硬编码分派 |
| L1-2 | 模板 `v-if="b.schedulerCard"` 硬编码专属组件 | `HeaderActionsHost.vue:39-46` | 8 行 |
| L1-3 | `HeaderActionButtonView.schedulerCard` 布尔字段 | `HeaderActionsHost.vue:131`、`:244`/`:260` | 视图模型泄漏域概念 |
| L1-4 | `SchedulerQuickCard.vue` 全组件 | `SchedulerQuickCard.vue:1-213` | 213 行宿主专属 |
| L1-5 | `PluginContributesHeaderAction.activation` 单值枚举 | `core/extension-host/types.ts:132`、`:205-221` | 类型层把域值写进契约 |
| L1-6 | 声明本体 `activation: 'scheduler-overlay'` | `core/extension-host/builtin-contributions.ts:59` | 1 行，但决定了上面 5 项 |
| L1-7 | 可见性谓词里的 activation 特判 | `useExtensionHostBridge.ts:268` | `ha.activation === 'scheduler-overlay' \|\| !!ha.commandId` |
| L1-8 | SDK 契约无 `activation` 字段（commandId 必填） | `packages/plugin-sdk/src/types.ts:252-259` | 第三方插件照 SDK 写不出该入口（已登记 `docs/plugins/architecture.md:268`） |

合计 8 个固定点：1 个 213 行整组件、1 个 15 行专属分支、6 个类型/谓词/声明单点。

### 2.3 插件化改造方案

目标：让任意插件声明「点击我的 headerAction 打开某个 overlay tab」，可选声明「hover 时用 ViewHost 预览我的树」。

现状骨架其实已通用，只有三处域耦合：

1. `activation` 值域写死成一个域名字面量（L1-5/L1-6）。
2. 分派后落到哪个组件写死（L1-2/L1-4）。
3. QuickCard 的「底部直开 overlay」把 overlay 语义烧进组件（L1-4 的 `:207-210`）。

改造方案（结构化 activation，core 与 SDK 同 commit 改）：

```ts
// packages/core/src/extension-host/types.ts（与 plugin-sdk 同步）
type HeaderActionActivation =
  | { kind: 'command' }                                    // 缺省，等价现状
  | { kind: 'overlay'; tabId: string; viewId: string;      // 取代 'scheduler-overlay'
      preview?: { mode: 'hover'; openDelayMs?: number; closeDelayMs?: number } }

interface PluginContributesHeaderAction {
  id: string
  title: string
  icon: string
  commandId?: string          // kind='command' 时必填（校验移到运行时或构建期）
  order?: number
  activation?: HeaderActionActivation
}
```

渲染侧对应改造：

- `HeaderActionsHost.vue:233-247` 的 if 分支 → 通用 `if (ha.activation?.kind === 'overlay')`，返回 `{ activation, onClick: () => openOverlayTab(ha.activation.tabId, sid) }`。`schedulerCard` 字段删除。
- `SchedulerQuickCard.vue` → 泛化为 `HeaderActionPreviewCard.vue`：props 改为 `{ sessionId, viewId, badge, disabled, tooltip, testid, footer? }`，内部只保留 hover/pin 状态机 + ViewHost + 可选底部动作条（`footer: { label, action: { kind: 'overlay'; tabId } }`）。
- hover 时序常量（160/240）从声明读取，缺省保持现值——scheduler 现行体感零回归。
- 谓词 `isVisibleHeaderAction` 改为「有 activation 或有 commandId」。
- `HEADER_ACTION_ICONS`（`:114-116`）是通用投影表，随 `icon` 声明扩展即可，不计本域固定点。

收益：L1-1/2/3/4/5/6/7 一次消除；L1-8 同步 SDK 类型后一并消除。代价：`PluginContributesHeaderAction` 双份定义必须同 commit 改（现状已漂移，`docs/plugins/architecture.md:268`）。

---

## 3 层 2：对话流行内呈现

### 3.1 现状

本层是全域最健康的一层，且**没有任何 scheduler 专属渲染代码**。三条通道：

(a) tool 调用与结果：走通用 `ToolRow`。

- 工具定义：`extensions/universal/scheduler/src/tool.ts`（`schedule` 与 `schedule_control` 两个工具）。
- 摘要：`tool.ts:156-180` 的 `withScheduleSummary` 往 `details.summary` 写一行摘要；宿主侧通用读取 `packages/ui/src/features/chat/ToolRow.vue:403-410`（`details.summary` 优先于按 input 派生摘要）。`schedule` 不在 `TOOL_ICON_MAP`（`packages/ui/src/features/chat/block-icon.ts:51-58`）内，图标落 `'tool-other'` 兜底——这是「未声明图标」的缺省，不是缺陷。
- TUI 渲染器 `renderResult`（`extensions/universal/scheduler/src/render-result.ts`，46 行）只在 TUI 生效，与 renderer 无关。

(b) 创建确认表单：走统一提问表单协议（`ui-form`）。

- 现行路径：`extensions/universal/scheduler/src/interaction.ts:166-175` 调 `uiFormInteract`，问题载荷 `[{ type: 'schedule', question: SCHEDULE_FORM_QUESTION, initial: draft }]`（`:168`），`expectTurn: false`（`:172`，命令路径提交后无 turn 跟随）。
- 协议定义：`packages/extension-protocol/src/extensions/ui-form/types.ts:61-68` `ScheduleQuestion`（`type: 'schedule'`，`initial?: ScheduleDraft`），属 `FormQuestion` 判别联合（`:71`）。`SCHEDULE_CREATE_MARKER` 值在同包 `scheduler-create/marker.ts:8`。
- runtime 翻译：`runtime/src/infra/pi/event-adapter.ts:1061-1069` 的 `MARKER_DIALOG_FALLBACKS` 表，`{ marker: SCHEDULE_CREATE_MARKER, translate: tryTranslateScheduleCreateSelect }`（`:1066`）；实现 `:915-934`（`isScheduleDraft` 校验后产 `form: true` + `scheduleCreate: true` + `scheduleDraft`）。
- 前端渲染：`packages/renderer/src/components/extension/form/FormOverlay.vue` 的 schedule 题型分支 `:289-304`（`<ScheduleForm>` 在 `:304`）；`ScheduleForm.vue` 494 行（once/recurring 双模式、cron 快捷、DateTimePicker、cron 预览、`canSubmit`/`submit` expose `:300`）。挂载源分流在 `Panel.vue:138-150`（`questions` 源 vs `draft` 源）。

(c) 到期通知：走 notify / custom 消息，无专属渲染。

- 派发：`extensions/universal/scheduler/src/backend.ts:57` 的 `sendMessage`（返回 void，投递结果无感知，已单独登记 [scheduler-result-awareness-channel.md](../scheduler-result-awareness-channel.md)）。
- 呈现：落 `SystemNotice.vue` 通用 display:true 分支（`packages/ui/src/features/chat/SystemNotice.vue:244` 注释点名 scheduler 派发提示同族同规格）。

(d) 附带事实：widget 推送（1 处，`widget.ts:151`）推的是**协议 widget**，进托盘 widget 区，不进对话流。

- 内容形状：`buildSchedulerWidgetGui`（`widget.ts:68-80`）= `guiResult(list-tree, meta{title,status,icon:'clock',badge})`；TUI 臂 `renderSchedulerWidgetTui`（`:34-56`）。
- 推送节流：指纹跳推（`computeTasksFingerprint` `:114-126`；`index.ts:341-364` `refreshWidget`；触发点 `index.ts:137` 每 tick 后 + `:181` session_start 首帧）。

### 3.2 固定点清单

| # | 固定点 | 文件:行 | 说明 |
|---|---|---|---|
| L2-1 | `ScheduleForm.vue` 494 行宿主专属表单渲染器 | `components/extension/form/ScheduleForm.vue:1-494` | 唯一实质固定点 |
| L2-2 | `FormQuestion` 的 `type: 'schedule'` 领域原语 | `extension-protocol/src/extensions/ui-form/types.ts:61-71` | 协议内置原语（本非插件贡献位） |
| L2-3 | `FormOverlay` schedule 题型分支 | `FormOverlay.vue:289-304`（另 `:98`、`:137-143`） | 约 18 行 + 提交门委托 |
| L2-4 | legacy `SCHEDULE_CREATE_MARKER` 翻译分支 | `event-adapter.ts:915-934` + 表项 `:1066` + `scheduler-create/*`（205 行） | legacy 窗口，注释自述随 D7 退役 |
| L2-5 | widget 推送键 `'scheduler'` | `extensions/universal/scheduler/src/widget.ts:151` | 字符串 key，非类型化 |
| L2-6 | 快照挂载自举缺口（overlay tab 用 `empty='hidden'`） | `WorkflowVizOverlay.vue:326` vs `SchedulerQuickCard.vue:80` | 拉取通道覆盖缺口 |

合计 6 个：1 个 494 行整表单、1 个协议原语（本不该插件化）、其余 4 个小分支/常量/缺口。

### 3.3 插件化改造方案

判断：**本层不需要插件化，需要的是把「原语内置」这一定位写清**。

- `type: 'schedule'` 与 `ScheduleQuestion` 的正确类比不是「插件贡献点」，而是 `tab-bar` / `action-bar` 那样的**协议内置领域原语**：任何 extension 都能发、宿主必须知道怎么渲染。它满足原语三判据——(1) 有多个潜在生产者（scheduler 的 `/schedule` 命令、任何想内联排期输入的扩展）；(2) 形状稳定可序列化；(3) 渲染需宿主能力（日期选择、cron 校验、locale 格式化）。
- 因此 L2-1/L2-2/L2-3 保持现状是正确的，只需在协议文档把它与「插件贡献点」区分（`ui-form/types.ts:56-60` 注释已说「时间输入领域原语（非 scheduler 专属形状）」，方向正确）。
- 可做的小改进：
  - L2-4 按注释承诺退役：`scheduler-create/types.ts:13-14` 自述「legacy 窗口语义…随 D7 窗口末清理退役」。退役后 `MARKER_DIALOG_FALLBACKS` 剩 3 项；`scheduler-create/` 205 行中 marker/helpers 可删，`ScheduleDraft`/`ScheduleFormResult` 类型被 `ui-form` 复用须保留。
  - L2-5 把 `'scheduler'` 变成插件内常量（与 `HEADER_ACTION_ID` 同处，`scheduler-manager/index.ts:76` 先例），避免与 `SCHEDULER_MODAL_VIEW_ID` 两个 id 语义混淆。
  - L2-6 补拉缺口：给 overlay tab 也用 `empty='placeholder'`，或在 `empty='hidden'` 时也触发一次 `refreshView`（`ViewHost.vue:58-59` 现在直接 return）。这是 ADR-0097 拉取通道的对称性修复。

---

## 4 层 3：drawer 一级 tab

### 4.1 现状

- 一级 tab 枚举：`packages/core/src/domain/drawer/types.ts:22` `RightDrawerTab = 'git' | 'doc' | 'detail' | 'subagent' | 'bashTask' | 'plan' | 'btw' | 'trace'`——**scheduler 不在其中**，且注释（`:15-21`）明确「workflow 不入本枚举（2026-10-19 用户裁决，drawer workflow tab 删除，唯一入口 = 浮层）」。
- 注册表：`packages/core/src/domain/drawer/registry.ts:156-165` 八条 `RIGHT_DRAWER_REGISTRY`；`:171` `OVERLAY_REGISTRY = [BROWSER_ENTRY, WORKFLOW_OVERLAY_ENTRY]`——scheduler 与 canvas **连浮层注册表都不在**（只有 2 条，而 `OverlayContentKind` 有 4 员；该不一致已登记 G5）。
- 渲染分支：`packages/renderer/src/components/workspace/PanelContainer.vue:146-176` 八条 `v-if/v-else-if`，与注册表一一对应（注释 `:140`）。
- `drawer.tab` 是**被提及但未注册**的挂载点：`bootstrap.ts:73-80` 只注册 5 个（`sidebar.tab` / `panel.header` / `composer.toolbar` / `provider.authorize` / `provider.detail-extra`），`drawer.tab` 仅出现在类型注释（`core/extension-host/types.ts:113`、`:156`，`plugin-sdk/src/types.ts:193`，`mount-point-registry.ts:6`）。

### 4.2 固定点清单

scheduler 在本层固定点 = **0**（既不声明、也不渲染、也不在枚举）。作为对照，本层对 scheduler 的隐性约束 2 处：

| # | 约束 | 位置 | 说明 |
|---|---|---|---|
| L3-1 | 一级 tab 枚举为封闭联合（新增必须改类型） | `core/domain/drawer/types.ts:22` | 本层插件化的总闸；对 scheduler 无直接影响 |
| L3-2 | `drawer.tab` 挂载点提名未注册 | `bootstrap.ts:73-80` 无该调用 | 一旦注册，插件才可能声明 drawer tab |

合计：0 个 scheduler 专属固定点，2 个域外约束。

### 4.3 判断：scheduler 该不该有 drawer tab

**不该，overlay 就是正确归属。** 三条依据：

1. 已有用户裁决先例：workflow 的 drawer tab 于 2026-10-19 删除，理由「浮层是唯一形态」（`core/domain/drawer/types.ts:16-18`，`registry.ts:13`/`:23`）。scheduler 与 workflow 同属「完整管理面板 + 会话级数据 + 单一打开入口」，形态应一致。
2. 交互密度：scheduler 主入口是 composer 左簇图标（常驻、带徽标、hover 即出面板）。drawer 需先开抽屉再切 tab，比 overlay 直开多一层；且 drawer 与对话流并排（宽度挤压），scheduler 的 stats-line + 每任务多行 + action-bar 需要宽面板。
3. 已有双入口共识：`openSchedulerTab` 与 `openCanvasTab` 是「同壳 tab 切换 + 独立 content kind 直达」的双入口先例（`workflow-viz-overlay.ts:135` 注释「对齐 openSchedulerTab 先例」，设计 §3.1(3) 明文要求两入口同态）。再加 drawer 就是第三态，违反同态。

结论：本层改造动作 = 无。但**应把 scheduler/canvas 补进 `OVERLAY_REGISTRY`**（现只有 browser/workflow 两条，`registry.ts:171`），否则浮层注册表与 `OverlayContentKind` 四员永远不一致，未来「tab 从注册表派生」的第 2 步会缺数据源（见 §5.3）。

---

## 5 层 4：overlay 一级 tab

### 5.1 现状

本域最关键的一层，也是「已跑通一半」的一层——**内容渲染已完全插件化，tab 位与 opener 完全写死**。

已插件化的部分（内容）：

- `WorkflowVizOverlay.vue:326`：`<ViewHost :view-id="SCHEDULER_MODAL_VIEW_ID" :scope="{ kind: 'session', sessionId: schedulerSessionId ?? '' }" empty="hidden" />`——一行，零业务语义。
- viewId 单源：`packages/extension-protocol/src/extensions/scheduler/types.ts:137` `SCHEDULER_MODAL_VIEW_ID = 'modal-scheduler-manager-scheduler-manager.panel'`；renderer 侧 re-export 保持导入路径（`workflow-viz-overlay.ts:74`）。双端同源防漂移（值沿用历史命名 `modal-<pluginId>-<modalId>`，modal 链已退役）。
- 生产者：`scheduler-manager/index.ts:497`。
- 数据链：见 §1.2，与 quick card / 托盘 widget 共用同一个 store。

写死的部分（容器）：

1. **tab 值域**：`workflow-viz-overlay.ts:63` `export type OverlayTab = 'runs' | 'scheduler' | 'canvas'`。
2. **tab 展示态**：`workflow-viz-overlay.ts:67` `export const overlayTab = ref<OverlayTab>('runs')`（`@data-owner` 豁免标注 `:65`；写方封闭集 = `openWorkflowVizOverlay` `:114` / `openSchedulerTab` `:127` / `openCanvasTab` `:140` / `setOverlayTab` `:147` / 关闭复位 watch `:80-86`）。
3. **tab 条分段**：`WorkflowVizOverlay.vue:428-432` `tabSegments` 三项字面量（label 走 i18n `panel.workflowViz.overlayTabRuns/Scheduler/Canvas`，icon 硬绑 `Workflow`/`Clock`/`Network`）；模板 `:142-164` 遍历渲染，禁用判据 `:156` `seg.value === 'runs' && run === null` 写死 runs 语义。
4. **标题三态**：`WorkflowVizOverlay.vue:65-71`（scheduler：`Clock` + i18n 标题）、`:72-78`（canvas）、`:79-136`（runs 六元素）。
5. **内容三态**：`:168`（runs）、`:308`（canvas）、`:319-327`（scheduler，`v-else` 兜底）。
6. **opener**：`core/domain/overlay/coordination.ts:67-69` `openSchedulerOverlay(sessionId)` → `openOverlay({ kind: 'scheduler', payload: { sessionId } })`；renderer 包装 `workflow-viz-overlay.ts:127-130` `openSchedulerTab`（core 换内容 + renderer 置 tab）。
7. **payload 类型**：`core/domain/overlay/types.ts:40-42` `SchedulerOverlayPayload { sessionId }`；并入判别联合 `:55-59`。
8. **内容 kind 词表**：`packages/shared/src/ipc-payloads.ts:289` `OverlayContentKind = 'browser' | 'workflow' | 'scheduler' | 'canvas'`（`OverlayKind` 派生别名 `overlay/types.ts:18`）。
9. **壳开合判定**：`WorkflowVizOverlayHost.vue:125` `isSchedulerOpen`、`:131` `isOverlayShellOpen`（三类任一）、`:135-139` `overlaySessionId`（canvas 无会话 → 空串）。
10. **会话删除级联**：`workflow-viz-overlay.ts:159-166` 显式列举 `kind === 'workflow' || kind === 'scheduler'`（`:162`）。
11. **opener 调用点唯一**：全仓 `openSchedulerTab` 只有一个生产调用（`SchedulerQuickCard.vue:209`）；`openSchedulerOverlay` 只被它间接调用（`workflow-viz-overlay.ts:128`）。即「打开 scheduler tab」能力当前只挂在 QuickCard 底部条上——headerAction 点击本身已不直开（2026-10-19 左簇浮层优化把点击改为 pin 面板，`SchedulerQuickCard.vue:19-27` 行为迁移说明）。

### 5.2 固定点清单

| # | 固定点 | 文件:行 | 性质 |
|---|---|---|---|
| L4-1 | `OverlayTab` 联合类型三值 | `workflow-viz-overlay.ts:63` | 类型层封闭枚举 |
| L4-2 | `overlayTab` ref 初值 `'runs'` | `workflow-viz-overlay.ts:67` | 默认 tab 写死 |
| L4-3 | `openSchedulerTab` 专用 opener | `workflow-viz-overlay.ts:127-130` | 每新增 tab 需 +1 函数 |
| L4-4 | 关闭复位 watch 归 `'runs'` | `workflow-viz-overlay.ts:80-86` | 复位目标写死 |
| L4-5 | `tabSegments` 三段字面量 | `WorkflowVizOverlay.vue:428-432` | label/icon/序写死 |
| L4-6 | tab 条模板 + runs 禁用判据 | `WorkflowVizOverlay.vue:142-164`（`:156`） | 容器语义（runs 是唯一「有数据才可进」的 tab） |
| L4-7 | 标题三态分支 | `WorkflowVizOverlay.vue:65-136` | 每 tab 一段模板 |
| L4-8 | 内容三态分支 | `WorkflowVizOverlay.vue:168`/`:308`/`:319-327` | 每 tab 一段模板 |
| L4-9 | `SchedulerOverlayPayload` | `core/domain/overlay/types.ts:40-42` | 每 tab 一个 payload 类型 |
| L4-10 | `OverlayContent` 判别联合加员 | `core/domain/overlay/types.ts:55-59` | 新增 kind 必须改 core 类型 |
| L4-11 | `openSchedulerOverlay` | `core/domain/overlay/coordination.ts:67-69` | 专用协调函数 |
| L4-12 | `isValidContent` 的 scheduler 分支 | `coordination.ts:22-24` | 校验分支写死 |
| L4-13 | `overlay/index.ts` 导出清单 | `core/domain/overlay/index.ts:19-27` | 每 opener 一条导出 |
| L4-14 | `OverlayContentKind` 四员 | `shared/src/ipc-payloads.ts:289` | 跨进程词表（browser:overlay-state IPC 契约四方共用） |
| L4-15 | 壳开合三类判定 | `WorkflowVizOverlayHost.vue:122-131` | `isWorkflowOpen`/`isSchedulerOpen`/`isCanvasOpen` + OR |
| L4-16 | `overlaySessionId` 派生（canvas 特判） | `WorkflowVizOverlayHost.vue:135-139` | 会话归属派生 |
| L4-17 | 会话删除级联 kind 枚举 | `workflow-viz-overlay.ts:159-166` | 条件式关闭 |
| L4-18 | `OVERLAY_REGISTRY` 只有 2 条（缺 scheduler/canvas） | `core/domain/drawer/registry.ts:171` | 注册表与词表不一致（G5） |

合计 18 个固定点，其中 L4-1~L4-14 与 L4-18 构成「新增一个 overlay tab 必须改的 6 文件改动链」：`shared 词表 → core 类型 → core 协调 → core barrel → renderer 控制器 → renderer 壳模板 → renderer 壳宿主 → renderer 交互组件`（runtime 广播层无需改）。

### 5.3 插件化改造方案

关键判断：本层分界线非常清楚——**`<ViewHost>` 那一行是终态，其余 18 个固定点全是「容器不知道 tab 从哪来」的补偿**。所以改造不是重写，而是把 tab 的来源从「联合类型常量」换成「声明 + 注册表」。

设计要点四条：

1. **tab 身份 = `(ownerPluginId, tabId)`，显示元信息由声明提供**。类比 `contributes.views[]`（`placement` 为开放字符串，`bootstrap.ts:73-80` 注册制）。新增挂载点 `'overlay.tab'`：

```jsonc
// manifest 片段（插件侧）
"contributes": {
  "views": [{
    "id": "scheduler.panel",
    "title": "定时任务",
    "placement": "overlay.tab",
    "viewType": "gui",
    "icon": "clock",          // lucide 名，宿主解析（与 headerAction.icon 同机制）
    "order": 20,
    "initialVisibility": "hidden"
  }]
}
```

配套新增可选字段（`PluginContributesView`，`core/extension-host/types.ts:152-161`）：`icon?: string`、`order?: number`、`openableWithoutEmptyState?: boolean`（对应 runs tab「无 run 禁用」语义，改成**插件自报**而非宿主写死）。

2. **`OverlayTab` 退化为 `string`，tab 列表从注册表派生**：
   - `workflow-viz-overlay.ts:63` → `export type OverlayTab = string`（或删除该类型，直接用 viewId）。
   - `tabSegments`（`WorkflowVizOverlay.vue:428-432`）→ `computed(() => registry.getContributions({ placement: 'overlay.tab' }).map(...))`，label 用声明 `title`，icon 走 `HEADER_ACTION_ICONS` 同款映射表。
   - `overlayTab` 默认值从 `'runs'` 改为「注册表首项」或「最近打开的 tab」（需一处裁决）。
   - 关闭复位（`:80-86`）保留「归首项」语义，不再写 `'runs'`。

3. **标题与内容分支收敛为两条通用路径**：
   - 标题：`icon + title` 两元素（scheduler/canvas 已是该形态，`WorkflowVizOverlay.vue:65-78`）。runs 的六元素是 workflow 自己的 header，应迁成 workflow 内容层的一部分，或声明 `headerSlot` 类型（属 workflow 域的事；本域只需保证通用路径能表达 scheduler 当前形态——能，2 元素足够）。
   - 内容：`<ViewHost :view-id="activeTab.viewId" :scope="{kind:'session', sessionId}" />` 单条。runs 例外（DAG + dock slot）需保留内置内容后门，建议 `kind: 'builtin' | 'view'` 显式区分，**不要**继续用 `v-else` 兜底。
   - 危险点：`v-else` 兜底（`:319`）现在是 scheduler；改造后若渲染分支写错，scheduler 会被「最后一个 else」意外接住。改造时必须把三态显式化。

4. **payload 与 opener 泛化**：
   - `SchedulerOverlayPayload`（L4-9）/`CanvasOverlayPayload`/`WorkflowOverlayPayload` 三者形状已收敛为 `{ sessionId } | { sessionId, runId } | { canvasId, sessionId }`。泛化形态 = `{ tabId: string; sessionId: string; params?: Record<string, string> }` 单型，原三型退化为别名（保留兼容，避免一次改太多消费方）。
   - `openSchedulerOverlay` / `openCanvasOverlay`（L4-11）→ `openOverlayTab(tabId, sessionId, params?)` 单函数；`isValidContent`（L4-12）简化为「tabId 在注册表中 + sessionId 非空」。
   - `OverlayContentKind`（L4-14）是 `browser:overlay-state` IPC 契约四方共用词表，**建议保留四员不动**（它是主进程显示收尾谓词的事实源，泛化收益低、风险高），只在 renderer 侧把 `kind` 当 `tabId` 用。

预期结果：新增第三个插件 tab 的改动面从 6 文件 18 点降到 **1 处 manifest 声明 + 0 行宿主代码**（前置条件：L4-1~L4-14 完成）。

### 5.4 已插件化 / 写死的边界（一句话总结）

| 关注点 | 归属 | 结论 |
|---|---|---|
| 树的内容与结构（stats-line/list-tree/action-bar） | 插件（`scheduler-manager`） | 已完成，宿主零语义 |
| 树的分区键（per-session） | 通用基建（ViewHostStore + scope） | 已完成 |
| 树的推送与丢失收敛 | 通用基建（transient 推送 + snapshot 拉取） | 已完成（overlay tab 有一处 `empty='hidden'` 缺补拉） |
| tab 的存在、名称、图标、顺序 | 宿主联合类型 + 模板常量 | 待泛化（18 点） |
| 打开动作的寻址（opener） | 宿主专用函数 | 待泛化（1 函数 → 1 通用函数） |
| headerAction 点击落到哪个 tab | 宿主 if 分支 + 域字面量 | 待泛化（§2.3） |

---

## 6 规模统计

### 6.1 各层代码行数（`wc -l` 实测）

层 1（composer 入口）：

| 文件 | 行数 | scheduler 命中行 |
|---|---|---|
| `packages/renderer/src/components/extension/SchedulerQuickCard.vue` | 213 | 全文件（宿主专属） |
| `packages/renderer/src/components/extension/HeaderActionsHost.vue` | 288 | 15 |
| `packages/core/src/extension-host/builtin-contributions.ts` | 81 | 16 |
| `packages/core/src/extension-host/types.ts` | 263 | 6 |
| `packages/core/src/extension-host/header-action-store.ts` | 129 | 0（通用） |
| `packages/renderer/src/composables/shell/useExtensionHostBridge.ts` | 593 | 2 |
| `packages/plugin-sdk/src/types.ts` | 908 | 0（缺 activation，属缺失而非固定点） |

层 2（对话流行内）：

| 文件 | 行数 | 说明 |
|---|---|---|
| `packages/renderer/src/components/extension/form/ScheduleForm.vue` | 494 | 宿主专属表单 |
| `packages/renderer/src/components/extension/form/FormOverlay.vue` | 344 | 34 行 schedule 命中 |
| `packages/extension-protocol/src/extensions/scheduler-create/types.ts` | 62 | Draft / FormResult 形状 |
| `packages/extension-protocol/src/extensions/scheduler-create/helpers.ts` | 135 | 校验/序列化 |
| `packages/extension-protocol/src/extensions/scheduler-create/marker.ts` | 8 | legacy marker |
| `packages/extension-protocol/src/extensions/ui-form/types.ts` | 85 | `ScheduleQuestion` 原语（`:61-68`） |
| `extensions/universal/scheduler/src/interaction.ts` | 304 | `uiFormInteract` 调用 |
| `extensions/universal/scheduler/src/tool.ts` | 224 | 工具定义 + summary |
| `extensions/universal/scheduler/src/render-result.ts` | 46 | TUI renderResult |
| `extensions/universal/scheduler/src/commands.ts` | 241 | `/schedule` 注册 |
| `extensions/universal/scheduler/src/widget.ts` | 152 | 协议 widget 推送 |
| `packages/runtime/src/infra/pi/event-adapter.ts` | 2099 | 15 行命中（legacy marker 分支） |

层 3（drawer）：scheduler 专属 0 文件 0 行。域外约束 2 处（`core/domain/drawer/types.ts` 45 行、`registry.ts` 178 行）。

层 4（overlay）：

| 文件 | 行数 | scheduler 命中行 |
|---|---|---|
| `packages/renderer/src/components/panel/workflow-viz/overlay/WorkflowVizOverlay.vue` | 588 | 24 |
| `packages/renderer/src/components/panel/workflow-viz/overlay/WorkflowVizOverlayHost.vue` | 307 | 15 |
| `packages/renderer/src/components/panel/workflow-viz/overlay/workflow-viz-overlay.ts` | 227 | 18 |
| `packages/core/src/domain/overlay/types.ts` | 86 | 8 |
| `packages/core/src/domain/overlay/coordination.ts` | 111 | 8 |
| `packages/core/src/domain/drawer/registry.ts` | 178 | 0（缺 scheduler 两条） |
| `packages/shared/src/ipc-payloads.ts` | — | 1（词表 `:289`） |

数据与扩展侧：

| 单元 | 行数 | 文件数 |
|---|---|---|
| `extensions/universal/scheduler/src/`（生产） | 5393 | 19 |
| `extensions/universal/scheduler/src/__tests__/` | 7543 | 29 |
| `resources/plugins/scheduler-manager/index.ts` | 706 | 1 |
| `resources/plugins/scheduler-manager/__tests__/index.test.ts` | 925 | 1 |

### 6.2 相关文件计数

`grep -rl` 生产文件（排除 `__tests__` / `.test.` / `vitest.config`）：

| 包 | 命中 scheduler 的生产文件数 |
|---|---|
| `packages/renderer/src` | 17 |
| `packages/core/src` | 6 |
| `packages/runtime/src` | 10 |
| `packages/ui/src` | 6 |
| `packages/extension-protocol/src` | 10 |
| `packages/shared/src` | 3 |
| `extensions/universal/scheduler/src` | 12 |
| `resources/plugins/scheduler-manager` | 1 |

全仓（含测试与脚本）文件命中数 = 125；生产口径 = 66（含跨域词形误命中，如 `terminal-service.ts` 的 "scheduled" 词、`useTurnElapsed.ts` 的 `scheduleTick` 函数名，不属本域）。

### 6.3 固定点汇总

| 层 | 固定点数量 | 「整组件/整文件」级 | 「单点」级 |
|---|---|---|---|
| 层 1 composer 入口 | 8 | 2（QuickCard 213 行、专属分支 15 行） | 6 |
| 层 2 对话流行内 | 6 | 1（ScheduleForm 494 行） | 5 |
| 层 3 drawer | 0（域外约束 2） | 0 | 0 |
| 层 4 overlay | 18 | 0（全是分支/类型/常量单点） | 18 |
| **合计** | **32** | **3** | **29** |

---

## 7 改造方案与依赖

### 7.1 GuiComponent 原语表达力评估

逐项对照 scheduler 面板真实需求（`scheduler-manager/index.ts:199-222` 的 `buildModalTree`，原语定义 = `packages/extension-protocol/src/core/types.ts:36-141`）：

| 需求 | 现值 | 原语够用 | 说明 |
|---|---|---|---|
| 统计行（启用/停用/共 N 上限 M） | `stats-line`（`index.ts:200-211`） | 够 | 已在用 |
| 每任务多行（名称 / 排期 / 执行次数 / 失败原因） | `list-tree` 嵌套 depth（`buildTaskRows` `:148-169`） | 够 | 已在用 |
| 行内三操作（暂停恢复 / 立即执行 / 删除） | `action-bar`（`buildTaskActions` `:171-184`） | 够 | `kind: 'danger'` 已覆盖删除；`args` 标量约束足够（id/enabled 都是标量） |
| 空态文案 | `ansi-text`（`:212`、`:221`） | 够但弱 | 只有一行文本，无「空态 + 行动按钮」组合原语；现用 `ansi-text` + 插件侧文案拼接 |
| 行内操作回执 notice | `ansi-text` 单行（`:474-495` notice 通道） | 够但弱 | 位置固定在列表尾部，无法就近挂到某任务行 |
| 暂停态视觉区分 | list-tree 行文本前缀（`已停用`） | 够但弱 | 无 `badge` / `tone` 行内原语，只能内联文字 |
| 分组（启用在前 / 停用在后） | 排序后在同一个 list-tree 序列里 | 够但弱 | 无 collapse / 分组头原语，插件用排序模拟 |
| overlay 一级 tab 条 | 不适用（宿主画） | **不够** | `tab-bar` 原语（`core/types.ts:86-95`）有 `tabs` + `sections` 且 `sections` 已支持容器化子树，但它的语义是「**面板内**二级分段」，不是「浮层壳的一级 tab」（后者需驱动 `overlayTab` 受控 prop + 壳标题栏）。若想用 `tab-bar` 表达一级 tab，需把整个浮层壳改成插件推树——方向相反，不建议 |
| 会话/作用域上下文 | ViewHost `scope` prop | 够 | 已解决（`ViewHost.vue:33`，`{kind:'session',sessionId}`） |
| 写操作执行 | `action-bar` + `ACTION_EXECUTOR_KEY` | 够 | 已闭环（`useExtensionHostBridge.ts:559-567` + `Actionbar.vue:36`） |

结论：**业务内容侧原语完全够用（scheduler 全树只用 3 种原语：stats-line / list-tree / action-bar / ansi-text）**，缺口全在容器侧：

1. 缺「overlay 一级 tab 的声明原语」——不是 GuiComponent 的问题，是 `contributes` 缺 `overlay.tab` 这类挂载点（当前 `placement` 词表里连名字都没有）。
2. 缺「行内操作就近回执」的弱能力（notice 只能全树级）。这不是改造阻塞项，属体验优化，可延后。
3. `tab-bar` 已有容器化 `sections`（`core/types.ts:88-94`，`packages/ui/src/rendering-protocol/primitives/TabBar.vue:20-40` 有完整降级链），可作为「面板内二级 tab」的现成方案；但**不要**拿它替代浮层一级 tab。

### 7.2 需 runtime 配合的点

| # | 需求 | 现状 | 工作量 |
|---|---|---|---|
| R-1 | `plugin:viewUpdate` 支持任意 viewId（不限于声明过的） | 已支持：`views-api.ts:80` 只做 `asSafeKey`（白名单排除路径分隔符），`message-bus-bridge.ts:209` 只要求非空字符串 | 无 |
| R-2 | `plugin.ui.snapshot` 单分区补拉 | 已支持：`transport/plugin-message-handler.ts:172-177` 支持 `sessionId` / `viewId` 过滤 | 无 |
| R-3 | 快照清理链覆盖新 tab | 已有五处（会话销毁 / crash / 禁用 / 卸载 / 重启用），见 `data-source-registry.md` #73 行 | 无 |
| R-4 | 若 overlay tab 声明走 `contributes.views[]`，需把外部插件的 `contributes` 透传到 renderer | **未闭环**：`loadExternal([])` 恒空（`bootstrap.ts:92`），`PluginInfo` 不含 `contributes`（G1）。这是全插件化的前置阻断项，scheduler 本身走 builtin 静态表不受影响 | 大（G1 修复面） |

结论：**scheduler 域的 overlay tab 泛化不需要 runtime 改动**（4 条里 3 条已满足，R-4 只影响 external 插件，不影响 builtin）。这是本域改造风险最低的重要原因。

### 7.3 需 pi extension 配合的点

| # | 需求 | 现状 | 工作量 |
|---|---|---|---|
| E-1 | 树的形状不需要 extension 改（已由 `scheduler-manager` 插件产） | 已完成 | 无 |
| E-2 | 若把 headerAction 预览也改为插件自报（如预览用哪种原语） | `pi-scheduler` 与 `scheduler-manager` 都不需要改：预览内容就是同一棵 `SCHEDULER_MODAL_VIEW_ID` 树 | 无 |
| E-3 | widget 双通道裁决（是否停推协议 widget） | 现状 `widget.ts:151` 推 key='scheduler'；若裁决停止，只删 `setSchedulerWidget` 调用点 + `widget.ts` 152 行（`index.ts:29` 的 import、`:137`/`:181` 的触发点） | 小 |
| E-4 | legacy `SCHEDULE_CREATE_MARKER` 退役 | 现由 `scheduler-create/` 承载；新路径（`uiFormInteract`）已上线。退役 = 删 marker + helpers + event-adapter 表项 `:1066` + `tryTranslateScheduleCreateSelect` `:915-934` | 小 |
| E-5 | tab 图标/名称为中文硬编码问题 | 声明里 `title: '定时任务'`（`builtin-contributions.ts:59`）是中文硬编码；i18n 化需要声明支持 i18n key（当前 `title` 只能是字符串）。同类问题在 `overlayTabScheduler` i18n key（`renderer/src/i18n/locales/zh-CN/workflow-viz.ts:21`）已存在 | 小（声明加 `titleKey?` 或宿主侧映射） |

结论：**pi extension 侧零阻塞**。E-3/E-4 是可选的清理项，E-5 是声明层的 i18n 缺口（与 tab 泛化同批处理最省事）。

### 7.4 风险与不可行项

| # | 风险 | 判断 |
|---|---|---|
| X-1 | 把 `OverlayTab` 改成 `string` 会丢失编译期穷尽检查 | 可控：把穷尽性从「类型联合」换成「注册表 + 运行时校验（tabId 不在注册表 → no-op + warn）」。`overlayTab` 已是 `ref`，写入口仅 4 个函数（L4-2 注释），收敛成本低 |
| X-2 | `v-else` 兜底（`WorkflowVizOverlay.vue:319`）在改造期会静默接住错误分支 | 必须改成显式三态（`v-if`/`v-else-if`/`v-else-if` + 最终 `v-else` 报错占位），并补一条「未知 tabId → 空态而非 scheduler」的测试 |
| X-3 | `OverlayContentKind` 是跨进程词表（`browser:overlay-state` IPC 四方共用），改它会波及 main 进程显示谓词 | **不建议改**（见 §5.3 第 4 条）。保留四员，renderer 内部用 tabId |
| X-4 | headerAction 的 `activation` 与 `PluginContributesView.activationEvent` 语义易混 | 现有注释已显式区分（`core/extension-host/types.ts:219`）。改造时命名建议 `activation`（点击行为）vs `activationEvent`（懒激活时机）保持，不复用 |
| X-5 | 第三方插件声明 `overlay.tab` 后，其 `views.update` 树能否到达 renderer | 受 G1 阻断（external `contributes` 无通路）。**当前只对 builtin 插件成立**；external 插件需要 G1 修复。因此第 2 步应先落 builtin 路径（scheduler/canvas 迁过去即可验证），再做 G1 |
| X-6 | QuickCard 泛化后 hover 时序（160/240ms）若改由声明控制，可能出现「插件写 0 导致闪现」 | 声明侧下限校验（如 `openDelayMs >= 50`），或用「缺省值 + 只有显式声明才覆盖」策略，不做插件自由配置 |
| X-7 | 双通道（headerAction + widget）在泛化后仍并存 | 不是改造阻塞项，但会让「同一能力两处入口」长期存在。建议在第 3 步同批裁决（停 widget 通道或明确两者定位差异） |
| X-8 | 不可行项：把浮层一级 tab 条改为 `tab-bar` GuiComponent 原语由插件推 | 不可行且不必要。一级 tab 需要驱动壳的受控 prop（`overlayTab`）+ 标题栏 slot，属于壳层契约而非内容树；GuiComponent 是内容层的可序列化镜像（`core/types.ts:1-11` 定位），越界使用会把壳的焦点陷阱/关闭通道/会话级联一起搬进插件 |

---

## 8 可执行改造步骤（有序）

目标：把 `activation='scheduler-overlay'` 特例泛化成通用机制，让任意插件都能声明「点击我的 headerAction 打开我的 overlay tab」。按「每步独立可验收、可回滚」排序。

### 步骤 1：契约层统一（无行为变化，纯类型）

- [ ] `packages/plugin-sdk/src/types.ts:252-259` 的 `PluginContributesHeaderAction` 补齐 `activation?`，字段形状与 core 版（`core/extension-host/types.ts:205-221`）逐字一致；`commandId` 改可选。
- [ ] 两处 `activation` 从 `'scheduler-overlay'` 字面量改结构化（`{ kind: 'overlay'; tabId; viewId; preview? }`），保留 `'scheduler-overlay'` 作为**迁移期联合成员**（一次性兼容，下个版本删）。
- [ ] `packages/core/src/extension-host/contribution-registry.ts:124-137` 的 `parseHeaderActionContributions` 透传结构（当前已整段透传 `h.activation`，只需类型放宽）。
- 验收：`pnpm extensions:typecheck` + `packages/core` 单测（`contribution-registry.test.ts:314-341` 现有 AP-1d 断言需同步改）+ `packages/plugin-sdk` 类型测试。
- 回滚点：只改类型，运行期行为由步骤 3 才切换。

### 步骤 2：注册 overlay.tab 挂载点 + 声明

- [ ] `packages/core/src/bootstrap.ts:73-80` 增 `mountRegistryImpl.register('overlay.tab')`。
- [ ] `packages/core/src/domain/drawer/registry.ts:171` 的 `OVERLAY_REGISTRY` 补 scheduler / canvas 两条（先补数据，不改渲染，纯消除 G5 不一致）。
- [ ] 在 `builtin-contributions.ts` 增 `scheduler.panel` 的 view 声明（`placement: 'overlay.tab'`，`icon: 'clock'`，`order: 20`），与现有 `scheduler-manager` 条目并列。
- [ ] `PluginContributesView`（`core/extension-host/types.ts:152-161`）补 `icon?` / `order?` / `openableWithoutEmptyState?` 三个可选字段。
- 验收：`node scripts/validate-constraints.mjs` + `core/domain/drawer/__tests__/registry.test.ts`（现有断言 `OVERLAY_REGISTRY` 长度 2，`registry.test.ts:58`，需同步改）+ `core/extension-host/__tests__/contribution-registry.test.ts`。
- 回滚点：新挂载点无消费方时为零行为变化（`MountPointRegistry.register` 仅登记）。

### 步骤 3：渲染端通用分派（headerAction）

- [ ] `HeaderActionsHost.vue:233-247` 的 `activation === 'scheduler-overlay'` 分支 → `activation?.kind === 'overlay'` 通用分支，`onClick` 改为调用 `openOverlayTab(activation.tabId, sid)`（步骤 4 提供）。
- [ ] 删除 `HeaderActionButtonView.schedulerCard`（`:131`、`:244`、`:260`）与模板分支（`:39-46`），改为 `b.preview` 存在时渲染通用预览卡。
- [ ] 迁移期保留旧字面量处理：`activation === 'scheduler-overlay'` → 内部归一为 `{ kind:'overlay', tabId:'scheduler', viewId: SCHEDULER_MODAL_VIEW_ID }`（一处映射函数，下版删）。
- [ ] `useExtensionHostBridge.ts:268` 的可见性谓词改为「有 activation 或有 commandId」。
- 验收：`packages/renderer/src/__tests__/components/extension/HeaderActionsHost.test.ts`（现 415 行，`:330-365` 的 activation 分派用例需重写为「结构化 activation」形态）+ `composer-tray.test.ts:1266-1275`（聚合段 HeaderActionsHost 真组件渲染）。
- 回滚点：单文件 + 单谓词，git revert 干净。

### 步骤 4：overlay opener 泛化

- [ ] `core/domain/overlay/coordination.ts` 增 `openOverlayTab(tabId, sessionId, params?)`；`openSchedulerOverlay` / `openCanvasOverlay` 改为它的薄壳（保留导出，避免一次改所有调用点）。
- [ ] `core/domain/overlay/types.ts:40-42` 的 `SchedulerOverlayPayload` 改为 `OverlayTabPayload { tabId; sessionId; params? }` 的别名（保留原导出名）。
- [ ] `coordination.ts:22-24` 的 `isValidContent` 改为「tabId 非空 + sessionId 非空」（scheduler 分支保留兼容）。
- [ ] `core/domain/overlay/index.ts:19-27` 补 `openOverlayTab` 导出。
- 验收：`core/domain/overlay/__tests__/coordination.test.ts`（现有 scheduler 用例保持绿）+ `types.test.ts`。
- 回滚点：旧函数为薄壳，调用方零改动即可回退。

### 步骤 5：浮层壳 tab 从注册表派生

- [ ] `workflow-viz-overlay.ts:63` 的 `OverlayTab` 改 `string`；`:67` 的初值改「注册表首项」（保留 `'runs'` 作为内置项 id，不改行为）。
- [ ] `WorkflowVizOverlay.vue:428-432` 的 `tabSegments` → 从 `ContributionRegistry.getContributions({ placement: 'overlay.tab' })` 派生 + 内置 `runs` 恒在首位（内置项排序权重最高）。
- [ ] 标题分支（`:65-136`）收敛：通用路径 = `icon + title`；`runs` 保留为 `kind:'builtin'` 的特例分支（用显式 `v-else-if="tab === 'runs'"` 而非 `v-else`）。
- [ ] 内容分支（`:168`/`:308`/`:319-327`）收敛：`kind:'view'` → 单条 `<ViewHost :view-id="activeTab.viewId">`；`runs` → 内置分支；未知 tabId → 空态占位（禁止 `v-else` 兜底到 scheduler）。
- [ ] `WorkflowVizOverlayHost.vue:122-131` 的三类 `isXxxOpen` → 单条 `isOverlayShellOpen`（由 tab 注册表 + core `isOpen` 派生，不再列举 kind）；`:135-139` 的 `overlaySessionId` 从 payload 统一取 `sessionId`（canvas 的 canvasId 迁入 `params`）。
- [ ] `workflow-viz-overlay.ts:159-166` 的会话删除级联从「kind 列举」改为「payload.sessionId 等值判定」（对全部 tab 通用，语义等价且不再漏新增 tab）。
- 验收：`workflow-viz-overlay.test.ts`（553 行，`:170`/`:424`/`:440`/`:454`/`:460` 均涉及 scheduler tab）+ `workflow-viz-overlay-host.test.ts`（732 行，`:551`/`:557` 断言 `overlayTab.value === 'scheduler'`）+ `canvas.test.ts:225-226`（其他 overlay 打开时不抢焦点，遍历 kind 列表需改为遍历注册表）。
- 回滚点：步骤 5 是最大的一步，建议单独 commit；`runs` 保留显式分支后行为不变（禁用判据 `:156` 改为声明字段 `openableWithoutEmptyState` 读取，先对 runs 硬编码保持，后续再迁）。

### 步骤 6（可选）：headerAction 预览面泛化

- [ ] `SchedulerQuickCard.vue` → `HeaderActionPreviewCard.vue`，props 去域化（`viewId` 替代内部 import 的 `SCHEDULER_MODAL_VIEW_ID`）。
- [ ] 底部动作条改声明字段（`activation.preview.footer: { label; action: { kind:'overlay'; tabId } }`），i18n key 由声明提供。
- [ ] `HeaderActionsHost.vue:39-46` 的模板分支改 `v-if="b.preview"`；`HEADER_ACTION_ICONS` 映射表随 `icon` 扩展（scheduler 只需 `clock`，已有）。
- 验收：`SchedulerQuickCard.test.ts`（185 行，需整体重写为通用组件测试 + 一条 scheduler 配置的集成用例）；`scheduler-quick-anchor` / `scheduler-quick-panel` / `scheduler-quick-open-overlay` 三个 testid 需同步改名（或保留 alias 避免 e2e 破碎；`docs/testing/` 未登记这三个 testid，实测 grep 仅测试文件内引用）。
- 回滚点：独立组件 + 独立模板分支。

### 步骤 7（可选，清理）：widget 双通道裁决 + legacy marker 退役

- [ ] 裁决 `widget.ts:151` 的协议 widget 是否保留（若停：删 `setSchedulerWidget` 调用 + `widget.ts` 152 行 + `index.ts:29/137/181` 触发点；同步删 `docs/architecture/data-source-registry.md` #40 行的 scheduler 举例，需按 C-proc-10 同 commit 回写）。
- [ ] 退役 `SCHEDULE_CREATE_MARKER`：删 `scheduler-create/marker.ts` + `helpers.ts` + `event-adapter.ts:915-934`/`:1066` + `FormOverlay` 的 draft 源分支（`Panel.vue:145-149`）；保留 `types.ts`（被 `ui-form` 复用）。
- 验收：`runtime/test/event-adapter-schedule-create.test.ts`（210 行）随删除一并移除；`renderer/src/__tests__/panel/schedule-create-inline.test.ts` 同步清理；`node scripts/select-affected-e2e.mjs --base main` 确认 `SCHED` 域（`scripts/verify-scheduler-e2e.cjs`）是否需要跟改。

### 步骤依赖关系

```
步骤 1（契约）
   ↓
步骤 2（挂载点+声明）──┐
   ↓                  │
步骤 3（headerAction 分派）← 步骤 4（opener 泛化）
   ↓                  ↓
步骤 6（预览面，可选）  步骤 5（壳 tab 派生）
                        ↓
                    步骤 7（清理，可选）
```

- 步骤 1 必须先做（否则步骤 3 无类型可用）。
- 步骤 4 与步骤 3 可并行（都只依赖步骤 1）。
- 步骤 5 必须在步骤 2 + 步骤 4 之后（需要注册表数据 + 通用 opener）。
- 步骤 6 / 7 可延后，不阻塞主链。

### 每步的最小验收集（回归防线）

| 步骤 | 必跑测试 |
|---|---|
| 1 | `packages/core` `contribution-registry.test.ts`；`pnpm extensions:typecheck` |
| 2 | `packages/core` `drawer/__tests__/registry.test.ts`、`extension-host/__tests__/contribution-registry.test.ts` |
| 3 | `packages/renderer` `HeaderActionsHost.test.ts`、`composer-tray.test.ts`、`composer-bar-density-wiring.test.ts` |
| 4 | `packages/core` `domain/overlay/__tests__/{coordination,types}.test.ts` |
| 5 | `workflow-viz-overlay.test.ts`、`workflow-viz-overlay-host.test.ts`、`canvas.test.ts`、`SchedulerQuickCard.test.ts` |
| 6 | `SchedulerQuickCard.test.ts`（重写）、`composer-tray.test.ts` |
| 7 | `runtime/test/event-adapter-schedule-create.test.ts`（删）、`schedule-create-inline.test.ts`（删）、`resources/plugins/scheduler-manager/__tests__/index.test.ts`（925 行，写路径不受影响但需确认） |

e2e 影响面（按 `docs/testing/e2e-map.json` 的 SCHED 域登记）：`scripts/verify-scheduler-e2e.cjs`（真实 pi 进程 + faux LLM，S1-S23 契约）只覆盖 extension 侧创建/持久化路径，**不涉及 renderer tab 结构**。步骤 3/5/6 属 renderer 容器改造，理论不影响该 e2e；但 `SCHED` 域登记了 `extensions/universal/scheduler/**` 与 `scripts/verify-scheduler-e2e.cjs` 的触发路径，改 `extensions/` 时（步骤 7）需按改动范围跑一次。

---

## 附：一句话回答「scheduler 距完全插件化还差什么」

数据链路、内容原语、写操作执行器三件已完成且是全仓样板；缺的是**容器层的三处「宿主知道 scheduler 这个词」**——`activation` 字面量、`OverlayTab` 联合成员、`SchedulerQuickCard` 专属组件。把这三处换成「结构化声明 + 注册表派生」，新增同类能力从「改 6 文件 18 点」变成「写 1 处 manifest」。
