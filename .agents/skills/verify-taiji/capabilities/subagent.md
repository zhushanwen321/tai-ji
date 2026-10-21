# subagent · 子代理能力原语（dispatch / list / stream / cancel / model）

> 骨架遵循 [API-CONTRACT §4](API-CONTRACT.md)：H2 即 capability id。
> 事实源：工具定义 `extensions/universal/subagent-workflow/src/interface/tool/{subagent-tool,tool-subagents}.ts`；
> 协议 `packages/shared/src/protocol.ts`（`session.getSubagents` / `session.getSubagentStreamState` /
> `session.subagentAction` / `subagent.stream_*`）；载荷 `packages/shared/src/subagent.ts`（`SubagentRecord`）；
> UI `packages/renderer/src/components/panel/{SubagentTab.vue,tray/TrayNativePanel.vue}` +
> `packages/ui/src/features/chat/SubagentRow.vue`。
> 观察入口只有一处：**composer 任务托盘**（侧栏 Agents tab 已于 2026-09-16 退役）+
> drawer subagent 详情 tab + 对话流 tool 块。

## 通用前置

- `env.ready` + `env.doctor`（扩展装载 N≥8，否则 `subagent_start` 工具不存在）。
- **派发是 agent 驱动的**：没有「用户直接派发子代理」的按钮。用户路径 = 在 composer 里让 agent
  去委派（或直接说「用 subagent 做 X」），agent 调工具。因此 `subagent.dispatch` 的
  A 通道证据 = 对话流里出现 subagent 工具块。
- 孙进程模型/LLM 可达性：**faux 通道不可达（已实测），mock-http 通道可达（已实测）**——SSOT = `capabilities/env.md` 的 Gotchas。
  探针：`scripts/probes/faux-grandchild.mjs`（结论 `verified-unreachable`）/
  `scripts/probes/mock-llm-grandchild.mjs`（结论 `mock-grandchild-reachable`）。因此本节断言分两层：
  - **结构层（faux / mock-http 均可验）**：工具调用被受理、record 出现、列表/详情/流通道/取消通道工作；
  - **执行层（`requires: mock-http | live`）**：子代理进程真的用某模型跑完一轮并回结果——
    **mock-http 通道可零 token 验**（本机 mock OpenAI provider，`createInstance({ llm })` 装配；
    孙进程只依赖 `PI_CODING_AGENT_DIR` 下的 models.json，不需要任何 extension）；
    faux 通道下不可达（实测失败形态：`Model "faux/..." not found` + record `stopReason: failed`）。

---

## subagent.dispatch · 派发子代理

- **通道**：A（对话流 subagent 工具块 + 托盘计数）+ B（`session.getSubagents` /
  `session.subagents` 帧、`subagent.stream_*`、完成通知）+ C（`ext-sessions/<rootSid>/subagents/`
  记录树 + 子代理 pi 进程）
- **前置**：`requires` = faux（结构层）/ **mock-http | live**（执行层）；依赖 `session.create`
  `chat.send` `chat.wait` `extension.load` `subagent.list`
- **用于**：`p0-subagent-dispatch`（主）、`p0-chat-stream`（工具块子项）、
  `p0-model-switch`（dispatch 时模型参数）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：对话里要求委派（如「用 subagent 审一下这个 diff」）→ assistant 回合出现一条
  subagent 行（`subagent-block`：`子代理` + agent 名 · slug + `(model · thinking)`）→
  点击该行打开 drawer subagent tab；composer 托盘出现 `tray-builtin-button[data-kind="subagent"]`
  计数（三态：running>0 亮 / 仅有历史 dim / 全无隐藏）。
#### 发起 subagent 的全部方式（共 4 条，别只记一种）

| # | 方式 | 入口 | 适用 |
|---|------|------|------|
| 1 | **agent 工具调用**（主路径） | 对话里要求委派 → agent 调 `subagent_start` / `subagents` | 绝大多数验收场景 |
| 2 | **托盘观察/取消** | composer 托盘 `tray-builtin-button[data-kind="subagent"]` → 面板 → 行内取消 | 只能观察与中止，**不能发起** |
| 3 | **session-manager 的 8 工具** | `create_managed_session` 等（agent 调） | 建的是**独立托管会话**，不是 subagent record（见 `subagent.session-observation`） |
| 4 | **续聊 / fork** | `subagent_message`（`action: message` / `fork-from`） | 对已有 record 续派，不是新发起 |

> **没有**「快捷键直接派 subagent」的入口；也**没有** GUI 里的「新建子代理」按钮。
> 发起权只在 agent（工具调用）——这是设计约束（subagent 的 task 由主 agent 编排）。
> 验收「能不能发起」= 验工具可用且 record 落地，不是找按钮。

- **协议（agent → 工具，不是 RPC）**：三个工具（`subagent-tool.ts` 注册）：
  | 工具 | 用途 | 关键参数 |
  |---|---|---|
  | `subagent_start` | 单个委派（后台跑，完成通知） | `task`（必填）、`slug`（必填，≤35） |
  | `subagents` | 批量派发 N 个独立任务（内部固定 `fan-out` 模板） | `tasks: string[]`（必填）、`agents?`、`aggregate?`、`slug?` |
  | `subagent_message` | 续聊 / 从历史 fork | `action: message|fork-from` + `subagentId`/`sourceSubagentId` |
  可选（`subagent_start`）：`agent`（绝对 .md 路径）、`model`（`provider/modelId`）、
  `thinkingLevel`、`fork`、`cwd`、`skillPath` 等。
  **模型解析三层**：`model` 参数 > agent frontmatter > 主 agent 当前模型
  （`subagent-tool.ts` `resolveModel` 注释）。显式给了不存在的模型**抛错，不静默回落**。
- **副作用点**：`SubagentService` 建 record（record 事件文件）→ spawn 引擎子进程（pi 引擎 =
  `packages/pi-subagent-cli`）→ 事件流进 `subagent` 域；完成后经通知（notifyDone）注入父会话、
  `session.workflows` 不涉及（单 subagent 不进 workflow 列表）。

### 驱动

```
# A 路径（最真实）：让 agent 去派发
click  role=textbox ; type "用 subagent_start 派一个子代理，task=检查 README，slug=chk-readme" ; press Enter
expect testid=subagent-block visible                       # 工具块
expect testid=tray-builtin-button[data-kind=subagent] visible
click  testid=tray-builtin-button[data-kind=subagent]
expect testid=tray-panel[data-panel-key="native:subagent"] visible
expect testid=tray-subagent-row visible
```

```
# 详情：对话流块点击 / 托盘行点击 都能进 drawer subagent tab
click  testid=subagent-block
expect testid=drawer-tab-subagent visible                  # 抽屉已切到 subagent
```

### 断言（期望终态 / 失败信号）

- 期望（结构层）：
  - 对话流出现 `subagent-block`，header 含 agent 名与 slug；`(model · thinking)` 括注与解析结果一致；
  - `session.getSubagents` 返回的 `subagents[]` 含该 `subagentId`（`agent/slug/task/status/model?/turns?`）；
  - 托盘出现计数；drawer subagent tab 可打开并渲染；`body 圆点/spinner` 与 `status` 一致。
- 期望（执行层，**`requires: mock-http | live`**）：子代理进程完成 →
  父会话收到完成通知（一条 assistant/tool 结果）→ record `status` 收敛（`idle`）+
  `turns/totalTokens/elapsedSeconds` 有值。
  **mock-http 通道断言要点**：① record 终态 `status ∈ {done, idle}`；② `instance.mockLlm.requests`
  里出现 `model === '<subModel>'` 的请求（铁证：孙进程真的打到 mock）；③ 成员剧本里的 canary 文本
  出现在 record / 子会话 JSONL。三件齐才判可达（探针 `scripts/probes/mock-llm-grandchild.mjs` 即此形态）。
- **失败信号（具体形态）**：
  - `subagent_start` 直接报错：`subagents runtime not initialized (session_start assembly failed)`
    （扩展装配失败——`assertServiceAvailable` 的文案含恢复动作）；
  - `model` 参数拼写错：工具报错并带 "Did you mean" 建议（大小写敏感，禁静默回落）；
  - `agent` 传相对路径 / 裸名 / 含 `..`：`assertSafeStartPath` 拒绝（必须绝对路径）；
  - 派发后托盘**没有**行、`session.subagents.subagents` 为空 → record 未建（工具未真正执行）;
  - 父会话永久「工具运行中」、subagent 行 spinner 不转完 → 子进程卡死/未完成（看
    `ext-sessions/<rootSid>/logs/` 与子代理 record 文件）；
  - 完成通知没到（父会话等不到结果）→ 通知链断（`pending-notifications` / notifier）。
- **批量形态（`subagents`）**：`tasks` 逐项一条成员；全批结束才发**一条**通知（不是每成员一条；
  `tool-subagents.ts` 头注）。断言「N 条 tray 行 + 一条通知」。

### 证据（A/B/C 各抓什么）

- A：对话流 subagent 块截图（含 model 括注）；托盘 subagent 面板截图；drawer 详情截图。
- B：`session.getSubagents` reply（含该 record 全字段）；`session.subagents` 帧；完成通知相关帧。
- C：`<dataDir>/ext-sessions/<rootSid>/subagents/`（`records/<sa-id>.events` / `sessions/` /
  `model-switch/`）；
  子代理 pi 进程（`ps -o command=`，看 `--model` / `--session-dir`）；`subagents/sessions/**` 的 JSONL。

### 证不了

- **孙进程 faux 通道不可达**（已实测）：`capabilities/env.md` + 探针 `scripts/probes/faux-grandchild.mjs`
  （`--no-extensions` + 白名单仅 structured-output；`TAIJI_E2E=1` 门）。所以「子代理用 faux 回话」
  不可断言；能断言的是工具受理 + record 结构 + 通道工作。
  **执行层请走 mock-http 通道**（`createInstance({ llm })`，探针 `scripts/probes/mock-llm-grandchild.mjs`
  结论 `mock-grandchild-reachable`）；mock 回复本身无语义，模型行为/成本仍不可断言。
- 真实模型下的任务质量/工具选择。

### Gotchas

1. **`subagent_start` 是后台的**：调用立即返回 `subagentId`，没有同步结果；结果经完成通知到达
   （`description` 明写 "You cannot get a synchronous/inline result"）。断言「派发成功」看工具块 +
   record，不要等「一轮 assistant 总结」。
2. **`slug` 必填**（≤35 字符）且用于行内区分并发；缺 slug 工具报错。
3. **`subagents` 批量成员是一次性成员**：不可 `message` 续聊（workflow-origin record 拒绝）；
   结果在 run 收尾时一条通知到达。
4. **托盘三态**：`total === 0` 时 builtin 按钮**不渲染**（`ComposerTray` 的 `builtinItems`）——
   「按钮不在」= 无记录，不是功能挂。
5. **`session.subagents` 的 `found`/`oversize`**：`found=false` = 主会话文件不在册（pi 延迟写入窗口），
   消费方保留旧分区；`oversize=true` 是旧格式兼容降级。断言列表为空前先看这两个字段。
6. **工具块渲染分派**：subagent 走 `SubagentRow`（`subagent-block`），workflow 走 `WorkflowRow`
   （`workflow-block`），普通工具走 `ToolRow`；别用 `tool-block-header` 当唯一锚。

---

## subagent.list · 子代理列表（RPC + 状态帧）

- **通道**：B（`session.getSubagents` + `session.subagents` state 帧）+ A（托盘行 / drawer 详情）
- **前置**：`requires` = none（读结构）；依赖 `subagent.dispatch`（要有记录）
- **用于**：`p0-subagent-dispatch`、`p0-subagent-cancel`、`p0-subagent-model`

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：composer 托盘 subagent 面板（`tray-native-panel`，分桶 tab `tray-panel-tab-*`：
  进行中 / 已结束）。
- **协议**：`session.getSubagents { sessionId }` → `session.subagents
  { sessionId, subagents: SubagentRecord[], oversize?, found? }`
  （handler 转发 `sessionService.getSubagents`；数据源 = runtime 每会话内存派生视图，
  pi entry 游标 + record journal 双增量源）。
  同时 `session.subagents` 是 **state topic**：断连/切回由 `session.subscribe` 的
  `stateSnapshot` 直接回放（不依赖广播时序）。
- **副作用点**：无（读）。

### 驱动

```js
const { subagents, found, oversize } =
  await p.call('session.getSubagents', { sessionId: sid }, { replyType: 'session.subagents' })
```

```
click  testid=tray-builtin-button[data-kind=subagent]
expect testid=tray-panel[data-panel-key="native:subagent"] visible
expect testid=tray-subagent-row count=N
expect testid=tray-subagent-slug (行内 slug)
```

### 断言（期望终态 / 失败信号）

- 期望：`subagents[]` 每条含 `{ subagentId, agent, slug, task, status, model?, modelSource?,
  thinkingLevel?, turns?, totalTokens?, elapsedSeconds?, startedAt?, endedAt?, error? }`；
  行数 = record 数；`status='running'` 行有 `tray-subagent-spinner`；已结束行在另一桶。
- **失败信号**：`found=false` 且 UI 仍显示旧列表（期望行为——保留分区）；`oversize=true` 时
  面板应显式降级提示而不是「无子代理」；行数与 `subagents.length` 不符（分桶/折叠 bug）。
- **完成态收敛信号**：记录从 running → idle，`turns/totalTokens` 出现；`endedAt` 有值。

### 证据（A/B/C 各抓什么）

- A：托盘面板截图（两桶）+ 行内 slug/engine icon。
- B：`session.getSubagents` reply 原文（截取关键字段）；`session.subagents` 状态帧。
- C：`ext-sessions/<rootSid>/subagents/records/**` 的 record 文件（状态/终态字段）。

### 证不了

- 列表的「实时性」在极端高频事件下的表现（record 双增量源的时序，需要压测）。

### Gotchas

1. **读路径换过源**（W1）：现在不是「重读主 session JSONL」，而是内存派生视图（pi entry 游标 +
   journal tail）。所以「主 JSONL 里没有 subagent 条目」≠ 列表为空。
2. **`found` 缺省 = true**：广播帧不带该字段；只有 RPC reply 才可能 `false`。断言「空列表」时
   必须区分 `found=false`（读不到会话）与 `subagents=[]`（真没有）。
3. **状态是两态**（`running` / `idle`）：legacy 终态值在解析边界归一（`SubagentStatus` 头注）；
   不要按旧文档断 `completed/failed`。
4. **行定位**：`tray-subagent-row` 每行同 testid，且**没有 `data-subagent-id`**；只能靠行内
   `tray-subagent-slug` 文本过滤（或行 `title` = `agent · slug`）。同 slug 并发会双命中
   → 建议补 `data-subagent-id`（当前锚点缺口）。

---

## subagent.stream · 子代理实时流

- **通道**：A（drawer 详情里的对话流逐字增长）+ B（`subagent.stream_chunk` 增量 + 清除帧 +
  `session.getSubagentStreamState` 拉取 + `session.subagentEntriesAppended` 增量 entry）+ C（子代理 JSONL）
- **前置**：`requires` = faux | mock-http（要有真实子进程产出）；依赖 `subagent.dispatch` `subagent.list`
  `protocol.events` `protocol.subscribe`
- **用于**：`p0-subagent-dispatch`（流式子项）、`p0-subagent-stream`（独立 scenario）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：drawer subagent tab 里能看到子代理正在输出的文字（与主对话流同款渲染，复用
  `MessageStream`）；非 pi 引擎 running 时显示 coarse 提示（`subagent-coarse-hint`：
  「该引擎不支持实时流」），降级时显示 `subagent-stream-degraded`。
- **协议（三条通道，别混）**：
  1. `subagent.stream_chunk { sessionId, recordId, msgSeq, deltaSeq, delta }` — **唯一内容推送通道**，
     transient（不分配 seq、不入 ring、不写快照、断连即丢）。消费端按 `(recordId, msgSeq, deltaSeq)`
     拼合；`deltaSeq` 跳号 = 失步。
  2. `subagent.stream_delta { sessionId, recordId, lines?, msgSeq? }` — 收尾**清除帧**
     （`lines: undefined`）+ 旧 R 路径兼容；B2 起不再用它推内容。
  3. `session.getSubagentStreamState { sessionId, recordId }` →
     `{ found, msgSeq, lastDeltaSeq, lines, degraded? }` — 晚订阅/刷新/失步的恢复拉取。
     `found=false` = 当前无进行中流（未开始或已定稿），**合法回执不是错误**。
  4. `session.subagentEntriesAppended` — 定稿 entry 增量（state 类但**刻意不入** stateSnapshot；
     对账靠 reducer 幂等 + 重开 fetchAndInject）。
- **副作用点**：`SubagentTee`（runtime）镜像子进程 mirror 流；`subagent:<rootSid>:<subagentId>`
  虚拟 session 分区写 chatStore（`packages/shared/src/virtual-session-id.ts` 工厂，INVAR-1.1）。

### 驱动

```
# 打开详情（drawer subagent tab）
click  testid=tray-builtin-button[data-kind=subagent]
click  testid=tray-subagent-row
expect testid=drawer-tab-subagent visible
# 流式中：
expect 详情内 block-text 文本随时间增长（TPS 允许时）
```

```js
// 晚订阅恢复
const st = await p.call('session.getSubagentStreamState', { sessionId: rootSid, recordId },
  { replyType: 'session.getSubagentStreamState' })
```

### 断言（期望终态 / 失败信号）

- 期望：`subagent.stream_chunk` 的 `deltaSeq` 从 0 连续；`msgSeq` 在消息边界递增；
  `getSubagentStreamState.lines` = 当前消息累积全文，`lastDeltaSeq` = 已处理水位；
  定稿后收 `subagent.stream_delta{lines: undefined, msgSeq}` 清除帧 + entry 权威链收敛；
  A 侧 drawer 文本与 `lines` 一致。
- **失败信号（具体形态）**：
  - `deltaSeq` 跳号且 `degraded=true` → live 发布已停（raw mirror seq 空洞），A 侧出现
    `subagent-stream-degraded`；此时应以落盘为准（刷新/重开拉全量）。
  - `found=false` 但 UI 还在等流 → 流已定稿（正常），或 record 不存在（错）。
  - drawer 文本重复/乱序 → 消费端没用 `(msgSeq, deltaSeq)` 去重/拼合。
  - drawer 空白但 record `status='running'` → 流通道断（transient 丢失后必须靠拉取恢复；
    没拉 = 消费端缺陷）。
  - 非 pi 引擎却出现 `subagent-stream-degraded`（应该出 `subagent-coarse-hint`）→ 引擎能力标注错。

### 证据（A/B/C 各抓什么）

- A：drawer 详情截图（流式中 + 定稿后）；`subagent-stream-degraded` / `subagent-coarse-hint` 在场性。
- B：`subagent.stream_chunk` 帧序列（`recordId/msgSeq/deltaSeq/delta` 前 N 字符）；
  `getSubagentStreamState` reply；清除帧。
- C：`ext-sessions/<rootSid>/subagents/sessions/**` 的 JSONL（定稿内容权威）。

### 证不了

- 实时流的「低延迟」体验指标（本技能不做性能基线；采样管道见 `docs/testing/render-sampling.md`）。
- 孙进程是否真的产出了流：faux 通道不可达；**mock-http 通道可验**（成员/子代理模型落 `mockllm/mock-sub-a`
  时 mock 请求记录 + record 产物双向可证），见 `capabilities/env.md` Gotchas 与探针 `scripts/probes/mock-llm-grandchild.mjs`。

### Gotchas

1. **transient = 断连即丢**：刷新/切走后不能指望回放；恢复唯一路径是
   `session.getSubagentStreamState`（+ entry 权威链）。因此「刷新后流没了」不是 bug，
   「刷新后不拉取」才是。
2. **清除帧不是内容帧**：`subagent.stream_delta` 带 `lines: undefined` 是收尾；把 `lines` 为空数组
   当「清空内容」会误删正文。
3. **`found=false` 不是错误**：常态可达（drawer 关闭窗口内流已定稿）。别把 RPC 成功 + found=false
   当缺陷上报。
4. **`session.subagentEntriesAppended` 是 state 类但无快照 key**（例外登记）：断连重连**不会**回放它；
   对账靠 reducer 幂等 + 重开拉取。
5. **虚拟 id 三段式**：`subagent:<rootSid>:<subagentId>`（恰好 2 冒号 3 段）。写错形态会 fail-fast
   （INVAR-1.1）；主会话是 btw 线时要传线 piSessionId，不是 btw vid。

---

## subagent.cancel · 取消子代理

- **通道**：A（托盘行两段式取消钮 + 行消失/停止转圈）+ B（`session.subagentAction` 回执）
  + C（子进程消失 / record 收敛）
- **前置**：`requires` = faux | mock-http（要有 running 记录）；依赖 `subagent.dispatch` `subagent.list`
- **用于**：`p0-subagent-cancel`（主）、`p0-interrupt-cancel`（执行域子项）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：托盘 subagent 面板（**pinned 态**）里 running 行右侧取消钮
  `tray-subagent-cancel`（两段式：首击变 `tray-subagent-cancel-confirm`，二击执行）。
- **协议**：
  - `session.subagentAction { sessionId, action: 'cancel', subagentId }` →
    `session.subagentActionDone { sessionId, action: 'cancel', subagentId }`；
    实现 = runtime `client.prompt("/subagents cancel <id> ...")`（扩展命令，不经 LLM）。
  - agent 侧等价工具：`subagent_manage { action: 'cancel', cancelParam: { subagentId } }`
    （还有 `close` 关闭 idle 记录）。
- **副作用点**：杀子进程/中断回合 → record 收敛；`session.subagents` 状态帧更新；托盘计数变化。

### 驱动

```
click  testid=tray-builtin-button[data-kind=subagent]
hover  testid=tray-subagent-row (running 行)
click  testid=tray-subagent-cancel
click  testid=tray-subagent-cancel-confirm        # 第二击才执行
expect 该行 spinner 消失 / 行进入「已结束」桶
```

```js
await p.call('session.subagentAction',
  { sessionId: rootSid, action: 'cancel', subagentId }, { replyType: 'session.subagentActionDone' })
```

### 断言（期望终态 / 失败信号）

- 期望：reply `{action:'cancel', subagentId}`；`session.subagents` 里该 record 不再 running
  （`status='idle'`，或记录带终态原因）；C：子代理进程消失；托盘计数 -1（running 计数）。
- **失败信号（具体形态）**：
  - 点一次 btn 就断言行消失 → 要求两段确认（首击只进确认态，testid 变 `-confirm`）。
  - reply 成功但 record 仍 running（`subagent.stopReason` 未出现）→ 取消命令没到扩展/进程未死。
  - 子进程还在（`ps` 命中）→ 只改了 record。
  - 行被立刻删掉（而非进「已结束」桶）→ 展示语义错（取消 ≠ 删除记录）。

### 证据（A/B/C 各抓什么）

- A：取消前后托盘截图（含确认态）。
- B：`session.subagentActionDone` reply；`session.subagents` 帧的前后 status。
- C：`ps` 前后（子代理进程）；record 文件终态字段（`stopReason` / `endedAt`）。

### 证不了

- 取消的「及时性」（子进程正在 LLM 请求中时取消的时延；属真实 provider 行为）。

### Gotchas

1. **两段式**：取消钮在确认态 testid 变 `tray-subagent-cancel-confirm`
   （`TrayConfirmButton` 的 `confirming ? \`${testid}-confirm\` : testid`）。
2. **只在 pinned 态渲染**：hover 面板未 pin 时行内按钮不出现（`v-if="pinned && ..."`）。
3. **取消 ≠ 关闭**：`cancel` 停止当前轮但保留记录（可 `subagent_message` 续聊）；`close` 才是关闭
   idle 记录（`subagent_manage action:'close'`）。
4. **btw/子会话的取消入口不同**：`tray-session-stop`（调度模式子会话）与本钮是两套；
   别在 subagent 面板找子会话停止钮。

---

## subagent.model · 子代理模型（派发时选择 + 来源标注）

- **通道**：A（详情头行模型标签 + 来源 badge）+ B（`SubagentRecord.model` / `modelSource`）
  + C（record 事件文件 / 子进程 `--model` argv）
- **前置**：`requires` = faux | mock-http；依赖 `subagent.dispatch` `subagent.list` `model.list`
- **用于**：`p0-model-switch`（执行域子项）、`p0-subagent-dispatch`（模型括注）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：派发时由 agent 指定（用户可在 prompt 里要求「用 X 模型」）；详情头行显示
  模型标签（可点开切，走 `model.subagent-switch`）+ **派发期来源 badge**
  `subagent-model-source-badge`（title 含完整盖章 ref）。
- **协议**：不是 RPC——`model`/`thinkingLevel` 是 `subagent_start` / `workflow_run` 的**工具参数**；
  结果体现在 `SubagentRecord.model`（`'provider/id'`）与 `modelSource`
  （`'explicit' | 'frontmatter' | 'preference' | 'default'`，`packages/shared/src/subagent.ts`）。
  另有 `recentEffectiveModel`：从子代理 JSONL **尾条 `model_change`** 派生（执行事实权威）。
- **副作用点**：record 事件文件（`record-created` 帧带 model/modelSource）→ 详情载荷。
  模型**不是** spawn 后 set，而是 spawn 时 `--model "provider/id[:level]"` 传入
  （`packages/pi-subagent-cli/src/spawn-runner.ts`）。

### 驱动

```
# 观察（派发后）
click  testid=tray-builtin-button[data-kind=subagent] ; click testid=tray-subagent-row
expect testid=subagent-model-trigger 文本含 provider/id
expect testid=subagent-model-source-badge visible      # 存量 record 无字段时不渲染
```

```js
const { subagents } = await p.call('session.getSubagents', { sessionId: rootSid },
  { replyType: 'session.subagents' })
// subagents[0].model / .modelSource / .thinkingLevel
```

### 断言（期望终态 / 失败信号）

- 期望：`model` = 三层解析的结果（显式参数 > frontmatter > 主模型）；`modelSource` 与来源一致
  （显式传 `model` → `explicit`）；`thinkingLevel` 与传入档位一致；C：子进程 argv 里 `--model`
  含该 `provider/id`（可能带 `:level` 后缀）。
- **失败信号（具体形态）**：
  - 显式模型拼错 → 工具 **抛错**（不是回落主模型）；若看到回落 = 解析链违规。
  - `model` 缺失但 `modelSource='explicit'` → 来源标注错。
  - 详情显示模型 A，子进程 argv 是模型 B → 展示与执行分叉（spawn 参数链断了）。
  - `subagent-model-source-badge` 不渲染：存量 record 无 `modelSource`（合法），不是缺陷。

### 证据（A/B/C 各抓什么）

- A：详情头行截图（模型 + 来源 badge + 覆盖 badge 三者区分）。
- B：`session.getSubagents` 里该 record 的 `model/modelSource/thinkingLevel/recentEffectiveModel`。
- C：`ps -o command= -p <子进程>` 的 `--model`；`subagents/sessions/**` JSONL 的 `model_change` 尾条。

### 证不了

- 模型「实际用了哪个」（`--model` 传给 pi 后可能被 pattern 引擎换同族；权威是 JSONL
  `model_change` 尾条 → `recentEffectiveModel`；faux 不会换）。
- 派发时的**用户覆盖**（那是 `model.subagent-switch` 的记账面，不在本 capability）。

### Gotchas

1. **`modelSource` 是「派发时点」快照**：不随后续热切变化（与 `modelOverride` 正交）。
2. **`subagent-model-trigger` 只在有 switchRecord 时渲染**（详情载荷里 record 存在）；
   `agentcall` 快照视图缺 record 时降级为纯 meta 文本。
3. **来源 badge 与覆盖 badge 是两个东西**：`subagent-model-source-badge`（派发来源）vs
   `subagent-override-badge`（用户覆盖面）。断言别混。
4. **`recentEffectiveModel` 读文件**：record 无 session 文件（未落盘）时不带该字段；按无值处理。

---

## subagent.session-observation · 子会话观察入口（托盘第 4 件）

> 与 `subagent.*` 的区分：`subagent.*` 观测的是 **subagent record**（recordId / slug / 引擎成员）；
> 本原语观测的是 **agent-managed session**（`session-manager` 扩展的 8 工具创建的独立会话）。
> 两者都在托盘里以「子会话」聚合展示，但数据源与 RPC 完全不同——**混用会导致断言永远不命中**。

- **通道**：A（`tray-session-panel` / `tray-session-row`）/ B（managed session 状态来源）/ C（`<dataDir>/ext-sessions/<sid>/` 下该托管会话自己的树）
- **前置**：`requires: faux`（需要 agent 主动调 `create_managed_session`）；依赖 `session.create` `subagent.list`
- **用于**：覆盖矩阵 P0 行「subagent/workflow 面板与派发」的**子会话观察**子项

## 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：composer 任务托盘的 built-in 第 4 件「子会话」→ `tray-session-panel` 列出当前会话创建/管理的托管 session（行 `tray-session-row` + 状态点 `tray-session-dot` + 元信息 `tray-session-meta`）；空态 `tray-session-empty`。
- 协议：托管会话的创建/管理走 `session-manager` 扩展的 8 个工具（`create_managed_session` / `send_to_session` / `get_session_history` / `get_session_status` / `list_managed_sessions` / `abort_session` / `watch_session` / `archive_session` / `delete_session`），由 agent 在 turn 内调用；runtime 侧落 `session-manager-handler.ts`（`TARGET_NOT_OWNED_ERROR` = 只允许操作本 agent 创建的会话）。
- 副作用点：每个托管会话在 `<dataDir>/ext-sessions/<托管sid>/` 有**自己的一棵树**；完成通知经 delivery-port 入账。

## 驱动

```bash
# faux 剧本：让 agent 起一个托管会话（工具名必须是 session-manager 的 8 工具之一）
cat > /tmp/managed.json <<'JSON'
[
  { "toolCalls": [{ "name": "create_managed_session", "args": { "cwd": "<repo>", "label": "verify-managed" } }], "stopReason": "toolUse" },
  { "text": "托管会话已创建（MANAGED-CREATED）。", "stopReason": "stop" }
]
JSON
node .agents/skills/verify-taiji/scripts/seed-faux.mjs <repo> ~/.taiji-dev/verify-<runId> /tmp/managed.json

PW="node ~/.agents/skills/browser-automation/scripts/pw.js http://localhost:<cdpPort>"
# 第 4 件 = built-in 按钮的 data-kind="session"（固定序 bash → subagent → workflow → session → canvas）
# [HISTORICAL] 不存在 `tray-panel-tab-session`：session 不参与 TrayNativePanel 的分桶 tab
# （TRAY_BUCKETS 只有 bash/subagent/workflow 三键，session 走独立扁平列表 TraySessionPanel）
$PW click 'css=[data-testid="tray-builtin-button"][data-kind="session"]'
$PW wait "testid=tray-session-panel"
$PW text "testid=tray-session-row"            # 行根，带 data-child-session-id
$PW text "testid=tray-session-meta"           # cwd 末段 · 状态 · 最后活跃
$PW attr "testid=tray-session-row" "data-child-session-id"
```

## 断言（期望终态 / 失败信号）

- 期望终态：托管会话创建后 `tray-session-panel` 出现一行（`tray-session-row`），`tray-session-dot` 反映存活态；行可点进入该会话（切到托管会话的对话流）。
- 失败信号：
  - 托盘「子会话」入口计数恒 0 → 数据源未接通（`useTrayCounts` 的 `TrayBuiltinKind = TrayTaskKind | 'session'` 独立通道断了）；
  - 行在场但点不动 → 切会话链路断；
  - 工具调用返回 `target session not found or not managed by this agent` → 归属校验（这是**正解**，不是 bug：agent 只能操作自己创建的会话）。

## 证据（A/B/C 各抓什么）

- **A（主）**：托盘面板与行的截图 + 行文本（label / 状态）。
- **B**：工具调用回执（`create_managed_session` 的 reply 含新 sessionId）+ 后续 `list_managed_sessions` 结果。
- **C**：新托管会话的 `<dataDir>/ext-sessions/<sid>/` 树存在；`agent/subagents/` 下托管记录。

## 证不了

- 完成通知**跨进程送达**（at-least-once / 幂等去重）：那属投递域（`E2E-DELIVERY-01/02/03`、`E2E-SESSMGR-03`）。
- 托管会话的**模型**独立配置（需 `model.subagent-switch` 与 `session-manager` 的交集，当前无剧本）。

## Gotchas

- **不要把「子会话」和「子代理」混为一谈**：前者 = agent-managed session（独立 pi 进程 + 自己的会话树，有 `session-manager` 8 工具）；后者 = subagent record（引擎成员，`subagent.*`）。托盘的 built-in 第 4 件只显示前者。
- **`delete_session` 仅用户明文提示可调**（设计约束）：faux 剧本里让 agent 自己调 `delete_session` 属违规路径，别写成验收用例。
- **托管会话同样受孙进程 faux 不可达影响吗？** 不受——托管会话是**主会话级的独立 pi 进程**（由 runtime 以主 pi 同款方式 spawn，带完整扩展集），不是 `pi-subagent-cli` 的 `--no-extensions` 孙进程。所以 faux 对托管会话**可用**（前提：`TAIJI_FAUX_SCRIPT` 被继承 + 该 pi 用 faux provider）。
- 归属校验是硬约束：跨会话操作返回 `TARGET_NOT_OWNED_ERROR`，这是正确行为。
