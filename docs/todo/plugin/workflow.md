# workflow 域全链路现状分析

状态：分析完成（2026-10-24；待裁决）

`docs/todo/plugin-pluginization.md` 分域分析之 workflow 分册。逐层实测锚点，判定每个「固定点」性质，给原语表达力评估与有序步骤。行号均为本分支实测。

## 0 结论摘要

1. **workflow 是四层里唯一零插件化的域**：todo/goal 走「插件推树 + ViewHost」（`extensions/universal/todo/src/index.ts:52-59` → `packages/ui/src/extension-host/ViewHost.vue:72-78`）；scheduler 的 overlay tab 也已是「插件推树 + ViewHost」（`resources/plugins/scheduler-manager/index.ts:497` → `workflow-viz/overlay/WorkflowVizOverlay.vue:326`）。workflow 全链路 0 处插件渲染；`workflow-viz/` 25 个生产文件 4814 行 + 托盘 4 文件 1065 行 + store 624 行全为宿主专属。
2. **半成品对照样本已存在，tab 位障碍已消解（容器统一批次 743f82e6f）**：`OverlayTab` 已开放为 `string` + `isKnownOverlayTab` 已知值判别（`workflow-viz/overlay/workflow-viz-overlay.ts:68`/`:74`——容器 tab 位一律开放，派生视图可产出非内置 tab 位）；三个内置 tab 中只有 scheduler 内容是插件树，另两段宿主专属。缺的只剩内容替换——而 runs 的内容（DAG/甘特）恰是原语表达不了的（§7.1）。
3. **数据面已完全插件化，渲染面完全没有**：run 状态/事件流/成员表全由 `pi-subagent-workflow` 产出（`host/journal-reporter.ts:156` → `runtime/src/infra/pi/event-adapter.ts:2057` → `services/session/session-records.ts:936` → `stores/workflow.ts:519`）。**零处需要新增协议**，改造是纯消费侧重排。
4. **对话流的 plugin 通道是空的**：`WORKFLOW_TOOL_NAMES`（`shared/src/constants.ts:47-52`）四名被 pi 侧明示不构造 `__gui__`（`interface/tool/tool-workflow.ts:328`/`:404`、`tool-subagents.ts:30`），宿主按名硬编码路由 `WorkflowRow.vue`（132 行）。同包 `workflow-script` 却正常产树（`tool-workflow-script.ts:278`）——同包两策略并存。
5. **drawer 裁决是最重要约束**：2026-10-19「浮层是唯一形态」（commit `3ee709342` 删 `WorkflowTab.vue` 395 行 + 2 测试文件 + `selection/workflow.ts` 47 行）。**并非所有功能都该有 drawer tab**，插件化不应做成「每域补一个 tab」。
6. **两处残留/漂移均已清理**：① `panel/__tests__/SubagentTab.degraded.test.ts`（含 mock 已删 `openWorkflowInDrawer` 的死 mock）已随测试合并批次 c2422d971 整文件删除；② `e2e/workflow-viz-overlay.spec.ts` OV3/OV5 的 `l2-tab-agent:*` 断言已改写为 `wf-viz-agent-drawer-tab-*`（agent 钻取现经页面级 agent 抽屉承载，2026-10-19 起 agent 内容移入 `AgentStreamDrawer`），`e2e/` 全目录 `l2-tab-agent` 零命中。

## 1 数据链路全景

### 1.1 状态/列表链（journal → 派生视图 → 增量信号 → 全量重拉）

| # | 跳 | 锚点 |
|---|---|---|
| 1 | journal 落盘 | `subagent-core/src/execution/persistence/run-event-journal.ts`；`RUN_EVENTS_SUFFIX=".record.jsonl"`（`shared/src/run-vocabulary.ts:135`）；路径 `<dataDir>/ext-sessions/<rootSid>/workflow/runs/<runId>.record.jsonl`（`shared/src/paths.ts:384`） |
| 2 | 壳推送 | `extensions/universal/subagent-workflow/src/host/journal-reporter.ts:156` `callMarkerRpc(guiCtx, SUBAGENT_JOURNAL_MARKER, …)` |
| 3 | runtime 旁路 | `runtime/src/infra/pi/event-adapter.ts:2057` `consumeJournalReport` → `:2074` `routeJournalReport`（成功才回 ACK） |
| 4 | 路由 | `runtime/src/services/session/journal-report-router.ts:43` → `SessionRecords.applyJournalReport`（sink 注册 `session-records.ts:465-467`） |
| 5 | fold + 缺口补读 | `runtime/src/services/session/events-projection.ts:657`（minSeq>watermark+1 → `readFromOffset`） |
| 6 | 派生 → 信号 | `session-records.ts:694` → `:936` `bus.publish('session.workflowUpdate')`（水位 diff + `filterReadableWorkflowSignals` 门） |
| 7 | renderer 收信号 | `renderer/src/composables/effects/useMessageEffects.ts:240-241` |
| 8 | store 重拉 | `renderer/src/stores/workflow.ts:519` → `:434` → `:477` `sessionApi.getWorkflows` |
| 9 | RPC | `core/src/transport/api/domains/session.ts:316` → `runtime/src/transport/session-message-handler.ts:797` → `session-records.ts:1309` |
| 10 | 消费 | `tray/useTrayCounts.ts:239-248` + `WorkflowVizOverlayHost.vue:165-170`（同 `recordsOf` 分区） |

### 1.2 蓝图链（DAG）

`run-events.ts:258-260`（`scriptSource` 全文）→ `shared/src/protocol.ts:194/898` `session.getWorkflowDag` → `session-message-handler.ts:840` → `session-records.ts:1408` → `:1420-1427` `resolveWorkflowRecordPath`（`projection.sources.v2WorkflowRegistered.get(runId)?.recordPath`，`events-projection.ts:417`）→ `workflow-run-events-reader.ts:454` `readDag` → `subagent-core/src/shared/workflow-dag-parser.ts:952` `parseWorkflowDag`；`dagCache` LRU5（`:380/382`，仅成功）→ renderer `workflow-viz-overlay.ts:175` `loadDag`（错误二分 + 在途丢弃 `:193`）。

### 1.3 事件流链（甘特/事件流）

`protocol.ts:194/897` → `session-message-handler.ts:824` → `session-records.ts:1395` → `workflow-run-events-reader.ts`（坏行宽容、单字段 2KB 截断、>32MB oversize）→ `stores/workflow.ts:406` `loadWorkflowRunEvents`（runId 分区 + LRU5 + 活跃锚 `:258`）→ `gantt-segments.ts` 480 → `gantt/WorkflowVizGantt.vue`（零时钟）。

### 1.4 工具调用链

pi `tool_execution_end` → `runtime/src/services/session/event-interpreter.ts:1114` `WORKFLOW_TOOL_NAMES.has` 触发 record 失效兜底 → `message.tool_call_end` → `applyEntry` → `ui/src/features/chat/ToolRow.vue:313` `isWorkflow` → `:19` `<WorkflowRow>`。workflow 族 tool result **不带 `__gui__`**。

### 1.5 完成通知链

`workflow-notify.ts:296/347` 投 `customType:'workflow-result'` → `shared/src/message.ts:33-37` `COMPLETE_NOTIFY_CUSTOM_TYPES` → `runtime/src/infra/pi/session-entry-mapper.ts:240` 与 core apply-entry 双向覆写 `display:false` → `core/src/domain/chat/notify-summary.ts:285` `workflowNoticeRow` → `ui/src/features/chat/folded-notice.ts:15-38` 四张映射表 → `Turn.vue:57` `turn.trigger === 'bg-notify'` 边界行。

## 2 层 1：composer 入口

### 2.1 现状

workflow 是**内置 built-in 件**（宿主自建计数 + 宿主专属面板），不属协议 widget 区。两套机制并存同一外壳。

徽标/计数来源 = `useTrayCounts` 从 `workflowStore.recordsOf(sid)` 派生（`:239-243`），数据来自 `session.getWorkflows` RPC——数据是插件的、计数是宿主的（B 型）。

pi 扩展侧 workflow 域**零 `setWidget`**：全包唯一用法是 subagent streaming sink（`session-lifecycle.ts:444-446`，经 `event-adapter.ts:717` 的 `subagent-stream-<id>` 分支）。workflow 走另两条通道 `SUBAGENT_JOURNAL_MARKER`（`journal-reporter.ts:156`）/ `SUBAGENT_INFLIGHT_MARKER`（`inflight-reporter.ts:129`），均「就地消费 + ack 不广播」；`inflightMirror` 消费方只有 crash-forensics / rolling-restart（`services/session/rolling-restart.ts:251`），**renderer 零读者**。

### 2.2 固定点清单（19 处）

| # | 锚点 | 内容 | 性质 |
|---|---|---|---|
| 1-3 | `tray/useTrayCounts.ts:75` / `:84` / `:90-94` | `TrayTaskKind` 三员 / `TrayBuiltinKind` 五员 / `TRAY_BUCKETS.workflow=['running','ended']` | 联合类型 ×2 + 硬编码桶 |
| 4-8 | `useTrayCounts.ts:239-248` / `:296-300` / `:324` / `:338-341` / `:351` | 计数派生 / counts 槽 / 挂载即 `loadWorkflows` / `retry(kind)` 分支 / lists 槽 | 宿主自建派生与首拉 |
| 9-10 | `ComposerTray.vue:341` / `:345-352` | `BUILTIN_ORDER` 五件序 / `BUILTIN_ICONS.workflow=Workflow` | 顺序 + 图标硬编码 |
| 11 | `ComposerTray.vue:403-410` | 三态：running>0 亮呼吸点+角标 / 有历史 dim / total=0 不渲染 | 三态宿主定义（插件只有 `WidgetMeta.status/badge` 近似） |
| 12 | `ComposerTray.vue:219` | `kind !== 'session' && kind !== 'canvas'` → `TrayNativePanel` | 面板族分派 |
| 13-14 | `TrayNativePanel.vue:302` / `:379` | `props.kind` 三员 / `workflowRows` 两视图分桶 | 联合 + 分桶 |
| 15-17 | `TrayNativePanel.vue:165-211` / `:522-523` / `:564` | workflow 行 52 行 DOM / `openWorkflowRow` → `openWorkflow(runId)` / `useWorkflowAction` | 行渲染 + 点击归宿 + 行内 action |
| 18 | `tray-tone.ts:59/74` | `workflowToneClass` / `workflowStatusLabel` | 色档 + 词表宿主持有 |
| 19 | `i18n/locales/zh-CN/tray.ts:24/37/60/66` | `title.workflow` / `oversizeHint` / `workflowOpFailed` / `workflowInterrupted` | 每 kind 同步 i18n |

### 2.3 插件化改造方案

把 workflow 从 built-in 件迁到协议 widget 区（todo/goal 形态）：

1. pi 侧 `setWidgetDual(ctx,'workflow',{gui,text})`（分派单点 `extension-protocol/src/core/helpers.ts:105`）；`WidgetMeta` 四字段覆盖现状：`status`→三态、`progress`→`N/M`+进度条、`badge`→运行数、`icon`→图标（`extension-protocol/src/core/types.ts:159-190`）。
2. 宿主删除 1-19：`useTrayCounts` workflow 槽、`BUILTIN_ORDER`/`BUILTIN_ICONS`、`TrayNativePanel` workflow 组、`tray-tone` 两函数。
3. 行内 abort → `action-bar` 原语（`types.ts:104-124`，`items[].commandId` + 标量 args）经 `ACTION_EXECUTOR_KEY`（`ui/src/rendering-protocol/action-executor-key.ts:22`，装配 `useExtensionHostBridge.ts:561-566`）→ `commandRegistry.execute`。（`kind` 只有 `danger`，两段式确认需插件侧自持状态。）
4. **阻塞项**：行点击「打开该 run 的 overlay」当前不可达（§7.4 R1）。不做则该 widget 只能看不能下钻。

## 3 层 2：对话流行内呈现

### 3.1 现状

两条呈现，均不走 `__gui__`：

```
Block 壳 → ToolRow（按 toolName 三分）
            ├ SUBAGENT_TOOL_NAMES → SubagentRow.vue
            ├ WORKFLOW_TOOL_NAMES  → WorkflowRow.vue   ← workflow
            └ 其余 → 普通 tool（展开区可渲 __gui__：ToolRow.vue:152-154）
```

### 3.2 固定点清单（13 处）

| # | 锚点 | 内容 | 性质 |
|---|---|---|---|
| 1-3 | `shared/src/constants.ts:47-52` / `ToolRow.vue:313` / `ToolRow.vue:18-19` | 工具名集合 / `isWorkflow` / `<WorkflowRow>` | 按名硬编码分派 |
| 4-6 | `ui/src/features/chat/WorkflowRow.vue` 132 行 / `:107-113` / `:116-123` | 单行 DOM / 点击 `openWorkflow(name,{slug,sessionId})` / chips 经 `lookupWorkflowRun` | 宿主专属组件 + 桥接缝 |
| 7-8 | `interface/tool/tool-workflow.ts:328`/`:404`、`tool-subagents.ts:30-33` | 「恒折叠单行不消费 `__gui__`（D8 裁决），不构造 GUI 描述符」 | **刻意不产树** |
| 9 | `interface/tool/tool-workflow-script.ts:278` | `withGuiAttach(…, buildScriptGui)` | 同包对照（正常产树） |
| 10-11 | `shared/src/message.ts:33-37` / `notify-summary.ts:217/285/322` | `COMPLETE_NOTIFY_CUSTOM_TYPES` / `FoldedNoticeType` 四员 + `workflowNoticeRow` + 分派 | 词表 + 类型 + 分支 |
| 12-13 | `folded-notice.ts:15/23/31/38` / `Turn.vue:57` | 四张 `Record<FoldedNoticeType,…>` 映射表 / `trigger==='bg-notify'` 聚合行（产出 `message-turns.ts:396`） | 每类型四键同步 / trigger 语义硬编码 |

**`workflow-viz/` 是否被对话流消费：否**。25 个生产文件只被 `overlay/WorkflowVizOverlayHost.vue`（`AppShell.vue:34`）与 `TrayCanvasPanel.vue`（仅 `openCanvasTab`）引用。唯一连接点 = `core/src/domain/drawer/coordination.ts:139/147` 两桥接函数（绑定在 `workflow-viz-overlay.ts:210-227`）。

### 3.3 插件化改造方案

本层收益最高、阻力最小（对话流已有 `ToolRow.vue:152-154` 的通用富渲染分支）：

1. 行本身：`card` + `stats-line` 足以表达「工作流 · name · slug + chips + N/M」。pi 恢复 `__gui__`（`withGuiAttach` 单点现成 `tool-shared.ts:123-146`），宿主删 `isWorkflow` 分支 + `WorkflowRow.vue`。
2. chips 实时性：现靠 `lookupWorkflowRun` 反查 store（`:120`），改造后退化为 tool result 快照；若需保留可 push 同 key widget。（推荐接受快照：实时面归 overlay。）
3. 点击下钻：同 §7.4 R1 阻塞。
4. 完成通知折叠行：`FoldedNoticeType` 四员 + 4 张映射表，改通用需 pi 改投 `GuiComponent` custom message。**不建议本轮动**（折叠行视觉/文案规范跨域共享，单域插件化会分裂）。

## 4 层 3：drawer 一级 tab（含历史裁决影响）

### 4.1 现状：workflow 已完全不在 drawer 内

2026-10-19 用户裁决「浮层是唯一形态」，commit `3ee709342` 删：`panel/WorkflowTab.vue`（395 行）、`__tests__/panel/workflow-tab.test.ts`（255 行）、`panel-container-lazy-retry-workflow.test.ts`（165 行）、`core/src/domain/drawer/selection/workflow.ts`（47 行）、`openWorkflowInDrawer`、`selectedWorkflowName`、`enteredFrom` 生产者。

| # | 锚点 | 内容 | 性质 |
|---|---|---|---|
| 1 | `core/src/domain/drawer/types.ts:24` | `RightDrawerTab` 已开放为 `string`（`RIGHT_DRAWER_TAB_IDS` 8 员已知值 + `isKnownRightDrawerTab` 判别，容器统一批次去枚举） | 类型层强制已消解为运行时判别 |
| 2 | `core/src/domain/drawer/registry.ts:30` | `ContainerContentType = string`（同批去枚举） | workflow 只属 overlay |
| 3 | `registry.ts:144-151` / `:203` | `WORKFLOW_OVERLAY_ENTRY` ∈ `OVERLAY_REGISTRY`（现 4 条：browser/workflow/scheduler/canvas，容器统一批次补齐） | 唯一声明位 |
| 4 | `renderer/src/components/workspace/PanelContainer.vue` | 原 8 分支 drawerTab 字面量 v-if chain 已删（容器统一批次），内容显隐归 `DrawerPanel` aside + ViewHost 推树渲染 | 内容分支硬编码已消解 |
| 5 | `core/src/domain/drawer/coordination.ts:139/147` | `openWorkflow` / `lookupWorkflowRun` 仍在 drawer 域，语义实为开 overlay | 域归属错位 |
| 6 | `renderer/src/i18n/locales/`（zh-CN/en `panel.ts`） | `tabWorkflow`/`noWorkflow`/`workflowHint` 三死键已删（i18n 目录 grep 零命中） | 死文案已清 |
| 7 | `panel/__tests__/SubagentTab.degraded.test.ts` | 已随测试合并批次 c2422d971 整文件删除 | 死 mock 已清 |
| 8 | 余 `SubagentTab.vue:12/13`、`useSubagentTabData.ts:17` 仍以已删 drawer workflow tab 为参照（`PanelContainer.vue` 两处已随容器统一重写消失、`SubagentTab.vue:77` 已更新为浮层归宿） | 3 处以 drawer workflow tab 为参照 | 注释漂移（部分残留） |
| 9 | `docs/testing/e2e-map.json` E2E-MOCK-01 note | 仍写「归宿 drawer workflow tab」 | 登记漂移 |

已清理（容器统一批次 743f82e6f + 测试合并批次 c2422d971）：3 i18n 死键、死 mock 文件、e2e 断言（OV3/OV5 改写抽屉 testid）、结构性固定点第 1、4 两处（tab 联合与内容分支 chain）。仍存：注释漂移 3 处（`SubagentTab.vue:12/13`、`useSubagentTabData.ts:17`）+ 1 e2e-map 表述（E2E-MOCK-01 note）。

### 4.2 对「drawer tab 插件化」方案的影响

1. **容器选择是产品裁决，不是插件声明**。「该出现在哪个容器」是设计决策；注册表只能登记已决定归属。正确形态 = 宿主注册挂载点 + 插件声明 placement（`plugin-sdk/src/types.ts:189-198`，`:193` 已列 `'drawer.tab'`），而非插件决定出现在 drawer。
2. **不要为对齐而补 tab**。workflow 反例证明「有扩展能力」≠「该有 drawer tab」：先做「已确定保留容器」的注册表化，再谈新增。
3. **容器注册表目前是只读文档**：`RIGHT_DRAWER_REGISTRY` 是唯一被消费的注册表（`ui/src/features/drawer/DrawerPanel.vue:135/202`）；`OVERLAY_REGISTRY` / `BOTTOM_DRAWER_REGISTRY` / `CONTAINER_REGISTRY` 生产零消费者（仅 `__tests__`）。workflow 若迁注册表驱动，需先给它真实消费者。

## 5 层 4：overlay 一级 tab

### 5.1 现状

overlay 是 workflow 唯一容器，也是半成品现场：

```
AppShell.vue:34 <WorkflowVizOverlayHost/>
 └ Host 307 行：4 门控 computed(:122/125/128/131) + 派生 matchResult/nodeStates/activePhase/elapsedMs(:179/187/203/231) + 1s tick(:219-227)
    + Guard(:34) + WorkflowVizOverlay 588 行（header 三态 + tab 条 + 三段 body）
    + WorkflowLivePanel(:54) + AgentStreamDrawer(:69) + BrowserOverlay(:80)
```

| # | 锚点 | 内容 | 性质 |
|---|---|---|---|
| 1-2 | `shared/src/ipc-payloads.ts:289` / `core/src/domain/overlay/types.ts:55-59` | `OverlayContentKind` 四员 / `OverlayContent` 判别联合 | 联合 ×2（IPC 契约四方共用） |
| 3 | `core/src/domain/overlay/coordination.ts:54/67/82` | `openBrowser`/`openSchedulerOverlay`/`openCanvasOverlay` + 通用 `openOverlay` | 每内容一 opener |
| 4 | `apps/electron/main/browser/gateway/display-gate.ts:145-148` | 四员硬校验，非法 throw | 跨进程同步点 |
| 5 | `core/src/domain/drawer/registry.ts:203` | `OVERLAY_REGISTRY` 已扩 4 条（browser/workflow/scheduler/canvas，容器统一批次补齐） | 注册表与类型不同步已修复 |
| 6-7 | `workflow-viz-overlay.ts:68`/`:71`/`:74` / `:80`+关闭复位 watch(`flush:'sync'`) | `OverlayTab` 已开放为 `string`（`OVERLAY_TAB_IDS` 三已知值 + `isKnownOverlayTab` 判别）/ `overlayTab` ref | **tab 轴**联合已去枚举（容器统一批次）；单例态仍在 |
| 8 | `workflow-viz-overlay.ts:147` | `setOverlayTab` 只写展示维度，**不改 core kind** | tab 与 kind 刻意解耦 |
| 9-11 | `:114` / `:127` / `:140` | `openWorkflowVizOverlay` / `openSchedulerTab` / `openCanvasTab` | 三个专用入口（各含 core 调用 + tab 置位） |
| 12 | `:159-169` | `closeWorkflowVizOverlayForSession` 三分支（workflow/scheduler 判 sessionId，canvas 走专用） | 级联硬编码 |
| 13-15 | `Host:122/125/128/131` / `:134-140` / `:142-145` | 每 kind 一 computed / `overlaySessionId`(canvas→'') / `overlayRun`(非 workflow→null) | per-kind 投影 |
| 16-17 | `Host:179/187/203` / `:219-227` | `matchResult`/`nodeStates`(六态)/`activePhase` / 1s tick | workflow 专属派生 + 时钟 |
| 18-20 | `WorkflowVizOverlay.vue:65/72/79` / `:428-432` / `:156`+`:435-438` | header 三态 / `tabSegments` 三项硬编码 / 「runs 无 run 禁用」 | 三段硬编码 |
| 21-22 | `:168` / `:308-318` | `tab==='runs'` → DAG + dock / `tab==='canvas'` → `CanvasPane`（async） | 宿主专属渲染 |
| 23-24 | `:322-327` / `workflow-viz-overlay.ts:87` | `v-else` → `<ViewHost :view-id="SCHEDULER_MODAL_VIEW_ID">`；viewId 单源 re-export（值 `modal-scheduler-manager-scheduler-manager.panel`，`extension-protocol/src/extensions/scheduler/types.ts:137`） | **唯一插件渲染段（半成品正面）** |
| 25 | `WorkflowVizOverlay.vue:415/420` | `canvasPaneId`/`canvasPaneSessionId` 读 core SSOT | 壳受控读 |

数据源与渲染组件：

| 视图 | 数据源 | 渲染组件 | 规模 |
|---|---|---|---|
| DAG | `session.getWorkflowDag` → `WorkflowDag`（`shared/src/workflow.ts:658-740`） | `dag/WorkflowVizDag.vue` 383 + `WorkflowVizDagNode.vue` 179 + `layout.ts` 506（手写正交边路由）+ `tone.ts` 71 + `types.ts` 44 + `NodeGuard.vue` 51 | 1234 行/6 文件 |
| 甘特 | `session.getWorkflowRunEvents` → `gantt-segments.ts` 480 | `gantt/WorkflowVizGantt.vue` 277 + `gantt-view.ts` 98 | 375 行/2 文件 |
| 实况 dock | `recordsOf` + `runEventsOf` | `WorkflowLivePanel` 133 + `WorkflowTabContent` 183 + `RunTraceTable` 197 + `RunEventStream` 212 + `PhaseTabContent` 153 + `AgentTabContent` 133 + `AgentStreamDrawer` 200 + `panel-tabs.ts` 66 | 1277 行/8 文件 |
| 壳/容器 | core 单例 + store | overlay 6 文件（Overlay 588/Host 307/Shell 135/Guard 46/控制器 227/types 16） | 1319 行/6 文件 |
| 根级纯函数 | run 反查/蓝图匹配 | `blueprint-match.ts` 116 + `run-name.ts` 13 | 129 行/2 文件 |

### 5.2 「tab 位写死 vs 内容已插件化」半成品分析

同一 overlay 的三个内置 tab（`OVERLAY_TAB_IDS`），内容成熟度三档：

| tab | 内容来源 | tab 位声明 | 差异 |
|---|---|---|---|
| `scheduler` | **插件树**：`resources/plugins/scheduler-manager/index.ts:497` `api.views.update(SCHEDULER_MODAL_VIEW_ID, tree,{sessionId})`；tree = `buildModalTree`（`:199-222`：`stats-line`+`list-tree`+`action-bar`+`ansi-text`）；渲染 `ViewHost`（`:326`）`empty="hidden"` | `tabSegments` 成员 + header 分支 = **2 处**（`OverlayTab` 联合已去枚举，tab 位不再是障碍） | **内容 100% 插件侧，宿主零业务代码** |
| `canvas` | 宿主 `CanvasPane`（async） | 同上 2 处 | 内容宿主专属；payload 需 `canvasId`（core 类型 + main 校验 + renderer 解读） |
| `runs` | 宿主：DAG 1234 + dock 1277 + 4 派生 computed + 1s tick | 同上 2 处 + 独有禁用规则 | 最重一段 |

**结论**：scheduler 证明「tab 位写死」与「内容插件化」是**两个可分离的维度**——tab 位侧已被容器统一批次消解（`OverlayTab` 开放 string + `isKnownOverlayTab`，tab 条渲染数据驱动），剩余障碍只在内容本身。workflow 的 `runs` 内容不是树 → `runs` 仍需一个宿主专属渲染器的逃生舱（即「注册表项 = viewId 或宿主组件」双形态），这是设计上最需要裁决的点。

另注意 **tab 与 kind 解耦带来的语义不对称**：`setOverlayTab('scheduler')` 只改展示维度，core 内容仍是 `workflow`（测试实证 `workflow-viz-overlay-host.test.ts:530-541`「tab 只切展示维度，core 内容 kind 不变」）；而 `openSchedulerTab` 会同时改 core kind。于是「点 tab 进 scheduler」与「直达打开 scheduler」是两条不同事实路径，`overlaySessionId` 取 `payload.sessionId` 时对两者都成立，但 `closeWorkflowVizOverlayForSession` 的分支判据（`cur.kind`）在纯 tab 切换后判的是 workflow——改造 tab 注册表时必须保留这条不对称语义，否则级联判定会回退。

## 6 规模统计（`wc -l` / `git ls-files` 实测）

| 层 | 范围 | 文件数 | 行数 |
|---|---|---|---|
| L1 composer 入口 | `panel/tray/ComposerTray.vue` 607 + `useTrayCounts.ts` 373 + `TrayNativePanel.vue` 567 + `tray-tone.ts` 77 + `composables/features/workflow/useWorkflowAction.ts` 48 | 5 | 1672 |
| L1（托盘目录全量） | `packages/renderer/src/components/panel/tray/` 生产文件（含 bash/session/canvas 共用件） | 16 | 3377 |
| L2 对话流 | `ui/src/features/chat/WorkflowRow.vue` 132 + `folded-notice.ts` 59 + `renderer/src/stores/workflow.ts` 624 | 3 | 815 |
| L2 关联（宿主侧判定） | `ToolRow.vue` 487 + `Turn.vue` 628 + `core/src/domain/chat/notify-summary.ts` 340 + `message-turns.ts` 870 | 4 | 2325 |
| L3 drawer 残留 | 删除链：`WorkflowTab.vue` 395（已删）+ 2 测试 420（已删）+ `selection/workflow.ts` 47（已删）；3 i18n 键与死 mock 文件已清（c2422d971 等批次）；仍存注释漂移 3 处 + e2e-map 1 表述 | 0 现存 | 0 现存 |
| L4 overlay | `workflow-viz/` 生产 25 文件（overlay 6/1319，panel 8/1277，dag 6/1234，gantt 2/375，根级 3/609） | 25 | 4814 |
| L4 core+shared | `core/src/domain/overlay/` 4 文件 299 + `drawer/registry.ts` 178 | 5 | 477 |
| 测试 | `workflow-viz/**/__tests__/*.test.ts` 14 文件 4597；托盘测试 7 文件 4244；e2e 4 spec 1637 | 25 | 10478 |
| pi 侧 workflow 域 | `tool-workflow.ts` 891 + `tool-workflow-script.ts` 493 + `workflow-events.ts` 746 + `workflow-notify.ts` 420 + `jsonl-run-store.ts` 937 + `journal-reporter.ts` 204 + `inflight-reporter.ts` 193 + `workflow-list-injector.ts` 76 + `commands.ts` 425 | 9 | 4385 |
| runtime workflow 域 | `workflow-run-events-reader.ts` 481 + `journal-report-router.ts` 46 + `inflight-mirror.ts` 127 + `workflow-extractor.ts` 37 | 4 | 691 |
| subagent-core workflow/run 族 | `*-workflow-*` / `run-*` / `*journal*`（排测试） | 31 | 8930 |

**渲染侧合计（L1 子集 + L2 子集 + L4）= 7301 行**；宿主专属、无插件等价物的 L4 占 66%。

## 7 改造方案与依赖

### 7.1 GuiComponent 原语表达力评估

现有原语 11 个（`extension-protocol/src/core/types.ts`）：`ansi-text` `:38`、`card` `:45`、`stats-line` `:52`、`progress-bar` `:57`、`list-tree` `:66`、`group` `:75`、`columns` `:80`、`tab-bar` `:86`（含 v1.1 `sections` 容器化）、`action-bar` `:104`、`text-input` `:126`、`custom` `:137`（仅内置编译期注册，无 provide 点）。

| 视图 | 能否用原语表达 | 判定依据 |
|---|---|---|
| **DAG 图** | **不能** | 需绝对定位节点坐标 + 手写正交边路由（`dag/layout.ts` 506 行：节点 156×44、列间 32px、lane 错开、loop-back 四折点、圆弧过渡）+ 缩放/平移手势 + 六态 dot 着色（`dag/tone.ts`）。原语只有流式布局，无坐标系/连线/手势任何一项；`custom` 逃生口无 provide 点（`core/src/rendering-protocol/custom-registry.ts:19` 只有 key/查询，全仓零 `provide`）。 |
| **甘特图** | **不能** | 需时间轴百分比定位 + phase 全高背景带（含斜纹 scriptOnly）+ attempt 分段横条 + 退避空档 + 运行游标（`WorkflowVizGantt.vue` 277 行）。`progress-bar` 只能表达单条 current/total，无法表达时间坐标系与多段并列。 |
| **实况 dock（trace 表）** | **部分能** | `list-tree`（`TreeItem{icon,label,status,depth,children}`，`:66-73`）可表达行 + 状态点，但 trace 表 9 列（`RunTraceTable.vue`：`#`/Agent/Phase/Attempt/状态/开始/耗时/Token/结果）需表格对齐；`columns` 只能固定列宽比例（`ratios`），无表头粘滞/行高一致/右对齐数值列。降级形态可接受，精确保真不能。 |
| **实况 dock（事件流）** | **基本能** | 行 = 时间 + 类型标签 + 内容，`list-tree` + `ansi-text` 可表达；截断提示（`truncatedHint`）用 `ansi-text`。 |
| **实况 dock（多级 tab）** | **能** | `tab-bar.sections`（`:86-103`）已实现「容器化分段：第 i 段 = tabs[i] 激活时渲染的子树，宿主本地持 active」，与 `WorkflowLivePanel` 的 `L2TabBar` + 固定 tab + phase 动态 tab 语义同构（动态增删需每次全量重推，`sections` 与 `tabs` 等长约束仍成立）。 |
| **托盘行（L1）** | **能** | `WidgetMeta` 四字段（title/status/progress/badge/icon）+ `group`/`stats-line`/`progress-bar` 组合；todo 已实证。 |
| **对话流行（L2）** | **能** | `card` + `stats-line` + `ansi-text`；phase chips 可用 `list-tree` 扁平或 `group` + `stats-line`。 |
| **完成通知折叠行** | **能但不建议** | 需 pi 改投 `GuiComponent` custom message；折叠行规范跨域共享，单域改会分裂。 |

**结论**：`runs` tab 的三个子视图里，事件流与多级 tab 可插件化，**DAG 与甘特不可**。这不是「补原语」能解决的——它们需要的是坐标系原语族（absolute/line/shape/gesture），而 `custom` 逃生口按设计只对内置 extension 开放且当前无 provide 点。因此 workflow 的 plugin 化边界应画在「**runs 的壳与轻量视图插件化，重可视化保留宿主**」。

### 7.2 需 runtime 配合的点

| # | 点 | 现状 | 需要什么 |
|---|---|---|---|
| 1 | journal 推送通道 | 已有（`event-adapter.ts:2057` + `journal-report-router.ts:43`），ack 生效回执完整 | **零改动**；若 workflow widget 需要实时 run 列表，可复用该通道扩 domain 而非新增协议 |
| 2 | `session.getWorkflows` / `getWorkflowDag` / `getWorkflowRunEvents` | 已有（`session-message-handler.ts:797/840/824`），结构化错误臂齐备 | 若 tree 化后 renderer 不再直读这三个 RPC，可保留供宿主 fallback；**不建议删**（重可视化仍需要） |
| 3 | `session.workflowUpdate` 增量信号 | 已有（`session-records.ts:936`，水位 diff） | 零改动 |
| 4 | `session.workflowAction`（abort） | 经 `client.prompt('/workflows abort <runId>')`（`session-records.ts:1455`）转 slash command | 若改 `action-bar`，插件可自持 `commands.register`，**但 command 不注入 pi 工具表**（`docs/todo/plugin-pluginization.md` S5），故 abort 仍应走插件自身 handler 而非依赖宿主转发 |
| 5 | overlay kind 集合 | `OverlayContentKind` 四员 + main 侧 `display-gate.ts:145-148` 硬校验 | 若引入「插件声明 overlay tab」，需把 main 的 content 校验从四字面量改为「宿主已知集合」动态下发（**跨进程契约变更**，风险最高的一项） |
| 6 | 插件 tool 不可见（S5） | `plugin-sdk` 的 `tools` 声明只进 runtime `toolRegistry`，不进 pi 工具表 | workflow 不依赖此项（能力在 pi extension 侧），但**折叠行/行点击若要走插件命令链，必须确认 command 通路可用** |

### 7.3 需 pi extension 配合的点

| # | 点 | 位置 | 需要什么 |
|---|---|---|---|
| 1 | 产出 workflow widget | 新增于 `extensions/universal/subagent-workflow/src/`（现零 `setWidget`） | `setWidgetDual(ctx,'workflow',{gui,text})`，`WidgetMeta` 填 title/status/progress/badge/icon；清屏 = `undefined`（同 todo `index.ts:52`） |
| 2 | 恢复 tool 的 `__gui__` | `interface/tool/tool-workflow.ts:328/404`、`tool-subagents.ts:30` 需撤 D8 裁决 | `withGuiAttach(result.details, toGuiCtx(ctx), buildWorkflowGui)`；`GuiComponent` 构造建议 `card`+`stats-line`（复用 `interface/gui/subagent-actions.ts:124` `buildGuiComponent` 范式） |
| 3 | run 下钻动作 | 无 | `action-bar` 的 `commandId` 只能执行宿主已注册命令；「打开某个 run 的 overlay」不是命令而是容器操作 → **需要新原语或新宿主命令**（§7.4 R1） |
| 4 | 事件流/多级 tab 树（可选） | `panel/*` 现宿主实现 | 若做，需 pi 侧订阅 journal 并推 `tab-bar.sections` 树；成本高、收益低（事件流已可用 `list-tree` 降级） |
| 5 | 完成通知 | `workflow-notify.ts:296/347` | 若要通用折叠行，改投 `GuiComponent` 携带的 custom message；建议本轮不动 |

### 7.4 风险与不可行项

| # | 项 | 性质 | 说明 |
|---|---|---|---|
| **R1** | **容器操作无原语（真阻塞）** | 不可行（当前协议） | 所有「点击 → 打开宿主容器」的归宿（层 1 行点击 `TrayNativePanel.vue:522`、层 2 块点击 `WorkflowRow.vue:107`）都依赖 `core/domain/drawer/openWorkflow` + `bindWorkflowOverlayOpener` 桥接。`GuiComponent` 11 原语里没有任何「request host container」语义；`action-bar` 只能走 `commandId` → 插件 command，而插件 command 无法改 core overlay kind。→ 需新增原语（如 `action-bar` 的 `hostAction` 字段）或宿主内置命令 `workflow.openRun`。**不解决则层 1/层 2 只能做到「可看不可点」**。 |
| **R2** | DAG / 甘特原语化 | 不可行（成本远超收益） | 见 §7.1。需要坐标系原语族；`custom` 逃生口无 provide 点且设计上仅内置。 |
| **R3** | overlay kind 跨进程契约 | 高风险 | 新增 kind 必须同步改 `shared/src/ipc-payloads.ts:289` + `core/src/domain/overlay/types.ts:55` + `apps/electron/main/browser/gateway/display-gate.ts:145-148` 三处；`OVERLAY_REGISTRY` 已补齐 scheduler/canvas（现 4 条，容器统一批次）——原「注册表与类型不同步」前置已消解。 |
| **R4** | tab 与 kind 解耦语义 | 中风险 | `setOverlayTab` 不改 core kind（`workflow-viz-overlay.ts:147`，测试 `workflow-viz-overlay-host.test.ts:530-541`）；会话删除级联按 `cur.kind` 判（`:159-169`）。注册表化若把「tab 点击」改为「换 content」，该不对称语义会回退 → 级联判定失效。**改造必须显式保留或重新裁决**。 |
| **R5** | 折叠行跨域规范 | 中风险 | `FoldedNoticeType` 四员（bash/subagent/workflow/managed）共享 4 张映射表与 `specs/chat/system-notices.md` 视觉规范；单域插件化会分裂规范。 |
| **R6** | 已漂移的测试资产 | 已清理 | 死 mock 文件已随 c2422d971 整删；OV3/OV5 断言已改写 `wf-viz-agent-drawer-tab-*`（e2e 全目录 `l2-tab-agent` 零命中）。回归信号失真风险已消除。 |
| **R7** | 计数双口径 | 低风险 | 迁 widget 后宿主 `useTrayCounts.workflow` 与插件 `WidgetMeta.badge` 并存会双口径；必须同批删宿主派生。 |

## 8 可执行改造步骤（有序）

**前置（0 阶段，无依赖，可立即做）**

1. 清理漂移资产（大部分已完成）：死 mock 文件已随 c2422d971 整删；OV3/OV5 断言已改写 `wf-viz-agent-drawer-tab-*`；三 i18n 死键已删；`PanelContainer.vue` 注释漂移已随容器统一重写消失、`SubagentTab.vue:77` 已更新。仍待做：`e2e-map.json` E2E-MOCK-01 的「drawer workflow tab」表述、`SubagentTab.vue:12/13` 与 `useSubagentTabData.ts:17` 注释。
2. 修注册表与类型不一致：已完成（`OVERLAY_REGISTRY` 现 4 条：browser/workflow/scheduler/canvas）。

**阶段 1（层 1，收益/成本最优，但含 R1 阻塞）**

3. pi 侧新增 workflow widget：`setWidgetDual(ctx,'workflow',{gui: buildWorkflowGui(state), text: renderWidgetLines(state)})`，`WidgetMeta` 四字段对齐现有三态/角标/进度/图标语义；清屏用 `undefined`。
4. 宿主侧删除 built-in workflow 件（固定点 1-19）：`useTrayCounts` 删 `workflow` 槽与 `TRAY_BUCKETS.workflow`、`ComposerTray` 删 `BUILTIN_ORDER`/`BUILTIN_ICONS` 的 workflow 项、`TrayNativePanel` 删 workflow 组与 `useWorkflowAction` 引用、`tray-tone.ts` 删两函数、`tray.ts` 删 5 键。**同批删宿主计数，避免 R7 双口径**。
5. 裁决 R1：若接受「widget 只读」，阶段 1 即可收敛；若要求下钻，先做 R1 的原语/命令扩展（独立立项，影响面跨 `extension-protocol` + `ui` + `core` + 插件执行器）。

**阶段 2（层 2，与阶段 1 独立但共享 R1）**

6. pi 撤 `tool-workflow.ts:328/404` 与 `tool-subagents.ts:30` 的「不构造 `__gui__`」裁决，改 `withGuiAttach(..., buildWorkflowGui)`；宿主 `ToolRow.vue` 删 `isWorkflow` 分支（`:313`/`:18-19`），删 `WorkflowRow.vue`（132 行）。chips 实时性降级为 tool result 快照（如需实时，后续用同 key widget 补）。
7. 保留完成通知折叠行不动（R5）；`FoldedNoticeType` 与 4 张映射表本轮零改动。

**阶段 3（层 4，半成品收口）**

8. tab 位声明表收敛：`OverlayTab` 已开放为 `string`（容器统一批次，tab 位不再是障碍），`tabSegments` 已数据驱动渲染 tab 条；剩余收敛点 = body 三分支（runs/scheduler/canvas 显式分支）与禁用规则收敛为「overlay tab 声明表」——每项 `{ id, label, icon, renderer: { kind: 'view', viewId } | { kind: 'host', component } }`。scheduler 项用 `view`（现成），runs/canvas 用 `host`（R2 决定它们无法 tree 化）。**必须保留 R4 的 tab/kind 不对称语义**（`setOverlayTab` 只改展示维度），否则级联判定回退。
9. 若阶段 8 落地，可把「workflow 的 DAG/甘特」注册为该声明表的 `host` 渲染器项，为将来其他域的重可视化提供同一逃生舱形态——但内容仍归宿主，不声称「已插件化」。
10. 更新 `docs/plugins/extension-points.md` R36/R37/G5/G8 与 `docs/plugins/renderer-pluginization-scan.md` C6/D1 的判定（R2 结论应把 workflow 从「C 完全写死」细化为「数据面 A + 轻量视图可 B + 重可视化 D」）。

**明确不做**

- DAG / 甘特原语化（R2）。
- 新增 drawer tab（§4.3 裁决约束）。
- 单域改造完成通知折叠行（R5）。
- 新增 `OverlayContentKind` 成员（R3 跨进程契约；本域无此需求）。

## 相关文档

- [docs/todo/plugin-pluginization.md](../plugin-pluginization.md) — 插件化改造索引与本域判定
- [docs/plugins/architecture.md](../../plugins/architecture.md) — 四层模型 / 贡献点契约 / 生命周期
- [docs/plugins/extension-points.md](../../plugins/extension-points.md) — R36/R37/G5/G8/P28/P29
- [docs/plugins/renderer-pluginization-scan.md](../../plugins/renderer-pluginization-scan.md) — C6/D1 与本域证据
- [docs/plugins/built-in-plugin-guide.md](../../plugins/built-in-plugin-guide.md) — scheduler-manager 案例走读（本域半成品对照）
- [docs/testing/e2e-map.json](../../testing/e2e-map.json) — E2E-MOCK-01（workflow-viz-overlay / workflow-sidebar-sync 登记）
