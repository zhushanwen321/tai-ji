# protocol · WS 协议通道（auth / rpc / subscribe / events）

> 这是**通道 B** 的原语归属文件：不绑定某个功能，而是「怎么和 runtime 说上话、怎么读它说的话」。
> 实现 = `scripts/lib/protocol.mjs`；单步 CLI = `scripts/vp.mjs`（RPC 类 capability 都经它）。
>
> 事实源：`packages/shared/src/protocol.ts`（`ClientMessageType` / `ClientMessageMap` /
> `ReplyPayloadMap` / `ServerMessageMap`）；auth 握手参考 `e2e/fixtures/launch-app-real.ts`
> 的 `openAuthedWs`（**移植语义，不 import**——它依赖 `@playwright/test`）。

---

# protocol.auth · 握手与鉴权

- **通道**：B
- **前置**：`requires: none`；依赖 `env.ready`（`<dataDir>/runtime-token` 必须先落盘）
- **用于**：所有走协议通道的 scenario / `vp.mjs` 子命令（`createProtocol` 内部自动完成）

## 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：无直接入口（runtime 是内部进程）。
- 协议：连 `ws://127.0.0.1:<runtimePort>` → 首帧发 `{ type: 'auth', payload: { token } }` → 等 `{ type: 'auth.result', payload: { ok } }`。
- 副作用点：token 缺失 = 实例未就绪（main 在 spawn + 健康检查通过后才写 `<dataDir>/runtime-token`）。

## 驱动

```bash
# 前置：端口与 token 都在盘
node .agents/skills/verify-taiji/scripts/vp.mjs env.doctor --data-dir ~/.taiji-dev/verify-<runId> --json
ls ~/.taiji-dev/verify-<runId>/runtime.port ~/.taiji-dev/verify-<runId>/runtime-token
```

程序侧：`createProtocol({ dataDir, runtimePort })`（自动读 token）→ 失败抛 `ProtocolError` 带 `hint`。

## 断言（期望终态 / 失败信号）

- 期望终态：`auth.result.ok === true`；后续任一 RPC 有 reply。
- 失败信号：
  - `runtime-token 缺失或为空` → 实例未起 / main 未写 token（先 `env.ready`）；
  - `WS auth failed: <reason>` → token 不匹配（连错实例：别人数据目录的 token）；
  - `WS auth handshake timeout` → 端口通但 runtime 未监听 WS（或端口被别的进程占）。

## 证据（A/B/C 各抓什么）

- **B（主）**：握手结果 + 首次 RPC 往返（`ping` → `pong`）。
- **C**：`<dataDir>/runtime.port`、`<dataDir>/runtime-token` 存在性；`lsof -ti :<runtimePort>` 归属 PID。
- **A**：不适用。

## 证不了

- token 的**权限语义**（任何拿到 token 的进程都能全权操作——本机模型，无分级）。
- 网络隔离（只证明本机回环可连）。

## Gotchas

- **连错实例的典型症状**：能握手但数据不对（因为连到别人的 runtime）。核对 = 端口来自本实例的 `--print` banner + `dataDir` 路径一致。
- **token 与端口必须同源**：从 A 实例拿 token、连 B 实例端口 → 鉴权失败（这是正解，不是 bug）。
- runtime 关闭后 WS 会 `close`，不要复用旧连接；`createProtocol` 每次重新握手。

---

# protocol.rpc · 请求 / 回复（含异名映射）

- **通道**：B
- **前置**：`requires: none`；依赖 `protocol.auth`
- **用于**：全部 `vp.mjs` 子命令与 scenario 的确定性断言

## 入口（用户 POV / 协议 / 副作用点）

- 协议：`{ type: <ClientMessageType>, id: <唯一>, payload: {...} }` → 等 `{ id: <同一个>, type: <ReplyType>, payload: {...} }`。
- **没有 `config.get` 这个 RPC**（`ClientMessageType` 无此条目）；连通性探针用 `ping`，配置读取用具体 RPC。

## 驱动

```bash
node .agents/skills/verify-taiji/scripts/vp.mjs session.list --data-dir ~/.taiji-dev/verify-<runId> --json
```

程序侧：`protocol.call(type, payload, { replyType?, timeoutMs? })`。

**异名回复表**（`lib/protocol.mjs` 的 `REPLY_TYPES`，缺一条就会超时）——以下是已登记的高频对：

| 请求 | 回复 |
|------|------|
| `session.create` | `session.created` |
| `session.delete` | `session.deleted` |
| `session.switch` | `session.switched` |
| `session.history` | `session.history`（同名） |
| `session.getCommands` | `session.commands` |
| `session.getContext` | `context.update` |
| `session.getSubagents` | `session.subagents` |
| `session.getWorkflows` | `session.workflows` |
| `message.send` / `message.abort` | `message.status` |
| `model.switch` | `model.switched` |
| `extension.list` | `config.extensions` |
| `plugin.list` / `plugin.toggle` | `config.plugins` |
| `ping` | `pong` |

## 断言（期望终态 / 失败信号）

- 期望终态：reply 的 `id` 与请求一致、`type` 命中映射表、payload 形状符合 `ReplyPayloadMap`。
- 失败信号：
  - **超时** = 映射表缺项（回复类型没对上）**或** runtime 未路由该 type（`unknown_type` error envelope）；
  - `error` envelope（`{ type:'error', id, payload:{ code, message } }`）→ `call` 抛 `ProtocolError` 带 `code`。

## 证据（A/B/C 各抓什么）

- **B（主）**：请求帧 + 回复帧原文（`vp.mjs` 的 `observations.reply`）。
- **C**：runtime 日志里对应的 handler 行；副作用 RPC（create/delete/switch）还需磁盘对照。

## 证不了

- 前端 renderer 是否收到 broadcast（那是 `protocol.events` 的事）。
- 并发/顺序语义（需配合 `protocol.events` 的 seq）。

## Gotchas

- **`replyType` 省略时的回落是同名**，但协议里大量异名对 → 新 RPC 上线先查 `ReplyPayloadMap`，别假设同名。
- 幂等：`session.create` 带 `clientUuid` 去重；不带则每次新建（重试会造出两个 session）。
- 超时预算：`session.create` 要 spawn pi 子进程，**给 120s 量级**；普通只读 RPC 30s 足够。

---

# protocol.subscribe · 订阅与快照

- **通道**：B
- **前置**：`requires: none`；依赖 `protocol.auth` + 一个已存在的 `sessionId`
- **用于**：所有需要读 live 事件的 scenario（`chat.*` / `subagent.*` / `workflow.*`）

## 入口（用户 POV / 协议 / 副作用点）

- 协议：`session.subscribe { sessionId, fromSeq? }` → reply `{ snapshot, stateSnapshot, lastSeq, gap? }`。
- runtime 是**订阅模型**：不订阅就收不到 session 级广播（`message.*` / `session.*` / `subagent.*`）。

## 驱动

```bash
# 单步 CLI 不做长连接订阅；订阅在 scenario 里用 lib
# ctx.protocol.subscribe(sid) → { snapshot, stateSnapshot, lastSeq }
```

## 断言（期望终态 / 失败信号）

- 期望终态：reply 带 `lastSeq`；随后的事件帧 `seq` 递增且 `gap` 缺省。
- 失败信号：
  - 订阅后收不到任何 `message.*` → 忘订阅 / sessionId 不匹配（**事件必须按 sessionId 过滤**）；
  - `gap: true` → 断连丢帧，需按 `lastSeq` 重放（`fromSeq`）或回落 `session.history` 拉取。

## 证据（A/B/C 各抓什么）

- **B（主）**：`lastSeq` / `stateSnapshot` 内容 / 事件序列。
- **C**：对照 pi session jsonl 落盘（live 事件必有对应 entry）。

## 证不了

- 帧不丢（`gap` 机制只标记，不补发——收敛靠重放或 history 拉取）。
- **transient 帧**（如 `subagent.stream_chunk` 不分配 seq）无法用序号回放。

## Gotchas

- **广播可能早于订阅**：切/建 session 后要主动拉（`session.getCommands` / `session.history`），不能假设广播已到。
- 多 session 并行验收时**每个事件都要按 sessionId 过滤**，否则断言会串（`waitFor` 的 predicate 必须带 sessionId）。
- keepalive：静默连接 45s 会被 runtime 断开（`HEARTBEAT_TIMEOUT_MS`）→ `lib/protocol.mjs` 内置 `config.get`… 注释：现实现用 `ping` 保活；**任何自定义长连接必须自己保活并清理定时器**。

---

# protocol.events · 事件帧读取与条件等待

- **通道**：B
- **前置**：`requires: none`；依赖 `protocol.subscribe`
- **用于**：`chat.wait` / `subagent.stream` / `workflow.runs` / 任何「等终态」的断言

## 入口（用户 POV / 协议 / 副作用点）

- 事件帧 = 无 `id` 的 message（`{ type, payload, seq? }`）；reply 帧有 `id`（不混入事件队列）。
- 程序侧：`protocol.events`（累积数组）+ `protocol.waitFor(predicate, { since, timeoutMs })` + `protocol.waitTurnEnd(sid)`。

## 驱动

```bash
# 事件读取只能在 scenario 内（长连接）；单步 CLI 不做
```

## 断言（期望终态 / 失败信号）

- 期望终态：`waitFor` 命中目标帧（`message.complete` / `message.error` / `session.subagents` / `subagent.*`）。
- 失败信号：`waitFor 超时` 会带 `recentFrames`（最近 20 帧类型+时间）——**这是区分「慢」与「死」的关键证据**：
  - 有推进（帧在变）→ 慢，加预算；
  - 只有心跳/无目标类型 → 死锁或忘订阅。

## 证据（A/B/C 各抓什么）

- **B（主）**：`recentFrames` 摘要 + 目标帧原文。
- **C**：超时场景下并行抓 runtime 日志尾部与 pi jsonl 尾部（判断 pi 是否在干活）。

## 证不了

- 事件与渲染的一致性（需要 A 通道对照）。
- at-least-once vs exactly-once（投递语义以 delivery 域文档为准）。

## Gotchas

- **禁固定 sleep 后断言**（pre-commit `.githooks/check-test-blind-wait.mjs` 会拦）：一律 `waitFor` / `expectVisible`。
- `message.error` 也是「回合结束」——`waitTurnEnd` 返回 `ok: false`，不要把它当成功。
- `since` 用 `protocol.events.length` 快照，防止命中上一轮的陈旧帧。
