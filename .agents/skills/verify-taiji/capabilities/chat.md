# chat · 对话主链能力原语（send / stream / wait / abort / steer / revoke / reload-equiv）

> 骨架遵循 [API-CONTRACT §4](API-CONTRACT.md)：H2 即 capability id。
> testid 权威源 = [docs/testing/01-chat-panel-composer.md](../../../../main/docs/testing/01-chat-panel-composer.md)
> §3（对话流锚点——本文件「锚点」均指断言用的 DOM 定位标记：testid 或文本特征）/ §4（send 全链时序）/ §5（流式事件序表）；本文件只补「怎么驱动、断言什么、失败长什么样」。
> 组件实装：`packages/renderer/src/components/panel/{Composer,MessageStream,QueueBubble}.vue` +
> `packages/ui/src/features/chat/{Turn,Block,TextRow,ThinkingRow,ToolRow,UserBubble}.vue`。

## 通用前置（本域共用）

- `env.launch` → `env.ready` → `env.doctor` 全绿；**faux 装配**（`seed-faux.mjs`）：
  `TAIJI_FAUX_SCRIPT=<dataDir>/agent/faux-responses.json`、`TAIJI_EXTENSION_PATHS=<repo>/e2e/fixtures/faux-provider-ext`。
- faux 响应脚本 = `FauxStep[]`（数组形态，逐轮 shift 出队）：`{thinking?, text?, toolCalls?, stopReason?, error?}`。
  脚本耗尽后**无回复**（不是挂死）；多轮验收要排够 step（见 Gotchas）。
- 想观察「流式中途态」必须 `TAIJI_FAUX_TPS=<n>`（tokensPerSecond > 0 才切块限速）；
  不设 = 瞬时到达，中途断言必然错过窗口。
- 发送走**统一投递入口** `delivery.submit`（`clientUuid` 必填），**不是** `message.send`
  （后者仍在协议里，但 composer 与 btw/子代理定向消息之外的主链已统一到内核）。
  出处：`docs/testing/01` §4.1 调用链；`packages/runtime/src/services/session/session-delivery-registry.ts`。

---

## chat.send · 发送一条消息

- **通道**：A（user 气泡立即入流 / 发送位状态）+ B（`delivery.submit` 回执 + `session.delivery` 广播事件）
  + C（`agent/sessions/**` JSONL 的 user entry；`logs/pi-*.jsonl`）
- **前置**：`requires` = faux|live；依赖 `session.create` `session.switch` `protocol.rpc` `chat.wait`
- **用于**：`p0-chat-stream`（主）、`p0-session-create-first-message`、`p0-session-isolation`、
  `p1-chat-revoke`、`p0-subagent-dispatch`（派发 prompt 由用户消息承载）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：composer（`composer-box`）内点击 `role=textbox` → 逐字输入 → `Enter` 或点发送位。
  发送位文案/title 由状态派生（`panel.composer.send = '发送'`、`queueSend = '排队发送'`；
  title 形如 `发送 · ⏎` / `排队发送 · ⏎`，`Composer.vue` 的发送位分支）。
- **协议**：`delivery.submit { sessionId, content, images?, clientUuid, segments? }` →
  `DeliverySubmitReply { clientUuid, state: 'queued'|'in-flight'|'delivered'|'failed',
  lane: 'direct'|'steer'|'queued', isCommand? }`。
  失败经 `error` envelope（`message_blocked` / `invalid_payload`），**不走** reply。
- **副作用点**：`chat.appendUser`（乐观气泡 `u-<uuid>`）→ 内核受理（落磁盘 outbox）→ 投递 pi
  （`prompt`）→ `session.delivery` 全量快照广播事件 → turn 事件（`message.message_start` …）→
  pi 落 JSONL。

### 驱动

```
click  testid=composer-box
click  role=textbox                       # contenteditable
type   role=textbox "第一轮问题"           # pressSequentially（禁 fill）
press  Enter                              # 或 click title="发送 · ⏎"
```

协议（scenario 常用，绕开 UI 抖动）：

```js
await p.send(sid, '第一轮问题')            // 封装内部：delivery.submit + 生成 clientUuid
// 或显式：
const uuid = crypto.randomUUID()
const reply = await p.call('delivery.submit',
  { sessionId: sid, content: '第一轮问题', clientUuid: uuid }, { replyType: 'delivery.submit' })
```

### 断言（期望终态 / 失败信号）

- **B 成功**：reply `state ∈ {queued, in-flight, delivered}`（idle 会话通常是 `in-flight` 或
  `delivered`）、`lane='direct'`（idle）；随后 `session.delivery` 广播事件出现该 `clientUuid` 条目。
- **A 成功**：user 气泡立即出现（文本 = 输入原文）；发送位从 ↑ 变 spinner/停止态。
- **C 成功**：pi JSONL 出现 user message entry（首条消息后文件才创建）。
- **失败信号（具体形态）**：
  - `error` envelope `code='message_blocked'`：BeforeSend hook 否决——**同时**已有 `message.error`
    气泡进对话流（renderer 抑制重复 toast，`MESSAGE_BLOCKED_CODE` 注释）。
  - `code='invalid_payload'`：`sessionId/content/clientUuid` 有空串（本域唯一同步校验）。
  - UI 有 user 气泡但 B 无回执 / C 无 entry → 乐观气泡假成功（投递链断），后续无 `message_start`。
  - 气泡出现但立刻消失并 toast「发送失败」→ 投递失败（`session.delivery` 条目 state=`failed`，
    队列气泡行有重试钮）。
  - 发送位不响应 Enter（死键）：`sendRoute` 判 queued/steer 但按钮/输入被禁（见 `chat.steer`）。

### 证据（A/B/C 各抓什么）

- A：user 气泡截图 + `composer-box` 发送位 title/class。
- B：`delivery.submit` reply 原文；之后的 `session.delivery` 广播事件（条目 state 演进）。
- C：`grep -c '"role":"user"' <sessionFile>`；`ext-sessions/<sid>/logs/pi-<date>.jsonl` 里的 prompt 行。

### 证不了

- 真实 provider 的鉴权/限流/上下文溢出（faux 恒成功）。
- 「消息是否真的进了模型上下文」（只能看 pi JSONL / 下一轮回复是否引用）。

### Gotchas

1. **contenteditable 必须 `pressSequentially`**：`fill` 不触发 input 逻辑（slash/skill/@/# 检测全失效）。

   **composer 输入三态（P0「composer 输入三态」用例组，此前无 capability 承接）**：

   | 态 | 触发 | 浮层挂载点 | 断言要点 |
   |----|------|---------|---------|
   | slash | 输入 `/` 开头 | `CommandPopover`（portal 到 body） | 输入 `/` 后浮层出现；继续输入过滤；`cmd-popover-empty` 是「无匹配」不是失败 |
   | mention | 输入 `@` 或「+菜单 → 引用」 | 同上（`composer.getMentionCandidates()` 供数） | 候选来自 RPC，**空候选是合法态**（无 agent/skill 时） |
   | file | 输入 `#` 或「+菜单 → 文件」 | 同上（`composer.getFileCandidates()` 供数） | `cmd-file-empty` / `cmd-file-error` / `cmd-file-truncated` 是三态占位 |

   **共同坑**：三个浮层都 portal 到 body（全局查，别限定在 composer 内）；都依赖 `pressSequentially`
   逐字触发（`fill` 一次性赋值不会触发检测）；`Esc` 关闭走模态表面登记表的 Esc 栈序
   （见 `ui.container`）。
   `packages/ui/src/features/composer/ComposerInput.vue`。
2. **faux 队列逐轮出队**：每发一轮消耗一个 step；脚本耗尽后「发了但永远不回复」——
   看起来像挂死，实际是脚本用完了。多轮剧本要排足 step（含 abort/steer 的额外轮）。
3. **不要用 `message.send` 验 composer 链路**：composer 走 `delivery.submit`；用错 RPC 会绕过
   内核投递路径判定与队列气泡，`chat.steer` 的断言也就失效了。
4. **user 文本会回显**：faux 回复若与输入同文（或 mock 回显），`getByText` 会双匹配；让回复文本
   与输入不同。
5. **首条消息前没有 session 文件**：C 证据只能在 assistant 到达后取（规则 #6）。
6. **发送位无稳定 testid**：发送/停止/排队三态都靠 `title`（`发送 · ⏎` / `停止` / `排队发送 · ⏎`）
   与 `stop-btn` class 区分，title 会随状态/i18n 变 → 建议补 `composer-send-btn` / `composer-stop-btn`
   （当前缺稳定 testid）。

---

## chat.stream · 流式渲染（thinking / 工具 / 文本 / 变更集）

- **通道**：A（块级 DOM）+ B（`message.*` 事件序）+ C（pi JSONL 的 entry 序）
- **前置**：`requires` = faux（`TAIJI_FAUX_TPS` 用于中途态）；依赖 `chat.send` `session.create`
- **用于**：`p0-chat-stream`（主）、`p0-markdown-render`（文本块宿主）、`p0-session-isolation`、
  `p1-tool-call-render`（工具块）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：发送后 assistant 回合内出现：thinking 行（「思考」+ 耗时）→ 工具行（`工具` + 工具名）
  → 文本块（逐字追加，streaming 光标）→ 变更集卡（有文件改动时）→ 回合收尾
  （turn-meta 从「工作中」转「已工作」+ token/耗时）。
- **协议（事件序）**：`message.message_start` → `message.thinking_start` / `thinking_delta` /
  `thinking_end` → `message.tool_call_start` / `tool_call_update` / `tool_call_end` →
  `message.text_delta`（transient）→ `message.file_changes` → `message.complete`。
  事件序表 SSOT = `docs/testing/01` §5；代码 = `packages/core/src/domain/chat/chunk-processor.ts` +
  `effects/registry.ts`。
- **副作用点**：`chatStore` 分区写入（`appendAssistantChunk`），thinking/tool/text 的 `contentBlocks`
  到达顺序；`message.complete` 回填 usage 并收敛 running toolCall。

### 驱动

```
# faux 脚本（两 step：先 thinking+tool，再文本）
# [{"thinking":"分析请求","toolCalls":[{"name":"read","args":{"path":"README.md"}}],"stopReason":"toolUse"},
#  {"text":"读取完成：结论如下。","stopReason":"stop"}]
# 启动时 TAIJI_FAUX_TPS=5（拉长窗口）

click  role=textbox ; type "流式演示" ; press Enter
expect testid=block-text visible                     # 文本块（TextRow 根）
expect text=思考 visible                              # thinking 行 label（panel.message.thinkingBlock）
expect css=.trace-tool 含工具名                        # tool 行（header 是两个 span，见 Gotcha 3）
```

### 断言（期望终态 / 失败信号）

- 期望：`message.message_start` 先于任何 delta；thinking/tool/text 三类块按到达顺序出现；
  文本渐增（TPS 低速时两次采样长度递增）；`message.complete` 后 turn-meta 转完成态、
  停止位回发送位。
- **失败信号（具体形态）**：
  - 有 user 气泡但**永无 `message_start`** → 投递链/pi spawn 失败（去看 `message.error` / `session.exited`）。
  - 文本块出现但内容不增长（`text_delta` 被丢）→ 分区/sessionId 路由错，或 `isLastAssistantStreaming`
    判定失效（会永久停滞）。
  - thinking 行只在流式中出现、结束后整块消失（若连 header 都没了 → 渲染缺陷，见 Gotcha 2）。
  - 工具块停在 running 永不收尾 → `tool_call_end` 丢失（`message.complete` 会兜底收敛，
    但若 complete 也丢就会挂）。
  - `message.error` / `message.stream_error` 进流且 `isStreaming` 复位（错误作为 assistant 消息入流，
    不是顶部 banner——架构约定 #3）。

### 证据（A/B/C 各抓什么）

- A：流式中（TPS 低速）与完成态两张截图；`block-text` 文本、`.trace-tool` 文本、turn-meta 文本。
- B：事件序清单（`type` + `receivedAt`，落 `frames.jsonl`）；`message.complete` 的
  `stopReason/usage/responseModel`。
- C：`jq -r .type <sessionFile>` 的类型序列（message / toolResult / thinking 是否与 UI 一致）。

### 证不了

- 真实模型的思考质量 / 工具选择（faux 是脚本演员）。
- shiki 高亮、HTML 预览、KaTeX 等**渲染细节**（归 `render.*` 域）。

### Gotchas

1. **thinking 全文完成后不在 DOM**：`ThinkingRow` 的 `thinkingExpanded = working || !collapsed`，
   完成后收起走 `v-if`（全文卸载）。断言只断言 header（「思考」文案，恒在）+ `thinking-duration`；
   要看全文先点 header 展开。
2. **thinking 没有专用 header testid**：根定位是 Block 壳的 `block-thinking-<thinkingId>`（id 只有运行时
   知道），稳定写法是 `[data-testid^="block-thinking-"]` 或文本「思考」（`panel.message.thinkingBlock`）。
3. **工具块 header 是多个 span**（「工具」+ 工具名 + 摘要），跨 span 的 `getByText` 不可靠：
   先限定 `.trace-tool` 容器（或 `tool-block-header`）再断言工具名。
4. **`TAIJI_FAUX_TPS` 才有时序窗口**：不设 TPS 时回复瞬时到达，「流式中」类断言必然错过。
5. **faux step 与轮次一一对应**：thinking/tool/text 在**同一个 step** 里才会出现在同一轮；
   分两个 step 会变成两轮 assistant（第二个 step 需要新的 user 消息触发，或 pi 的 toolUse 续轮）。
6. **`message.text_delta` 是 transient**（不入 ring、断连即丢）：刷新/重连后只能靠 history 重建，
   不要把 mid-stream 文本当可回放证据。
7. **工具名断言别用宽泛词**（`read` 会撞正文）：限定容器后取 header 文本。

---

## chat.wait · 等待回合终态

- **通道**：B（唯一权威：`message.complete` 或 `message.error`）；A 用于交叉验证
- **前置**：`requires` = faux|live；依赖 `chat.send` `protocol.events` `protocol.subscribe`
- **用于**：几乎全部吃 LLM 轮的 scenario（`p0-chat-stream` / `p0-subagent-dispatch` /
  `p1-chat-revoke` / `p0-session-isolation`）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：无（内部等待）；用户可见对应物 = 停止位回发送位、turn-meta 转完成态。
- **协议**：`message.complete { sessionId, stopReason, willRetry, usage?, responseModel?,
  diagnostics?, errorMessage?, content? }`（`packages/runtime/src/infra/pi/event-adapter.ts`
  `extractAgentEndFields` 的产出）；错误 `message.error { sessionId, message }`。
  lib 的 `p.waitTurnEnd(sid)` 把 **`message.complete` / `message.error` / `message.stream_error` /
  `session.exited` 四类都当结束**（返回事件，调用方按 `type` 区分成功/失败）。
- **副作用点**：`finalizeSession`（收尾 streaming 气泡、收敛 toolCall、回填 usage、复位 isGenerating）。

### 驱动

```js
// 库用法（scenario 内，推荐）：先取 since 再 send，避免命中上一轮陈旧事件
const since = p.events.length
await p.send(sid, 'hello')
const end = await p.waitTurnEnd(sid, { since, timeoutMs: 120_000 })
if (!end.ok) throw new Error(`turn 失败：${end.type} ${end.payload?.stopReason}`)
```

```bash
# 单步 CLI（跨进程，连接已有实例）
node .agents/skills/verify-taiji/scripts/vp.mjs chat.wait --data-dir <dir> --sid <sid> --json
```

> **[HISTORICAL] `vp chat.wait` 的两个坑（2026-10-22 审查实测修复）**：
> ① 旧实现「新开连接 subscribe 后立刻读 occupancy 快照」，在「send 已返回、pi 尚未 start」时
> 读到 `idle` → 直接 `alreadyIdle:true` 返回，把**未开始**的 turn 判成已结束（实测
> `wait 0.3s alreadyIdle=True lens=0`）。现行默认**必须观察到终态事件**才算结束；
> 只有显式 `--allow-idle` 才走旧快路径（并在输出标 `decidedBy: 'idle-snapshot'`）。
> ② 旧实现恒返回 `ok:true`（即使 `message.complete.stopReason === 'error'`）→ codemode 会把
> LLM 404 当成功。现行 `ok` 反映 turn 是否成功，失败时 exit 1。
> → **跨进程编排优先用 `run.mjs` 的 scenario（进程内 `waitTurnEnd` 语义最强）**；
> `vp chat.wait` 只适合人工单步核对。

### 断言（期望终态 / 失败信号）

- 期望：**该轮最后一次** `message.complete`（同一 sid）满足 `willRetry === false`，且其后无新的
  `message_start`；正常路径一轮一条。

  **⚠️ 词表必须分清（wire vs pi 内部，两套值域不同）**：

  | 位置 | 值域 |
  |------|------|
  | **wire 侧** `message.complete.stopReason`（本原语断言的对象） | `end_turn`（正常）· `tool_use`（工具段结束，后面会继续，不能当终态）· `aborted`（中止）· `error`（失败）· `max_tokens` · `content_filter` |
  | **faux 脚本 / pi 内部** `AssistantMessage.stopReason`（写 `fixtures/faux-responses/*.json` 时用） | `stop` · `toolUse` · `length` · `error` · `aborted` |

  映射实现 = `packages/runtime/src/infra/pi/event-adapter.ts` 的 `STOP_REASON_MAP`
  （`stop→end_turn` / `toolUse→tool_use` / `length→max_tokens`）。
  **[HISTORICAL] 不要把 pi 侧词表套到 wire 协议上**：早期文档在断言段写 `stopReason === 'endTurn'`
  或 `'toolUse'`，全仓无 `'endTurn'` 字面量（`grep -rn "'endTurn'" packages` 零命中）→ 断言恒假。
  同理 `'toolUse'` 在 wire 上是 `'tool_use'`；写成驼峰会让「工具段未结束」的判定永远不命中。
- **失败信号（具体形态）**：
  - 等到 `willRetry:true` 的 `message.complete`（中间失败事件）就当结束 → 下一轮断言全部错位。
  - 等到超时但事件一直在推进（`message.tool_call_*` 持续）→ **慢，不是死**（用 `waitFor` 的
    最近 20 条事件类型摘要区分，API-CONTRACT §1.2）。
  - 只收到 `message.error` → 错误已入流（UI 可见 `block-text-error`），检查 `errorMessage`。
  - 等到 `message.stream_error`（不是 complete）→ 流终止，`isStreaming` 已复位，但语义是「异常终止」；
    `session.exited` → pi 进程退出（会话 dead），后续必须 `session.restore`。

### 证据（A/B/C 各抓什么）

- A：终态截图（停止位消失、turn-meta 完成）。
- B：`message.complete` payload 原文（`stopReason/willRetry/usage`）；事件时间线。
- C：`<sessionFile>` 末条 assistant entry 的 stopReason（pi 侧真相）。

### 证不了

- 真实模型的自动重试策略（faux 装配里 `retry.enabled=false`，见 `seed-faux.mjs` 写入的 settings）。

### Gotchas

1. **`willRetry` 必须过滤**：pi 每次 attempt 失败都发 `agent_end`（`willRetry=true`），只有
   `willRetry=false` 才是回合终态。⚠️ `lib/protocol.mjs` 的 `waitTurnEnd` 的 `ok` **只判
   `stopReason !== 'error'`，不看 `willRetry`** —— faux 装配已关 retry（`seed-faux` 写
   `retry.enabled=false`）所以 faux 下安全；真实模型/自动重试场景要自己再等一条
   `willRetry=false` 的 `message.complete`。
2. **`since` 必须在 `send` 之前捕获**：faux 极快时 `message.complete` 可能在 `send` resolve 前入队；
   先 `const since = p.events.length` 再 `p.send(...)` 再 `p.waitTurnEnd(sid, { since })`
   （`scenarios/p0-session-chat.mjs` 就是这么写的）。
3. **`stopReason='tool_use'` 不是回合终点**（注意是 wire 的 snake_case，不是 faux 脚本的 `toolUse`）：
   工具调用后 pi 会续下一轮 assistant，UI 会出现新的 `message_start`；等「最后一个」终态要靠
   `willRetry=false` + 无后续 `message_start`。
4. **abort 也会发 `message.complete`（`stopReason:'aborted'`）**：只看 `message.complete` 会把中止
   误判为正常完成；断言正常完成要排 `stopReason`。
5. **faux 耗时短**：`waitFor` 的 predicate 不要用「等 500ms 后仍 streaming」这类时间推断
   （红线 1 + 时间平抑红线）。

---

## chat.abort · 中断当前回合

- **通道**：A（停止位 → 发送位；可继续发新消息）+ B（`message.abort` 回执 + 广播
  `message.complete{aborted}` + `session.occupancy` 回落 idle）+ C（pi 侧 abort 记录 / 日志）
- **前置**：`requires` = faux（低 TPS 制造流式窗口）；依赖 `chat.send` `chat.stream` `chat.wait`
- **用于**：`p0-chat-stream`（中断子项）、`p0-interrupt-cancel`（主）、`p0-session-isolation`（后台会话中止）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：流式中发送位变停止钮（class `stop-btn`，title = `停止`；压缩期 title =
  `终止压缩`，`panel.composer.stopCompacting`）→ 点击。
- **协议**：`message.abort { sessionId }` → reply `message.status { sessionId, status: 'aborted' }`；
  runtime 随后**主动广播** `message.complete { sessionId, stopReason: 'aborted' }`
  （`packages/runtime/src/services/session/message-dispatcher.ts` abort 收尾段）。
- **副作用点**：pi `abort`（协作式）→ occupancy `generating → idle` → 失效挂起交互
  （`extension:requestsInvalidated`：审批条/表单/ask-user 一并解散）。

### 驱动

```
expect title="停止" visible             # 流式中
click  title="停止"                     # 或 css=.stop-btn
expect title=/^发送/ visible            # 回到发送位
```

```js
await p.call('message.abort', { sessionId: sid }, { replyType: 'message.status' })
```

### 断言（期望终态 / 失败信号）

- 期望：reply `status='aborted'`；`message.complete.stopReason==='aborted'`（同 sid）；
  `session.occupancy.turn === 'idle'`；A 侧停止位消失、发送位回归；**能立刻再发一条并得到回复**
  （isGenerating 复位，不卡死）。
- **失败信号（具体形态）**：
  - 停止钮点后仍在（`sendButtonState` 仍 stop）→ occupancy 未复位（isGenerating 卡住）。
  - reply `status='aborted'` 但没有 `message.complete` 广播 → 前端流式态永不收尾（历史事故：
    只 resolve Promise 不广播，`docs/testing/01` §4.2 记录）。
  - abort 后 `turn-meta` 仍显示「工作中」/思考行还在扫光 → 收尾链断。
  - abort 后发新消息被拦（toast「会话正在处理中」）→ 占用未回落。
  - 挂起的审批/表单没消失（僵尸 ready）→ 失效链断。

### 证据（A/B/C 各抓什么）

- A：流式中（点停止前）、中止后各一张截图；`sendButtonState` 的 DOM title 前后。
- B：`message.status` reply；`message.complete{aborted}` 事件；`session.occupancy` 前后两条事件。
- C：`ext-sessions/<sid>/logs/pi-<date>.jsonl` 里的 abort 信号；`<sessionFile>` 尾部若有
  abort 记录（pi 侧形态）。

### 证不了

- 「pi 是否真的立刻停止烧 token」（faux 是本地演员；真实模型的 abort 语义只能 live 验）。
- `session.forceQuit`（强杀进程）与 abort 的区别：forceQuit 走 `message.status{force_quit}` +
  `session.exited`，**不**发 `message.complete{aborted}`（`handleSessionForceQuit` 注释）。

### Gotchas

1. **压缩期按钮 title 变「终止压缩」**：此时点按钮中止的是**压缩流程**，不是回合（`sendButtonStopTarget`）。
   断言 `title='停止'` 前先确认不在压缩态（`session.occupancy.compacting === false`）。
2. **staging（fork/handoff）优先于 stop**：staging 激活时发送位是 fork/handoff 发送钮，停止钮不渲染；
   要先 Esc 退出 staging。
3. **abort 不广播 `message.error`**：UI 不该出现红色错误条；出现 = 把主动中止错标成错误
   （`event-adapter.ts` 的 `aborted → noop` 分支就是为此）。
4. **abort 不清队列**：只有 `session.forceQuit` 会 `delivery.drain`；abort 后队列条目继续存在
   （`docs/testing/01` §4.4 与 `delivery.drain` 注释）。
5. **后台会话也能 abort**：会话不必在前台；但 UI 上只有前台能看到停止钮（协议侧可以直接 abort）。

---

## chat.steer · 流式中追加（steer 投递路径）

- **通道**：B（`delivery.submit` 回执 `lane='steer'`）+ A（回合不被打断、追加内容进入当前回合；
  队列气泡可能一闪）
- **前置**：`requires` = faux（低 TPS 拉长窗口，保证提交时 occupancy 仍 generating）；依赖
  `chat.send` `chat.stream` `chat.abort`
- **用于**：`p0-chat-stream`（steer 子项）、`p0-interrupt-cancel`（与 abort 对照）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：流式中继续输入 → `Enter`。不打断当前回合（`Alt+Enter` 名义上是 followUp，但见 Gotcha 3：
  当前线与 steer 走同一 RPC 且 intent 缺省为 `interrupt-at-turn-boundary`）。
- **协议**：仍然是 `delivery.submit`（**没有 `message.steer`**，该条目已退役）。
  lane 判定唯一实现在 runtime 内核：`laneOf(view)` = 不可投（compacting）→ `queued`；
  活跃 run（`turn ∈ {generating, dispatching}`）→ `steer`；否则 `direct`
  （`session-delivery-registry.ts`）。
  投递意图 `intent` 不在 `delivery.submit` 协议里（payload 无该字段）；runtime 取
  `input.intent ?? 'interrupt-at-turn-boundary'`，映射 `streamingBehavior='steer'`
  （`toStreamingBehavior`）。
- **副作用点**：pi steering 队列；回合完成后追加的 user 内容进入历史；`session.delivery` 条目终态
  （`delivered` / `handled`）。

### 驱动

```
# TAIJI_FAUX_TPS=3 的实例
type "长回复" ; press Enter                 # 等 title="停止" 出现
click role=textbox ; type "追加一句" ; press Enter     # 同一输入框
expect title="停止" visible                 # 回合仍在进行（没被打断）
```

```js
const reply = await p.call('delivery.submit',
  { sessionId: sid, content: '追加一句', clientUuid: crypto.randomUUID() },
  { replyType: 'delivery.submit' })
// 断言 reply.lane === 'steer'
```

### 断言（期望终态 / 失败信号）

- 期望：reply `lane='steer'`；当前回合继续（同一 `messageId` 的 delta 继续，无新的 `message_start`
  抢占）；本轮结束后追加内容作为 user 消息出现在历史里（`session.history` 可见）。
- **失败信号（具体形态）**：
  - reply `lane='direct'` → 提交时 occupancy 已 idle（TPS 太快 / 已经收尾），本次验的不是 steer。
  - reply `lane='queued'` → 会话处于 compacting（被 hold），走的是排队而非 steer。
  - 当前回合被中断（`message.complete{aborted}`）→ 错走了 abort 通道。
  - 追加内容丢失（history 里没有）→ pi 未消费 steering 队列（条目可能被对账收回，查
    `session.delivery` 条目终态）。
  - 输入被禁用 / Enter 死键 → `sendRoute` 与按钮态分叉（见 abort Gotcha 1）。

### 证据（A/B/C 各抓什么）

- A：流式中 + 追加后 + 完成态三张截图（或两次 `block-text` 长度采样）。
- B：`delivery.submit` reply（lane）；`session.delivery` 条目状态演进；本轮 `message.complete` 只有一次。
- C：`<sessionFile>` 里追加消息的 user entry 出现在同一 turn 之后（pi 侧位置）。

### 证不了

- 「steer 文本被模型真的采纳」（faux 不读上下文；只能证明投递与历史落位）。
- **followUp 投递路径**（`intent='after-run'`）当前无用户可达入口（见 Gotcha 3），标不可达。

### Gotchas

1. **窗口极短**：faux 不设 TPS 时回复瞬时完成，无法制造 steer 窗口；必须 `TAIJI_FAUX_TPS` 个位数。
2. **steer 与 queued 长得像**：都走 `delivery.submit`，唯一区别是回执 `lane`；不要用「出现了队列气泡」
   判断 steer（队列气泡只显示未送达条目，steer 条目可能瞬间 delivered 不渲染）。
3. **`Alt+Enter` 目前与 `Enter` 不可区分**（代码事实）：两者都汇入 `delivery.submit`，而该 payload
   **没有 intent 字段**，runtime 缺省 `interrupt-at-turn-boundary` → `streamingBehavior='steer'`。
  评论里的「followUp 保留语义」在线级不成立（`composer-keydown` / `useComposerKeydown` 的
   分发层存在，但线上痕迹相同）。要验 followUp 语义需专门的 in-process 测试（本技能测不了）。
4. **steer 后回合只 complete 一次**：如果看到两次 `message.complete`，多半是另开了一轮（模型
   以 toolUse 继续），不是 steer。

---

## chat.revoke · 消息撤回（会话树内回退）

- **通道**：A（user 气泡消失 + 草稿回填）+ B（`session.revokeMessage` 回执 +
  `revoked/error` 判别）+ C（pi JSONL 树回退后的文件内容）
- **前置**：`requires` = faux（先发一轮）；依赖 `chat.send` `chat.wait` `session.history`
- **用于**：`p1-chat-revoke`（主）、`p1-derived-panels-rebuild`（撤回后 plan/todo/goal/scheduler 重建）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：hover 一条 user 气泡 → 出现 `msg-revoke-button`（title =
  `撤回（回到发送前，原文回草稿）`；生成中 `aria-disabled=true`，title =
  `生成中，停止后可撤回`）→ 点击。
- **协议**：`session.revokeMessage { sessionId, targetId }` → 同名 reply
  `{ revoked: true, content } | { revoked: false, error }`，`error ∈`
  `busy | no-mapping | extension-missing | nav-failed | pi-reclaimed | workflow-running`
  （`RevokeMessageErrorCode`，`packages/shared/src/protocol.ts`）。
- **副作用点**：runtime 七步编排（`RevokeOrchestrator`）→ `__taiji_nav__ <entryId>` 内部命令
  触发 pi `navigateTree` → 校验 `get_entries` → 回执（`revoked:true + content`）。
  renderer 收到成功后**主动重拉 history**（`reconcileHistory`）+ `restoreRevokedDraft(reply.content)`
  回填草稿。
- **在途分支（重要）**：若目标消息还没 delivered（内核派生视图 `state !== 'delivered'`），
  撤回**不走** `session.revokeMessage`，而走 `delivery.cancel`（队列气泡 × 撤销同一管道）。

### 驱动

```
hover  css=.turn-1 .group\/user            # 悬停 user 气泡行（hover 动作区 opacity 才可命中）
expect testid=user-bubble-actions visible  # 动作槽（常驻但 opacity-0 + pointer-events-none）
click  testid=msg-revoke-button
expect css=.turn-1 count=0                  # 该 user 气泡消失（后续 assistant 一并回退）
expect role=textbox 含原文                   # 草稿回填（restoreDraft）
```

### 断言（期望终态 / 失败信号）

- 期望：reply `revoked:true`；`content` 含原文（可能含投递标记，由 `restoreRevokedDraft` 剥）；
  对话流回退到该消息之前（被撤消息 + 其后的 assistant/turn 全部消失）；草稿回填；
  `session.history` 不再含被撤内容；C：JSONL 树被回退（文件内容不再含该 entry 之后的分支）。
- **失败信号（具体形态）**：
  - `revoked:false` + `busy`：会话在 streaming/compacting/settling/bash/revoking —— 等停或先 abort。
  - `revoked:false` + `no-mapping`：`targetId` 定位不到（live 气泡 id 用了 `u-<uuid>` 但条目已 delivered
    且映射丢失 / 重开后用了错误的 id 空间）。
  - `workflow-running`：有 workflow run 在跑（撤回不得静默终止后台任务）——先 abort run。
  - `pi-reclaimed` / `extension-missing` / `nav-failed`：agent-ext 通道问题（`__taiji_nav__` 命令）。
  - UI 气泡消失但 history 仍有内容（刷新即复活）→ 只改了前端分区，没真回退。
  - 派生面板残影（plan/todo 面板还显示被撤回合的状态）→ 派生重建链断（P1 契约）。

### 证据（A/B/C 各抓什么）

- A：撤回前/后对话流截图；草稿框文本；派生面板截图（若涉及）。
- B：`session.revokeMessage` reply 原文；随后 `session.history` 的 messages 列表。
- C：`<sessionFile>` 行数 / 末条 entry id 前后对照（树回退）；`*.jsonl` 里不再有被撤 entry 的分支。

### 证不了

- 「模型上下文是否真的不再引用被撤内容」——只能间接（下一轮回复不提及）或看 pi 侧 entry 树；
  faux 不读上下文，此项在 faux 下不可证。
- 定时任务是否「不复活」（scheduler 域，需 scheduler 面板 + 真实定时链路）。

### Gotchas

1. **两套 targetId 空间**：live 乐观气泡 = `u-<uuid>`（= clientUuid），reload/历史 = pi entryId
   （8 位 hex）。把 clientUuid 定死会失败（protocol 注释明写）。UI 驱动最稳：直接点按钮（它内部选对 id）。
2. **在途撤回是另一条通道**：消息还在队列里时点撤回 → `delivery.cancel`（reply
   `{cancelled, content}`），不是 `session.revokeMessage`。断言 reply 类型别写错。
3. **撤回后 history 重拉是主路径**：`session_tree` 没有事件可订阅，前端靠 reply 成功后的主动拉；
   所以「撤回成功但 UI 没变」常常是重拉失败（warn 日志：`post-revoke history refresh failed`）。
4. **生成中按钮是「伪禁用」**：`aria-disabled` + click 检查（不是 `disabled` attribute），
   所以 `toBeDisabled()` 不会绿；断言 `aria-disabled="true"`。
5. **撤回不回滚「已发生的结局」**：session_end/meta 是事实，撤树不改它（`session-file-utils` 注释）。
6. **动作钮需要 hover**：`msg-revoke-button` 在 `user-bubble-actions` 槽内，默认 `opacity-0 +
   pointer-events-none`（悬停/键盘聚焦才可命中）；先 hover `.group/user` 行再点，否则点击被吞。

---

## chat.reload-equiv · live ≡ reload 等价性（P0 核心证明）

- **通道**：A（live 结束态 UI 与 reload 后 UI 逐项一致）+ B（`session.history` 与 live 事件序列同源）
  + C（pi JSONL entry 序）
- **前置**：`requires` = faux（`TAIJI_FAUX_TPS` 可选）；依赖 `chat.send` `chat.stream` `chat.wait`
  `session.history` `session.persistence` `session.switch`
- **用于**：`p0-session-persistence`（主）、`p0-chat-stream`（收尾断言）、`p0-markdown-render`

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：发完一轮后关掉重开（或切走再切回），对话流长得一样：同样的块、同样的文本、
  同样的工具结果、同样的 usage 徽标。
- **协议 / 机制**：单一 reducer 双路喂入——live 走 `applyEntryFrame`（每条事件喂一条 entry），
  reload 走 `replayEntries` fold；两条路径共用同一份派生段（`packages/core/src/domain/chat/apply-entry.ts`
  头注：ADR-0062「实时事件与文件重放喂同一 reducer」）。`session.history` 由
  `convertPiHistory`（= lift + `replayEntries`）产出。
- **副作用点**：切回已 hydrate 的会话会**主动** `refreshHistory`（`runEntryChain` 第 9 步）→
  `reconcileHistory`（基线替换 + 保留 streaming 尾部）。

### 驱动（三级强度，按成本选）

**① 最轻（协议对账，日常回归）**

```js
// 一轮结束后
const liveText = await ui.text('[data-testid="block-text"]')          // 或按 turn 取
const h = await p.call('session.history', { sessionId: sid }, { replyType: 'session.history' })
// 断言 h.messages 里的 assistant 文本 / user 文本 / toolCalls / usage 与 live UI 一致
```

**② 中（切走再切回，走真实 reload 数据通路）**

```
click css=.session-item hasText=<另一个会话>
click css=.session-item hasText=<目标会话>
expect testid=block-text 文本 == 记录值
expect testid=turn-0 / turn-1 计数不变
expect testid=turn-meta-0 含「已工作」与 token 徽标
```

**③ 最强（应用级重开）**

```bash
kill <本实例 dev-instance PID>
TAIJI_DEV_BACKGROUND=1 TAIJI_FAUX_SCRIPT=... TAIJI_EXTENSION_PATHS=... \
  node apps/electron/scripts/dev-instance.mjs --data-dir <同一 dataDir>
# 重新 CDP 连接 → 点侧栏该会话 → 断言内容与记录值一致
```

### 断言（期望终态 / 失败信号）

- 期望：
  - 文本逐字一致（含 markdown 原文）；
  - 块序列一致（thinking → tool → text 的顺序，`contentBlocks` 不变）；
  - turn 数一致、每个 `turn-meta-<i>` 的「思考 ×N / 工具 ×N」徽标一致；
  - usage/token 徽标一致（`turn-meta-tokens`）；
  - `session.history.messages[].piEntryId` 存在（后续 fork/revoke 精确性前提）。
- **失败信号（具体形态）**：
  - reload 后文本缺失一段（live 有、history 无）→ reducer 两路派生分叉；
  - reload 后多出一条重复消息（reconcile 基线替换与 streaming 尾部双计）；
  - reload 后 thinking 块整块消失（`applyEntry` 未建模 thinking part）；
  - reload 后工具块只有 header、没有输出（toolResult 配对失败/窗口截断）；
  - reload 后 turn 折叠条计数变化（`思考 ×2` → `×1`）= entry 派生口径漂移；
  - 重开后会话不在列表（持久化失败，见 `session.persistence`）。
- **反向信号（等价性未成立但看起来绿）**：只断言「有文本」，不比对逐字/块序 → 属弱断言，
  scenario 不应这么写。

### 证据（A/B/C 各抓什么）

- A：live 结束态 + reload 后两张截图；按 turn 抽取的 DOM 文本快照（`attach('live-dom.txt')` /
  `attach('reload-dom.txt')`）。
- B：`session.history` reply 的 messages 摘要（role/content 前 N 字/piEntryId/toolCalls 名）；
  live 期间 `message.*` 事件类型序列。
- C：`<sessionFile>` 的 entry 类型序列与条数（与 B 的 messages 对账）。

### 证不了

- **真实模型/真实 provider** 下的 entry 形态差异（faux 只产 text/thinking/toolCall 的有限形态）。
- 图片 / 附件 / 变更集的全类型等价（需真实工具产物；见 `render.image` / `render.changeset`）。
- 内存压力下的 LRU 驱逐后重载（可造：切 9 个会话触发驱逐，`LRU_MAX_SESSIONS = 8`，
  `packages/core/src/domain/chat/lru.ts`）。

### Gotchas

1. **pi 延迟写入**：首 assistant 之前 JSONL 不存在；等价性取证必须在首 assistant 之后。
2. **等价性不是「UI 文本存在」**：必须逐字 + 块序 + 计数三件套都对比；只断言存在会漏掉
   「live 多一段 / reload 少一段」这类真实分叉。
3. **切走再切回会**走 `refreshHistory`（不是零请求），这正好是最便宜的真实 reload 通路；
   但**同一会话 LRU 内切回**只在已 hydrate 时刷新，未 hydrate（被驱逐）走全量 `session.history`。
4. **强形态重开要复用同一 `--data-dir`**（`~/.taiji-dev/verify-*` 树内）；换目录 = 新环境，验不到。
   重开后 CDP 端口不变（同 worktree hash），但仍要核对页面 URL 属本实例（doctor）。
5. **thinking 完成态在 reload 后只有 header + 预览**：`ThinkingRow` 收起是 `v-if`，reload 后不会
   自动展开；比对 thinking 全文需要点开。
6. **label 不持久**（landing 建会话）：reload 断言里不要比 label（见 `session.create` Gotcha 3）。

## chat.queue-delivery · 队列投递域（chat-flow-consistency 交付，2026-10-24）

**新增能力点**（剧本在 `scenarios/`，登记见 [P0-P1-COVERAGE.md](P0-P1-COVERAGE.md) §五）：

- **队列区原位编辑**（✎ 编辑）：锚定分区 `useQueueEditAnchor`（把输入框草稿绑定到被编辑队列条目的在编状态；ADR-0049 #76）+ delivery.edit 回执四值 `delivered/unconfirmed/cancelled/not-found`（Q3 如实化）；× 清除 = delivery.cancel + 草稿回填（V9/V10 既有行为）。剧本 `p1-queue-inline-edit`。
- **队列操作幂等**：编辑/取消/清除/重发/+N 展开收起/重试全部（resync）反复操作后 delivery.peek 只读视图一致。剧本 `p1-queue-ops-idempotent`。
- **回合中插话与收起时机**：occupancy 四维状态机（shared `isActiveTurnPhase`）驱动——工作态回合不收起、计时持续；插话入队、回流自动开新回合。剧本 `p1-turn-interject-collapse`。
- **settling 窗口投递**：ACTIVE_TURN_PHASES 含 settling，窗口内追问 steer 即时受理；确定性窗口 = dev 开关 `TAIJI_AGENT_DEV_SETTLING_DELAY_MS=2500`（runner 经 meta.env 透传）。剧本 `p1-settling-steer-delivery`。
- **块序定稿重建**：message_end(assistant) 按载荷整条重建（id 匹配优先/位置兜底三级定位），reload ≡ live 块序。剧本 `p1-block-order-replay`。
- **思考形态**：GLM end.content 全文思考 + 空思考条目轮，UI 思考块唯一性 + reload 等价。剧本 `p1-thinking-event-form`。
- **断连自愈结果验收**：WS 断连（routeWebSocket）重连后残留收尾 + 权威接管 + UI ≡ reload；D4 recoverStalledSession 专属触发路径（终态事件处理链半途抛错）黑盒不可达，剧本 `p1-disconnect-selfheal` 按实测登记 notProvable。

### Gotchas（本批实测新增）

1. **协议直发 user 消息 live 气泡可能间歇缺失**（registry 防御机制静默消费竞态，docs/todo/rpc-direct-send-user-bubble.md）——协议直发剧本断言 user 原文在场会假失败，改走 composer 真实用户路径（p1-block-order-replay 先例）或登记重试。
2. **clientUuid 必须是 `u-<8-4-4-4-12 hex>` 合法 marker 身份段**（shared MSG_ID_TAG_RE）——lib randomUuid 已修；自拼形态会使 edit/cancel 的 marker 匹配失败（条目被收养为新条目 + unconfirmed）。
3. **队列编辑替换输入用「聚焦 → Meta+a 全选 → 直接键入」**——禁「全选→Backspace」：空草稿边沿解除锚定 watch，Enter 走普通发送降级。
4. **turn-meta 索引 1-based**（message-turns index=i+1）；dev 模式 DOM 保留组件模板注释，裸 substring 判「已工作/已工作过」恒误报（读渲染标签文本需过滤注释节点）。
5. **建会即订阅 + 首个 submit 前的会话**：session.delivery topic 由 registry 的 onRuntimeCreated 创建事件补接线（2026-10-24 修复前需补一次 subscribe；旧产物剧本保留该绕行，事件断言仍有效）。
