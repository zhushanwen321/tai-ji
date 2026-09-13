# 架构总览（ARCHITECTURE）

> **系统架构 SSOT 在 [`docs/architecture.md`](docs/architecture.md) + [`docs/architecture/`](docs/architecture/) 子文档群。** 本文件是 design 工作流入口索引 + 架构不变式速查，不重复细节。

## 进程拓扑

四进程 + 一共享类型包，两层边界通信：

| 进程/包 | 运行时 | 目录 | 职责 |
|---------|--------|------|------|
| Renderer | Electron renderer (Chromium, Vue 3) | `packages/renderer/` | UI + 状态管理 + 业务编排 |
| Main | Electron main (Node) | `apps/electron/main/` | 原生生命周期 + 跨进程编排（窗口/runtime supervisor/OS gateway） |
| Runtime | Node 子进程 (`ELECTRON_RUN_AS_NODE=1`) | `packages/runtime/` | **pi 协议唯一适配点** + session 管理 + 配置持久化 |
| Preload | 注入脚本 | `apps/electron/preload/` | 安全桥接，暴露 `window.electronAPI` |
| shared | npm package `@xyz-agent/shared` | `packages/shared/` | 三上下文共享的协议/类型/常量 |

> 依赖方向铁律：`main/runtime/renderer → shared → 外部`，禁止反向。

## 三层职责

| 层 | 职责 | 铁律 |
|----|------|------|
| Renderer | 让用户给上下文、审查产出、介入行为 | 业务代码不直接处理 pi 格式 |
| Runtime | pi 协议适配 + session 管理 + 配置持久化 | `transport/services/infra` 三层；services 零 infra 直连 |
| Main | Electron 壳 | 不放业务逻辑（持有窗口注册表是跨进程协调状态） |

**Runtime 三层**（取代旧 design.md D4 四层，adapters 已并入 infra）：
- `transport/`（7 file）：纯路由 ClientMessage→service，零业务逻辑
- `services/`（49 file）：业务编排 + 定义 `ports/` 接口（config/session/pi-engine/model/installer/tree/workspace 七域），**零 infra 直连**。workspace 域（2026-07-03 新增）：pull-only RPC（`workspace.listRecent`，不做 broadcast），写入时机挂 `session-lifecycle.create` + `message-dispatcher.sendPrompt`，详见 ADR-0003/0004。`[from: 2026-07-03-recent-workspaces §system-architecture]`
- `infra/`（18 file）：唯一与 pi/npm/git 打交道的位置，实现 ports 接口

依赖方向：`transport → services ← infra`（services 定义 ports，infra 实现 ports，无环）。

## 通信边界

两条出口通道，选路规则：**需 Main 特权（原生窗口/进程/OS）→ IPC；其余一律 → WS**。

| 边界 | 载体 | 协议 | 用途 |
|------|------|------|------|
| ① preload | `window.electronAPI`（渲染不直接用 ipcRenderer） | IPC invoke | 系统/窗口/进程生命周期 |
| ② WebSocket | `ws-client.ts` + `event-bus.ts` | JSON（ClientMessage/ServerMessage） | 业务/数据全部 |
| 组合根 | API Client（`renderer/src/api/`） | 统一门面 | 对组件屏蔽走哪条 |

**启动时序契约**（必须显式守护）：Main createWindow（先）→ runtimeManager.start()（后）→ renderer init → IPC getRuntimePort() → connect WS → 业务就绪。Runtime 重启经 `onRuntimePort` 推新端口触发重连。

## 数据流模式

```
pi 子进程事件 → infra/pi/event-adapter(翻译) → ServerMessage(WS)
  → renderer ws-client(收字节) → event-bus(按 type 分发)
  → api/events.ts(第2层: 抽 payload.sessionId 路由, 无 sid 丢弃)
  → composables/features/(业务编排) → Pinia store 分区(Map<sessionId>)
  → Vue 响应式组件
```

**跨 store 编排在 composable 层（实例）**：⌘K 全局搜索（`useSearch`）聚合 4 源——命令内存（core `command-registry`/`command-store`）+ 文件 WS（core `file-search` 缓存，未命中调 composer domain WS + 超时 race）+ session domain（WS）+ recents（localStorage）。实现位于 core `packages/core/src/domain/new-task-search/`（`search.ts`/`search-jump.ts`/`recents.ts`），2026-09-11 由 renderer 迁入。编排归 composable 非 domain（domain 严格只调 transport+pending，编排跨 store 违反铁律），见 [ADR-0028](docs/adr/0028-search-orchestration-in-composable.md)。`[from: 2026-06-30-search-modal §system-arch]`

## 关键状态机

| 状态机 | 状态流 | 来源 |
|--------|--------|------|
| Session 生命周期 | `create → active/idle → compact → restore → delete`，扁平 `.jsonl` 持久化 | `docs/architecture/context.md` |
| Generating | `isGenerating`（pi 处理中）+ `streamingMessage`（当前逐字输出），两者可能不同步 | context.md |
| Message streaming | `message_start → text_delta×N → tool_execution_start/end → agent_end` | `docs/standards.md §3.3` |
| NewTaskFlow | 8 态：`idle/landing/dir-popover/branch-popover/dir-dialog/branch-modal/completed/cancelled` | `useNewTaskFlow.ts` |
| Plugin 生命周期 | `UNLOADED → LOADING → ACTIVATING → ACTIVE → DEACTIVATING → UNLOADED`（+ CRASHED） | `2026-05-27-clarify-plugin-phase1/spec.md` |

## 架构不变式（违反必出 bug）

1. **Runtime 是 pi 协议唯一适配点**，业务代码不直接处理 pi 格式
2. **所有 runtime→前端消息必须带 sessionId**（无 sid 丢弃），三层隔离见 NFR.md「数据」
3. **Runtime broadcast 时序竞争**：session 级 broadcast 若在 session 建立/激活流程内部发出，会早于 renderer 订阅 → 丢失。renderer 切换/创建 session 后需立即消费的 session 级状态，**必须主动拉取**（不可依赖 broadcast 到达）。详见 CLAUDE.md「架构约定」
4. **emit 只传单个 payload 对象**（CLAUDE.md 规则 #1）
5. **event-bus listener 模块级 refCount 防重复注册**（CLAUDE.md 规则 #2）
6. **错误统一走 `chatStore.markSessionError(sid, err)` 单一入口**，重置 isGenerating + streamingMessage（CLAUDE.md 规则 #3）

## 子文档导航

- [`docs/architecture.md`](docs/architecture.md) — 系统架构总览入口（进程拓扑图/数据流/核心约束实质说明）
- [`docs/architecture/runtime-layering.md`](docs/architecture/runtime-layering.md) — Runtime 三层重构（取代旧四层）
- Runtime 模块清单（runtime-module-map.md，已删除，git 可追溯；现行结构见 runtime-layering.md §1 与 context.md「Agent Runtime」）
- [`docs/architecture/context.md`](docs/architecture/context.md) — 领域术语表完整版
- [`docs/architecture/design.md`](docs/architecture/design.md) — 跨进程架构决策记录 D1–D9（D4 四层已被 runtime-layering 取代；迁移路线已删，git 可追溯）
- **文件树子系统架构决策**：[ADR-0025](docs/adr/0025-file-view-full-project-tree.md)（File View 全项目树语义）/ [ADR-0026](docs/adr/0026-file-tree-lazy-loading.md)（懒加载）/ [ADR-0027](docs/adr/0027-fileservice-three-layer.md)（FileService 三层）。`[from: 2026-06-28-sidebar-project-file-tree §子系统]`
- **搜索子系统架构决策**：[ADR-0028](docs/adr/0028-search-orchestration-in-composable.md)（编排归 composable）/ [ADR-0029](docs/adr/0029-domain-types-ssot-in-lib.md)（领域类型 SSOT 归 lib）/ [ADR-0030](docs/adr/archive-digest.md#adr-0030)（已压缩档案）（文件匹配算法复用）。`[from: 2026-06-30-search-modal §decisions D-026/D-028/D-029]`
- [`docs/standards.md`](docs/standards.md) — 编码标准（streaming 生命周期/mock 策略/路径规范等）
- [`CONTEXT.md`](CONTEXT.md) — design workflow 精简统一语言（指向 context.md 完整版）
