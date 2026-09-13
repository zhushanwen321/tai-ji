---
verdict: pass
---

# ADR-0046：RPC 类型配对 SSOT（RequestReplyMap + ReplyPayloadMap）

- 状态：Accepted

## 上下文

H4 开发（perf-h3-h4-memory-jsonl）引入 `session.history`/`session.fullHistory` reply 时，发现协议类型契约断裂有两层：

1. **协议层缺口**：`ServerMessageMapBase` 未声明约 15 个有 reply 语义的 `ServerMessageType`（含 session.history/fullHistory），走兜底 `Record<string, unknown>`。`reply()` 的泛型收窄（ADR-0016 的延续，`broker.ts:101 reply<T extends ServerMessageType>(...payload: ServerMessageMap[T])`）因此失效——`ServerMessageMap['session.history']` = `Record<string, unknown>`，构造侧 reply 任意字段都通过。

2. **消费层断裂**：9 个 domain 手写 `pending.register<{...}>` 泛型参数，与 `ServerMessageMap` 完全脱钩。`useConnection.ts:86 pending.resolve(msg.id, msg.payload)` 把 `unknown` 塞进手写 T，编译器不校验。`historyTruncated` 在协议里该是 required，前端手写成了 optional（靠 `?? false` 兜底）——这种不一致编译器抓不到。

同时，request→reply 的**配对关系**从未被显式建模。配对非对称（`session.switch`→`session.history`、`session.create`→`session.created`），全靠 domain 注释和人的记忆。37 个 RPC 配对散落在 7 个 handler 文件里。

Client 侧 `ClientMessage`、Server 侧 `ServerMessage` 均已从各自 Map 派生（SSOT 已建），缺的是：
- request→reply 配对映射
- `request()` 原语类型化（现有 `request.ts` 是雏形，但 `payload: Record<string, unknown>` 无约束、`TReply` 手写）

## 决策

采用**方案 C 精简版：一级映射 ReplyPayloadMap + command() 类型化原语**。

### 一级映射

```
ReplyPayloadMap:   K（RPC request type） → reply payload
```

- **payload 消费型 K**：value 引用 `ServerMessageMap[...]`（如 `session.history` → `ServerMessageMap['session.history']`）。这些是 domain 实际读取 reply 字段的 RPC（getHistory 读 messages、file.read 读 content）。
- **ack 型 K**：value = `void`。这些是 domain 只关心 resolve/reject、不读 reply payload 的 RPC（`message.send`/`steer`/`follow_up`/`abort` + `git.stage`/`unstage`/`commit`/`checkout`，现状 `register<void>`）。void 诚实反映 domain 实际消费，避免给没人读的字段定义收窄类型（死类型）。

### command() 类型化

```
command<K extends keyof ReplyPayloadMap>(
  type: K,
  payload: ClientMessageMap[K],
  timeoutMs?: number,
): Promise<ReplyPayloadMap[K]>
```

payload 从 `ClientMessageMap[K]` 约束（消除 `Record<string, unknown>`），返回从 `ReplyPayloadMap[K]` 推导（消除手写 TReply）。命名 `command()` 对齐 D3 架构文档（`docs/architecture/design.md` D3 的 `command()` 原语）。

### 不建 RequestReplyMap

初版方案曾提议两级映射（RequestReplyMap K→reply type + ReplyPayloadMap K→payload）。spec 审查后砍掉 RequestReplyMap，理由：
- RequestReplyMap 的首要价值（运行时 reply type 漂移防御）明确在 outOfScope，本 topic 不实装——为不实装功能预建 37 条映射表是 YAGNI（AGENTS.md 规则 #7）。
- 纯编译期类型推导只需 ReplyPayloadMap 一级。
- 配对关系文档可读性经 ReplyPayloadMap 的 key 集合 + domain 调用点的 `command<K>()` 字面量已满足。
- 真到实装运行时漂移防御那天，再加 RequestReplyMap——届时每一条都有实际消费点。

## 备选方案

- **方案 A（只补 ServerMessageMap 条目）**：只补协议层缺口，不动 domain 手写泛型。治标——protocol.ts 有类型、domain 不引用，两边各写一份靠人同步，正是 `historyTruncated` required/optional 不一致的来源。
- **方案 B（补条目 + domain 从 ServerMessageMap 推导）**：domain 用 `pending.register<ServerMessageMap['session.history']>(id)`。比 A 进一步，但配对关系仍靠人记（K 写错静默通过）。
- **方案 C 两级映射（初版，已推翻）**：RequestReplyMap + ReplyPayloadMap 两级。审查发现 RequestReplyMap 首要价值（运行时漂移防御）在 outOfScope 不实装，为不实装功能预建 37 条表是 YAGNI。且给 ack 型定义收窄 status 字面量是死类型（domain 不读）。推翻为精简版一级映射。

## 理由

1. **断裂点 2（消费层脱钩）是根因**。只补协议层（A/B）不解决 domain 与协议脱钩，三个月后加字段 domain 仍不会跟着改。command() 让 domain 从协议推导，单点真相源。
2. **一致性 > 品味**（AGENTS.md 规则 #6）。当前 9 个 domain 手写泛型是既有模式，要么全改成推导、要么全留手写，不能 H4 特例。command() 统一模式。
3. **D3 API Client 的类型层子任务**。`docs/architecture/design.md` D3 设想的 `command()` 原语，本方案是其完整类型化落地 + 命名对齐。
4. **精简优先**：ack 型 = void 诚实反映消费（不死类型），不建 RequestReplyMap（YAGNI），不碰流式事件（范围不蔓延）。

## 后果

- 正面：protocol.ts 改 reply 字段 → domain + runtime 构造侧同时编译报错（单点真相源）。消除 40+ 处手写泛型。command() 命名对齐 D3 未来收口。
- 负面：新增一个映射 interface（ReplyPayloadMap，约 37 条 key，多数 value 引用 ServerMessageMap 或 void）。协议层结构略重，但集中一处优于散落 9 个 domain 手写。
- 运行时行为零变更：纯类型重构，command() 内部仍是 pending.create+register+transport.send。
- 不在范围：运行时 reply type 漂移检测（需 RequestReplyMap，留到实装时加）；流式 push 事件 payload 类型化（events 层独立 topic）。

## 状态

Accepted（cw-2026-07-17-perf-c-rpc-type-pairing）

## W6 验证 closeout（2026-07-17）

方案 C 精简版 W1-W6 全部落地，纯类型重构零行为变更，验证全通过：

- **门面三元**（`packages/renderer/src/api/index.ts`）：11 个 domain 导出（session/chat/config/model/extension/plugin/settings/git/file/composer/workspace）两侧同构，无类型报错。
- **AC-7 类型零 error**：
  - renderer `vue-tsc --noEmit` → EXIT 0（0 error）
  - shared `tsc --noEmit` → EXIT 0（0 error）
  - runtime `tsc --noEmit` → 仅 2 个预存 `src/cli/index.ts` TS1005 语法 error（与本 topic 无关，已 grep -v 排除）；除此外 0 error
- **AC-8 vitest 全量回归**：以 W1 前 commit `a6e876e0` 为 baseline 对比确认——renderer 29 失败 / runtime 42 失败**全部为 pre-existing**，与 command() 迁移零关联：
  - renderer：9 个共享测试文件（fg5-message-stream 的 mock getHistory、session-renamed/state-changed-sync、markdown、useExtensionUI、useFileSearch、flow-integration、panel/session-active-state）的失败在 baseline 同名失败；另 6 个 `system-prompt-page` 失败属 system-prompt 主题（新 untracked 测试，baseline 不存在），非本 topic。
  - runtime：7 个共享测试文件（session-service getHistory、server-extension、data-flow-integration、event-interpreter-*、bridge-sync、file-read-permission）共 16 个失败与 baseline 逐条一致；另 26 个失败全属 5 个新 untracked 的 `*-system-prompt.test.ts`（system-prompt 主题），非本 topic。
- **契约测试**：`src/__tests__/api/rpc-type-pairing.test.ts` 16/16 全绿（RequestReplyMap/ReplyPayloadMap 配对 + command() 类型化校验）。

结论：verdict pass。协议层单点真相源（ServerMessageMap + ReplyPayloadMap）已贯通 domain 与 runtime 构造侧，command() 命名对齐 D3。
