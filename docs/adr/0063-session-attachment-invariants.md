# ADR 0063：session 附着不变量（I1-I5）

- 状态：Accepted
- 日期：2026-08-19
- 关联：restore-fork-attach-fix.md（P0 根因分析与 F4 护栏设计全文；已删除，git 可追溯，机制沉淀在 session-attach-assert.ts / session-lifecycle.ts 注释）· [ADR-0062](0062-single-data-owner-absolute-write-rule.md)（绝对写规则，本 ADR 的前置约束；其 §2 已增补第三类合法形态）· [data-source-registry.md](../architecture/data-source-registry.md) §4 ⑩（会话文件身份登记条目，I5 落点）

## 背景

2026-07-17 至 2026-08-19 间的 P0 数据丢失 bug：restore/fork 把会话内容拷进 `$TMPDIR` 临时文件 → 让 pi 附着 → 立即 unlink（注释自述「pi 已读入内存」）。此后每轮对话都写进按路径重建的 tmp 孤儿文件，登记的原会话文件永不更新，app 重启后新对话全部消失。bug 能存活 40 天无人察觉，暴露的不是单处代码错误而是**不变量缺失**——若下述任一不变量存在，bug 会在引入当天或第一次回归时暴露。

pi 附着语义（锚点均为 pi-mono 0.84.1 源码，本地 `~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/`；I4 要求：本文档全部 pi 行为断言带此级锚点）：

> **修订注（2026-08-20，pi-assumption-remediation W6）**：本文撰写时上述 clone 实际停留在 0.80.3 而 node_modules 实装为 0.84.1，锚点行号实为「0.84.1 dist 语义 + clone 行号形态」（审计报告 C #6 抽验核心锚点 setSessionFile / `_persist` 在 0.84.1 dist 成立，结论未失效；clone 现已更新，详见 troubleshooting 观察项）。查阅规则修订（只加不删）：**pi 语义断言的权威源 = node_modules 实装版**（断言前 `npm ls @earendil-works/pi-coding-agent` 核对版本），clone 仅作可读 TS 参照且引用前须核对版本。

- `modes/rpc/rpc-mode.ts:575-577`：`switch_session` RPC → `runtimeHost.switchSession(command.sessionPath)`。
- `core/agent-session-runtime.ts:193-209`：`switchSession` → `SessionManager.open(sessionPath)` → `createRuntime` **永久采纳**该 SessionManager（不是临时读一遍历史）。
- `core/session-manager.ts:815-816`：`setSessionFile` 把传入路径 resolve 后存为实例**永久字段** `sessionFile`。
- `core/session-manager.ts:934-960`：`_persist` 每轮 `appendFileSync(this.sessionFile, ...)` **按路径追加**——文件被删也会按路径重建（tmp 孤儿「复活」的机制）。
- `modes/rpc/rpc-types.ts:101`：`get_state` 响应含 `sessionFile?: string` 字段——附着后即实际写目标，I1 对账零成本。
- 附着瞬间 pi 即向目标文件写入 entry（实测 2026-08-19，每次附着 ~2 条 custom entry）——「附着 = 立即绑定写目标」的运行时自证。

## 决策：五条附着不变量

### I1 登记路径 ≡ pi 写路径

runtime 登记的 `sessionFilePath` 必须恒等于 pi 的实际写目标（`get_state().sessionFile`，`rpc-types.ts:101`）。附着错文件 = 此后每轮对话写错文件 = 数据丢失级 bug。

**机制**：`assertPiSessionFile(client, expectedSessionFile, context)`（`packages/runtime/src/infra/pi/session-attach-assert.ts`，独立零依赖模块，`process-manager.ts` re-export——独立的原因见该文件头注释）——`switchSession` 成功后调 `getState()` 比对，双侧 `path.resolve()` **词法**归一后仍不一致即 **throw**（fail loud，错误信息含双路径 + 上下文 + 恢复指引）。归一化定论（实测探针 2026-08-19，pi 0.84.1 macOS）：pi 侧 `resolvePath`（`utils/paths.ts:81`，`session-manager.ts:816` 调用）不做 symlink realpath 展开——`/var/folders/...` 与 `/private/var/folders/...` 输入各自原样返回，xyz 传入什么形态 pi 就回报什么形态，双侧同源 → `path.resolve()` 足够；symlink 视角差异本身就是要暴露的路径管理分裂，**刻意不用** `realpathSync` 归一。

**跳过分支的如实声明（三个，生产环境均不可达，仅适配单测 mock 生态）**：① `getState` 通道缺失（mock 缺方法）；② `sessionFile` 字段取不到（mock 把「无 sessionFile」当 create 路径延迟写入窗口正常态）；③ pi 报告路径 `existsSync` 为假（mock 的固定假路径不指向真实文件）。三者在真实 pi 均不可达：附着瞬间 pi 即写目标文件（本 ADR 背景节实测），`SessionManager.open` 必设 sessionFile。**分支 ③ 的已知覆盖缺口（W2 verifier 专项评估，判 minor 后裁决接受）**：若未来代码回归「附着 tmp → unlink」形态且 unlink 先于断言执行，pi 报告路径不存在 → 跳过 → 该形态护栏失效；最自然的回归形态（unlink 在内层 finally）下接线先于 unlink 执行仍被 mismatch 拦截，失效仅剩人为构造形态——收紧为 throw 需改造两个既有 mock 测试的假路径生态，留后续升级为可观测 error 时一并处理（观察项记录于计划 ledger）。若 pi 未来改字段名（协议漂移），I3 等价测试的真实 mismatch 断言会红，漂移检测不悬空。

**接线（无例外结构）**：restoreSession / forkSession（switchSession 后）+ withEphemeralPi（raceReadyTimeout 后）三处——新附着调用点照抄即得守卫。失败 throw 不 warn（D3：分裂静默 40 天的教训，warn 会被淹没）；既有 catch 分支 safeDestroy + rethrow 保证进程不泄漏。

### I2 会话内容只存在于 sessions 目录（+ 内存）

任何设计不得把对话数据放进 `$TMPDIR`（或其他临时目录）。tmp 目录会被 OS 清空、不被 xyz 扫描、不被备份——放进去 = 慢性数据丢失。合法位置只有 sessions 目录（`~/.xyz-agent/pi/sessions/`，pi 的写目标）与活跃进程内存。本 ADR 前置的 tmp 管线（拷 $TMPDIR → 附着 → unlink）已随 W1 整体删除；review 层拦截见 `pr-cr-fix` review-data-governance checklist（对话数据禁入 $TMPDIR 为 MUST）。

### I3 持久性屏障：进程退出/切换前，登记文件必须包含 pi 已写的全部 entry

会话进程退出/切换后，登记文件的内容必须与 pi 生前已写的 entry 一致——否则重启即丢轮次。**机制**：生命周期等价测试（`packages/runtime/src/__tests__/equivalence/attach-lifecycle.test.ts`，真实 pi 子进程 spawn，禁 mock）：附着正式文件 → 一轮真实 prompt → kill（SIGTERM→2s→SIGKILL，与 `RpcClient.kill`/`destroySession` 同语义）→ 文件断言（增长量守恒 + 逐 entry 类型可指认）→ 重新 spawn 附着同一文件断言历史逐条一致。restore/fork 两路径各一用例。**覆盖边界（如实声明，W2 verifier F3）**：等价测试直接驱动 `switchSession` + helper，不经过生产 `restoreSession`/`forkSession` 全管线——生产管线整段回退 tmp 附着时等价测试不红；该形态的运行时守卫是 I1 断言（接线在生产管线内，tmp 附着瞬间 mismatch 即 throw，dev 期暴露），CI 红线由 attach 断言的 mock 接线用例 + review checklist 步骤 9（对话数据禁入 $TMPDIR）承担。

### I4 对 pi 内部行为的断言必须引用 pi-mono 源码行号

「pi 已读入内存」「pi 会忽略未知类型」式臆断是根因温床。任何落进代码注释 / ADR / 设计文档 / 测试断言的 pi 行为声明，必须附 pi-mono 源码锚点（文件 + 行号，本地 clone 只读查阅，不靠网络搜索），且断言前须穷尽 pi 侧全部消费层。

[HISTORICAL] 两个已付出代价的案例（不削弱只加强）：

- **本次根因（2026-07-17 引入）**：`session-lifecycle.ts` 旧注释「pi 已读入内存，可安全删除临时文件」——未查证 `setSessionFile` 把路径存为永久字段（`session-manager.ts:815-816`）与 `_persist` 按路径追加（`:934-960`），臆断附着是「读一遍」，实为「永久重绑读写目标」。40 天数据丢失。
- **MF1 教训（2026-08-19 tech-design-review 推翻初判）**：初版判决「session_end 行可保留——pi parse 层不忽略但不抛错，xyz reducer default no-op 无害」。对抗式审查推翻：只查了 parse 层，漏了 pi **索引层** `_buildIndex`（`session-manager.ts:879-886`，对所有非 session entry 无差别 `byId.set(entry.id); leafId = entry.id`——无 id 的 legacy session_end 行使 `leafId = undefined`）与**追加层**（`appendMessage` 的 `parentId = this.leafId` 断链 → `buildSessionPath` `:330-352` 回溯终止 → 全部旧历史不进 LLM 上下文，AI 失忆）。教训：单层「无害」≠ 整体无害，断言必须穷尽 pi 侧全部消费层（parse → index → append → context build）。

review 层拦截见 review-data-governance checklist（pi 行为断言无锚点为 MUST）。

### I5 会话文件身份（sessionFilePath / attach 状态）是受治理数据

会话文件路径与附着状态此前无登记（「12 类 GUI 数据」未覆盖 runtime 记账层），双头分裂因此无对照源可查。登记落点：[data-source-registry.md](../architecture/data-source-registry.md) §4 ⑩——owner = runtime 记账层（`initializeManagedSession` 登记 + `assertPiSessionFile` 断言守卫），权威源 = sessions 目录扫描 + pi `get_state().sessionFile` 对账。改动会话文件身份链路的 PR 必须对照该条目（review-data-governance）。

## 后果

- 正面：同类 bug（登记路径 ≠ pi 写路径 / 对话数据进 $TMPDIR / 重启丢轮次）被三层护栏之一结构性拦截——运行时断言（I1，fail loud）、CI 回归网（I3，等价测试）、流程守卫（I2/I4，review checklist）+ 登记表对照（I5）。
- 正面：本 ADR 与 ADR-0062（绝对写规则）互补——0062 管「谁写文件」，本 ADR 管「附着到哪个文件 + 写了没丢」；restore-time 归一化作为 0062 §2 第三类合法形态与其边界约束（登记表 §4 ⑨）一致。
- 负面：每次附着多一次 `get_state` RPC（毫秒级只读，实测无感知）；等价测试需要真实 pi binary + LLM 凭证（skip-if-no-real-pi 双轨，CI 只跑凭证无关子集，完整基线在开发机）。
