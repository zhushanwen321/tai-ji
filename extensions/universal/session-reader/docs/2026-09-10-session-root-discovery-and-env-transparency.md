# session-reader 会话根发现、环境自识别与布局对齐

> **一句话结论**：`session_read` 在 xyz-agent/TaiJi 里看不到任何主 session，根因是 xyz-agent 的数据布局**没有对齐现版 pi**——sessions 被 `--session-dir` 覆盖到 `agentDir` 的兄弟目录 `<dataDir>/pi/sessions`，而工具按 pi 默认布局推导 `<agentDir>/sessions`。本设计给两层解法：**方案 B（根修，先行）**把 xyz-agent 布局完整对齐现版 pi（agent 目录上移、去掉 `--session-dir`、存量数据一次性手工迁移——无外部用户，存量集合封闭），让派生式假设**构造性成立**并绝根此类 bug；**方案 A（护栏与体验）**把 session-reader 的根解析改为权威信号 + 候选根探测 + `doctor` 自诊断，并补齐错误信息、uuid 归一化、分组输出与标题检索。B 先行则 A 显著收缩（删 env 注入与 family 专项修复）。另将 session-reader 的双仓副本（纯 pi 装机版 / CLI 仓）纳入同步范围（§6.9 / M5），消除同一 bug 的仓外存留。

---

## 开篇（SCQA）

- **S（情境）**：`session-reader` 是 pi 的一个 extension，对外暴露 `session_read` 工具，提供 `find → outline → expand → detail` 的渐进式读取，让 LLM 用结构化语义（turn / entry）而不是裸字节去读 pi 的 session jsonl。它是**刻意设计的护栏**——存在的意义之一就是阻止 agent 直接 `find`/`grep`/`cat` 原始 jsonl。
- **C（冲突）**：在 xyz-agent（含打包版 TaiJi.app）里，`find` / `recent` 对**主 session 完全失明**。实测 `session_read{action:"find", query:"01a08a6e"}` 命中 0 条，而同一时刻 `outline` 传入该文件的绝对路径**一次成功**。agent 连续失败后转向 shell `find` 搜磁盘——护栏被绕过。
- **Q（问题）**：如何让 `session_read` 在任何宿主下都能一次命中，使绕行 shell 搜盘**没有收益**？
- **A（答案）**：两层解法。**方案 B（§6.10–§6.12，根修）**：xyz-agent 数据布局完整对齐现版 pi——`PI_CODING_AGENT_DIR` 改指 `<dataDir>/agent`、**去掉 `--session-dir`** 让 pi 用默认布局（`agent/sessions/<encodeCwd>/`）、存量数据由**一次性手工迁移脚本**搬运（无外部用户，存量集合封闭，§6.11）、reap 判据从 `--session-dir` 换为 spawn 清单。**方案 A（§6.1–§6.9，护栏与体验）**：session-reader 根解析改权威信号 + 候选根探测 + `doctor` 自诊断；错误信息重写 + uuid 归一化 + 分组输出；元数据用 `SessionManager.listAll`。B 先行，A 收缩执行。

---

## 1. 背景：被设计的系统是什么

**本章结论**：`session-reader` 是一条通用读取引擎加一层发现层；本次设计聚焦发现层里「主 session 根目录怎么定」这一个决定，以及它导致的两条下游失败（`find` 类与 `family` 类）。**

`session_read` 内部是两层：

| 层 | 职责 | 代表文件 |
|---|---|---|
| **发现层（discovery）** | 决定「有哪些 session 文件、各自在哪、哪些匹配查询」 | `src/discovery/roots.ts`（扫盘）、`find.ts`（匹配）、`subagents.ts`（家族扫描 + subagent manifest） |
| **读取层（core + tool-handler）** | 解析 jsonl、重建 turn/entry 视图、渲染成 token 受控的文本 | `src/core/*`、`src/tool-handler.ts` |

关键性质：**读取层是干净的、来源无关的**——只要给它一个文件路径，它就能读。事故里「绝对路径一次成功」正是这一层的证据。

发现层的输入是一个参数 `agentDir`。它从 pi 的 `getAgentDir()` 取（`src/index.ts:189` 调用 `handleSessionRead(params, getAgentDir(), signal)`）。`getAgentDir()` 的语义是 pi 实装契约（`dist/config.js:420`）：

```js
// pi dist/config.js:420-426
export function getAgentDir() {
    const envDir = process.env[ENV_AGENT_DIR];   // ENV_AGENT_DIR = 'PI_CODING_AGENT_DIR'
    if (envDir) return expandTildePath(envDir);
    return join(homedir(), CONFIG_DIR_NAME, "agent");  // ~/.pi/agent
}
```

发现层用它推导两个根：

```ts
// src/discovery/roots.ts:83-94
export async function listMainSessions(agentDir: string) {
  return scanJsonlRecursive(join(agentDir, 'sessions'), SKIP_DIRS_MAIN)   // ← 主 session
}
export async function listSubagentSessions(agentDir: string) {
  return scanJsonlRecursive(join(agentDir, 'subagents'), new Set())       // ← subagent
}
```

### 1.1 两个宿主，两种布局

`getAgentDir()` 在两种宿主下返回不同值，而 session 的**实际落盘位置只在一种宿主下等于 `<agentDir>/sessions`**：

| 宿主 | `agentDir` = `getAgentDir()` | pi 如何决定 session 目录 | 主 session 实际位置 |
|---|---|---|---|
| **纯 pi CLI** | `~/.pi/agent` | 未指定 → pi 默认：`<agentDir>/sessions/<encodeCwd(cwd)>/` | `<agentDir>/sessions/` ✅ 与推导一致 |
| **xyz-agent / TaiJi.app** | `~/.xyz-agent/pi/agent`（由 `PI_CODING_AGENT_DIR` 注入） | runtime 显式传 `--session-dir <dataDir>/pi/sessions` | **`<dataDir>/pi/sessions/`** ❌ 是 `agentDir` 的**兄弟**，不是子目录 |

pi 的 session 目录优先级（`dist/main.js:530-533`）：

```js
const envSessionDir = process.env[ENV_SESSION_DIR];   // 'PI_CODING_AGENT_SESSION_DIR'
const sessionDir = (parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
    (envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
    startupSettingsManager.getSessionDir();
```

即 **`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > settings.sessionDir > 默认 `<agentDir>/sessions/<encodeCwd>`**。

xyz-agent 走的是第一条：`packages/runtime/src/infra/pi/rpc-client.ts:289` 执行 `args.push('--session-dir', sessionDir)`，其中 `sessionDir = getSessionsDir()`。而 xyz-agent 自己的路径 SSOT 明确把 sessions 定义成 `pi/` 的子目录、`agent/` 的**兄弟**（`packages/runtime/src/infra/pi/pi-paths.ts:105`）：

```ts
/** xyz-pi root: ~/.xyz-agent/pi/ */
export function getPiRoot(): string { return join(getConfigDir(), 'pi') }
/** xyz-pi agent directory: ~/.xyz-agent/pi/agent/ */
export function getPiAgentDir(): string { return join(getPiRoot(), 'agent') }

export function getSessionsDir(): string {
  return join(getPiRoot(), 'sessions')     // ← ~/.xyz-agent/pi/sessions，不是 agentDir/sessions
}
```

> **`agentDir`** = pi 的 agent 配置目录，读 `PI_CODING_AGENT_DIR`，存放 `models.json` / `settings.json` / `auth.json`。
> **`sessionDir`** = session jsonl 的存放目录。二者在纯 pi 下是父子关系（`<agentDir>/sessions`），在 xyz-agent 下是**兄弟关系**（`<dataDir>/pi/sessions`）。工具把两者当成同一个推导式，这就是全部问题的根。

**subagent 不受影响**：xyz-agent 没有覆盖 subagent 目录，`subagent-workflow` 用 `getPiAgentDir()` 派生子路径，所以 `<agentDir>/subagents/` 在两个宿主下都成立。这解释了事故里最反直觉的现象——**subagent 查得到、主 session 查不到**。

### 1.3 布局沿革：现布局是「旧版 pi 形态的快照」

要理解 §6.10 的方案 B，需要先知道现在的 `pi/` 层是怎么来的、以及它与现版 pi 的偏差。

**`pi/` 层的出生**：commit `77f006420`（2026-05-27，`fix: unify xyz-pi directory to ~/.xyz-agent/pi/`）。那次修复的 root cause 是打包版把 `PI_CODING_AGENT_DIR` 指到了 app 内捆绑的只读资源目录（无 models.json，pi 起不来）；修法原文是「use `~/.xyz-agent/pi/` as xyz-pi's root directory (**equivalent to system pi's `~/.pi/`**)」——即**在 app 数据目录里镜像一个完整的 pi 家目录**。`pi/` 这层买到的所有权边界（重置内嵌 pi = `rm -rf pi/`，不碰 app 的 config/extensions）、与打包资源结构对齐、dev/prod 实例隔离，这些都成立且保留。

**但它镜像的是 pi 当时的形态**：`pi/{agent, sessions}` 并排、sessions 平铺。之后 pi 自己演进过两次（证据见 §12.3）：

| | 旧版 pi（镜像时） | 现版 pi 0.84.x |
|---|---|---|
| sessions 位置 | `~/.pi/sessions`（家级） | **`<agentDir>/sessions`**（收进 agent；`dist/config.js:456`） |
| 文件形态 | 平铺 | **`<encodeCwd>/` 子目录**（`migrations.js` 的 `migrateSessionsFromAgentRoot`，注释自述「Bug in v0.30.0」，issue pi-mono#320） |

xyz-agent 的镜像没有跟随：`getSessionsDir()` 仍指向家级 `pi/sessions`、`--session-dir` 又把文件压成平铺。本机旁证：`~/.pi/sessions/` 是空残壳（2026-05-26），4619 个真实 session 全在 `~/.pi/agent/sessions/<encodeCwd>/`——**纯 pi 用户的实际布局早已不是「家级 sessions」**。

方案 B 的取向由此而来：与其让消费端继续猜，不如把布局对齐到现版 pi，让「从 agentDir 派生」这个假设**构造性成立**。

### 1.2 受影响的 action 不止 `find`

发现层的根列表是**多个 action 的共享数据源**。除了 `find`，还有：

- `family` / `export{format:"family"}` → `tool-handler.ts:707,882` → `buildFamilyFromFs(sessionId, agentDir)` → `subagents.ts:99 collectMainSessions()` → **同一条 `listMainSessions(agentDir)`**。
- 其余按 id 解析的 action（`outline`/`expand`/`detail`/`search`/`export`/`extract`/`workflow`/`result`）走 `resolveSessionId` 的片段分支 → `findSessions`。

所以只修 `findSessions` 会制造一个**新的矛盾**：`find` 说这个 session 存在，`family` 紧接着说它不存在（§3.2 失败模式 C 的加强版）。本设计把根列表作为**单一数据源**供全部发现层消费者使用。

---

## 2. 设计目标

**本章结论**：改造后，agent 在任何宿主下都能用 `session_read` 完成「定位 → 阅读 → 检索」全流程，无需任何 shell 搜盘。**

1. **任何宿主下主 session 全 action 可见**：`find`（uuid / recent / 关键词三条匹配路径）以及 `family` / `export{format:"family"}` 等按 id 解析的 action，候选集必须包含当前宿主的全部主 session。
2. **失败时能自证，且不给出错误归因**：定位失败的错误信息必须携带「发现层内部状态」（每个候选根路径 + 文件数）+ 一条**确定能成功**的替代动作 + 明确的禁止项；**不得**在证据不足时断言「真的没有这个 session」。
3. **环境透明**：agent 能直接问出「我现在跑在纯 pi 还是 xyz-agent/TaiJi，数据目录在哪」，不必靠猜或探测。
4. **主 session 可按人话检索**（范围限定）：能用标题（如「福耀玻璃深度研究」）、cwd、时间检索**当前宿主会话根**内的主 session，不必记 uuid。**显式不覆盖（仅标题维度）**：`<encodeCwd>/` 子目录布局下的标题检索——§6.10 布局对齐后 xyz-agent 主根与纯 pi 同构（各项目 session 在 `<encodeCwd>/` 子目录），标题检索需逐目录全量解析，成本不可接受（§6.6 调用策略 2），故该维度对两种宿主同规则不覆盖；标题仍随 search 输出可见（§6.6 降级路径：标题检索降级为不可用而非错误）。**首条 user 关键词匹配不在此限定内**：该维度维持现状能力（全部候选可检索，含纯 pi 跨项目），见 §6.6 策略 2 的回退规则。
5. **跨会话内容检索**（阶段二）：能回答「哪个 session 讨论过 X」，而不是只能按元数据匹配。
6. **布局完整对齐现版 pi**（方案 B，先行）：xyz-agent 的数据布局与 pi 0.84.x 完全同构，唯一差异是根目录（`~/.pi/` vs `~/.xyz-agent/`）。对齐后「从 agentDir 派生 session 路径」对**所有**消费者构造性成立，本类 bug 绝根；pi 未来演进布局时 xyz-agent 零改动自动跟随。

**In-scope**：`session-reader` extension 的发现层重构（根解析 / 环境识别 / `doctor` / 错误信息 / 检索维度）；**xyz-agent 数据布局对齐 pi（§6.10）+ 一次性手工迁移与启动残留探测（§6.11）+ reap 判据替换（§6.12）**；**双仓同步（§6.9，M5：npm 发版 + 纯 pi 装机更新 + CLI 仓与 skill 重平移）**。
**Out-of-scope**：
- 不改任何 session 文件的**格式**（jsonl 行结构、entry 类型——session-reader 纯读，方案 B 也只改「写到哪个目录」不改「写什么」）。**写入位置**属 In-scope：方案 B 会把新 session 的落盘位置从 `<dataDir>/pi/sessions`（平铺）切到 `<dataDir>/agent/sessions/<encodeCwd>/`（pi 默认），存量数据由一次性手工迁移脚本搬运（§6.11）；pi 子孙进程继承面的完整枚举见 §6.5（仅 A 全量退路相关）。
- 不改 pi 源码（[MANDATORY] 上游不改；方案 B 全部用 pi 的公开机制：`PI_CODING_AGENT_DIR` env + 默认派生，不 fork 不 patch）。
- 不做 TUI 侧改动（`hash-provider` / `/session-pick` 数据源已是 `SessionManager.listAll` 且仅 TUI 注册，不受本 bug 影响）。
- 不在工具 description 里注入环境信息（理由见 §6.4）。
- 不引入持久化索引文件（阶段二先用「窄化后线性扫 + 字节上限」，是否需要索引见 §11）。

---

## 3. 现状：使用者眼里是什么样的

**本章结论**：agent 拿不到任何候选，工具把失败误报成「没有这个 session」，并在错误信息里把 agent 指向一个同样会失败的下一步；最后 agent 只能去 shell 搜盘。**

### 3.1 现状的真实输出

无匹配时，工具返回（`src/tool-handler.ts:384-391` 实装文案）：

```text
无匹配 session："01a08a6e"。最近 3 个 session：
  1. 01a08aac… 修复…
  2. 01a08aab… 红队证伪…
  3. 01a08aa7… 【任务】…
👉 用 session_read { action:"find", query:"recent" } 看全量，或换片段重试。
```

`find` 命中时，每条候选只打印 **8 字符截断 id**（`src/tool-handler.ts:434`，`SESSION_ID_PREFIX_LEN = 8`）：

```text
1. 01a08aac… 2026-09-10 Stock
2. 01a08aab… 2026-09-10 Stock
```

工具自己声明的行为边界（`src/index.ts:152` description）：

> `Do NOT use for the current session (the host provides current-session access) …`
> `outline before detail. Never read raw .jsonl files—use this tool.`

### 3.2 怎么出错（实机复现）

在 xyz-agent 真实数据上跑发现层（探针命令见 §12.2）：

| # | agent 的调用 | 实测结果 | 期望 |
|---|---|---|---|
| 1 | `find{query:"01a08a6e"}` | 0 命中 | 命中主 session |
| 2 | `outline{session:"01a08a6e-74fc-78a4-9580-8539b40e0920"}` | 无匹配 | 返回 outline |
| 3 | `find{query:"01a08a"}` | 34 命中，**全是 subagent，主 session 0 条** | 含主 session |
| 4 | `find{query:"recent"}` | 同样 0 条主 session | 含主 session |
| 5 | `outline{session:"~/.xyz-agent/pi/sessions/2026-09-10T08-28-09-852Z_01a08a6e-….jsonl"}` | **成功** | 成功 |

失败模式归纳：

- **A（主 session 全盲）**：`find` / `recent` / `family` 的候选集里主 session 恒为 0。**这是唯一的根因性失败**，#1/#2/#3/#4 全部由它派生。
- **B（误导性恢复指引）**：错误信息推荐 `action:"find", query:"recent"`，而 `recent` 走的是**同一个**候选集 → 照做必然二次失败。
- **C（失败归因错误）**：工具把「根目录配错」表现为「没有这个 session」，agent 无法区分二者，于是怀疑是自己 uuid 记错，反复换片段重试。
- **D（输出不可复制）**：`find` 只给 8 字符截断 id，agent 无法把它粘回去做精确调用 → 被推向 shell `ls`。

### 3.3 对 handoff 报告的核对结论（重要）

原诊断把它拆成两个独立缺陷（P0-1 主 session 索引缺失 / P0-2 uuid→文件解析失效）。**核实结论：P0-2 不是一个独立缺陷，是 P0-1 的表现——但仅限 handoff 列举的输入形态。**

依据：`session` 参数的三种形态走三条**互不相交**的解析分支（`src/tool-handler.ts:266-288`）：

```ts
// ① 绝对路径或 ~ 前缀（Windows 盘符由 isAbsolute 处理）
if (isAbsolute(session) || session === '~' || session.startsWith('~/')) {
  return resolveBySessionPath(session)      // ← 直接 stat + 读首行，完全不经过发现层
}
// ② sa-id 前缀 → record manifest 精确反查
if (session.startsWith('sa-')) return resolveByRecordId(...)
// ③ 其余：findSessions 透传 source 沿用 F1/F2
return resolveByFragment(session, agentDir, source)   // ← 走发现层，撞的是同一个根
```

- 分支 ①（绝对路径）**从不查候选集**——它 `existsSync` + 读首行 header 就返回。所以 #5 成功只证明读取层没坏，不证明「uuid→文件解析链路」有任何独立问题。
- 分支 ③（片段）走 `findSessions`，命中条件是纯子串（`src/discovery/find.ts:375-377`）：

  ```ts
  const uuidHits = candidates.filter(
    (c) => c.ref.sessionId.includes(query) || c.meta.path.includes(query),
  )
  ```

  这条子串匹配**天然覆盖 handoff 列举的全部输入形态**。实测（用真实 14 个主 session 构造候选集）：

  | 传入形态 | 修复候选集后命中 |
  |---|---|
  | `01a08a6e`（8 位前缀） | 3 main ✓ |
  | `01a08a6e-74fc-78a4-9580-8539b40e0920`（完整 uuid） | 1 main ✓ |
  | `a08a6e-74fc`（任意位置子串） | 1 main ✓ |
  | 完整 basename（含时间戳前缀） | 1 main ✓ |
  | `#` + uuid | 由上游 `stripHash`（`tool-handler.ts:111-113`，调用点 `:269`）剥离，工具路径 OK ✓ |

  所以「uuid 解析」对 handoff 列举的形态**不需要新增能力，候选集修好即自动成立**。P0-2 的验收项（#1/#2 转 ✅）合并进 P0-1。

**但「自动全好」有边界——存在两个 handoff 未列举、修好候选集后仍 0 命中的形态**（实测同上）：

| 传入形态 | 修复候选集后命中 | 原因 |
|---|---|---|
| `01A08A6E-74FC-…`（**大写** uuid） | **0** | `String.includes` 大小写敏感 |
| `01a08a6e74fc78a495808539b40e0920`（**去连字符**） | **0** | 与带连字符 id 不构成子串 |

更糟的是这两个形态会被 `looksLikeUuidFragment`（`find.ts:156-158`，`/^[0-9a-f-]+$/i`，**大小写不敏感**）判为「像 uuid 片段」→ **跳过关键词回退** → 0 命中。若按 v1 设计直接把自检结论写成「根解析正常，这是真的没有这个 session」，对这两个输入就是**错误归因**——正是 §3.2 失败模式 C 的翻版。处理见 §6.7。

**handoff 另有两处事实需更正**：

- handoff §6 把 `…/2026-09-10T08-28-09-852Z_01a08a6e-74fc-….jsonl` 标注为「福耀玻璃深研」。该文件实际的标题是 **「太保寿险深度研究攻坚」**；「福耀玻璃深度研究」是同一分钟创建的另一个文件 `…_01a08a6e-0d26-….jsonl`。这本身无关紧要，但它说明**即使路径正确，靠文件也无法判断内容是哪个标的**——正好是 §2 目标 4（标题检索）要解决的问题。
- handoff §2 记录「`~/.xyz-agent/pi/sessions/` 47 个 jsonl」。本次实测为 **14** 个（环境随时间变化），不影响结论。

### 3.4 为什么第 3 条「34 命中全是 subagent」不是 bug

`find{query:"01a08a"}` 命中 34 条 subagent 是**正确行为**：pi 的 session id 是 uuidv7，v7 的前缀是毫秒时间戳，所以同一小时内创建的 session 天然共享 6–7 位前缀。实测命中项的 id 形如 `01a08aac-…` / `01a08aab-…`，确实都含 `01a08a`。

> **这条事实改变设计取向**：短 uuid 片段**在构造上就是弱检索键**（时间前缀碰撞）。把「一次命中」寄托在片段匹配上不可靠，必须补标题、cwd、时间这些**语义键**（§2 目标 4）。

---

## 4. 根因 + 物理数据流

**本章结论**：唯一的根因是 `listMainSessions` 把「pi 的默认 session 布局」当成「session 布局」，而 xyz-agent 用 CLI 参数覆盖了它；发现层没有任何机制把这个覆盖反馈给自己。**

### 4.1 根因

```ts
join(agentDir, 'sessions')   // src/discovery/roots.ts:84
```

这一行隐含了一个**未被声明、也未被校验的假设**：`sessionDir === <agentDir>/sessions`。该假设：

- 在**纯 pi** 下成立（pi 默认布局，`dist/core/session-manager.js:242-247` 的 `getDefaultSessionDirPath`）；
- 在 **xyz-agent / TaiJi.app** 下**不成立**，因为 runtime 用 `--session-dir` 显式覆盖成了 `<dataDir>/pi/sessions`。

发现层拿不到「sessionDir 被覆盖了」这个信息，因为它只接收 `agentDir` 一个参数。**信息不对称**，而非逻辑错误。

> 这是**猜测 vs 权威**的问题：工具在**猜** session 根在哪（按 pi 默认布局推），而宿主**知道**它在哪（`SessionManager` 已解析、`--session-dir` 在 argv 里）。修法是让工具从「猜」改成「问」。

### 4.2 实测的四个根目录（三宿主对照）

| 宿主 | `<agentDir>/sessions` | `<dirname(agentDir)>/sessions` | `<agentDir>/subagents` | 真值 |
|---|---|---|---|---|
| xyz-agent（TaiJi.app） | 2（另有 6 个在 `workflow-state/` 被有意跳过） | **14** | 1330 | 14 |
| xyz-agent-dev | 0 | **35** | 62 | 35 |
| 纯 pi | **4619** | 0（`~/.pi/sessions` 本机为空） | 2596 | 4619 |

注一：`<agentDir>/subagents` 一列三个宿主全部正确——再次印证 subagent 路径不受本 bug 影响。
注二：`~/.pi/sessions` 在**本机**为空是 pi 自己的 `migrations.js` 迁移结果；**不能当作通用前提**。注意有**两条互不相同的迁移链**会产生「legacy 非空」状态：① 纯 pi 侧——pi 的 `migrations.js` 把旧 `~/.pi/sessions` 迁入 `<agentDir>/sessions`，中断则前者残留；② xyz-agent 侧——`packages/runtime/src/infra/pi/pi-maintenance.ts:71,97` 把 `<configDir>/sessions`（即 `~/.xyz-agent/sessions`）迁入 `<configDir>/pi/sessions`，中断则前者残留——**注意 `~/.xyz-agent/sessions` 不在本设计任何候选根里**（候选根是 `dirname(agentDir)/sessions` = `~/.xyz-agent/pi/sessions`），若需覆盖属另一处缺口（§11.7）。本设计对 `[legacy]` 根采用「非空即纳入候选 + doctor 告警标注」而非「假定其为空」（§6.1）。

### 4.3 物理数据流（现状）

```text
磁盘                                                        发现层                         agent 眼前
────────────────────────────────────────────────────────────────────────────────────────────────────
~/.xyz-agent/pi/sessions/                    ┐
  2026-09-10T08-28-09-852Z_01a08a6e-74fc….jsonl │  ← 真值在这
  2026-09-10T08-27-43-270Z_01a08a6e-0d26….jsonl │
  （14 个）                                    ┘
                                                          listMainSessions(agentDir)
~/.xyz-agent/pi/agent/sessions/              ┐             = join(agentDir,'sessions')
  --Users-…-stock-dag-plugins-…--/            │  ← 扫的是这里
    （2 个迁移残留 session）                    │
~/.xyz-agent/pi/agent/subagents/             ┘
  --Users-zhushanwen-Stock--/sessions/          scanJsonlRecursive(…, 'subagents') ✅
    （1330 个 subagent session）              ─────────────────────────────────────→  34 条 subagent 候选
                                                                                        主 session: 0 条
                                                                                              ↓
                                                                                    F1「无匹配 session」
                                                                                    👉 提示去用 recent
                                                                                    （recent 走同一候选集）
```

### 4.4 环境识别现状：宿主身份是「可观测但未被观测」的

agent 与工具都不知道自己跑在哪个宿主。但环境里其实已有充分证据（以下均为**活体进程实测**，非推断）：

| 信号（`process.env`） | 纯 pi | xyz-agent dev | TaiJi.app | 单独使用的可靠性 |
|---|---|---|---|---|
| `XYZ_AGENT_EXT_LOG` | 无 | `1` | `1` | **中**——xyz-agent 无条件注入（`rpc-client.ts:195`，注释「托管语义恒为 `'1'`」），但 `ENV_WHITELIST_PREFIXES` 含裸 `XYZ_` 前缀（`packages/shared/src/constants.ts:74`），用户 shell 里的同名变量会透传进**任何**进程 |
| `PI_CODING_AGENT_DIR` | 无（除非用户自设） | `<dataDir>/pi/agent` | 同左 | 中——pi 原生变量，裸 pi 用户也可能设；但其**值**形态（`*/.xyz-agent*/pi/agent`）是 xyz-agent 专属约定 |
| `XYZ_AGENT_DATA_DIR` | 可能被用户 shell 设置 | `<dataDir>` | 同左 | **低**（单独用）——非 xyz-agent 专有 |
| `XYZ_AGENT_PACKAGED` | — | **已被剥除** | **已被剥除** | **不可用**——在 `SPAWN_ENV_OUTBOUND_DENY_LIST` 里（`packages/shared/src/spawn-env-contract.ts:30`） |
| `PI_CODING_AGENT_SESSION_DIR` | 无 | **当前未设**（本设计新增，§6.5） | 同左 | 高（一旦由 runtime 注入） |
| extension bundle 路径 | `~/.pi/agent/npm/node_modules/…` | 仓库路径或 npm 目录 | `….app/Contents/Resources/extensions/@zhushanwen/pi-session-reader/` | 高——bundle 为 ESM，`import.meta.url` 保留（`scripts/bundle-extensions.mjs:283`） |

**结论**：**没有任何单一信号是充分判据**。环境判定必须用**多信号合取**（§6.2）：`XYZ_AGENT_EXT_LOG === '1'` **且** `PI_CODING_AGENT_DIR` 值匹配 xyz-agent 目录形态，二者同时成立才判「xyz-agent 托管」；包型（dev / packaged）用 extension 自身 bundle 路径判定。`XYZ_AGENT_PACKAGED` 明确不可用（这条要写进文档以免后人重蹈）。判定结果永远**附带 evidence 行**，让 agent 能看到「为什么这么判」并自行推翻。

---

## 5. 终态：使用者眼里将是什么样的

**本章结论**：agent 遇到原事故场景时一次命中；即便失败，错误信息也会直接告诉它根目录状态和一条确定可行的下一步，并明确封死 shell 搜盘。**

### 5.1 成功路径

原事故重演（xyz-agent 下，agent 想读那份福耀玻璃深研）。**以下为按实测数据与设计规则推演的期望输出形态，非逐字实测**（实测基线见 §8 V5）：

```text
agent → session_read { action:"find", query:"福耀玻璃" }

main（live 根 14 个 + `[default]` 迁移残留 2 个，合并后 1 条命中）：
  1. 01a08a6e-0d26-780c-9598-1d9dd65d6418 · 2026-09-10 · Stock · 福耀玻璃深度研究
     ↳ session_read { action:"outline", session:"01a08a6e-0d26-780c-9598-1d9dd65d6418" }

subagent（14 条命中，main 1 条 + subagent 14 条 = 15 ≤ 默认 limit 20，故全部列出）：
  2. 01a08a7c-… · 2026-09-10 · 【任务】福耀玻璃…
  …
```

三处变化：候选集含 main、打印**完整 id**、按 `source` 分组且 **main 段置顶**（subagent 噪声不淹没目标，见 §6.7）；标题来自 pi 的 `SessionManager.listAll`（§6.6），所以 agent 说人话就能找到。

agent 想知道自己在哪（**B 前世界示例**；B 后 live/env 根变为 `<dataDir>/agent/sessions`，见 §5.3）：

```text
agent → session_read { action:"doctor" }

环境判定：xyz-agent（托管）· 发行形态：packaged
依据：XYZ_AGENT_EXT_LOG=1 且 PI_CODING_AGENT_DIR 形态匹配 <dataDir>/pi/agent；
      bundle 位于 *.app/Contents/Resources/extensions/
数据目录：/Users/zhushanwen/.xyz-agent
agentDir：/Users/zhushanwen/.xyz-agent/pi/agent

会话根（按优先级）：
  1. [live]     /Users/zhushanwen/.xyz-agent/pi/sessions          ← SessionManager 当前值
                存在 · 14 文件 · 扫 12ms · main
  2. [env]      /Users/zhushanwen/.xyz-agent/pi/sessions          ← PI_CODING_AGENT_SESSION_DIR
                存在 · 14 文件 · 扫 12ms · main（与 1 同路径，已去重）
  3. [legacy]   /Users/zhushanwen/.xyz-agent/pi/sessions          ← dirname(agentDir)/sessions
                与 1 同路径，已去重
  4. [default]  /Users/zhushanwen/.xyz-agent/pi/agent/sessions    ← agentDir/sessions（pi 默认布局）
                存在 · 2 文件 · 扫 3ms · main（含子目录；非当前主根）
  5. [subagent] /Users/zhushanwen/.xyz-agent/pi/agent/subagents
                存在 · 1330 文件 · 扫 210ms · subagent

诊断：主 session 根解析正常（最高优先级 main 根 14 文件）。
（legacy 告警只在 legacy 根**非空**时出现——§6.1；本机该根与主根同路径，已去重，不告警。）
```

### 5.2 失败路径（带恢复指引）

传入一个真的不存在的 uuid：

```text
agent → session_read { action:"find", query:"01a08zzz" }

无匹配 session："01a08zzz"

自检（发现层，只陈述事实）：
  main 根        14 文件  /Users/zhushanwen/.xyz-agent/pi/sessions
  subagent 根    1330 文件 /Users/zhushanwen/.xyz-agent/pi/agent/subagents
  → 候选集非空，根解析正常
  → 查询已做 uuid 归一化匹配（小写 + 去连字符）后仍无命中

最接近的候选（编辑距离）：
  01a08aac-c612-7017-a0d6-1a1cf5f78c53  subagent  差异在第 5 位：zz → 8a
  01a08aa7-779f-7330-9b89-36a453b6381b  subagent  差异在第 5 位：zz → 8a

正确做法：
  - 改用标题/keyword：session_read { action:"find", query:"福耀玻璃" }
  - 已知文件路径时直接传绝对路径：session_read { action:"outline", session:"<绝对路径>.jsonl" }
  - 截断/过期 id 用更短前缀：session_read { action:"find", query:"01a08a" }
  - 想先看环境与根目录状态：session_read { action:"doctor" }

不要用 shell find/ls/rg 搜 session 目录，不要 cat/read 原始 .jsonl —— session_read 是唯一入口。
```

### 5.3 布局终态（方案 B 落地后）

```text
~/.xyz-agent/                      ← xyz-agent 数据根（≙ pi 的 ~/.pi/，但**根层不需要同构**——
│                                     pi 0.84.4 的全部资源从 agentDir 派生，家级足迹为零，
│                                     已由第 4 轮主审 grep pi dist 全量核实）
├─ projects.json / runtime.port / attachments/ / engines/ / gen-stats/
│  logs/ / plugins/ / run/ / secrets/ / update/   ← xyz-agent 自己的（实测清单），不动
├─ agent/                          ← ≙ ~/.pi/agent（PI_CODING_AGENT_DIR = <dataDir>/agent）
│  ├─ models.json / settings.json / auth.json / config/providers.json
│  ├─ sessions/                    ← ≙ pi 默认：getSessionsDir() = join(agentDir,'sessions')
│  │  └─ --Users-zhushanwen-Stock--/    ← <encodeCwd(cwd)>/，pi 自动分目录
│  │     └─ 2026-09-10T08-28-09-852Z_01a08a6e-74fc-….jsonl（+ .model.json/.project.json 等 sidecar）
│  ├─ subagents/<encodeCwd>/{sessions,records}/  ← 相对位置不变，只是少一层 pi/
│  └─ workflow-state/ …
└─ pi.backup-v2-<ts>/              ← 迁移备份，保留不自动删；回滚 = 改回 pi
```

**对齐范围声明**：对齐的是 **`agent/` 子树这一层**（pi 的全部读写足迹），不是根层逐目录同构——pi 的家级遗留物（`~/.pi/extensions`、`assets`、`token-stats` 等实测均非 0.84.4 读写）不需要也不应该在 xyz-agent 侧镜像。变化只有三件事：`agent/` 上移一层、`--session-dir` 从 spawn argv 删除（pi 走默认派生）、存量平铺 session 迁入 `<encodeCwd>/` 子目录。

关键变化：**自检行只陈述事实**（「候选集非空」「已做归一化匹配」），**不断言**「真的没有这个 session」——v1 设计在这里犯的错（对大写/去连字符输入给出错误归因）已在 §6.7 修正；**候选行用编辑距离让 agent 一眼自纠**；**最后一行把绕行动作就地封死**。

---

## 6. 关键决策与权衡

**本章结论**：七个决策共同把「猜根目录、失败不可诊断、检索键弱、家族通路脱节」变成「问权威、失败自证、语义键可检索、全 action 同源」。**

### 6.1 会话根发现：权威优先 + 候选根探测（选定）

- **采用**：发现层改为 `resolveSessionRoots(signals)` 返回**带来源标签的根列表**，逐个扫描、按 realpath 去重、合并结果。信号按优先级：
  1. **`[live]`** `ctx.sessionManager.getSessionDir()`（规范化后的根，见下）——宿主已解析的**权威值**；
  2. **`[env]`** `process.env.PI_CODING_AGENT_SESSION_DIR`——pi 自己的 session 目录变量（**B 先行路径下此信号不建**——布局对齐后 pi 默认派生即正确，随 U4 整体删除，§6.13 收缩；退路时按本节原样执行）；
  3. **`[default]`** `<agentDir>/sessions`——pi 默认布局（纯 pi 的真根，xyz-agent 下的迁移残留）；
  4. **`[legacy]`** `<dirname(agentDir)>/sessions`——xyz-agent 兄弟布局的兜底。
  5. **`[subagent]`** `<agentDir>/subagents`——**常量推导，不来自任何信号**（xyz-agent 未覆盖该目录、subagent-workflow 用 `getPiAgentDir()` 派生，两宿主均正确，§1.1 末段），列入根列表仅为统一展示与 `doctor` 计数。
- **`[live]` 的规范化**：`getSessionDir()` 在纯 pi 返回**按 cwd 编码的子目录**（`<agentDir>/sessions/--Users-x--`），在 xyz-agent 返回**根本身**（`--session-dir` 覆盖时 pi 不追加 encodeCwd，见 `session-manager.js:1179-1180` `const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd)`）。判据：basename 匹配 encodeCwd 形态则取 `dirname`，否则取自身。
- **`[legacy]` 非空的处理**：不假定它为空。非空即纳入候选（历史 session 是真实数据），并在 `doctor` 里标注（示意，实装文案为「非空（N 文件）——该位置已作为候选根纳入 find」，对 agent 更可操作；迁移残留指引由 doctor 的独立 glob 段承担）。
- **被否**：
  - **只加一条 `<dirname(agentDir)>/sessions`**（最小改动）——能把 xyz-agent 修好，但**没有任何自证能力**：下次宿主换个布局，同样静默失效，事故重演。且无法解释「为什么两个根都有文件」。记为「方案 A」。
  - **只信 `ctx.sessionManager.getSessionDir()`**——纯 pi 下它只指向**当前 cwd** 的子目录，跨项目检索（`find` 的核心价值之一）会丢一大片历史。记为「方案 C」。
- **证据**：`roots.ts:84`（现状）；`dist/main.js:530-533`（优先级链）；`session-manager.js:242-247,1179-1180`（默认 vs 覆盖两条路径）；`pi-paths.ts:105-107`（xyz-agent 侧 SSOT）；§4.2 三宿主实测表。
- **效果**：让 §2 目标 1 成立，并使 §5.2 的「自检行」有数据可打（没有候选根列表就没有自检）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **B：权威优先 + 候选根探测 + 来源标签** | 高——宿主换布局自动跟随，且失败可自证 | 中——新增 roots resolver + 触点接线 | 多扫 1–2 个目录（`[legacy]` 通常不存在，readdir 失败即空；量级探针见 §12.1 P-8） | ✅ |
| A：单点补 `<dirname(agentDir)>/sessions` | 低——同类失效会复发，无自证 | 极低（1 行） | 高——本次事故的全部不可诊断性原样保留 | ❌ |
| C：只信 `SessionManager.getSessionDir()` | 中——权威但视野窄 | 低 | 中——纯 pi 跨项目检索能力回退 | ❌ |

**被否若用**：若选 A，§5.2 那段错误信息只能退化成原文案换个词——因为没有候选根列表，打不出「自检」，「没有这条 session」和「根配错了」依旧无法区分，agent 仍会去 shell 搜盘。若选 C，纯 pi 用户把 `find{query:"某个别的项目的历史"}` 的命中率从「全库」降到「当前 cwd」。

### 6.2 环境判定：多信号合取 + evidence 附带

- **采用**：`detectEnvironment(signals)` 返回 `{ kind, distribution, dataDir, evidence[] }`。判定规则：
  - **托管（xyz-agent）** ⟺ `XYZ_AGENT_EXT_LOG === '1'` **且** `PI_CODING_AGENT_DIR` 的值匹配 xyz-agent 数据目录形态（B 前为 `<*>/.xyz-agent*/pi/agent`，**B 后为 `<*>/.xyz-agent*/agent`**——形态判据随 §6.10 落地同步更新，两种形态都接受以兼容迁移前后）。**两信号同时成立才判托管**——前者单独会被用户 shell 透传污染（`ENV_WHITELIST_PREFIXES` 含裸 `XYZ_`），后者单独会被裸 pi 用户的自设值污染，合取后误判面显著收窄。
  - **发行形态**：bundle 路径（`import.meta.url`）位于 `*.app/Contents/Resources/extensions/`（macOS）或对应 Windows/Linux 应用资源目录 → `packaged`；否则 `dev`。无法判定时为 `null`，不猜。
  - **`evidence[]` 恒输出**：把每条命中的信号原样列出，让 agent（和排障的人）能核对判定依据。
- **被否**：
  - 单信号判定 `XYZ_AGENT_EXT_LOG === '1'`——被 shell 透传击穿（§4.4 表）。
  - 在 `description` 里静态写死「本工具运行于 TaiJi.app」——同一份 extension 要同时服务两种宿主，写死必然对另一边错误。
- **证据**：§4.4 实测表；`constants.ts:74`（`XYZ_` 前缀在入站白名单）；`bundle-extensions.mjs:283`。
- **效果**：让 §2 目标 3 成立，且判定**可被证据推翻**而非黑盒断言。

### 6.3 新增 `doctor` action

- **采用**：新增 action `doctor`，输出 §5.1 那张表：环境判定 + evidence + 每个候选根（来源 / 路径 / 是否存在 / 文件数 / 扫描耗时）+ 诊断结论 + legacy 告警。
- **成本控制**：`doctor` 默认**不扫 subagent 根**（只列路径与「是否可扫」，不产文件数）——subagent 根在纯 pi 下有 2596 个文件，agent 可能在一次会话里反复问 `doctor`，重复全量扫盘不可接受；需要时显式传 `includeSubagents:true`。（v9.8 修订：原「对已扫过的根做根扫描缓存、重复调用不重扫」方案已删除——ext-simplify-04 U3 判定缓存保护的已是便宜化路径，每次实扫反而更实时；subagent 根默认不扫仍是主要成本控制手段，见 §7B 要点 8。）
- **被否**：把这些信息塞进现有 action 的错误信息里——只在失败时可见，且失败路径本就狭窄（§5.1 的常态查询看不到环境）。`doctor` 是**可主动询问**的。
- **证据**：现状 10 个 action（`index.ts:26-36`）无任何自检入口；事故中 agent 无法区分两类失败（§3.2 失败模式 C）。
- **效果**：让 §2 目标 3 成立；并给 §6.7 的「错误信息自检行」提供同一份数据的渲染源（**同一数据源两处渲染**，不重复实现探测）。

### 6.4 环境信息放 `doctor` + 错误信息，**不放** 工具 description

- **采用**：环境判定结果只在 `doctor` 输出与失败错误信息中出现。工具的**模型可见契约**仍会变，但变化最小化：`action` enum 增加 `'doctor'` 一个值 + `description` 里 action 列表补一词 + `promptGuidelines` 加一句「不确定环境时用 doctor」。其余文本不动；u12 search 跨会话用法三处 description 扩写（D-17③）与 doctor `includeSubagents` 参数为已登记增量。
- **代价诚实声明**：上述三处都是模型可见面，会**一次性**使 provider 的前缀缓存失效（本仓 `cache-probe` 的指纹键含 `guidelines` / `toolsSent` / `toolsReg`，见 `extensions/universal/cache-probe/src/fingerprint.ts:20-28`，会记一条 change 事件）。增量量级：新增一个 enum 值（约 10 字节）+ description 一词 + guideline 一句（约 120 字节），**一次性**，此后前缀稳定。**不**把「数据目录路径」这类按宿主变化的值放进 description——那会造成跨宿主前缀不稳定。
- **被否**：在 `description` 里动态插入「当前环境：TaiJi.app / 数据目录：…」。
- **证据**：`fingerprint.ts:20-28`；工具 description 属于系统提示词前缀。
- **效果**：环境可见性（目标 3）由 `doctor` 满足，同时把缓存代价从「每次变化」压到「一次性、约 130 字节」。

### 6.5 xyz-agent 侧：用 pi 自己的变量让 session 目录自描述（含继承面枚举）

> **状态（v5）**：本决策在 **B 先行路径下整体删除**（§6.13 收缩表）——布局对齐后 pi 默认派生即正确，无信息缺口。保留全文作为**被否谱系**与 **B 延期退路**（届时按本节原样执行）。其中「继承面枚举」「forward 登记义务」的分析方法在退路上仍然有效。

- **采用**：`packages/runtime/src/infra/pi/rpc-client.ts` 在 spawn pi 时，除现有 `--session-dir` 外**再注入 `PI_CODING_AGENT_SESSION_DIR = getSessionsDir()`**（经 `buildOutboundChildEnv` 的 `extras` 通道，遵守 C-proc-09 唯一构建点约束）。
- **为什么值得**：这是**在信息断点上修，而不是在消费端兜**。`--session-dir` 只存在于 pi 自己的 argv，env 才是**可被子进程继承**的自描述契约——任何未来的 pi-native 或第三方消费者（不只本 extension）都能直接读到。
- **forward 登记义务（C-proc-09 的另一半）**：`docs/design/env-propagation-boundary.md:215` 明确要求「pi 子树内的新 env 须在出站契约清单加 forward 条目并附消费锚点」。本设计必须同步改两处，缺一不可：
  1. `packages/shared/src/spawn-env-contract.ts` 的 `SPAWN_ENV_FORWARD_REFERENCE` 增一条（对齐既有 `PI_CODING_AGENT_DIR` 条目的写法，`spawn-env-contract.ts:150-158`）：`injectionPath` 写明 extras 通道，`piConsumerAnchors` 写 `dist/main.js:530-533` + 本 extension 的 `[env]` 信号。
  2. `docs/design/env-propagation-boundary.md` 的 B 组表同步。
  **为什么必须显式登记**：既有防线拦不住这个遗漏——`.githooks/check_spawn_env_boundary.py` 是**文件级**白名单（文件内出现构建器调用即整文件放行，`rpc-client.ts` 早已含 `buildOutboundChildEnv(`），`spawn-env-contract.test.ts` 只断言清单「含某几项」、无完整性断言。漏登记不会被任何机器拦截。
- **继承面枚举（此变量会传给谁、谁会受影响）**：

  | 继承者 | 是否自带 `--session-dir`（argv 优先，覆盖 env） | 影响 | 判定 |
  |---|---|---|---|
  | subagent-workflow 派生的 subagent pi | **是**（`packages/subagent-core/src/execution/engine/engines/pi/session-runner.ts:1149`） | 落盘位置不变。**该进程内 `[env]` 信号缺席**——subagent pi 的 env 是 runtime 进程 env 的整体继承（`session-runner.ts:1764` `{ ...process.env }`，subagent-core 是 runtime 的 workspace 依赖），U4 的 extras 只进主会话 pi 子进程、不进 runtime 自身 env → 主根在 subagent pi 内只会以 **`[legacy]`**（`dirname(agentDir)/sessions` = `<dataDir>/pi/sessions`）形态出现，`[live]` 指向 subagent 目录 | 可接受：`[legacy]` 恰好兜住主根（再次印证 §6.1 该信号的必要性）；`doctor` 按 kind 标注即可区分。**若要 subagent pi 也拿到 `[env]`，属 U4 范围扩展**（改 `session-runner.ts` 的 `buildChildEnv`），须另行登记并过 C-proc-09 评审——本设计默认不做 |
  | agent 通过 bash 工具派生的任意 `pi` 调用 | **否**（取决于用户命令） | 会把新 session 写进 `<dataDir>/pi/sessions`，**注入 TaiJi 的主 session 列表** | **已接受的代价**，见下 |
  | relay / 其他 runtime 派生链 | **是**（已核，第 2 轮复审补充证据：`session-runner.ts:1149` userArgs 恒带 → `relay.mjs:163` 握手帧 argv 原样透传 → `relay-registry.ts:374` 按帧 argv spawn） | 与第一行同分类：落盘位置不变，但该进程内 `[env]` 信号同样错位指向主根（握手帧 `env: {...process.env}` 原样上送，`buildOutboundChildEnv` 不剥此变量） | 可接受，同第一行 |

  **对 bash 派生类的量化与恢复通道**：AGENTS.md 规定的本地实测命令**总是带** `--session-dir`，故正常工作流不触发；触发面限定为「agent 自行发起的不带 `--session-dir` 的裸 pi 调用」。后果是**多出若干落错位置的 session 文件**（只增不删，无静默覆盖）。恢复通道 = 用 `session_read{action:"doctor"}` 发现多余根后**人工 `rm`**（doctor 的根文件列表即工作清单）。**没有机器兜底**：runtime 的 reap 只杀孤儿 pi **进程**、不处理 session **文件**（`reap-orphan-pi.ts:10-27`，判据是 argv 含 `--session-dir` + ppid=1），且 pi 侧无自动 GC（`docs/pi-semantics.json` PS-19 在案）。**重审触发条件**：若实施后发现该面被高频触发（`doctor` 显示 `<dataDir>/pi/sessions` 出现明显非 app 来源的 session），回改本决策，改为只在 env 里放一个**只读**的提示变量（如 `XYZ_PI_SESSION_DIR_HINT`），不占用 pi 的权威变量名。
- **被否**：只改 session-reader 探测（不做宿主侧声明）——能修好本次问题，但断点仍在，任何新消费者都要重走一遍猜测。
- **证据**：`dist/main.js:530-533`（pi 读取 `ENV_SESSION_DIR`，优先级仅次于 `--session-dir`）；`dist/config.js:406`（变量名）；`rpc-client.ts:200`（既有 `PI_CODING_AGENT_DIR` 注入先例）；`spawn-env-contract.ts:150-158`（forward 条目范式）；`env-propagation-boundary.md:215`（登记义务）。
- **效果**：让 §6.1 的 `[env]` 信号长期可靠；即使 session-reader 的 `[live]` 探针因 pi 升级失效，`[env]` 仍在。
- **验收**：主探针 = 会话内 bash `env` 自读（P-3/P-5；`ps eww` 仅 best-effort，见 §12.1 的 SIP 在案否决）；subagent pi 内 `doctor` 的判定为「`[live]` 标注为 subagent 根、主根以 `[legacy]` 形态出现（`[env]` 缺席）」（§8 V7③）。

### 6.6 主 session 元数据：`SessionManager.listAll`，但**惰性 + 窄化 + 缓存**（选定）

- **采用**：`find` 的元数据层（标题 `name` / cwd / 首消息预览）用 pi 的 `SessionManager.listAll(dir)`——它返回 `SessionInfo[]`，字段含 `path / id / cwd / name / parentSessionPath / created / modified / messageCount / firstMessage / allMessagesText`（`dist/core/session-manager.d.ts:125-138`），`name` 即 `session_info` entry 的用户标题。注入方式：`index.ts` 构造 `metadataProvider` 回调传入 handler，**发现层保持零 pi 依赖**（与 §6.2 信号包同一注入范式）。
- **必须先写清这个 API 的两条实装语义（本设计的选型前提即建立在其上）**：
  1. **`listAll(dir)` 只扫一层、不递归**——带 `dir` 的分支走 `listSessionsFromDir`（`dist/core/session-manager.js:550-556`），`readdir(dir)` 后直接 filter `.jsonl`。对照三宿主布局：xyz-agent 主根 14 文件**平铺** → 能全部拿到；纯 pi `[default]`/`[live]` 的 4619 文件全部在 `<encodeCwd>/` 子目录 → **`listAll(根)` 返回 0 条**。pi 自己的无参分支才是两层枚举（`session-manager.js:1306-1318`）。所以 `listAll(dir)` 的真实语义是「扫一个**平铺目录**」，不是「扫一个根」。
  2. **每次调用 = 全量解析该目录全部文件**——`buildSessionInfo`（`session-manager.js:443-511`）`for await` 读到 EOF、无 break，顺带收集 `allMessagesText` / `messageCount` / 时间戳。成本是 O(目录总字节) 而非 O(文件数)：本仓自有实测「全盘 3488 项 ≈ 8s」（`hash-provider.ts:161`）、单 cwd 目录 530 文件 667ms（`docs/2026-08-10-cwd-popup-redesign.md:190`）。**「19ms vs 1500ms」的既有记录（`index.ts:203`）语境是单个 per-cwd 小目录，不可外推到根目录。**
- **由此定调用策略（三条，缺一会退化成秒级卡顿）**：
  1. **惰性触发**：仅在「uuid 精确匹配 = 0 **且** uuid 归一化匹配 = 0 **且** query 非纯 hex（即 keyword 路径）」时才调 `listAll`。uuid / recent 路径不调（recent 只对 limit 截断后的少数候选补元数据）。
  2. **窄化目标**：只对**平铺目录**调用——即「未做 encodeCwd 剥层的 `liveSessionDir` 本身」（xyz-agent 下即主根，平铺；纯 pi 下即当前 cwd 的目录，小）+ 扫描结果**无子目录**的候选根。**含子目录的根跳过 listAll，但其中的候选不退出 keyword 匹配**：这些候选回退现状 `readFirstUserMessageText` 路径做首条 user 匹配（现状 `matchByKeywords` 本就对全部候选深读首条 user，回退即成本与召回均无变化）；被跳过的只是「标题检索」这一**增量**能力（对含子目录的根做标题检索需枚举全部 encodeCwd 子目录 × 全量解析，成本不可接受）。`liveSessionDir` 缺失时同理全部回退。——**§2 目标 4 的范围限定只针对标题维度；首条 user 维度的现状能力不收缩**（否则纯 pi 跨项目「按首条 user 内容找 session」会被静默砍掉，main session 无 manifest、首条 user 是其唯一 keyword 匹配键）。
  3. **进程内 TTL 缓存**（keyed by 目录路径；秒级 TTL / 目录 mtime 失效）：标题数据变更低频，重复 keyword 查询不重复全量解析。
- **降级路径**：`metadataProvider` 注入失败 / 调用抛错（单目录 try/catch，记空并继续）→ 回退现有 `readFirstUserMessageText`（只读首条 user，命中即停），**标题字段留空**。降级只损失「标题检索」，不损失「能找到 session」。
- **为什么仍优于自写深读**：自写「顺带解析 `session_info`」同样必须读全文件才能证明不存在（实测某 23MB 主 session 中 `session_info` 在第 31 行；xyz-agent 14 个主 session 中 3 个无 `session_info`，须读到 EOF），纯 pi 全库最坏 ≈ 2.7GB（放大约 170 倍，P-9）。`listAll` 的全量解析是**同样的输入、但由 pi 维护且有并发封装**（`buildSessionInfosWithConcurrency`），且配合上面的惰性 + 窄化 + 缓存后，实际触发面被压到「小目录 + 低频」。
- **被否**：
  - 自写 `session_info` 深读——成本被实测否决（P-9），且重复实现 pi 已有的并发解析。
  - 只靠首条 user message 预览匹配——事故反例：`01a08a6e-0d26` 与 `01a08a6e-74fc` 的首条消息可能都是「帮我分析下这只股票」，无法区分标的；标题「福耀玻璃深度研究」/「太保寿险深度研究攻坚」可区分。
  - 「用 `listAll` 做全库标题索引」——被实装语义否决（平铺一层 + 全量解析），纯 pi 不可行。
- **证据**：`session-manager.js:443-511,550-556,1292-1325`；`session-manager.d.ts:125-138,353-354`；本仓 `hash-provider.ts:2,139,157-159,161`（用法先例 + 空参灾难分支 + 两条实测耗时）+ `index.ts:203`（19ms 语境）；`docs/2026-08-10-cwd-popup-redesign.md:190`（667ms/530 文件）；标题覆盖率实测 10/14（P-4 注）。
- **效果**：让 §2 目标 4 在「当前宿主会话根」范围内成立（纯 pi 跨项目标题检索显式列为不覆盖，见调用策略 2）。

### 6.7 `find` 匹配与输出：归一化 + 分组 + 全 id

- **采用**，三个子决策：
  1. **uuid 归一化匹配（修 §3.3 的两个盲区）**：uuid 片段匹配改两级（**回退关系**：精确层零命中才进入归一化层，两层层间互斥而非合并排序——实施期澄清，避免归一化变体混入精确命中）；第一级为现状的精确子串（`sessionId.includes(query)`）；第二级对**归一化形态**再比一次：`norm(s) = s.toLowerCase().replace(/-/g, '')`，`norm(sessionId).includes(norm(query))`。`looksLikeUuidFragment` 同步用 `norm(query)` 判定。这样**大写 uuid、去连字符 uuid** 都能命中，且不会因为「像 uuid 片段」而错误跳过关键词回退。
  2. **结果按 `source` 分组，main 段置顶**：实测 `find{query:"福耀玻璃"}` 命中 **1 main + 14 subagent**，且 subagent 的 mtime 晚于主 session，按现有 mtime 倒序会把主 session 挤到后面。**精确规格**：
     - `limit` 作用于**分组后的合并列表**：main 段优先占满（上限 `limit`），剩余配额给 subagent 段；main 命中 > `limit` 时 subagent 段为 0 条、仅显示计数；
     - `truncated` 按**合并总量**（命中总数 vs 实际输出数）计算，不按单组；
     - subagent 段超出剩余配额时**折叠为计数行**并提示「加 source:"subagent" 查看」；
     - **解析路径不受分组影响**：`resolveByFragment`（outline/family 等全部按 id action 的入口）用独立的无分组查询，语义保持现状（mtime 排序 + limit 截断）——分组只是 `find` 的**展示层**规则，不是匹配层规则。
  3. **输出全 id + 可直接复制的调用串**：`find` / F1 候选行打印**完整 sessionId**，并附一条可直接复制执行的 `session_read{action:"outline", session:"<完整 id>"}`。
- **`SESSION_ID_PREFIX_LEN` 的改动范围声明**：该常量还被 `result` action 复用（`tool-handler.ts:1559` → `result-action.ts:46,238` 注入批量头行渲染），且测试 `execution-tree.test.ts:747` 对 8 字符截断有断言。本设计**只改 `formatFindContent` 与 `formatNoMatch` 两处渲染**，**不动** `result` 通路与常量本身——`result` 的批量输出里短 id 足够（每项已带完整正文指针）。
- **被否**：
  - 保持 8 字符截断「省 token」——事故反例：agent 拿到 `01a08aac…` 无法粘回做精确调用，只能改去 shell `ls`（§3.2 失败模式 D）。
  - 只加归一化不改分组——「说人话就能找到」会在 15 条 subagent 噪声里退化（实测 §12.1 P-4 注）。
- **证据**：`find.ts:156-158,375-377`（现状匹配）；`tool-handler.ts:379,434,386,1559`（截断常量与两处消费）；`result-action.ts:46,238`（`result` 通路的独立消费）。
- **效果**：让 §2 目标 1/2/4 成立；切断「输出不可复制 → 转向 shell」这条动机链。

### 6.8 `family` / `export{format:"family"}` 必须接入同一根列表（本设计新增的范围）

> **状态（v9.7）**：B 先行路径下 `collectMainSessions` 不换根列表（§6.13 收缩——布局对齐后 `listMainSessions(agentDir)` 恒正确），退路时按本节原样执行；not-found 文案改列实际候选根两种路径都做（并入 U1，见 §10 U7 行）。

- **采用**：`subagents.ts:99 collectMainSessions(agentDir)` 改为从 `resolveSessionRoots(signals)` 取 main 文件列表（签名从 `agentDir: string` 换成 `signals`，与 §6.1 同一信号包）。`subagents.ts:55` 起的 not-found 错误文案同步改为列出**实际扫描过的候选根**，而不是写死 `<agentDir>/sessions`。
- **只改 main 腿，另两条腿明确不改**：`buildFamilyFromFs` 有三条数据腿——main（本决策改）、subagent identities（`subagents.ts:156 listSubagentSessions`）、record manifests（`listRecordManifests`）。后两条都从 `<agentDir>/subagents` 推导，**两宿主下均正确**（实测 1330 / 2596，§4.2），不修不坏，维持现状。
- **为什么必须在本次做**：不改的话，修复后链路是——`find{uuid}` 命中主 session（§5.1 的终态）→ agent 顺理成章追问家族关系 → `family{同一 uuid}` → `buildFamilyFromFs` 仍只索引 `<agentDir>/sessions`（xyz-agent 下仅 2 个迁移残留）→ `core/family.ts:263 resolveFamily` 抛 `session "…" not found under …/agent/sessions`。**实测已复现**（§12.1 P-2 注）。修前是「F1 无匹配 + 👉」，修后变成「无恢复指引的内部错误，且提示把 agent 推回明明能找到它的 `findSessions`」——**比修前更差**，且直接违反 §2 目标 1。
- **被否**：只修 `findSessions`、把 family 登记为已知限制——10 个 action 里 2 条路径（`family`、`export format=family`）对 xyz-agent 下 14/14 个当前主 session 全部不可达，这不是可接受的残留。
- **证据**：`subagents.ts:63-68,98-99`；`tool-handler.ts:707,882`；`core/family.ts:263`；§12.1 P-2。
- **效果**：让 §2 目标 1 的「全 action」成立；消除「find 说有、family 说没有」的自相矛盾。
- **注**：`recursive:true` 的执行树路径（`execution-tree.ts`）只需 `resolved.fileName` + manifest，不依赖 main 根扫描，**无需改**；若不改 `subagents.ts`，`family` 与 `family{recursive:true}` 会行为分裂（一个抛错一个可用），这也是必须改的理由之一。

### 6.9 双仓漂移：session-reader 的三个副本与同步方案（v9 起纳入执行范围，M5 交付）

**一份代码、三个副本**（2026-09-10 实测核实；「漂移」= 三副本在各自 fork/发布时刻相同，此后独立演化、互不同步）：

| 副本 | 位置与身份 | 版本 | 谁在用它 |
|---|---|---|---|
| ① 本仓 extension（**权威源**） | `extensions/universal/session-reader/`，打进 TaiJi.app，npm 发布名 `@zhushanwen/pi-session-reader`（registry 已发至 0.4.0） | 0.4.0 | TaiJi.app / xyz-agent 内的 agent |
| ② 纯 pi 装机副本 | `~/.pi/agent/npm/node_modules/@zhushanwen/pi-session-reader/`——由 `~/.pi/agent/settings.json` 的 `packages` 条目 `npm:@zhushanwen/pi-session-reader`（**无版本约束**）安装 | **0.2.4**（装机实测；registry 已 0.4.0） | 用户**不经 xyz-agent、直接跑裸 `pi`** 时加载 |
| ③ CLI 派生仓 | `~/Code/pi-session-reader/`：`@zhushanwen/pi-session-reader-cli@0.1.0` 且 `"private": true`，不发布 npm（**不可能**是 0.2.4 的发布源）；2026-09-09 自本仓 `135c1dbab` 平移（`LINEAGE.md §1`） | 0.1.0 | 全局 skill `~/.agents/skills/pi-session-reader`（symlink 指向它）——zcode 等**非 pi agent** 经 skill 的 `session_read{…} ≡ pi-session-reader <cmd>` 一对一映射表（`SKILL.md:63-70`，写死「10 个 action」）调用 |

**漂移的现状**：本次修复只落副本①；副本②③的 `src/discovery/roots.ts:84` 实测与本仓旧版逐字相同（带同一 bug）；本设计新增 `doctor` 后，副本③的 skill 计数（10 ≠ 11）与映射表（缺 doctor 行，CLI 亦无该子命令）也漂移——非 pi agent 读到 `session_read{action:"doctor"}` 指针行将无法映射。

**为什么有实际影响（非理论洁癖）**：

- 副本②的 bug 会真实触发：AGENTS.md 规范的本地实测命令就是 `pi --mode rpc --session-dir <dir> …`——只要带 `--session-dir`，session 就不在 `<agentDir>/sessions` 默认位置，同一 bug 在**纯 pi 环境**同样复现。本 bug 从来不限 TaiJi 宿主。
- **修复到不了装机**：pi 对 `packages` 条目不自动升级（装机实测停 0.2.4 而 registry 已 0.4.0）——**只发版不更新装机，纯 pi 侧永远用旧版**，修复等于没修。
- 副本③影响所有走 skill 的非 pi agent（映射表查不到 doctor 对应命令）。

**处理（v9：U13 由「登记待办」升级为执行单元，M5 阶段交付，时机 = 本修复随 merge 发布时）**：

1. **npm 发版**：修复随本仓正常 changeset → merge 流程发版（仓库纪律禁止本地 `changeset publish`）——修复的唯一来源是副本①，**不是**改 CLI 仓。
2. **触发纯 pi 侧更新**：merge 后执行 `pi update @zhushanwen/pi-session-reader`（`pi update --help` 实测：`pi update <source>` 单包更新到最新；`--extension <source>` 等价短形态）。跳过此步则 ① 白发。
3. **CLI 仓（副本③）跟进**：以修复后的本仓为基线**重平移**——v9.1 精确化（CLI 仓自 2026-09-09 平移后已有 15+ 本地 commit 独立演化：new-write 命令层、parser/LINEAGE 治理、skill 创建与重构）：**双向 diff 对照**——CLI 仓本地演化**保留**，仅把本仓修复面文件（`src/discovery/roots.ts` 及发现层相关）的 diff 移植过去；同文件双侧都演化时逐 hunk 裁决（CLI 侧命令层/测试改动保留，本仓 discovery 修复面移植）。并实现 `doctor` 子命令（skill 映射表的等价 CLI 面，输出判定语义见 V11④）。`LINEAGE.md` 的基线 commit 与日期随重平移更新（其自带的同步义务声明）。
4. **skill 同步**：`~/Code/pi-session-reader/skills/pi-session-reader/SKILL.md` 的 action 计数 10 → 11、映射表补 `doctor` 行（注意其「只读保证」段落一致性——doctor 也是只读）。
5. **发布说明写迁移指引**（v9.1，U14b 的用户可见通道）：App 发版 notes 写明「升级前先关闭应用并运行 `scripts/migrate-pi-layout-v2.mjs`」——启动 WARN 仅日志通道，发布说明是「先迁后升」推荐时序面向用户的载体。

验收 V11（§8.2）。

### 6.10 方案 B：布局完整对齐现版 pi（选定，先行）

- **采用**：三步布局变更，对齐后 xyz-agent 与 pi **唯一**差异是根目录：
  1. `PI_CODING_AGENT_DIR` 改指 `<dataDir>/agent`（即 `getPiAgentDir()` 改为 `join(getDataDir(), 'agent')`，`pi/` 层退役为备份）；
  2. **删除 `--session-dir` spawn 参数**——pi 走默认派生 `join(agentDir,'sessions')`，且按 cwd 自动分 `<encodeCwd>/` 子目录（`session-manager.js:242-247`）；
  3. `getSessionsDir()` 改为 `join(getPiAgentDir(),'sessions')`（对齐 pi 的 `dist/config.js:456`），subagents/workflow-state 等全部从 agentDir 派生的路径**自动跟随**。
- **为什么这是根修**：本 bug 的本质是「消费端按 pi 默认布局派生，宿主却覆盖了它」（§4.1 信息不对称）。方案 A 治的是「让消费端拿到覆盖信息」，方案 B 治的是「**取消覆盖**」——对齐后不存在信息不对称这个类别：pi 的默认派生对所有消费者（session-reader、family、任何未来 extension、甚至用户的裸 pi 工具链）都是对的。pi 未来再演进布局（如再度调整 sessions 位置），xyz-agent 零改动自动跟随——这类 bug **绝根**。
- **用户拍板记录**：目标形态 = 「完整对齐 pi，只是根目录不同，一个 `~/.pi/` 一个 `~/.xyz-agent/`」（2026-09-10 会话）。
- **被否**：
  - **B2（路径对齐但保留 `--session-dir`，指到 `<agentDir>/sessions`）**——保留 reap 判据、迁移最简（平铺→平铺）、消费方零改动，但文件保持平铺、argv 仍带覆盖位，「对齐」只对齐了路径没对齐机制；pi 布局再演进时 B2 不跟随（显式 `--session-dir` 抑制 encodeCwd，`session-manager.js:1179-1180`），根修效果减半。**若 B1 的 reap 判据（§6.12）实施受阻，B2 是降级退路**。
  - **维持现状 + 只做方案 A**——能修好本 bug，但「宿主覆盖 vs 消费端派生」的结构性张力永久存在，每个新消费者都要重走一遍发现层。
- **证据**：§1.3 沿革表；`dist/config.js:456`（pi 现版 getSessionsDir）；`session-manager.js:242-247`（默认 encodeCwd）；`77f006420` commit message（pi/ 层的镜像意图）；本机 `~/.pi/` 实测（家级 sessions 为空残壳）。
- **效果**：让 §2 目标 6 成立；并使 §6.8（family 专项修复）与 §6.5（env 注入）**整体不再需要**（见 §6.13）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **B1：完整对齐（去 `--session-dir` + agent 上移 + 迁移）** | 高——派生构造性成立，bug 绝根，跟随 pi 演进 | 中——一次性手工迁移脚本 + 启动残留探测 + reap 判据替换 + 消费方清扫 | 数据迁移（手工脚本，有备份兜底，§6.11）；reap 换判据（§6.12） | ✅ |
| B2：路径对齐但保留 `--session-dir` | 中——机制未对齐，不跟随 pi 演进 | 低——纯 move，reap 不动 | 低 | ❌（降级退路） |
| 维持现状 + 方案 A | 低——结构性张力永存 | 低 | 每个新消费者复发 | ❌ |

**被否若用（B2）**：§5.3 的目录树里 sessions 仍是平铺，`doctor` 会永远显示「live 根 = 显式覆盖」，且 pi 下次布局演进时 xyz-agent 又要手动跟随——B2 修的是这一次的症状，B1 修的是这一类。

### 6.11 一次性手工迁移 + 启动残留探测（方案 B 的交付物之一；v9 由「首启自动迁移」收缩）

- **决策变更（v9）**：v5–v8 的设计是「首启自动迁移 + 四守卫状态机（0a 续传 / 0b 已迁移 / 0c 全新 / 0d 降级回装）」。用户确认**项目当前无外部用户**（2026-09-10）——需要迁移的机器集合是封闭的（= 本机 prod `~/.xyz-agent` 与 dev `~/.xyz-agent-dev` 两个数据目录，主 session 2026-09-10 复测 9 + 36 个），自动迁移对未来所有新装机是**永不触发的死代码**，却要永远维护其崩溃续传矩阵。收缩为：**一次性手工迁移脚本（U14a）+ 启动残留探测告警（U14b）**。
- **前提显式声明**：本方案成立依赖「B 落地前无外部存量用户」（用户确认，2026-09-10）。日后若有新分发，新装机直接新布局（全新安装形态），前提不被打破；若出现**未知的**存量机（理论上不存在），启动残留探测会告警并指引人工迁移。
- **采用（U14a）**：新增 `scripts/migrate-pi-layout-v2.mjs`（随仓提交留档，`node` 直接运行；**不在 app 启动路径**），对 `<dataDir>` 逐个执行——本机即对 `~/.xyz-agent` 与 `~/.xyz-agent-dev` 各跑一次。**推荐时序 = 先迁后升**（关闭应用 → 跑脚本 → 安装/启动新版；此序下 `<dataDir>/agent` 尚不存在，步骤 2 走整体 rename 的干净路径）；**先升后迁**（先装新版、收到 WARN 后再迁）是合法兜底时序，由步骤 2b 并道分支处理。流程（每步幂等，失败即人工可见、修因后重跑安全）：

  ```text
  0. 前置检查（fail-fast，按序）：
     a. 实参形态校验：<dataDir> basename 匹配 .xyz-agent* 且 <dataDir>/pi 下**含**
        agent/ 或 sessions/ 子目录（存在性判据而非「仅含」——dev 实测 pi/ 顶层另有
        空壳残片文件，见证据行；续传模式下 pi/ 不存在，形态判据自然跳过、仅
        basename 校验生效）——不匹配即中止，防误传资源布局目录
        （如 apps/electron/resources/pi）被 rename 破坏打包资源
     b. 运行中进程检测（pgrep -f 固定模式清单：pi 二进制路径形态、relay.mjs、TaiJi.app、
        runtime node 入口；模式清单随报告打印，脚本自证本机 pi 二进制路径命中清单才继续，
        §11.13）——命中则中止并列出 PID。无运行进程 = 无「孤儿持旧路径 fd 写备份目录」的
        竞态，替代 v7 的前置 reap 双候选
     c. 目标形态三判：
        · <dataDir>/pi 存在                 → 首迁或降级增量，往下走（步骤 1）
        · pi 不存在且无 pi.backup-v2-*/    → 打印「无需迁移」退出（全新安装形态）
        · pi 不存在但存在 pi.backup-v2-*/  → 续传模式（v9.1：上次迁移中断——备份即暂存，
          跳过步骤 1，步骤 2-4 对**备份名内嵌 ts 最大**的一份幂等重入，「目标已存在跳过」
          天然去重（v9.2 判据：备份名自带创建序时间戳，是一手数据源——mtime 判据依赖
          「rename 不改 mtime / 降级回装必经重建」等隐式推演链且对同秒粒度无防御，弃用）；
          多份备份在报告注明。堵住 v9 初版「见 pi 不存在即退出」把中断态误判为
          已完成、剩余数据永滞备份的缝隙——该缝隙曾使「重跑安全」声明失效）
  1. rename(<dataDir>/pi, <dataDir>/pi.backup-v2-<ts>)   ← 原子；此后旧路径不再被任何代码
                                                          读写；备份即暂存，不再二次改名；
                                                          续传模式跳过本步
  2. agent 上移（两条路径择一；记录型子树一律文件级并入）：
     a. agent/ 不存在（先迁后升，推荐时序）：
        rename(pi.backup-v2-<ts>/agent, <dataDir>/agent)  ← 配置域整体上移（models/settings/
        auth/subagents/workflow-state/config/…全带走，含 pi/agent/sessions/ 的 encodeCwd
        残留——相对位置在新布局下恰好正确）
     b. agent/ 已存在（先升后迁：新版启动过、agent/ 含窗口期增量）：
        逐项搬移 pi.backup-v2-<ts>/agent/* → <dataDir>/agent/，按域分三种规则：
          · 记录型子树（sessions/ subagents/ workflow-state/）：逐子目录逐文件并入
            （uuid/manifest 命名，同名跳过并计数，含 encodeCwd 同名子目录内部合并）——
            subagent session 与 records manifest 同为 uuid 命名，文件级合并不丢窗口期增量
          · provider 三件套（auth.json 凭据 / models.json 自定义 provider 定义 /
            config/providers.json xyz 侧扩展）——**keyed-by-providerId 逐 key union**
            （v9.2 方向，v9.3 按实机形态锚定 keyed 域）。三件的 keyed 域**路径不同**
            （§12.3 实测）：auth.json = **顶层**；models.json = **`.providers`** 一层之下
            （顶层单键嵌套）；providers.json = **`.providers`** 一层之下（顶层另有
            `version:int` / `scopedModels:list` 非域键）。union 规则：域内逐 key——
            key 只在一侧 → 取该侧；双侧都有（窗口期换 key 场景）→ 新赢（凭据时效）；
            **域外伴随字段**（providers.json 的 version/scopedModels、models.json
            未来新增顶层键）→ **取新侧**并进冲突清单（第 10 轮裁决：运行时是新版
            代码在读该文件，新侧伴随字段与其 schema 自洽；影面审曾建议旧赢，被
            「version 旧赢可能使新版代码读到过期 schema 号」否决。**源码依据**
            （§12.3 实测核证）：providers.json 的唯一读写方 `provider-extras-store.ts:24`
            注释「version 留未来迁移钩子，当前恒 1」，写侧恒写 1、读侧对 version 的
            唯一消费是合法性校验（≠1 → `quarantineCorruptFile` 整文件隔离重置，
            `:143-147`）——当前两侧恒同值、取侧等价；未来启用 v2 后新侧值更可能
            正确，且读侧 quarantine 是现成兜底（providers extras 属可重建状态，
            失配面有界）。scopedModels 等 list 字段取新侧不做并集——并集对覆盖型
            条目有语义风险）。**防御式降级
            （按健康侧选向，第 10 轮修正）**：任一侧 JSON 解析失败、域路径解析不到、
            域内值或伴随字段非预期形态（非 object / 非 number 等，pi 未来改 schema）→
            该文件整体取**健康一侧**
            （旧侧坏 → 新赢；新侧坏 → 旧赢；双侧坏 → 不动 + 报告人工处理，不产
            坏数据主位）并进冲突清单——v9.2 初版「一律旧赢 + 新避让」在旧侧坏时
            自相矛盾（把坏文件赢进主位），被第 10 轮主审击穿。
            **写回原子性**（v9.3）：union 结果 tmp+rename 原子写目标路径（对齐 §6.12
            spawn 清单的写语义——写一半崩溃不损坏目标）；旧侧完整文件天然留在备份
            目录、不产中间态文件。理由（第 8 轮主审反例 + 第 9 轮影面审锚点修正）：
            v9.1 把三件套拆到相反方向后，窗口期新增自定义 provider 产生「定义在凭据
            不在」交叉失配；v9.2 初版「三件同为顶层 keyed map」的前提与实机不符
            （仅 auth.json 成立）——按字面实施时 models.json 唯一顶层键 providers 整体
            新赢（交叉失配复活）、providers.json 恒定触发降级（union 从未生效），故
            锚定各文件真实域路径。独立凭据文件（token* 等，无跨文件联动）维持新赢
            旧避让（旧侧 `*.old-v2-aside`）
          · 其余单文件配置（settings.json 等）与资源型目录：旧赢、新避让
            （新侧改名为 <name>.new-v2-aside）——数月累积定制的损失面大于窗口期增量；
            资源型目录（npm/ extensions/ tmp/）目标存在即跳过（双侧皆为生成物）
          全部冲突（无论方向）逐文件进迁移报告「冲突清单」，keyed union 的逐 key 冲突
          也进清单（「provider X 取新侧凭据」）；附核对指引（哪些用旧/哪些用新、避让文件
          在哪；迁移后鉴权异常或 provider 列表缺项，先查三件套的 aside 与冲突清单）
  3. 分发主 session：递归遍历 pi.backup-v2-<ts>/sessions/ 下每个 .jsonl
     （平铺层 + 既有 encodeCwd 形态子目录，dev 实测存在 --private-tmp--/ 目录）：
     读首行 header（type==='session'）→ cwd = header.cwd
       ├─ 有 cwd  → 目标 agent/sessions/<encodeCwd(cwd)>/<basename>
       └─ 无/坏头 → 目标 agent/sessions/_migrated-no-cwd/<basename>   ← pi 的 listAll 与本工具的
                                                                        scanJsonlRecursive 都按
                                                                        「任意子目录」枚举，可被发现
     sidecar 随行：匹配规则 = <basename>. 前缀的全部兄弟文件（前缀匹配而非枚举后缀白名单——
       实测除 .model/.project/.meta/.preset.json 外还有 .handoff.json 等仓内功能 sidecar，白名单必漏）
     目标已存在同名（理论不冲突，文件名含 uuid）→ 跳过并计数
  4. 兼并更早布局：若 <dataDir>/sessions 存在（77f006420 之前的旧旧布局）→ 同 3 分发
  5. 校验并清除 agent/settings.json 的 sessionDir 字段（pi 优先级链第 3 位的静默覆盖位；
     有则删除并打印——不清除则任何写入者都能让「默认派生」静默失效）
  6. 打印迁移报告（分发/跳过/避让计数 + 备份路径 + 回滚命令 = 删或改名 agent/ +
     pi.backup-v2-<ts> 改回 pi；附「冲突清单」与「顶层残片清单」——pi/ 顶层不在
     agent/ sessions/ 内的文件（dev 实测有 2B 空壳 auth.json/models-store.json 等，
     真身在 agent/ 同名文件）不迁移、留在备份，报告列出供人工确认可忽略；
     检测到**本次之前的旧 pi.backup-v2-*** 时列出各份规模（文件数/字节数）并提示
     核对残部——「中断→降级回装→再升→重跑」复合态下旧残部备份不被任何分支消费
     （续传只在 pi 不存在时触发），报告是唯一区分信号，第 8 轮主审 SG）
  ```

- **采用（U14b）启动残留探测**：runtime 启动处（原 `migrateToPiSubdir()` 调用位，`runtime/src/index.ts:194`）若 `<dataDir>/pi` 存在**且其下含 `agent/` 或 `sessions/` 子目录**（v9.2 与 doctor 同判据——防「pi/ 存在但无该形态」时 WARN 指引跑脚本、脚本 0a 形态校验拒跑的理论死锁）→ 记 WARN 日志：「检测到旧布局 `<dataDir>/pi`，历史会话不在新布局中、不可见；关闭应用后运行 `scripts/migrate-pi-layout-v2.mjs` 迁移」。约 5 行，替代整个守卫矩阵，统一兜住三种残留态：「忘了迁」「出现未知存量机」「降级回装旧版重建 `pi/`」——同一探测入口，同一指引。doctor（U8）以**独立 glob 规则**（`pi.backup-v2-*/` 备份与未迁移的 `pi/`，均不在 `[legacy]` 推导式内——`dirname(agentDir)/sessions` 够不到带时间戳的备份名与 `pi/` 层）探测并标注，附同一迁移指引。**判据收紧（v9.1）**：doctor 侧 glob 基点 = `dirname(agentDir)`（xyz-agent 下 = `<dataDir>`，纯 pi 下 = `~/.pi`），且 `pi/` 须同时满足「其下含 `agent/` 或 `sessions/` 子目录」才告警——防纯 pi 宿主下任意来源的 `~/.pi/pi/` 目录误报；备份 glob 同基点同形态判据。**窗口期双面失明（已接受代价，v9.1 显式声明）**：「先升后迁」窗口内，旧主 session 对 session-reader 候选根与 TaiJi 会话列表**双面**不可见（两者都只扫新布局）；WARN 仅落 runtime 日志（TaiJi 界面无弹窗）。缓解 = 推荐时序「先迁后升」写入发布说明（§6.9 处理 5）+ doctor 可主动查；消除 = 迁移完成。量级 = 窗口时长 × 用户迁移拖延度，数据无损（旧文件在 `pi/` 原处不动）。**重审触发条件（v9.2 补第四要素）**：若发版后 doctor 探测显示未迁移残留普遍持续超周级（说明日志通道 + 发布说明不足以驱动迁移），将 WARN 升级为 TaiJi 启动时用户可见提示（renderer 侧改造，届时另行登记）。
- **既有函数处置（沿 v7 拆分决策，挂点简化）**：`migrateToPiSubdir()` 的目录迁移段退役（其 `<configDir>/sessions → pi/sessions` 迁移使命终结，无预兆 `mkdirSync` 前置段随之消亡——v6 撞名反例的根源）；`isPackaged()` bundled 同步段保留为独立 `syncBundledResources()`，**直挂 runtime 启动**（v7 挂 aligned 迁移入口，v9 迁移组件移出启动路径后回归启动直挂）——它是全仓唯一 bundled skills 同步点（`pi-maintenance.ts:107-126`，同步 `skills → <agentDir>/skills` 与 `extensions → getExtensionsDir()`），打包版全新安装依赖。（影面审登记：退役段实测还含 `pi/agent/{extensions,npm,tmp}` → dataDir 根层迁出——B 后这类残留若存在将随 `agent/` 整体上移躺在新位置、不被任何代码读取，无探测、低损失，与 `<dataDir>/sessions` 旧旧布局同类登记为已接受残留。）
- **关键设计点**：
  1. **备份即暂存，一步到位**——步骤 1 直接把 `pi/` 原子改名为 `pi.backup-v2-<ts>/`（此后旧路径不再被任何代码读写），分发直接从备份目录读。不做 copy-then-delete（双倍 IO 且留中间态）；不做 v5–v8 的「暂存目录 + 完成标记 + 二次改名」——那是自动迁移崩溃续传的设施，手工脚本的等价物 = 失败即人工可见 + **步骤 0c 续传分支** + 全程幂等重入（v9.1 收口：v9 初版把「重跑安全」寄望于各步幂等，但出口判据排在全部幂等步骤之前——步骤 1 后中断的重跑被「无需迁移」提前吞掉，分发永不可达；续传分支补上该断链）。
  2. **encodeCwd 复用** `pi-paths.ts:122-124` 现有实现；header 解析语义对齐 pi 自带迁移 `migrateSessionsFromAgentRoot`（`migrations.js`，读 `header.cwd` 编码子目录）——区别是 pi 对无 cwd 的文件 `continue` 跳过（留在原地丢失），本迁移收进 `_migrated-no-cwd/`。
  3. **备份不自动删**：`pi.backup-v2-<ts>/` 保留；doctor 独立 glob 探测标注（U14b）；清理指引落点 = `docs/troubleshooting.md` 迁移节（列入 U14 交付清单，v9.1 消除悬空引用）；备份体积 ≈ `pi/` 全量（prod 实测含 1330 个 subagent 文件 + 配置 + sessions），迁移报告实测登记（V9⑨）；自动删除留给观察期后的后续版本。
  4. **降级兼容（写明给用户）**：迁移后若**装回旧版本** app，旧版读 `<dataDir>/pi`（不存在）→ 当全新安装对待，历史会话在旧版中不可见但数据无损躺在备份里；旧版运行产生的增量会重建 `pi/`，新版启动残留探测（U14b）告警 → 重跑脚本并道分支（2b 记录型子树文件级并入，无增量丢失）。回滚命令见步骤 6。这是接受的降级行为。
  5. **测试安全性**：脚本不在 app 启动路径，runtime vitest 的 `XYZ_AGENT_DATA_DIR` tmp 重定向与它无关（无 v6 担心的「vitest 真实迁移 dev 数据目录」问题）；脚本只对显式传入的 `<dataDir>` 参数运行，tmp fixture 测试（V9）显式传 tmp 路径。
- **被否（v5–v8 自动迁移整机连同收缩理由入谱系）**：
  - **首启自动迁移 + 四守卫状态机（v5–v8 形态）**——工程上成立（v8 已收敛到状态矩阵无缝隙），但其全部复杂度服务于「大量不可控外部用户机器」这一前提；前提不成立（无外部用户）后，守卫矩阵成为启动路径里的永久死代码与维护负担。**收缩而非推翻**：六步数据语义（备份 → 上移 → header.cwd 分发 → 兼并旧旧布局 → 校验 sessionDir → 报告）原样保留，仅触发方式从「首启自动」改为「人工一次性」。v8 的守卫 0a 三重叠加态分析、v7 的 ENOTEMPTY 双保险等裂缝防御随整机退役，其防御意图由「步骤 0 前置检查 + U14b 探测告警 + 步骤 2b 并道分支」以更粗粒度承接。
  - **前置 reap 双候选（v7）**——被步骤 0b 的进程前置检查替代：无运行中的 pi = 无旧路径 fd 竞态可消；`LEGACY_PI_SESSIONS_DIR` 常量随之消亡（旧布局字面量的合法持有者改为脚本本体，U18 豁免表同步）。
  - **配置文件内容级 merge（v6/v8 否决维持）**——步骤 2b 是**逐项确定性的分域搬移**，不是内容级合并：每个冲突都有确定性去向（避让文件名 `.old-v2-aside` / `.new-v2-aside`），无部分失败态歧义。
  - **并道分支统一「旧赢、新避让」（v9 初版）**——被第 7 轮双审独立击穿：①凭据时效反例——窗口期在新版登录的 `auth.json` 被旧侧覆盖，工作凭据换成可能过期的旧凭据（全 401 且无归因线索）；②记录域失明——`subagents/`、`workflow-state/` 整目录避让后，`scanJsonlRecursive(join(agentDir,'subagents'))` 类固定路径扫描永远够不到避让名，窗口期增量（本机 prod 该域实测 1330 文件）对全部工具消失。改为分域规则：记录型子树文件级并入 / 凭据新赢旧避让 / 其余旧赢新避让 / 冲突清单进报告。
  - **分域规则「凭据新赢 / 其余（含 models.json）旧赢」（v9.1）**——被第 8 轮主审击穿：provider 注册是三件套联动（models.json 定义 / auth.json 凭据 / config/providers.json 扩展，同 keyed by providerId），拆到相反方向后窗口期新增自定义 provider 产生「A/B/C 定义在凭据不在 + D 凭据在定义不在」的交叉失配，比统一旧赢更隐蔽。改为三件套 keyed-by-providerId 逐 key union（同 key 新赢）+ 防御式降级。**与 v6/v8 否决的「内容级 merge」显式区分**：后者指配置 schema 级整体合并（需理解 schema 演化、引入部分失败态歧义）；keyed map 的逐 key union 是结构化确定性操作（同 key 有固定方向、无部分失败歧义），不在该否决射程内。（v9.2 初版把 keyed 域统一锚在顶层，被第 9 轮影面审实机证伪——三件套仅 auth.json 顶层为 keyed，models.json/providers.json 的域在 `.providers` 之下；按字面实施则 models.json 交叉失配复活、providers.json 恒定降级。v9.3 锚定各文件真实域路径。）另有**三件套捆绑降级——被否**（第 10 轮主审裁定）：捆绑会把单文件畸形确定性放大为三件全降（场景 X 的换 key 也丢）；部分降级的最坏形态是**轻度单向失配**（union 生效文件与降级文件的组合，如「凭据在、定义不在」），是 v9.1 四处损伤面的真子集、方向单一、冲突清单有痕——不追求「最坏零失配」，换取单文件故障不扩散。任一三件套文件触发降级时，迁移报告显式提示：「窗口期若新增过 provider，其定义/凭据在对应 aside 文件，按 providerId 手工搬回」。
  - **中断态靠各步幂等自然重跑（v9 初版）**——被击穿：步骤 1 完成后中断，重跑命中「pi 不存在 → 无需迁移」出口，分发步骤永不可达、剩余数据滞留备份。改为步骤 0c 续传分支（备份即暂存 + 幂等重入）。
  - copy-then-delete（双倍 IO 且留中间态）；只 move 不备份（无回滚通道）；迁移时顺带删 workflow-state 等残留（不在迁移里夹带清理）。
- **证据**：`pi-maintenance.ts:71-110`（既有迁移）与 `:80-82`（mkdir 前置，v6 撞名反例）；`runtime/src/index.ts:194`（调用点）；`migrations.js:76-115`（pi 自带迁移语义）；本机实测 prod `~/.xyz-agent/pi/` 顶层只含 `agent/` + `sessions/`（主 session 首测 14 个、2026-09-10 复测 9 个，期间有清理；dev 36 个）；**dev `~/.xyz-agent-dev/pi/` 顶层另有空壳残片**——`auth.json`/`models-store.json` 各 2 字节（2026-08-20）与 `settings.json` 37 字节（2026-09-09），真身在 `pi/agent/` 内同名文件（235B/10152B/241B，实测对比），属陈旧残片：不迁移、留备份、进报告残片清单；dev `pi/sessions/` 实测含 `--private-tmp--/` 子目录与 `.handoff.json` sidecar（§12.3）。
- **效果**：让 §2 目标 6 在存量机（= 本机）上成立；V9 验收（触发方式 = 手工运行脚本）。

### 6.12 reap 孤儿判据替换（方案 B 的硬前提）

- **问题**：`reap-orphan-pi` 的误杀防线①依赖「argv `--session-dir` 值与本实例 `getSessionsDir()` 精确相等」（`reap-orphan-pi.ts:147-160` + 文件头注释 D4a）；env 判据（`PI_CODING_AGENT_DIR`）已被本仓探针**在案否决**（macOS `ps eww`/`launchctl procinfo` 因 SIP 拿不到他进程 env，`reap-orphan-pi.ts:12-14`）。B1 删掉 `--session-dir` 后该判据失效，**不解决这一块就不能落地 B1**。
- **采用：`--no-extensions` 判据 + spawn 白名单清单**（v6 修订，吸收两审查方的撞值反例；v7 补 dev 形态并收紧登记规则）。runtime 在构建 pi argv 时（`buildPiArgs`），把实际传入的 **xyz-agent 自己 staged/安装的 extension 路径**写入 `<dataDir>/run/pi-spawn-markers.json`（`run/` 目录已有先例：relay socket）。登记规则 = 值位于下列 **builtin staged 根三形态**之一：① 打包资源根 `*.app/Contents/Resources/extensions/`；② **dev 双形态（D-11 勘误扩根）**——dev 资源根 `<projectRoot>/apps/electron/resources/extensions/`（resources staging，`extension-resolver.ts:94,196` + `relay-paths.ts:50` 实证 dev/build 同源、无 `.app` 前缀）+ **dev 源码根 `<repoRoot>/extensions/<group>/<pkg>`**（resolver dev 分支实际传参形态；初版②「dev/build 同源走 resources」前提与实装不符——dev builtin 路径来自源码根，不扩根则 dev 清单恒空、dev 孤儿全漏收且无报错，V10① dev 正向必失败）；③ `<dataDir>` 下由 ExtensionResolver 管理的 `extensions/` 与 `npm/` 子树。用户配置来源（`~/.pi/`、项目 `.pi/`、`~/.agents/`）一律排除。reap 判据改为四条合取：
  - `--mode rpc`（保留，防误杀用户手跑的交互式 pi）
  - **且 argv 含 `--no-extensions`**——**主判别位**：xyz spawn 恒带（`buildPiArgs` 首行 `['--mode','rpc','--no-extensions','--approve']`，`rpc-client.ts:269`），而本仓 AGENTS.md 的实测命令模板与用户裸 pi **不带**（实测核对）。
  - **且** argv 中任一 `--extension`/`--skill` 值与清单中某项**精确相等**（沿用现有 `flagValue` + `===` 机器；清单**只登记 staged 专属路径**——TaiJi spawn 的 argv 实测混有 `~/.pi/agent/extensions/…`、项目 `.pi/extensions/…`、`~/.agents/skills` 等用户世界路径，**全部不进清单**）
  - **且** `ppid === 1`（防线②原样保留；防线③单实例锁原样保留）
  - 清单缺失/读不到 → **跳过收殓并记日志**（fail-safe 方向对齐 D4b「宁漏不误杀」）。
- **为什么必须双层**：单靠清单会被本仓自己的工作流击穿——AGENTS.md 的 MANDATORY 实测命令模板就是 `pi --mode rpc --session-dir <dir> --extension <path>`，用户从 ps 输出复制 argv 即可撞上清单值（若清单登记了用户路径），叠加 ppid=1（终端关闭/nohup 后 reparent）即被误杀。`--no-extensions` 是机器可判的硬分界；白名单清单进一步排除「带 `--no-extensions` 的其他来源进程」。**清单写语义**：每次 spawn **全量重算并覆盖写**（tmp + rename 原子写），不 append——覆盖写天然清理已禁用 extension 的历史值；并发 spawn 各写各的全量集，mandatory 18 包恒传保证最小集稳定。
- **收殓范围变化（显式声明）**：现状孤儿 subagent/relay pi **不被** reap（其 `--session-dir` 指向 `subagents/…` ≠ 主 session 目录）；B 后 subagent pi 由 mirrorFlags 镜像主进程的 staged `--extension` 与 `--no-extensions`（`session-runner.ts:1183-1190` + `argv-mirror.ts:60-64`，数据源是**主 pi 进程**的 process.argv——subagent 由主 pi 进程内的 extension spawn，其父是主 pi）→ **开始被收殓**。方向是修复现状漏收（孤儿 subagent 同样烧 token），属预期改进；活跃 subagent 的 **ppid = 主 pi pid**（非 runtime pid，v7 勘误），不受影响。孤儿 subagent 的收殓时序是**两轮**：主 pi 先被收殓/死亡 → subagent reparent 到 ppid=1 → 下一轮 reap 收。V10③ 按此时序构造。
- **判据的原理性极限（边界声明）**：四条合取全部是 argv/ppid 可观测量的函数，等价类 = 「与 xyz spawn 同形的 argv」。用户排障时从 `ps` **完整复制** xyz pi 的 argv 重跑并孤儿化，与真孤儿在判据维度完全同形，原理上不可区分——接受该极限，不为此加机制（V10② 的反向项构造不出此形态属预期）。**实机补充备案（Gate B 组 3 附带发现）**：node 形态 pi（`node_modules/.bin` shim）启动即 `process.title='pi'` 吞掉 `ps` argv 观测面——四条合取依赖 argv 可观测量，此形态下判据失明（fail-safe 漏收方向，不误杀）；runtime 实机经 `piCommand` 注入 bun binary 不受影响。
- **被否**：
  - 清单登记「全部 `--extension`/`--skill` 值」（v5 原案）——被活体进程证据击穿：TaiJi spawn 的 argv 实测混有用户裸 pi 世界路径，登记它们 = 为误杀用户进程开门。
  - env 判据——SIP 在案否决，不重开。
  - pid 登记簿（spawn 时记 pid，reap 查表）——更精确但要新基础设施 + 陈旧条目 GC；argv 机器已存在，成本更低。
  - 匹配 pi 二进制路径（argv[0]）——打包版可判，dev 版与用户裸 pi 共用同一 npm 二进制，不可判。
- **证据**：`reap-orphan-pi.ts:12-27`（env 否决记录 + 三重防线）、`:130-160`（`flagValue`/`matchesOwnPiArgv` 现有机器）；`rpc-client.ts:269`（`--no-extensions` 恒带）、`:205-216`（`appendSkillAndExtensionArgs`）；活体 `ps -A -o pid,command` 实测（TaiJi argv 混有 `~/.pi/…` 用户路径）；`mandatory-extensions.json`（18 包）。
- **效果**：B1 的落地前提成立；V10 验收（含「不误杀带 `--extension` 的用户实测 pi」反向项）。
- **待验证（§11.11）**：`options.extensionPaths` 在所有 spawn 路径上含 staged 专属路径——经调用链核实为恒传（`session-lifecycle.ts:382,832` 经 `resolveCreateLaunch` 恒有 builtin 前置，`preset-service.ts:502`），实施期复测确认清单永远非空。

### 6.13 两方案的关系：B 先行，A 收缩执行

- **执行顺序（选定）**：**B 先行**（M-1 阶段），A 随后按「B 后世界」收缩执行。理由：B 是根修且用户已拍板方向；先做 A 的全量版会建造 U4/U5/U7 这批 B 落地即弃的一次性设施。
- **B 落地后 A 的收缩表**：

  | A 的组件 | B 落地后处置 | 理由 |
  |---|---|---|
  | U4 env 注入 + U5 forward 登记（§6.5） | **删除** | 对齐后 pi 默认派生即正确，无信息缺口可填；少一个 env 变量与登记维护 |
  | U7 family 专项修复（§6.8） | **删除** | `join(agentDir,'sessions')` 变正确，`collectMainSessions` 无需换根列表；not-found 文案仍建议改为列实际候选根（保留为 U1 的一部分） |
  | U1 根解析器（§6.1） | **简化** | `[default]` 根成为主根且恒正确；`[live]` 保留（纯 pi 下剥层到根、B 后与 default 去重，仍是防御）；`[legacy]` 保留——B 后 `dirname(agentDir)/sessions` = `<dataDir>/sessions`（77f006420 之前的**旧旧布局**残留），迁移备份 `pi.backup-v2-*/sessions` **不在该推导式内**（带时间戳，固定公式够不到），备份探测走 doctor 的独立 glob 规则（§6.11 U14b）；`[env]` 信号随 U4 删除 |
  | U2/U3/U6/U8/U9/U10/U11/U12 | **保留不变** | 环境透明、doctor、错误信息、归一化、分组、标题、内容检索与布局正交，两种布局下都需要 |

- **B 延期的退路**：若手工迁移脚本或 reap 判据在实施中受阻，A 按 v4 全量执行（含 U4/U5/U7），B 解阻塞后再落地并按上表收缩。两条路径都在本设计中完整可执行。

---

## 7. 实现机制（把终态落到代码层）

**本章结论**：方案 B 是 runtime 侧一次布局切换 + 迁移脚本 + reap 判据替换；方案 A 是 extension 侧新增根解析器与环境探测器（纯函数 + 注入信号，可完全单测）。**

### 7A. 方案 B（runtime 侧）

```text
runtime 启动（main 拉起后、首个 pi spawn 前）
  ├─ pi-maintenance.syncBundledResources()            ← 全仓唯一 bundled skills 同步点（打包版，
  │                                                    `pi-maintenance.ts:107-126` 拆分保留）
  └─ 残留探测：<dataDir>/pi 存在且含 agent|sessions 子目录形态 → WARN ← §6.11 U14b（v9.2 判据，指引运行迁移脚本；
       不迁移、不阻塞启动；「忘了迁 / 未知存量机 / 降级重建」统一兜底入口）

scripts/migrate-pi-layout-v2.mjs（U14a：一次性手工运行，不在启动路径；prod/dev 数据目录各跑一次）
  ├─ 步骤 0   前置检查（实参形态校验；pgrep -f 模式清单查运行进程；
  │            pi 存在→迁移 / 无 pi 无备份→退出 / 有备份无 pi→续传）
  ├─ 步骤 1   原子备份改名：pi → pi.backup-v2-<ts>
  ├─ 步骤 2   agent/ 上移（不存在 → 整体 rename；已存在 → 分域并入：记录型文件级 /
  │            provider 三件套 keyed union / 偏好旧赢，冲突清单进报告）
  ├─ 步骤 3-4 分发平铺 session（含 <dataDir>/sessions 旧旧布局；header.cwd → <encodeCwd>/）
  ├─ 步骤 5   校验并清除 settings.json 的 sessionDir 覆盖位
  └─ 步骤 6   迁移报告（计数 + 备份路径 + 回滚命令）

rpc-client（B 后）
  ├─ env.PI_CODING_AGENT_DIR = getPiAgentDir()        ← 值变为 <dataDir>/agent（写法不变）
  ├─ 删除 args.push('--session-dir', …)               ← pi 走默认派生
  └─ 写 <dataDir>/run/pi-spawn-markers.json           ← 仅 staged 专属路径（三根之下，§6.12）

reap-orphan-pi（B 后）
  └─ 常规：--mode rpc && argv 含 --no-extensions（主判别位）
           && 任一 --extension/--skill 值 ∈ spawn 清单（精确相等）
           && ppid===1（防线②不变）                    ← §6.12 四条合取；清单缺失跳过收殓
```

路径 SSOT 变更：`shared/paths.ts` 与 `runtime/pi-paths.ts` 的 `getPiAgentDir()` → `join(getDataDir(),'agent')`；`getSessionsDir()` → `join(getPiAgentDir(),'sessions')`；`getPiRoot()` 删除。全仓 `pi/sessions` / `pi/agent` 字面量清扫（含测试常量与文档，§10.1）。

### 7B. 方案 A（extension 侧）

```text
src/index.ts（pi 依赖层，唯一触点）
  execute(_id, params, signal, _onUpdate, ctx)
    ├─ 采集信号包（全部可选链，见下） ─────────────────────────┐
    │   agentDir       = getAgentDir()                          │
    │   liveSessionDir = ctx?.sessionManager?.getSessionDir?.() │ ← ExtensionContext 基础字段，
    │   env            = process.env                           │    非 mode-gated（types.d.ts:209-219）
    │   bundleUrl      = import.meta.url                       │ ← ESM bundle 保留
    │   metadataProvider = async (root) => SessionManager.listAll(root) │ ← §6.6
    └───────────────────────────────────────────────────────────┘
                          ↓
src/tool-handler.ts（纯逻辑，零 pi 依赖；Gate A 回流拆分后本文件留守编排 + re-export，
  四缝外移：doctor → doctor.ts / F1·formatNoMatch → no-match.ts / 跨会话与 search 管线 → search-across.ts /
  extract 预设 → extract.ts / 低层工具 → handler-utils.ts）
  handleSessionRead(params, signals, signal)
    ├─ roots = resolveSessionRoots(signals)          ← 单一数据源，§6.1/§6.8
    ├─ action==='doctor' → renderDoctor(roots, detectEnvironment(signals))
    ├─ find → findSessions(roots, metadataProvider, …)
    ├─ family / export{format:'family'} → buildFamilyFromFs(roots, …)
    │     （仅 main 腿走 roots；subagent/manifest 腿维持 <agentDir>/subagents 推导，§6.8）
    └─ 其余 → resolveSessionId → …；失败 → F1 带自检行（复用同一 roots）
                          ↓
src/discovery/roots.ts
  resolveSessionRoots(signals) → SessionRoot[]
    SessionRoot = { id, kind: 'live'|'env'|'default'|'legacy'|'subagent',   ← B 收缩后无 'env'（§6.13）
                    path, source: 'main'|'subagent', exists, fileCount?, scanMs }
    · 规范化 [live]（encodeCwd 形态剥一层）
    · realpath 去重（同一路径多信号命中只扫一次，保留最高优先级 kind 作标签）
    · 逐个 scanJsonlRecursive（现有实现复用，含 workflow-state 跳过）
                          ↓
src/discovery/env.ts（新增）
  detectEnvironment(signals) → { kind, distribution, dataDir?, evidence[] }
```

要点：

1. **发现层保持零 pi 依赖**：`roots.ts` / `env.ts` / `find.ts` 只接受注入的 `signals` 与 `metadataProvider`，不 import pi（沿用 `roots.ts:8-11` 的既有分层声明）。pi 侧类型以 `import type` 进入，不产生运行时依赖。
2. **`ctx` 采集必须可降级**：`execute` 用可选链读取 `ctx?.sessionManager?.getSessionDir?.()`。**为什么**：现有测试 `index.test.ts:97` 以 `execute('tc-1', {action:'find'}, undefined, undefined, undefined)` 调用（第 5 参 `ctx` 为 `undefined`），无条件解引用会把这条断言 `👉` 错误文案的测试打成 `TypeError`。运行时同理——pi 升级若移除该字段，工具应降级而非抛内部错误；实施期加固：可选链之上再加 try/catch，「方法存在但调用抛错」同样降级（index.ts，测试覆盖三态）。`liveSessionDir === undefined` 时走 §6.1 的候选根降级（B 先行路径 = `[default]` + `[legacy]`，`[subagent]` 恒在；退路形态含 `[env]`，§6.13）。
3. **`[live]` 规范化**：`basename(liveSessionDir)` 匹配 encodeCwd 形态时取 `dirname`，否则取自身。该判据对应 pi 两条路径的差异（§6.1 证据）。
4. **去重按 realpath**，保留最高优先级标签；`doctor` 中把被去重的根以「与 N 同路径，已去重」注记显示。
5. **`doctor` 的诊断结论只陈述事实**：输出各根文件数与「最高优先级 main 根是否非空」，**不输出**「真的没有这个 session」这类归因断言（§5.2 / §3.3 教训）。subagent 根默认不扫（§6.3）。
6. **`scanJsonlRecursive` 复用**：`resolveSessionRoots` 内部仍调用它，不新写扫盘逻辑；仅把返回值聚合改为带 `kind` 标签。
7. **向后兼容**：`findSessions(query, agentDir, opts)` 与 `buildFamilyFromFs(sessionId, agentDir)` 的旧签名保留为薄包装（内部构造只含 `agentDir` 的信号包 → 退化为「`[default]` + `[legacy]`」两根），使存量单测与外部调用不破。**注意**：这只对测试与外部深 import 有意义——**工具运行路径必须走新签名**，否则 family 修复不生效（§6.8）。
8. **根扫描不缓存（v9.8 修订）**：原方案「仅 `doctor` 的重复调用共享根扫描缓存（keyed by root path；秒级 TTL 或目录 mtime 变化即失效），**`find` 一律不读缓存**——F1 自检行的计数必须取自**本次 find 刚完成的实扫结果**」已随 ext-simplify-04 U3 整体删除：缓存保护的对象（subagent 根默认 `'stat'` 只做存在性检查后，仅剩 main 根 readdir+stat）已是便宜化路径，Gate B 活体 doctor 秒级返回未依赖缓存命中。删除后 `resolveSessionRoots` 每次调用实扫——F1 自检行计数天然取本次实扫结果，原 PS-14（缓存把「首条 assistant 前 0 文件」误报成「主根为空」）的防污染规则**只因该缓存存在才需要存在**，随之失效；doctor 重复调用输出一致且新落盘文件立即可见（更实时）。进程内现仅保留 u11 标题元数据 TTL 缓存（§6.6，metadataCache，与根扫描无关）。

---

## 8. 验收（真实场景，非单测非 mock）

**本章结论**：用 8 个真实场景覆盖全部 5 条目标，全部在真实宿主、真实数据上跑，不用 mock；含 2 条反向场景（防「修好 A 弄坏 B」）。**

### 8.1 改动规模

**大**：新增 action、变更发现层接口与数据源、跨包改动（runtime 布局切换 + 迁移脚本 + reap 判据 + pi 语义登记；A 全量退路另含 spawn env 注入与 forward 登记）。按大改动标准做多场景验收。

### 8.2 验收场景

| 场景 | 回溯 §2 目标 | 真实流程 / 数据 / 路径 | 通过标准 |
|---|---|---|---|
| **V1 原事故复现（TaiJi.app）** | 目标 1 | 在 TaiJi.app（打包版）里新开 session，执行 `session_read{action:"find", query:"01a08a6e"}`，数据为真实主 session（设计期首测 14 个、2026-09-10 复测 9 个，期间有清理——以实施期实测数为准；B 前在 `~/.xyz-agent/pi/sessions/`；**B 后在手工迁移完成的机器 `<dataDir>/agent/sessions/<encodeCwd>/`**，V9⑤ 重跑本场景） | 命中集含 `01a08a6e-0d26-…` / `-74fc-…` / `-b007-…` 三条 main，且 `source=main`，完整 id 可见 |
| **V2 纯 pi 不回退** | 目标 1 | **环境隔离后**启动纯 pi：`env -u PI_CODING_AGENT_DIR -u XYZ_AGENT_EXT_LOG -u XYZ_AGENT_DATA_DIR -u PI_CODING_AGENT_SESSION_DIR pi --mode rpc --session-dir <tmp> --extension <repo>/extensions/universal/session-reader`（AGENTS.md 实测命令 + 显式剥除托管信号，防 TaiJi 会话内执行时被继承 env 污染判定），对 `~/.pi/agent/sessions/` 真实 4619 个 session 执行 `find{query:"<某个已知 uuid 前缀>"}` | 命中该 session（命中来自 `[default]` = `~/.pi/agent/sessions`；本环境 `[live]` = `<tmp>` 是另一目录，**不去重**）；`[legacy]`（`~/.pi/sessions`）不产生候选也不报错；`doctor` 判 `standalone-pi` |
| **V3 doctor 自描述 + legacy 告警** | 目标 3 | 在 V1 环境执行 `session_read{action:"doctor"}`；纯 pi 跑**两种形态**——(a) V2 环境（带 `--session-dir <tmp>`）、(b) 同样 env 隔离但**不带** `--session-dir` | TaiJi 下：`xyz-agent · packaged`、数据目录 `~/.xyz-agent`、live 根文件数与实测一致、`[legacy]` = `<dataDir>/sessions`（旧旧布局，迁移完成机通常不存在——仅事实行，B 前世界才与主根同路径去重）；纯 pi (a) 下：`standalone-pi`、`[live]` = `<tmp>` 与 `[default]`（4619 文件）各自列出不去重；纯 pi (b) 下：`[live]` 剥层后与 `[default]` 同路径去重、4619 文件、`[legacy]` = `~/.pi/sessions` 空。**legacy 告警判据统一为「非空才告警」（§6.1）**：上述环境均**不出现**告警、仅事实行；另构造一个 legacy 根非空的环境（或临时放入一个 .jsonl）验证告警出现。各环境都打印各根文件数与 evidence 行 |
| **V4 失败自证 + 封死绕行** | 目标 2 | 在 TaiJi.app 里执行 `session_read{action:"find", query:"01a08zzz"}`（不存在的片段） | 输出含：① 事实型自检行（main 根 N 文件 / subagent 根 M 文件 / 「已做归一化匹配」）② 编辑距离最近候选 ③ 三条做法 + doctor 提示（共四行，§5.2 形态）④ 一行明确的「不要用 shell find/ls/rg 搜 session」；**且不含**原「去用 recent」误导指引，**且不断言**「真的没有这个 session」 |
| **V5a 归一化 + 分组**（M3 交付） | 目标 1/4 | 在 TaiJi.app 里依次执行：`find{query:"01A08A6E-74FC-78A4-9580-8539B40E0920"}`（全大写）、`find{query:"01a08a6e74fc78a495808539b40e0920"}`（去连字符）、`find{query:"福耀玻璃"}` | 前两者（v1 设计下为 0 命中）各自命中 `01a08a6e-74fc-…`；第三者 main 段**置顶**且含 `01a08a6e-0d26-…`；所有输出完整 id（**标题字段可为空**——标题检索随 V5b/M4 生效） |
| **V5b 标题检索命中**（M4 交付；v9.6 随 B 后布局改写） | 目标 4 | 执行 `find{query:"福耀玻璃"}`、`find{query:"海康威视"}`，再对窄化候选执行 `search{session:"<id列表>", pattern:"<关键词>"}` | **find 通路**：main 段置顶且按首条 user 关键词命中（§6.6 策略 2 回退——B 后主根同为 `<encodeCwd>/` 布局，标题维度按策略 2 显式不覆盖，候选行展示首条 user 片段）；**标题可见性由 search 通路承载**：命中 session 的标题（`listAll` 的 `name`，如「福耀玻璃深度研究」）在 search 结果中显示。活体证据：Gate B 组 1（fixture 迁移数据，search 输出 name 正确、find 命中归因首条 user） |
| **V6 family 全 action 一致** | 目标 1 | 在 TaiJi.app 里执行 `session_read{action:"family", session:"01a08a6e-74fc-78a4-9580-8539b40e0920"}`，再执行 `{action:"export", format:"family", session:<同 id>}` | 两者都正常返回（不抛 `not found under …/agent/sessions`），family 树 root 为该 id；`find` 与 `family` 对同一 id 的存在性判定**一致**；family 树含该 session 发起的 **subagent 节点（≥1，或与该 session 的 manifest 计数一致）**——防 subagent 腿被误改而测试仍绿 |
| **V7 env 注入反向面**（**仅 A 先行/B 延期退路时执行**，B 落地后 U4 删除、本场景作废） | 目标 1 的副作用面 | 在 TaiJi.app 会话内通过 bash 执行 `env \| grep PI_CODING_AGENT_SESSION_DIR`（确认变量已注入，**可靠通道**）；随后执行**不带** `--session-dir` 的 `pi -p 'hi'`（`-p/--print` 存在于 `dist/cli/args.js:124`，print 模式本身无交互；裸 pi 读 `PI_CODING_AGENT_DIR` 下 models.json/auth 取模型，预期可用），落盘观察 = 执行前后 `ls <dataDir>/pi/sessions` 取差集 | ① 变量可见；② 落盘位置被**显式记录**为「进入 `<dataDir>/pi/sessions`」或「未进入」，与 §6.5 的已接受代价声明一致；③ subagent pi 内 `doctor` 的判定与 §6.5 表第一行一致：`[live]` 标注为 subagent 根、主根以 **`[legacy]`** 形态出现（`[env]` 在 subagent pi 内**缺席**，因 U4 不触及 session-runner），两者不被误标混淆。**收尾**：探针产生的 session 文件（无论落哪）人工 `rm` 清理，与 §6.5 恢复通道闭环 |
| **V8 跨会话内容检索**（阶段二） | 目标 5 | 先 `find{query:"<某 cwd 或时间范围>"}` 窄化，再对结果检索关键词（如某次讨论里出现过的 `adj_factor`） | 返回包含该关键词的 session 列表 + turn 索引 + 可直接执行的调用串；纯 pi 全库宽搜被**明确拒绝**并提示先窄化（不静默超时） |
| **V9 迁移正确性（方案 B，手工脚本）** | 目标 6 | 用 tmp 副本（复制 `~/.xyz-agent` 真实布局）走四条时序：**先迁后升**（推荐）——关闭应用后手工运行 `node scripts/migrate-pi-layout-v2.mjs <tmpDir>`，迁移前后对比 `find <tmpDir> -type d` 目录树，随后在新版里 `session_read{action:"find", query:"01a08a6e"}` 与 `outline`；**先升后迁**（兜底）——先启动新版（触发残留 WARN）→ 关闭 → 跑脚本（分域并道分支）；**中断续传**——步骤 1 后人工中断 → 重跑；**重复运行**——完整成功后再跑一次 | ① `pi/agent/*` 全部出现在 `<dataDir>/agent/`（models.json/settings.json/subagents 在位）；② 原平铺主 session（首测 14 / 复测 9，以实施期为准）按 header.cwd 落入对应 `<encodeCwd>/`（含无 cwd 者入 `_migrated-no-cwd/`）；③ sidecar（.model.json/.project.json/.handoff.json）随行；④ `pi.backup-v2-*` 存在且含未迁移残留；⑤ **迁移后 find/outline/family 对全部旧 session 命中**（V1 场景在迁移机上重跑通过）；⑥ 中断续传：重跑进续传模式完成迁移、已搬文件零重复动作；完整成功后重跑 = 全跳过报告；⑦ 分域并道：记录型子树（sessions/subagents/workflow-state）文件级并入无丢失；**provider 三件套（auth/models/config providers.json）keyed 逐 key union，keyed 域按 §6.11 实测锚点（auth 顶层 / models 与 providers 在 `.providers`）——场景 X 与场景 Y 用例分别构造在三个文件上**：X（窗口期给既有 provider 换 key）→ 三个文件的同 key 均取新侧；Y（窗口期新增自定义 provider）→ 迁移后该 provider 的定义与凭据在三件中同时在位；providers.json 的 version/scopedModels 域外伴随字段取新侧进清单；独立凭据（token*）新赢（旧侧 `*.old-v2-aside`）、偏好类旧赢（新侧 `*.new-v2-aside`），冲突清单逐文件进报告；畸形 JSON 用例细分两形态——**key 域子对象畸形**（`.providers` 值非 plain object）与**伴随字段畸形**，降级方向按健康侧选向验证（旧侧坏→新赢 / 新侧坏→旧赢 / 双侧坏→不动报人工）；⑧ 有进程运行时中止并列 PID、实参形态校验拒绝非 `.xyz-agent*` 目录；升级后未迁移的启动 = WARN 日志出现且 doctor 按收紧判据（`pi/` 含 agent\|sessions 子目录形态）标注；⑨ 迁移报告含备份体积实测登记 |
| **V10 reap 判据替换（方案 B）** | 目标 6 的副作用面 | ① 正向 ×2：prod（打包资源根 staged）与 **dev**（仓库资源根 staged）各制造一个孤儿（spawn 带 `--no-extensions` + 清单内 `--extension` 的 `pi --mode rpc` 后 kill 其父）确认被收殓；② 反向 ×3：用户裸 pi 交互式、按 AGENTS.md 模板的 `pi --mode rpc --extension <staged路径>`（**带清单值但无 `--no-extensions`**）、带 `--no-extensions` 但 `--extension` 值不在清单——三者都不被杀；③ 孤儿 subagent **两轮时序**（先收主 pi → subagent reparent ppid=1 → 下一轮收）；活跃 subagent（ppid = 主 pi pid）不被杀；④ 清单缺失：删掉 `pi-spawn-markers.json` 后 reap 跳过并记日志（宁漏不误杀） | 四个子项全部符合；`reap-orphan-pi.test.ts` 的 DIR 常量与断言同步更新后全绿 |
| **V11 双仓同步**（M5 交付） | 目标 1（纯 pi 宿主延伸） | 本修复随 merge 发布后：① `pi update @zhushanwen/pi-session-reader` 更新纯 pi 装机副本；② CLI 仓 `~/Code/pi-session-reader` 以修复后本仓为基线重平移并实现 `doctor` 子命令；③ 同步 `SKILL.md` 计数与映射表；④ 在 V2 同款环境隔离命令（`--session-dir <tmp>` 形态）下对装机副本实测 | ① 装机副本 `version` ≥ 本修复发布版（`grep '"version"' ~/.pi/agent/npm/node_modules/@zhushanwen/pi-session-reader/package.json`）；② 纯 pi 带 `--session-dir` 实测命令下 `find` 由 0 命中变命中（副本②的 bug 消除，复现 §3 同款场景）；③ skill 正文 action 计数 = 11 且映射表含 `doctor` 行；④ CLI `pi-session-reader doctor` 子命令输出与 extension 侧**字段结构等价**（根列表各列 + 环境判定行 + evidence 行），且对同一数据目录各根 fileCount 一致——`[live]` 根与托管 env 信号在 CLI 宿主缺席属预期差异，不参与等价判定（v9.1 明确判定语义） |

**回归基线**（必须保持）：

- `find{query:"红队"}` 等 subagent 关键词检索行为不变（现网依赖）。
- 传入绝对路径 `outline{session:"<路径>.jsonl"}` 仍可用（防回退，`resolveBySessionPath` 不动）。
- `find{query:"01a08a", limit:100}` 的 subagent 段含 34 条（uuidv7 时间前缀碰撞属正确行为，§3.4；分组后 main 段 0 条 + subagent 段 34 条，合计不变）。
- 纯 pi 下 `find{query:"<某个非当前 cwd session 首条 user 中的关键词>"}` 行为与现状一致（命中来自 `[default]`，走首条 user 回退路径——§6.6 策略 2 的可判定回归项）。
- `find{query:"recent"}` 的候选集含主 session（原失败模式 #4 的验收保护；预期 main 14 条 + subagent 淹没，**main 段置顶**后可辨识——若实现按 §6.7 分组，`recent` 亦同规则）。
- `result` action 的批量头行仍为 8 字符短 id（§6.7 范围声明；`execution-tree.test.ts:747` 断言不变）。
- `index.test.ts:97`（`ctx === undefined`）仍通过且断言的是 `👉` 错误文案（§7B 要点 2 降级）。

---

## 9. 实施

**本章结论**：分四批交付——M-1 布局对齐（方案 B）先行，M0–M3 恢复正确性与可诊断性，M4 补检索力，M5 双仓同步（随发版触发）。**

### 9.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| **M-1 布局对齐（方案 B，先行）** | `scripts/migrate-pi-layout-v2.mjs` 一次性手工迁移脚本 + 启动残留探测（U14）；`getPiAgentDir/getSessionsDir` SSOT 切换；rpc-client 删 `--session-dir` + 写 spawn 清单；reap 判据替换；全仓路径字面量清扫 | §5.3 布局终态（V9/V10）；本 bug 在**所有**消费者上根修 |
| **M0 根发现（收缩版）** | 新增 `resolveSessionRoots` + 信号包；`index.ts` 接线（含 `ctx` 可选链降级）；`[env]` 信号与 family 专项修复**不建**（§6.13） | §5.1 候选集含 main（V1/V2 在迁移机上重跑） |
| **M1 环境识别** | 新增 `env.ts`（多信号合取）+ pi 语义登记（U6，登记范围含布局事实） | §5.1 环境行（V3） |
| **M2 doctor** | 新增 `doctor` action + 渲染（复用 M0/M1 数据；subagent 根默认不扫——原根扫描缓存交付物已删，v9.8；`pi.backup-v2-*` 备份与未迁移 `pi/` 残留走**独立 glob 探测**——不在 `[legacy]` 推导式内，§6.11 U14b） | §5.1 doctor 全表（V3） |
| **M3 错误信息与输出** | F1 重写（事实型自检 + 编辑距离候选 + 三条做法 + 禁止项）；uuid 归一化匹配；`find` 按 source 分组 + 全 id + 可复制调用串 | §5.2（V4/V5a） |
| **M4 检索力**（阶段二） | 元数据走 `SessionManager.listAll`（标题/cwd/首消息，惰性 + 窄化 + 缓存，§6.6）；跨会话内容检索（窄化前置 + 字节上限） | V5b/V8 |
| **M5 双仓同步**（§6.9，时机 = 随 merge 发版） | npm 发版（changeset 流程）；`pi update @zhushanwen/pi-session-reader` 更新纯 pi 装机副本；CLI 仓双向 diff 重平移（本地演化保留）+ `doctor` 子命令 + `LINEAGE.md` 基线更新；`SKILL.md` 计数/映射表同步；发版 notes 写「先迁后升」迁移指引（U14b 用户可见通道） | 副本②③（纯 pi 装机 / CLI + skill）消除同一 bug（V11）；发布说明补 WARN 日志通道的可见性缺口 |

M-1 独立交付且先行；M0–M3 是一个不可分割的正确性交付（M3 的自检行依赖 M0 的根列表）；M4 可独立排期；M5 依赖 doctor 落地（M2），时机绑定 merge 发版。若 M-1 受阻 → 按 §6.13 退路执行 A 全量版（恢复 U4/U5/U7 与 V7）。

---

## 10. 下一层拆分

**本章结论**：拆成 18 个可实施单元（U13 自 v9 起为执行单元），M-1 为第一批（方案 B，U14–U18），M0–M3 为第二批（方案 A 收缩版），M4 为第三批，M5 为第四批（双仓同步）。**

| 单元 | 说明 | justification（为什么这么拆） |
|---|---|---|
| **U14**（M-1）`scripts/migrate-pi-layout-v2.mjs` + 启动残留探测 | §6.11 手工迁移脚本（六步 + 三判前置实参/进程/形态 + 续传分支（备份名 ts 判据）+ 分域并道（记录型文件级 / provider 三件套 keyed union + 防御式降级 / 偏好旧赢）+ 冲突清单报告，不在启动路径）+ runtime 启动残留 WARN（判据与 doctor 对齐：`pi/` 含 agent\|sessions 形态）+ doctor 备份/残留 glob 标注（基点 `dirname(agentDir)`）+ `docs/troubleshooting.md` 迁移节（备份清理指引落点） | 方案 B 的数据面交付物；独立可测（tmp 目录复制真实布局做 fixture，V9 四条时序 + 场景 X/Y 用例）；无崩溃续传状态机（无外部用户，存量集合封闭——§6.11 决策变更；中断态由步骤 0c 续传分支承接，v9.1） |
| **U15**（M-1）路径 SSOT 切换 + 消费方改造 | `shared/paths.ts` + `runtime/pi-paths.ts` 的 `getPiAgentDir/getSessionsDir` 改值、`getPiRoot` 删除；**三个非派生消费方专项改造**（v6 增）：① `usage-stats-service.ts:66-95` 扫描改两层（现单层 `readdir` + 跳目录，B 后根层 `.jsonl` 数 = 0 → 统计**归零**）；② `pi-maintenance.ts:150-151` `getPiGlobalAgentDir` 的「向上 3 层」推导改从 `getDataDir()` 起（B 后多走一层 → `cleanLeakedPackages` 静默失效）；③ `session-fork.ts:154-162` `buildForkTarget` 改写 `join(getSessionsDir(), encodeCwd(header.cwd), fileName)`（现写平铺根，B 后 pi 原生 `listAll` 只枚举子目录 → fork session 在 TUI/`/session-pick` 不可见；`import-service.ts:252` 已是子目录形态，两写入方对齐）。字面量清扫（**数据布局清 / 资源布局豁免**两栏）：清 `reap-orphan-pi.test.ts` DIR、`usage-stats-service.test.ts`、`spawn-env.test.ts`、`scripts/probe-pi-sw-snapshot.mjs:29-61`（用旧路径存在性判生产布局）、`scripts/verify-plugin-contract.sh:128`（fixture 建旧布局）、`workflow-extractor.ts:236` 注释、AGENTS.md/troubleshooting.md；**豁免** `pi-maintenance.ts:109` bundled 同步源 `join(process.cwd(),'pi','agent')` 与 `prepare-pi-resources.sh` 的 `resources/pi`（app 资源布局，非用户数据布局） | SSOT 单点改值 + 三个硬编码消费方不改造则 B 必坏其一；资源/数据两种布局字面量同形，机械清扫会误伤打包资源逻辑 |
| **U16**（M-1）rpc-client：删 `--session-dir` + spawn 白名单清单 | 删 argv 参数；写 `<dataDir>/run/pi-spawn-markers.json`（仅 staged 专属路径；每次 spawn 全量重算覆盖写，tmp+rename 原子） | B 的机制面；清单是 U17 的前提，与迁移（U14）可并行开发 |
| **U17**（M-1）reap 判据替换 | `matchesOwnPiArgv` 改四条合取（`--mode rpc` + `--no-extensions` 存在 + 白名单值精确相等 + ppid=1）；测试同步；**收殓范围扩大声明**（孤儿 subagent/relay pi 从「不收」变「收」） | B 的安全面；不落地则 B 不可发布（孤儿 pi 失收殓） |
| **U18**（M-1）constraints.json 布局对齐契约登记 + 独立字面量守卫 | ①新增 C-pi 条目：「xyz-agent 数据布局与 pi 默认布局同构（agent/ 子树），唯一差异 = 根目录；禁止再引入 `pi/` 兄弟布局引用与新 `--session-dir` 覆盖」；`node scripts/render-constraints.mjs` 重生成 md。②守卫为**新独立检查器**（v7 修订：v6 拟挂的 `check_path_whitelist.py` 与 `check-pi-sync.mjs` **均不承载此检查**——前者 TARGETS 仅 `packages/runtime/src/index.ts` 一个文件、只查白名单变量动态化；后者查固定版本锚点清单、无字面量扫描；照挂即假防护）：显式文件范围（`packages/` `apps/` `scripts/` 源码 + AGENTS.md + docs/troubleshooting.md）+ 字面量模式（`'pi','agent'`/`'pi','sessions'` join 形态与 `xyz-agent*/pi/` 上下文的 `pi/agent`、`pi/sessions` 字符串——**显式排除 `.pi` 前缀**（`~/.pi`、`/.pi/`、`'.pi'`）：系统 pi 家目录 `~/.pi/agent` 是固定合法路径且子串含 `pi/agent`，不排除则范围内 ≥6 处合法引用（`core/src/transport/mock/settings-data.ts:72,75`、`subagent-core/src/shared/resource-discovery.ts:13,568`、`shared/paths.ts:46`、`pi-maintenance.ts:141-142`）首跑即大面积误报，`check_path_whitelist.py:88` 已有同类先例注释）+ **集中豁免常量表**（资源布局清单：`pi-maintenance.ts` bundled 同步源、`find-pi-executable.ts:47` bundled pi 二进制、`prepare-pi-resources.sh` 资源路径、`scripts/migrate-pi-layout-v2.mjs` 迁移脚本本体——旧布局 `pi/sessions` 等字面量的唯一合法持有者，v9 起替代已消亡的 `LEGACY_PI_SESSIONS_DIR`；以 `LAYOUT_LITERAL_EXEMPT` 常量 + 行内注释标记承载，替代散点清单防漏列）+ 挂 pre-commit 新钩子 | 本仓纪律「新增约束先登记再写代码」（AGENTS.md）；U15 一次性清扫无守卫 = 字面量必回流（本次审查即抓到 6 处存量）；豁免集中化防「清单式指令漏列即漏豁免」（`find-pi-executable.ts:47` 漏列则打包版找不到 pi 二进制） |
| **U1** `discovery/roots.ts`：`resolveSessionRoots(signals)` | 信号 → 带 `kind` 标签的根列表；规范化 `[live]`；realpath 去重；复用 `scanJsonlRecursive`。**B 后收缩**：`[env]` 信号删除，`subagents.ts` not-found 文案改列实际候选根（U7 其余不建） | 是 M0–M3 全部下游的数据源，必须最先落地且可单测 |
| **U2** `discovery/env.ts`：`detectEnvironment(signals)` | 多信号合取判定 + `evidence[]` | 与 U1 无数据依赖，但 `doctor` 需两者齐备；独立成单元便于分别单测 |
| **U3** `index.ts` 信号采集接线 | `execute` 组装信号包（可选链 `ctx?.sessionManager` / `process.env` / `import.meta.url`）并传入 handler | 唯一的 pi 依赖触点；`ctx === undefined` 降级必须在此层兜住（现有测试即以五参 `undefined` 调用 `execute`，见 §7B 要点 2） |
| **U4** `runtime`：注入 `PI_CODING_AGENT_SESSION_DIR` | 经 `buildOutboundChildEnv` 的 `extras`。**B 先行路径下不建**（§6.13）；仅 A 全量退路执行 | 跨包改动，需与 U1 的 `[env]` 信号分别验收（可独立回滚） |
| **U5** `shared` + `docs`：C-proc-09 forward 登记 | `spawn-env-contract.ts` 的 `SPAWN_ENV_FORWARD_REFERENCE` 增条目 + `env-propagation-boundary.md` B 组表 + `spawn-env-contract.test.ts` 增 `toContain` 断言。**B 先行路径下不建**（§6.13）；仅 A 全量退路执行 | 登记义务与 U4 绑定但落点不同包；无既有机器防线拦截（文件级白名单 + 测试无完整性断言），故须**自带补红**——同文件 `:42-45` 的 U0① 增补范式（`it('含 … XYZ_SUBAGENT_IDLE_TIMEOUT_MS')`）就是先例，加三行使「漏登记」从不会红变必红 |
| **U6** `docs/pi-semantics.json`：pi 私有语义登记 | 登记 6 条：① `ENV_SESSION_DIR` 变量名（`dist/config.js:406`）；② session 目录优先级链（`dist/main.js:530-533`）；③ `ctx.sessionManager` 非 mode-gated（`types.d.ts:209-219`）；④ `getSessionDir()` 双形态（cwd 编码子目录 vs 根本身，`session-manager.js:1179-1180`）；⑤ pi 默认布局构造式 `<agentDir>/sessions/<encodeCwd>`（`session-manager.js:242-247`）；⑥ `settings.sessionDir` 是优先级链第 3 位的静默覆盖位（`settings-manager.js:451-452`；B 依赖它恒为空，迁移脚本步骤 5 校验清除，§6.11）；各配 pi-anchor + 探针 | 这些是 `[live]`/`[env]`/B 默认派生的成立前提，pi 升级若漂移将**静默**失效（无任何运行时报错，只有行为变化）；按 C-proc-08 须登记使 `check-pi-semantics.mjs` 可拦截。⑤ 与 ④ 是两个不同事实（前者是 `getDefaultSessionDirPath` 的构造式，后者是 `create()` 的分支选择），与 §12.3 的登记去向列一一对应 |
| **U7** `discovery/subagents.ts`：家族扫描接入根列表 | `collectMainSessions` 改用 `resolveSessionRoots`。**B 先行路径下不建**——布局对齐后 `listMainSessions(agentDir)` 恒正确（§6.13）；仅 A 全量退路执行。not-found 文案改列实际候选根**两种路径都做**（并入 U1） | 消除「find 说有、family 说没有」（§6.8）；B 落地后该矛盾不存在 |
| **U8** `doctor` action | schema enum + handler 分支 + 文本渲染 + subagent 根默认不扫（v9.8：原缓存交付物已删，见 §7B 要点 8） | 新增 action 需同步 description/guidelines/测试，独立成单元 |
| **U9** F1 错误信息重写 + uuid 归一化 | 事实型自检行 + 编辑距离 top-N + 三条做法 + 禁止项；两级归一化匹配 | 是「封死绕行」的唯一执行点，需单独的文案审查（面向 agent 的提示词）；归一化是 §3.3 盲区的唯一修复点 |
| **U10** `find` 输出增强 | 按 source 分组（main 置顶）+ 全 id + 可复制调用串；**不动** `SESSION_ID_PREFIX_LEN` 与 `result` 通路 | 纯渲染改动，与 U9 同源但可独立验收（成功路径 vs 失败路径）；范围声明防误伤 `result` |
| **U11**（M4）元数据走 `SessionManager.listAll` | `metadataProvider` 注入 + 三条调用策略（惰性触发 / 仅平铺目录 / TTL 缓存）+ 两条 guard（仅对存在根调用且永传非空串；单目录 try/catch 记空继续）+ 纯 TS 降级（首条 user，命中即停） | 解决「标题检索」；该 API 实装语义是「扫一层平铺目录 + 每文件全量解析」（§6.6 两条前提），不窄化即秒级卡顿；降级路径独立可测 |
| **U12**（M4）跨会话内容检索 | 窄化前置 + 字节上限 + 结果渲染 | 新增检索能力，需单独定义「宽搜拒绝」语义 |
| **U13**（M5，v9 由登记升级为执行单元）双仓同步 | ① npm 发版（随 merge changeset 流程，修复唯一来源 = 本仓）；② `pi update @zhushanwen/pi-session-reader` 更新纯 pi 装机副本（settings 条目无版本约束、pi 不自动升级，装机实测停 0.2.4）；③ CLI 仓 `~/Code/pi-session-reader` 以修复后基线重平移 + `doctor` 子命令；④ `SKILL.md` action 计数 10→11 + 映射表补 doctor 行 | 副本②③带同一 bug 且「只发版不更新装机」到不了纯 pi 侧（§6.9 三副本表）；细节与时机见 §6.9 |

### 10.1 文件改动地图

| 文件 | 改动 |
|---|---|
| `extensions/universal/session-reader/src/discovery/roots.ts` | 新增 `resolveSessionRoots` / `SessionRoot` / `SessionRootSignals`；`listMainSessions`/`listSubagentSessions` 保留为旧签名薄包装（**工具路径不再直接消费它们**，见 §7B 要点 7） |
| `extensions/universal/session-reader/src/discovery/env.ts` | **新增** |
| `extensions/universal/session-reader/src/discovery/find.ts` | `collectCandidates` 改从 `resolveSessionRoots` 取文件列表；两级归一化匹配；`metadataProvider` 注入点 |
| `extensions/universal/session-reader/src/discovery/subagents.ts` | not-found 文案列实际候选根（U7 其余不建，§6.13） |
| `extensions/universal/session-reader/src/tool-handler.ts` | `handleSessionRead` 签名加 `signals`/`metadataProvider`；新增 `doctor` 分支与 `renderDoctor`；改写 `formatNoMatch`；`formatFindContent` 分组 + 全 id；编辑距离工具。**不改** `SESSION_ID_PREFIX_LEN` 与 `result-action.ts`。**Gate A 回流拆分落点（本行仅留守编排 + re-export）**：doctor → `src/doctor.ts`、F1/`formatNoMatch` → `src/no-match.ts`、跨会话与 search 管线 → `src/search-across.ts`、extract 预设 → `src/extract.ts`、低层工具 → `src/handler-utils.ts` |
| `extensions/universal/session-reader/src/index.ts` | schema enum 加 `'doctor'`；description action 列表补一词；guidelines 加一句；`execute` 组装信号包（可选链）+ `metadataProvider` |
| `packages/runtime/src/infra/pi/pi-maintenance.ts` | `migrateToPiSubdir` **拆分退役**——目录迁移段退役，`isPackaged()` bundled 同步段保留为独立 `syncBundledResources()` **直挂 runtime 启动**（全仓唯一 bundled skills 同步点，`pi-maintenance.ts:107-126`）；新增启动残留探测（`pi/` 存在且含 agent\|sessions 子目录形态 → WARN + 迁移指引，与 doctor/脚本 0a 判据对齐，U14b）；`getPiGlobalAgentDir` 推导改从 `getDataDir()` 起（U15②） |
| `scripts/migrate-pi-layout-v2.mjs` | **新增**（U14a）：一次性手工迁移脚本（六步 + 并道分支 + 迁移报告）；不在 app 启动路径 |
| `packages/shared/src/paths.ts` + `packages/runtime/src/infra/pi/pi-paths.ts` | `getPiAgentDir` → `join(getDataDir(),'agent')`；`getSessionsDir` → `join(getPiAgentDir(),'sessions')`；`getPiRoot` 删除（U15） |
| `packages/runtime/src/infra/pi/rpc-client.ts` | 删 `--session-dir` argv；写 `<dataDir>/run/pi-spawn-markers.json`（U16）；B 先行路径下 `extras` **不**增 env（U4 仅退路） |
| `packages/runtime/src/services/reap-orphan-pi.ts` | 判据换四条合取（U17）；测试 DIR/断言同步 |
| `packages/runtime/src/services/usage/usage-stats-service.ts` | 扫描改两层（U15①——不改则 B 后统计归零） |
| `packages/runtime/src/services/session/session-fork.ts` | `buildForkTarget` 改写 encodeCwd 子目录（U15③） |
| `packages/runtime/src/services/reap-orphan-pi.test.ts`、`usage/usage-stats-service.test.ts`、`infra/__tests__/spawn-env.test.ts`、`scripts/probe-pi-sw-snapshot.mjs`、`scripts/verify-plugin-contract.sh` | 路径常量/fixture 同步（U15 清扫范围） |
| `docs/constraints.json` + 重生成 `docs/constraints.md` | 新增布局对齐契约条目（U18） |
| `AGENTS.md` / `docs/troubleshooting.md` / `logger.ts:431` / `shared/workflow.ts` / `workflow-extractor.ts:236` 注释 | `~/.xyz-agent/pi/` 字面量同步（U15 清扫范围） |
| `packages/shared/src/spawn-env-contract.ts` | `SPAWN_ENV_FORWARD_REFERENCE` 增条目（U5，**仅 A 全量退路**） |
| `docs/design/env-propagation-boundary.md` | B 组表同步（U5，**仅 A 全量退路**） |
| `docs/pi-semantics.json` | 登记 6 条 pi 私有语义（U6） |
| 测试 | `src/__tests__/roots.test.ts`（三宿主信号包 table-driven）、`env.test.ts`（新增，含透传污染反例）、`tool-handler.test.ts`（`doctor` + 新 F1 文案 + 分组 + 归一化 + family 一致性）、`index.test.ts`（`ctx === undefined` 与 `sessionManager` 缺方法两例） |

---

## 11. 待验证检查点

设计阶段无法确定、留给实施期验证的点（**不编造结论**）：

1. **`ctx.sessionManager.getSessionDir()` 在 RPC 模式的实际返回值**。类型上 `sessionManager` 是 `ExtensionContext` 的基础字段（`types.d.ts:209-219`，非 mode-gated），但需在 xyz-agent 的 RPC 子进程里实跑确认其返回 `<dataDir>/pi/sessions`（而非 cwd 编码子目录）。**失败降级**：`[live]` 信号不可用时，`[env]` + `[default]` + `[legacy]` 三根仍能覆盖三宿主（U1 的候选根设计已保证降级路径可用）。
2. **`[live]` 的 encodeCwd 判据**是否会误判（例如用户 cwd 路径恰以 `--` 结尾）。实施时用真实路径集合回归；若误判，改用「该目录的父目录名为 `sessions`」作判据。（✅ 已消解：roots.test 真实形态用例 + Gate B P-6 活体确认，台账见 impl-plan 残留风险节）
3. **`SessionManager.listAll` 的实测成本与合并语义**。**已由源码核定**（第 3 轮修订）：只扫一层平铺目录、不递归（`session-manager.js:550-556`）；每文件全量解析、读到 EOF（`:443-511`）——§6.6 据此已定为惰性 + 窄化 + 缓存。**仍需实测**：(a) 真实目录上的单次耗时（对照先例 530 文件 667ms，`docs/2026-08-10-cwd-popup-redesign.md:190`）以校准 TTL 量级；(b) 多目录结果的重复 id 合并规则；(c) `name` 在旧 session 上的缺失率。**降级**：任一项不达预期即回退到纯 TS 首条 user 读取（U11 的降级路径），标题检索降级为不可用而非错误。
4. **`find` 扫多根的耗时**。纯 pi 下单根 4619 文件，`find` 已有全量首行扫描。新增 `[legacy]`（通常不存在）应 <1ms（§12.1 P-8 实测登记）；若 `find` P50 劣化超 20%，考虑首行扫描改并发（当前为串行 `for`）。
5. **uuid 归一化的误命中面**。`norm` 匹配（小写 + 去连字符）会把「8 位 hex 但语义是别的东西」的 query 也纳入 uuid 匹配。**对比基线写死**：与现状（精确子串 + `looksLikeUuidFragment` 无回退）对**同一组 query** 比命中数与召回类型，二者做差；增量仅限「大小写/连字符变体」（`looksLikeUuidFragment` 改用 `norm(query)` 是等价变换——`/i` 已忽略大小写，去连字符不扩字符类），预期无召回回归，实测确认。**唯一非等价差异（实施期实装核对，照抄 `find.ts` `looksLikeUuidFragment` 注释措辞）**：纯连字符 query 归一化为空串后不再判 uuid 特征——现状 `/^[0-9a-f-]+$/i` 会判其具备 uuid 特征而跳过关键词回退，新版归一化后为空串则走关键词回退（精确子串层已先处理它，此处语义更准确），行为更合理；对差基线时该形态的召回差异属预期，不计为回归。
6. **`PI_CODING_AGENT_SESSION_DIR` 注入后的实际效果与继承面**。活体 `ps eww` 确认可见（§12.1 P-3）；pi 未因 `--session-dir` 与 env 同时存在而行为异常（按 `main.js:530-533` 的 `??` 链 argv 优先，行为应不变——实跑确认）；V7 的 bash 派生类落盘位置与 §6.5 声明一致。
7. **legacy 根非空的机器**。§4.2 注二指出两条迁移链都可能产生「legacy 非空」：① 纯 pi 的 `~/.pi/sessions`（pi `migrations.js` 残留）——**在候选根内**；② xyz-agent 的 `~/.xyz-agent/sessions`（`pi-maintenance.ts` 残留）——**不在候选根内**（候选根是 `dirname(agentDir)/sessions` = `~/.xyz-agent/pi/sessions`）。需分别构造回归「非空即纳入候选 + doctor 告警」路径，并确认不会与 `[default]` 形成大量陈旧重复条目；对 ② 裁决「是否补第四候选根」或「显式声明不覆盖及原因」。
8. **relay / 其他 runtime 派生链是否带 `--session-dir`**——**已核**（第 2 轮复审补充实测）：relay 链带（`session-runner.ts:1149` → `relay.mjs:163` → `relay-registry.ts:374`），与 §6.5 表第一行同判定；本仓全部 `pi --mode rpc` spawn 点已穷举（`rpc-client.ts:289` / `session-runner.ts:1149` / relay 经帧 argv 透传），无遗漏。
9. **`doctor` 的 token 与墙钟成本**。输出含 4–5 个根；「扫描耗时」若使输出超预算则折叠为可选参数；墙钟上界受 §6.3 的 subagent 根默认不扫约束，需实测确认。（✅ 已消解：subagent 根默认不扫，Gate B 活体 doctor 秒级返回，台账见 impl-plan。v9.8 修订：原「根扫描缓存约束」已随 ext-simplify-04 U3 删除缓存机而失效——Gate B 秒级返回本就未依赖缓存命中，无缓存形态的耗时复验归 ext-simplify-04 S4。）
10. **手工迁移脚本的 header 覆盖率**（方案 B）。`~/.xyz-agent/pi/sessions/` 首测 14 文件中 3 个无 `session_info`（2026-09-10 复测存量 9 个，期间有清理）；迁移依赖的是首行 `session` header 的 `cwd` 字段——需实测全部存量文件的首行 cwd 覆盖率（决定 `_migrated-no-cwd/` 的占比），并确认 pi 对 `_migrated-no-cwd/` 这类非 encodeCwd 形态子目录的 `listAll`/resume 行为（源码看是「任意子目录均枚举」，`session-manager.js:1306-1318`，需实跑确认）。
11. **`--extension` 恒传断言**（方案 B / §6.12 前提）。需实测 xyz-agent 所有 spawn 路径上 `options.extensionPaths` 非空（mandatory 18 包理论恒传）；若存在零 extension 形态，reap 该次漏收（fail-safe 可接受）但清单文件仍须写入。
12. **app 侧扫描对「全子目录」形态的兼容**（方案 B，v7 全收敛）。源码已判定：会话列表 `scanPiSessionsFromDisk`（`session-file-utils.ts:1015-1058`）根层 + 一层子目录都扫 → **兼容**；`import-service.ts:252` 已写 encodeCwd 子目录 → **兼容**；`usage-stats-service.ts` 单层扫描 → **确定破坏**（已列 U15① 改造为两层——两层即够，pi 只写一层 encodeCwd，`_migrated-no-cwd/` 与改造后的 fork 也都是一层）；`session-fork.ts` 写平铺 → **确定不一致**（已列 U15③ 改造）；`background-task-reaper` 扫 `<agentDir>/base-tool-enhance/`（agentDir 派生，与 sessions 形态无关）与 `workflow-extractor`（按传入文件路径解析、不枚举目录）→ **兼容**（第 5 轮影响面复审源码核实）。
13. **手工迁移与运行中 pi 的竞态**（方案 B，v9.1 收敛）。脚本步骤 0b 前置检查运行中进程并 fail-fast——pgrep **-f 固定模式清单**（pi 二进制路径形态 / relay.mjs / TaiJi.app / runtime node 入口；node 脚本进程 comm = `node`，不带 `-f` 会全漏），模式清单随迁移报告打印；**不依赖用户先验自证**（v9 初版把失效信号定为「用户明知有进程而脚本报 0」——被击穿：孤儿 pi 恰是用户不知道的进程；v9.1 改为脚本自检「本机 pi 二进制路径命中模式清单」命中才继续）。dev/prod 同跑靠数据目录隔离（天然安全）。残余面（已接受）：模式清单外的进程形态漏检 → 其 fd 写入留在备份内、续传重跑不补该部分——fail-safe 方向（宁漏不破坏），doctor 备份标注兜底可见。
14. **B 后新版对空 `agent/` 的自举行为**（方案 B，v9.1 新增）。「先升后迁」合法兜底时序的前提 = 新版能在 `<dataDir>/agent` 为空/缺失时自举（models.json 谁创建、pi 能否起、xyz-agent 模型体系从哪读——§1.3 记载的 `77f006420` 事故正是 agentDir 无 models.json 致 pi 起不来的同形态前车之鉴）。⛔ 实施期门：tmp 空数据目录启动新版实测自举链路。若不能自举：把「先升后迁」从「合法兜底时序」降格为「不可用时序」，U14b 指引与发布说明话术改为「必须先迁后升」，V9 先升后迁子场景改为负向判定（新版应显式报错而非静默空跑）。

---

## 12. 附录

### 12.1 探针清单（准则 7：运行时断言必须附探针）

| 编号 | 断言 | 探针 | 状态 |
|---|---|---|---|
| P-1 | `findSessions('01a08a6e', '~/.xyz-agent/pi/agent')` 返回 0 命中（现状根因复现） | `npx tsx ./probe-find.mts`（§12.2） | ✅ 已测（0 命中） |
| P-2 | 修复候选集后 `family` 仍抛 not-found（证 §6.8 必要性） | 对 `buildFamilyFromFs('01a08a6e-74fc-…', '~/.xyz-agent/pi/agent')` 探针 | ✅ 已测（THROW，文案见 §6.8） |
| P-3 | xyz-agent spawned pi 进程 env 含 `XYZ_AGENT_EXT_LOG=1` | 主探针 = **会话内 bash `env` 自读**（bash 工具读自身 env，不受 SIP 限制，恒可靠）；`ps eww -A \| grep -o '…'` 为 best-effort 旁证——本仓 `reap-orphan-pi.ts:12-14` 在案记录「macOS 上 `ps eww`/`launchctl procinfo` 因 SIP 拿不到他进程 env（探针否决）」，本机当前实测可见（6 进程 `=1`）属机器/权限差异，**不可作为依赖通道** | ✅ 已测（6 进程 `=1`） |
| P-4 | 四根文件数（xyz-agent prod / dev / 纯 pi）+ 主 session 标题覆盖率 | 见 §4.2 表；`grep -c '"type":"session_info"'` 逐文件 | ✅ 已测（14 文件中 10 个含 `name`） |
| P-5 | `PI_CODING_AGENT_SESSION_DIR` 被 pi 消费（优先级链） | 主探针 = P-3 同款**会话内 bash `env` 自读**（`ps eww` 仅 best-effort，见 P-3 的 SIP 在案否决） | ✅ 源码已核；⛔ 实施期用 env 自读确认 |
| P-6 | `ctx.sessionManager.getSessionDir()` 在 RPC 模式返回主 session 根 | 在 xyz-agent RPC 子进程内打印该值 | ⛔ 实施期门（§11.1） |
| P-7 | bundle 为 ESM 且保留 `import.meta.url` | `scripts/bundle-extensions.mjs:276(format:"esm"),283(注释)` | ✅ 源码已核；⛔ 实施期在打包产物内确认 |
| P-8 | uuid 归一化盲区（大写 / 去连字符 → 现状 0 命中）+ 多根扫描耗时增量 | 对真实 14 主 session 构造候选集跑 5 种 query 形态；`performance.now()` 包裹多根扫描 | ✅ 已测（大写 0、去连字符 0，见 §3.3 表）；⛔ 多根耗时实施期登记 |
| P-9 | 自写 `session_info` 深读的成本（证 §6.6 否决理由） | 抽样对比「读到首条 user」vs「读全文」的字节量 | ✅ 已测（~170x 放大，2.7GB 最坏量级） |
| P-10 | pi 无 `--agent-dir` flag（否决 §6.12 备选） | `grep -n "agent-dir" node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js` → 零命中 | ✅ 已测 |
| P-11 | 存量主 session 首行 header 的 cwd 覆盖率（§6.11 手工迁移分发依据） | 对 `~/.xyz-agent/pi/sessions/*.jsonl` 逐文件读首行统计 | ⛔ 实施期门（§11.10） |
| P-12 | 手工迁移脚本幂等三态：完整成功后重跑全跳过；步骤 1 后中断重跑续传完成；先升后迁分域并道无覆盖丢失 | tmp 目录复制真实布局 → 重跑 / 步骤 1 后中断注入 / 构造 `agent/` 已存态再跑 | ⛔ 实施期门（V9⑥⑦） |

**P-6 失败的降级路径**：`[live]` 根被跳过，发现层退化为「`[env]` + `[default]` + `[legacy]`」三根并集——在三个已知宿主的实测布局下这三根已完备（§4.2），故 P-6 失败**不阻塞** M0 交付，只降低「跟随宿主」的长期健壮性。

### 12.2 复现探针（可重跑）

```bash
cd <repo>/extensions/universal/session-reader
cat > ./probe-find.mts <<'EOF'
import { findSessions } from './src/discovery/find.js'
import { listMainSessions, listSubagentSessions } from './src/discovery/roots.js'
const agentDir = '/Users/zhushanwen/.xyz-agent/pi/agent'
console.log('main:', (await listMainSessions(agentDir)).length,
            ' sub:', (await listSubagentSessions(agentDir)).length)
for (const q of ['01a08a6e', '01a08a']) {
  const r = await findSessions(q, agentDir, { limit: 100 })
  const by: Record<string, number> = {}
  for (const m of r.matches) by[m.source] = (by[m.source] ?? 0) + 1
  console.log(`find(${JSON.stringify(q)}) ->`, r.matches.length, by)
}
EOF
npx tsx ./probe-find.mts
# 实测输出：main: 2  sub: 1330
#          find("01a08a6e") -> 0 {}
#          find("01a08a")   -> 34 { subagent: 34 }
```

> 探针为临时诊断脚本，用完删除（不随 git 跟踪）。

### 12.3 关键事实核验表

| 事实 | 权威源 | 核验方式 | 登记去向 |
|---|---|---|---|
| 主 session 根 = `<agentDir>/sessions` | `src/discovery/roots.ts:84` | 读源码 | — |
| pi 默认布局 = `<agentDir>/sessions/<encodeCwd>` | `dist/core/session-manager.js:242-247` | 读源码 | U6 登记 |
| session 目录优先级 `--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > settings | `dist/main.js:530-533` | 读源码 | U6 登记 |
| `ENV_SESSION_DIR` 变量名 = `PI_CODING_AGENT_SESSION_DIR` | `dist/config.js:406` | 读源码 | U6 登记 |
| xyz-agent 用 `--session-dir <dataDir>/pi/sessions` | `rpc-client.ts:289` + `pi-paths.ts:105-107` | 读源码 | — |
| `getAgentDir()` 读 `PI_CODING_AGENT_DIR` | `dist/config.js:420-426` | 读源码 + `node` 实测（无 env 时返回 `~/.pi/agent`） | — |
| `XYZ_AGENT_PACKAGED` 不可用（被剥） | `packages/shared/src/spawn-env-contract.ts:30` | 读源码 + 活体 ps（唯一持有者为 Electron 主进程，无 pi 子进程持有） | — |
| `XYZ_AGENT_EXT_LOG=1` 在 pi 进程 env，但可被 shell 透传污染 | 活体 `ps eww` 实测 + `constants.ts:74`（`XYZ_` 前缀在入站白名单） | 已测 + 读源码 | — |
| `ExtensionContext.sessionManager` 非 mode-gated | `dist/core/extensions/types.d.ts:209-219` | 读源码 | U6 登记 |
| `ReadonlySessionManager.getSessionDir()` 存在，且 `--session-dir` 覆盖时返回根本身 | `dist/core/session-manager.d.ts:140,205` + `session-manager.js:1179-1180` | 读源码 | U6 登记 |
| `SessionManager.listAll(dir)` 返回 `SessionInfo{name,cwd,firstMessage,…}`；**语义 = 扫一层平铺目录（不递归）+ 每文件全量解析（读到 EOF）** | `dist/core/session-manager.js:550-556`（`listSessionsFromDir` 单层 readdir）、`:443-511`（`buildSessionInfo` 全量）、`:1292-1325`（双分支）；`session-manager.d.ts:125-138,353-354`；本仓 `hash-provider.ts:2,139,157-159,161` | 读源码 | U6（成本形态随 ④/⑤ 一并登记） |
| 主 session 含 `session_info.name` 标题 | 真实 jsonl + `rename-session/src/index.ts:79`（`pi.setSessionName(title)`） | 已测（10/14 文件命中） | — |
| bundle 为 ESM，`import.meta.url` 保留 | `scripts/bundle-extensions.mjs:276,283` | 读源码 | — |
| 双仓事实：npm 0.2.4 = 本仓 extension 的发布快照；`~/Code/pi-session-reader` 是 private 的 `-cli@0.1.0` CLI 派生仓 | 两仓 `package.json` + `~/.pi/agent/settings.json` + 安装副本源码比对 | 已测 | §6.9 / U13 |
| pi 支持 `pi update <source>` 单包更新到最新（U13② 的装机更新通道） | `pi update --help` 实测（"Update one package"；`--extension <source>` 等价形态） | 已测 | §6.9 / U13 |
| skill 映射表写死 10 action，symlink 指向 CLI 仓 | `~/.agents/skills/pi-session-reader` → `…/pi-session-reader/skills/pi-session-reader`，`SKILL.md:63-70` | 读源码 | §6.9 / U13 |
| pi 现版 sessions 在 agent 内：`getSessionsDir() = join(getAgentDir(),'sessions')` | `dist/config.js:456-458` | 读源码 | U6 ⑤ |
| pi 曾改过布局：v0.30.0 session 误存 `~/.pi/agent/`，后迁 `agent/sessions/<encoded-cwd>/` | `dist/migrations.js` `migrateSessionsFromAgentRoot` 注释（自述 Bug in v0.30.0，issue pi-mono#320） | 读源码 | U6（布局沿革事实） |
| 本机 `~/.pi/sessions/` 为空残壳、4619 个真实 session 在 `~/.pi/agent/sessions/<encodeCwd>/` | 实机 `ls` / `find` 统计 | 已测 | — |
| pi **没有** `--agent-dir` CLI flag（独立 CLI 仓的同名 flag 是其自建，非 pi 实装） | `dist/cli/args.js` grep `agent-dir` 零命中 | 已测 | — |
| reap 判据 = argv `--session-dir` 精确相等 + ppid=1；env 判据被 SIP 探针在案否决 | `reap-orphan-pi.ts:12-27`（文件头注释 D4a/D4b）、`:147-160` | 读源码 | §6.12 |
| `~/.xyz-agent/pi/` 根层只含 `agent/` + `sessions/` 两个子目录（prod）；dev `pi/` 顶层另有 2B 空壳 `auth.json`/`models-store.json` 与 37B `settings.json` 残片（真身在 `pi/agent/` 同名文件，size/mtime 实测对比） | 实机 `ls` + `stat` | 已测 | §6.11 |
| provider 三件套顶层形态（keyed union 的域锚点依据）：auth.json = 顶层 keyed（providerId → dict）；models.json = 顶层单键 `providers`（keyed 域在 `.providers`）；config/providers.json = 顶层 `{version:int, providers:dict, scopedModels:list}`（keyed 域在 `.providers`，另有非域键） | 实机 prod `~/.xyz-agent/pi/agent/` 三文件 python json 解析 | 已测 | §6.11 |
| providers.json 的 `version` 当前恒 1（写侧 `provider-extras-store.ts:26,52`），读侧唯一消费 = 合法性校验（≠1 → `quarantineCorruptFile` 隔离重置，`:143-147`），无版本分派逻辑——域外伴随字段取侧等价、失配面有界 | `packages/runtime/src/services/provider-extras-store.ts` 读源码（第 10 轮影面审终验核证） | 已测 | §6.11 |
| xyz-agent 恒以 argv 传 18 个 mandatory extension 的 staged 路径（`--no-extensions` 恒带且只禁自动发现、显式 `--extension` 仍生效——pi help 原文 `dist/cli/args.js:294`）；**但 argv 同时也混有用户配置来源的路径**（活体实测 `~/.pi/agent/extensions/…`、项目 `.pi/extensions/…`、`~/.agents/skills`）——「用户 extension 不进 argv」被该实测证伪 | `rpc-client.ts:269,203-215` + `mandatory-extensions.json` + 活体 `ps -A -o pid,command` | 读源码 + 实测 | §6.12 |

### 12.4 变更历史

- v9.8（2026-09-14，ext-simplify-04 U3 doctor 根扫描缓存机删除 + A2 顺带）：①§6.3 成本控制行——「对已扫过的根做根扫描缓存、重复调用不重扫」方案删除（subagent 根默认 `'stat'` 后缓存保护的已是便宜化路径），subagent 根默认不扫保留；②§7B 要点 8 改写——「仅 doctor 重复调用共享根扫描缓存 / find 一律不读缓存」机制整体退役，`resolveSessionRoots` 每次实扫，原 PS-14 防污染规则（该缓存存在才需要存在）随之失效，进程内仅剩 u11 标题元数据 TTL 缓存（§6.6）；③§9.1 M2 行与 §10 U8 行的缓存交付物删除；④§11.9 半句修正——Gate B 秒级返回未依赖缓存命中，无缓存形态复验归 ext-simplify-04 S4。代码面：`DoctorCacheEntry`/`doctorScanCache`/`doctorRootCache` 与 `SessionRootCache`/`SessionRootCacheEntry`/`ScanOptions.cache`/`SessionRoot.cached` 全链删除（renderDoctor「缓存命中」行随之消失）；`statDirMtimeOrNull` 与 TTL 常量迁 tool-handler（metadata 缓存独占，`METADATA_CACHE_TTL_MS` 独立定义 5000 不再别名）；同批顺带 A2——`formatSessionNotFound` 窄化 `subagents:'stat'`（该路径只渲染 main 根行，不再深扫 subagent 根）。执行台账见同目录 impl-plan 变更历史同日条目。
- v9.7（2026-09-11，design-code-sync 第 1 轮 code-right 修复）：①四处消费点补 B 先行收缩标注（§6.1 `[env]` 信号、§6.8 顶部状态 banner、§7B kind 枚举「B 收缩后无 'env'」、§10.1 subagents.ts 行改「not-found 文案列实际候选根（U7 其余不建，§6.13）」——正文此前仅在 §6.13 收缩表与 §10 U4/U7 行声明收缩，消费点未同步属漂移面）；②四处悬空章节引用勘正（原引用指向 §7 下不存在的编号小节，§7 实体系 = 7A/7B 要点列表：降级相关 3 处改 §7B 要点 2、薄包装 1 处改 §7B 要点 7）；③§11.5 补唯一非等价差异（纯连字符 query 归一化为空串后不再判 uuid 特征 → 走关键词回退，与 `find.ts` `looksLikeUuidFragment` 实装注释对齐）；④§7B 数据流图与 §10.1 tool-handler 行补 Gate A 回流拆分落点注记（doctor → `doctor.ts`、F1/`formatNoMatch` → `no-match.ts`、跨会话与 search 管线 → `search-across.ts`、extract 预设 → `extract.ts`、低层工具 → `handler-utils.ts`，tool-handler 留守编排 + re-export）；⑤§6.4 代价面补「u12 search 跨会话用法三处 description 扩写（D-17③）与 doctor `includeSubagents` 参数为已登记增量」；⑥§6.12 登记规则②扩双 dev 形态（dev 资源根 + dev 源码根 `<repoRoot>/extensions/<group>/<pkg>`，D-11 勘误）+ 原理性极限段补 node 形态 pi `process.title='pi'` 吞 ps argv 观测面的实机备案（runtime 经 `piCommand` 注入 bun binary 不受影响）。
- v9.6（2026-09-11，Gate B 实测驱动的 doc_error 修正）：V5b 行与目标 4 范围注记随 B 后布局改写——§6.6 策略 2 的「平铺主根」前提被 §6.10 布局对齐结构性取代（B 去 `--session-dir` 后 pi 自动按 cwd 分 `<encodeCwd>/` 子目录，主根不再平铺），标题维度按策略 2 对两种宿主同规则不覆盖、find 命中归因首条 user、标题可见性由 search 通路承载（Gate B 组 1 活体证据：search 输出 name 正确、find 命中归因首条 user 原文）。原 V5b「标题来自 listAll name 的 find 命中」系 B 前世界形态未随 §6.10/§6.13 收缩更新，属设计内部漂移。
- v9.5（2026-09-11，阶段 3 一致性审查 B 区 doc_error 修正 + reasonable 同步）：①V3 TaiJi 期望的 `[legacy]` 子句改 B 后形态（B 前世界才与主根同路径去重，§6.13 收缩表漏更面）；②V4 ③ 计数措辞对齐 §5.2 四行形态；③§7B 要点 2 补 try/catch 调用抛错降级加固句（实施期加固，防后人删 catch）；④§6.7 子决策 1 澄清两级匹配为回退关系（消除「命中排最前」合并排序歧义）；⑤§6.1 legacy 告警引文标注为示意并同步实装文案。
- v9.4（2026-09-11，实施期同步）：§7A 图残留探测行补 v9.2 形态判据（「且含 agent|sessions 子目录」，图系 v9 初版措辞残留，与 §6.11 正文及 pi-maintenance.ts 实装不一致——阶段 3 审查 A 区 doc_error 修正）。
- v9（2026-09-10）：用户两问驱动的修订（迁移触发判断简化 + 双仓漂移升级为执行范围）：
  1. **§6.11 由「首启自动迁移 + 四守卫状态机」收缩为「一次性手工迁移脚本（U14a）+ 启动残留探测（U14b）」**——用户确认无外部用户（存量集合封闭 = 本机 prod/dev 两目录，主 session 复测 9 + 36），自动迁移对未来装机是永不触发的死代码；六步数据语义保留，触发改人工一次性（推荐「先迁后升」，「先升后迁」走步骤 2b 并道分支——初版统一旧赢新避让，第 7 轮改分域规则，见第 4 条）；v5–v8 的守卫矩阵、`.pi-migrating-v2` 暂存、`.pi-layout-v2.done` 完成标记、ENOTEMPTY 双保险、前置 reap 双候选（`LEGACY_PI_SESSIONS_DIR`）、file-lock 并发守卫、vitest 环境守卫整机退役入被否谱系；`syncBundledResources()` 回归直挂启动。
  2. **§6.9 重写为三副本表**（① 本仓 extension 权威源 0.4.0 ② 纯 pi 装机副本 0.2.4 ③ CLI 派生仓 0.1.0 + skill symlink），漂移影响与「只发版到不了装机」机理写实；**U13 由「登记待办」升级为 M5 执行单元**（npm 发版 → `pi update @zhushanwen/pi-session-reader` 装机更新 → CLI 仓重平移 + `doctor` 子命令 → SKILL.md 计数 10→11/映射表补行）；`pi update <source>` 单包更新实测入事实表。
  3. 联动同步：一句话结论/SCQA/In-scope、§6.10 对比表、§6.13 收缩表（§6.11 锚点改 U14b）与退路措辞、§7A 图（迁移移出启动路径；reap 删前置双候选帧）、§8.1、V1（主 session 计数勘误：首测 14 → 复测 9，期间有清理）、V9（改手工触发 + 两条时序 + 判定⑥⑦⑧）、新增 V11、§9.1 增 M5 行、§10（U13/U14 重写、U18 豁免表 LEGACY 常量 → 脚本本体、U6 步骤引用、文件地图 pi-maintenance 行重写 + `scripts/migrate-pi-layout-v2.mjs` 新行）、§11.10/§11.13、P-11/P-12。
  4. **第 7 轮双审修复**（主审 3 MF + 2 SG；影面审 2 MF + 4 SG——两方在「中断重跑被出口吞」与「并道记录域失明」独立收敛，互为印证）：①步骤 0 改三判前置（实参形态校验防误传资源布局目录 / pgrep -f 固定模式清单 + 脚本自证 / pi+backup 三分支），**新增续传分支**（pi 不存在但 `pi.backup-v2-*/` 存在 → 幂等重入，堵住中断态被「无需迁移」吞掉、数据滞留备份的缝隙）；②并道分支改**分域规则**（记录型子树 sessions/subagents/workflow-state 文件级并入防窗口期增量失明；凭据类新赢旧避让防工作凭据被过期旧凭据静默覆盖；偏好类旧赢；冲突清单逐文件进报告）；③U14b doctor glob 写明基点 `dirname(agentDir)` + 判据收紧（`pi/` 含 agent\|sessions 形态，防纯 pi `~/.pi/pi/` 误报）+ 窗口期双面失明与 WARN 仅日志通道的代价显式声明；④§6.9 处理 3 CLI 重平移精确化（双向 diff、CLI 本地 15+ commit 保留、LINEAGE.md 基线更新义务）+ 处理 5 发版 notes 迁移指引；⑤V9 扩四条时序与判定⑥-⑨、V11④ 等价性语义明确、§11.13 重写（失效信号自证化）+ 新增 §11.14（B 后空 agentDir 自举实施期门）、U14/M5 行同步、备份清理指引落点 troubleshooting.md。
  5. **第 8 轮修复**（主审 1 MF + 1 SG；影面审 0 MF + 2 SG——影面判「设计就绪」）：①**provider 三件套（auth/models/config providers.json）由 v9.1 分域改 keyed-by-providerId 逐 key union**（同 key 新赢 + 防御式降级）——主审反例：三件套被拆到相反方向时窗口期新增自定义 provider 产生「定义在凭据不在 + 凭据在定义不在」交叉失配，比统一旧赢更隐蔽；keyed union 与 v6/v8 否决的「内容级 merge」显式区分（结构性逐 key 操作 vs schema 级整体合并）；②续传备份选取判据由 mtime 改**备份名内嵌 ts 最大**（一手数据源，消除隐式推演链）；③窗口期双面失明代价补「重审触发条件」第四要素（残留普遍持续超周级 → WARN 升级为启动 UI 提示）；④runtime WARN 判据与 doctor/脚本 0a 对齐（同「pi/ 含 agent\|sessions 形态」，消除指引-拒跑死锁）；⑤迁移报告补「旧备份清单」（复合态残部不被任何分支消费，报告是唯一信号）；⑥dev 目录实参校验误杀修复（存在性判据替代「仅含」）+ 顶层残片实测登记（2B 空壳 auth.json 等，真身在 pi/agent/，不迁移进报告清单）。
  6. **第 9-10 轮修复**（两审在 keyed 域锚点上再次独立收敛——影面审第 9 轮实机证伪 + 主审终验同发现）：①**keyed union 域锚点勘误**——v9.2「三件同为顶层 keyed map」前提与实机不符（仅 auth.json 顶层 keyed；models.json 顶层单键 `providers` 嵌套；config/providers.json 顶层含 version/scopedModels 非域键），按字面实施 models.json 交叉失配复活、providers.json 恒定降级；v9.3 锚定真实域路径（auth 顶层 / models 与 providers 在 `.providers`），V9⑦ 场景 X/Y 用例分别构造在三个文件上，形态实测入事实表；②**域外伴随字段裁决取新侧**（主审建议）——运行时是新版代码在读该文件，新侧 version/scopedModels 与其 schema 自洽；影面审的旧赢建议被「version 旧赢使新版代码读到过期 schema 号」否决，裁决入档；scopedModels 取新不做并集（覆盖型条目语义风险）；③**降级方向改按健康侧选向**——v9.2「一律旧赢+新避让」在旧侧解析失败时把坏文件赢进主位（自相矛盾），改「旧侧坏→新赢 / 新侧坏→旧赢 / 双侧坏→不动报人工」；④**不捆绑降级裁定入被否谱系**（部分降级最坏 = 轻度单向失配，是 v9.1 损伤面真子集、清单有痕；捆绑会放大单文件故障）+ 三件套任一降级时的报告搬回指引；⑤union 写回补 tmp+rename **原子写**声明 +「旧侧完整文件留备份、不产中间态」。
- v8（2026-09-10）：第 6 轮收尾复审——**两方均判 0 must-fix，设计就绪**。双方各 1-2 条 SG 已当轮修完：①守卫 0a 补「且 pi 不存在」条件（关闭「迁移中途崩溃 + 旧版回装重建 pi/ + 再装新版」三重叠加态被续传静默吞增量的状态矩阵缝隙）+ 续传改「跳过步骤 1；步骤 2 幂等执行」（关闭「两条相邻 rename 之间崩溃」窗口下配置域被错埋进备份的缝隙）；②U18 字面量模式排除 `.pi` 前缀（系统 pi 家目录 `~/.pi/agent` 子串含 `pi/agent`，不排除则首跑 ≥6 处合法引用大面积误报）；③形态③折中论证措辞按主审 INFO 精确化。
- v7（2026-09-10）：第 5 轮聚焦复审（主审 1 MF + 4 SG；影响面审 3 MF + 5 SG——两方在 dev staged 缺口、前置 reap 判据断链、pi+agent 并存态三处独立收敛，互为印证）：
  0. **`--no-extensions` 判别位自洽确认（主审，源码+活体双证）**：pi help 原文「Disable extension discovery (**explicit -e paths still work**)」——只禁自动发现，显式 `--extension` 不受影响；活体 4 个 TaiJi pi 全带 `--no-extensions` + 23 个 `--extension` 且工具正在其中运行。「恒带」与「staged 生效」两前提互不矛盾。
  1. **§6.11 前置 1 重写（影响面 MF-A = 主审 SG-B）**：v6「迁移前 reap 用旧判据」不成立——旧判据期望值由 `getSessionsDir()` 代码推导（B 版返回新路径 ≠ 孤儿 argv 旧值）、新判据清单在首个 spawn 前不存在，两条路径都收不了。改「迁移模块导出 `LEGACY_PI_SESSIONS_DIR` 常量 + reap 期望值双候选精确匹配」；§11.13 补「前置 reap 收殓数落日志」可观测判定；§7A 同步。
  2. **退役范围拆分（影响面 MF-B）**：`migrateToPiSubdir` 的 `isPackaged()` bundled 同步段（`pi-maintenance.ts:107-126`，全仓唯一 skills 同步点）保留为独立 `syncBundledResources()` 挂 aligned 入口（覆盖全新安装出口②）；仅目录迁移段退役——v6「整体退役」会让打包版首装缺 pi 技能。
  3. **U18 守卫改独立检查器（影响面 MF-C）**：v6 拟挂的 `check_path_whitelist.py`（TARGETS 单文件）与 `check-pi-sync.mjs`（版本锚点）均无字面量扫描能力，照挂即假防护；改为显式文件范围 + 字面量模式 + **集中豁免常量表**（`LAYOUT_LITERAL_EXEMPT`，含 v6 漏列的 `find-pi-executable.ts:47` bundled pi 二进制——漏列则打包版起不了 pi）+ pre-commit 新钩子。
  4. **白名单登记规则补 dev 形态并收紧（主审 MF-5 = 影响面 SG-2）**：builtin staged 根三形态（打包资源根 / **dev 仓库资源根** `<projectRoot>/apps/electron/resources/extensions/`——漏掉则 dev 清单恒空、dev 孤儿全漏收且无报错 / `<dataDir>` 下 ExtensionResolver 管理的 `extensions/`+`npm/` 子树）；用户配置来源一律排除。主审第 6 轮评估该折中**可接受、不必强制收紧到仅 mandatory**（mandatory 恒传使形态①②值恒在孤儿 argv，排除形态③实际几乎不损失收殓面、净效应≈纯安全收益；保留的理由是这些路径同样是 xyz 自己传的，语义上并不更「正确」）。V10① 补 dev 正向子项。
  5. **守卫加第 0d 分支 + ENOTEMPTY 双保险（影面 SG-1 = 主审 SG-C）**：「迁移完成 → 装回旧版产生增量 → 升回新版」的 agent+pi 并存态原先无定义（步骤 2 rename 撞非空 agent/ 即 ENOTEMPTY）；显式策略 = 不自动迁移 + doctor 持续告警 + 人工处理指引；步骤 2 另对 ENOTEMPTY 加 catch 转显式自救文案。
  6. **事实勘误（主审 SG-A）**：活跃 subagent 的 ppid = **主 pi pid**（subagent 由主 pi 进程内的 extension spawn，`argv-mirror.ts:60-64`），非 runtime pid；结论不变（ppid≠1 不杀），孤儿 subagent 收殓为两轮时序，V10③ 校准。
  7. **判据原理性极限声明（主审 SG-D）**：完整复制 xyz pi argv 重跑的进程与真孤儿在判据维度同形，原理上不可区分——接受极限，不为此加机制。
  8. **§11.12 全收敛（影响面 INFO）**：background-task-reaper（扫 agentDir 派生目录）与 workflow-extractor（按文件解析不枚举）源码核实兼容，撤除实施期实测项。
- v6（2026-09-10）：第 4 轮（方案 B 专项，主审 4 MF + 影响面 7 MF，去重后 9 条独立）全量修订。**两个预设攻击点被双向裁决**：pi 子进程 cwd 链（rpc-client→process-manager→session-lifecycle→pi main.js→getDefaultSessionDir）实测成立，B 默认派生可行；pi 家级足迹为零（dist 全量 grep），`agent/` 上移不与根层冲突。修复：
  1. **§6.12 reap 判据改双层**（`--no-extensions` 存在 + 白名单清单只登记 staged 专属路径）：活体进程证据击穿 v5 的「用户 extension 不进 argv」假设（TaiJi argv 实测混有 `~/.pi/…` 用户路径，AGENTS.md 实测命令模板本身带 `--extension`）；补清单写语义（全量重算覆盖 + 原子写）与收殓范围扩大声明（孤儿 subagent 从不收变收）。
  2. **§6.11 迁移三处修复**：幂等出口①与续传承诺的矛盾（守卫 0a 续传模式 + 完成标记为唯一完成判据）；`migrateToPiSubdir` 的 mkdir 前置撞步骤 2 rename（ENOTEMPTY，存量机首启即崩 → 旧函数退役）；sidecar 白名单改前缀匹配（实测存在 `.handoff.json` 第五种）+ 遍历声明递归（dev 实测存在 `--private-tmp--/` 子目录）。
  3. **迁移前置条件新增**：先跑一次 reap（旧判据此刻仍可用，消除孤儿持旧路径 fd 的竞态）；顺带清除 `settings.json` 的 `sessionDir` 静默覆盖位；vitest 环境守卫。
  4. **U15 扩为「SSOT + 三个非派生消费方」**：usage-stats 单层扫描（B 后统计归零）、`getPiGlobalAgentDir` 向上 3 层推导（B 后多走一层，`cleanLeakedPackages` 静默失效）、`session-fork.ts` 写平铺（pi 原生枚举不可见，与 import-service 形态分裂）；清扫清单补 2 个脚本 + 1 注释，并建「数据布局清 / 资源布局豁免」两栏。
  5. **U18 新增**：constraints.json 布局对齐契约登记 + 字面量回流守卫（一次性清扫无守卫必回流）。
  6. **A 侧三处判据漂移同步**：§6.2 环境判定形态（B 后 `<*>/.xyz-agent*/agent`，双形态兼容）；§6.13 `[legacy]` B 后语义（`<dataDir>/sessions` 旧旧布局，备份走 doctor 独立 glob）；§5.3 目录树按实机修正（根层实际为 attachments/engines/…，非 SSOT 注释所列）+「对齐 = agent/ 子树一层，根层不需要同构」声明。
  7. U6 登记 5→6 条（settings.sessionDir 旁路）；§11.12/13 由待实测收敛为已核+剩余项；V1/§5.1 标注 B 后路径；V10 扩四子项。
- v5（2026-09-10）：按用户拍板「布局完整对齐 pi（根修，先行）」并入**方案 B**（§6.10–§6.13 + §7A + V9/V10 + U14–U17）：
  1. **§6.10 布局对齐**：agent 上移一层、删 `--session-dir`、SSOT 改值；B1/B2/维持现状三案对比，B2（保留 flag 的路径对齐）记为降级退路。
  2. **§6.11 首次启动迁移脚本**：先原子改名备份、后分发的六步幂等流程；无 cwd 文件入 `_migrated-no-cwd/`（pi 按任意子目录枚举仍可发现）；备份保留不自动删；旧版本回装的降级行为写明。
  3. **§6.12 reap 判据替换**：`--session-dir` 删除后改 spawn 清单判据（`--extension`/`--skill` 值精确相等 + ppid=1）；`--agent-dir` argv 方案被实测否决（pi 无此 flag，P-10）。
  4. **§6.13 两方案关系**：B 先行则 A 收缩——U4/U5/U7 删除、U1 简化；B 延期则 A 按 v4 全量执行（V7 相应标为退路场景）。
  5. **§1.3 布局沿革**：`77f006420` 的镜像意图、pi 两次演进证据（v0.30.0 迁移 + sessions 收进 agent）、现布局为旧形态快照的结论。
  6. 验收增 V9（迁移正确性六判定）/ V10（reap 正反向）；检查点增 §11.10–11.13；探针增 P-10~P-12；事实表增 8 行。
- v4（2026-09-10）：第 3 轮主审聚焦复审（1 MF + 3 SG）全量修订：
  1. **keyword 匹配域规格补全（MF-1）**：§6.6 策略 2 补「含子目录被跳过 listAll 的候选**不退出 keyword 匹配**，回退现状 `readFirstUserMessageText` 首条 user 匹配（现状 `matchByKeywords` 本就对全部候选深读首条 user，成本与召回均无变化）」；§2 目标 4 明确「范围限定只针对标题维度，首条 user 维度现状能力不收缩」；§8 回归基线补纯 pi 跨项目首条 user 检索的可判定项。此前的窄化策略按字面实施会静默砍掉现状能力。
  2. **§6.5 验收行残留（SG-1）**：「`[env]`/`[live]` 两根被正确标注」改为与表格/V7③ 一致的「`[live]` 标 subagent 根、主根以 `[legacy]` 出现（`[env]` 缺席）」，并同步探针口径（env 自读为主）。
  3. **U6 登记条数（SG-2）**：§10.1 文件地图行 4→5，与 U6 justification 一致。
  4. **V2/V3 场景漂移（SG-3）**：V2 注明本环境 `[live]` = `<tmp>` 与 `[default]` 不去重；V3 的纯 pi 拆带 / 不带 `--session-dir` 两种跑法分别给判定。
- v3（2026-09-10）：第 2 轮聚焦复审（影响面审 0 MF + 6 SG；主审 5 MF + 5 SG）全量修订：
  1. **§6.6 重写（主审 MF-A）**：`listAll(dir)` 两条实装语义核定——只扫一层平铺目录不递归（`session-manager.js:550-556`）、每文件全量解析读到 EOF（`:443-511`）；调用策略改为**惰性触发 + 窄化（仅平铺目录）+ TTL 缓存**；§2 目标 4 限定范围（纯 pi 跨项目标题检索显式不覆盖）；§11.3 的「是否递归」由待验证转为源码已核。
  2. **§6.5/V7③ 更正（主审 MF-B）**：subagent pi 的 env 是 runtime 进程 env 整体继承（`session-runner.ts:1764`），U4 的 extras 不进 runtime 自身 env → subagent pi 内 `[env]` **缺席**、主根以 `[legacy]` 出现；扩展注入属范围变更须另过 C-proc-09 评审，本设计默认不做。
  3. **legacy 告警判据统一（主审 MF-C）**：三处矛盾收敛为「非空才告警」；§5.1 TaiJi 示例更正（`[legacy]` 与主根同路径去重，删除错误的 `~/.pi/sessions` 告警行）；V3 改为正反向判定 + 构造非空环境。
  4. **分组 × limit × truncated 规格（主审 MF-D）**：limit 作用于分组后合并列表、truncated 按合并总量、解析路径不受分组影响；回归基线改可判定形式（`limit:100`）。
  5. **删除 delta 链引用（主审 MF-E）**：三处「（影响面 MF-x）」改为自包含描述。
  6. **family 三腿声明（主审 SG-1）**：§6.8 补「只改 main 腿」；§6.1 补 `[subagent]` 根来源（常量推导，非信号）；§7 数据流图加注；V6 补 subagent 节点判定。
  7. **V5 拆分（主审 SG-2）**：V5a（归一化 + 分组，M3）/ V5b（标题检索，M4），§9.1 同步。
  8. **归一化验证基线（主审 SG-3）**：§11.5 写死「与现状对同一组 query 做差」。
  9. **legacy 两链区分（主审 SG-5）**：§4.2 注二区分 pi 侧与 xyz-agent 侧迁移链；§11.7 补 `~/.xyz-agent/sessions` 不在候选根的缺口裁决。
  10. **影响面 SG-1~SG-6**：relay 链已核（带 `--session-dir`，`session-runner.ts:1149`→`relay.mjs:163`→`relay-registry.ts:374`）；doctor 缓存三处矛盾统一（`find` 永不读缓存、自检行取实扫计数）；恢复通道删「reap 兜底」事实错误（reap 只杀进程不处理文件）；P-3/P-5 主探针改为会话内 `env` 自读（`ps eww` 有 `reap-orphan-pi.ts:12-14` 在案的 SIP 否决记录，降为 best-effort）；V7 补落盘观察/清理/模型来源三细节；U5 补 `toContain` 补红断言（同文件 `:42-45` 范式）；U6 计数 4→5；U9' 编号统一为 U13 + 补「npm 无版本约束、须触发纯 pi 侧重装」。
  11. **勘误**：`hash-provider.ts:9`→`index.ts:203`（19ms 语境）；`subagents.ts:63-68`→`:55`；「亚 agent 根」→「subagent 根」；§5.1 样例数量口径；`\"` 转义残留。
- v2（2026-09-10）：按两份对抗式审查报告（主审 4 must-fix + 影响面审 6 must-fix，共 10 条去重后 8 条独立 + 12 条 suggestion）全量修订：
  1. **范围补全**：`family` / `export{format:"family"}` 接入同一根列表（新增 §6.8、U7、V6）——原设计保留 `listMainSessions` 旧路径会导致修复后 `find` 命中而 `family` 抛错（实测 P-2 复现）。
  2. **事实更正**：§6.9 双仓归属（npm 0.2.4 是本仓 extension 的发布快照，`~/Code/pi-session-reader` 是 private 的 `-cli@0.1.0`，不可能发布）+ 补 skill 映射表耦合。
  3. **归一化盲区**：新增两级 uuid 归一化匹配（§6.7），修掉「大写 / 去连字符 uuid → 0 命中且被错误归因」；自检改为**事实型**、不断言「真的没有」。
  4. **成本纠偏**：元数据改用 `SessionManager.listAll`（§6.6、U11），替换 v1 的自写 `session_info` 深读（实测 ~170x 放大、最坏 2.7GB，P-9）。
  5. **契约与登记**：补 C-proc-09 forward 登记（U5）、C-proc-08 pi 语义登记（U6）。
  6. **继承面枚举**：§6.5 补 env 继承者三分类、量化、恢复通道、重审触发条件；§8 增反向场景 V7。
  7. **降级与兼容**：`ctx` 可选链 + `index.test.ts:97` 入测试地图（§7B 要点 2）；`listAll` 降级路径（§11.3）。
  8. **验收补强**：V2 环境隔离命令、V3 legacy 告警正反向、V5 归一化用例、`recent` 回归基线、`result` 短 id 不动声明。
  9. **示例校真**：§5.1 改为按实测推演并显式标注非逐字实测；`find` 按 source 分组修「subagent 噪声淹没」。
  10. **行号勘误**：`spawn-env-contract.ts:30`（原写 31）、`rpc-client.ts:195`（原写 199）、`bundle-extensions.mjs:283`（`format:"esm"` 在 276）。
- v1（2026-09-10）：首版。基于 handoff `/tmp/handoff-session-reader-fixes.md` 的缺陷清单做核验后重写——撤销 P0-2（非独立缺陷，§3.3），补入 handoff 未覆盖的环境识别（§6.4/§6.5）与标题检索（§6.6），并新增物理数据流与探针清单。
