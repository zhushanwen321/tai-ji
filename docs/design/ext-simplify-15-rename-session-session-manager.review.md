# ext-simplify-15 对抗式审查报告（rename-session + session-manager）

VERDICT: NEEDS-FIX (must-fix 2 / suggestion 3)

> **审查基线**：2026-09-13，本 worktree（feat-optimize-extension-over-engineering）当前源码实读。审查方法论 = over-engineering-audit skill（四问框架 + 反模式清单 + 豁免规则）。设计文档 v1 起草于 2026-09-11；**其后兄弟设计 `docs/design/rename-session-three-modes.md`（经 5 轮审查 v1→v3.4）吸收实施了本文档的 D1/D3 并关闭了 D4/C3，同时其 D5 决策推翻了本文档空 ref 等价性前提**——本报告事实核对全部以当前源码为准，不采信文档转述。
>
> **核心结论**：本文档的审计发现全部属实（M20/M25/B1-B3 无一伪问题），方案自身无过度设计；但其 rename-session 部分（D1/D3/D4/C3 + 验收 V1-V3 + 探针 P1）**已被 rename-session-three-modes 实施或改道，文档全文仍以「待执行」口吻书写**，实施者按现文档执行必与已实施代码冲突。**仍待执行且方案成立的 = D2（M25 双端死面删除，A4-A6）+ B1-B3（session-manager low 批）**，占文档执行项的主体，故判 NEEDS-FIX 而非 FAIL。

---

## 1. 事实核对表

| # | 设计文档声称（章节） | 当前源码核实（file:line） | 判定 |
|---|---|---|---|
| 1 | M20：`PI_RENAME_*` 四键全仓 0 生产 setter，唯一真实用法 = 1 个历史验收场景（§3.1/§6.1） | 全仓 grep `PI_RENAME_`：生产代码 0 命中；pure.ts:188-190 [HISTORICAL] 注释自证「已删（设计 rename-session-three-modes.md D6，吸收 ext-simplify-15 D1）：全仓 0 生产 setter、4 键中 3 键从未被用过」。历史验收文件 `docs/design/usage-page-fixes.impl-plan.md` **已被 retire**（commit fadd8b8b4 "retire 139 pipeline artifacts"，`git log --follow` 可考） | **属实，且已实施**（原文件 :41,102,123,147 引用现为死链） |
| 2 | M20 现状：pure.ts:53-57 常量 / :74-114 getEnvOverrides / :239-254 loadRenameConfig 4 层 / pure.test.ts:261-404 17 用例 / README:47-49 / SKILL.md:68-88,119-120（§3.1） | 以上代码**全部不存在**：pure.ts 现为 3 层（loadRenameConfig :192-202，flag > config > default）；pure.test.ts:336-377 现为「env 覆盖层删除负面」describe（TC-D6-1..3 锁定预置变量无幽灵效果）；README.md:47-56 现为 3 层优先级表 + [HISTORICAL] 声明；SKILL.md:105 [HISTORICAL] 声明 | **已被 rename-session-three-modes D6 实施改变**（终态即本文档 A1-A3 目标态） |
| 3 | §6.1：V8 场景改走「默认空 ref 真实路径」——`DEFAULT_RENAME_CONFIG.model = {type:"ref", ref:""}` → `parseRef("")` 返回 null → 与无效 ref 在同一 `!model` 守卫汇合（llm.ts:244-249）→ warn + 跳过 | **该路径在当前源码不存在**：llm.ts:274-275 `const model = config.model.ref === "" ? ctx.model : resolveModel(ctx, config.model)`——空 ref **跟随会话主模型**（rename-session-three-modes D5 语义变更，llm.ts:249/272-273 注释自证），只有非空 ref 解析失败才走 `!model` 守卫（llm.ts:276-280，warn "model not available, skipping" 仍在） | **失实（前提被 D5 推翻）**；文档 §6.1 自列的备选（显式无效 ref config）是唯一可行路径，且已被 rename-session-three-modes 附录 A 改道裁决（V3→V7）采纳 |
| 4 | P1 探针：验证「空 ref 与无效 ref 汇合同一 !model 守卫」（§6.6） | 同 #3——空 ref 走 ctx.model 分支，探针必失败；文档自带降级路径（「手写无效 ref config」）有效 | **前提失实**；降级路径有效（探针门可整体撤销或直接登记降级形态） |
| 5 | M25：`SessionManagerRequest` 类型死（§3.2 表第 5 行）——定义 + index.ts:57 re-export + README.md:33 引用；event-adapter 鸭子解析不依赖它 | types.ts:13-16 定义（文档写 :12-16，偏 1 行）；extension-protocol/src/index.ts:57 re-export ✓；extension-protocol/README.md:33 引用 ✓；全仓 grep 生产 import **0 命中**（仅协议包自身导出、自身测试 validation.test.ts:33-36 导出断言 + session-manager.test.ts:60-70 类型标注、extension index.ts:75 **注释**引用、README、设计文档）；event-adapter.ts:644-663 `translateSessionManagerSelect` 鸭子解析 `as { action?, params? }`（文档 :615-633，行号漂移）不 import 该类型 ✓；handler 查表路由 :141-168 ✓ | **属实（未实施）** |
| 6 | M25：`create.model`/`create.thinkingLevel` 死字段（§3.2 表 1-2 行） | 协议 types.ts:37/:39 字段声明 + :96-97 守卫 ✓；handler :205 解构 + :216-217 透传 `modelOverride`/`thinkingOverride`（文档 :215-216，偏 1 行）✓；发送侧 extension src/index.ts:15-19 `CreateManagedSessionParams = {cwd, label?, prompt?}` 无此二字段 ✓ | **属实（未实施）** |
| 7 | M25：`list.spawnSource`/`list.parentAgentSessionId` 死字段（§3.2 表 3-4 行） | 协议 types.ts:63/:65 + 守卫 :128-129 ✓；handler :336-337 `wantSpawn = spawnSource ?? 'agent'`、:338 `wantParent` 恒取路由上下文 ✓；types.ts:64 注释自认「仅作显式收窄提示」✓；发送侧 index.ts:31 `Type.Object({})` + :212 `toParams: () => ({})` ✓；grep `spawnSource\|parentAgentSessionId` 在 session-manager 包内 0 命中 ✓ | **属实（未实施）** |
| 8 | Summary 结果类型的 `spawnSource`/`parentAgentSessionId` 有真实产出，保留（§3.2 注） | types.ts:171-172 声明 + handler :352-359 list 响应真实 map 产出 ✓ | **属实** |
| 9 | isSubagentSession 路径嗅探 + 布局已变更过一次（F3/§6.3） | llm.ts:45-47 `sessionDir.includes(path.sep + "subagents" + path.sep)`（文档 :36-38，漂移）；path-encoding.ts:39-44 `getSubagentSessionDir` 产出 `subagents/<enc>/sessions`，:40-42 [MF#1] 回退注释（曾改 `subagents/sessions/<enc>/` 后回退）✓ | **属实，且 C-ext-21 已登记**（见 #10） |
| 10 | §6.3：需新登记 C-ext-21（authority：本文档 §6.3 锚点） | **constraints.json 已存在 C-ext-21**（完整条目：id/summary/scope/authority/dimensions/enforcement 五字段齐备）；双端互指注释已在：path-encoding.ts:22-26（点名 rename-session llm.ts isSubagentSession + C-ext-21）+ llm.ts:38-43（点名 path-encoding.ts + C-ext-21）。实际登记 authority = `design/rename-session-three-modes.md` §3.3 D7（非本文档 §6.3）；id 顺延正确（现有 C-ext-01..21，无冲突）；enforcement type:review + agent:review-arch-boundary，格式对齐 C-ext-19 先例 | **已被 rename-session-three-modes D7 实施完成**（登记内容与本文档 §6.3 设计一致，authority 归属不同） |
| 11 | preview 双维护两道对冲（§6.4 D4）：互指注释 + E2E 断言 | llm.ts:199 注释「e2e/harness.mjs 的 rebuildPreview 是同构实现，两处必须同步改」+ harness.mjs:202-204 对向注释 ✓；harness.test.mjs:27-73「rebuildPreview 三分支边界」单测 ✓；run-a1.mjs:12-13,:178-189 内容匹配主判别器（「日志 assistant 段 == rebuildPreview(原始文本)」双向锁定，含 >4000 码点前提失效守卫 :180-185）✓——任一侧单改阈值/格式，另一侧旧实现产生的重构文本必不匹配 → E2E 假红可发现 | **属实**；D4 裁决（零改动接受现状）依据成立，且已被 rename-session-three-modes 附录 A 登记「随本设计关闭」 |
| 12 | B1：`SessionManagerToolDetails` 三态联合写后无人读（§6.5 B1） | src/index.ts:60-64 类型 + :112/:130/:135 三处构造 ✓；消费链全查：① pi TUI 仅在工具注册 `renderResult` 钩子时消费 details（pi-coding-agent dist/modes/interactive/components/tool-execution.js:257 `resultRenderer({content, details})`），session-manager registerTool 未注册 renderResult（index.ts:157-173 仅 name/label/description/parameters/execute）→ TUI 默认渲染不读 details；② provider 层不读 details（pi-ai dist/providers/anthropic.js、google.js grep `details` 均 0 命中）→ **不进 LLM 上下文**；③ renderer/core 只消费 `details.__gui__`/`details.todos` 形状（truncate-tool-output、Block.vue extractGui 体系），SessionManagerToolDetails 无这些键 → 无消费；④ runtime 测试（session-manager-e2e-probe / equivalence）grep details 0 命中；⑤ 唯一读者 = extension 自身 tool-error-handling.test.ts:66,79（B1 已列改造）。注意 details 会写进 toolResultMessage 进 session JSONL（pi-agent-core agent-loop.js:532-544 `createToolResultMessage`）但无任何读者 | **属实（未实施）**；附实施类型坑见 S1 |
| 13 | B2：本地 `SessionManagerRawError` 与协议包 `SessionManagerErrorResult` 重复（§6.5 B2） | index.ts:53-58 本地声明（`{error, hint?, sessionId?}`）vs 协议 types.ts:181-186（`{error, sessionId?, hint?}`）形状完全一致 ✓；index.ts:5 已 import 协议包（文档写 :7，偏 2 行）→ 改 import 零新增依赖 ✓ | **属实（未实施）** |
| 14 | B3：6 工具 description 未声明 xyz-agent runtime 依赖，独立 pi 用户误调用白烧 30-60s（F4/§6.5 B3） | index.ts:182,:191,:200,:209,:218,:227 六个 description 均无依赖声明 ✓；README.md:22-24「运行要求」节自认「独立 pi CLI 环境无 handler 时工具将等待至超时（create/history 60s、其余 30s）」✓；SELECT_TIMEOUT_MS 分档 :44-51 ✓ | **属实（未实施）** |
| 15 | D3 被否证据：subagent-core 已有 `PI_SUBAGENT_*` env 贯穿，subagent-service.ts:265-274 注释自认「env 描述子进程自己的身份」（§6.3） | env 身份贯穿机制存在（subagent-service.ts:147「[R1] 跨进程身份贯穿 env 名常量（ENV_ROOT_SESSION_ID / ENV_DEPTH / ENV_ROOT_CWD」+ nested-visibility-env-propagation.test.ts 等），语义与「内部递归身份协议」一致；行号 :265-274 → 实际约 :147（大幅漂移，机制未变） | **部分属实**（内容成立，行号漂移） |
| 16 | 开篇 S 段：rename-session v0.7.0、session-manager v0.1.6 | 当前 package.json：rename-session **v0.9.0**（三模式 minor ×2）、session-manager **v0.1.7**、extension-protocol v0.9.0 | **版本基准漂移**（非事实错误，随 MF1 更新） |

---

## 2. must-fix 清单

### MF1：rename-session 侧四项（D1/D3/D4/C3）已被 rename-session-three-modes 吸收实施/关闭，本文档仍全文以待执行口吻书写——按现文档执行必与已实施代码冲突

- **文档位置**：§2 In-scope/目标 1、3、4；§6.5 执行项总表 A1-A3/C1/C2/C3 行（标「D1 直接执行」「D3 直接执行」「裁决零改动」）；§7 验收表 V1/V2/V3；§8.1 迁移路径 M1/M2 阶段；§8.3 待验证检查点第 1、3 条；开篇一句话结论。
- **源码证据**（均已实施）：
  - D1 已实施：`extensions/universal/rename-session/src/pure.ts:188-201`（env 层已删，3 层优先级 + [HISTORICAL] 注释点名「设计 rename-session-three-modes.md D6，吸收 ext-simplify-15 D1」）；`pure.test.ts:336-377`（env 负面测试 TC-D6-1..3）；`README.md:47-56`、`skills/rename-session-ext-config/SKILL.md:105`（[HISTORICAL] 声明）。
  - D3 已实施：`docs/constraints.json` C-ext-21 条目已存在（authority 指向 rename-session-three-modes §3.3 D7）；`packages/subagent-core/src/execution/path-encoding.ts:22-26` 与 `extensions/universal/rename-session/src/llm.ts:38-43` 双端互指注释已存在。
  - D4/C3 已关闭：`docs/design/rename-session-three-modes.md` 附录 A 表格明确「D4（preview 双维护接受现状）/ C3（export 面登记不执行）零改动裁决随本设计关闭，不再悬置」。
  - 吸收边界的权威登记：rename-session-three-modes.md 附录 A（「ext-simplify-15 后续落地时，其实施者须对照本表**跳过 D1/D3/D4/C3**，否则删 env 必与本设计冲突」）。
  - 死链证据：`docs/design/usage-page-fixes.impl-plan.md` 已被删除（commit fadd8b8b4 "docs(design): retire 139 pipeline artifacts"），本文档 §3.1/§6.1/§8.3 共 3 处引用（:41,102,123,147）全部悬空。
- **问题**：实施者按本文档执行会发生——A1-A3 对已删代码再执行（脏 diff 或困惑）；C1 重复登记已存在的 C-ext-21（id 冲突）；M1 阶段验收 V1-V3 中 V3 场景不可达（见 MF2）；§8.3 第 3 条指引实施者参考一个已不存在的文件。本文档是 git 已跟踪（commit 1725c4c94）的待实施设计，状态失真直接误导执行。
- **为什么必须修**：本仓约束「设计文档同步纪律（C-proc-10）」要求设计文档与现状一致；rename-session-three-modes 附录 A 已单方登记吸收关系并声明执行依赖「ext-simplify-15 落地时实施者自查」，本文档侧零标注则该自查机制断裂。
- **建议修法**：① 文档头部加状态框：D1→已被 rename-session-three-modes D6 吸收实施、D3→D7 吸收实施、D4/C3→随其关闭、**仍待执行 = D2（A4-A6）+ B1-B3**；② §6.5 表 A1-A3/C1/C2/C3 行标「已由 rename-session-three-modes 实施/关闭」并指向其附录 A；③ §7 删 V1/V2/V3（分别被 rename-session-three-modes V1/V8/V7 取代），保留 V4/V5；④ §8.1 删 M1 阶段，M2 改为首发阶段；⑤ §8.3 第 3 条死链改为 git 历史指针（fadd8b8b4^ 的文件版本）或直接删除该条。

### MF2：§6.1 核心采用论证、P1 探针、V3 验收场景的「默认空 ref」等价性前提已被 rename-session-three-modes D5 推翻——文档自身的可行性论证失实

- **文档位置**：§4 物理数据流（「模型解析：resolveModel(ctx, config.model) → null → warn → 跳过」段）；§5.2 失败路径第 1 条（「config 手写错」——仍成立，但「默认空 ref」隐含前提不在）；§6.1 采用段（「原 U8-V8 验收场景改走默认空 ref 真实路径：enabled=true + 不配 model → parseRef("") 返回 null → 与无效 ref 在同一 !model 守卫汇合」）；§6.6 探针 P1；§7 V3（「同 V1 但不写 model config（默认空 ref）→ warn + 落账 0 + 无标题」）。
- **源码证据**：`extensions/universal/rename-session/src/llm.ts:274-275`：
  ```ts
  const model =
      config.model.ref === "" ? ctx.model : resolveModel(ctx, config.model);
  ```
  空 ref 分支直接取 `ctx.model`（跟随会话主模型，D5 语义），**不再经 parseRef/resolveModel → null 的静默跳过路径**；`!model` 守卫（llm.ts:276-280）只对「非空 ref 解析失败」和「ctx.model 为 undefined」生效。`pure.ts:33/:79` 注释与 `README.md:41`（「空 ref 跟随会话主模型（开箱即用），非空但解析失败（配错）才静默跳过」）同证。
- **问题**：按文档跑 P1 探针必失败（空 ref 不走被验证的守卫汇合路径）；V3 场景「不写 model config → 静默跳过 + 无标题」在当前源码不可达（会真实跟随主模型生成标题）。文档 §6.1 把「默认空 ref」写为主选、把「显式无效 ref config」写为降级备选——主备关系已反转。
- **为什么必须修**：即使 MF1 修复后 D1 不再执行，本文档仍是 M20 审计结论与 env 删除设计的权威记录之一；等价性论证是 D1「V8 场景改道」决策的支撑，前提失实会让后续读者得出「空 ref 静默跳过是现状」的错误结论（该语义恰是 rename-session-three-modes D5 要消灭的缺陷——「开着但不可用」）。文档可信度必须整体成立，因为 M25/B 批部分仍待按本文档实施。
- **建议修法**：§6.1 采用段、§4 数据流、§6.6 P1、§7 V3 四处改道登记：「空 ref 语义已被 rename-session-three-modes D5 改为跟随会话主模型，原 V8 等价性验证改用显式无效 ref（`invalid-provider/nonexistent-model`，parseRef 成功 → modelRegistry.find 失败 → null → 同一守卫），见该设计 V7 与附录 A 冲突裁决」；P1 探针行整体标「前提已被 D5 取代，随 D1 实施一并关闭（rename-session-three-modes 探针 P1/P2 已实测闭环，其 v3.4 变更历史）」。

---

## 3. suggestion 清单

### S1：B1 实施注记缺失——pi `AgentToolResult.details` 类型必填，直接删键会 typecheck 红

- **文档位置**：§6.5 B1 行（「删 SessionManagerToolDetails 三态联合与三处构造」）。
- **证据**：pi-agent-core `dist/types.d.ts:317-321`——`interface AgentToolResult<T> { content: ...; details: T; ... }`，**details 为必填字段**；extension executeTool（index.ts:106）返回类型显式含 `details: SessionManagerToolDetails`，registerTool 的 execute 契约是 `Promise<AgentToolResult<TDetails>>`（pi-coding-agent dist/core/extensions/types.d.ts:372）。完全删除 details 键对必填属性的结构赋值大概率触发 TS2739（实施时会立即发现，但文档未预告）。
- **建议**：B1 实施形态写明——删自定义三态类型后 `details: undefined`（或核对 registerTool 泛型 TDetails 推断是否允许省略键），executeTool 返回类型同步收窄。行为等价性本审查已代为核实（见 §4 第 7 条），无需额外探针。

### S2：版本基准漂移——S 段两包版本号已过时

- **文档位置**：开篇 S 段（「v0.7.0」「v0.1.6」）、§8.1 包版本策略段。
- **证据**：rename-session package.json 当前 **0.9.0**（三模式 minor 已发两次）、session-manager **0.1.7**、extension-protocol 0.9.0。
- **建议**：随 MF1 状态框一并更新；§8.1 的 bump 建议（rename-session minor）已随 D6 实际发布兑现，改为登记事实。

### S3：待执行项（D2/B 批）行号已漂移，实施前需刷新

- **文档位置**：§3.2 死契约位置图、§6.5 A4/A5/B1-B3 行号列（自声明「2026-09-11 实读」）。
- **证据**（文档值 → 当前实读值，均已实际读源码核对）：event-adapter.ts :615-633 → **:644-663**（translateSessionManagerSelect）、:749 → **:778**（marker 分发点）；session-manager-handler.ts :215-216 → **:216-217**；extension index.ts B2「:7 已 import」→ **:5**；rename-session llm.ts :36-38 → **:45-47**、:179 → :199、:181-189 → :201-209；path-encoding.ts :33-38 → **:39-44**；subagent-service.ts :265-274 → **:147 附近**；types.ts SessionManagerRequest :12-16 → :13-16。协议 types.ts 的 4 死字段/守卫行号（:37,:39,:63,:65,:96-97,:128-129,:171-172）与 handler :205/:336-338、extension :15-19/:31/:78/:212、B1 :60-64/:112/:130/:135、B3 :157-173 **未漂移**。
- **建议**：附录 A 修正记录补一行本轮漂移；实施 D2 时以符号名（非行号）定位。

---

## 4. 已核实无问题（附证据快照，防后续重复怀疑）

1. **M25「双端零消费」全称断言已穷尽证伪检索**：`SessionManagerRequest` 全仓生产 import = 0（grep 覆盖 ts/tsx/mjs/js/md/json/sh/py/yml——命 中仅为：协议包自身 re-export `packages/extension-protocol/src/index.ts:57`、协议包测试 validation.test.ts:33-36（导出断言）+ session-manager.test.ts:60-70（类型标注，测试不算生产调用方）、extension 注释 `extensions/universal/session-manager/src/index.ts:75`、两处 README、设计文档）。runtime 侧 `onSessionManagerRequest` 回调族（event-interpreter.ts:495/:941、server.ts:599、index.ts:523）是独立参数签名，不消费该类型。
2. **4 死字段发送方 = 0 双端确认**：extension 侧 schema（index.ts:15-19 create / :31 list）+ `spawnSource|parentAgentSessionId` 在 session-manager 包 grep 0 命中 + `SESSION_MANAGER_MARKER` 的 extension 使用方全仓仅 session-manager 一个包（其余命中均为 runtime/协议包自身/测试）→ 不存在第二发送方。
3. **「单 commit 双端同批删除」（D2）可行性成立**：A4-A6 全部落在 monorepo `packages/`（extension-protocol + runtime + 协议测试）——同 commit 编译闭包，无跨 npm 发布时序问题；session-manager 包**不 import 任何被删类型**（index.ts:5 仅 `SESSION_MANAGER_MARKER` + `SessionManagerAction`）→ 协议删除对其 typecheck 零影响，npm 版本耦合（session-manager `workspace:*` 依赖 protocol，publish 时解析为精确版本）不构成破坏面；桌面 builtin 扩展走 esbuild bundle staged（AGENTS.md 规则 17）恒同 commit；独立 pi 用户无 runtime 应答方，字段死活无影响。
4. **`SessionService.create` 的 `modelOverride/thinkingOverride` GUI 侧真实消费**（Out-of-scope 边界正确）：`packages/runtime/src/interfaces.ts:106-109`（Landing Model Chip > preset.modelOverride 优先级注释）、:286-287（Staging Mode ADR-0056 composer 暂存覆盖）。
5. **marker 通道本质复杂度豁免成立**：pi 0.84.4（npm ls 确认实装）无自定义 extension_ui_request 方法；ASK_USER/BRIDGE/GUI_WIDGET 同构先例在 event-adapter.ts 同文件（:674 translateBridgeSelect、:709 tryTranslateAskUserSelect、:778 marker 分发链）；SESSION_MANAGER_MARKER/ACTIONS 定义 `packages/extension-protocol/src/extensions/session-manager/marker.ts`。
6. **D2 被否方向 B 的安全反证属实**：handler :331-334 注释「LLM 可控 params 不得放宽过滤……否则 agent 可枚举其他 agent 的子 session（label/cwd 泄露）」——`list.spawnSource` 暴露确为方向性错误，删除方向获得安全票。
7. **B1 行为等价性成立**（本审查代验，文档未自证）：details 不进 LLM 上下文（pi-ai providers/anthropic.js、google.js grep `details` 0 命中）；pi TUI 仅经工具自注册的 renderResult 消费 details（tool-execution.js:257，session-manager 未注册）；renderer 只消费 `__gui__`/`todos` 形状；runtime 测试 0 断言。isError+content 已满足 LLM 判错（pi-agent-core createToolResultMessage :532-544 只把 content/isError 送进 toolResult 消息语义面）。
8. **A6 测试改造清单与现状吻合**：validation.test.ts:33-36（index.ts 导出 SessionManagerRequest 断言）、session-manager.test.ts:60-70（SessionManagerRequest[] 类型标注）+ :70-84（create 用例含 `model: 'm'`/`thinkingLevel: 'high'`——需同批删）、tool-error-handling.test.ts:66/:79（details 断言——B1 批）。
9. **D4 两道对冲真实存在且论证成立**：互指注释双向（llm.ts:199 ↔ harness.mjs:202-204）+ harness.test.mjs:27-73 三分支边界单测 + run-a1.mjs:178-189 内容匹配主判别器（日志文本 == rebuildPreview(原始文本)，双向锁定，单侧漂移必假红可发现）。
10. **e2e 隔离模式先例属实**：rename-session e2e/README.md:16（auth.json 迁移指引）、:28/:68（`PI_CODING_AGENT_DIR=$TMP/agent` env 样例）——V1/P1 备选的「先例」声称成立。
11. **startup-config-declaration 守卫不受 M25/M20 影响**：`src/__tests__/startup-config-declaration.test.ts:27` 仍断言 package.json startupConfig content 与 DEFAULT_RENAME_CONFIG 深相等（已随 mode 字段同批更新），A4/A5 不触碰。
12. **C-ext-21 登记完整性**：id 顺延无冲突（constraints.json 113 条，C-ext-01..21 连续）；scope/authority/dimensions/enforcement 字段齐备，enforcement `type:review + agent:review-arch-boundary` 与仓库 review 类先例一致（对照 C-ext-19 的 `type:machine`——机制不同属条目性质差异，非格式错误）。
13. **方案自身四问全过（无过度设计）**：全案仅三类动作——删除（D1/D2/B1/B2：概念数单调下降，-1 env 层、-1 类型、-4 字段、-3 处守卫/消费维护点、-1 本地重复类型）、登记（D3：零行为变更的显式化）、零改动裁决（D4/C3）；无任何新增机制/抽象/扩展点；被否方案谱系完整且各有反证（保留单键=骨架永续；方向 B=安全反证；env 收敛=契约面扩大；import subagent-core=role 失格）；探针 P1/P2 为实施期验证门非常驻机制；反模式清单逐条核对无信号（无 inner-platform/abstraction inversion/leaky abstraction/pass-through/second-system/Greenspun）。
14. **改测试不属「迁就简化」**：A2/A6/B1 删除的测试块测的就是被删机制自身（env 覆盖优先级、死类型导出断言、details 三态断言），被删机制无行为承诺需要保留测试守护；且 env 负面回归（TC-D6-1..3）已补——「删掉的层不再有幽灵效果」有新测试锁定。

---

## 5. 审查方法与范围说明

- 覆盖源码全读：`extensions/universal/rename-session/src/pure.ts`、`src/llm.ts`、`extensions/universal/session-manager/src/index.ts`（232 行）、`packages/extension-protocol/src/extensions/session-manager/types.ts`、`marker.ts`、`packages/runtime/src/transport/session-manager-handler.ts`、`event-adapter.ts`（marker 分发与鸭子解析段）、`packages/subagent-core/src/execution/path-encoding.ts`、`subagent-service.ts`（env 常量段）、相关测试与 README/SKILL 文档。
- pi SDK 断言以本 worktree 实装 `node_modules/@earendil-works/pi-coding-agent@0.84.4` + `pi-agent-core`/`pi-ai` dist 编译 JS 为准（npm ls 确认版本）。
- 关联设计 `docs/design/rename-session-three-modes.md`（吸收方，已实施）与 `ext-simplify-index.md` 仅读作状态参照，其转述均经源码复核。
- 本审查未修改任何设计文档与源码；唯一产物为本报告文件。
