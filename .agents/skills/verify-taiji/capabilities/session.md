# session · 会话域能力原语（create / list / switch / history / delete / archive / restore / isolation / persistence）

> 本文件按 [API-CONTRACT §4](API-CONTRACT.md) 骨架逐 capability 展开：H2 标题即 capability id。
> testid 权威源 = [docs/testing/02-panels-sidebar.md](../../../../dev-0.11.11/docs/testing/02-panels-sidebar.md)
> （侧栏/归档）与 [docs/testing/01-chat-panel-composer.md](../../../../dev-0.11.11/docs/testing/01-chat-panel-composer.md)
> （新建任务/Panel header）；本文件只写「驱动怎么点、断言什么、失败长什么样」，不复制清单。
> 组件实装路径以 `<repo>/packages/renderer/src/components/{sidebar,archive,panel,new-task}/` 为准。

## 通用前置（本域全部 capability 共用）

- 实例就绪三条判据全过（`env.launch` → `env.ready`），扩展装载 N≥8（`env.doctor`）。
- **建会话必须有可用模型**：`SessionLifecycle.createNew` 在 spawn 前检查 `configStore.getDefaultModel()`，
  缺失直接抛 `MODEL_NOT_CONFIGURED`（`packages/runtime/src/services/session/session-lifecycle.ts`
  的 `createNew`）。faux 装配天然带 `faux/faux-1` 默认模型；常规实例依赖模板种子的 provider。
- 会话数据两棵树，别混：
  - `<dataDir>/agent/sessions/<encodeCwd>/<ISO>_<uuid>.jsonl`：pi 宿主会话文件（含 `.preset.json`
    / `.project.json` / `.meta.json` / `.agent.json` / `.handoff.json` / `.model.json` 六类旁挂）。
    推导 SSOT = `packages/shared/src/paths.ts` 的 `getPiSessionsDir`。
  - `<dataDir>/ext-sessions/<sessionId>/`：taiji 自有 session 维度树（`logs/` / `subagents/` /
    `workflow/runs/` / `attachments/` …，ADR-0141）。

---

## session.create · 新建会话

- **通道**：A（Landing 首发提交）+ B（`session.create` RPC → `session.created` 回执 +
  `config.sessions` 广播）+ C（两棵树 / sidecar / pi 进程）
- **前置**：`requires` = faux（推荐）| custom-provider（`requiresModel`）| live；
  依赖 `env.launch` `env.ready` `env.doctor` `protocol.auth` `protocol.rpc` `session.list`
- **用于**：`p0-session-create-first-message`（主）、`p0-chat-stream`、`p0-session-isolation`、
  `p0-model-switch`（`modelOverride` 面）、`p1-session-archive`（造数据前置）、
  `p0-subagent-dispatch`（起点会话）、`p0-workflow-run`（起点会话）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：侧栏「新建」按钮（title = `新建任务 · ⌘N`）或 ⌘N → Landing 态
  （`new-task-landing`，组件 `components/new-task/Landing.vue`）→ 选目录 chip → 输入首条消息 → 发送。
  **点新建不建 session**：`useNewTaskFlow` 只记 `pendingCwd`，首发提交才 create（避免僵尸空会话）。
- **协议**：`session.create`，payload 全字段见下表；reply `session.created { session: SessionSummary }`
  （`packages/shared/src/protocol.ts` `ClientMessageMap['session.create']` /
  `packages/runtime/src/transport/session-message-handler.ts` `handleSessionCreate`）。
- **副作用点**：spawn pi（`ProcessManager.createSession`）→ 读回 pi 真实 sessionId
  （`readBackCreateState`）→ 注册 session → 写 `.preset.json` / `.project.json` sidecar →
  非 hidden 则 `workspaceService.record(cwd)`（最近工作区）→ 插件 `didCreateSession` 定向投递 →
  广播 `config.sessions`。

**参数面（逐个语义 + 验收怎么用）**

| 参数 | 语义（出处） | 验收怎么用 |
|------|-------------|-----------|
| `cwd?: string` | 工作目录；**省略 = runtime 进程 cwd**（`process.cwd()`）；空串或路径不存在时**降级到 homedir**（`resolveCreateCwd`），renderer 侧比对 `reqCwd !== 实际` 触发 toast（`createSessionFlow` INV-7）。 | 传真实 git 仓库路径（如 `<repo>` 本身或 `e2e/fixtures/sample-project`），后续文件树/git 角标才有内容。传不存在路径可验降级 toast。 |
| `label?: string` | 会话名；缺省 = `basename(cwd)`（`session-lifecycle.ts` registerCreateSession）。Landing 传首条消息文本（`firstTextTrimmed`），但 **`persistLabel` 未开 → 不写 pi 会话名**，重启扫描后 label 回落 `basename(cwd)`（或 rename-session 扩展改名后的名字）。 | 断言 reply 的 `session.label`；**不要**拿 label 做跨重启等值断言（见 Gotchas）。要持久名用 `session.rename`。 |
| `hidden?: boolean` | 隐藏会话：不进 sidebar（`scanner.listAll` 过滤 hidden）、不记最近工作区；供内部使用（公共 session / btw 线）。 | B：`config.sessions` 里搜不到该 id；`session.switch` 仍可用该 id（能进对话流）。C：`ext-sessions/<sid>/` 仍生成。 |
| `presetId?: string` | 会话创建时锁定的 pi 启动预设（模式）id；runtime 写 `.preset.json` sidecar，restore 据此重建 pi args。省略 = 默认预设。 | C：断言 `<sessionFile>.preset.json` 的 `presetId`；B：`config.sessions` 广播的 summary 带 `launchPresetId`（扫描期读 sidecar）。**不要**用 payload 里的 `presetId` 断言生效（它只是请求值）。 |
| `projectId?: string` | 归属 project（与 cwd 无关）；空 = 未归类（读取侧兜底默认项目），**空值不写 sidecar**。 | C：`<sessionFile>.project.json`；B：session summary 的 `projectId`；A：侧栏分组归属。 |
| `modelOverride?: string` | Landing 模型 chip 的覆盖值（`'provider/id'`），优先级 `override > preset.modelOverride > 全局默认`（protocol 注释 + `resolveCreateLaunch`）。Landing 路径恒传 **`resolveLaunchConfig` 解析终值**（D5 契约快照化）。 | 断言 reply 的 `session.modelId` = 覆盖值；C：**pi 进程 argv 含 `--model <provider/id>`**（spawn 参数，`packages/pi-rpc/src/spawn-args.ts` `buildPiMainAgentArgs`；`ps -o command= -p <pid>`）。注意 JSONL 的 `model_change` entry **只在后续切换时**才写（初始模型不写）。 |
| `thinkingOverride?: ThinkingLevel` | 思考档位覆盖（`PI_THINKING_LEVELS` 七值全集，`packages/shared/src/pi-preset.ts`）。pi 可能钳制到模型族支持档。 | 断言 reply `session.thinkingLevel`；C：**pi 进程 argv 含 `--thinking <level>`**（同上）；`thinking_level_change` entry 也是后续改动才写（PS-04：值未变不发事件也不写 entry）。注意 faux-1（reasoning:false）只有 `off`，要验多档需 `faux-1-reasoning`。 |
| `clientUuid?: string` | **create 幂等键**（发现 B）：同一次「新建任务」的网络重试复用同一 uuid；runtime 用 in-flight Promise 共用 + 成功短 TTL 记录，重复到达返回已建 session，不重复 spawn/建号。与 `message.send.clientUuid` 是互不相干的键空间。 | 连发两次同 `clientUuid` 的 create：两次 reply 的 `session.id` 必须相同；C：`ext-sessions/` 只多一棵树、`ps` 只有一个新 pi 子进程。发不同 uuid = 两个 session。 |

### 驱动

**A 路径（Landing 首发）**

```
click  testid=new-task-landing            # 断言可见（空 composer 卡片）
click  testid=chip-directory              # 目录 chip（有历史 session 时会被预填最近目录）
expect testid=dir-select-popover visible  # portal 到 body，全局查
click  testid=workspace-item (第 1 项)     # 选中后 chip 文本变目录末段名
fill/type  role=textbox                   # composer contenteditable：必须 pressSequentially
click  title="发送 · ⏎"                    # 文案 SSOT = ui locale panel.composer.send = '发送'
expect testid=new-task-creating visible   # 同帧过渡视图（可选断言）
expect testid=new-task-landing count=0    # create 完成后离开 Landing
```

**B 路径（协议直建，scenario 首选，避免 Landing 目录浮层的历史预填干扰）**

```js
const { session } = await p.call('session.create',
  { cwd: repo, label: 'verify-session-A', modelOverride: 'faux/faux-1' },
  { replyType: 'session.created' })
await p.call('session.switch', { sessionId: session.id }, { replyType: 'session.switched' })
```

### 断言（期望终态 / 失败信号）

- **B 成功**：reply `session.created.session` 含
  `{ id, label, cwd, status, modelId, thinkingLevel?, sessionFile?, launchPresetId?, projectId? }`；
  `config.sessions` 广播的 `groups[].sessions[]` 中出现同 id。
- **B 失败信号**：
  - `error` envelope `code='MODEL_NOT_CONFIGURED'` → 没配 provider/model（create 根本没 spawn）。
  - `code='invalid_payload'`（sessionId/content 类校验）不会出现在 create；create 的 payload
    不做字段校验，异常统一走中央 catch（错误码透传）。
  - **假成功形态**：reply 成功但 `session.cwd` ≠ 请求 cwd → 是 cwd 降级（renderer 侧有 toast，
    协议侧只有 summary 能看出来），不是失败但必须记录为「降级」。
- **A 成功**：`new-task-landing` 消失、panel 态 `composer-box` 在、`panel-session-label` 显示会话名。
- **A 失败信号**：发送后仍停在 Landing（create 抛错 → toast，`new-task-landing` 不消失）；
  `new-task-cancelled`（用户取消）会把已建 session 删掉（`remove` 清理）。
- **C 成功**：`ext-sessions/<sid>/` 树出现；`.preset.json`（若给 presetId）/ `.project.json`
  （若给 projectId）在 `agent/sessions/...` 下；`agent/sessions/<encodeCwd>/<...>.jsonl`
  **可能还不存在**（pi 首次落盘条件 = 有 user 或 assistant 消息）。

### 证据（A/B/C 各抓什么）

- **A**：Landing 态截图 + 发送后对话流截图；`panel-session-label` 文本。
- **B**：`session.created` reply 原文（json 落 `<runDir>/session-create-reply.json`）；
  `config.sessions` 广播帧里的该条 summary；幂等重试两次 reply 的 id 对比。
- **C**：`ls <dataDir>/ext-sessions/` 前后对照；`ls <dataDir>/agent/sessions/**`；
  `cat <sessionFile>.preset.json|.project.json`；`ps` 里该 session 的 pi 子进程（`lsof -p` 或
  `ps -o command= -p <pid>` 含 sessionId 相关参数）。

### 证不了

- 真实 provider 的鉴权/额度（faux 恒 `auth:{}`，零网络）。
- `presetId` 展开后的**工具/扩展面是否真的按模式生效**（要 `extension.list` + 命令清单/工具清单，
  属 settings.preset / extension.load 域）。
- `hidden` 会话的任何 UI 面（没有用户入口，只能协议+磁盘）。
- 模式提示词（replace/append）真实注入 pi（要 `session.fetchCurrentSystemPrompt`）。

### Gotchas

1. **延迟 create 是产品语义**：点「新建」不建会话。断言「create 发生了」只能等首发提交之后，
   不能以「进了 Landing」为证据（`useNewTaskFlow` 的 `pendingCwd` 只在内存）。
2. **create 的 `clientUuid` 去重有 TTL**：成功记录「短保留」后回收（`createIdempotency`）。验证幂等
   要在同一次重试窗口内连发；隔太久第二次会真的再建一个。
3. **label 不持久（landing 路径）**：`persistLabel` 只对 handoff / agent-managed create 打开；
   landing 建的会话重启后 label 回落 `basename(cwd)`（`session-scanner.ts` `label: s.name ?? basename(cwd)`）。
   跨重启等值断言请用 `session.rename` 或改为断言 cwd/消息内容。
   另注意：**非 faux 实例默认开 auto-rename**（`<dataDir>/agent/auto-rename-enabled`），首轮后
   rename-session 扩展可能把 label 改写成生成的标题；faux 装配已删该标志（`lib` 侧行为）。
4. **pi 会话文件延迟写入**（关键规则 #6）：首条 user/assistant 消息之前 `agent/sessions/**.jsonl`
   不存在是**正确行为**；此时断言文件存在 = 假失败。正确时点 = 首个 assistant 回复到达后。
   任何代码都不许在首次 flush 前创建/触碰该文件（EEXIST → 会话永久卡死）。
5. **`cwd` 空串会落到 homedir**：`resolveCreateCwd('')` 走主目录；renderer 用 INV-7 降级 toast
   提示，但协议层看不出来——B 路径建会话必须显式传 cwd。
6. **`modelOverride`/`thinkingOverride` 是「快照终值」不是「chip 当前值」**：Landing 恒传
   `resolveLaunchConfig` 的解析结果（preset/全局默认都已折进去）。要验 chip 覆盖链路，就在
   Landing 上真的切 chip（`model-picker-item-<id>` / 档位行），再首发，断言 reply 的
   `session.modelId` / `thinkingLevel`。
7. **扩展未装载完就 create**：端口在位但扩展没装完时会话缺命令/工具（doctor 的第三条判据就是防这个）。

---

## session.list · 会话列表

- **通道**：B（`config.sessions` RPC reply + 广播）+ A（侧栏列表）+ C（可选：扫描来源）
- **前置**：`requires` = none（不消费 LLM）；依赖 `env.ready` `protocol.rpc`
- **用于**：`p0-session-create-first-message`（断言建后被列出）、`p0-multi-session`（切换/归档前置）、
  `p1-session-archive`（角标与列表对账）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：侧栏 segmented tab 的「会话」（`sidebar-view-tablist` 内的 `role=tab`，文案来自
  `sidebar.segmentedTab.*`）；列表区 `session-list-header`。
- **协议**：`config.sessions`（**不是 `session.list`**，原 `session.list` 已改名，见
  `packages/core/src/transport/api/domains/session.ts` 注释）→ reply/广播
  `{ groups: SessionGroup[]; archiveCount?: number }`。`groups[].cwd` + `sessions: SessionSummary[]`。
- **副作用点**：无写副作用；runtime 侧 `listPersistedSessions()` = 活跃实例 + 磁盘扫描合并
  （`SessionScanner.listAll` 过滤 `hidden`）。

### 驱动

```
click  role=tab name=/^会话/          # 或直接 expect testid=session-list-header visible
expect testid=session-list-header visible
# 行：.session-item（role=button，aria-label = label）
```

协议：

```js
const { groups, archiveCount } = await p.call('config.sessions', {}, { replyType: 'config.sessions' })
```

### 断言（期望终态 / 失败信号）

- 期望：目标 session 出现在 `groups` 中，`cwd` 正确、`status/lastActiveAt/modelId` 合理；
  `archiveCount` 与归档列表条目数一致（归档域广播同源）。
- 失败信号：`session-list-error` 出现（`session.listLoadError` 非空）+ `session-list-retry` 可点；
  协议侧 `config.sessions` reject 或超时（runtime 死）。
- 计数类断言：`archiveCount` 必须等于 `session.archive` 后归档列表 `archive-list-count` 的文本，
  两处不一致 = 角标帧与列表帧分叉（缺陷）。

### 证据（A/B/C 各抓什么）

- A：侧栏截图（含目标行）+ `session-list-header` 文本。
- B：`config.sessions` reply 原文（截取目标 group/session）；广播帧时间戳。
- C：可选——`ls <dataDir>/agent/sessions/` 与列表行数对账（发现「内存有、磁盘无」的漂移）。

### 证不了

- 排序/分组语义是否「用户预期」（当前组序由 project 排序 + runtime 组序决定，属产品口味）。

### Gotchas

1. **列表是广播驱动的**：create/archive/rename/delete 都会广播 `config.sessions`；断言前必须先
   建立 WS 连接并（在协议侧）记录广播帧，否则「等列表变化」会一直等不到。
2. **`archiveCount` 可选**：archiveService 未注入时字段缺省（消费方按 0 隐藏角标）。断言角标前先
   确认归档域可用（`session.archive` 不返回 `archive_unsupported`）。
3. **会话行无 per-session testid**：行根 = `.session-item`（`role=button`，`aria-label` = label，
   「已归档」标记时前缀改变），**没有 `data-session-id`**；同名 label 会双命中
   （建议补 `session-item-<sid>` / `data-session-id`，当前锚点缺口）。

---

## session.switch · 切换活跃会话

- **通道**：B（RPC + 后续 `session.history` / 订阅）+ A（`panel-session-label` / 对话流替换）
- **前置**：`requires` = none；依赖 `session.list` `session.history` `protocol.subscribe`
- **用于**：`p0-multi-session`、`p0-session-isolation`、`p0-chat-reload-equiv`、`p1-session-archive`（恢复后回场）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：点侧栏会话行（`.session-item`，`role=button`，`aria-label` = 会话名；
  点行 → `emit('select', id)` → `useSidebar.selectSession`）。
- **协议**：`session.switch { sessionId }` → reply `session.switched { sessionId, session }`
  （**不带 messages**，2026 perf 瘦身；历史由 `session.history` 单独拉）。
- **副作用点**：12 步切入链（`packages/core/src/domain/session/use-session.ts` `runEntryChain`）：
  清未读 → **先建流订阅** → LRU recency → panel 载入 → 导航 → 历史回填（首切 hydrate / 再切
  `refreshHistory`）→ 文件树预加载 → LRU 驱逐。switch 入口还会 `markSessionViewed`（idle 回收豁免）。

### 驱动

```
click  css=.session-item  hasText=<label>     # 行根，不是 session-detail-card（那是 hover 卡片）
expect testid=panel-session-label text=<label>
```

协议：

```js
await p.call('session.switch', { sessionId: sid }, { replyType: 'session.switched' })
```

### 断言（期望终态 / 失败信号）

- 期望：reply 的 `session.id === sid`；随后 `session.history` 请求发出（首切或再切刷新）；
  A 侧 `panel-session-label` 变为该会话名、对话流换成该会话内容。
- 失败信号：
  - `error` `code='not_found'` / `code='file_not_found'`（磁盘 JSONL 丢失）；
  - A 侧仍显示旧 label、或对话流空但列表有该行（历史 RPC 失败 → `retry-history` 出现）。
  - **切了但内容不对**：切回后看到别的会话消息 = 路由/分区串台（严重缺陷，见 `session.isolation`）。

### 证据（A/B/C 各抓什么）

- A：切换前后各一张截图 + `panel-session-label` 文本。
- B：`session.switched` reply；紧随其后的 `session.history` 请求/回执（证明「主动拉」发生）。
- C：该 session 的 pi 进程是否被拉活（回收态切换会 ensureActive → 新 pi 进程）。

### 证不了

- 「切换 12 步链内部顺序」本身（只能通过症状间接证明；顺序不变量由单测锁）。

### Gotchas

1. **`session-detail-card` 不是会话行**：它是 hover 详情卡（`SessionItem.vue` 里 Teleport 到 body 的
   232px 浮层，含 cwd/分支/消息数）。点它不会切会话。会话行根 = `.session-item`
   （`e2e/session-archive.spec.ts` 的 `sessionRow()` 就是 `.session-item`）。
2. **切 session 后不要假设广播已到**：命令/上下文等会话级状态靠主动拉（`session.getCommands`）
   或 `session.subscribe` 的 `stateSnapshot` 回放；切换瞬间的广播可能早于订阅。
3. **switch reply 不含历史**：断言「历史已到位」必须等 `session.history` 回执或 UI 内容，
   不能以 switch reply 成功为依据。

---

## session.history · 历史读取（含游标翻页）

- **通道**：B（唯一权威）+ A（渲染）
- **前置**：`requires` = none；依赖 `session.switch`（或直接对任意已存在 sid 调用）
- **用于**：`p0-chat-reload-equiv`、`p0-session-persistence`、`p0-session-isolation`（分区内容对账）、
  `p1-chat-revoke`（撤回后 history 不含被撤内容）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：切会话/打开会话时自动发生；历史截断时顶部有「加载更早」
  （`load-more-history`，`packages/ui/src/features/chat/TruncatedHistoryBar.vue`）。
- **协议**：`session.history { sessionId, cursor?, limitTurns?, maxBytes? }` →
  `{ sessionId, session?, messages: Message[], truncated, loadedTurns, totalTurnsEstimate }`
  （`packages/shared/src/protocol.ts` `ServerMessageMap['session.history']`）。
  - 不带 `cursor` = 最近窗口；带 `cursor`（= 当前窗口最早消息的 `piEntryId`）= 翻页取更早的 N turns。
  - cursor 指向的消息已不存在 → 返回空页 + `truncated:false`（到头，不报错）。
- **副作用点**：无（只读）。renderer 侧回填走 `reconcileHistory`（基线替换 + 保留 streaming 尾部）；
  toolResult 图片落盘编排在 `reconcileFromReply`。

### 驱动

```js
const h1 = await p.call('session.history', { sessionId: sid }, { replyType: 'session.history' })
// 翻页
const oldest = h1.messages.find(m => m.piEntryId)?.piEntryId
const h2 = await p.call('session.history', { sessionId: sid, cursor: oldest, limitTurns: 2 },
  { replyType: 'session.history' })
```

### 断言（期望终态 / 失败信号）

- 期望：`messages` 含 user/assistant 全类型（thinking/toolCalls/usage/piEntryId 都在）；
  `loadedTurns` 与窗口内 turn 数一致；`truncated=true` 时 `totalTurnsEstimate` 为下界。
- 失败信号：
  - `messages` 为空但 UI 有内容（说明 UI 读的是 live 分区而非 history，等价性未成立）；
  - `truncated=true` 且翻页返回同一批（cursor 语义失效）；
  - `piEntryId` 全缺 → fork/revoke 的精确目标不可用（只能走 timestamp fallback，风险见 Gotchas）。
- **等价性断言（不是本 capability 单独能证）**：`session.history` 的文本必须与 live 结束后 UI 文本
  逐条一致 → 归 `chat.reload-equiv`。

### 证据（A/B/C 各抓什么）

- A：UI 对话流截图（用于与 history 文本对照）。
- B：`session.history` reply 原文（落 `history-<sid>.json`，只截取文本/id/piEntryId 字段）。
- C：`<dataDir>/agent/sessions/<encodeCwd>/<...>.jsonl` 的 entry 行数/类型分布（`jq -r .type | sort | uniq -c`）。

### 证不了

- 历史里的**图片内容**是否正确落盘（toolResult 图片走 attachments/image-cache，需看磁盘文件）。

### Gotchas

1. **`piEntryId` 可能缺**：RPC 路径读的 session 若无 `piEntryId`，fork 走
   `fromMessageTimestamp + role` fallback，匹配失败会**静默 fork 到最近一条**（protocol 注释 W21 风险）。
   历史断言里看到 `piEntryId` 缺失就要显式记录，不要当等价。
2. **游标是「文件侧身份」**：`piEntryId ?? id`；拿 UI 上第一条消息的 id 去翻页时，若是 live 乐观
   气泡（`u-<uuid>`）会翻不到（不是错误，是身份空间不同）。
3. **窗口按 turn 原子切**：`limitTurns` 不能把 turn 切一半；首 turn 有豁免语义（protocol D4 注释）。
4. **history 不是「全量」**：默认双预算（turn 数 + 字节）；`truncated` 恒需检查。

---

## session.delete · 会话删除（真删）

- **通道**：B（RPC）+ C（磁盘/进程）；A **weak-anchor**（现无单会话删除 UI 入口）
- **前置**：`requires` = none；依赖 `session.list`（对账）
- **用于**：`p0-session-persistence`（删后不复活）、`p1-session-archive`（彻底删除面）、
  `p0-session-cleanup`（场景收尾可选）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV（真相）**：侧栏单会话的「删除」语义**已迁移为归档**（`session-archive` 设计 D6）。
  现役用户可见的「彻底删除」只有两处：
  1. 归档列表行的悬停双钮之一 `archive-row-purge-btn`（两段确认）→ RPC **`session.purgeArchive`**；
  2. 目录行的批量删除 `folder-delete-btn`（两段确认）→ RPC `session.deleteByCwd`。
- **协议**：`session.delete { sessionId }` → `session.deleted { sessionId }`。现役**程序化**消费方 =
  首发失败回滚（`createSessionFlow` 的 `session.remove`）、fork 失败回滚、btw 线直删。
- **副作用点**（`session-lifecycle.ts` `delete`）：立死亡处置 latch → 若是活跃会话则 `detachSession`
  + `pm.destroySession`（**杀 pi**）+ `removeSessionEntry` → 清插件 KV（tombstone）→
  `cascadeDeletedSessionContent`（主 JSONL 进废纸篓；`ext-sessions/<sid>/` 整树进废纸篓；
  pi 宿主树内 6 段旁挂硬删）→ 广播 `config.sessions`。

### 驱动

```js
await p.call('session.delete', { sessionId: sid }, { replyType: 'session.deleted' })
```

```bash
# UI 彻底删除（归档态）
ls ~/.taiji-dev/<dataDir>/agent/archive/**        # 找 .archive.json 对应的 sid
```

### 断言（期望终态 / 失败信号）

- 期望：reply `{ sessionId }`；随后 `config.sessions` 广播里无该 id；C 侧
  `ext-sessions/<sid>/` 从原位消失（mac 进废纸篓）、`agent/sessions/**/<sid 相关文件>` 不在原位；
  活跃会话删除后其 pi 子进程消失。
- 失败信号：
  - reply 成功但树还在原位 = 清理链失败（可能是 trash 失败上抛，被上层吞了——查 runtime 日志）；
  - reply 成功但 `config.sessions` 仍有该行 = 广播缺失；
  - pi 进程仍在（`ps` 命中）= 杀进程步骤失败，后续 session 会 ghost。
- **「删了又回来」= 严重缺陷**：重启后扫描重建该会话（说明只删了内存没删文件，或 sidecar 残留）。

### 证据（A/B/C 各抓什么）

- A：删除前后 `config.sessions` 对应行/侧栏截图（本 capability 的 A 区只能证明「列表消失」）。
- B：`session.deleted` reply + `config.sessions` 广播帧。
- C：`ls -la <dataDir>/ext-sessions/` 前后；`ls <dataDir>/agent/sessions/**` 前后；
  `ps` 前后（pi 子进程）；mac 废纸篓 `~/.Trash` 里是否有该 session 文件。

### 证不了

- 废纸篓的**可恢复性**（mac 软删后能否真的还原，属 OS 行为，不做断言）。

### Gotchas

1. **别把 `session.delete` 当用户入口验**：单会话真删已无 UI 入口；用 `session.archive` +
   `session.purgeArchive` 验用户可见的「彻底删除」。混淆这两个会写出一条永远走不通的剧本。
2. **删除活跃会话会杀 pi**：如果该会话正在流式，删除会中断回合；断言「删除成功」前先确认
   `session.occupancy` 不是 generating（或接受中断）。
3. **`deleteByCwd` 是批量**：`folder-delete-btn` 两段确认后按 cwd 删**所有**会话，包括 hidden
   （`deleteByCwd` 收集面「故意含 hidden」）；在 verify 数据目录里只对自己的目录用。
4. **规则 #7**：删除是本机唯一合法的「整树回收」入口；不要手写 `rm -rf ext-sessions/<sid>`
   去模拟删除（会绕过 tombstone / 插件 KV 守卫）。

---

## session.archive · 归档 / 恢复 / 彻底删除（用户可见的整理链）

- **通道**：A（侧栏两段确认 + 归档列表 + 摘要）+ B（`session.archive` / `session.unarchive` /
  `session.purgeArchive` / `config.archives`）+ C（`agent/archive/**` 簿记与压缩体）
- **前置**：`requires` = none（造数据会话可用 faux）；依赖 `session.create` `session.list` `session.switch`
- **用于**：`p1-session-archive`（主）、`p0-session-persistence`（归档/恢复后数据一致）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：会话行 hover → `session-archive-btn`（**两段确认**：首击进 accent 确认态，
  title 变「再次点击确认归档」，二击才执行）→ 行消失、`sidebar-archive-count-badge` +1 →
  `sidebar-archive-entry-btn` 进 `archive-list-view` → 点 `archive-row-<sessionId>` 看摘要
  （`archive-summary-view`：banner / `archive-archived-pill` / 逐 turn 摘要 / `archive-restore-button`）→
  恢复（`archive-row-restore-btn`）或彻底删除（`archive-row-purge-btn`，两段确认）。
- **协议**：
  - `session.archive { sessionId }` → `session.archive { sessionId }`（同步段 = 搬移 + 簿记骨架；
    压缩后台异步）。
  - `session.unarchive { sessionId }` → `{ sessionId, session: SessionSummary }`。
  - `session.purgeArchive { sessionId }` → `{ sessionId, keptSubagentsDir? }`。
  - `config.archives {}` → `{ archives: ArchiveSummary[] }`（归档列表与角标同源）。
- **副作用点**：`<agentDir>/archive/<encodeCwd>/<原文件名>`（staging 明文）→ 后台压缩产出
  `.zst` 并删明文；`.archive.json` 簿记（`staging|archived`）；`.restoring` 恢复中标记；
  `assets/<sessionId>/{attachments,artifacts,image-cache}/`；六类旁挂明文随迁
  （`SESSION_SIDECAR_EXTS`，`packages/runtime/src/services/archive/archive-paths.ts`）。
  归档 / 恢复 / purge 各自在 service 步骤内广播 `config.sessions`（角标随广播即时）。

### 驱动

```
hover  css=.session-item hasText=<label>
click  testid=session-archive-btn          # 第一次 → 确认态（不要在此断言已归档）
click  testid=session-archive-btn          # 第二次 → 真正归档
expect testid=sidebar-archive-count-badge text=1
expect css=.session-item hasText=<label> count=0
click  testid=sidebar-archive-entry-btn
expect testid=archive-list-view visible
click  testid=archive-row-<sessionId>
expect testid=archive-summary-view visible
expect testid=archive-archived-pill visible
click  testid=archive-restore-button       # 或 archive-row-restore-btn
```

### 断言（期望终态 / 失败信号）

- 期望：角标 +1 且等于 `config.archives.archives.length`；归档行出现；
  C 侧簿记 `status` 从 `staging` → `archived`、`.zst` 存在；恢复后回原 project 分组、行回场
  （`session-item-restored-highlight` 短暂高亮）、`config.archives` 少一条。
- 失败信号：
  - `error` `code ∈ {archive_generating, archive_already_archived, archive_restore_conflict,
    archive_corrupted, archive_not_found, archive_io_error}`（六码闭集，`packages/shared/src/archive.ts`
    `ARCHIVE_ERROR_CODES`）——**这是 fail-fast 域，不是 P2 降级域**（涉及数据搬移）。
  - 点一次就断言行消失 → 永远失败（两段确认）。
  - 归档钮 `disabled`：`generating` 时禁用（title 提示）；先停回合或等流式结束。
  - 归档后仍能 `session.switch` 到该 session 且有完整历史 = 归档没真的搬走（或恢复冲突态）。

### 证据（A/B/C 各抓什么）

- A：行 hover 确认态截图、归档列表截图、摘要视图截图。
- B：`session.archive` / `unarchive` / `purgeArchive` 回执；`config.archives` 前后条目数；
  `config.sessions` 广播的 `archiveCount`。
- C：`ls <dataDir>/agent/archive/<encodeCwd>/`（`.archive.json` / `.zst` / `assets/`）；
  `cat *.archive.json | jq .status`；恢复后原位文件回来 + `ext-sessions/<sid>/` 树回来。

### 证不了

- 摘要的「语义质量」（`ArchiveSummaryTurn.agent` 取该 turn 最后一段非空 assistant 文本，是规则不是智能）。
- 崩溃自愈六类中间态的完整回归（需构造 fixture，走 `archive-fixture.ts`；不属本技能）。

### Gotchas

1. **两段确认**（三处都是）：`session-archive-btn`、`archive-row-purge-btn`、`folder-delete-btn`。
   单次点击只进确认态，`title` 会变（如「再次点击确认归档」）。
2. **归档行靠 sid 寻址**：`archive-row-<sessionId>`；sid 要从 `config.archives` 或 `session.created`
   回执里取，别从 UI 文本猜。
3. **staging 期的「压缩中」是正常态**：`archive-row-compressing` 在场时 `.zst` 可能还没生成；
   断言压缩产物要等 `status==='archived'`。
4. **归档 ≠ 删除**：归档后会话仍在磁盘（`agent/archive/`），`session.switch` 未必还能进（列表已移出），
   但 `session_read` 仍能读摘要（agent 侧）。要验「彻底删除」必须走 `purgeArchive`。
5. **恢复冲突**：恢复时创始人（同名文件）已存在 → `archive_restore_conflict` fail-fast，不会覆盖。

---

## session.restore · 复活死会话（≠ 归档恢复）

- **通道**：B（RPC；reply 复用 `session.created`）+ A（行 dead 标记消失 / 对话流可继续）+ C（新 pi 进程）
- **前置**：`requires` = faux|custom-provider（要能重新 spawn 模型）；依赖 `session.list` `session.switch`
- **用于**：`p0-session-persistence`（重启/崩溃后恢复）、`p0-multi-session`（dead 行重开）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：点击一个已死（dead / 进程被回收）的会话行 → `session.switch` 内部 `ensureActive`
  自动恢复（用户看不到「恢复」按钮）；显式入口 = 崩溃自动恢复失败后的提示条
  （`respawn-pending-bar`，`components/panel/Panel.vue`）里的重试。
- **协议**：`session.restore { sessionId }` → reply **`session.created { session }`**（复用类型，
  `handleSessionRestore`）。失败码：`MODEL_NOT_CONFIGURED` / `SESSION_NOT_FOUND` / `RESTORE_FAILED`
  （`packages/runtime/src/utils/errors.ts`）。
- **副作用点**：`respawn.ensureRestored`（in-flight join，不双跑）→ spawn pi + `switch_session`
  （从 JSONL 续）→ 注册回 Map → 广播 `config.sessions`。
- **与广播的边界**：`session.restored` / `session.restoreFailed` **只**在「pi 非主动退出的自动恢复链」
  产生（5s 延迟 + 连续 2 次失败熔断）；手动 `session.restore` 或 switch 触发的惰性恢复**不推**这两个帧。

### 驱动

```js
await p.call('session.restore', { sessionId: sid }, { replyType: 'session.created' })
```

### 断言（期望终态 / 失败信号）

- 期望：reply `session.created.session.id === sid`；C 侧新 pi 子进程在位；A 侧该行不再呈 dead 态
  （`opacity-50` 消失）、对话流可继续发消息。
- 失败信号：
  - `SESSION_NOT_FOUND`（scan 不到）/ `file_not_found`（JSONL 丢了）/ `RESTORE_FAILED`；
  - **假恢复**：reply 成功但发消息报 `SESSION_NOT_ACTIVE` / 无 `message_start` → 注册表与进程不一致；
  - 恢复后历史缺失（switch_session 未指向原 JSONL）。

### 证据（A/B/C 各抓什么）

- A：dead 行 → 恢复后行的视觉态（前后截图）+ 发一条消息能进流。
- B：`session.created` reply（注意 replyType 不是 `session.restored`）；
  若断言自动恢复链则等 `session.restored { attempts }`。
- C：`ps` 里新 pi 进程；`<dataDir>/agent/sessions/.../<原文件>.jsonl` 的 mtime/行数未变（续写而非新建）。

### 证不了

- 「自动恢复链」（5s 延迟 + 熔断）本身：需要 **kill -9 pi 子进程**制造非主动退出，成本高且会污染
  该会话在途回合；本技能默认不做（除非 scenario 显式声明）。

### Gotchas

1. **`session.restore` ≠ `session.unarchive`**：前者是「重启死进程」，后者是「归档解压回原位」。
   API 命名相近，断言目标完全不同（前者看 pi 进程，后者看 archive 目录）。
2. **replyType 是 `session.created`**：拿 `session.restored` 当 reply 会超时（那个是广播，不是回执）。
3. **惰性恢复不推广播**：switch 触发恢复时不要等 `session.restored`，等 `session.switched` 即可。
4. **规则 #6 同族风险**：恢复路径不得在 pi 首次 flush 前创建 session 文件；测试里也不要预建同名文件。

---

## session.isolation · per-session 隔离（并发不串）

- **通道**：A（两个会话对话流互不污染）+ B（每帧 `sessionId` + 各自 `session.occupancy`
  + 各自 `session.history`）+ C（两棵 `ext-sessions/<sid>/` 树、两份 `logs/pi-*.jsonl`）
- **前置**：`requires` = faux（两轮回复即可，不需要真实模型）；依赖 `session.create` `chat.send`
  `chat.stream` `protocol.events` `protocol.subscribe`
- **用于**：`p0-session-isolation`（主）、`p0-chat-stream`（并发变体）、`p0-multi-session`

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：侧栏两个会话来回切；一个在后台流式、另一个在前台；切回来内容仍在且完整。
- **协议**：所有 `message.*` / `session.occupancy` / `session.delivery` 帧必带 `sessionId`；
  缺 `sessionId` 的帧前端应忽略（架构约定 #7）。订阅是**会话级长订阅**，切走不退订
  （只有 LRU 驱逐才 `session.unsubscribe`，`useChat.ts` 的 evict 复合入口）。
- **副作用点**：`chatStore` 以 `Map<sessionId, Message[]>` 分区（ADR-0049 Map 分区范式）；
  WS handler 必须用 `updateFor(capturedSid)`（结构性消除切换竞态）。

### 驱动（双 session 剧本，可执行）

```js
// 0) 两个会话（faux 实例；model-keyed 脚本按各进程 spawn 时的 --model 选队 → 两边回复可不同）
//    脚本：{ "faux/faux-1": [{text:"A-REPLY-ONLY"}], "faux/faux-1-b": [{text:"B-REPLY-ONLY"}] }
const a = (await p.call('session.create',
  { cwd: repo, label: 'ISO-A', modelOverride: 'faux/faux-1' }, { replyType: 'session.created' })).session
const b = (await p.call('session.create',
  { cwd: repo, label: 'ISO-B', modelOverride: 'faux/faux-1-b' }, { replyType: 'session.created' })).session
await p.subscribe(a.id); await p.subscribe(b.id)     // B 通道事件按 sid 过滤

// 1) A 发一条长回复（TAIJI_FAUX_TPS 调低拉长窗口），B 保持 idle
//    UI 侧：确保当前 panel 在 A（panel-session-label = ISO-A）
//    发送：type role=textbox + Enter（或协议 p.send(a.id, 'A-ONLY-TEXT')）

// 2) A 流式中切到 B（点 .session-item[ISO-B]），断言：
//    - A 的流式内容不在 B 的 DOM 里（B 的回复是 B-REPLY-ONLY）
//    - B 的 session.occupancy.turn === 'idle'（A 的帧 sessionId 全是 A）
//    - A 的 message.complete 仍到达（后台会话帧不丢）

// 3) 切回 A：断言 A 的完整文本在 DOM，且 B 的分区里没有 A 的文本
```

### 断言（期望终态 / 失败信号）

- 期望：
  - 所有收到的帧 `payload.sessionId` ⊆ {a.id, b.id}，且**没有**缺 sessionId 的 session 级帧；
  - `session.history(a.id)` 只含 A 的 user 文本，`session.history(b.id)` 只含 B 的；
  - A 流式期间 B 的 occupancy 保持 idle；切回后 A 内容完整（不重复、不截断）；
  - C：`ext-sessions/a/` 与 `ext-sessions/b/` 各自只有自己的 `logs/pi-*.jsonl` 与 `subagents/`。
- **失败信号（具体形态）**：
  - B 的对话流里出现 A 的文本（哪怕一瞬）→ 分区/路由串台；
  - `message.text_delta` 落在错误 sid 的分区 → `update` 而非 `updateFor(capturedSid)`（ADR-0049 违规）；
  - 切回 A 后内容重复（乐观气泡 + history 基线双计）或丢失（reconcile 基线替换吃掉 streaming 尾）；
  - A 的 `message.complete` 未到（切走导致退订）→ 后台会话永久 streaming。

### 证据（A/B/C 各抓什么）

- A：A 流式中 / B 前台 / 切回 A 三张截图；两会话 DOM 文本各一份。
- B：按 sid 分组的帧计数（`{sid, type}` 直方图，落 `frames-by-session.json`）；两会话
  `session.history` 文本对照。
- C：`ls <dataDir>/ext-sessions/` 下两棵树；各自 `logs/pi-<date>.jsonl` 是否只含自己的 turn。

### 证不了

- 「三层过滤」（ChatStore 分区 / useChat 路由 / PaneSessionView 过滤）内部各自是否生效——
  只能通过症状证明整体不串；单层失效但被其它层兜住的情况测不出。
- 多窗口/多连接并发（需要两个 CDP/两个 WS 客户端；本技能默认单连接）。

### Gotchas

1. **两个会话的回复默认可能相同**：faux 脚本是**每 pi 进程各自一份队列**（spawn 时从同一文件重载队首）。
   要让两边回复不同，用 **model-keyed 脚本** + `session.create.modelOverride` 指定不同模型
   （`{ "faux/faux-1": [...], "faux/faux-1-b": [...] }`；主 pi 的 spawn argv 带 `--model`，
   见 `packages/pi-rpc/src/spawn-args.ts` `buildPiMainAgentArgs`）。注意 key 绑定的是 **spawn 时**的模型：
   会话中途 `model.switch` 不会重载队列。
2. **切走不退订**：后台会话的帧仍会到达并写入它自己的分区。想观察「后台流式」，就在切走后继续
   监听 `message.*`（按 sid 过滤），而不是切回来才看。
3. **切换瞬间的广播可能早于订阅**：切到 B 后要主动拉 `session.getCommands` / 等 `session.subscribe`
   的 `stateSnapshot`，不要把「切完立即有的状态」当广播必达。
4. **同名 label 双匹配**：两个会话若 label 相同（如都用了默认 basename），`.session-item` 的
   `hasText` 会双命中；务必用不同 label（`ISO-A` / `ISO-B`）。

---

## session.persistence · 会话持久化与恢复（落盘事实）

- **通道**：C（主：JSONL / sidecar / `ext-sessions/` 树）+ B（`session.history` / `config.sessions`
  重启后仍在）+ A（重启后打开会话内容可见）
- **前置**：`requires` = faux（一发一收即可）；依赖 `session.create` `chat.send` `chat.wait`
  `session.list` `session.restore` `chat.reload-equiv`
- **用于**：`p0-session-persistence`（主）、`p0-chat-reload-equiv`、

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：关掉应用重开（或点另一个会话再回来），历史还在、能继续聊。
- **协议**：无专用写 RPC。落盘由 **pi 自己**完成（写入方唯一 = pi，`session-model-control.ts` 注释
  「持久层唯一写方 = pi（model_change entry 落 JSONL）」）。runtime 只写 sidecar 与 `ext-sessions/` 树。
- **副作用点（落盘清单）**：
  - `<dataDir>/agent/sessions/<encodeCwd>/<ISO>_<uuid>.jsonl`：pi 会话本体（message / toolResult /
    thinking / model_change / thinking_level_change / session_info / compaction 等 entry）。
    **延迟写入**：首条 user 或 assistant 消息后才建文件。
  - 同目录六类旁挂：`.preset.json` / `.project.json` / `.meta.json` / `.agent.json` /
    `.handoff.json` / `.model.json`（`SESSION_SIDECAR_EXTS`）。
  - `<dataDir>/ext-sessions/<sid>/`：`logs/pi-<date>.jsonl`（pi stdout tee）、`subagents/`、
    `workflow/runs/`、`attachments/`、`artifacts/`、`image-cache/`、`background-tasks/`、
    `plugin-data.json`、`session-view.md`、`btw/`、`canvases/`。

### 驱动

```bash
# 发完一轮后：
ls -la <dataDir>/ext-sessions/<sid>/
ls -la <dataDir>/agent/sessions/**/          # 找 <ISO>_<uuid>.jsonl 及其旁挂
jq -r .type <sessionFile> | sort | uniq -c   # entry 类型分布
# 重启形态：kill <dev-instance pid> 后用同一 --data-dir 重启
```

### 断言（期望终态 / 失败信号）

- 期望：
  - 首 assistant 后 JSONL 存在，entry 类型覆盖该轮实际发生的事（至少 `message`；工具轮有
    `toolResult`；切过模型有 `model_change`；改过档位有 `thinking_level_change`）；
  - `ext-sessions/<sid>/logs/pi-<date>.jsonl` 存在且含该轮记录；
  - 重启（或切走再回）后 `config.sessions` 仍列出该会话、`session.history` 内容与重启前一致。
- 失败信号：
  - **首 assistant 前文件不存在**是正常的（不要判 fail）；首 assistant 后仍不存在 = 落盘失败。
  - 重启后列表缺该会话（sidecar/JSONL 不在扫描域，或 `session_end` 把它标成异常态）。
  - `ext-sessions/<sid>/` 缺 `logs/`（pi stdout tee 链断）→ 卡死时无证据。
  - `session.restore` 后历史为空（只恢复了壳，没续原 JSONL）。

### 证据（A/B/C 各抓什么）

- A：重启前后同一会话的对话流截图（用于与 B/C 对照）。
- B：重启后 `config.sessions` 的该条 summary（`sessionFile` / `lastActiveAt` / `modelId`）+
  `session.history` 文本。
- C：上面的 `ls` / `jq` 输出；`stat -f %m` 对比文件 mtime（续写 vs 重建）。

### 证不了

- 「崩溃时刻在途 turn 是否被保留」——pi 只落已完成 entry；在途回合丢失是设计（恢复提示条会说明）。
- `~/.taiji`（prod 树）行为：本技能只用 `~/.taiji-dev/` 树内数据目录（红线 3）。

### Gotchas

1. **pi 延迟写入（最关键）**：`create` 后立刻断言 JSONL 存在 = 假失败。正确时点 = 首个 assistant
   到达后。反向红线：任何代码不得在首次 flush 前创建/触碰 session 文件（EEXIST → 永久卡死）。
2. **label 不持久（landing 建会话）**：见 `session.create` Gotcha 3；跨重启断言用 cwd / 消息内容 /
   `session.rename` 后的名字。
3. **sidecar 写入有「JSONL 必须存在」守卫**：除 create 路径（`skipJsonlExistsGuard`）外，
   文件不存在时 sidecar 静默跳过（规则 #6）。所以「preset 绑定丢了」常常是因为写 sidecar 时
   JSONL 还没落盘——不是 preset 功能坏了。
4. **`ext-sessions/` 是 taiji 自有树，不是 pi 的**：删它不会删 pi 会话；反之删 JSONL 也不会清树。
   持久化断言要两棵树都看。
5. **不要从测试/脚本里预建 session 文件或 sidecar**（规则 #6 同族）：会让会话进入不可恢复态。

---

## 附：会话域与「归档/删除/恢复」三个词的一页对照（防混淆）

| 用户动作 | 用户入口 | RPC | 目标 |
|---|---|---|---|
| 收起会话（可恢复） | 行 hover `session-archive-btn` 两段确认 | `session.archive` | 搬到 `agent/archive/` + 压缩 |
| 从归档拿回来 | 归档列表行 `archive-row-restore-btn` / 摘要 `archive-restore-button` | `session.unarchive` | 解压回原路径原分组 |
| 彻底删除（用户可见） | 归档列表行 `archive-row-purge-btn` 两段确认 | `session.purgeArchive` | 删归档体 + 级联清理 |
| 批量删目录 | 目录行 `folder-delete-btn` 两段确认 | `session.deleteByCwd` | 按 cwd 批量真删 |
| 真删单个会话 | **无 UI 入口** | `session.delete` | 程序化清理（首发失败回滚等） |
| 复活死进程 | 点 dead 行（自动）/ `respawn-pending-bar` 重试 | `session.restore` | spawn pi + 续原 JSONL（**不是归档恢复**） |
