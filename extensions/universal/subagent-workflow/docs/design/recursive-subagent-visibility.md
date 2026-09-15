# 递归 Subagent 跨层可见性设计

> **当前层 → 下一层**：技术方案（接口/数据模型/env 契约）→ 实现任务（代码改动 + 真实场景验收）
>
> **层性质**：涉及运行时数据流（跨进程身份贯穿）+ 持久化字段，准则 5/6/7 全适用。

## 1. 背景目标

**结论**：`/subagents` 当前只能看到第 1 层 subagent（主进程直接 spawn 的），B/C 等更深层级（subagent 内部再 spawn 的 subagent）完全不可见。本设计让主进程视角能看到完整递归树。

**SCQA**：

- **Situation**：subagent 在独立 pi 子进程运行，每个 subagent 的身份（record id、嵌套深度、所属根 session）写入各自 session.jsonl 的 `subagent-identity` custom entry。`/subagents` 命令从磁盘重建这些 record 并展示，展示层（depth 标签、parent/children）已实现。
- **Complication**：身份字段在跨进程时丢失——子进程不知道"自己的根 session 是谁、自己的父 record 是谁、自己的深度是多少"。导致深层 record 被 `rootSessionId` 过滤掉、且即使保留也因 `parentRecordId` 为空无法建树。
- **Question**：如何让身份信息正确跨进程传递，使主进程 `/subagents` 看到完整递归树？
- **Answer**：仿照已验证的 `PI_SUBAGENT_FORK_DEPTH` 环境变量机制，补传 3 个身份字段（根 session id、自身 record id、嵌套深度）+ 1 个树根 cwd（[MF-3] worktree 落盘目录统一用），子进程启动时建立执行上下文基线与统一落盘目录。

### 系统认知（受众假设：会用 subagent 但不懂内部机制的开发者）

- **subagent = 独立 pi 子进程**：主 agent 通过 `subagent` 工具派发任务时，扩展 spawn 一个全新 pi 进程跑该任务。这个子进程加载同一套 extension，**拥有自己独立的 `SubagentService` 实例**。
- **递归嵌套**：subagent A 在执行任务时，同样可以调用 `subagent` 工具 spawn subagent B，B 又可 spawn C。pi 允许嵌套（受深度护栏限制，默认上限见 `nestingDepth` 检查）。
- **session.jsonl 是唯一持久化源**：每个 subagent 的 session 文件写到同一个 `sessionsDir`（按 cwd 分目录）。record 终态后从内存淘汰，`/subagents` 读时从 jsonl 重建。
  - **[MF-3] worktree 模式下也按 ROOT cwd 分目录**：子进程 spawn cwd = checkout 路径，若按各自 cwd 编码目录，深层 record 落到 `enc(checkout)` 段、ROOT 扫描不到 → 全树可见性深度 ≥ 2 断裂。第 4 个贯穿 env `PI_SUBAGENT_ROOT_CWD`（真 ROOT 的 mainCwd）让所有层级的 sessions 与 records 两套目录统一编码在 `enc(ROOT cwd)` 段。
- **`subagent-identity` custom entry**：subagent 退出后，父进程向其 session.jsonl 追写一条 identity entry（`session-runner.ts:955-983`），携带 `{id, agent, mode, task, rootSessionId, parentRecordId, depth, ...}`。重建器（`session-reconstructor.ts`）靠它恢复身份。

### 设计目标

1. **主进程 `/subagents` 看到完整递归树**：无论嵌套多深（A→B→C→…），所有 record 都出现在列表里，depth 标签、parent、children 关系正确。
2. **身份字段持久化正确**：重建出的 record 的 `rootSessionId` 全指向真根 session，`parentRecordId` 指向直接父，`depth` 正确递增。
3. **重开 session 仍可见全树**：主 session 结束后 `/resume` 重开，全树仍可重建（持久化链路完整）。
4. **fork 分支可见**：fork 出的 session 分支内 spawn 的 subagent，在主进程 `/subagents` 可见（消除 fork 可见性割裂）。

### Scope

- **In scope**：
  - 跨进程身份贯穿（`rootSessionId` / `parentRecordId` / `depth` 三个字段）；主进程视角全树可见
  - **fork 分支可见性顺带改善**：fork 出的 session 分支内 spawn 的 subagent，归到顶层 ROOT、主进程可见（现状下归 fork session 自身、主进程不可见——可见性割裂）。env 无条件注入每个 subagent，fork subagent 同样收到 `PI_SUBAGENT_ROOT_SESSION_ID`，自然归 ROOT
- **Out of scope**（用户明确确认）：
  - subagent 子进程**内部**的 `/subagents` 视图（subagent 不交互，无需自查子树）
  - 旧 session 文件兼容（只保证新 session 生效，不做迁移）
  - `list-view` 树形缩进展示（当前 depth 标签 `[L2]`/`[L3]` + 详情面板 parent/children 已足够，非本设计阻塞项）

## 2. 现状与问题分析

### 使用者视角的现状

主 agent 派发一个会递归 spawn 的 subagent 任务（例如让 worker A 完成任务时再分工给 worker B、B 再分给 C）。执行完成后，用户在主 session 输入 `/subagents` 想查看这次递归调用了哪些 subagent、各自状态如何。

**实际看到**：只有 A 一条 record。B、C 不在列表里。

### 失败模式 + 根因

身份字段有两个跨进程断点。以下用拓扑 `主进程(ROOT) → spawn A → A 内 spawn B → B 内 spawn C` 说明。

#### 断点 1：`rootSessionId` 不跨进程保持为 ROOT（过滤层）

`record-store.ts` 的 `collectRecords` 按 `rootSessionId === ROOT` 过滤（`ROOT` = 主进程 `this.sessionId`）。而 `rootSessionId` 赋值在 `subagent-service.ts:653` 的 `createRecordForMode`：

```ts
rootSessionId: this.sessionId ?? undefined,  // 当前进程的 pi session id
```

`this.sessionId` 是**当前进程**的 session id（`initSession` 时从 `ctx.sessionManager.getSessionId()` 注入）。每个子进程是新 pi session，id 不同：

| record | 创建它的进程 | 该进程 `this.sessionId` | record.rootSessionId | 主进程过滤(`===ROOT`) |
|---|---|---|---|---|
| A | 主进程 | ROOT | ROOT | ✓ 保留 |
| B | A 子进程 | A_sess | A_sess | ✗ **被过滤** |
| C | B 子进程 | B_sess | B_sess | ✗ **被过滤** |

B/C 的 session.jsonl 文件确实在同一个 sessionsDir 里、重建器也能读到，但过滤步骤把它们丢了。

#### 断点 2：`parentRecordId` / `depth` 跨进程丢失（数据层）

`execCtxAls`（AsyncLocalStorage，携带 `{recordId, depth}`）用于在同进程内传递执行上下文。`createRecordForMode`（`subagent-service.ts:641-644`）读它建立父子链：

```ts
const parentCtx = this.execCtxAls.getStore();
const parentRecordId = parentCtx?.recordId;
const depth = parentCtx ? parentCtx.depth + 1 : 0;
```

**AsyncLocalStorage 不跨进程**。子进程启动时 `execCtxAls` 是空的。`initSession`（`subagent-service.ts:279-289`）只从 env 初始化 `forkDepthAls`，**不初始化 `execCtxAls`**：

```ts
const envDepth = process.env.PI_SUBAGENT_FORK_DEPTH;
if (envDepth !== undefined && envDepth !== "") {
  this.forkDepthAls.enterWith(base);  // 只有 forkDepthAls，没有 execCtxAls
}
```

结果：A 子进程的 `execCtxAls` 为空 → A 内创建 B 时 `B.parentRecordId=undefined`（应为 A.id）、`B.depth=0`（应为 1）。

#### 跨进程目前只传了一个字段

`session-runner.ts:659-661` 的 spawn env 块：

```ts
const childEnv: Record<string, string | undefined> = { ...process.env };
if (opts.fork && opts.parentForkDepth !== undefined) {
  childEnv.PI_SUBAGENT_FORK_DEPTH = String(opts.parentForkDepth + 1);  // 仅此一个，且仅 fork 时
}
```

`rootSessionId` / `parentRecordId` / `depth` **没有任何跨进程传递机制**。

#### 物理数据流（当前：断的）

```
主进程(ROOT)
  │ createRecordForMode: A.rootSessionId=ROOT, A.parent=∅, A.depth=0  ✓
  │ execCtxAls.run({A.id, 0})  ← 只在主进程内有效
  │ spawn A → env 只传 [PI_SUBAGENT_FORK_DEPTH]（非 fork 时连这个都没有）
  ▼
A 子进程(A_sess)
  │ initSession: this.sessionId=A_sess; execCtxAls=∅（无 env 初始化）
  │ createRecordForMode: B.rootSessionId=A_sess ✗, B.parent=∅ ✗, B.depth=0 ✗
  │ spawn B → env 同样缺失身份
  ▼
B 子进程(B_sess) → C 同样错位 …
```

主进程 `collectRecords(filter=ROOT)` 扫描 sessionsDir：
- A 的 jsonl → rootSessionId=ROOT → 保留
- B/C 的 jsonl → rootSessionId=A_sess/B_sess → **过滤丢弃**

**结论：主进程只看到第 1 层。**

### 展示层其实已经 ready

`list-component.ts` 已实现完整树形渲染所需的数据消费：

- 行 421：`depthTag = r.depth > 0 ? [L${r.depth+1}]`（顶层不标，深层标 `[L2]`/`[L3]`）
- 行 459-461：详情显示 `parent: <id 或 (root)>`
- 行 549-555：方案 B children 查询——`collectRecords().filter(r => r.parentRecordId === record.id)`

**展示层零改动，纯缺数据。** 修复聚焦数据层 + 过滤层。

## 3. 解决方案

### 3.1 终态（使用者视角）

主 session 中：

```
> /subagents
┌─ Records ──────────────────────┐
│ ● worker  background  [L1]     │  ← A（顶层，running）
│ ● worker  background  [L2]     │  ← B（A 的子）
│ ● worker  background  [L3]     │  ← C（B 的子）
└────────────────────────────────┘
# 选中 B 查看详情：
  parent: sa-1a2b3c              ← 指向 A
  children: sa-4d5e6f            ← 列出 C
  depth: 1
```

所有层级的 record 都可见，parent/children 链完整可追溯，depth 标签正确区分层级。

**恢复指引（失败路径）**：

- **record 详情 `parent: (root)` 但预期有父**：identity entry 缺 `parentRecordId`。查 `TAIJI_AGENT_DEBUG=1` 的 `[subagents] execCtxAls initialized: recordId=X` 日志，确认 `PI_SUBAGENT_SELF_RECORD_ID` env 是否贯穿到该子进程。
- **B/C 等 record 根本不出现**（更常见失败）：identity entry 的 `rootSessionId` 不等于主 session id、被过滤丢弃。排查链：`cat <session>.jsonl | grep subagent-identity` 看 `rootSessionId` 值 → 若不等于主 session id，查 `[subagents] execCtxAls initialized: rootSessionId=Z` 日志确认 env 是否贯穿 → 指向注入点（`runSpawn` 的 childEnv）或读取点（`initSession`）。
- **[MF-3] 全树可见但 worktree 分支的深层 record 缺失**：identity entry 的 `rootSessionId` 正确仍找不到时，查 session 文件落盘位置——`subagent-identity` 所在文件是否在 `subagents/<enc(ROOT cwd)>/sessions/` 下。若在 `enc(<checkout 路径>)` 段（旧版 worktree 布局），是落盘目录未统一（`PI_SUBAGENT_ROOT_CWD` 未贯穿）；恢复指引：确认 `runSpawn` 注入点与 `subagent-service` 构造读取点均使用 `ENV_ROOT_CWD`（旧文件本身不可迁移，会被 GC 按 TTL 清理）。

### 3.2 多方案对比

#### 方案 A：env 变量贯穿（推荐）

仿照已验证的 `PI_SUBAGENT_FORK_DEPTH`，spawn 时注入 4 个 env，子进程 `initSession` 读取建立基线（[MF-3] 第 4 个 `PI_SUBAGENT_ROOT_CWD` 供落盘目录统一编码）。

| 维度 | 评价 |
|---|---|
| 长期架构合理性 | **高**。与现有 forkDepth 机制完全同构（同一通道、同一 initSession 读取模式、同一 enterWith 贯穿生命周期），一致性最高。env 是父→子单向传启动参数的 Unix 标准方式，不污染 pi 核心 argv 语义。 |
| 短期实现成本 | **低**。4 处改动：env 常量定义、`initSession` 读 env、`createRecordForMode` 改 `rootSessionId` 来源、`runSpawn` 注入 env。展示层零改动。 |
| 风险 | **低**。机制已被 forkDepth 验证（跨进程工作正常）。env 是进程级单值，`enterWith` 贯穿整个 session，无并发问题（每进程一个基线）。 |

#### 方案 B：子进程反向解析父 session 文件

不传 env，子进程通过 `mainSessionFile`（argv 已传）读父 session，反推身份链。

| 维度 | 评价 |
|---|---|
| 长期架构合理性 | **差**。反向解析脆弱——依赖父 session 文件存在且格式稳定，并发写入/文件延迟（pi 首次 flush 前 session 文件可能不存在，见 taiji 关键规则 #6）会导致解析失败。且 `mainSessionFile` 是 fork 源语义，非 subagent 父子语义，混用会污染。 |
| 短期实现成本 | **高**。需解析父链、处理文件缺失、容错降级。 |
| 风险 | **高**。文件时序竞态、格式漂移都会导致身份丢失。 |

**若用方案 B**，§2 的 A→B→C 拓扑在 B 创建时若 A 的 session 文件尚未 flush，B 的 parentRecordId 仍为空——回到现状。

#### 方案 C：pi CLI argv flag（`--subagent-parent-record-id` 等）

用 argv 而非 env 传身份。

| 维度 | 评价 |
|---|---|
| 长期架构合理性 | **中**。argv 是 pi 核心的扩展点，但 subagent 身份是扩展内部概念，塞进 argv 要求 pi 核心识别这些 flag（pi 不认识 `PI_SUBAGENT_*` 语义），耦合扩展与核心。 |
| 短期实现成本 | **中**。需 pi 核心配合解析，或扩展自己扫 argv。 |
| 风险 | **中**。argv 与 pi 核心 argv 处理耦合，pi 升级可能冲突。 |

**推荐方案 A**。理由：与现有 `PI_SUBAGENT_FORK_DEPTH` 同构、已被验证、改动最小、不耦合 pi 核心。方案 B/C 在可靠性和架构清晰度上均劣于 A。

### 3.3 关键决策与权衡

#### 决策 1：env 描述"子进程自己的身份"，而非"父的身份"

env 是父进程写给即将启动的子进程的，描述**子进程（这个 subagent）自己**：

| env | 语义 | 写入值（父进程） |
|---|---|---|
| `PI_SUBAGENT_ROOT_SESSION_ID` | 子进程的根 session id | `ctx.sessionRootId`（贯穿，子进程不覆盖） |
| `PI_SUBAGENT_SELF_RECORD_ID` | 子进程自己的 record id | `record.id`（父刚 `createRecordForMode` 创建的） |
| `PI_SUBAGENT_DEPTH` | 子进程的嵌套深度 | `record.depth` |
| `PI_SUBAGENT_ROOT_CWD` | **[MF-3]** 子进程所属树根的 cwd（sessions/records 落盘目录编码键） | `ctx.rootCwd`（worktree 模式下子进程的 mainCwd=checkout 路径，rootCwd 贯穿真 ROOT） |

子进程 `initSession` 读这 4 个 env 建立基线后，`createRecordForMode` 读 `execCtxAls` 时，孙 subagent 的 `parentRecordId` 自然 = 子进程自己的 record id（即孙的直接父）。

**被否**：用 `PI_SUBAGENT_PARENT_RECORD_ID`（描述父）。语义混乱——env 的接受方是子进程，子进程读 `PARENT_RECORD_ID` 后还要再映射"我的父是 X"，不如 `SELF_RECORD_ID` 直接建立"我是 X"的执行上下文。`SELF` 与 `execCtxAls.enterWith({recordId: SELF})` 一一对应，零映射。

#### 决策 2：无条件注入（含 fork subagent，顺带改善 fork 可见性）

`PI_SUBAGENT_FORK_DEPTH` 仅 `fork=true` 时注入（fork 是可选行为）。本设计的 4 个 env **无条件注入每个 subagent**——身份贯穿与落盘目录统一是所有 subagent 的基础需求，不依赖 fork。

**fork subagent 的归属变化（顺带改善）**：`execute(opts.fork=true)` 同样走 `runSpawn`（`subagent-service.ts:715-718` 透传 `opts.fork`），childEnv 无条件构造，故 fork subagent 的子进程也收到 `PI_SUBAGENT_ROOT_SESSION_ID`。现状下 fork session 内 spawn 的 subagent 其 `rootSessionId` = fork session 自身 id，主进程（filter=ROOT）不可见；本设计后归顶层 ROOT、主进程可见。这是**改善**（消除 fork 可见性割裂，符合「看到全部」诉求），非破坏——多个**独立**主 session（非 fork 关系）仍按各自 rootSessionId 隔离（场景 3 覆盖）。

**被否**：注入加 `if (!opts.fork)` 排除 fork subagent。会让 fork 分支内的递归 subagent 仍不可见，与「看到全部」诉求冲突，且增加条件分支复杂度。

#### 决策 3：`rootSessionId` 来源从 `this.sessionId` 改为 `this.sessionRootId`

新增 `SubagentService.sessionRootId` 字段：

```ts
// initSession 中：
const envRoot = process.env.PI_SUBAGENT_ROOT_SESSION_ID;
this.sessionRootId = envRoot ?? init.sessionId;  // 有 env = 子进程（贯穿真 ROOT）；无 env = 根进程（自己是 root）
```

`createRecordForMode` 改用 `this.sessionRootId` 赋值 `record.rootSessionId`。根进程 `sessionRootId === sessionId`（行为不变）；子进程 `sessionRootId` 是 env 贯穿的真 ROOT。

**被否**：保留 `this.sessionId` 含义不变，另加 `this.sessionRootId`。会引入两个相似字段易混。本设计显式区分：`sessionId` = 本进程 pi session（用于事件路由等），`sessionRootId` = 所属根 session（用于 record 归属过滤）。语义正交。

#### 决策 4：`execCtxAls` 在 `initSession` 用 `enterWith` 建立基线（而非每次 execute）

子进程只有一个身份（自己的 record），`enterWith` 贯穿整个 session 生命周期，进程内所有 async 链都能读到。这与 `forkDepthAls` 的 initSession 初始化模式完全一致。

> **探针（实施期门，准则 7）**：`initSession` 读 env 后，在 `TAIJI_AGENT_DEBUG=1` 时输出 `[subagents] execCtxAls initialized: recordId=X depth=Y rootSessionId=Z`。验收场景 1 用它确认基线建立。⛔ 实施期补探针实测。

## 4. 验收

> 用真实 pi CLI 本地实测（项目规范：pi extension 测试优先本地 pi 实测，非单测非 mock）。模型用 `xiaomi-token-plan-cn/mimo-v2.5-pro`。

### 场景 1：三层嵌套全树可见（回溯目标 1）

**确定性构造**：不依赖 LLM 自主决定是否递归——写一个强制递归 test agent（`recursive-worker.md`），system prompt 固定「收到任何 task，若未达第 3 层则先 spawn 一个同 agent 子 agent，再用一句话回复」，配 `maxTurns` 钉死三层。确保每次都产生确定的 A→B→C 链，而非「大概率触发」。

**步骤**：
1. 写 `recursive-worker.md`（强制递归 agent，深度到 3 停）。
2. 本地起主 pi session（rpc 模式）：`pi --mode rpc --session-dir /tmp/acc-rec --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <subagent-workflow 路径>`
3. 发 prompt 让主 agent 用 `recursive-worker.md` spawn A（`agent({agent: <recursive-worker 绝对路径>, maxTurns: 3})`），A 强制 spawn B、B 强制 spawn C。
4. 等全树完成后，主 session 发 `/subagents` 命令。

**通过标准**：
- `/subagents` 列表出现 3 条 record（A/B/C）
- depth 标签：A 无标签（L1 顶层不标）、B `[L2]`、C `[L3]`
- 选中 A 详情：`parent: (root)`，`children:` 列出 B 的 id
- 选中 B 详情：`parent:` 指向 A 的 id，`children:` 列出 C 的 id
- 选中 C 详情：`parent:` 指向 B 的 id，`children:` 为空

### 场景 1b：env 传递机制确定性验证（回溯目标 1，单元层）

场景 1 依赖 LLM 配合验端到端可见性；本场景用单元测**确定性**验证 env 传递机制本身（不依赖 LLM）。

**步骤**：单元测断言 `runSpawn` 构造的 `childEnv` 含 4 个 `PI_SUBAGENT_*` 键，值 = `ctx.sessionRootId` / `record.id` / `String(record.depth)` / `ctx.rootCwd`（mock `spawn` 捕获传入 env）。

**通过标准**：4 个 env 键存在且值正确；覆盖 `opts.fork=true` 与 `opts.fork=false` 两种（决策 2 无条件注入，两者都应有）。

### 场景 2：identity entry 字段持久化正确（回溯目标 2）

**步骤**：场景 1 完成后，检查 `/tmp/acc-rec/subagents/sessions/` 下 A/B/C 三个 session.jsonl 的 `subagent-identity` custom entry。

**通过标准**（每个文件）：
| record | rootSessionId | parentRecordId | depth |
|---|---|---|---|
| A | = 主 session id | 缺失或 null | 0 |
| B | = 主 session id | = A.id | 1 |
| C | = 主 session id | = B.id | 2 |

三个文件的 `rootSessionId` **完全相同**（都 = 主 session id）。

### 场景 3：多主 session 隔离不串（回溯目标 1，防回归）

**步骤**：起两个独立主 pi session（不同 `--session-dir`，如同 cwd 下两个独立 session），各自 spawn 一个 subagent。

**通过标准**：session1 的 `/subagents` 只看到 session1 的 subagent，看不到 session2 的（`rootSessionId` 过滤生效，隔离未被破坏）。

### 场景 4：重开 session 仍可见全树（回溯目标 3）

**步骤**：场景 1 的主 session 退出后，用 `pi --resume <主 session>` 重开，发 `/subagents`。

**通过标准**：全树 A/B/C 仍可见，parent/children/depth 与场景 1 一致（磁盘重建链路完整）。

### 场景 5：fork 分支 subagent 可见（回溯目标 4）

**步骤**：主 session 中 fork 出一个分支 session（pi `/fork`），在 fork 分支内用场景 1 的 `recursive-worker` spawn 一个 subagent F。回到主 session 发 `/subagents`。

**通过标准**：
- 主 session `/subagents` 列表出现 F（rootSessionId = 主 session id，归 ROOT）
- F 的 identity entry `rootSessionId` = 主 session id（非 fork session id）
- 场景 3 的独立 session 隔离仍成立（fork 分支归 ROOT 不破坏独立 session 隔离）

## 5. 下一层拆分

### 数据模型 + env 契约（单元 1）

- **改 `subagent-service.ts`**：`SubagentService` 加 `private sessionRootId: string` 字段；定义 4 个 env 常量名（`PI_SUBAGENT_ROOT_SESSION_ID` / `PI_SUBAGENT_SELF_RECORD_ID` / `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_ROOT_CWD`）。
- **justification**：契约先行，后续单元引用同一常量。

### initSession 读 env 建立基线（单元 2）

- **改 `subagent-service.ts:initSession`**（约 279-289 行 forkDepth 读取块附近）：
  ```ts
  const envRoot = process.env.PI_SUBAGENT_ROOT_SESSION_ID;
  this.sessionRootId = envRoot ?? init.sessionId;
  const envSelfRecord = process.env.PI_SUBAGENT_SELF_RECORD_ID;
  // 守卫对齐 forkDepth（subagent-service.ts:284 同样排空串），防 env 异常空串导致 enterWith({recordId:""})
  if (envSelfRecord !== undefined && envSelfRecord !== "") {
    const envDepth = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10);
    this.execCtxAls.enterWith({ recordId: envSelfRecord, depth: Number.isNaN(envDepth) ? 0 : envDepth });
  }
  ```
- **探针**：`TAIJI_AGENT_DEBUG=1` 时输出初始化日志（决策 4）。
- **justification**：子进程启动即建立"我是谁"的执行上下文，后续 `createRecordForMode` 读 ALS 自动正确。
- **验收**：场景 1。

### createRecordForMode 改 rootSessionId 来源（单元 3）

- **改 `subagent-service.ts:653`**：`rootSessionId: this.sessionRootId`（从 `this.sessionId` 改）。
- `parentRecordId` / `depth` 不变（仍读 `execCtxAls`，单元 2 保证子进程 ALS 已建立）。
- **justification**：根进程 `sessionRootId===sessionId`（行为不变），子进程用贯穿的真 ROOT。
- **验收**：场景 2。

### SessionRunnerContext 透传 sessionRootId（单元 4）

- **改 `session-runner.ts:SessionRunnerContext`**：加 `sessionRootId: string` 字段。
- **改 `subagent-service.ts:buildSessionRunnerContext`**：填入 `this.sessionRootId`。
- **justification**：runSpawn 需要真 ROOT 注入子进程 env，不能依赖 `process.env` 隐式继承（显式传递更清晰、可测）。
- **验收**：单元 5 联动。

### runSpawn 注入 env（单元 5）

- **改 `session-runner.ts:659` env 块**（forkDepth 注入旁）：
  ```ts
  childEnv.PI_SUBAGENT_ROOT_SESSION_ID = ctx.sessionRootId;  // 贯穿真 ROOT
  childEnv.PI_SUBAGENT_SELF_RECORD_ID = record.id;            // 子进程自己的 record
  childEnv.PI_SUBAGENT_DEPTH = String(record.depth);          // 子进程的深度
  childEnv.PI_SUBAGENT_ROOT_CWD = ctx.rootCwd;                // [MF-3] 真 ROOT 的 cwd（落盘目录编码键）
  ```
- **justification**：跨进程传递的唯一注入点。无条件注入（决策 2）。第 4 个 env（ROOT cwd）与身份贯穿同构，子进程 store/runSpawn 落盘目录统一编码在 `enc(ROOT cwd)` 段（sessions 与 records 两套目录必须同源，见 path-encoding.ts）。
- **验收**：场景 1/2/4 全量联动。

### 文件改动地图

| 文件 | 改动 |
|---|---|
| `extensions/subagent-workflow/src/execution/subagent-service.ts` | 单元 1/2/3/4（字段 + initSession + createRecordForMode + buildSessionRunnerContext） |
| `extensions/subagent-workflow/src/execution/session-runner.ts` | 单元 4/5（SessionRunnerContext 字段 + runSpawn env 块） |

展示层（`list-component.ts` / `list-view.ts` / `session-reconstructor.ts`）**零改动**——`SubagentRecord` 类型字段不变，重建器已读 identity 的 `parentRecordId`/`depth`/`rootSessionId`。

### 待验证检查点

- 探针实测（决策 4）：实施期在本地 pi 跑场景 1，确认 `[subagents] execCtxAls initialized` 日志在 A/B/C 三个子进程都出现且值正确。
- 深度护栏交互（设计期值链推导，实施期 smoke 确认）：`execCtxAls` 既用于建树（本设计）又用于嵌套深度护栏（`subagent-service.ts:416-417` 的 `nestingDepth = parentNesting ? parentNesting.depth+1 : 0`）。值链自洽：`enterWith` 基线 `depth` = env `PI_SUBAGENT_DEPTH` = 父注入的 `String(record.depth)`；子进程创建孙时护栏读 `execCtxAls.depth + 1` = 子.depth，与主进程 `execute` 入口的计算同构（主进程无 env → ALS 空 → depth=0 顶层）。**结论：不破坏护栏阈值**，子进程从正确深度起算而非从 0 重计。实施期跑一次极限深度场景 smoke 确认推导成立。
