# 14 · 后台命令侧边栏视图 + Drawer 详情 测试流程

> 覆盖：plugin 区「后台命令」L2 视图（BackgroundTaskListView：三桶筛选 + 两行式 item + 行内两段式终止）与 drawer bashTask tab（BackgroundTaskDetailPanel：元信息 / 输出跟随 / 终止）。
>
> 设计：[background-task-sidebar-view.md](../design/background-task-sidebar-view.md)（§3.1 终态 / D4-D7 / D10）。先读 [00 总览](00-test-strategy-overview.md)。

## §1 功能概述

AI 把 bash 命令转后台执行后，任务落在 per-session registry.json。本功能提供用户可见可控面：

- **列表**（Sidebar plugins tab →「后台命令」L2 tab）：三桶筛选（运行中/已结束/全部 + 计数，默认运行中）、两行式 item（状态 icon + 命令 + 耗时 / pid · exit）、running 行行内两段式终止（✕ → ✓）、点击行开 drawer；
- **drawer 详情**（bashTask tab，第 8 tab）：命令全文（可复制）、元信息行（taskId · pid · 开始 · 时长 · exit · reason）、输出尾部（running 时 2s 跟随）、两段式终止按钮 + 回执分支 toast。

数据链路：runtime `BackgroundTaskService` 直读 registry（拉取 RPC + 变更广播），renderer `useBackgroundTasks` per-session 分区。测试框架（vitest 用例）见 `packages/renderer/src/__tests__/components/background-task-list-view.test.ts` 与 `background-task-detail-panel.test.ts`。

## §2 组件结构概述

列表侧：`PluginViewContainer.vue`（NATIVE_VIEWS 路由，viewId='background-tasks'）挂 `BackgroundTaskListView.vue`（容器 `background-task-list`）：全量空态 `bg-task-empty`；有任务时渲染三桶筛选槽 `bg-task-filterbar`（`bg-task-filter-active|ended|all`，`data-active` 标当前桶）与 ScrollArea 列表——运行中空桶 `bg-task-bucket-empty`（含「查看全部」`bg-task-view-all`）、已结束空桶 `bg-task-bucket-empty-ended`、任务行 `bg-task-item`（点击开 drawer；行内含「全部」桶分段边界 `bg-task-group-divider`、状态 icon `bg-task-icon`、pid·exit 第二行 `bg-task-meta`、running 行行内两段式终止按钮 `bg-task-kill`→确认态切换为 `bg-task-kill-confirm`）。另有损坏/断连横幅 `bg-task-corrupt-banner` / `bg-task-disconnect-banner`。

Drawer 侧：`DrawerPanel.vue` tab 栏新增 bashTask 值（`drawer-tab-bashTask`，复用既有 `drawer-tab-{key}` 模板），`PanelContainer.vue` v-if 分支挂 `BackgroundTaskDetailPanel.vue`（容器 `bash-task-detail`）：命令全文 `bash-task-command` + 复制按钮 `bash-task-copy`、元信息行 `bash-task-meta`（状态色点 `bash-task-status-dot` + taskid/pid/started/duration/exit/reason 各 span）、输出区三态互斥（`bash-task-output` 有内容且 running 时 2s 跟随 / `bash-task-output-unavailable` 文件已清理 / `bash-task-output-empty` loaded 且空）、running 时的两段式终止按钮 `bash-task-kill`（`data-armed="true"` 为确认态）。

## §3 data-testid 清单

testid 以组件 template 内 data-testid 属性为准（下表均已核实有效）。

### 列表（BackgroundTaskListView.vue）

| testid | 触发/可见条件 |
|--------|--------------|
| `background-task-list` | 视图挂载时恒显（容器） |
| `bg-task-empty` | 全量空态（loaded 且 0 条；此时不渲染筛选条） |
| `bg-task-filterbar` | 有任务时恒显（三桶筛选槽） |
| `bg-task-filter-active` / `bg-task-filter-ended` / `bg-task-filter-all` | 同 filterbar；`data-active` 标当前桶 |
| `bg-task-bucket-empty` | 「运行中」桶空（含 bg-task-view-all） |
| `bg-task-view-all` | 同上，点击跳「全部」桶 |
| `bg-task-bucket-empty-ended` | 「已结束」桶空（仅文案） |
| `bg-task-item` | 每条任务一个；@click 开 drawer bashTask tab |
| `bg-task-group-divider` | 仅「全部」桶 active/ended 段边界处 |
| `bg-task-icon` | 恒显；running 时内部为旋转环，其余为色点 |
| `bg-task-meta` | 恒显（第二行 pid · exit） |
| `bg-task-kill` / `bg-task-kill-confirm` | 仅 running 行 hover 显现；首击变 confirm（常显红底），再击发 kill RPC |
| `bg-task-corrupt-banner` / `bg-task-disconnect-banner` | registry 损坏 / 数据源断连横幅 |

### Drawer 详情（BackgroundTaskDetailPanel.vue）

| testid | 触发/可见条件 |
|--------|--------------|
| `drawer-tab-bashTask` | drawer 打开时 tab 栏内（`drawer-tab-{key}` 模板新值） |
| `bash-task-detail` | 选中任务后（未选中走 DrawerPanel 空态文案） |
| `bash-task-command` | 恒显（命令全文） |
| `bash-task-copy` | 恒显（title 随 copied 态换文案） |
| `bash-task-meta` | 恒显（元信息行容器） |
| `bash-task-status-dot` | 恒显；class 随 bucket SSOT tone |
| `bash-task-meta-taskid` / `-pid` / `-started` / `-duration` | 恒显（duration 文案随 running/终态切换） |
| `bash-task-meta-exit` | 仅 exitCode 非 undefined |
| `bash-task-meta-reason` | 仅终态（orphaned 或 exited+reason） |
| `bash-task-output` | output 拉到且非空（running 时 2s 跟随） |
| `bash-task-output-unavailable` | output 文件丢失/清理（lost） |
| `bash-task-output-empty` | output loaded 但为空 |
| `bash-task-kill` | 仅 running（killing/终态无按钮）；`data-armed="true"` = 确认态 |

### 测试注意

- running 计时用 fake timers（列表 1s tick / drawer 输出跟随 2s interval）；
- 杀进程是 mock RPC，不会真杀——行内终止断言两段式状态机（testid 切换）而非进程消失；
- i18n key 全表见 `packages/renderer/src/i18n/locales/{zh-CN,en-US}/{panel,sidebar}.ts`（`panel.sideDrawer.bashTask*` 21 个 + `sidebar.backgroundTaskList.*` 18 个）；文案断言用 override `t(key)` 注入而非依赖 locale 文件（组件测试既有形态）。

## §4 相关文档

- 设计文档：[background-task-sidebar-view.md](../design/background-task-sidebar-view.md)（终态 §3.1 / 筛选 D10 / kill 矩阵 D6 / 输出跟随 D7）
- SideDrawer 宿主：[05-side-drawer.md](05-side-drawer.md)（bashTask tab 为第 8 tab）
- 侧栏面板范式：[09-subagent-workflow-panel.md](09-subagent-workflow-panel.md)（Agents tab 同构先例）
- 组件测试：`packages/renderer/src/__tests__/components/background-task-list-view.test.ts`（12 用例）/ `background-task-detail-panel.test.ts`（13 用例）
