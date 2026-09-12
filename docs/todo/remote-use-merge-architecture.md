# 远程化合并架构指引（feat-remote-use → main）

> **状态**：待执行。`feat-remote-use` 分支（86 commits，P0-P7 全交付）合并进 main 后，**本文档删除**。
> **创建日期**：2026-08-02
> **关联分支**：`feat-remote-use`（worktree 路径 `../feat-remote-use`）
> **架构 SSOT**：原指 renderer-target-architecture.md §2（七层架构 + 归属规则；已删除，git 可追溯）；现行权威 = [docs/architecture/renderer-rebuild-architecture.md](../architecture/renderer-rebuild-architecture.md)（§3 包拓扑 / §4 core 分层）

---

## 1. 为什么需要这份文档

`feat-remote-use` 引入了远程化功能（服务器跑 runtime+pi，桌面/手机客户端连接），把 renderer 从「单进程桌面 SPA」变成「双模式（本地+远程）多客户端运行时」。v6 前端架构为此新增了 **Transport & Coordination Layer（T&C 层）**（七层架构的第 6 层），作为远程化连接/协同逻辑的归位点。

合并时，远程化的代码必须按本文档的归位清单落到 T&C 层，而不是散落回 Foundation/Feature。归属判据见 renderer-target-architecture.md §2.2 功能归属规则表（已删除，git 可追溯）。

---

## 2. 合并顺序

**remote 先进 main，v6 重构在 remote 之上做。**

| 步骤 | 动作 | 理由 |
|---|---|---|
| 1 | `feat-remote-use` → main | remote 是已交付生产功能（P0-P7），优先于 v6 内部重构 |
| 2 | `feat-optimize-ui` rebase onto 新 main | v6 重构基于远程化后的代码做 |
| 3 | B3 routeInbound 合并设计 | 声明式路由表 + 远程化 5 类分支，合并点非 auto-merge |
| 4 | B1/B2 在 remote 基线上做 | presence store 隔离合规、lease 字段清理对齐 |
| 5 | 阶段 C 视觉波次 | mobile 视觉单列子波次 |

**不推荐**：v6 先合、remote 后 rebase——remote 的 86 commits 会与 v6 B 系列（改同样文件）全面冲突。

---

## 3. T&C 层归位清单

远程化新增/扩展的全部代码，合并时归位到 T&C 层：

| 远程化改动 | 来源（feat-remote-use） | T&C 层归位 |
|---|---|---|
| `lib/remote/`（5 文件，新增） | `packages/renderer/src/lib/remote/` | T&C 层，原路径保留 |
| `ws-client.ts` auth/seq/RTT/presence 扩展（+516 行） | `packages/renderer/src/lib/ws-client.ts` | T&C 层 ws-client，原地扩展不拆文件 |
| `useConnection.ts` routeInbound 远程分支（5 类消息） | `packages/renderer/src/composables/useConnection.ts` | T&C 层 routeInbound 的 ROUTE_TABLE 条目（见 §4） |
| `useConnection.ts` 双模式 init() + retryRuntime | 同上 | T&C 层 useConnection（connection-mode 驱动分支） |
| `stores/presence.ts`（新增） | `packages/renderer/src/stores/presence.ts` | T&C 层 presence store |
| `session.ts` lease 字段 + busy/idle 消费 | `packages/renderer/src/stores/session.ts` | store 留 Foundation，**消费逻辑**归 T&C 层 |
| `components/remote/*`（4 组件，新增） | `packages/renderer/src/components/remote/` | T&C 层连接 UI |
| `lib/ipc.ts` 降级机制 | `packages/renderer/src/lib/ipc.ts` | T&C 层 ipc-adapter |
| `lib/terminal-reconnect-signal.ts`（新增） | `packages/renderer/src/lib/` | T&C 层（断线终端重连信号） |

**runtime 侧**（不在 renderer 分层内，但合并时需知晓）：

| 远程化改动 | 来源 | 归位 |
|---|---|---|
| `transport/token.ts` / `seq-counter.ts` / `session-buffer.ts` / `file-endpoint.ts` | `packages/runtime/src/transport/` | runtime transport 层，新增模块无侵入 |
| `services/session/lease-manager.ts` | `packages/runtime/src/services/session/` | runtime services 层，新增模块 |
| `infra/async-context.ts` / `async-mutex.ts` | `packages/runtime/src/infra/` | runtime infra 层，新增模块 |
| `connection-manager.ts` 重写（认证门+回放+presence） | `packages/runtime/src/transport/` | runtime transport 层，侵入式改动 |
| `message-broker.ts`（seq 打点+ring buffer+定向投递） | 同上 | runtime transport 层，侵入式改动 |
| `server/` CLI（独立分发） | `packages/runtime/src/server/` | runtime 新增子目录 |

---

## 4. routeInbound 合并设计（B3 × 远程化）

`useConnection.ts` 的 `routeInbound` 是合并最大冲突点——v6 的 B3 要把它退化为声明式路由表，远程化已经往里面塞了 5 类消息分支。

**合并方案**：远程化的 5 类分支作为 ROUTE_TABLE 条目注入，不回退 if-else。

```ts
const ROUTE_TABLE: Record<ServerMessageType, RouteRule> = {
  // 既有分支
  'message.*':            { channels: sid => [sid], handler: dispatchSession },
  'session.exited':       { channels: 'global', handler: handleSessionExited },
  // 远程化新增（合并后纳入）
  'session.deleting':     { channels: sid => [sid], handler: handleSessionDeleting },
  'session.deleted':      { channels: sid => [sid], handler: handleSessionDeleted },
  'session.busy':         { channels: sid => [sid], handler: handleSessionBusy },
  'session.idle':         { channels: sid => [sid], handler: handleSessionIdle },
  'presence.update':      { channels: 'global', handler: handlePresenceUpdate },
  // ...
}
```

**验收**：routeInbound 查表 + 执行，无业务逻辑内联。远程协同消息（busy/idle/presence）的 store 写入经事件消费层（B2 的 useMessageEffects）分发，不在 routeInbound 内联。

---

## 5. sync 兼容纪律

`feat-remote-use` 有 `scripts/sync-mobile-from-renderer.sh`，通过 COPY_MAP 从桌面 renderer 单向 copy 业务层到 mobile-renderer。v6 重构改这些文件时必须同步 sync 脚本。

**COPY_MAP 覆盖的文件**（整目录 copy）：`composables/` · `stores/` · `components/ui/` · `components/panel/message-stream/` · `components/sidebar/` · `lib/remote/` · `lib/ws-client.ts` · `api/` · `i18n/` · `mock/`

**v6 重构影响 sync 的 B 项**：

| B 项 | sync 影响 | 应对 |
|---|---|---|
| **B4 Composer 合并** | useContenteditableInput 被吸收进 useComposerInput，mobile copy 整目录会断裂 | 保留 re-export 兼容层，或同步更新 mobile import |
| **B5 Sidebar 拆分** | 抽出的 composable 若放新子目录（features/sidebar/），整目录 copy 自动带过 | 确认无遗漏 |
| **B9 路径重组** | features/panel 按域分子目录，被删/合并文件导致 mobile import 断裂 | COPY_MAP 从整目录改为显式文件清单 |
| **B9 useConnection 位置** | MANUAL_FORK 路径若移动，sync `--force` 误覆盖 mobile fork | **路径锁定**：保持在 `composables/useConnection.ts`，或同步更新 sync MANUAL_FORK 数组 |

**MANUAL_FORK 锁定**：`composables/useConnection.ts` 是 mobile 的人工 fork（砍本地模式分支只保留远程），**B9 重组时路径不移动**。

---

## 6. 协同状态在 ADR-0049 隔离模型中的位置

远程化引入 presence（全局协同态）和 lease（runtime TTL 管控）。它们是 ADR-0049 per-session 隔离的**显式例外**：

- **presence**：全局态（跨所有 session），不进 `useSessionScopedState` 分区
- **lease**：per-session 字段但生命周期由 runtime TTL 管控（非 renderer 发起）
- **清理对齐**：`triggerSessionCleanups(id)` 必须订阅 `session.deleted` 广播，确保其他客户端删 session 时本地 lease 同步清除

---

## 7. mobile-renderer plugin 子集

mobile-renderer 布局与桌面完全不同（底部 tab/抽屉式），16 挂载点是**桌面拓扑专属**。mobile plugin 支持：

| 维度 | mobile 支持 | 说明 |
|---|---|---|
| **B 对话流**（B1 tool result / B2 消息卡） | ✅ | message-stream 已 copy，GuiComponentRenderer 可用 |
| **D 命令配置**（D1 slash） | ✅ | CommandPopover 已 copy |
| **A 结构容器**（A1-A4） | ❌ | 无 drawer / 无 sidebar 第 5 tab / 无 panel header 按钮组 |
| **E 独立 view** | ❌ | mobile 无独立 view 路由 |

mobile 不含 ExtensionHost 层，plugin 渲染降级为 message-stream 内嵌的 GuiComponentRenderer。完整 mobile plugin 拓扑待 `packages/core` 抽取后定义。

---

## 8. 合并后删除

`feat-remote-use` 合并进 main 且 v6 B3/B9 重构完成（远程化代码归位 T&C 层）后，**本文档删除**。届时：
- T&C 层归位清单（§3）的内容已体现在代码结构中
- routeInbound ROUTE_TABLE（§4）已落地
- sync 兼容纪律（§5）已内化进 sync 脚本 + B9 checklist
- mobile plugin 子集（§7）已纳入 renderer-target §3.4 挂载点表

七层架构图 + 归属规则表 + 依赖铁律（renderer-target §2.1-§2.3）是**通用架构设计**，不随本文档删除——它们是 renderer 架构的永久组成部分。
