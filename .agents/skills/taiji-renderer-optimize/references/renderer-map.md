# Renderer Map — 结构地图与既有性能范式

审查前必读。用途：① 定位代码归属层；② §3「已有范式」清单用于拦截重复提议——命中清单的建议一律判误报。

## 1. 范围与分层

本 skill 的特化范围（三个包是一个逻辑整体，聊天功能跨三者）：

| 包 | 职责 | 关键位置 |
|----|------|---------|
| `packages/renderer/src/` | 壳层：组件/composables/stores/api（WS 客户端） | `components/panel/`（聊天主面板）、`composables/`、`stores/`、`api/events.ts`（三通道事件总线） |
| `packages/core/src/` | 领域层：chat store factory、delta 合帧、LRU 驱逐、useSessionScopedState 工厂 SSOT | `domain/chat/`（store.ts / mutations.ts / delta-coalescer.ts / lru.ts）、`foundation/use-session-scoped-state.ts` |
| `packages/ui/src/features/chat/` | 聊天展示组件：Turn / MarkdownRenderer / BashOutputBlock / TurnRail | `composables/useMarkdownStreaming.ts` |

注意：renderer 的 `stores/chat.ts`、`useChat.ts` 是 30-120 行薄包装，真正逻辑在 `packages/core/src/domain/chat/`——**分析聊天性能必须同时看两个包**，只看 renderer 壳层会得出错误结论。

## 2. 消息流渲染链路（确定结论，禁止推测）

```
WS message.* → api/events.ts（三通道总线）
  → core delta-coalescer.ts        # 第 1 层节流：text_delta/thinking_delta 按 sid:type microtask 合帧
  → core store.ts / mutations.ts   # shallowRef(new Map<sid, ShallowRef<Message[]>>) 只替换该 sid 内层 ref
  → renderer MessageStream.vue     # virtua <Virtualizer> 虚拟滚动，DOM 只挂视口项
  → logic/messageTurns.ts          # toRenderItemsIncremental：流式只重建末位 turn
  → ui MarkdownRenderer.vue + useMarkdownStreaming.ts
                                   # 第 3 层节流：rAF trailing + 前缀段缓存 + streaming-fence 占位
```

关键锚点（行号可能漂移，以符号名为准）：

- `components/panel/MessageStream.vue` — `<Virtualizer :data=renderItems :key=sessionId :keep-mounted=pinnedIndexes :shift=isPrepend>`
- `packages/core/src/domain/chat/delta-coalescer.ts` — microtask 批量合帧；非 delta 消息先 flush 保序
- `packages/core/src/domain/chat/mutations.ts` — `commitMessages` 只替换该 sid 内层 shallowRef（ADR-0039）
- `packages/ui/src/features/chat/composables/useMarkdownStreaming.ts` — rAF trailing 节流 + 增量前缀缓存（prefixSegments 引用恒等零重渲染）+ 未闭合 fence 不跑 shiki/mermaid
- `composables/logic/markdown.ts` — shiki highlighter 全局单例、markdown-it 实例单例、`renderIncremental` 前缀段缓存

## 3. 已有范式清单（命中 = 误报，勿重复提议）

| 范式 | 出处 | 含义 |
|------|------|------|
| 消息流虚拟滚动 | virtua/vue `<Virtualizer>`（MessageStream.vue） | 已实现，勿再提议"加虚拟列表"。ADR-0045 自研方案已被 virtua 取代（历史） |
| streaming 三层节流 | 上节链路 | microtask 合帧 → shallowRef 分区替换 → rAF+增量 markdown。勿再提议"加节流/防抖" |
| markdown/shiki 缓存 | logic/markdown.ts | highlighter/markdown-it 单例 + 前缀段增量缓存已存在，勿再提议"markdown 加缓存" |
| 消息体浅响应 | ADR-0039 | 深响应式代理曾致 70-500MB 内存压力；messages 用 shallowRef + 不可变替换是**性能决策**，勿提议改回 reactive |
| per-session Map 分区 | ADR-0049 + foundation/use-session-scoped-state.ts | per-session 状态的强制范式，含 `updateFor(capturedSid)` 防竞态 |
| 事件订阅 refCount | standards §2.2 | 多实例 composable 的事件订阅用模块级 refCount + onScopeDispose 防重复注册 |
| 终端写入 rAF 队列 | stores/terminal-write-queue.ts | 已实现 |
| session LRU 驱逐 | core/domain/chat/lru.ts | 已实现 |
| reka ScrollArea | components/ui/scroll-area/ | 只用于 sidebar/overview 等短列表；消息流**不用**它，勿混用 |

## 4. 深度 watch 已知清单

全仓（packages + apps + extensions，排除 node_modules 与测试）deep watch 共 4 处，其中本 skill 三包范围内 3 处（审查时核对是否新增第 4 处，新增即信号）：

1. `packages/renderer/src/composables/features/fork-handoff/useForkBranchNotify.ts`
2. `packages/renderer/src/stores/project.ts`
3. `packages/core/src/domain/settings/use-provider-edit.ts`（settings 域，非 chat）

范围外另有 1 处：`packages/ui/src/features/settings/common/LoadPaths.vue`（settings 域，不在本 skill 审查动改范围，勿误判为新增）。

## 5. 验证命令

```bash
# 测试（cwd 敏感：@ alias 只在 renderer vitest.config.ts 配置，必须从子包目录跑）
cd packages/renderer && npx vitest run                                   # 全量
cd packages/renderer && npx vitest run src/__tests__/<file>.test.ts      # 单文件（开发期增量优先）
pnpm --filter @xyz-agent/core test                                       # core 包独立 vitest

# typecheck / lint
pnpm --filter @xyz-agent/frontend run typecheck                          # vue-tsc --noEmit
pnpm lint                                                                # 根目录 eslint .

# dev 冒烟闸门（mock 轨 E2E 验证不了模块加载期副作用，[HISTORICAL] 2026-06-30 事故）
node scripts/dev-smoke.mjs                                               # exit 0 = ok
```

测试框架红线：vitest（禁 `node:test` / `tsx --test`）；timer 测试用 `vi.useFakeTimers()`。

## 6. 关联文档

- `docs/adr/0039-chat-messages-shallowref.md` — 消息 shallowRef 决策（性能基线）
- `docs/adr/0049-session-isolation-map-partition.md` — Map 分区范式 SSOT（含 CR checklist）
- `docs/standards.md` — §2.2 refCount、§3 聊天 UI 布局/自动滚动/streaming 生命周期、§7 样式规范
- `docs/architecture/conversation-stream-block-rendering.md` — block 渲染顺序/streaming 零跳变设计
- `docs/page-design/v6-tokens.css` + `v6-master-spec.md` — 设计 token 值 SSOT（hook 守卫）
- 代码注释引用的"perf 07 文档"不在 docs/ 下（在 cw harness 目录），以代码注释为准
