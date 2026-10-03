# 终端多实例（一个会话开多个终端）延期登记

> **状态**：待立项（2026-10-02 用户裁决：不进三容器重构本期范围，协议级改造单列）。
>
> **本文件定位**：登记"终端多实例"这一已识别需求、其真实成本与解锁条件。裁决关闭或立项实施时更新状态行。

## 需求

三容器重构后，终端住底抽屉（bottom drawer），但仍是**每会话一个 PTY**。用户明确表达过"terminal 可以开多个"的诉求（2026-10-02 容器体系讨论），需要多个终端实例 tab（如一个跑测试、一个跑 dev server、一个临时命令）。

## 为什么本期不做（成本实录）

终端身份 = sessionId 一元键，贯穿四层，多实例 = 引入"终端实例 id"维度的协议级改造：

1. **renderer**：`useTerminal.ts` 的分区键是 sessionId（模块级 `Map<sessionId, TerminalPartition>`，:129）；buffer 分区、flush 监听器同键。
2. **runtime**：`terminal-service.ts` 的 `ptyMap = Map<sid, IPty>`（:87），spawn 幂等逻辑按 sid 去重（:98-102）。
3. **WS 协议**：`terminal.data / exit / alive` 消息按 sid 路由，帧格式无实例字段。
4. **RPC**：`terminalApi.spawn({sessionId...})` 入参无实例 id。

四层要同步加实例维度，且要处理实例级生命周期（创建/ kill 单个实例、会话销毁时级联、buffer 按实例持久）。

## 同族延期项（同一改造批次考虑）

- **浏览器多页面**：主进程 WebContentsView 池同样按 sessionId 单实例（browser-view-manager.ts:33，LRU 上限 3），多网页 tab 要加同一性质的实例维度。
- **浮层实例 tab 条**（混排类型，2026-10-02 已裁决形态）：依赖上面两项的实例 id 落地后才有实例可切。

## 解锁条件 / 立项触发

- 三容器重构 W1（底抽屉 + 终端搬家）交付并稳定后；
- 设计时必须同时回答：实例 id 的命名空间（`term:<sid>:<n>`？）、WS 帧加字段的兼容策略（旧 renderer × 新 runtime）、底抽屉实例 tab 条与容器的关系（届时底抽屉从"终端面板"升格为真容器，参考设计文档 `.tmp/tech-design/display-containers.md` §7.1 的 YAGNI 注记）。

## 关联

- 设计文档（过程产物，不入 git）：`.tmp/tech-design/display-containers.md`（三容器重构，W4 节）
- 现状锚点：`packages/renderer/src/composables/features/terminal/useTerminal.ts`、`packages/runtime/src/` terminal-service、`apps/electron/main/browser/browser-view-manager.ts`
