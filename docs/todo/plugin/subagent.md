# subagent 域全链路现状分析

状态：分析完成（2026-10-24；待裁决）

分析对象 = 「用户可见的 subagent 能力」从入口到内容的四层链路：
composer 入口 → 对话流行内呈现 → drawer 一级 tab → overlay 一级 tab。
本文只描述现状事实与锚点，改造判定集中在 §7 / §8。

父文档：[docs/todo/plugin-pluginization.md](../plugin-pluginization.md)。同域登记：
[subagent-core-d1-residual-edges.md](../subagent-core-d1-residual-edges.md)、
[subagent-workflow-issues.md](../subagent-workflow-issues.md)。
绘制说明：本文所有「文件:行号」均经 `sed -n '<line>p'` 逐行实测校验（2026-10-24，工作树当前状态）。

---

## 0 结论摘要

1. **subagent 是四层全固定的 C 类域，且固定点密度不均：层 3 最重、层 2 最「薄」但最不可替代。**
   层 1 固定点 6 处（1834 行）、层 2 固定点 5 处（3572 行）、层 3 固定点 12 处（3137 行）、
   层 4 固定点 6 处（1541 行）。层 3 的 `SubagentTab.vue`（522 行）本身只是编排壳——真正不可替代的
   是它挂载的 `MessageStream`（对话流全套渲染树），这是 subagent 域**唯一无法用 GuiComponent 替代的资产**。

2. **数据链路已经「半插件化」，但插件侧只推数据、不推 UI；且三套通道语义互不相同。**
   `pi-subagent-workflow` 确实产出 GuiComponent（`interface/gui/subagent-actions.ts:124 buildGuiComponent`，
   产出 card / list-tree / stats-line 三原语，共 13 处 `guiComponent(...)` 调用），但这些树挂在
   `details.__gui__` 上，被 `ToolRow.vue:152` 的**普通 tool 分支**消费——而 subagent_* 工具名走的是
   `SubagentRow`（`ToolRow.vue:16`），后者从不读 `__gui__`（`grep -c __gui__ SubagentRow.vue` = 0）。
   **即：插件已经产出了声明式 UI，宿主把它丢掉了，改用专属组件重画。** 这是全仓最典型的
   「插件做了、宿主不接」断点，也是四层里改造成本最低的地方。

3. **托盘存在两套并行机制，subagent 同时占了两套的槽位但只用了其中一套。**
   `TrayTaskKind = 'bash' | 'subagent' | 'workflow'`（`useTrayCounts.ts:75`）是宿主自建计数 + 专属面板；
   协议 widget 区（`getViewIds` + `orderTrayWidgetIds`）是插件推树 + 通用 `TrayWidgetPanel` 渲染。
   subagent 走前者。而 todo/goal 走后者——在 `ComposerTray.vue` 里两者是相邻的两段模板
   （built-in 五件 `:168-236`，widget 区 `:238-273`），后者零业务代码（只有 head + 递归渲染）。

4. **层 3 与层 4 已在同一个「对话流复用」事实下分裂成两个实现点，用途不同。**
   drawer 的 `SubagentTab.vue`（`:212`）与 overlay 的 `AgentTabContent.vue`（`:39`）都挂 `MessageStream`，
   共用 `useSubagentTabData`，但用不同 `streamScope` 隔离订阅
   （`useSubagentTabData.ts:67 STREAM_SCOPE = 'drawer:subagent'`，overlay 侧传独立 token，
   见 `AgentTabContent.vue:69-71` 注释）。层 4 的 subagent 呈现（workflow overlay 右侧
   `AgentStreamDrawer`）**不是** overlay 一级 tab，而是 run 级 drawer——说明「subagent 详情」
   这个能力本身已有两套容器归属，再加一套就是第三套。

5. **overlay 不应该新增 subagent 一级 tab。**
   理由：overlay 内容语义 = `{ kind, payload }` 单例换内容（`packages/core/src/domain/overlay/types.ts:55 OverlayContent`），
   一级 tab 是「同一 payload 的多个视角」（runs / scheduler / canvas）；而 subagent 是 run 的**下级**实体
   （`WorkflowAgentCall.memberRecordId` → `SubagentRecord.subagentId`），进一级 tab 会造成
   「tab 条语义 = 视角切换」与「tab 条语义 = 实体钻取」的混用。§5.3 给出替代方案。

---

## 1 数据链路全景

### 1.1 通道总表（生产 → 中转 → 消费）

| # | 生产（pi extension / subagent-core） | 中转（runtime） | 消费（renderer） | 语义 |
|---|---|---|---|---|
| C1 | `subagent-record` / `workflow-record` custom entry 落 pi session JSONL（`subagent-core` 落盘点） | `event-adapter` entry_appended → `SessionEventProjection` fold（`events-projection.ts:548` 类定义）；冷启动 `scanRecordFamilyEntriesFromSessionFile`（`session-file-extraction.ts:123`） | `session.getSubagents` RPC 拉取（`session-message-handler.ts:755-762`）/ `session.subagents` 广播 | **列表快照**（权威） |
| C2 | 同上（journal 文件 `.record.jsonl` / run journal） | `host/journal-reporter.ts:156` → select + `SUBAGENT_JOURNAL_MARKER` → `event-adapter.ts:2057 consumeJournalReport` → `journal-report-router.ts:43 routeJournalReport` → `events-projection.ts:657 applyJournalReport` | 无直接消费（喂 C1 的 fold） | **推送加速 + 生效回执**（仅应用成功才 ack，`event-adapter.ts:2079`） |
| C3 | `host/inflight-reporter.ts:129` → select + `SUBAGENT_INFLIGHT_MARKER`（绝对计数帧） | `event-adapter.ts:2015 consumeInflightReport` → `inflight-mirror.ts:105 applyReport`（整值覆盖） | **无前端消费**；唯一读方 `rolling-restart.ts:251,291` | **在途计数**，与 C1 完全正交；两处封口禁广播（`event-adapter.ts:1803`,`:1810`） |
| C4 | 引擎进程 fd3 raw mirror（仅当引擎由 runtime spawn） | `subagent-tee.ts`：`PiEvent` 翻译 → entry 化 | `session.subagentEntriesAppended`（`:225`）/ `subagent.stream_chunk`（`:282`）/ `subagent.stream_delta`（`:316`） | **子代理对话流实时内容**（live） |
| C5 | 不适用 | `session-records.ts:916 publishRecordChanges` 水位 diff 后发全量帧 | `session.subagents` → `route-inbound.ts:308` → `useMessageEffects.ts:216 handleSubagents` → `subagentStore.applyRecords`（`stores/subagent.ts:226`） | **列表增量推送**（全量帧，diff 驱动） |
| C6 | `ToolRow` 的 tool 块本身 | 无（tool result 走主对话流 entry） | `SubagentRow.vue` 读 `tool.input` + `tool.output` 自行解析 | **行内呈现**（本地解析，非协议） |
| C7 | `withGuiAttach` → `details.__gui__`（`subagent-actions.ts:100`） | 无（随 entry 透传） | `ToolRow.vue:152` 的**普通 tool 分支** `GuiComponentRenderer`（subagent 分支不消费） | **声明式行内 UI（当前被丢弃）** |
| C8 | `/subagents message` 成功后 `pi.sendMessage` 落 `subagent-directive` custom_message | 无 | `SystemNotice.vue:160` 定向气泡 | **定向消息留痕** |

### 1.2 链路图

```
pi 进程（@zhushanwen/pi-subagent-workflow 13820 行 / subagent-core 56440 行）
├─ subagent-record entry ──┐
├─ journal 增量（C2）  ────┤
│                          ▼
│                  SessionEventProjection（fold + 权威仲裁：running 优先 / startedAt 最新）
│                          │
│                          ▼ 水位 diff（subagentRecordEquals:1804）
│                  cache.subagents ──┬──► broadcast session.subagents（全量帧，:916）
│                                    └──► RPC reply session.getSubagents（:1080）
│
├─ select + INFLIGHT_MARKER ──► inflightMirror（内存 Map，127 行）──► rollingRestart（不广播）
├─ select + JOURNAL_MARKER  ──► journalReportRouter ──► SessionEventProjection.applyJournalReport
│
└─ 引擎 fd3 ──► SubagentTee ──► entriesAppended / stream_chunk / stream_delta（transient）
                                         │
renderer                                 ▼
├─ core/coordination/route-inbound.ts:308  'session.subagents'
│     └─► useMessageEffects.ts:216 ──► subagentStore.applyRecords（per-session Map 分区）
├─ core/coordination/route-inbound.ts:317  'session.subagentEntriesAppended'
│     └─► useMessageEffects.ts:227 ──► chatStore.applySubagentEntries（虚拟分区）
│
├─ 层1 composer：useTrayCounts（读 subagentStore）→ ComposerTray → TrayNativePanel（kind='subagent'）
├─ 层2 对话流：ToolRow → SubagentRow（读 tool.input/output，解析 subagentId）
├─ 层3 drawer：SubagentTab → useSubagentTabData → MessageStream（虚拟 id 分区）
└─ 层4 overlay：AgentStreamDrawer → AgentTabContent → MessageStream（agentcall: 快照）
```

### 1.3 状态判定权的归属（关键事实）

`isRunningProjection` 定义在 **renderer**，不在 shared、不在 runtime：

```
packages/renderer/src/lib/subagent-bucket.ts:40
  return record.status === 'running' && record.stopReason === undefined
```

消费方三处（同一 import，无副本）：`stores/subagent.ts:42`、`useTrayCounts.ts:67`、
`TrayNativePanel.vue:288`。runtime 侧零出现（`grep -rn isRunningProjection packages/runtime/src` 为空），
`packages/shared` 零出现。`packages/mobile-renderer/src/views/SubagentStatusLine.vue:32,60` 是**手写镜像**而非 import。

含义：runtime 只产出 `status`（两态 running/idle）+ `stopReason` 两个事实字段
（`subagent-status.ts:84 normalizeSubagentStatus` 把 pi 的九种 legacy 状态串归一到两态，
保证 renderer 永不见旧值）；「是否在跑」是**渲染侧派生**。任何把 subagent 判定迁入插件的方案，
都要先讲清这条判定权的归属——复刻即造第二口径。

---

## 2 层 1：composer 入口

### 2.1 现状（锚点）

**入口本体** = `Composer.vue` 左簇的 `ComposerTray`：

- 挂载点：`packages/renderer/src/components/panel/Composer.vue:132`（`data-composer-cluster="left"`），
  实际组件 `:159-165`（`v-if="sessionId"` + `v-show="!density.anchorProtected"`）。
- 左簇顺序（`:133-165`）：`AddMenuPopover`（+）→ `HeaderActionsHost`（插件 headerAction）→
  `ComposerBtwButton` → `ComposerTray`（任务托盘 = built-in 五件 + 协议 widget 区）。
- 注意 `Composer.vue:132` 的 `v-if` 还带 `&& !subagent`——subagent 车道形态下整个左簇不渲染
  （`:355-357` 注释：托盘/插件 toolbar 对 subagent 无数据面）。

**图标来源**：

- built-in 五件图标 = `ComposerTray.vue:345-351 BUILTIN_ICONS`，subagent 项在 `:347 subagent: Bot`
  （lucide `Bot`，import 见 `:286`）。
- 固定序 = `:341 BUILTIN_ORDER = ['bash','subagent','workflow','session','canvas']`
  （不参与 widget 动态排序）。
- 对照：协议 widget 区图标走 `TrayWidgetButton.vue` 的四档 fallback 链——
  `:157 BUILTIN_WIDGET_ICONS`（**仅** `todo`/`goal` 两条）→ `:166 WIDGET_ICON_ENTRIES`
  （10 条 lucide 名白名单）→ `:185 FALLBACK_WIDGET_ICON = LayoutGrid`；
  `meta.icon` 可为 `{paths}`（`validateWidgetIconPaths` 白名单，`:221`）。
  **两套图标机制互不复用**：built-in 是硬编码 Record，widget 是 meta 驱动的四档链。

**徽标 / 计数**：

- 类型：`useTrayCounts.ts:75 TrayTaskKind = 'bash' | 'subagent' | 'workflow'`
  （+ `:84 TrayBuiltinKind = TrayTaskKind | 'session' | 'canvas'`）。
- 分桶表：`:90 TRAY_BUCKETS`，subagent 项 = `['running','ended']`（两视图；
  `[两视图裁决 2026-09-16]` 已删第三桶，见 `:86` 注释）。
- 计数派生：`:224 subagentRecords`（`recordsOf(sid, {excludeOrigin:'workflow'})`）→
  `:230 subagentRunning`（`isRunningProjection`）/ `:233-235 subagentEnded`（`!isRunningProjection`）→
  `:291-295 counts.subagent`。
- 徽标渲染：`ComposerTray.vue:198-208`（呼吸点 + 计数，仅 `running > 0` 才出）；
  取值 `:414-416 badgeCount()`——session / canvas 用 `total`，其余（含 subagent）用 `running`。
- 三态：`:403-409 builtinItems` 过滤 `total === 0` 的件（全无 → 按钮 DOM 不存在，归零不虚亮）。

**首拉 / 错误 / 降级**：

- 首拉：`useTrayCounts.ts:318-330` `watch(normalizedSid)` → `loadSubagents(sid)` + `loadWorkflows(sid)`
  （`immediate: true`；btw 线 vid 跳过，`:322`）。
- 错误态：`:358 errors.subagent = subagentStore.loadErrorOf(sid)`；oversize：`:363`；loading：`:368`。
- 面板三态渲染：`TrayNativePanel.vue:33`（loading）/ `:40`（error + retry）/ `:50`（oversize 降级）。

**点击行为**：

- 点击 built-in 按钮 = `onTogglePin`（`ComposerTray.vue:555-563`），pin 打开面板（**非**直达 drawer）。
- 面板内容分流：`:219-234`——`item.kind !== 'session' && item.kind !== 'canvas'` → `TrayNativePanel`
  （subagent 落此类）；session → `TraySessionPanel`；canvas → `TrayCanvasPanel`。
- 面板内行点击：`TrayNativePanel.vue:129 @click="openSubagentRow(record)"` →
  `:514-516 openSubagent({ virtualId: subagentVirtualId(props.sessionId, record.subagentId) })`
  → `core/domain/drawer/coordination.ts:74 openSubagent` → `:76 drawerControl.open('subagent')`
  → **最终打开层 3 的 drawer。即 composer 入口没有自己的详情容器，它是 drawer 的 opener。**
- 行内操作：`:540 cancelConfirm = useTwoStepConfirm(...)` → `:550-560 cancelSubagent`
  （两段式确认；`isStreamingSubagent` 为 false 时改 toast「已结束」不发 RPC，`:551-554`）。

**聚合形态（密度档）**：`ComposerTray.vue:83-163` 聚合入口（单 `Layers` 图标 + 运行数角标）→
`TrayAggregatePanel.vue:54-59` 段内仍按 kind 渲染 `TrayNativePanel`。
聚合只改容器、不改 kind 集合。密度判据：`composer-density.ts:187-194`（`absent` / `aggregated` / `expanded`）。

### 2.2 固定点清单（6 处 / 1834 行）

| # | 固定点 | 位置 | 为什么是固定点 |
|---|---|---|---|
| L1-1 | `TrayTaskKind` 三值联合写死 | `useTrayCounts.ts:75` | 新增任务域必须同改 `TRAY_BUCKETS`（`:90`）+ `TrayCounts`（`:105-114`）+ `TrayLists`（`:120-131`）四处 |
| L1-2 | `TrayBuiltinKind` 五值联合写死 | `useTrayCounts.ts:84` | 同上，另加 `ComposerTray BUILTIN_ORDER`（`:341`）+ `BUILTIN_ICONS`（`:345`）两张表 |
| L1-3 | subagent 计数派生硬编码 | `useTrayCounts.ts:224-235,291-295` | 分桶谓词 `isRunningProjection` + `excludeOrigin:'workflow'` 是宿主业务判断 |
| L1-4 | 图标硬编码 Record | `ComposerTray.vue:345-351` | built-in 图标不能由插件提供（widget 区可以） |
| L1-5 | subagent 专属行渲染分支 | `TrayNativePanel.vue:123-161`（39 行模板） | 引擎 icon + spinner + agent/slug + turns/tokens/耗时 + task 摘要 + 两段式取消，全部专属 |
| L1-6 | 行点击归宿硬编码 | `TrayNativePanel.vue:514-516` | 只能开 drawer subagent tab，无可配置的 opener |

### 2.3 插件化改造方案（可行，且是四层里最容易的一层）

**判定：可行。** 已有一个跑通的同类样板：todo / goal 在协议 widget 区产 `tab-bar + list-tree`，
宿主 `TrayWidgetPanel` 只做 head + 递归渲染（148 行，零业务语义）。todo 的生产端：
`extensions/universal/todo/src/model.ts:163 buildGui` → `:177 guiComponent("tab-bar", {tabs, sections})`
→ `:189-196 meta{title,status,progress,icon:'list-checks',badge}`；
推送端 `todo/src/index.ts:54-56 setWidgetDual(ctx, "todo", {gui: buildGui(...)})`。

改造路径（4 步）：

1. `pi-subagent-workflow` 在 subagent record 变化时调 `ctx.ui.setWidget('subagent', { gui, meta })`。
   通道已通：`event-adapter.ts:675 tryDecodeWidgetGui` 解 `GUI_WIDGET_MARKER` →
   `message-bus-bridge.ts:347 'extension:widgetGui'` → `view-host-store.ts:120 consumeWidget`
   → session 域分区。**runtime 零改动。**
2. `meta` 提供 `{ title:'Subagent', status:'running'|'idle', badge: runningCount, icon: 'bot' }`
   —— `WidgetMeta` 已有全部字段（`extension-protocol/src/core/types.ts:159`），
   `TrayWidgetButton` 的 badge/status/icon 链已实现（`:242-258`）。
   **需给 `WIDGET_ICON_ENTRIES`（`TrayWidgetButton.vue:166-177`）补 `'bot'` 一条**（现 10 条无 bot）。
3. `gui` 产 `tab-bar`（tabs = `进行中 N` / `已结束 M`，`sections` = 两个 `list-tree`）——
   `tab-bar.sections` 容器化分段是既有能力（`extension-protocol/src/core/types.ts:86-95`），todo 已在用。
4. 宿主删除 `BUILTIN_ORDER` 的 `'subagent'` 项与 `TrayNativePanel` 的 subagent 分支；
   `TrayTaskKind` 收窄为 `'bash' | 'workflow'`（或两者全迁）。

**残留缺口（必须一并解，否则改造不完整）**：

- **行内操作不可表达**：`action-bar` 的 `commandId` 走 `CommandRegistry.execute`
  （`action-executor-key.ts:18` + `useExtensionHostBridge.ts:561` provide），是「插件命令」通道；
  而「取消 subagent」当前是 `subagentStore.cancelSubagent` → `session.subagentAction` RPC
  （handler `session-message-handler.ts:894-904`）。要么插件注册 `subagent.cancel` 命令
  （插件 handler 内部调 `session.subagentAction`，`args` 传 `sessionId`+`subagentId`——
  `args?: Record<string, string|number|boolean>` 支持标量，`extension-protocol/src/core/types.ts:114`），要么保留宿主行内按钮。
  **这是本层唯一的真阻塞点（依赖 §7.1 缺口 2）。**
- **两段式确认不可表达**：`TrayConfirmButton` 是宿主组件，协议无「二次确认」原语。
  可行解 = 插件侧两步：先推 `{label:'取消'}`，点击后推 `{label:'确认取消', kind:'danger'}`。
  但这要求插件持有「pending confirm」瞬态 + 依赖点击回传——**`action-bar` 无点击回执通道**。
- **点击行打开详情**：`list-tree` 的 `TreeItem` 无 onClick / commandId / id（`extension-protocol/src/core/types.ts:199-205`），
  无法表达「点这行开 drawer」。需新原语，或 `action-bar` 之外的「行点击」通道。

---

## 3 层 2：对话流行内呈现

### 3.1 现状（锚点）

**分派链**：`Block.vue:69-73`（`type === 'tool' || type === 'agentgraph'` → `ToolRow`）
→ `ToolRow.vue:16`（`isSubagent` → `SubagentRow`）/ `:19`（`isWorkflow` → `WorkflowRow`）/ `:23`（其余普通 tool）。

**工具名判定**：`ToolRow.vue:312 isSubagent = SUBAGENT_TOOL_NAMES.has(toolName)`，
集合 SSOT = `packages/shared/src/constants.ts:29-34`（`subagent` / `subagent_start` / `subagent_manage` / `subagent_message`）。
对照 `WORKFLOW_TOOL_NAMES`（`shared/src/constants.ts:41-46`）含 `subagents`（批量派发走 workflow run）。
block 分类：`core/domain/chat/assistant-blocks.ts:25-27`（`isAgentgraphToolName(tc.toolName) ? 'agentgraph' : 'tool'`）。

**`SubagentRow.vue`（162 行，其中约一半是注释）**：

- 模板 `:15-58`：单行，**无展开区**（文件头 `:8` 明确 "collapsed only"）。
- 内容：`RunningBlockIcon`（running）或 `BLOCK_ICON_LUCIDE.subagent`（users 图标）+
  `panel.message.subagent` 标签 + agent 名（`--name` 色）+ slug + `(model · thinking X)` +
  失败摘要 chip（`:52-56`，`bg-danger-soft` + `title` 全文）。
- 数据源 = **本地解析 `tool.input` / `tool.output`**，不是协议：
  - `:90-93 inputObj`（`tool.input` 当 `Record<string, unknown>`）；
  - `:104-107 subagentAgent`（`input.agent` 取 basename，缺省 `general-purpose`）；
  - `:110-113 subagentSlug`（`input.slug`）、`:116-119 subagentModel`（`input.model`）、
    `:122-125 subagentThinkingLevel`；
  - `:138-152 subagentId`（**`JSON.parse(tool.output)`** 取 `subagentId`；注释 `:130-137` 说明
    output 形态 = `{action, subagentId, sessionFile, slug, bgResponse}`）。
- 点击：`:156-161 openSubagentDrawer` → `:160 openSubagent({virtualId: subagentVirtualId(mainSid, subId)})`
  （缺 `sessionId` 或 `subagentId` 时 no-op）。**层 2 的点击归宿同样是层 3。**

**`ToolRow.vue` 的 `__gui__` 通道（`SubagentRow` 不消费）**：

- `:356-369 guiComponent` = `extractGui(props.tool?.details)?.component`
  （final 优先，running 时回退 `detail` 单数）；
- `:347-354` 注释写明「extension RPC 模式把 GuiComponent 放进 `details.__gui__.component`，
  前端用 extractGui 统一校验版本后路由到 GuiComponentRenderer」；
- 渲染点 `:152-154`（`<GuiComponentRenderer :component="guiComponent" />`）**位于 `v-else`
  普通 tool 分支内部**（`:23` 起的 `<div v-else class="group/tool">`）——
  subagent / workflow 两分支在 `:16` / `:19` 已提前返回，结构上永不达 `:152`。

**系统通知类**：

- `subagent-directive` 定向气泡：`SystemNotice.vue:12-22`（`data-testid="subagent-directive-bubble"`，
  `:19` slug chip），判定 `:159-162`（`props.message.customType === SUBAGENT_DIRECTIVE_CUSTOM_TYPE`）；
  customType SSOT = `extension-protocol/src/extensions/subagent-notify/custom-types.ts:34`。
- `subagent-bg-notify` / `workflow-result`：**不进对话流外部行**——
  `COMPLETE_NOTIFY_CUSTOM_TYPES`（`shared/message.ts:33-37`）作 turn 边界触发器；
  `Turn.vue:30` 注释明确「隐藏通知（subagent/workflow）无外部行」。
- 折叠通知图标 / 文案：`folded-notice.ts:14`（`subagent: Bot`）+ `:22,30,37` 三个 i18n key。

**其它行内涉及**：

- `TurnSummary.vue:98`（`isSubagentVirtualId` → 只显复制/朗读，无 fork/handoff；`:58` 注释）；
- `message-stream/ActivityStrip.vue:162-171,223-226`（虚拟 session 的 `subagentThinking` 呼吸弧）；
- `useBackgroundWork.ts:35`（`hasRunning(sid, {excludeOrigin:'workflow'})` 参与 session working 判定）；
- `block-icon.ts:72-77 getBlockIcon`（优先级：`status==='running'` 覆盖一切 → `isSubagent` → `isWorkflow` → toolName）。

### 3.2 固定点清单（5 处 / 3572 行）

| # | 固定点 | 位置 | 为什么是固定点 |
|---|---|---|---|
| L2-1 | 工具名集合硬编码分派 | `shared/src/constants.ts:29-34` + `ToolRow.vue:312` | 新增 agent 类工具必须改 shared 常量（跨包契约）+ core block 分类 |
| L2-2 | `SubagentRow` 专属行组件 | `SubagentRow.vue` 全 162 行 | 布局（agent/slug/model/thinking/failtag）+ 视觉（`--name` 色）全专属 |
| L2-3 | **`tool.input` 本地解析**（非协议） | `SubagentRow.vue:90-152` | 依赖 `input` schema 形状（`agent`/`slug`/`model`/`thinkingLevel` 在顶层）；`output` 靠 `JSON.parse` |
| L2-4 | `__gui__` 通道存在但被 subagent 分支绕过 | `ToolRow.vue:16` vs `:152` | 结构性：分派先于 gui 渲染点，subagent 分支永不达 |
| L2-5 | `agentgraph` block kind 硬编码 | `core/domain/chat/assistant-blocks.ts:16,25-27` | 新增 agent 类需改 core block 分类 + `Block.vue:69-73` 分派 |

**补充事实（数据质量层面的隐藏缺陷）**：`SUBAGENT_TOOL_NAMES` 含 `subagent_manage` 与
`subagent_message`，但 `SubagentRow` 全篇按 **start 参数形状** 解析（`input.agent`/`input.slug` 顶层）。
manage 的 input 是 `{action:'list'|'cancel'|'close', listParam/cancelParam/closeParam}`、
message 的 input 是 `{action:'message', messageParam:{...}}`——两者都无顶层 `agent`/`slug`，
故渲染时 agent 名恒落 `general-purpose` 缺省（`:106`）、slug 恒空；`subagentId` 靠
`output.subagentId`，而 manage 的 list 输出是 `listResponse` 数组（顶层无 `subagentId`）→ 点击 no-op。
**这是「一个组件承担三种工具形态」的既有缺陷**，插件化评估必须计入（也正是声明式 UI 的相对优势面）。

### 3.3 插件化改造方案（可行度：高，且能顺带修上面那条缺陷）

**判定：可行，且是最划算的一层。** 插件侧**已经在产 GuiComponent**：

```
extensions/universal/subagent-workflow/src/interface/gui/subagent-actions.ts
  :124 buildGuiComponent(input, result)
    - start      → card( header = slug | id 前 N 位, body = [stats-line] )   :133-138
    - list       → list-tree( items = [{label:'agent · slug · subagentId', status, icon}] )  :142-152
    - message    → stats-line([{label:'messaged', value:subagentId, severity:'ok'}])  :154-157
    - fork-from / cancel / close → stats-line（:160-179）
  挂载点 :100 withGuiAttach(detailsBase, ctx, () => buildGuiComponent(input, result))
  helpers 定义 extensions/universal/subagent-workflow/src/interface/tool/tool-shared.ts:123
  isGuiCapable 仅 mode==='rpc'（extension-protocol/src/core/helpers.ts:27）
```

**改造 = 把 `__gui__` 的消费点从「普通 tool 分支」移到「subagent 分支」**，两个方案：

方案 A（最小改动，推荐先做）：`SubagentRow` 增加 `__gui__` 读取
- 在 `SubagentRow.vue` 内加 `guiComponent = extractGui(tool.details)`（或复用 `ToolRow` 已算好的
  `guiComponent` 经 prop 传入），有值时渲染 `GuiComponentRenderer` 替代手写单行；
  无值时保留现有 fallback（向后兼容存量会话 + 非 rpc 模式）。
- 成本约 +20 行；收益：插件侧调整行内呈现不再需要改 taiji 源码。
- **前置条件**：`__gui__` 只在 `mode==='rpc'` 产出，fallback 必须保留。

方案 B（彻底）：由插件决定整行形态，宿主只做「shell + 点击容器」。
- 需宿主提供「点击整行 → 携带上下文执行命令」的原语（与层 1 同一缺口），
  或保留 `subagent-block` 外壳、内部全交 `GuiComponentRenderer`。
- 前置依赖：`openSubagent` 归宿无法由 GuiComponent 表达（`action-bar` 只能 `commandId`，
  无「打开 drawer」原语）。

**附带收益**：`buildGuiComponent` 已按 `input.action` 分支（start/list/message/cancel/close/fork-from），
天然解决 §3.2 补充事实的「一组件三形态」缺陷——这正是声明式 UI 相对专属组件的核心优势。

---

## 4 层 3：drawer 一级 tab

### 4.1 现状（锚点）

**tab 位**：`packages/core/src/domain/drawer/types.ts:24`
`RightDrawerTab = string`（容器统一批次去枚举；内置 8 员 = `RIGHT_DRAWER_TAB_IDS` 已知值 + `isKnownRightDrawerTab` 判别，编译层锁已拆）。

**注册表条目**：`packages/core/src/domain/drawer/registry.ts:97-104 SUBAGENT_ENTRY`
```
{ content:'subagent', text:'subagent（子代理）', icon:'bot',
  labelKey:'panel.sideDrawer.tabSubagent',
  emptyTextKey:'panel.sideDrawer.noSubagent',
  emptyHintKey:'panel.sideDrawer.subagentHint' }
```
数组位置 `:156-165 RIGHT_DRAWER_REGISTRY`（第 4 位，`:160`）。
图标标识→组件映射：`packages/ui/src/features/drawer/DrawerPanel.vue:181-193 ICON_BY_ID`（`:187 bot: Bot`），
tab 列表派生 `:201-209`（`RIGHT_DRAWER_REGISTRY.map`），fallback `:196 FALLBACK_ICON`。

**内容分支**：`packages/renderer/src/components/workspace/PanelContainer.vue:157`
`<SubagentTab v-else-if="drawerTab === 'subagent'" />`（8 tab 中 7 个是 `v-else-if`，
subagent 是第 4 个；`drawerTab` 来源 `:386 useDrawerControl().activeTab`）。
`SubagentTab` **无 props**——完全自治（读 core selection 分区 + store），不依赖 `panelSessionId`。

**`SubagentTab.vue`（522 行）结构**：

| 区块 | 行 | 说明 |
|---|---|---|
| 二级 tab 条 | `:26-62` | 恒渲染（单 tab / 空都不隐藏，`:24-25` 裁决）；`data-vid` + 关闭按钮；`role=tablist` |
| 空态 | `:65-73` | `Bot` 图标 + `noSubagent` + `subagentHint` |
| 标题栏（差异化层） | `:80-150` | agent · slug · 引擎 badge · `stopReason` · `ModelSelectPopover` · 模型来源 badge |
| 只读提示 | `:156-161` | `!composerVisible` 时显示 |
| coarse 提示 | `:165-172` | 非 pi 引擎 running（`:441-445`） |
| 流降级提示 | `:177-185` | `chatStore.isSubagentStreamDegraded`（`:449-454`） |
| 错误态 | `:188-205` | `loadError` + outcome 摘要兜底 + retry（`:518-521`） |
| **对话流** | `:212-217` | `<MessageStream :session-id="activeTab" :main-session-id="panelStore.focusedSessionId" />` |
| composer 带 | `:224-226` | `<Composer :session-id="activeTab" :show-btw="false" subagent />` |

关键：`:214 :key="activeTab"`（切 tab 重挂）+ `:212` 直接复用主对话流 `MessageStream`，
文件头 `:4-6` 明写「D3 完整复用原则（硬约束）：直接挂主对话流同一个 MessageStream……
不重写任何对话流渲染」。

**数据编排（已下沉 composable）**：

- `useSubagentTabData.ts`（210 行）：`loadSubagentData`（拉历史 + 订阅流 + outcome 兜底 + task 气泡种入）、
  `stopSubagentStream`、`loadError`；`STREAM_SCOPE='drawer:subagent'`（`:67`）；
  deps 契约见 `:41-59`（`streamScope` 可选，overlay 用独立 token 防互停）。
- `useSubagentDrawerTabs.ts`（70 行）：二级 tab 编排（`:43 openDrawerTab`、`:60 clearSubagentSelection`、
  `:66 closeDrawerIfTabsEmpty`）。
- `subagent-composer-lane.ts`（154 行）：`isSubagentComposerEligible`（`:50`）、
  `useSubagentComposerLane`（`:57`，发送 `:81 subagentAction('message')`、中止 `:97 cancelSubagent`）、
  `wireSubagentLaneTerminals`（`:136`）。
- `useSubagentModel.ts`（368 行）：模型标签四分支合成 + `setModel` 回执写状态（禁乐观写）。
- store：`stores/subagent.ts`（515 行）——`recordsOf`（`:186-194`）、`applyRecords`（`:226-228`）、
  `drawerTabs` 分区（`:237`）、`loadSubagents`（`:318`）、stream 订阅表（`:161`）。

**打开入口（3 个）**：

1. 托盘行点击：`TrayNativePanel.vue:514`；
2. 对话流行点击：`SubagentRow.vue:160`；
3. workflow agentcall：层 4 的 `AgentStreamDrawer` + `useSubagentDrawerTabs`。

### 4.2 固定点清单（12 处 / 3137 行）

| # | 固定点 | 位置 | 为什么是固定点 |
|---|---|---|---|
| L3-1 | `RightDrawerTab` 八值联合 | `packages/core/src/domain/drawer/types.ts:22` | 新增 drawer tab 必须改类型（编译层锁） |
| L3-2 | `SUBAGENT_ENTRY` 元信息 | `packages/core/src/domain/drawer/registry.ts:97-104` | icon 字符串 + 3 个 i18n key 写死 |
| L3-3 | `RIGHT_DRAWER_REGISTRY` 数组位置 | `drawer/registry.ts:156-165` | tab 顺序 = 数组序 |
| L3-4 | `ICON_BY_ID` 映射 | `DrawerPanel.vue:181-193` | 新 icon 标识须入表，否则落 `FALLBACK_ICON`（`:196`） |
| L3-5 | `PanelContainer` 七分支 `v-else-if` | `PanelContainer.vue:146-176` | 每个 tab 一个专属组件，无法注册 |
| L3-6 | `SubagentTab` 标题栏专属布局 | `SubagentTab.vue:80-150`（71 行） | 引擎 badge / stopReason / 模型切换 / 来源标注，四类专属元信息 |
| L3-7 | `MessageStream` 挂载（对话流复用） | `SubagentTab.vue:212-217` | **不可替代资产**（见 §7.1 缺口 1） |
| L3-8 | `Composer` subagent 车道挂载 | `SubagentTab.vue:224-226` + `subagent-composer-lane.ts:50,57,136` | 发送/中止分流到 `session.subagentAction` |
| L3-9 | 二级 tab 条 + 关闭编排 | `SubagentTab.vue:26-62` + `useSubagentDrawerTabs.ts:43,60,66` | 多 subagent 并行、关空关抽屉 |
| L3-10 | 五类状态提示条 | `SubagentTab.vue:156-205`（只读/coarse/降级/错误/outcome） | 非 pi 引擎降级语义专属 |
| L3-11 | selection 分区写入 | `core/domain/drawer/selection/subagent.ts:23,53,62` + `drawer/coordination.ts:74-77` | `selectedSubagentId` per-session 分区 |
| L3-12 | 数据编排三件套 | `useSubagentTabData.ts`(210) + `useSubagentDrawerTabs.ts`(70) + `useSubagentModel.ts`(368) | 虚拟 id 三段式管线 + 模型切换回执 |

### 4.3 插件化改造方案（可行度：低，仅标题栏可迁）

**判定：整 tab 不可插件化，但可拆成「宿主壳 + 可插槽的头尾两段」。**

不可行的硬理由：

1. **`MessageStream` 不可替代**：它承载整个对话流渲染树（Turn / Block / ToolRow / ThinkingRow /
   MarkdownRenderer / MermaidRenderer / 图片 / 折叠 / 虚拟滚动 / 跟底 / 查找），约 6000 行
   （`ui/src/features/chat/` 27 文件 6414 行）。`GuiComponent` 的 11 个原语没有「对话流」概念，
   `ansi-text` 只能渲染预格式化 ANSI 行（`primitives/AnsiText.vue` 159 行，`ansi_up` 转 HTML），
   会把 markdown / 代码高亮 / mermaid / 图片全部降级成纯文本。
   **这是 subagent 域真正的护城河：内容不是声明式 UI，是「另一个会话的完整对话」。**
2. **composer 车道不可表达**：`text-input` 只有 `value` + `onUiEvent`（值变更回传），
   没有「提交」动作语义（`extension-protocol/src/core/types.ts:126-134`）；而 lane 需要发送 / 跟随 / 中止三种终端
   （`wireSubagentLaneTerminals`，`subagent-composer-lane.ts:136`）。

可行部分（收益明确但都不足以整 tab 迁出）：

- **标题栏（L3-6，71 行）可迁**：四类元信息（引擎 / stopReason / 模型 / 来源）全部可由插件在
  `setWidget` 的 `meta` 或 `card(header+stats-line)` 表达。但模型切换是**交互**
  （`ModelSelectPopover` → `subagent.setModel`），需 `action-bar` + 命令链承接
  ——`subagent.setModel` RPC 已存在（`transport/subagent-message-handler.ts:34`），可包成插件命令。
  **阻塞点**：无 select/popover 原语（`types.ts` 11 原语里没有下拉选择器）。
- **二级 tab 条（L3-9）可迁但无意义**：`tab-bar` 有 `tabs + sections` 容器化分段
  （`extension-protocol/src/core/types.ts:86-95`，`primitives/TabBar.vue` 159 行本地持 active index）。但 `sections` 的子树
  仍是 GuiComponent，**无法把 `MessageStream` 塞进去**——只能迁「tab 条本身」，内容仍宿主渲染。
  收益/成本比差，不建议。
- **空态 + 五类提示条（L3-10）部分可迁**（`card` + `ansi-text`），但它们是状态机分支，
  分散迁出会让「什么情况下显示什么」跨越插件/宿主两处，违反单一事实源。

**推荐形态**：drawer tab 保留（宿主），但把 tab **内容容器化**为
「宿主 MessageStream + 插件产 header 区」两段——即把 `SubagentTab` 的标题栏换成 `ViewHost`
挂到新挂载点（如 `drawer.tab.header`），tab 位与内容实例仍归宿主。

---

## 5 层 4：overlay 一级 tab

### 5.1 现状（锚点）

**overlay 一级 tab 位**：`packages/renderer/src/components/panel/workflow-viz/overlay/workflow-viz-overlay.ts:68`
`OverlayTab = string`（容器统一批次去枚举；内置三已知值 = `OVERLAY_TAB_IDS`：'runs' / 'scheduler' / 'canvas'）——**subagent 不在内置 tab 中**。

**tab 条**：`WorkflowVizOverlay.vue:428-432 tabSegments`
```
[{ value:'runs',      label: overlayTabRuns,      icon: Workflow },
 { value:'scheduler', label: overlayTabScheduler, icon: Clock },
 { value:'canvas',    label: overlayTabCanvas,    icon: Network }]
```
渲染 `:147-163`（`data-testid="wfvz-overlay-tab-${seg.value}"`）；
`runs` 在无 run 时禁用（`:156 :disabled`，`:435-437 onTabClick` 二次守卫）。
body 三分支：`:168`（runs = DAG + live dock）/ `:308`（canvas = `CanvasPane` 异步组件）/ `:326`（scheduler = `ViewHost`）。

**overlay 内容类型（core SSOT）**：`packages/core/src/domain/overlay/types.ts:55-59`
```
OverlayContent = {kind:'browser'} | {kind:'workflow'} | {kind:'scheduler'} | {kind:'canvas'}
```
四种 payload 各自带 `sessionId`（scheduler `:40-42`、canvas `:48-52`、workflow `:32-35`、browser `:25-29`）。

**subagent 在 overlay 内的实际形态**：不是一级 tab，而是 **run 级右侧 drawer**：

- `WorkflowVizOverlayHost.vue:69-75` 挂 `<AgentStreamDrawer v-if="isWorkflowOpen && panelInput">`；
- `AgentStreamDrawer.vue`（200 行）：`fixed right-0 w-[452px] z-[calc(var(--z-dialog)+1)]`（`:24`），
  多 tab（每 tab = 一个 agent call），`openAgent` 在 `:168-173`（`status==='pending'` 或无 `sessionId` 时 no-op），
  `defineExpose({openAgent})` 在 `:199`；
- 内容 `AgentTabContent.vue`（133 行）：`:39 <MessageStream :session-id="virtualId" :main-session-id="sessionId" />`，
  `virtualId` = `subagent:<mainSid>:<memberRecordId>` 三段式（`:51 subagentVirtualId`），
  独立 `streamScope`（`:69-71` 注释：防与 drawer 互停订阅）；
- 触发：`WorkflowLivePanel`（trace 行 / DAG 点击）→ `@open-agent` → `agentDrawerRef.openAgent`（Host `:61`）。

**与 drawer 的分工（现存事实）**：

| 维度 | 层 3 drawer subagent tab | 层 4 overlay agent drawer |
|---|---|---|
| 归属 | 主 session 的子代理（tool 派发，`origin:'tool'`） | workflow run 的 agent call（`origin:'workflow'`） |
| 虚拟 id | `subagent:<mainSid>:<subId>` | `agentcall:<acsId>` 或 `subagent:<mainSid>:<memberRecordId>` |
| 实时流 | 恒订阅（`STREAM_SCOPE='drawer:subagent'`） | 独立 scope；agentcall 快照只拉历史不订阅（`SubagentTab.vue:12-13` 注释） |
| 容器 | 右抽屉（与 git/doc/detail 并列） | 浮层内右侧 fixed 抽屉（浮在 overlay 壳上，z+1） |
| composer | 有（subagent 车道） | 无 |
| 关闭联动 | 关空即关抽屉（`closeDrawerIfTabsEmpty`） | 随 overlay 开合消亡（`v-if` 构造性清 tab） |

### 5.2 固定点清单（6 处 / 1541 行）

| # | 固定点 | 位置 | 为什么是固定点 |
|---|---|---|---|
| L4-1 | `OverlayTab` 三值联合 | `workflow-viz-overlay.ts:63` | 新增一级 tab 必改联合类型 |
| L4-2 | `tabSegments` 硬编码数组 | `WorkflowVizOverlay.vue:428-432` | 每段 label + icon 手写 |
| L4-3 | body 三分支 `v-if/v-else-if` | `WorkflowVizOverlay.vue:168,308,326` | 每 tab 一个专属内容组件 |
| L4-4 | `OverlayContent` 四值判别联合 | `packages/core/src/domain/overlay/types.ts:55-59` | 新增内容类型必改 core（含 payload 形状） |
| L4-5 | `AgentStreamDrawer` 专属壳 | `AgentStreamDrawer.vue` 全 200 行 | 452px fixed 定位 + 多 tab 集 + `openAgent` expose 契约 |
| L4-6 | `AgentTabContent` 专属内容 | `AgentTabContent.vue` 全 133 行 | meta 快照条 + 错误重试 + `MessageStream` 挂载 |

**注意（正面样板证据）**：`scheduler` tab 内容**已经是插件产树 + ViewHost 渲染**
（`WorkflowVizOverlay.vue:326 <ViewHost :view-id="SCHEDULER_MODAL_VIEW_ID" :scope="{kind:'session', sessionId}" empty="hidden" />`），
只有 tab **位**写在联合类型里。这证明「overlay 内容可插件化」的机制已跑通一个，
缺的是「tab 位注册」这一层抽象。

### 5.3 subagent 应否进 overlay 一级 tab？（结论：不应）

**反对进一级 tab 的四条论据**：

1. **语义层级错配**：overlay 一级 tab 的三个成员都是「同一 payload 的不同视角」——
   `runs` = run 的 DAG 图，`scheduler` = 该 session 的定时任务，`canvas` = 该 session 的画布。
   subagent 是 run 的**下级实体**（`WorkflowAgentCall.memberRecordId` → `SubagentRecord.subagentId`；
   `WorkflowAgentCall` 定义 `shared/src/workflow.ts:52-140`），进一级 tab 会把「视角切换」与
   「实体钻取」混在同一 tab 条（违反容器语义分区：一级 = 容器能力，二级 = 内容实例）。
2. **已有等效能力且更合适**：`AgentStreamDrawer`（L4-5）已提供「run 内 agent 钻取」，
   且**带多 tab 并行 + 全高纵向**（452px），比 overlay 一级 tab 的 88%×92% 面板内嵌更符合阅读长对话
   （`OverlayShell.vue:47` 面板尺寸）。
3. **会制造第三套 subagent 容器**：现有两套（drawer tab / overlay agent drawer），
   加一套 = 同一个 `MessageStream` 挂载点变三处，`streamScope` 隔离矩阵从 2×2 变 3×3，
   `useSubagentTabData` 的 scope token 语义进一步复杂化（现已需防「drawer 与 overlay 互停订阅」，
   `useSubagentTabData.ts:53-58` 注释）。
4. **本层收益与成本倒挂**：进一级 tab 只换来「不用先开 run 就能看 agent」，
   而该需求已被「托盘行点击 → drawer」覆盖（层 1 L1-6）。

**替代方案（若确需 overlay 内直达）**：

- 增加 `OverlayContent` 的 `{kind:'subagent', payload:{sessionId, subagentId}}`，但**不开一级 tab**，
  而是让 `WorkflowVizOverlayHost` 在 `kind==='subagent'` 时**直接以 `AgentStreamDrawer` 单 tab 形态打开**
  （复用现有壳，零新容器）。这样「overlay 承载 subagent 详情」成立，且不污染 tab 条语义。
- 需同改的级联点：`closeWorkflowVizOverlayForSession`（`workflow-viz-overlay.ts:159-167`）的
  载荷 `sessionId` 判定。

---

## 6 规模统计

全部数字为 `wc -l` 实测（2026-10-24，工作树当前状态）。

### 6.1 分层源码规模

| 层 | 文件数 | 行数 | 固定点 |
|---|---:|---:|---:|
| L1 composer 入口 | 6 | 1834 | 6 |
| L2 对话流行内 | 13 | 3572 | 5 |
| L3 drawer 一级 tab | 12 | 3137 | 12 |
| L4 overlay 一级 tab | 6 | 1541 | 6 |
| 合计 | 37 | 10084 | 29 |

分层明细：

| 层 | 文件 | 行数 |
|---|---|---:|
| L1 | `tray/useTrayCounts.ts` | 373 |
| L1 | `tray/TrayNativePanel.vue` | 567 |
| L1 | `tray/ComposerTray.vue` | 607 |
| L1 | `tray/TrayConfirmButton.vue` | 67 |
| L1 | `tray/TrayAggregatePanel.vue` | 130 |
| L1 | `lib/subagent-bucket.ts` | 90 |
| L2 | `ui/features/chat/SubagentRow.vue` | 162 |
| L2 | `ui/features/chat/ToolRow.vue` | 487 |
| L2 | `ui/features/chat/Block.vue` | 150 |
| L2 | `ui/features/chat/SystemNotice.vue` | 359 |
| L2 | `ui/features/chat/block-icon.ts` | 152 |
| L2 | `ui/features/chat/RunningBlockIcon.vue` | 336 |
| L2 | `ui/features/chat/WorkflowRow.vue` | 132 |
| L2 | `panel/MessageStream.vue` | 576 |
| L2 | `panel/message-stream/ActivityStrip.vue` | 342 |
| L2 | `composables/panel/useSubagentThinking.ts` | 56 |
| L2 | `composables/features/chat/useBackgroundWork.ts` | 40 |
| L2 | `composables/effects/useMessageEffects.ts` | 279 |
| L2 | `core/coordination/route-inbound.ts` | 501 |
| L3 | `panel/SubagentTab.vue` | 522 |
| L3 | `stores/subagent.ts` | 515 |
| L3 | `composables/panel/useSubagentTabData.ts` | 210 |
| L3 | `composables/panel/useSubagentDrawerTabs.ts` | 70 |
| L3 | `composables/features/subagent/useSubagentModel.ts` | 368 |
| L3 | `composables/panel/subagent-composer-lane.ts` | 154 |
| L3 | `packages/core/src/domain/drawer/types.ts` | 45 |
| L3 | `packages/core/src/domain/drawer/registry.ts` | 178 |
| L3 | `core/domain/drawer/coordination.ts` | 158 |
| L3 | `core/domain/drawer/selection/subagent.ts` | 78 |
| L3 | `ui/features/drawer/DrawerPanel.vue` | 285 |
| L3 | `components/workspace/PanelContainer.vue` | 554 |
| L4 | `workflow-viz/overlay/WorkflowVizOverlay.vue` | 588 |
| L4 | `workflow-viz/overlay/WorkflowVizOverlayHost.vue` | 307 |
| L4 | `workflow-viz/overlay/workflow-viz-overlay.ts` | 227 |
| L4 | `workflow-viz/panel/AgentStreamDrawer.vue` | 200 |
| L4 | `workflow-viz/panel/AgentTabContent.vue` | 133 |
| L4 | `packages/core/src/domain/overlay/types.ts` | 86 |

### 6.2 对称件的测试规模（改造必须同步改的回归面）

| 层 | 测试文件数 | 行数 |
|---|---:|---:|
| L1 | 4 | 3094 |
| L2 | 3 | 2291 |
| L3 | 2 | 1556 |
| L4 | 0（归 workflow 测试族） | — |
| 合计 | 9 | 6941 |

L1 明细：`composer-tray.test.ts` 1287 / `tray-native-panel.test.ts` 1032 /
`useTrayCounts.test.ts` 565 / `tray-session-panel.test.ts` 210。
L2 明细：`subagent-tab.test.ts` 803 / `turn-working.test.ts` 996 / `chat-subagent-stream.test.ts` 492。
L3 明细：`subagent-tab.test.ts` 803 / `stores/subagent.test.ts` 753（与 L2 有重叠计一项）。

### 6.3 域外依赖（改造会牵动的上游规模）

| 组件 | 文件数（非测试） | 行数 |
|---|---:|---:|
| `extensions/universal/subagent-workflow/src/` | 41 | 13820 |
| └ `interface/tool/` | — | 3005 |
| └ `interface/tui/` | — | 3104 |
| └ `interface/command/` | — | 1189 |
| └ `interface/gui/` | — | 588 |
| └ `host/` | 3 | 942 |
| └ `injectors/` | — | 752 |
| `packages/subagent-core/src/`（非测试） | 195 | 56440 |
| runtime 中转 10 文件 | 10 | 6986 |
| 协议侧 `extension-protocol/src/extensions/subagent-*` | 8 | 497 |

runtime 中转 10 文件明细：`inflight-mirror` 127 / `journal-report-router` 46 /
`session-records` 1958 / `events-projection` 822 / `subagent-extractor` 768 /
`subagent-status` 135 / `workflow-step-merge` 274 / `workflow-record-projection` 411 /
`event-adapter` 2099 / `subagent-tee` 346。

### 6.4 全域 subagent 词频分布（renderer，非测试）

`grep -l subagent packages/renderer/src --include=*.ts --include=*.vue | grep -v __tests__` =
**61 文件 / 15543 行**；提及 subagent 的行数合计约 **700 行**（占 4.5%）。
即「subagent 相关」文件里绝大部分是通用组件（`Composer.vue` 621 行仅 1 处提及、
`PanelContainer.vue` 554 行 10 处、`composer-shell.ts` 739 行 26 处），
真正专属的是 §6.1 那 37 个。

测试侧：`__tests__` / `*.test.*` 中含 subagent 的 **82 文件**。

### 6.5 关键计数

- drawer tab 总数：**8**（`RIGHT_DRAWER_REGISTRY` 8 条数组元素；`PanelContainer` 7 个 `v-else-if`
  + 第 1 个 git 用 `v-if`）。
- overlay 一级 tab：**3**（`OverlayTab`）；`OverlayContent` 判别联合 **4** 值（含 browser 无 tab）。
- composer built-in 件：**5**（`TrayBuiltinKind`）；协议 widget 区条目数 = 运行时动态（`getViewIds`）。
- `GuiComponent` 原语：**11** 个（§7.1）；有 Vue 实现的 **10** 个（`custom` 无 provide 点）。
- 已注册挂载点：**5**（`core/src/bootstrap.ts:73-80`）。
- pi 工具：**7**（`subagent_start`/`subagent_manage`/`subagent_message`/`subagents`/`workflow_run`/
  `workflow_control`/`workflow-script`）；command **3**（`subagents`/`workflows`/`subagent-model`）。

---

## 7 改造方案与依赖

### 7.1 GuiComponent 原语表达力评估

11 个原语（`packages/extension-protocol/src/core/types.ts:36-141`），逐个对应 subagent 域的 UI 需求：

| 原语 | 定义行 | 字段（含可选） | subagent 域可表达 | 缺口 |
|---|---:|---|---|---|
| `ansi-text` | 38-40 | `lines: string[]` | 一切内容的兜底 | 无交互、无结构；markdown/图片/mermaid 全降级 |
| `card` | 45-49 | `variant?`, `header?: GuiComponent\|string`, `body: GuiComponent[]` | 层 2 行内块（插件已用，`subagent-actions.ts:133`） | 无 onClick、无折叠态 |
| `stats-line` | 52-54 | `items: StatItem[]`（`label?`,`value`,`severity?`,`icon?`，`extension-protocol/src/core/types.ts:192-197`） | 层 2 「N turns · Nk · Ns」、层 3 标题栏元信息 | 纯展示，无交互 |
| `progress-bar` | 57-63 | `label?`,`current`,`total`,`unit?`,`severity?` | workflow 行进度、subagent tokens 进度 | 同上 |
| `list-tree` | 66-71 | `items: TreeItem[]`（`icon?`,`label`,`status?`,`depth?`,`children?`，`:199-205`）, `numbered?` | 层 1 托盘列表、层 2 list action 结果（插件已用，`:142`） | **行不可点**（`TreeItem` 无 onClick/commandId/id） |
| `group` | 75-77 | `children: GuiComponent[]` | 任意组合根 | 无 |
| `columns` | 80-83 | `children: GuiComponent[]`, `ratios?: number[]` | 双列元信息布局 | 无 |
| `tab-bar` | 86-95 | `tabs: {label,active?,status?}[]`, `sections?: GuiComponent[][]` | **层 1 两视图（进行中/已结束）**、层 3 二级 tab 条（仅条） | sections 内容只能是 GuiComponent；tab 无 badge 数字 |
| `action-bar` | 104-116 | `items: {id,label,kind?:'danger',disabled?,commandId?,args?}[]` | 层 1 取消/关闭按钮、层 3 模型切换 | **无点击回传**（只 execute）；无二次确认；args 只标量 |
| `text-input` | 126-134 | `id,label?,placeholder?,value?,multiline?` | 层 3 composer 输入框（理论） | **无提交语义**；只有 value 变更回传（`onUiEvent`） |
| `custom` | 137-140 | `component: string`, `props: Record<string, unknown>` | 理论上可塞任意（含 MessageStream） | **注册表无 provide 点**（见下） |

**`custom` 逃生口的实际状态（死通道）**：
`GUI_CUSTOM_REGISTRY_KEY` 定义在 `core/src/rendering-protocol/custom-registry.ts:19`，
全仓**只有两处 inject、零处 provide**：`GuiComponentRenderer.vue:69`、`PrimitiveRouter.vue:50`。
`custom-registry.ts:6` 注释写「provide 的实际调用留在 ui 层（builtin 编译期 provide 是 ui 职责）」
但 ui 层未实装。且注册表类型是 `Readonly<Record<string, Component>>`（`:19`）+
`EMPTY_CUSTOM_REGISTRY = Object.freeze({})`（`:25`）——设计上就只允许 builtin 编译期 provide。
**含义**：即便内置插件也不能注册自定义组件，A 类样板的极限就是上面 10 个可用原语。

**结论矩阵**：

| subagent UI 需求 | 可用原语 | 判定 |
|---|---|---|
| 层 1 托盘图标 + 计数徽标 | `WidgetMeta`（非 GuiComponent）+ `TrayWidgetButton` 既有链 | **表达得了**（todo/goal 已证） |
| 层 1 托盘行列表（agent/slug/turns/tokens/耗时/task） | `list-tree`（`label` 拼串 + `status` 圆点） | 表达得了（信息密度略降，多字段需拼成 label） |
| 层 1 行点击打开详情 | — | **表达不了**（`list-tree` 无点击） |
| 层 1 行内两段式取消 | `action-bar` | **部分**（可发命令；无确认态回传 + 缺点击回执） |
| 层 2 行内单行摘要 | `card` + `stats-line` | **表达得了**（插件已实现，宿主未接） |
| 层 2 失败 chip | `stats-line` 的 `severity:'danger'` | 表达得了 |
| 层 2 running 呼吸弧 | — | **表达不了**（无动效原语；可退化为 `status:'running'` 圆点） |
| 层 3 标题栏四类元信息 | `card(header)` + `stats-line` | 表达得了 |
| 层 3 模型切换下拉 | `action-bar`（无下拉原语） | **表达不了**（无 select/popover 原语） |
| 层 3 二级 tab 条 | `tab-bar` | 条表达得了，sections 内容不行 |
| 层 3 **对话流** | — | **表达不了**（决定性缺口，见下） |
| 层 4 agent drawer 壳（多 tab + fixed 定位） | `tab-bar` 可表达 tab 条 | 壳定位/尺寸属宿主职责，不属原语范围 |

**三个决定性缺口（按阻塞严重度排序）**：

1. **对话流原语缺失**：`MessageStream`（576 行壳）+ `ui/src/features/chat/`（27 文件 6414 行）
   + `MessageStream` 内部依赖（markdown 管线 / renderMarkdown / Mermaid / 图片 / virtua 虚拟滚动）。
   `ansi-text` 是唯一「自由内容」通道，但它吃的是**已渲染成 ANSI 的字符串行**
   （`primitives/AnsiText.vue` 用 `ansi_up` 转 HTML），丢失全部富交互。
   若要插件承载 subagent 详情，需要新原语（如 `session-stream: {sessionId, mode}`）
   或给 `custom` 补 provide 点。
2. **交互回传缺口**：`action-bar` 只有 `commandId` → `CommandRegistry.execute`
   （`action-executor-key.ts:18-20`），**执行后无回传给插件**；`text-input` 有 `onUiEvent`
   （`plugin-sdk/src/types.ts:905`）但只有值变更、无提交。
   所以「点击行 → 打开某容器」「二段式确认」「下拉选择」三类交互都无法由插件完成。
3. **`custom` 无提供点**：见上。逃生口当前是死通道。

### 7.2 需 runtime 配合的点

| # | 需求 | 现状 | 改动量 |
|---|---|---|---|
| R1 | 插件命令 → `session.subagentAction` 桥接（托盘取消、模型切换） | 命令链 = `CommandRegistry.execute` → WS `plugin.executeCommand`（`useExtensionHostBridge.ts:561`）；`subagentAction` handler 在 `transport/session-message-handler.ts:894-904`；`subagent.setModel` 在 `transport/subagent-message-handler.ts:34` | **小/零**：插件 handler 内部调即可，`args` 传 `sessionId`+`subagentId` |
| R2 | `setWidget` 的 subagent 推送落 session 分区 | 通道已通：`event-adapter.ts:675 tryDecodeWidgetGui` → `WIDGET_GUI` 帧 → `message-bus-bridge.ts:347` → `view-host-store.ts:120 consumeWidget` | **零改动** |
| R3 | 托盘计数是否改为插件推送 | `useTrayCounts` 当前直连 `subagentStore`（`recordsOf` + `isRunningProjection`） | 需裁决。**建议保留宿主派生**（计数口径已 SSOT 在 `subagent-bucket.ts:40`，改由插件推 badge 会造第二口径） |
| R4 | 「插件承载详情」所需数据 RPC | `session.getSubagentHistory`（`session-message-handler.ts:764`）、`session.getSubagentStreamState`（`:770`）、`subagent.stream_chunk` 已有 | **零改动**（数据面够用），卡在渲染面缺原语 |
| R5 | 若新增 `OverlayContent {kind:'subagent'}` | `packages/core/src/domain/overlay/types.ts:55-59` + `overlay/coordination.ts:35 openOverlay` + `workflow-viz-overlay.ts:159-167` 级联 | 小：加类型 + payload + 级联判定分支 |

**runtime 侧的正面事实（改造不触碰）**：`inflight-mirror`（127 行）与 `journal-report-router`（46 行）
都是**纯旁路**，既不广播也不落盘；`event-adapter.ts:1803`/`:1810` 双封口结构性禁止 marker 帧进前端。
`session.subagents` 全量帧（`session-records.ts:916`）与 `session.subagentEntriesAppended`
（`subagent-tee.ts:225`）是两条独立通道：前者服务列表、后者服务对话流。
`session.subagentEntriesAppended` 虽登记为 `state` 类但在 `STATE_NO_KEY_TOPICS` 例外清单
（不入快照、不入 ring），因为它是增量流非 last-value。

### 7.3 需 pi extension 配合的点

| # | 需求 | 现状 | 改动量 |
|---|---|---|---|
| E1 | subagent 列表推 `setWidget('subagent', {gui, meta})` | **未实现**。`grep setWidget` 仅命中 streaming sink（`subagent-workflow/src/session-lifecycle.ts:445`，key=`subagent-stream-<recordId>`，被 `event-adapter.ts:724` 拦截走 tee 路径） | 中：新增推送点（record 变化时），产 `tab-bar + list-tree`，填 `meta{title,status,badge,icon:'bot'}` |
| E2 | subagent 行内 UI 走 `__gui__` | **已实现**（`subagent-actions.ts:100,124`） | **零改动**，宿主接上即可（§3.3 方案 A） |
| E3 | 行内点击 / 取消 / 确认的交互通道 | 无 | 中：先解 §7.1 缺口 2，或改走 `commandId` + `args{subagentId}` |
| E4 | 模型切换下拉 | 无原语 | 大：需新增 select 原语，或保留宿主 `ModelSelectPopover` |
| E5 | 注册 `bot` 图标到 widget icon 白名单 | `WIDGET_ICON_ENTRIES`（`TrayWidgetButton.vue:166-177`）10 条无 `bot` | 极小（宿主改动）：加一行 |

**pi extension 侧可复用的既有资产**（改造不必重写）：

- `interface/gui/subagent-actions.ts`（588 行目录内）：完整 action → GuiComponent 映射；
- `interface/gui/gui-mappers.ts`：status → `TreeItem.status` / icon 枚举映射（`:34` 注释说明唯一生产调用方）；
- `host/` 层三个 reporter（inflight 193 / journal 204 / pi-host 545 行）与
  `callMarkerRpc` 通道已验证（`extension-protocol` 的 marker 体系）。

### 7.4 风险与不可行项

**不可行（不要尝试）**：

| # | 项 | 理由 |
|---|---|---|
| X1 | 用 GuiComponent 承载 subagent 对话流 | 无对话流原语；`ansi-text` 会把 markdown/shiki/KaTeX/mermaid/图片/虚拟滚动/查找全部降级。`MessageStream` 是 6000 行渲染树，重写它 = 重写整个对话流 |
| X2 | 把 `SubagentTab` 整体迁为插件 view | 同上 + composer 车道（`subagent-composer-lane.ts` 发送/中止分流到 `session.subagentAction`）无法用 `text-input` 表达（无提交语义） |
| X3 | subagent 进 overlay 一级 tab | 语义层级错配（§5.3）+ 制造第三套容器 + 三重 `streamScope` |
| X4 | 插件侧复刻 `isRunningProjection` 判据 | 判定权 SSOT 在 renderer（`subagent-bucket.ts:40`），复刻即造第二口径 |
| X5 | 让插件直连 `subagentStore` / renderer 状态 | 违反分层（插件跑 Worker/fork，无 renderer 上下文） |

**风险（做也要标注）**：

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| K1 | `__gui__` 只在 `mode==='rpc'` 产出（`helpers.ts:27 isGuiCapable`） | 裸 pi TUI / 非 rpc 模式下行内 fallback 必须保留，否则空渲染 | 双路径（有 gui 用 gui，无 gui 走现 `SubagentRow` 解析） |
| K2 | `list-tree` 信息密度不足以承载当前托盘行 | 托盘行有 6 类信息（引擎 icon / spinner / agent / slug / 3 个统计 / task 摘要）；`TreeItem` 只有 `label`+`status`+`icon`+`children` | 拼成单 label（`agent · slug · Nt · Nk · Ns`）+ 第三行用 `children` 嵌套；或接受密度下降 |
| K3 | 撤销宿主 built-in 分支会丢现有端到端测试 | L1 测试 3094 行 4 文件全部针对 built-in 三件；迁 widget 后需重写为 widget 区测试 | 分两 commit：先加 widget 推送并行跑，再删 built-in 分支 + 迁移测试 |
| K4 | 两套托盘机制并存期计数可能双显 | widget 区与 built-in 区同时渲染 subagent 条目 = 两个按钮 | 灰度期用 `aggregated` 档或 flag 门控；切换时同步删 built-in |
| K5 | `agentcall:` / `subagent:` 两种虚拟 id 的 `MessageStream` 复用 | 两个 `streamScope` 已存在，若再加容器需谨慎 | 复用 `useSubagentTabData` 的 `streamScope` 参数（`deps` 已支持，`:58`） |

---

## 8 可执行改造步骤（有序）

按「收益/风险比」排序。步骤 1-2 可独立交付；3-5 依赖裁决；6 不建议。

### 步骤 1：修 `__gui__` 断点（层 2，最低成本，收益立现）

1. `ToolRow.vue`：把已算好的 `guiComponent`（`:356`）作为 prop 传给 `SubagentRow`（`:16`）。
2. `SubagentRow.vue`：有 `guiComponent` 时渲染 `<GuiComponentRenderer :component="guiComponent" />`
   替代单行摘要；无值时保留现有全部解析逻辑（K1 fallback）。
3. 保持 `subagent-block` 外壳与 `@click="openSubagentDrawer"`（点击归宿不变）。
4. 测试：`turn-working.test.ts` / `subagent-tab.test.ts` 增两例（有 gui / 无 gui 渲染等价性）。

验证：dev 下跑一次 subagent 派发，对话流行应显示插件产的 `card(stats-line)`；
裸 pi `-ne` 模式下应回退到现手写单行。

### 步骤 2：给 widget icon 白名单补 `bot`（前置，1 行）

`TrayWidgetButton.vue:166-177 WIDGET_ICON_ENTRIES` 加 `['bot', Bot]`（import 同步加）。
否则步骤 3 的 `meta.icon='bot'` 会落 `console.warn` + `FALLBACK_WIDGET_ICON`（LayoutGrid）。

### 步骤 3：pi extension 侧新增 subagent widget 推送（层 1 前置）

1. `pi-subagent-workflow` 新增推送点：在 record 注册 / 状态迁移 / 终态 settle 三处
   （hooks 已在 `session-lifecycle.ts` / `subagents-events.ts`）调
   `setWidgetDual(ctx, 'subagent', { gui, meta })`。
2. `buildSubagentWidgetGui(records)` 纯函数（放 `interface/gui/`，与 `subagent-actions.ts` 同目录）：
   - 产 `tab-bar`：tabs = `[{label:'进行中 N', active:true}, {label:'已结束 M'}]`，
     `sections = [[list-tree(进行中)], [list-tree(已结束)]]`；
   - `list-tree.items` = `[{label:'agent · slug · Nt · Nk · Ns', status, icon}]`（见 K2）；
   - 分桶谓词**必须复用** `isRunningProjection` 语义（`status==='running' && !stopReason`），
     在插件内以等价实现书写并在注释标注「口径来源 renderer subagent-bucket.ts:40」。
3. `meta = { title:'Subagent', status: records 有 running ? 'running' : 'idle',
   badge: String(runningCount), icon: 'bot' }`。
4. 清屏：records 全空时 `setWidgetDual(ctx, 'subagent', undefined)`（对应 `view-host-store.ts:131` invalidate）。

### 步骤 4：宿主并行渲染 widget 区（灰度，不删 built-in）

不改 `BUILTIN_ORDER`，让 `ComposerTray.vue:238-273` 的 widget 区自然渲染新条目。
此时托盘会出现两个 subagent 按钮（K4），用 `aggregated` 档或临时 flag 避免误判。
验收点：widget 版 subagent 面板的 tab 计数与 built-in 版完全一致（同源数据，diff 应为空）。

### 步骤 5：删 built-in subagent 分支（层 1 收尾，依赖步骤 3-4 验收通过）

1. `ComposerTray.vue:341 BUILTIN_ORDER` 删 `'subagent'`；`:345-351 BUILTIN_ICONS` 删该项。
2. `useTrayCounts.ts`：`TrayTaskKind` 收窄（删 `'subagent'` 或整个 `TrayTaskKind` 面）；
   同步删 `:86 TRAY_BUCKETS.subagent`、`:105-114 TrayCounts.subagent`、`:120-131 TrayLists.subagent`、
   `:224-235` 派生、`:291-295` counts、`:318-330` 里的 `loadSubagents`、`:330-343 retry` 分支、
   `:352-370` errors/oversize/loading 的 subagent 项。
3. `TrayNativePanel.vue`：删 `:123-161` 的 subagent 模板分支、`:376-380 subagentRows`、
   `:504 isRunningSubagent`、`:514-516 openSubagentRow`、`:539-560` cancel 编排；
   `kind` 类型收窄（`:302`）。
4. 测试迁移：`tray-native-panel.test.ts`（1032 行）的 subagent 用例 → widget 区用例；
   `useTrayCounts.test.ts`（565 行）删 subagent 分桶断言；`composer-tray.test.ts`（1287 行）改断言目标。
5. `lib/subagent-bucket.ts` 的 `isRunningProjection` **保留**（其他消费方仍在用：
   `stores/subagent.ts:42`、`useBackgroundWork.ts:35`）。

### 步骤 6（不建议执行）：层 3 / 层 4 插件化

理由见 §4.3（`MessageStream` 不可替代）与 §5.3（语义层级错配）。
替代动作（低成本、收益明确）：

- **层 3 标题栏容器化**：`SubagentTab.vue:80-150` 换成 `ViewHost`（新挂载点，如 `drawer.tab.header`）。
  前置：`registerMountPoints`（`core/src/bootstrap.ts:73-80`）加一点 + 插件产 `card(header)+stats-line`。
  阻塞：模型切换需 select 原语（E4）。
- **层 4 直达**：`OverlayContent` 加 `{kind:'subagent'}`，Host 以 `AgentStreamDrawer` 单 tab 形态打开
  （§5.3 替代方案，零新容器）。

### 依赖图

```
步骤 2 (bot icon) ──► 步骤 3 (ext 推送) ──► 步骤 4 (并行验收) ──► 步骤 5 (删 built-in)
步骤 1 (__gui__ 接线) ── 独立，可并行
步骤 6 ── 需先裁决 §7.1 缺口 2（交互回传）+ 新原语设计，本轮不动
```

---

## 9 相关文档

- [docs/todo/plugin-pluginization.md](../plugin-pluginization.md)——父文档（四层固定点总图 + 全域对照表）
- [docs/plugins/architecture.md](../../plugins/architecture.md)——插件架构总览（四层模型 / 贡献点契约）
- [docs/plugins/extension-points.md](../../plugins/extension-points.md)——三层扩展点盘点
  （R37 托盘固定 / R39 customType 硬编码 / G4 drawer tab 集未注册）
- [docs/architecture/extension-gui-protocol.md](../../architecture/extension-gui-protocol.md)——GuiComponent 渲染协议
- [docs/extensions/subagents/architecture.md](../../extensions/subagents/architecture.md)——subagent 包拓扑与机制落点
- [docs/extensions/subagents/engine-development-guide.md](../../extensions/subagents/engine-development-guide.md)——引擎契约
- `docs/domain-model.md`——本域未登记（无聚合/不变量条目），若改造涉及状态机需补登
