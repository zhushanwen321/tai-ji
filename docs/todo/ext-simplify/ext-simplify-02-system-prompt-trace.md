# ext-simplify-02：taiji/system-prompt-trace 过度设计收敛（删自持久化 baseline + Like\*Event 归一）

> **一句话结论**：删除 system-prompt-trace 为「拿不到 session 文件路径」场景平行再造的自持久化 baseline 子系统（约 120 行），onSessionStart 基线解析收敛为「stash → fork previousSessionFile → getSessionFile() 直读」三档——fork 档维持现状读取路径（v5 M0 探针证伪「fork 新文件直读」后回炉定案，见 §6.1/§6.2）；Like\*Event 三接口与 SessionStartReason/normalizeSessionStartReason 归一到 pi SDK 已导出类型；顺带修复 persisted 路径 parentVersionDiffSummary 永远缺省的数据层缺口。开工前有一次 pi CLI 探针门槛验证 pi 运行时行为（⛔ M0，见 §6.5；已于 2026-09-12 执行：P1/P3 PASS、P2 FAIL 触发 D2 回炉），终态行为断言在 M2 后合入前复跑（同节）。

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-system-prompt-trace`（v0.1.5）是 xyz-agent 的 taiji 组 builtin extension——每当 effective system prompt 建立或变化时向 session JSONL 追加一条 `xyz:system-prompt` 留痕 entry，供 GUI Trace 视图与排查使用。为跨重启去重（同一 prompt 重开后不重复写），它维护一个「hash 基线」，解析路径共三路：switch stash 直读 / fork previousSessionFile 直读 / **agentDir 自持久化小文件**（`system-prompt-trace-baseline.json`，含原子写、tmp 唯一化、RMW 竞态论证、64-session 剪枝，约 120/201 行 baseline.ts）。
- **C（冲突）**：2026-09-11 过度设计审计（候选 2/11，taiji 单元）证实该自持久化层的存在前提是假的——它赌「app 重启直 spawn resume / reload 等无 switch 事件的链路拿不到 session 文件路径」，而 pi 0.84.4 的 `ExtensionContext.sessionManager`（`ReadonlySessionManager`）本就含 `getSessionFile()`，且留痕 entry 自身完整落盘 fullText，直读 session JSONL 最后一条留痕即得比小文件更强的基线（hash+version+**fullText**）。同时本包自定的 3 个 `Like*Event` 接口 + `SessionStartReason`/SESSION_START_REASONS/`normalizeSessionStartReason` 全链冗余于 SDK 已导出类型。
- **Q（问题）**：如何在不损失留痕主链路（switch 去重、version 续接、reload 去重）的前提下，删掉这个自产自销的持久化子系统与冗余类型层，并把「fork 基线语义」这个挂着「暂定，待 P2 实测定」的悬置点一并关闭？
- **A（答案）**：基线解析收敛为三档——stash（resume 主链路，保留）→ fork 档读事件 `previousSessionFile`（源文件最后留痕，维持 §1 表格记录的现状路径 2）→ `getSessionFile()` 直读 JSONL 最后留痕（覆盖 reload / 直启 resume / 兜底）；类型层全部 `import type` SDK 具名类型。一次本地 pi CLI 探针（四 reason × getSessionFile 矩阵）拆「pi 行为断言 / 终态行为断言」两段分期执行——pi 行为段在 M0 开工前，终态段在 M2 后合入前（见 §6.5）。M0 已执行（2026-09-12）：P2 证伪「fork 并入直读」（常态 /fork 时点 fork 新文件未落盘，直读 null），fork 档回退读 previousSessionFile（D2 v5 定案，见修订记录）。

**层声明**：本文档是「技术方案设计」层（下一层产物 = 可实施的代码任务 + 测试改造清单），准则 5/6/7 全适用。

**证据基线**：pi SDK 断言全部核对自本 worktree 实装 `node_modules/@earendil-works/pi-coding-agent@0.84.4` 的 dist 编译产物（npm ls 确认版本），非 clone 参照。审计报告四问全文见 taiji 单元导出（sa-dea80496）；本文化引的行号均为 2026-09-12 实读值。

---

## 1. 背景：被设计的系统是什么

**system-prompt-trace 解决的问题是「effective system prompt 的变化不可见」**：xyz-agent 的 system prompt 由多源拼装（builtin 注入、`--append-system-prompt`、skill、AGENTS.md 等），跨 turn 可能变化，但变化本身不落任何痕迹。本 extension 以 custom entry（不进 LLM context，零模型侧影响）形式向 session JSONL 追加留痕：每次建立或变化时写 `{version, hash, reason: initial|resume|change, fullText, charCount, parentVersionDiffSummary?}`，version 在 session 内单调递增。GUI Trace 视图（`packages/core/src/domain/session-trace/trace-rows.ts` 的 `summarizeSystemRow` 投影 version/reason/hash/charCount）与排查流程消费它。

「hash 基线」是去重的依据：session 重开（switch/reload/重启）时先恢复上次的 hash+version，首个 turn_start 对比当前 prompt hash——相同则不写（避免重开一次多一条重复留痕），不同则写 `resume` 并续接版本号。

关键消费链路（本次必须全部不回归的面）：

| 链路 | 入口 | 现状基线路径 |
|---|---|---|
| GUI 内 switch session | runtime `switch_session` RPC（`packages/runtime/src/infra/pi/rpc-client.ts:1016`，恢复 session 唯一入口）→ pi `switchSession` | 路径 1：旧 runtime 在 `session_before_switch` 直读目标文件存 stash（模块级单例跨 runtime 传递） |
| TUI `/resume`、`/new` | pi `agent-session-runtime.js` 同款 switchSession/newSession | 同上（new 档无基线） |
| fork | pi `fork()`（TUI fork / GUI 经 switchSession 走 resume） | 路径 2：读 `previousSessionFile`（源 session 文件）——**types.ts/trace.ts 注释自认「暂定语义，待 P2 实测定」** |
| skill 变更 reload | SkillRegistry → `ReloadOrchestrator`（`packages/runtime/src/services/session/reload-orchestrator.ts:22-24`）→ `/__xyz_reload__` → agent-ext 调 `ctx.reload()`；TUI 侧 `/reload`（interactive-mode.js:2487） | 路径 3：**自持久化小文件**（本设计删除对象） |
| app 重启直 spawn resume | `pi --resume/--session` 或 xyz-agent runtime spawn | 路径 3：同上。**注意：该链路 session_start 的 reason 实为 `"startup"` 且不带 previousSessionFile**（main.js:570 `isInitialRuntime` 分支 + agent-session.js:152 默认值；SDK 类型注释也声明 previousSessionFile 仅 new/resume/fork 存在） |

## 2. 设计目标

1. **主链路零回归**：GUI switch / TUI resume / fork / skill reload / 重启直启五链路的留痕行为（去重、version 续接、reason 语义）与现状一致或更准。
2. **删自持久化子系统**：baseline.ts 中 PersistedBaselineEntry/File、readPersistedBaseline、writePersistedBaseline、loadBaselineFileForWrite、uniqueTmpPath、pruneSessions、MAX_BASELINE_SESSIONS 及 TraceEnv/types/index 的对应 wiring 整体移除，包内不再有第二个持久化状态源。
3. **数据层缺口修复**：`parentVersionDiffSummary` 在「重启直启 resume 后 prompt 变化」场景不再缺省（现状 persisted 只有 hash+version 无 fullText，见 baseline.a12.test.ts:190 的 `toBeUndefined()` 断言自证）。
4. **类型层归一**：Like\*Event 三接口与 SessionStartReason/SESSION_START_REASONS/normalizeSessionStartReason 删除，事件接入直接用 SDK 具名类型（与同组 msg-id-mapper/system-prompt 的既有风格一致）。
5. **悬置关闭**：fork 基线的「暂定语义，待 P2 实测定」注释随 M0 探针定案——语义定案为读 previousSessionFile 最后留痕（v5 回炉，见 §6.2），已知局限（F4）登记为已接受代价，不再有待验证标记。

**In-scope**：`extensions/taiji/system-prompt-trace/`（src + tests + README）+ 登记回写与悬空引用清扫四处——`docs/architecture/data-source-registry.md` §6 条目、包 `README.md`「四路径」章节、`docs/design/pi-session-start-handler-idempotency-audit.md` 历史性标注、`scripts/check-doc-symbol-drift.mjs` DOC_MODULE_MAP 登记（C-proc-10 同步纪律，见 D3）。
**Out-of-scope**：
- goal / smart-context / rename-session 的同模式 Like\* 归一（审计候选 3/11 的跨包部分，见各自包设计文档）；
- GUI Trace 视图对 `parentVersionDiffSummary` 的投影（该字段现状仅扩展自身测试消费，`summarizeSystemRow` 未读它——本次只保证数据层可产出，投影是独立产品决策）；
- stash 机制本身的删除（见 §6.1 被否谱系）；
- handler `async` 标记等 suggestion 级清理（不在审计覆盖面内）。

---

## 3. 现状：使用者眼里是什么样的

### 3.1 现状的真实样子（取自代码与测试）

一次 GUI 内 switch session 的留痕轨迹（现状正确路径，来自 a12 测试「路径 1」场景）：

```
session A：turn1 写 xyz:system-prompt {version:1, reason:"initial", hash:H1, fullText:...}
用户切到 session B 再切回 A：
  旧 runtime onSessionBeforeSwitch("resume", A的文件) → 直读 A 最后留痕 → stash{H1,v1}
  switchSession: emitBeforeSwitch → SessionManager.open(A文件) → teardownCurrent
               → createRuntime(新 manager, session_start{reason:"resume", previousSessionFile:切换前B文件})
  新 runtime onSessionStart("resume") → 消费 stash{H1,v1} → baseline 命中
  turn_start：hash(A当前prompt)==H1 → 不写。JSONL 仍 1 条留痕，Trace 视图 version 不变 ✓
```

persisted 路径的真实样子（本设计要消灭的路径，来自 a12 测试「路径 3」场景）：

```
app 重启直 spawn resume session A（session_start reason:"startup"，无 switch 事件）：
  onSessionStart 落到第三档 → readPersistedBaseline(agentDir/system-prompt-trace-baseline.json, A的sessionId)
  → 只有 {hash:H1, version:1}，无 fullText
  turn_start：prompt 已变为 H2 → 写 {version:2, reason:"resume", hash:H2}
             → parentVersionDiffSummary 缺省（无 parent 全文可 diff）
             → 同时 writePersistedBaseline(RMW + tmp唯一化 + 剪枝) 刷新小文件
```

### 3.2 真实失败模式

- **F1（数据缺口）**：上述重启直启场景，`parentVersionDiffSummary` 永远 undefined——留痕声称记录「与上一版的 diff 摘要」但该路径物理上拿不到 parent 全文（小文件只存 hash+version）。测试以 `expect(...parentVersionDiffSummary).toBeUndefined()`（baseline.a12.test.ts:190）把缺陷固化为契约。
- **F2（认知负担）**：为这一个场景维护约 120 行持久化子系统（原子写/tmp 唯一化/逐 entry 校验/64-session 剪枝），外加 data-source-registry.md §6:114 一整段跨进程锁豁免论证（PR #186 MF2）——而它自产自销：写方=本包 writePersistedBaseline，读方=本包 readPersistedBaseline，包外零引用（审计实跑 `rg "readPersistedBaseline|writePersistedBaseline"` 全仓仅定义/消费/wiring 三处）。
- **F3（类型双轨）**：同包内两种事件接入风格并存——msg-id-mapper/system-prompt 直接 import SDK 类型，本包却自定 `SessionStartLikeEvent { reason: string }`（SDK 是五值字面量联合）再靠运行时 `normalizeSessionStartReason` 归一。SDK 类型演进（如 reason 新增值）时本地 `string` 静默放行而非编译报错——负防腐。
- **F4（悬置语义）**：fork 档读 `previousSessionFile`（源 session 文件全文），拿到的是**源文件最后**一条留痕；而 fork 到早期 turn 时正确基线应是**fork 截断点前**最后一条。现状注释自认「暂定，待 P2 实测定」（trace.ts onSessionStart 注释、types.ts mapReasonForFirstWrite 注释）。

### 3.3 根因

**对 pi SDK 能力的过时假设。** persisted 子系统赌「无 switch 事件的链路拿不到 session 文件路径」——实读 pi 0.84.4 dist 证伪：
- `ExtensionContext.sessionManager: ReadonlySessionManager`（extensions/types.d.ts:219），其 Pick 成员含 `getSessionFile(): string | undefined`（session-manager.d.ts:140 与 :208，实现直接返回 `this.sessionFile`，session-manager.js:723-725）；
- **session_start 事件触发时 ctx.sessionManager 已指向当前 session**：switchSession 在 `SessionManager.open(sessionPath)` 之后才 createRuntime（agent-session-runtime.js:126-144，新 manager 与 sessionStartEvent 同批传入）；fork 三分支同理（:174-253）；reload 不重建 manager（agent-session.js:2216-2232）；直启时 main.js 的 createRuntime 传入 createSessionManager 产物（main.js:536/:655）；
- 留痕 entry 落盘含 fullText（trace.ts write() 全量写入），直读 JSONL 最后一条即得完整基线——`readLastPromptFromSessionFile`（baseline.ts:63）就是现成函数，stash/fork 档已在用。

类型层同理：pi 0.84.4 包根具名导出 `SessionStartEvent`/`SessionBeforeSwitchEvent`/`TurnStartEvent`（dist/index.d.ts:7），`on()` 按事件名重载、handler 参数即 SDK 事件类型（extensions/types.d.ts:909/:911/:929），`SessionStartEvent.reason` 已是五值字面量联合（:419）。Like 簇的「逆变匹配更稳」理由声明不成立（同组两包直接用 SDK 类型工作正常）。

## 4. 物理数据流（现状 vs 终态）

> **基线（baseline）** = 跨重启恢复的 `{hash, version, fullText?}` 三元组，是「首个 turn_start 是否写留痕、version 从几续接」的判定依据。就是 §3.1 例子里 stash 那个 `{H1, v1}`。

现状（三路解析，其中路径 3 为本设计删除对象）：

```
                         ┌─ 路径1 stash：session_before_switch(旧runtime) ─直读目标JSONL─┐
session_start(reason) ───┤─ 路径2 fork：readLastPromptFromSessionFile(previousSessionFile) ├→ baseline
                         └─ 路径3 persisted：readPersistedBaseline(agentDir小文件[无fullText])┘
写留痕时(write)：appendEntry(JSONL) + writePersistedBaseline(小文件双写) ←── 第二个持久化状态源
```

终态（三路解析——v5 回炉后 fork 档维持现状路径 2，仅 persisted 消失；单一持久化源 = session JSONL 自身）：

```
                         ┌─ 档1 stash：session_before_switch(旧runtime) 直读目标JSONL（resume 主链路，保留）
session_start(reason) ───┼─ 档2 fork：readLastPromptFromSessionFile(previousSessionFile)（源文件最后留痕，仅 reason="fork"；缺失/不可读 → null）
                         └─ 档3 直读：ctx.sessionManager.getSessionFile() → readLastPromptFromSessionFile
                                   （覆盖 reload / 直启resume / new兜底；文件不存在或无留痕 → null）
写留痕时(write)：仅 appendEntry(JSONL) ←── 唯一持久化源；小文件不再有写方
```

四 reason 下三档解析的行为矩阵（直读档源码依据见 §6.5 探针 P1–P3；fork 档依据见 P2 降级记录与 D2 证据）：

| session_start reason | 触发链路 | getSessionFile() 指向 | 直读结果 | 后续 turn 行为 |
|---|---|---|---|---|
| startup（新会话） | 直启无 --session | 新文件路径（`_persist` 延迟：首条 assistant 前不落盘，文件不存在） | null | 写 initial v1 |
| startup（直启 resume） | `pi --resume/--session` / runtime spawn | open 的目标文件 | 最后留痕（含 fullText） | hash 命中不写；变化写 resume v+1 带 diff 摘要（**修复 F1**） |
| resume | switchSession（GUI switch_session RPC / TUI /resume） | open 的目标文件（与 stash 同源同值，stash miss 时兜底） | 同 stash | 同现状 |
| fork | fork() 三分支（缺省 position="before"） | —（fork 档不走直读，v5 回炉见 D2：常态 /fork 时点 fork 新文件未落盘——createBranchedSession 仅路径含 assistant 才立即 flush（session-manager.js:1144-1151），fork 到首条 user message 时路径仅 session 头部链，直读 null（M0 探针实测）） | previousSessionFile（源文件）最后留痕（含 fullText，探针实证源文件已落盘） | prompt 未变 → 去重不写；变 → resume、version=源最后留痕 version+1、diff 相对源留痕（= 现状路径 2 定案，F4 已知局限见已接受代价 4）；previousSessionFile 缺失/不可读 → null → 按映射写 resume v1 兜底 |
| reload | ctx.reload()（skill 编排 / TUI /reload） | 当前文件（不换 manager） | 当前最后留痕（**替代 persisted**） | hash 命中不写；prompt 已变 → 写 resume v+1 带 diff 摘要（F1 修复在 reload 链路的变体，V3 的实际命中路径；reason 语义经 trace.ts:144-148 核实：baseline 非 null 分支恒为 resume） |

---

## 5. 终态：使用者眼里将是什么样的

### 5.1 成功路径（重启直启场景，即现状 F1 缺口场景的修复后形态）

```
前置：session A 已有留痕 {v1, initial, hash:H1, fullText:P1}，app 重启。
$ pi --resume（或 xyz-agent runtime spawn 直启 A）
  session_start(reason:"startup") → 直读档读 A 文件 → baseline{H1, v1, fullText:P1}
  turn_start：当前 prompt == P1 → hash 命中 → 不写，留痕仍 1 条
用户修改 system prompt append 配置后继续对话：
  turn_start：hash 变为 H2 → 写 {v2, resume, hash:H2, fullText:P2,
            parentVersionDiffSummary:"+2 -1 lines ..."}   ← 不再缺省
  Trace 视图重开 A：v1 → v2 两条留痕，v2 带 diff 摘要（数据层就绪；GUI 投影 out-of-scope）
磁盘面：agentDir 下不再出现 system-prompt-trace-baseline.json 的写动作；
       旧文件若存在则成为无读方孤儿（见 D3）。
```

reload 场景（GUI skill 变更链路）在终态下与上同构：`/reload` → session_start(reason:"reload") → 直读档读当前文件 → 命中不写。

### 5.2 失败路径（带恢复指引）

- **JSONL 读取失败/损坏**（文件被截断、单行 JSON 损坏）：`readLastPromptFromSessionFile` 逐行倒序扫描 + `parseTraceEntryData` 运行时 guard（types 校验不符返回 null），坏行跳过、全坏返回 null → 无基线 → 首个 turn 按 reason 兜底写（resume 必写）。恢复：无需动作——留痕是诊断性旁路，多写一条是设计 D2 已接受语义；要排查损坏原因看 agentDir 下 `logs/`（路径随 pi getAgentDir() 推导：缺省 `~/.pi/agent/logs/`，`PI_CODING_AGENT_DIR` 重定向时为 `<agentDir>/logs/`——探针/验收场景即后者；XYZ_AGENT_DEBUG=1 才落盘，extension-logger 缺省 no-op）。
- **getSessionFile() 返回 undefined**（session 从未 flush，如纯内存 session 或首 assistant 前）：视为无基线 → initial/resume 兜底。恢复：同上，无需动作。
- **fork 档 previousSessionFile 缺失/不可读**：SDK 类型注释声明该字段仅 new/resume/fork 存在（extensions/types.d.ts:421），fork 三分支均带（agent-session-runtime.js:211/:229/:246），常态必然在——仍需防御性处理：字段缺失（in-memory fork 且源 sessionFile 为 undefined）或源文件尚未落盘（罕见：源会话尚无 assistant 即 fork，首条 assistant 前 `_persist` 不落盘）或读取失败 → 统一视为无基线 → 按 mapReasonForFirstWrite("fork")="resume" 写 v1 兜底。恢复：无需动作（与现状路径 2 的防御行为一致）。
- **类型层**（Like 归一后）：pi 升级新增 reason 枚举值时，`mapReasonForFirstWrite` 的 switch 将出现编译期 non-exhaustive 报错（五值联合穷尽性检查）→ 负防腐生效，修复动作明确（补 case），替代现状的运行时静默归一为 "startup"。

## 6. 关键决策与权衡

**本章结论：4 个决策——三档基线解析（A 方案，v5 M0 探针回炉后终态）、fork 基线维持 previousSessionFile 语义定案（F4 登记为已接受代价）、persisted 残留不主动清理、类型层 import type 归一。**

### 6.1 D1：基线解析收敛形态（选定：方案 A 三档——v5 回炉后终态）

- **采用**：`onSessionStart(reason, ctx)` 解析基线三档——①stash 命中（reason=resume 且 stash.pending 非空，cancelled 残照旧消费防污染）优先；②reason="fork" 时读事件 `previousSessionFile`（源文件最后留痕），缺失/不可读 → null；③否则 `ctx.sessionManager.getSessionFile()` 直读 JSONL 最后留痕，miss → null。onSessionStart 保留 previousSessionFile 参数（D4 类型归一不变：SDK SessionStartEvent 自带该字段，直接消费即可，无需恢复 Like 接口）。
- **沿革**：v1–v4 选定方案 B 两档（fork 并入直读）；v5 M0 探针 P2 证伪 fork 新文件直读（常态 /fork 时点 fork 新文件未落盘，机制见证据段），回退审计原案三档——原被否对象（A）成为选定、原选定（B）成为被否，裁决翻转的完整重演见修订记录第 4 轮。
- **被否**：
  - **方案 B（v1–v4 选定两档：stash → getSessionFile() 直读覆盖 fork）**——M0 探针证伪：fork 档直读的物理前提（session_start 时点 fork 新文件已落盘且含截断点前留痕）不恒成立。击穿反例：TUI /fork 常态形态（position="before"）fork 到首条 user message 时 createBranchedSession 路径仅 session 头部链、无 assistant，flushed=false 文件不落盘（session-manager.js:1144-1151），直读 null——「fork 截断点语义 by construction」不成立（2026-09-12 探针 A0-3 实测 + 源码定案，完整反例见被否谱系增补）。
  - **方案 C（保留 persisted，声称 forward-ready）**——审计已否：120 行子系统自产自销（包外零引用）、无 fullText 导致 F1、RMW/tmp/剪枝全是自引复杂度；「未来基线丢失代价不可接受时升格 file-lock 正规锁」的 registry 登记恰恰证明它在为一个可避免的状态买保险。若用它，§5.1 的例子继续保持 diff 缺省，§4 数据流继续双持久化源。
  - **方案 B+（连 stash 也删，onSessionBeforeSwitch handler 整体移除）**——stash 与直读档在 resume 场景同源同值（switchSession 源码 :126-144，before_switch 时读与 session_start 时读指向同一目标文件、单进程顺序执行其间无写方），理论可删。但 stash 是审计明确保留的主链路保险（before_switch 时序 100% 先于 teardown，且 cancelled 语义已测试覆盖），删除收益（-1 概念 -1 handler）小于把主链路押在「session_start 时 manager 已就位」这一断言上的风险放大。**登记为后续审计机会，不在本次实施**。
- **证据**：session-manager.d.ts:140/:208（getSessionFile 存在性）；agent-session-runtime.js:126-144/:174-253（switchSession/fork 时 manager 先 open 后 createRuntime）；agent-session.js:2216-2232（reload 不换 manager）；main.js:536/:655/:570（直启传 open 的 manager）；session-manager.js:726-754（`_persist`：首条 assistant 前 entry 不落盘——直读档对新 session 安全返回 null）；session-manager.js:1144-1151（createBranchedSession 的 hasAssistant 条件 flush——fork 档直读被证伪的机制根源）；同包 stash 消费/取消残留语义见 trace.ts onSessionStart 现状实现。
- **效果**：目标 2（删子系统）、目标 1（五链路零回归——resume/reload/直启落在直读档矩阵内，fork 档行为恒等现状路径 2）、§5.1 成立。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A 三档（v5 选定） | 单一持久化源（session JSONL 自身）；fork 档行为恒等现状（零回归的最强证成）；删 ~120 行 + 4 概念 | 低-中：trace.ts 三档解析（fork 档为现状逻辑保留），其余同 B 改动面 | F4 语义偏差保留（登记为已接受代价 4，见 §9.3） | ✅（v5 回炉） |
| B 两档（v1–v4 选定） | 同 A 且无 fork 特判，但依赖「fork 新文件 session_start 时点可直读」这一被证伪前提 | 中：同上 | fork 档直读常态 null → 去重失效；已被 M0 探针击穿 | ❌（v5 证伪） |
| C 保留 persisted | 双持久化源，为已证伪的赌注持续缴税 | 零 | F1 缺口永续；每次全仓动作携带维护义务 | ❌ |

### 6.2 D2：fork 基线语义定案（v5 回炉：选定读 previousSessionFile 最后留痕，= 现状路径 2 语义）

- **采用**：fork 档（reason="fork"）读事件 `previousSessionFile`（源 session 文件）最后留痕为基线——与 §1 表格记录的现状路径 2 完全一致，本设计对该档读取逻辑零改动（仅随 D1 删 persisted 写侧）。行为：fork 后首 turn prompt 与源最后留痕相同 → 去重不写；不同 → 写 resume、version = 源最后留痕 version + 1、parentVersionDiffSummary 相对源留痕 fullText。防御：previousSessionFile 缺失（SDK 类型注释声明该字段仅 new/resume/fork 存在——extensions/types.d.ts:421，fork 三分支均带，常态必然在）或源文件尚未落盘（罕见：源会话尚无 assistant 即 fork）或读取失败 → null → 按 `mapReasonForFirstWrite("fork")="resume"` 写 v1 兜底。
- **被否**：
  - **fork 档并入 getSessionFile() 直读（v1–v4 原选定）**——击穿反例已入被否谱系：TUI /fork 常态形态（position="before"）session_start 时点 fork 新文件未落盘（hasAssistant 条件 flush），直读 null，V6「version = 截断点 + 1」不成立（2026-09-12 M0 探针 A0-3 实测 + 源码定案，机制见 D1 证据段）。原「暂定语义」悬置以「维持现状语义 + F4 登记为已接受代价」方式关闭。
  - **接受 null 基线（fork 后一律 resume v1 重开）**——fork 后首 turn 必写一条（即使 prompt 未变），去重对 fork 链路失效，与目标 1 冲突；且「fork 后 prompt 未变」是高频场景（fork 操作本身不改 system prompt 配置），每次 fork 恒多一条冗余留痕。
  - **窄保留 persisted 仅供 fork 档只读**——写侧/原子写/tmp 唯一化/剪枝全套复杂度照留（只读仍依赖写侧持续产出数据），双持久化源维持，直接违背目标 2 删除立意。
  - **直读优先 + previousSessionFile 兜底混合（v5 重演新增候选）**——fork 到中间 turn 时（createBranchedSession 路径含 assistant，文件立即落盘且含截断点前留痕）直读得截断点语义；fork 回早期时兜底读源文件得源末尾语义。被否理由：同入口两种基线方向（一从截断点续接、一从源末尾续接），行为依赖 fork 点不可预测；fork 档需 reason 特判两段式解析——本设计立意是删复杂度，为单一「更准」场景引入 fork 专属分支违背立意；且 F4 偏差的实际后果有限（见已接受代价 4），不值得为之保双轨。
- **证据**：agent-session-runtime.js fork 三分支（:174-253）：position 缺省 "before"（:175），position="before" 要求 entryId 为 user message 且 targetLeafId = 其 parentId（:184-193）；三分支均以 `{ reason: "fork", previousSessionFile }` 发 session_start（:211/:229/:246）。TUI /fork 调 fork(entryId) 无 options（interactive-mode.js:4305，选择器仅列 user message）；position="at" 仅 /clone（interactive-mode.js:4330）与 extension command 形态触达。fork 新文件落盘条件：createBranchedSession 仅路径含 assistant 时立即 `_rewriteFile` + flushed=true，否则 flushed=false（session-manager.js:1144-1151）——fork 到首条 user message 时路径仅 session 头部链（真实会话 JSONL 佐证：首条 user message 的 parent 为 model_change/custom 头部链），文件不落盘。M0 探针 A0-3 反向实证：fork 事件内 previousSessionFile 在且指向源文件，源文件已落盘、最后留痕含 fullText（42473 chars == charCount）。
- **效果**：目标 5（悬置关闭——trace.ts/types.ts 的「暂定，待 P2 实测定」注释随实现删除，语义以本节定案为准）；目标 1 的 fork 链路以「恒等现状」证成；F4 语义偏差登记为已接受代价 4（§9.3）。

### 6.3 D3：persisted 残留清理方式（选定：不主动删除旧文件）

- **采用**：发布后旧 agentDir 中可能存在 `system-prompt-trace-baseline.json` 主文件及其 tmp 残留（`*.tmp_<pid>_<rand>`，写/rename 抛错且清理再失败的双重故障产物——uniqueTmpPath 唯一名不自覆盖，baseline.ts:126-130/:147-156）——新版本无任何读方/写方，成为孤儿文件。**不写迁移/清理代码**，登记回写四件：①`docs/architecture/data-source-registry.md` §6:114 条目改标「已废弃（无读写方，可安全手动删除）」，删除清单把主文件与 `system-prompt-trace-baseline.json.tmp_*` glob 一并纳入，并顺带修正条目内的权威源死路径——现行条目写的是 `extensions/system-prompt-trace/src/baseline.ts`（分组迁移前旧写法，`ls extensions/` 证实该路径不存在），回写时改为 `extensions/taiji/system-prompt-trace/src/baseline.ts`，废弃条目不得挂着找不到的源码路径；②同表 :120 engines.json 条目中「参照上行 system-prompt-trace-baseline.json PR #186 MF2 先例」的参照锚点改为直接引用或历史标注（该行豁免论证自身成立，不随本删除失效），避免悬空引用；③包 README `extensions/taiji/system-prompt-trace/README.md`「跨重启 hash 基线四路径」章节（:38-46，自称「权威实现见 src/trace.ts onSessionStart」）改「三档」（删 persisted 路径描述；previousSessionFile 描述保留并按 D2 v5 定案更新），其 reason 映射表「fork/reload 暂定」行同步定案（目标 5 悬置清扫的同族标记）；④`docs/design/pi-session-start-handler-idempotency-audit.md` **两处** system-prompt-trace 行均加历史性标注——排查表行引用的被删符号（`readPersistedBaseline`、`baseline.ts:86-109`、小文件路径），以及 §4「其他事件注册事实」表行（:83）的「turn_start 双注册 → 本 session 重复 appendEntry + **全局基线双写**」表述（persisted 删除后无双写面，该短语终态下不成立）——该文档是对 2026-09 时点现状的审计记录，改写事实会失真；其「残留发现」（stash 双注册）在终态下依然有效，标注注明即可。
- **机检通道**：`scripts/check-doc-symbol-drift.mjs` DOC_MODULE_MAP 登记 `'docs/design/ext-simplify-02-system-prompt-trace.md' → ['extensions/taiji/system-prompt-trace/src']`——否则 M3 的「checker 必须跑过」对本档检不出任何一处（显式登记制：未登记文档不检查）。同批按 checker 书写约定（反引号 = 现行代码符号）处理本文档的反引号候选：按 checker 同款正则（反引号 span 内蛇形大写 ≥2 段 + getXxx( 形态）对本文档实跑提取，v2 时点候选全集为 **5 个符号**（getSessionFile、SESSION_START_REASONS、XYZ_AGENT_DEBUG、TMP_RESIDUE_MARKERS、PID_FILE；本轮修订新增文本引入的 PI_CODING_AGENT_DIR / XYZ_AGENT_EXT_LOG 均命中白名单，见免处理栏），调整清单全列如下——M3 与 M2 同 commit 后「按清单执行 → 跑 checker 绿」以全集执行为前提，漏任何一处首跑即红：
  - **删除目标符号类（裸写）**：SESSION_START_REASONS ×3 处——SCQA 开篇、§6.4 采用段、本段原元引用（第 2 轮修订已把本段自身改为裸写，实施时处理前两处；M1 删除后该符号不在映射模块符号表，残留反引号必红）；
  - **元引用类（裸写）**：TMP_RESIDUE_MARKERS 与 PID_FILE ×1 行（修订记录第 1 轮 MF-impact 行转述 registry 候选名时带入）——属 runtime updater/subagent-workflow 域符号，不在映射模块符号表且无白名单命中，第 2 轮修订已改裸写；与删除目标符号类的差异：符号本身仍现行存在于其所属模块，只调整本文档书写、不涉及删除；
  - **免处理（核实记录）**：getSessionFile ×10 处（v5 修订后全文重数；v2 时点为 ×11，直读档相关行随三档改写增减后净 -1）——M2 后随 `export interface TraceContext`（trace.ts:30）新增成员名进入 checker 符号表（interface 成员名收录），绿；XYZ_AGENT_DEBUG、XYZ_AGENT_EXT_LOG 与本文档新增的 PI_CODING_AGENT_DIR 命中 checker ENV 前缀白名单（PI_/XYZ_ 等），绿。新增本文档内容时同口径自检：getAgentDir() 等 get 前缀函数提及一律裸写（不在映射模块导出表，带反引号即新增必红候选）。
  - registry 文档与幂等审计文档**不**入映射：前者全仓横切（其反引号候选横跨 updater/subagent-workflow 等多模块符号，无法归一为单模块映射），后者为 10 包时点审计记录——二者的清扫由上述 ①②③④ 人工清单承担；且 checker 候选提取只覆盖蛇形大写与 getXxx( 形态，`readPersistedBaseline` 类非 get 驼峰本就不在机检面内，人工清单不可省略。
- **被否**：主动删除（extension 启动时 unlink）——为一次性残留写永久代码，且对用户 agentDir 做写删除违反最小侵入。
- **证据**：孤儿文件量级实测上界 = 主文件每 agentDir 1 个（≤64 session 条目、典型 < 10KB）；tmp 残留仅在「写失败 + 清理失败」双重故障下产生、量级 0..n 且不增长；无读方 = D1 删除面即全部读写方。
- **效果**：已接受代价四要素——量级：一次性 ≤10KB/agentDir 主文件 + 极小概率 tmp 残留；恢复路径：用户手动删或永留（无任何行为影响）；重审触发：无（一次性残留，不增长）；显式判定：可接受。C-proc-10 闭环 = 机检（本文档映射）+ 人工清扫（①–④）双通道，check-doc-symbol-drift.mjs 必须跑过且绿。

### 6.4 D4：类型层归一方式（选定：import type SDK 具名类型 + 删归一化链）

- **采用**：`index.ts` 删除 `SessionStartLikeEvent`/`SessionBeforeSwitchLikeEvent`/`TurnStartLikeEvent` 三接口，事件 handler 参数直接标注 SDK 导出的 `SessionStartEvent`/`SessionBeforeSwitchEvent`/`TurnStartEvent`；`types.ts` 删除 `SessionStartReason`（本地五值联合）、SESSION_START_REASONS、`normalizeSessionStartReason`，`mapReasonForFirstWrite` 保留（真实语义映射）但入参类型改用 `SessionStartEvent["reason"]` 索引访问；trace.ts 内部状态 `sessionStartReason` 同步改型。
- **被否**：
  - 保留 Like 簇仅删 normalize——半吊子：`reason: string` 的降级子集仍在，F3 的负防腐仍在。
  - 先在 SDK 侧提 feature request——项目纪律明确不修改 pi 源码不提 PR；且 SDK 已导出所需类型，无事可提。
- **证据**：dist/index.d.ts:7 具名导出三类型；extensions/types.d.ts:909/:911/:929 `on()` 按事件名重载（handler 参数即 SDK 类型）；:416-422 `SessionStartEvent.reason` 五值字面量联合 + `previousSessionFile?: string` 注释「Present for new/resume/fork」；同包先例 msg-id-mapper/system-prompt 直接 import SDK 事件类型（taiji 单元四问记录证实）。
- **效果**：目标 4；负防腐反转（SDK reason 演进 → 编译期 non-exhaustive 报错，恢复动作明确见 §5.2）；行为零变更（纯类型层——`normalizeSessionStartReason` 删除后「untyped extension 传入非五值」场景由 TS 契约接管，运行时不可达）。v5 回炉后 onSessionStart 恢复消费 previousSessionFile 字段仍走 SDK 原生类型（见 D1/D2），无需恢复 Like 接口——D4 结论不受回炉影响。

另有两个 export 收敛执行项（审计 low 级，随 D1/D4 顺带）：`parseTraceEntryData`（baseline.ts:45）去 export——全仓仅同文件 :77 内部调用；`computePromptHash`（trace.ts:59）去 export——内部使用保留，测试改为本地 `createHash("sha256")` 计算期望值（纯函数等价引用，一行替代）。

### 6.5 探针清单（⛔ 实施期门：pi 行为段在 M0 开工前，终态段在 M2 后合入前）

每条探针拆两段断言，时点不同且不可互换：

- **pi 行为段**（M0 开工前）：与实现无关的 pi 运行时行为（reason 值、`getSessionFile()` 指向、文件内容），用一次性探针 extension 观察——它验证的是 D1/D2 赖以成立的前提，失败则**开工前**重审设计，保住「不通过不开工」的门的意义。
- **终态段**（M2 后、合入前）：本设计实施后才存在的行为（不写 / version 续接 / diff 有值），必须用实装本包复跑——旧代码上这些断言必红（旧代码无直读日志、fork 读源文件、F1 缺口在），不能前置到 M0。

**统一环境定义（本节全部探针与 §8 的本地 CLI 验收场景共用，四要素缺一不可）**：

1. **`PI_CODING_AGENT_DIR=<tmp agentDir>`**：隔离 agentDir。baseline 路径（index.ts:64 的 join(getAgentDir(), BASELINE_FILENAME)，BASELINE_FILENAME 本身也在 M2 删除面内）与 extension-logger 落盘（`<agentDir>/logs/`，extension-logger fileLog 同用 pi 的 getAgentDir()）**同受这一个 env 支配**（pi config.js getAgentDir 实读：env 有值即返回，缺省 `~/.pi/agent`）——重定向后 baseline 与日志同步进 `<tmp agentDir>`，「logs 无报错」与「agentDir 无 baseline 写动作」两条子检查才同时有效；不设则 baseline 落真实 `~/.pi/agent`（验收写动作污染真实目录且负向检查无从执行——`--session-dir` 只管 session 文件目录，不产生 agentDir）。该机制与 xyz-agent runtime 隔离 pi 子进程用的同一个（rpc-client.ts:201 spawn env 注入同款）。
2. **`XYZ_AGENT_DEBUG=1`**：extension-logger 落盘开关（双开关分级：`XYZ_AGENT_DEBUG=1` 全量 / `XYZ_AGENT_EXT_LOG=1` 仅 INFO / 均缺省 no-op 零 fs 调用）——不开则日志文件根本不产生，「logs 无报错」类负向检查空转假绿（文件不存在 ≠ 无报错）。
3. **`--extension` 按段加载**：pi CLI 该参数可重复（args.js:293 「can be used multiple times」）。pi 行为段**双加载**——现状版本本包（npm dist，留痕写方）+ 一次性探针 extension；终态段单加载实装本包。P1「发消息产生留痕」/P3「选已有留痕的 session」「直读最后留痕含 fullText」依赖现状版本本包在场写 `xyz:system-prompt` entry——只挂探针 extension（仅 log + fs 直读，无写方）则留痕恒不存在、直读恒 null，P1/P3 的 pi 行为段降级路径会被脚本前提缺口误触发（M0 门误判风险）。
4. **凭据供给（预置 auth.json）**：pi 的凭据解析完全跟随 agentDir 重定向——auth.json 路径 = join(getAgentDir(), "auth.json")（config.js:436-437），models.json 同在 agentDir（:431-433）——fresh `<tmp agentDir>` 下无任何凭据，实测 `pi -p` 首个请求即报 `No API key found for <provider>`，无法产生 assistant turn，而本节全部探针与 §8 全部 CLI 验收均依赖真实模型 turn。三选一裁决：**选定向 `<tmp agentDir>` 预置 auth.json 副本**（`cp ~/.pi/agent/auth.json <tmp agentDir>/auth.json`，或仅提取所需 provider 单项）——凭据现状即在真实 auth.json（实测均为 api_key 形态），一条拷贝即就位零搬运；stored 凭据是解析链第一优先源（pi-ai auth/resolve.js 的 resolveProviderAuth：overrides.apiKey > stored > ambient env），实测 fresh tmp agentDir + 预置后 `pi -p` 正常产生 assistant turn；命令行与探针产物零凭据，唯一落盘副本在 `<tmp agentDir>` 内随验收清理。被否：①provider env（所选 provider 对应的 API key 环境变量，如 anthropic 对 ANTHROPIC_API_KEY、xiaomi-token-plan-cn 对 XIAOMI_TOKEN_PLAN_CN_API_KEY，映射表见 pi-ai env-api-keys.js）——实测同样可行，但要求执行者先把 key 从 auth.json 搬进 env（OAuth 形态凭据无法走 env），且 key 进入子进程环境；②`--api-key` 参数（cli/args.js:58 解析 → main.js:641-649 setRuntimeApiKey）——key 进命令行文本，探针产物（命令行摘录）贴 PR 时泄漏面最大，且必须与 --model 组合。附注：不预置时 pi 首跑会在 `<tmp agentDir>` bootstrap 空 auth.json 与 models-store.json（实测确认），预置与否该两文件均属 pi 自身文件，不属 V1「无 baseline 写动作」检查对象（该检查只锚定 system-prompt-trace-baseline.json 及 `.tmp_*`）；--model 所选 provider 须在预置的 auth.json 内有凭据；V2/V3 走 GUI，凭据由 runtime 供给的 dev 数据目录 agentDir（`~/.xyz-agent-dev/agent`，已 provisioning）覆盖，不适用本要素。

**pi 入口锚定**：上述命令中的 pi 一律指本仓实装入口 `./node_modules/.bin/pi`（symlink 指向实装包 dist/bundle/cli.js，实测 --version 输出 0.84.4，与本表头基线一致）；禁止裸写 PATH 上的全局 pi——其版本不受 C-proc-08 版本门禁控制（实测 PATH 全局 pi 为 0.85.1），pi 行为段断言会与 0.84.4 dist 基线错位。

| ID | 验证的行为（两段） | 探针（本地 pi CLI，实装 0.84.4） | 时点 | 失败时的降级路径 |
|---|---|---|---|---|
| P1 | **pi 行为段**：`/reload` 后 session_start(reason:"reload") 触发时 `getSessionFile()` 指向当前文件且最后留痕可读。**终态段**：reload 后首 turn hash 命中不写，JSONL 留痕条数不增 | `PI_CODING_AGENT_DIR=<tmp agentDir> XYZ_AGENT_DEBUG=1 ./node_modules/.bin/pi --session-dir <tmp session-dir> --extension <npm 版本包 dist> --extension <一次性探针extension>`（统一环境 pi 行为段双加载，TUI，凭据按第 4 要素预置；`--model` 选 auth.json 内有凭据的 provider）：发消息产生留痕+assistant → `/reload` → 探针日志记录 session_start reason、getSessionFile() 指向与直读结果。终态段换装实装本包（单 --extension）复跑同一脚本，数 JSONL 的 `xyz:system-prompt` 条数 | pi 行为段 ⛔ M0；终态段 ⛔ 合入前 | pi 行为段失败（manager 未就位/文件不可读）：核对失败输出与 dist 源码断言差异；pi 行为与源码不符按版本门禁流程重验（check-pi-semantics），**开工前**回本设计重审 D1。终态段失败且确认 pi 固有限制（仅 reload 档）：fork/resume/直启三档不受影响时可缩为「reload 档保留 persisted 小文件只读（不复活写路径）」的窄保留并回本设计重审 D1。**——2026-09-12 M0 已执行：pi 行为段 PASS（reload 档直读前提成立），降级路径未触发** |
| P2 | **pi 行为段（原断言，已被证伪）**：fork 后 `getSessionFile()` 指向 fork 新文件且内容 = 截断点前 entry（非源文件全文）。**终态段（v5 降级后按方案 A 断言）**：fork 后 prompt 未变 → 无新留痕（去重）；prompt 再变 → change（fork 后首 turn 命中分支已确立 current baseline，配置再变走 change 分支，trace.ts:127-132）、version = 源最后留痕 version + 1、diff 相对源留痕 | TUI 内 fork 到早期 turn（`/fork` 或树导航）→ pi 行为段由探针记录 getSessionFile() 并 fs 读 fork 文件，比对内容范围；终态段按新标准断言（由 §8 V6 执行） | pi 行为段 ⛔ M0；终态段 ⛔ 合入前 | **已触发降级（2026-09-12 M0 探针），回退方案 A**：pi 行为段 FAIL——常态 /fork（position="before" fork 到 user message）session_start 时点 fork 新文件未落盘（fileExists=false 实测），直读 null，原断言「内容 = 截断点前 entry」不成立。关键证据（自包含）：① position 缺省 "before"、要求 entryId 为 user message 且 targetLeafId = 其 parentId（agent-session-runtime.js:175/:184-193），/fork 调 fork(entryId) 无 options（interactive-mode.js:4305）；② createBranchedSession 仅路径含 assistant message 才立即 flush，否则 flushed=false 延迟落盘（session-manager.js:1139-1151）；③ fork 到首条 user message 时路径仅 session 头部链、无 assistant → 文件不落盘；④ 反向证据：fork 事件内 previousSessionFile 在且指向源文件（三分支均带，agent-session-runtime.js:211/:229/:246），源文件已落盘、最后留痕含 fullText（42473 chars == charCount 实测）。按本列原降级路径执行：D2 回退读 previousSessionFile（即方案 A 形态），其余档不受影响 |
| P3 | **pi 行为段**：`--resume/--session` 直启时 reason="startup"（无 previousSessionFile）且 `getSessionFile()` = 目标文件、直读最后留痕含 fullText。**终态段**：命中轮零新增；改 append 配置后新留痕 `reason:"resume"`、version+1、**parentVersionDiffSummary 有值**（F1 修复实证） | `./node_modules/.bin/pi --resume`（选已有留痕的 session，同 P1 模板的统一环境）→ pi 行为段由探针记录三事实；终态段用实装包发一条消息 → 留痕条数不增 → 改 append 配置再发 → 断言新留痕形态 | pi 行为段 ⛔ M0；终态段 ⛔ 合入前 | pi 行为段失败：按 P1 pi 段降级处理；此场景是 persisted 的原主场景，**开工前** D1 整体重审（回滚到方案 C 需重新设计评审）。终态段失败：排查实现。**——2026-09-12 M0 已执行：pi 行为段 PASS（reason="startup"、无 previousSessionFile、getSessionFile=目标文件、直读含 fullText 四事实成立），降级路径未触发** |
| P4（辅助） | Like 归一编译等价性：handler 直接标注 SDK 类型后 `on()` 重载接受、无逆变报错 | 实施时 `pnpm extensions:typecheck`（真实编译器即探针；SDK 类型与 handler 签名兼容性由 tsc 验证） | ⛔ 同提交（M1） | 失败 → 检查是否 SDK 版本漂移（npm ls 核对 0.84.4）；确认无漂移后保留单点 `import type` 过渡并在本节登记 |

> P1–P3 即审计指定的「一次本地 pi CLI 探针验证 reload 事件时序」，扩展为四 reason 矩阵一次跑清。P1–P3 全部按本节「统一环境定义」四要素执行（P2/P3 探针命令同 P1 模板：同一 `<tmp agentDir>` + `XYZ_AGENT_DEBUG=1` + 第 4 要素凭据预置，P3 的 resume 会话也在该环境下预造）。pi 行为段共用一个一次性探针 extension（仅 log + fs 直读，随探针脚本归档、不入包）与同一临时 session-dir，且按统一环境第 3 要素双 `--extension` 加载（现状版本本包 + 探针）；终态段换装实装本包（单 --extension）复跑同一脚本化步骤。产物（JSONL 片段 + 日志摘录）贴入实施 PR 描述。
>
> **M0 执行记录（2026-09-12）**：P1/P3 pi 行为段 PASS（直读档两前提成立，不受 fork 档回炉影响）；P2 pi 行为段 FAIL 触发 D2 回炉（证据见 P2 行降级列与修订记录第 4 轮）。终态段均未跑——M2 后合入前复跑，P2 终态段按方案 A 新断言、由 V6 执行。

---

## 7. 实现机制（把终态落到代码层）

**本章结论：改动收敛在 4 个源文件 + 3 个测试文件 + 4 个登记/文档面（registry、包 README、幂等审计标注、drift checker 登记），净删约 170 行（源码 680 行的 ~25%）。**

文件改动地图（实施清单，非代码）：

| 文件 | 动作 | 要点 |
|---|---|---|
| `src/baseline.ts` | 大删 | 删 BASELINE_FILENAME、MAX_BASELINE_SESSIONS、PersistedBaselineEntry/File、readPersistedBaseline、writePersistedBaseline、loadBaselineFileForWrite、emptyBaselineFile、uniqueTmpPath、pruneSessions 及 fs/path/logger 相应 import（约 -120 行）；保留 readLastPromptFromSessionFile（删 source 参数——v5 回炉后 "previous-session-file" 生产者保留，但 source 字段全包零消费如旧，删除理由更新见 types.ts 行）与 parseTraceEntryData（去 export）。文件头注释的「四路径口径」改「三档」 |
| `src/trace.ts` | 改 | TraceEnv 删两方法（readPersistedBaseline/writePersistedBaseline），TraceContext 增 `getSessionFile(): string \| undefined`；onSessionStart 保留 previousSessionFile 参数（D4 SDK 类型直用），解析逻辑改三档（stash 优先 → reason="fork" 读事件 previousSessionFile → 否则 ctx.getSessionFile() 直读）；write() 删 env.writePersistedBaseline 双写；onTurnStart 基线命中分支删「续命刷新小文件」调用；mapReasonForFirstWrite 调用点类型随 D4；注释删「暂定待 P2」改引用 D2 v5 定案 |
| `src/types.ts` | 删+改 | 删 SessionStartReason、SESSION_START_REASONS、normalizeSessionStartReason；PromptBaseline.source 字段整体删除（三值全删——`"persisted"` 生产者随 persisted 删除消失；`"previous-session-file"` 生产者 v5 回炉后保留但为唯一生产值且全包零消费：grep `.source` 证实无任何属性读取点，保留单值枚举即死结构（第 1 轮 S-主审 同一裁决逻辑）；`"target-file"` 沦为常量；落盘 entry data SystemPromptTraceEntryData 不含 source 字段，类型收敛不触存量 JSONL）；mapReasonForFirstWrite 入参改 `SessionStartEvent["reason"]`；mapReasonForFirstWrite 注释删「暂定待 P2」 |
| `src/index.ts` | 改 | 删三 Like 接口，`import type { SessionStartEvent, SessionBeforeSwitchEvent, TurnStartEvent, ExtensionAPI, ExtensionContext }`；删 baselineFilePath 与 persisted wiring；toTraceContext 增 getSessionFile 适配（`ctx.sessionManager.getSessionFile()`）；三 handler 直接标注 SDK 类型 |
| `src/__tests__/baseline.a12.test.ts` | 改写 | 「路径 3」两用例改写为直读档场景（startup+目标文件直读；diff 摘要从 toBeUndefined 断言反转 toContain 断言）；「路径 4」兜底用例保留（构造 getSessionFile 返回 undefined）；删 persisted 文件读写断言与 source 字段断言（:270/:278） |
| `src/__tests__/index-wiring.test.ts` | 改 | fork 用例（:187-213）的 previousSessionFile 直读断言**保留**（v5 回炉后 D2 与现状语义一致，不再改指向 getSessionFile）；「仅刷新自持久化基线版本」断言删除；事件 payload 类型断言随 SDK；新增 previousSessionFile 三态防御用例（fake 字段构造缺失/源文件未落盘/读取失败 → 全部 null → resume v1 兜底——CLI 场景不可构造，见 V6 防御路径句） |
| `src/__tests__/trace.a11.test.ts` | 改 | 删「未知 reason 按 startup」用例（类型收窄后不可达）；computePromptHash 的 import 改本地 sha256 期望值；文件头 :8-9「fork/reload 暂按 resume（待 P2 实测定）」同族悬置标记一并定案（目标 5） |
| `docs/architecture/data-source-registry.md` | 回写 | §6:114 条目标废弃（「可安全手动删除」清单含主文件与 `system-prompt-trace-baseline.json.tmp_*` glob 残留）+ 条目内权威源死路径修正为 `extensions/taiji/system-prompt-trace/src/baseline.ts` + :120 engines.json 参照锚点修正（D3①②；同 commit，C-proc-10） |
| `extensions/taiji/system-prompt-trace/README.md` | 改 | 「跨重启 hash 基线四路径」章节（:38-46）改「三档」——删 persisted 路径描述，previousSessionFile 描述保留并按 D2 v5 定案更新（fork 档维持读它），自称「权威实现见 src/trace.ts onSessionStart」随实现同步；reason 映射表「fork/reload 暂定，待 P2 探针实测定」行改定案（D3③；目标 5 同族标记） |
| `docs/design/pi-session-start-handler-idempotency-audit.md` | 标注 | **两处** system-prompt-trace 行加历史性标注（D3④）：排查表行被删符号引用（readPersistedBaseline、baseline.ts:86-109、小文件路径）+ §4「其他事件注册事实」表行（:83）的「全局基线双写」表述（persisted 删除后无双写面）——时点审计记录不改写事实，stash 双注册残留发现在终态下仍有效 |
| `scripts/check-doc-symbol-drift.mjs` | 登记 | DOC_MODULE_MAP 增 `'docs/design/ext-simplify-02-system-prompt-trace.md': ['extensions/taiji/system-prompt-trace/src']`；同批按 D3 机检通道的机检清单处理待裸写符号（M3 时点剩 SESSION_START_REASONS ×2 处——第 3 处元引用与 TMP_RESIDUE_MARKERS、PID_FILE 已在第 2 轮随改裸写，checker 书写约定「反引号 = 现行代码符号」）；跑 checker 绿（D3 机检通道） |

错误规格不变量：所有基线读取函数继续不抛错（读失败返回 null）；handler 内 try/catch 顶层兜底保留（留痕是诊断性旁路，失败不得影响 agent 主流程）。

## 8. 验收（真实场景，非单测非 mock）

**本章结论：改动规模「中-大」（删持久化子系统 + 行为矩阵变化），用 6 个真实场景验收，每个回溯 §2 目标。**

### 8.1 改动规模

机制删除 + 基线解析矩阵重排 + 类型层归一——属「行为变更/接口调整」级，多场景验收；单测（a11/a12/wiring/diff 四套）仅作回归辅助，不计入验收。

### 8.2 验收场景

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| V1 | TUI 直用 pi：reload 去重 | 目标 1（reload 链路） | 本地 pi CLI 按 §6.5 统一环境执行：`PI_CODING_AGENT_DIR=<tmp agentDir> XYZ_AGENT_DEBUG=1 ./node_modules/.bin/pi --session-dir <tmp session-dir> --extension <本包 dist>`（TUI，凭据按第 4 要素预置）：发消息（产生 initial v1 + assistant）→ `/reload` → 再发消息 → 读 session JSONL | 留痕仍 1 条（reason/version/hash 不变）；`<tmp agentDir>/logs/` 下本包日志无 error 级条目（XYZ_AGENT_DEBUG=1 才落盘——extension-logger 缺省 no-op，文件不存在 ≠ 无报错；终态代码读路径静默、唯一 logger.error 点是 handler 顶层兜底，出现 error 即异常）；`<tmp agentDir>/` 无 system-prompt-trace-baseline.json 及 `.tmp_*` 新写动作（agentDir 由 PI_CODING_AGENT_DIR 产生，与 session-dir 独立） |
| V2 | GUI switch 主链路 | 目标 1（主链路零回归） | `pnpm dev` 起应用：session A 产生留痕 → 切到 B（new，写 initial）→ 切回 A → A 的 Trace 视图与切走前一致（实施按 impl-plan 偏差 D-10 以 CLI 等价链路执行，`pnpm dev` GUI 形态未走） | A 的留痕条数/version 不因往返切换增加；B 为独立 v1（无串基线）；全程无 stash 相关回归 |
| V3 | GUI skill 变更 reload | 目标 1 + 目标 2 | dev 运行中修改 `.agents/skills/` 下某 skill 文件 → 等 ReloadOrchestrator 触发 `/__xyz_reload__` → 继续对话 | reload 后留痕不新增（hash 命中）；改 skill 导致 prompt 实际变化时写 **resume** v+1 且 parentVersionDiffSummary 有值（reason 语义经 trace.ts:144-148 核实：baseline 非 null 分支恒为 resume，`change` 仅出现在 current 确立后的后续 turn）；runtime spawn pi 子进程注入的 agentDir 下无 baseline 小文件写动作——路径推导：rpc-client.ts:201 spawn env 注入 PI_CODING_AGENT_DIR = getPiAgentDir() 返回值 = `<dev 数据目录>/agent`（dev 即 `~/.xyz-agent-dev/agent`，从 getConfigDir() 动态推导），查该目录根无 baseline 主文件/.tmp_* 写动作（实施按 impl-plan 偏差 D-10 以 CLI 等价链路执行，`pnpm dev` GUI 形态未走） |
| V4 | 重启直启 resume + F1 修复 | 目标 3（diff 缺口） | 有留痕的 session（统一环境下 CLI 预造，如复用 V1 产物）→ 完全退出 pi/应用 → 按 §6.5 统一环境 `PI_CODING_AGENT_DIR=<同一 tmp agentDir> XYZ_AGENT_DEBUG=1 ./node_modules/.bin/pi --session-dir <同一 tmp session-dir> --extension <本包 dist> --resume` 直启（agentDir 必须与预造时同一——baseline 孤儿判定与 agentDir 检查都锚定它；凭据按第 4 要素预置于同一 tmp agentDir）→ 发消息（hash 命中）→ 修改 append 配置再发消息 | 命中轮零新增；变化轮新留痕 reason="resume"、version 续接、parentVersionDiffSummary 含 "+N -M lines" 形态内容（不再 undefined） |
| V5 | 负面行为：孤儿文件无影响 + 新 session 不误写 resume | 目标 1（不该发生的不发生） | 在 `<tmp agentDir>/`（PI_CODING_AGENT_DIR 隔离目录，不触真实 `~/.pi/agent`）预置一个旧 baseline 文件 `system-prompt-trace-baseline.json`（模拟存量用户）→ 跑 V1–V4 全流程；另开全新 session 发首条消息；验收完随 `<tmp>` 目录一并清理 | 预置文件全程不被读写（mtime 不变）；全新 session 首留痕 reason="initial" v1（不因孤儿文件写成 resume） |
| V6 | TUI fork 读源最后留痕（D2 v5 定案） | 目标 1（fork 链路）+ 目标 5（悬置关闭） | 本地 pi CLI 按 §6.5 统一环境执行（实装本包单 --extension，TUI）：发消息产生 v1（append 配置 A）→ 改配置 B 继续对话产生 v2 → fork 回仅含 v1 的早期 turn（`/fork` 或树导航）→ fork 后继续对话（配置未动，仍 B）→ 读 fork session JSONL → 改回配置 A 再对话 → 再读 | 第一步（prompt 未变）：fork 后首 turn **不写**留痕（hash 命中源最后留痕 v2，去重生效，与现状 persisted 行为一致）——fork 文件 JSONL 零 `xyz:system-prompt` 新增；第二步（改回 A）：新留痕 reason="change"（fork 后首 turn 的命中分支已确立 current baseline，配置再变走 change 分支而非 resume——resume 仅用于 session_start 后基线重确立的首 turn，与 V3/V4 语义区分）、version = 源最后留痕 v2 + 1（= 3）、parentVersionDiffSummary 相对源留痕 fullText 有值——version 自源末尾续接（F4 已知局限形态：起点相对新会话自身历史不直觉，但单调、无跳号漏记）。previousSessionFile 缺失/不可读兜底：首留痕 resume v1（防御路径，§5.2）——该子断言不在本 CLI 场景构造：源文件不存在的 fork 被 pi 直接拒绝（agent-session-runtime.js:216-218 对源文件缺失 throw，到不了 session_start），三态兜底由 index-wiring 单测以 fake previousSessionFile 承载（§7 测试改写面）。附注：position="at" 形态（/clone 与 extension command 触达，fork 点在 assistant 上）fork 新文件立即落盘、直读可命中截断点——非 /fork 常规入口，不在本场景覆盖；GUI 侧 fork 实际经 switchSession 走 resume 链路，已由 V2 覆盖 |

补充约束：全部 CLI 验收场景（V1/V4/V5/V6）与探针共用 §6.5 统一环境四要素（含第 4 要素凭据预置——`cp` 动作在 tmp agentDir 首次创建时执行一次，贯穿全程），同一 `<tmp agentDir>` 贯穿（V5 的预置对象、V1 的负向检查、V4 的直启复用同一路径）；V1/V4 与探针 P1/P3 共享执行产物，V6 与 P2 终态段共享（P2 终态段按 v5 方案 A 新断言、由 V6 执行；同一临时 session 可复用）；验收记录（JSONL 行摘录）贴 PR。

## 9. 实施

### 9.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M0 探针门 | 跑 §6.5 P1–P3 的 **pi 行为断言段**（一次性探针 extension + 临时 session-dir，按 §6.5 统一环境四要素执行——含第 4 要素凭据预置与 pi 入口锚定），产物留档。**已于 2026-09-12 执行：P1/P3 PASS、P2 FAIL（触发 D2 回炉，本设计 v5）** | ⛔ 门槛：D1/D2 赖以成立的 pi 运行时行为实证，不通过不开工（终态行为断言段不在本门——它们在 M2 后、合入前复跑，见 §6.5）；P2 未通过即按门设计回炉 D1/D2（v5 终态）后再开工，门的保护价值按预期兑现 |
| M1 类型归一（D4） | Like 簇删除 + SDK import + normalize 链删除 + 两 export 收敛 + 对应测试改写；`pnpm extensions:typecheck \|\| extensions:lint \|\| extensions:test` 三连绿（P4 即此门的编译验证） | 纯类型层先行，行为零变更，独立可验收（编译即证） |
| M2 机制删除（D1/D2 v5 终态） | baseline.ts 删 persisted 子系统 + trace.ts 三档解析 + types/index wiring + 测试改写 | §5 终态行为；V1–V6 验收 + P1–P3 终态断言段复跑（P2 按方案 A 新断言、由 V6 执行；合入前） |
| M3 登记回写（D3） | registry 条目废弃标注（含 tmp glob + 权威源死路径修正）+ engines.json 参照锚点修正 + 包 README「四路径」改「三档」 + 幂等审计两处行历史性标注 + drift checker DOC_MODULE_MAP 登记（含本文档待裸写符号调整——M3 时点剩 SESSION_START_REASONS ×2 处，清单见 D3 机检通道）+ 跑 checker 绿，同 commit 随 M2 | C-proc-10 同步纪律闭环（机检 + 人工清扫双通道） |

M1/M2 分两个 commit（类型层与机制层行为影响分离，review 面清晰）；M3 与 M2 同 commit。包版本 patch bump（taiji 组无独立外部消费者，内部简化无对外行为变化）。

### 9.2 下一层拆分

| 单元 | 说明 | justification |
|---|---|---|
| u1 类型归一 | M1 全部 | 独立可验收（typecheck 绿 + 行为零变更），先行避免 M2 机制改动与类型改动交叉 |
| u2 persisted 删除 + 三档解析 | M2 的 src 四文件 | D1/D2（v5 终态）的最小落地面；依赖 u1（onSessionStart 签名已定型） |
| u3 测试改写 | 三个测试文件 | 与 u2 同 commit 才能保持绿；单独拆会留红窗口 |
| u4 登记回写 | registry + 包 README + 幂等审计标注 + drift checker 登记四个登记面 | C-proc-10 纪律要求同 commit；独立单元便于 review 核对锚点与登记 |

### 9.3 待验证检查点

- §6.5 探针 P1–P3 的两段结果（pi 行为段已于 2026-09-12 M0 执行：P1/P3 PASS、P2 FAIL 并触发 v5 回炉；终态段 M2 后合入前复跑；设计阶段断言全部有 dist 源码依据，但纪律上仍以实跑为准——P2 即该纪律兑现的实证案例）。
- xyz-agent runtime spawn 直启链路（V4 的 GUI 侧变体）在 dev 数据目录隔离（`~/.xyz-agent-dev`）下复跑一次——排除打包 staging 层与直连差异（AGENTS.md「extension 改动优先在本地 pi CLI 实测」的交叉验证）。
- 已接受代价 1 的观察口径（见下）：合入后若 Trace 视图观察到 reload/重开场景留痕**成对重复**（同 hash 两条相邻留痕），说明「首 assistant 前中断 + 重开」窗口比预估频繁，回本设计重审直读档的 flush 语义假设。
- 已接受代价 4 的观察口径（见下）：合入后若 GUI Trace 收到「fork 会话留痕 version 起点混乱」类反馈，回本设计重审 D2 被否栏的混合方案（直读优先 + 源文件兜底）。

**已接受代价汇总**（四要素，承接现状设计 D2 的既有接受面）：
1. **首 assistant 前中断窗口（仅 reload 分支产生重复）**：留痕写入但 `_persist` 尚未 flush（session-manager.js:726-754 首条 assistant 前不落盘）+ 随后 reload → 直读档读盘 miss → 兜底重写一条（reason 按映射为 resume、version 重开 v1），flush 后表现为同 hash 两条相邻留痕。与现状的如实对照：**现状该窗口零丢失**——write() 在 appendEntry 后同步双写小文件（不受 `_persist` 延迟影响），reload 时 persisted 命中、不重写；终态该窗口命中即**确定**多写一条（不是概率性损耗；crash/退出分支旧留痕随进程丢失，重写恰一条、无重复）。量级：<0.1% 的预估对象是「窗口命中 + 随后 reload」的联合先验——需同时满足中断发生在首个 turn 的首条 assistant 落盘前（窗口以秒计）且用户随即 reload 该 session，两事件独立且均低频；persisted 自身写失败（IO 故障，现状注释已声明接受）是另一分布，不构成本代价的对照基线。恢复：无功能损失（留痕是诊断旁路，重复条目仅 Trace 视图噪音，version 序列自重写点起仍单调）；重审：见 §9.3 第三条（成对重复观察口径）；判定：可接受。
2. **孤儿 baseline 文件**：见 D3（≤10KB/agentDir 一次性，可接受）。
3. **session_start 读大文件**：直读档从读小文件（persisted）变读 session JSONL 全文（长 session 可达 MB 级）。量级：每 session_start 一次 readFileSync+倒序扫行，MB 级文件毫秒级，非热路径（现状 stash/fork 档本就如此读，仅 reload/直启档从读小文件变读大文件）；恢复：无需（无正确性影响）；重审：若未来观察到 session 启动延迟可加「只读尾部 N KB」优化（记入 backlog，本次不做）；判定：可接受。
4. **F4 语义偏差保留（v5 回炉新增，fork 基线 = 源文件最后留痕，可能指向 fork 点之后的版本）**：fork 回早期 turn 时基线取源文件最后留痕而非 fork 截断点前最后留痕——理想语义不可达（常态 fork 新文件未落盘、直读被证伪，见 D2）。量级：每次「fork 回早期」场景的形态性代价（非概率损耗）：fork 后 prompt 未变（高频，fork 操作本身不改配置）→ hash 命中不写，恰与去重意图一致；prompt 变 → version = 源最后留痕 + 1，起点相对新会话自身历史不直觉但单调、fullText/diff 诊断信息无损失；行为与现状路径 2 完全一致（零回归）。恢复：无功能损失（留痕是诊断旁路）；重审：见 §9.3 第四条观察口径；判定：可接受。

---

## 附录：变更历史

- v1（2026-09-12）：初稿。覆盖审计候选 2（C2 high）、候选 11（C11）与两项 low 级 export 收敛；探针 P1–P3 定为实施期门。
- v2（2026-09-12）：第 1 轮对抗式审查修复（主审 1 must-fix + 1 suggestion；影响面审 1 must-fix + 3 suggestion + 1 INFO 交接），逐条见下节修订记录。
- v3（2026-09-12）：第 2 轮聚焦复审修复（主审 1 must-fix + 1 suggestion；影响面审 1 must-fix + 2 suggestion），逐条见下节修订记录。
- v4（2026-09-12）：第 3 轮聚焦复审修复（主审 1 must-fix + 3 INFO 不计数项），逐条见下节修订记录。
- v5（2026-09-12）：M0 探针门执行——P1/P3 pi 行为段 PASS、P2 FAIL（pi 0.84.4 固有行为证伪「fork 并入 getSessionFile() 直读」），按 §6.5 P2 降级路径回炉 D1/D2：fork 档回退读 previousSessionFile（= 恢复现状路径 2 读取语义），基线解析终态从两档改三档，F4 登记为已接受代价 4；全文联动与方案对比重演见修订记录第 4 轮。

## 修订记录

### 第 1 轮（2026-09-12）

对照 `.review/ext-simplify-02-review.md`（主审）与 `.review/ext-simplify-02-review-impact.md`（影响面审）逐条修复。全部 must-fix 与 suggestion 已修，无未修项。

| # | 意见 | 修法 | 反例重演 / 方向裁决 |
|---|---|---|---|
| MF-主审 | P0-16：探针时序自相矛盾——§6.5「合入前」vs §9.1 M0「不通过不开工」，且 P1–P3 混入 M2 后才可观察的终态断言（改码前跑必红） | 选审查方向②（拆两段）并重构 §6.5：每条探针拆「pi 行为段（M0，一次性探针 extension 观察 reason/getSessionFile/文件内容）+ 终态段（M2 后合入前，实装包复跑）」；§9.1 M0/M2 行、开篇结论同步 | 重演审查反例：P1「日志确认直读命中」→ 直读命中归终态段，M0 只断言 reason 与 getSessionFile 指向（探针自带 fs 读取），反例消灭；P2「version = 截断点+1」→ 归终态段，M0 只断言 fork 文件内容范围，消灭；P3「diff 有值」→ 归终态段，M0 只断言 startup/无 previousSessionFile/目标文件/含 fullText，消灭。弃方向①（全部探针后移 M2 后）：它保住文档内部一致，但 D1/D2 的运行时前提改为实施后才实证，探针失败分支（P2 回退方案 A / P3 重审 D1）的返工面从「零实施」变成「M2 已实施」，门的保护价值归零——不符合「不通过不开工」的本意。连带：§8 补 V6 fork 场景（回溯目标 1+5），fork 终态验收不再悬置在时点曾自相矛盾的 P2 上 |
| S-主审 | P1-5：`PromptBaseline.source` 保留 `"previous-session-file"` 两值但 D1/D2 后无生产者（死值） | 弃「收敛单值」，改为 source 字段整体删除（含 readLastPromptFromSessionFile 的 source 参数）；§7 types.ts/baseline.ts 行与 a12 测试行同步 | 实读核实：全包 grep `.source` 零属性读取点（生产者三处：trace.ts:107 previous-session-file、baseline.ts:79 参数透传、baseline.ts:108 persisted——前两者随 D1/D2 消失，后者本就在删除面）。三值全删后 `"target-file"` 是无读者的常量，保留单值枚举 = 本次设计要消灭的那类死结构；落盘 entry data 不含 source（影响面审 INFO-2⑤ 实证），不触存量 JSONL。审查给的「收敛单值」方向会把死枚举换成死常量，不采纳 |
| MF-impact | P0-12：登记回写与悬空引用清扫清单不完整（漏 README「四路径」章节、幂等审计 ：20 被删符号引用；drift checker 显式登记制使清单内外清扫均无机检信号） | D3 采用段扩为四件登记（①registry 含 tmp glob ②engines.json 锚点 ③README「四路径」改「两档」+ reason 表定案 ④幂等审计历史性标注）+ 机检通道段（DOC_MODULE_MAP 登记本文档映射 + 本文档删除目标符号反引号口径调整）；§2 In-scope、§7 文件地图（新增 3 行）、§9.1 M3、§9.2 u4 联动 | 实跑核实 checker：①未登记文档零检查（现状 10 映射文档全绿不含本文档）；②文档侧候选提取只覆盖「蛇形大写 + getXxx(」——`readPersistedBaseline` 类非 get 驼峰即使登记也检不出，人工清扫清单不可省略（据此机检通道段显式声明盲区）；③审查方向中「registry 也登记映射」经实扫否决——registry 全仓横切，其反引号候选（TMP_RESIDUE_MARKERS、PID_FILE 等，精确数 7）不属本包符号，登记即误报，改为人工清单承担 |
| S-impact-1 | P0-19：孤儿登记漏 tmp 残留文件模式（`*.tmp_<pid>_<rand>` 双重故障产物） | D3 证据/效果与 registry 回写条目把 `system-prompt-trace-baseline.json.tmp_*` glob 一并纳入「可安全手动删除」清单 | —（量级极小，审查自评不阻塞） |
| S-impact-2 | P0-12：§4 矩阵 reload 行缺「prompt 已变」格（V3 的实际命中路径无矩阵可对照） | reload 行「后续 turn 行为」补「prompt 已变 → 写 resume v+1 带 diff 摘要」；顺带补 fork 行无 targetLeafId 分支的直读结果与行为格（主审 INFO 同源） | 重演 trace.ts 现状语义（:135-148）：baseline 非 null 且 hash 不等 → resume version+1 带 diff——与直启 resume 行同构，确认补格内容与实现一致 |
| S-impact-3 | P0-20：代价 1「与现状 persisted 丢失后果同级」类比失真（现状 persisted 同步落盘，该窗口零丢失） | 代价 1 如实重述：现状该窗口零丢失（同步双写不受 _persist 延迟影响）、终态该窗口确定多写一条（仅 reload 分支产生成对重复；crash 分支无重复）；<0.1% 预估对象改为「窗口命中 + 随后 reload」联合先验的显式论证；persisted IO 写失败标注为另一分布、不作对照基线；观察口径保留 | 重演两条路径：reload——现状 persisted 命中不重写 vs 终态档 2 miss 重写（同 hash 两条相邻，version 重开）；crash——旧留痕随进程丢失，终态重写恰一条。确认「确定多写」仅 reload 分支成立，重述与实现一致 |
| INFO-交接（影响面→主审） | V3 通过标准「写 change v+1」与实现语义不符 | V3 改「写 resume v+1」并注明语义依据（trace.ts:144-148：baseline 非 null 分支恒为 resume，change 仅在 current 确立后） | 实读 trace.ts:144-148 核实审查断言属实后采纳 |
| 主审 INFO（顺带，非计数项） | 编号引用错位（§6.4→§6.5）、fork 行缺第三分支、trace.a11 头 :8-9 悬置标记、行号微偏（readLastPromptFromSessionFile :57→:63、computePromptHash :65→:59） | 全部一并修正（§4/§7/目标 5 清扫面） | 行号经实读核实后修正 |

**被否谱系增补**：本轮无决策被推翻，D1–D4 均维持原裁决；被否栏新增两条修复方向裁决记录——探针「统一后移」（MF-主审方向①，击穿点：门的保护价值归零）与「source 收敛单值」（S-主审方向，击穿点：死枚举换死常量），分别见修订记录对应行。

### 第 2 轮（2026-09-12）

对照 `.review/ext-simplify-02-review-r2.md`（主审）与 `.review/ext-simplify-02-review-impact-r2.md`（影响面审）逐条修复。全部 must-fix 与 suggestion 已修，无未修项。本轮两份报告的 4 项上轮 findings 修复成立性均被确认（不重列）。

| # | 意见 | 修法 | 反例重演 / 方向裁决 |
|---|---|---|---|
| MF-主审 | P0-13：探针与验收脚本的运行环境参数缺失且互斥——V1 两条负向子检查（logs 无报错 / agentDir 无 baseline 写动作）受同一 getAgentDir() 支配（baseline 路径 index.ts:64 与 extension-logger 落盘同源），不存在让两者同时有效的配置；logs 检查依赖未声明的 XYZ_AGENT_DEBUG=1（extension-logger 缺省 no-op，恒假绿）；V5 预置按字面侵入真实 ~/.pi/agent；V3 检查路径无推导；§6.5 探针只挂一次性探针 extension 而留痕需本包在场（直读恒 null，P1/P3 降级路径有被脚本缺口误触发的 M0 门误判风险） | §6.5 新增「统一环境定义」三要素（PI_CODING_AGENT_DIR=<tmp agentDir> 隔离 agentDir——baseline 与 logs 同步隔离 + XYZ_AGENT_DEBUG=1 开日志 + --extension 按段加载：pi 行为段双加载现状版本本包与探针、终态段单加载实装包），P1 探针命令与脚注落位；V1/V4/V5/V6 场景列改按统一环境执行，V1 两条子检查改为同时有效的口径（logs 指向 <tmp agentDir>/logs/、agentDir 指向 <tmp agentDir> 根），V3 补 agentDir 路径推导（rpc-client.ts:201 runtime spawn 注入同款 env），V5 预置/检查/清理全锚定 <tmp>；§5.2 logs 排查指引与 §8 补充约束同步 | 先实读核实环境组合有效性再动笔：pi config.js getAgentDir()（env 有值即返回）+ extension-logger fileLog（join(getAgentDir(), "logs") + 双开关分级）+ index.ts:64 baseline 路径同源——PI_CODING_AGENT_DIR 重定向后两条子检查对象各自就位，矛盾消灭。反例重演：①只设 --session-dir 不设 env → agentDir 检查无对象（检查空转）→ 统一环境第 1 要素消灭；②设 env 但 logs 检查仍写 ~/.pi/agent/logs/ → logs 已移 <tmp>（检查空转）→ V1 通过标准改路径消灭；③不开 XYZ_AGENT_DEBUG=1 → 日志文件不产生（假绿）→ 第 2 要素消灭；④探针单加载 → 留痕恒不存在（P1 直读恒 null 误触降级）→ 第 3 要素双加载消灭；⑤V5 字面预置 → 侵入真实目录 → <tmp> 锚定消灭。连带校准：实读发现读路径全静默（readPersistedBaseline / readLastPromptFromSessionFile 读失败均静默 null，唯一 logger.error 点是 handler 顶层兜底），V1 原「无基线读取报错」指向的日志信号在现状与终态均不存在——改为「无 error 级条目」（被否记录见下） |
| MF-impact | P0-12：D3 机检通道的反引号调整清单漏计——按 checker 同款正则对本文档实跑提取，候选全集 5 个符号，原清单只处理 2 处提及；M3 与 M2 同 commit 后「按清单执行 → 跑 checker 绿」首跑必红（:184 元引用命中已删符号 + :311 两符号无白名单命中） | 机检通道段重写为候选全集清单，按两类分列处置口径：删除目标符号类（SESSION_START_REASONS ×3 处：SCQA、§6.4、机检通道段原元引用——末处随本轮改裸写，M3 处理前两处）与元引用类（TMP_RESIDUE_MARKERS / PID_FILE ×1 行——非映射模块符号且无白名单命中，随本轮在第 1 轮修订记录行改裸写）；补免处理核实记录（getSessionFile ×11 随 TraceContext export interface 入符号表；XYZ_AGENT_DEBUG / PI_CODING_AGENT_DIR 命中 ENV 白名单）与新增内容自检口径（getAgentDir() 等 get 前缀提及一律裸写）；§7 checker 行、§9.1 M3 行计数同步 | 本轮修订完成后按 checker 同款正则复跑全文提取自检：候选仅剩 getSessionFile（M2 后绿）+ ENV 白名单符号（绿）+ 待 M3 裸写的 SESSION_START_REASONS 两处（:8/:195，清单在案）——M3 时点推演「登记 + 按清单裸写 → checker 绿」可达，首跑必红反例消灭。自指攻击：机检通道段与修订记录自身若带反引号提这些符号会造新候选——本轮全部裸写，反例消灭。:311 处置择一：去反引号 vs 改写表述（被否，见下） |
| S-主审 | P1-5：SESSION_START_REASONS 带反引号提及实为 3 处（:8/:184/:195），非清单声称的 2 处 | 与 MF-impact 同一清单合并处理（上表第 2 行）——机检通道段按「×3 处」登记并注明第三处为该段原元引用、已随本轮裸写 | 同 MF-impact 重演 |
| S-impact-1 | registry :114 条目权威源列挂死路径 extensions/system-prompt-trace/src/baseline.ts（分组迁移遗留，旧目录不存在） | D3① 回写动作扩为「改标废弃 + 顺带修正死路径为 extensions/taiji/system-prompt-trace/src/baseline.ts」；§7 文件地图 registry 行同步 | 实读核实：ls extensions/ 仅 shared/taiji/universal 三目录，旧路径不存在；废弃条目挂死路径则读者按图索骥无实证——修正后可追溯 |
| S-impact-2 | 幂等审计 :83（§4「其他事件注册事实」表）还有第二处 system-prompt-trace 行：「全局基线双写」表述终态下不成立；D3④ 原只点名 :20 排查表行 | D3④ 历史性标注范围扩为该文档两处 system-prompt-trace 行（:20 + :83）；§7 文件地图幂等审计行同步 | 实读核实 :83 行原文「turn_start 双注册 → 本 session 重复 appendEntry + 全局基线双写」——persisted 删除后无双写面，该短语与 :20 行同性质（时点审计记录），同批标注不改写事实 |
| 主审 INFO（顺带，非计数项） | §7 章首「5 个源文件」与文件地图 4 个 src 行矛盾；README 行锚点 :36-45 实为 :38-46 | 「5 个」改「4 个」（与 §9.2 u2「src 四文件」一致）；锚点改 :38-46 | 机械性计数/行号错位，实读核对后修正 |

**被否谱系增补**：本轮无决策被推翻，D1–D4 与第 1 轮全部裁决维持；新增两条处置口径裁决记录——①「:311 元引用反引号改写表述」（击穿点：两符号名是转述 registry 候选名的事实内容，改写损失精确性且 checker 恢复动作首选「同步修正文档」的裸写路径，改采裸写）；②「V1 logs 检查保留『无基线读取报错』原表述」（击穿点：实读证明基线读路径全程静默不写日志，「基线读取报错」指向的信号不存在，检查空转——改采「无 error 级条目」口径，见 MF-主审行），分别见修订记录对应行。

### 第 3 轮（2026-09-12）

对照 `.review/ext-simplify-02-review-r3.md`（主审）逐条修复。must-fix 已修；3 条 INFO（不计数）一并处理，无未修项。本轮上轮 findings 修复成立性已被 r3 确认（不重列）。

| # | 意见 | 修法 | 反例重演 / 方向裁决 |
|---|---|---|---|
| MF-主审 | P0-13/P0-16：统一环境配方缺「模型凭据供给」要素——pi 凭据解析完全跟随 agentDir 重定向（auth.json = join(getAgentDir(), "auth.json")，config.js:436-437；models.json :431-433），fresh tmp agentDir 实测 `pi -p` 报 `No API key found for <provider>`，无法产生 assistant turn，而 P1–P3 pi 行为段与终态段、V1/V4/V5/V6 全依赖真实模型 turn——按字面执行 M0 门首跑即卡死在凭据，且有误触「回审 D1」降级路径的门误判风险。伴生缺口：探针命令字面 pi 未锚定版本（PATH 全局 pi 实测 0.85.1，实装基线 0.84.4 仅在 ./node_modules/.bin/pi），行为断言可能与基线错位 | §6.5 统一环境定义增补第 4 要素「凭据供给（预置 auth.json）」（三选一裁决见右栏）+ 四要素后新增「pi 入口锚定」段（命令中的 pi 一律指 ./node_modules/.bin/pi，实测 --version = 0.84.4，禁止裸写 PATH pi）；命令模板落位六处——P1 命令（锚定 + 凭据引用）、P1–P3 脚注（三要素→四要素 + 凭据预置）、V1 命令（锚定 + 凭据引用）、V4 命令（锚定 + 凭据 + 补全 `...` 省略的 --session-dir/--extension）、§8 补充约束（三要素→四要素 + cp 动作时机）、§9.1 M0 行（补统一环境四要素引用）；V5/V6/§5.2 核对后不改（见下） | 先实读凭据链再动笔：pi-ai auth/resolve.js 的 resolveProviderAuth 优先级 = overrides.apiKey > auth.json stored > ambient env（源码注释明确 stored owns the provider，env 仅在无 stored 时参与——fresh tmp agentDir 恒无 stored，env 路径恒可用）；env-api-keys.js getApiKeyEnvVars 映射表（anthropic 对 ANTHROPIC_API_KEY 等）实测存在。三选一实测对照（同一 fresh tmp agentDir + ./node_modules/.bin/pi + 同一 model）：①预置 auth.json 副本 → `pi -p` 输出 ok、exit 0，**选定**——凭据现状即在真实 auth.json（实测 6 provider 全 api_key 形态）一条拷贝零搬运、stored 为第一优先源、命令行与探针产物零凭据（泄漏面仅 tmp 落盘副本随验收清理）、tmp agentDir 形态与真实存量用户一致（与 V5 存量模拟同构）；②provider env（不预置 auth.json、仅设 XIAOMI_TOKEN_PLAN_CN_API_KEY）→ 同样 ok，**被否**——需先把 key 从 auth.json 搬进 env、OAuth 形态凭据无法走 env、key 进子进程环境；③--api-key（cli/args.js:58 → main.js:641-649 setRuntimeApiKey）**被否**——key 进命令行文本，探针产物贴 PR 泄漏面最大，且必须与 --model 组合（main.js:645）。M0 门完整链路重演：mktemp tmp agentDir → cp 真实 auth.json → PI_CODING_AGENT_DIR + XYZ_AGENT_DEBUG=1 + 锚定入口 + 双 --extension 同款命令 → assistant turn 正常产生，「首跑卡死在凭据」反例消灭；不预置凭据的对照跑实测确认 pi bootstrap 自建空 auth.json 与 models-store.json（第 4 要素附注「属 pi 自身文件、不属 V1 负向检查对象」的依据），V1「无 baseline 写动作」检查不受凭据预置影响（检查只锚定 system-prompt-trace-baseline.json 及 .tmp_*）；锚定重演：./node_modules/.bin/pi --version = 0.84.4 vs PATH pi = 0.85.1，「断言与基线错位」反例消灭 |
| 主审 INFO（顺带，非计数项）① | :338 自检结论 SESSION_START_REASONS 行号写「:8/:191」，实际第二处在 :195（§6.4 采用段）——v2 行号残留 | 第 2 轮修订记录两处同族残留一并修正（MF-impact 行「:8/:191」→「:8/:195」；S-主审行「:8/:184/:191」→「:8/:184/:195」） | grep 复核：带反引号的 SESSION_START_REASONS 当前实为 :8/:195 两处（:184 机检通道段与 :195 §6.4 在本轮新增内容之前，行号未漂移）；:341 行的「:184 元引用」「:311 两符号」为第 2 轮时点实况记录，r3 已核实对账相符，保持原样 |
| 主审 INFO（顺带，非计数项）② | §7 checker 行与 §9.1 M3 行的「5 符号」与紧随列举（3 符号/5 处提及）口径混用——「5 符号」是 :184 的 v2 时点全集口径（含免处理项），M3 执行面实为待裸写的 SESSION_START_REASONS ×2 处 | 两行统一为 M3 执行面口径：§7 checker 行改「待裸写符号（M3 时点剩 SESSION_START_REASONS ×2 处——第 3 处元引用与 TMP_RESIDUE_MARKERS、PID_FILE 已在第 2 轮随改裸写）」；M3 行同口径（「含本文档待裸写符号调整——M3 时点剩 SESSION_START_REASONS ×2 处，清单见 D3 机检通道」） | 与 D3 权威清单（:184-188，保留「v2 时点候选全集 5 个符号」历史口径与「实施时处理前两处」执行指引）对齐：全集口径留在 D3 段内自洽，§7/§9.1 引用处只报 M3 执行面数字，同一事实不再两种计数并存 |
| 主审 INFO（顺带，非计数项）③ | V4 命令模板 `...` 省略 --session-dir，依赖脚注隐含闭合 | 随 MF 命令模板落位一并补全（`PI_CODING_AGENT_DIR=<同一 tmp agentDir> XYZ_AGENT_DEBUG=1 ./node_modules/.bin/pi --session-dir <同一 tmp session-dir> --extension <本包 dist> --resume`），不再依赖隐含 | 补全成本≈0 且与 V1 模板同形态，字面执行者不再有「漏带 --session-dir 后 session 选择器空列表暴露再回看」的弯路 |

**被否谱系增补**：本轮无既有决策被推翻，D1–D4 与前两轮全部裁决维持；新增凭据供给三选一裁决记录（第 4 要素内）——「provider env」（实测可行但需搬运 key、OAuth 凭据不可用、key 进子进程环境）与「--api-key」（key 进命令行文本、产物贴 PR 泄漏面最大、须与 --model 组合）均写入第 4 要素被否栏，选定「预置 auth.json 副本」。

**联动同步清单核对（7.2 五处）**：①正文决策——§6.5 第 4 要素 + 锚定段落位；②终态数据流图——§4 数据流与验收环境要素正交，凭据不触基线解析链路，无需改；③错误规格表——§5.2 失败路径为终态运行时行为（JSONL 损坏 / getSessionFile undefined / 类型层），凭据缺失是探针环境前提缺口（第 4 要素内已给判定与恢复形态），不属 §5.2 面，无需改；④§5 拆分单元表 + §7 文件改动地图——探针环境是执行前提非代码改动面，§7 章首计数与文件清单不变；⑤§4 验收——V1/V4 命令模板、§8 补充约束、§9.1 M0 行已落位，V5/V6/§5.2 核对结论：V5 无命令模板且预置对象叙述已锚定 `<tmp agentDir>`（auth.json 预置与 baseline 孤儿预置同目录共存、检查对象不同不冲突）、V6 为叙述式引用统一环境自动覆盖、§5.2 为运行时排障指引与凭据无关，三处均无需改。

### 第 4 轮（2026-09-12）：M0 探针回炉（v5）

非对照审查报告——Step 7 协议回炉：M0 探针门（impl-plan u0-probe）实跑结果 P1（reload 档直读）PASS、P3（直启档直读）PASS，**P2（fork 档直读）FAIL**——pi 0.84.4 固有行为证伪「fork 并入 getSessionFile() 直读」，按 §6.5 P2 行既定降级路径回炉 D2 决策并全文联动。本轮为 v1 以来首次决策被推翻（D1 选定 B→A、D2 选定直读→读源），全部修订源自同一实证，无未修项。

**探针证伪（证据入档，自包含）**：

- 机制链：TUI /fork 调 fork(entryId) 无 options（interactive-mode.js:4305，选择器仅列 user message）→ position 缺省 "before"（agent-session-runtime.js:175），该形态要求 entryId 为 user message 且 targetLeafId = 其 parentId（:184-193）→ createBranchedSession 复制「root 到 targetLeafId 的路径」，且**仅当路径含 assistant message 才立即落盘**，否则 flushed=false 延迟到 `_persist()`（session-manager.js:1139-1151）→ fork 到首条 user message 时路径仅 session 头部链（真实会话 JSONL 佐证：首条 user message 的 parent 为 model_change/custom 链）→ 无 assistant → fork 新文件不落盘 → session_start 时点直读 null。
- 探针实测（A0-3）：snapshot.fileExists=false，原断言「内容 = 截断点前 entry」不成立；反向证据成立——fork 事件内 previousSessionFile 在且指向源文件（三分支 :211/:229/:246 均带），源文件已落盘、最后留痕含 fullText（42473 chars == charCount 实测）。
- 适用边界精确化（比初报措辞更窄的全称修正）：fork 到中间 turn（parent 链已含 assistant）时 fork 新文件**会**立即落盘且含截断点前留痕，该形态直读可命中——被证伪的是「fork 档直读可作为稳定基线路径」（结果依赖 fork 点、前提不恒成立），不是「任何形态都读不到」。

**方案对比重演（fork 档归属）**：

| 方案 | 内容 | 裁决 |
|---|---|---|
| A 回退 previousSessionFile | fork 档读源文件最后留痕（= 恢复 §1 现状路径 2 读取语义，仅删 persisted 写侧）；前提已探针实证（源文件已落盘、最后留痕含 fullText）；fork 后 prompt 未变 → 去重不写（与现状 persisted 行为一致）；prompt 变 → resume、version = 源最后留痕 version + 1 | **选定**——fork 档行为恒等现状（目标 1 零回归的最强证成），代价仅为 F4 登记为已接受代价 4 |
| B 接受 null 基线 | fork 后一律 resume v1 重开 | 被否——fork 后首 turn 恒写一条（即使 prompt 未变），去重对 fork 链路失效，与目标 1 冲突 |
| C 窄保留 persisted | persisted 仅供 fork 档只读 | 被否——写侧/原子写/tmp 唯一化/剪枝全保留（只读依赖写侧持续产出），双持久化源维持，直接违背目标 2 删除立意 |
| D 直读优先 + 源文件兜底（重演新增候选） | fork 档先试直读（中间 turn 命中截断点语义）、miss 再读 previousSessionFile | 被否——同入口两种基线方向（中间 turn 从截断点续接、早期 fork 从源末尾续接），行为依赖 fork 点不可预测；fork 档需 reason 特判两段式解析；单一「更准」场景的增益不抵特判复杂度，违背本设计删复杂度立意 |

| # | 意见 | 修法 | 反例重演 / 方向裁决 |
|---|---|---|---|
| MF-回炉 | M0 探针 P2 FAIL 证伪 D1（两档）采用段与 D2（fork 文件截断点）整节——fork 新文件常态形态下 session_start 时点未落盘，直读 null | D1 裁决翻转为方案 A 三档（采用/沿革/被否/证据/对比表五部分重写，沿革段记录翻转脉络）；D2 重写为「读 previousSessionFile 定案」（采用含防御规格、被否四案含重演新增的 D 混合案、证据含源码行号与探针实测、效果含 F4 登记去向）；§6 章首结论、SCQA 一句话结论与 A 段、§2 目标 5、§4 终态图与矩阵 fork 行、§5.1/§5.2、§7 文件地图六行、§8 V6、§9 联动（见下方五处核对） | 重演重点一：证伪断言的适用边界精确化（中间 turn 直读可命中）——避免「全称否定」过宽表述被后续实测反打；重演重点二：F4 从「待修复缺陷」重估为「可接受局限」——hash 命中不写恰与去重意图一致（fork 后 prompt 未变是高频形态），不命中则 version 单调且诊断信息无损，且与现状行为完全一致；重演重点三：D 混合案（v1–v4 不存在、本轮重演真实浮现的候选）显式立案并否决，防止「知道中间 turn 可直读却整体回退」或「为它保留混合双轨」两个偏差方向 |
| 登记 | P1/P3 PASS 结论、P2 降级标注与证据摘录需入档 | §6.5 P1/P3 降级列尾追加「已执行 PASS、降级路径未触发」；P2 行原断言标注「已被证伪」、终态段改按方案 A 断言、降级列写「已触发降级 + 四点关键证据（含源码行号与探针实测数）」；§6.5 脚注追加 M0 执行记录段；§9.1 M0 行登记执行日期与结果；§9.3 第一条同步（P2 成为「以实跑为准」纪律的实证案例） | P1/P3 验证的是直读档（reload/直启）前提，不受 fork 档回炉影响，PASS 结论与三档化兼容；终态段均未跑，仍锚定 M2 后合入前 |
| 登记面 | 既有引用计数与措辞漂移 | D3 免处理栏 getSessionFile ×11 → ×10（全文重数）；§7 a12 行「档 2 直读场景」改「直读档」；已接受代价 1/3 的「档 2」改「直读档」（v5 档位编号下档 2 = fork 档，沿用旧编号即指代错误）；§9.1 M3 行 README「两档」改「三档」 | 修订记录内历史行号/计数（第 1–3 轮的 :195、×11 等）按「不改写历史时点实况」先例保持原样 |

**被否谱系增补**：「fork 并入 getSessionFile() 直读——击穿反例：TUI /fork 常态形态（position=before）session_start 时点 fork 新文件未落盘（hasAssistant 条件 flush，session-manager.js:1144-1151），直读 null，V6 version=截断点+1 不成立（2026-09-12 M0 探针 A0-3 实测 + 源码定案；行号以 2026-09-12 实读 :1144-1151 为准，替代初报记录的 :1153-1163）」；同批新增「直读优先 + previousSessionFile 兜底混合」（见方案对比 D 行）。既有被否条目（探针统一后移、source 收敛单值、stash 机制删除、B+ 等）全部维持。

**联动同步清单核对（本轮五处逐项）**：①正文 D1/D2 采用段与终态描述——D1 五部分重写 + 沿革段、D2 整节重写、§6 章首、SCQA（一句话结论/A 段）、§2 目标 5：均改三档措辞并锚定 v5 定案，完成；②§4 物理数据流——终态图重画为三档（档 2 fork previousSessionFile / 档 3 直读）、矩阵 fork 行按 D2 v5 重写（机制 + 探针证据 + 兜底全落位）、矩阵标题同步，完成；③错误规格——§5.2 新增「fork 档 previousSessionFile 缺失/不可读」防御条目（SDK 注释声明该字段仅 new/resume/fork 存在——fork 三分支均带、常态必然在，但字段缺失/源文件未落盘/读取失败三态统一 null → resume v1 兜底），完成；④§7 实现机制与文件改动地图——trace.ts 行（三档解析 + previousSessionFile 参数保留）、baseline.ts 行（「四路径」改「三档」+ source 参数删除理由更新）、types.ts 行（source 字段三值删除理由按 v5 重写——previous-session-file 生产者保留但零消费死结构照旧）、index-wiring 行（fork 用例断言反转保留 previousSessionFile）、README 行与 D3③（「两档」改「三档」+ previousSessionFile 描述保留）、D4 效果段（Like 接口不恢复注记）完成；§7 章首「4 源文件 + 3 测试文件 + 4 登记面」计数复核不变；⑤§8 验收与 §9 迁移/拆分——V6 通过标准按方案 A 重写（prompt 未变 → 不写；变 → resume v=源+1；position=at 附注；防御路径注明）、补充约束 P2 终态段引用同步、M0/M2 行、u2、已接受代价 4、§9.3 两条观察口径：完成。

**checker 口径自检**：修订完成后以 checker 同款正则（反引号 span 内蛇形大写 ≥2 段 + get 前缀驼峰紧跟 "("）全文提取——候选仅四类：getSessionFile ×10（免处理，M2 后入符号表，计数已同步 D3 免处理栏）、SESSION_START_REASONS ×2（M3 待裸写清单在案，计数与 M3 执行面口径一致）、XYZ_AGENT_DEBUG/XYZ_AGENT_EXT_LOG/PI_CODING_AGENT_DIR（ENV 前缀白名单，绿）。本轮新增文本零新增清单外候选：hasAssistant/createBranchedSession/position/targetLeafId/flushed 等 pi 侧符号均为非候选形态（驼峰且非 get 前缀带括号形态），全程未以反引号候选形态出现；未引入新的蛇形大写候选；TMP_RESIDUE_MARKERS/PID_FILE 保持 0 命中（历史行已裸写）。

### 第 5 轮（2026-09-12）：r5/r4 聚焦复审修复（v5.1）

对照 `.review/ext-simplify-02-review-r5.md`（1 must-fix, 1 suggestion）与 `.review/ext-simplify-02-review-impact-r4.md`（0 must-fix, 0 suggestion, 2 INFO）：

| 意见 | 修法 |
|---|---|
| MF-主审（P0-13/P0-14）：V6 第二步断言 reason="resume" 与实现语义不符——fork 后首 turn 命中分支已确立 current（trace.ts:135-141），「改回配置 A」走 change 分支（trace.ts:127-132）；P2 终态段断言同族同错（第 1 轮修 V3 时的同族错误在 v5 重写 V6 时复发） | P2 终态段断言（§6.5）与 V6 第二步（§8）reason 改 "change" 并注明语义依据与 V3/V4 的 resume 语义区分；version=3 与 diff 断言不变，场景结构不动。决策翻转论证链经主审 r5 判定闭合（「行为恒等现状」含失败路径逐点同构、V6 构造可判、D 混合案被否成立），D1/D2 不动 |
| S-主审（P0-13 可执行性）：V6 防御路径子断言「源会话尚无 assistant 即 fork」在 TUI CLI 不可构造——agent-session-runtime.js:216-218 对源文件缺失直接 throw | 防御子断言从 V6 CLI 场景移出，改由 index-wiring 单测以 fake previousSessionFile 构造三态承载；V6 句与 §7 index-wiring 行同步落位 |

影响面 r4 四项聚焦核查全部通过（签名与现状同形 / fork 档性能零新增 / 三态防御可达性 / 代价 4 四要素齐全），2 条 INFO 不计数（代价 3 括注子面枚举、V6 position=at 附注描述为被否 D 案假设——附注已自声明不在覆盖内，零决策影响，不改）。

