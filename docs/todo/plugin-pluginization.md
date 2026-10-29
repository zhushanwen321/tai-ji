# 插件化改造：把固定实现迁成插件（跨 composer / 对话流 / drawer / overlay 全链路）

状态：未解决（2026-10-24 登记；扫描与分域分析进行中，设计待裁决）

## 现状

taiji 已完成插件化基础设施（`PluginService` / `ContributionRegistry` / `MountPointRegistry` / `ViewHost` / `GuiComponent` 协议），但**大量本可由插件承载的功能仍写死在宿主**——新增一个同类能力必须改 taiji 源码。

横向对照（pi extension 侧已实装的能力 vs renderer 侧的实现形态）分三类：

| 类型 | 含义 | 例子 |
|---|---|---|
| A 已插件化 | 插件产 `GuiComponent` 树，宿主用通用容器渲染 | todo / goal（托盘 widget 区，前端零专属代码） |
| B 半插件化 | 数据由插件推送，但**渲染是宿主专属组件** | scheduler（数据插件推，面板 `SchedulerQuickCard` 宿主画） |
| C 完全写死 | 后端能力在插件/自建，前端是专属业务实现 | canvas / subagent / workflow / plan / btw / trace |

### 汇总对照表

| 功能域 | pi 侧实装 | renderer 固定实现 | 判定 |
|---|---|---|---|
| todo | `pi-todo` 1326 行，`buildGui()` 产 tab-bar + list-tree | 无专属组件 | **A** |
| goal | `pi-goal` 3825 行，同样产 GuiComponent | 无专属组件 | **A** |
| scheduler | `pi-scheduler` 5393 行 + builtin plugin `scheduler-manager` 706 行 | `SchedulerQuickCard.vue` 213 行 + overlay scheduler tab 内容渲染（tab 位已开放）+ `HeaderActionsHost` 的 `activation === 'scheduler-overlay'` 特例 | **B** |
| plan | `pi-plan` 3402 行 | `panel/plan/` 4 组件 1292 行 + 抽屉 `plan` tab + `PLAN_REVIEW_MARKER` 专属分支 | **C** |
| canvas | `pi-canvas` 1556 行 + **runtime `services/canvas` 2164 行** | `components/canvas/` 19 文件 6065 行 + overlay `canvas` tab | **C（后端双实现）** |
| subagent | `pi-subagent-workflow` 15501 行 | 前端 28292 行（101 文件）+ 托盘 `TrayTaskKind` 写死 + `SubagentTab.vue` 522 行 | **C** |
| workflow | 同上（同包） | `panel/workflow-viz/` 4814 行 + 托盘写死 + overlay `runs` tab | **C** |
| btw | 无 pi 扩展 | `BtwPanel.vue` 467 行 + runtime `btw-*.ts` 5 文件 + 前端 1987 行 | **C（纯自建）** |
| trace | 无 pi 扩展 | `panel/trace/` 1573 行 + 卡头写死两段 | **C（纯自建）** |
| smart-context | `pi-smart-context` 1572 行 | `SystemSmartContextSection.vue` 246 行 + 专属 RPC handler 49 行 | **C（配置页）** |
| rename-session | `pi-rename-session` | `RenameSessionPage.vue` 460 行 + handler 73 行 | **C（配置页）** |
| network-proxy | `pi-network-proxy` | `settings/network/` 4 文件 769 行 + handler 68 行 | **C（配置页）** |
| base-tool-enhance / llm-retry | 各自 ext-config JSON | `SystemLlmRetrySection.vue` 436 行 + handler 50 行 | **C（配置页）** |
| permission | `pi-permission`（有配置 schema） | **无配置页** | 配置无处可改 |

### 结构性观察

1. **todo/goal 已证明正确形态，但未推广**：插件侧产 `GuiComponent` 树，宿主完全不知道业务语义。前端专属代码 0 行 vs subagent 28292 行。残留两处硬编码尾巴：`tray-order.ts` 的 `TRAY_WIDGET_KNOWN_ORDER = ['todo','goal']`、`TrayWidgetButton.vue` 的 `BUILTIN_WIDGET_ICONS` 映射。
2. **托盘并存两套机制**：`TrayTaskKind = 'bash' | 'subagent' | 'workflow'` 是宿主自建计数 + 专属面板；协议 widget 区是插件推送 + 通用渲染。subagent/workflow 数据其实**已由 pi 扩展推送**（`SUBAGENT_INFLIGHT_MARKER` / `SUBAGENT_JOURNAL_MARKER` → `inflight-mirror`），只是宿主选择自己渲染。
3. **抽屉 tab 位已开放（容器统一批次 743f82e6f），tab 内容仍固定**：`RightDrawerTab` 已开放为 `string`（`packages/core/src/domain/drawer/types.ts:24`，`RIGHT_DRAWER_TAB_IDS` 内置 8 员 + `isKnownRightDrawerTab` 判别 `:41`），`PanelContainer.vue` 的 8 分支字面量 chain 已删、内容显隐归 ViewHost 推树渲染。内置 8 员中 3 个对应 pi 扩展能力（subagent / plan / bashTask）——tab 位不再是障碍，剩余固定点在各 tab 的内容实现。
4. **overlay 一级 tab 位已开放，内容派生未完成**：`OverlayTab` 已开放为 `string` + `isKnownOverlayTab` 已知值判别（容器统一批次）。`scheduler` tab 仍是「插件产树 + ViewHost 渲染」的唯一样本；tab 条/标题/内容分支的注册表派生仍待做（tabSegments 数据源内置）。
5. **配置页伪插件化**：四个 pi extension 的配置后端都是独立 JSON，但 taiji 为每个写了 runtime handler + 一组专属 WS 方法 + renderer 页面（合计约 1282 行前端 + 240 行 runtime）。`permission` 有完整 schema 却一个页面都没写——说明「每插件配一个宿主页面」走不通。

### 全链路视图（本次分析对象）

一个功能从「用户可见入口」到「内容呈现」要穿过四层，每层都有固定点：

```
composer 图标/入口  →  对话流（行内呈现）  →  drawer 一级 tab  →  overlay 一级 tab
   ↑ HeaderActionsHost      ↑ MessageStream      ↑ RightDrawerTab      ↑ OverlayTab
   ↑ TrayWidgetButton       ↑ Turn / ToolRow     ↑ PanelContainer 分支  ↑ tabSegments 写死
   ↑ AddMenuPopover         ↑ SystemNotice       ↑ RIGHT_DRAWER_REGISTRY
```

## 待办

- [ ] **分域全链路分析**（subagent / workflow / scheduler 各一份，落 `docs/todo/plugin/`）：
  每域要覆盖 composer 入口（图标来源 / 徽标 / 点击行为）→ 对话流行内呈现（tool result / custom message / 系统通知）→ drawer 一级 tab（是否应该有 / tab 元信息 / 内容渲染方式）→ overlay 一级 tab，逐层给出现状锚点、插件化改造方案、需 runtime / pi extension 配合的点。
- [ ] **汇总出整体设计**：统一容器抽象（tab 注册表 / 面板注册表）、`GuiComponent` 原语是否够用的判定、分阶段落地顺序。
- [ ] 附录裁决项（见下）。

### 附录：扫描中发现的附带问题

| # | 问题 | 位置 |
|---|---|---|
| S1 | 已消解：`PluginContributesHeaderAction` 两版已对齐（SDK 已补 `activation?: HeaderActionActivation`、`commandId` 已可选，容器扩展点统一 §6.11 阶段 0） | `packages/plugin-sdk/src/types.ts:305-316` vs `packages/core/src/extension-host/types.ts:205-218` |
| S2 | runtime 对 `contributes` 零 schema 校验 | `plugin-registry.ts` `buildDescriptor` |
| S3 | `contributes.hooks` 只在 `inferActivationEvents` 中被读，hook 类型名被当激活事件 | `plugin-registry.ts:315` |
| S4 | `custom` GuiComponent 注册表无 provide 点（仓库内只有 inject） | `packages/core/src/rendering-protocol/custom-registry.ts` |
| S5 | 插件 tool 只进 runtime `toolRegistry`，不注入 pi 工具表 → 模型看不见 | `packages/runtime/src/services/plugin-service/tool-api.ts` |

## 相关文档

- [docs/plugins/architecture.md](../plugins/architecture.md) — 插件架构总览
- [docs/plugins/extension-points.md](../plugins/extension-points.md) — 三层扩展点全量盘点
- [docs/plugins/renderer-pluginization-scan.md](../plugins/renderer-pluginization-scan.md) — renderer 扫描报告（24 候选）
- `docs/todo/plugin/` — 分域全链路分析（subagent / workflow / scheduler）
