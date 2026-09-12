# ext-simplify-15：rename-session + session-manager 过度设计收敛（删 PI_RENAME_* env 覆盖层 + 协议死面双端删除）

> **一句话结论**：删除 rename-session 的 `PI_RENAME_*` 四键环境变量覆盖层（0 生产 setter，唯一真实用法是 1 个验收场景，改走「默认空 ref」真实路径）；单 commit 双端同批删除 session-manager 协议的 4 个死请求字段 + 1 个纸面类型；isSubagentSession 路径嗅探与 subagent-core 目录布局的跨包耦合登记 constraints.json（C-ext-21）+ 双端注释；preview 格式双维护裁决接受现状（既有互指注释 + E2E 断言双重对冲）；顺带清理 session-manager 包内 3 处 low 死面。

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-rename-session`（v0.7.0）在 session 首个成功 turn 后用独立 LLM 生成会话标题；`@zhushanwen/pi-session-manager`（v0.1.6）提供 6 个 agent 自管子 session 工具，经 `ctx.ui.select(SESSION_MANAGER_MARKER)` 通道对接 xyz-agent runtime 的 `SessionManagerHandler`，嵌套 `{action, params}` 契约 SSOT 在 `@xyz-agent/extension-protocol`。两包均为 builtin feature tier 扩展（可禁不可卸）。
- **C（冲突）**：2026-09-11 过度设计审计证实——rename-session 的配置解析存在 4 层优先级（env > flag 文件 > config 文件 > 默认），其中 env 覆盖层全仓 0 个生产 setter，4 键中仅 1 键被 1 个历史验收场景用过一次；session-manager 协议有 4 个请求字段 + 1 个请求类型无任何发送方/消费方（唯一客户端的工具 schema 从未暴露它们，runtime 侧却有守卫与消费点在维护）；isSubagentSession 用路径段嗅探判定子 session，与 subagent-core 的目录布局决策双端硬编码、无任何守卫链接（该布局历史上已变更过一次）。
- **Q（问题）**：如何删掉这些零使用的配置面与协议死面，把跨包路径耦合显式化，同时保证 rename 主流程与 6 工具真实调用链零回归？
- **A（答案）**：env 层整体删除（验收场景改走真实配置路径）；死面从协议类型、运行时守卫、handler 消费点三处双端同批删除；路径耦合登记约束 + 双端注释；preview 双维护经裁决保留。本文展开。

**层声明**：本文档是「技术方案设计」层（下一层产物 = 可实施的代码任务 + 测试改造清单），准则 5/6/7 全适用。

**证据基线**：pi SDK 断言核对自本 worktree 实装 `node_modules/@earendil-works/pi-coding-agent@0.84.4`（npm ls 确认）；两包源码、`packages/extension-protocol/src/extensions/session-manager/`、`packages/runtime/src/transport/session-manager-handler.ts`、`packages/runtime/src/infra/pi/event-adapter.ts`、`packages/subagent-core/src/execution/path-encoding.ts` 均为 2026-09-11 实读，文内行号全部为实读值（与审计快照的行号差异见附录 A）。

---

## 1. 背景：被设计的两个 extension 是什么

**两个包解决的是同一个主题（session 生命周期）的两端：标题的可读性与子会话的可管理性。**

rename-session 挂 `turn_end` 事件：开关检查 → 排除 subagent 子 session → 首 turn 判定 → fire-and-forget 调 LLM 生成 slug 式标题 → `pi.setSessionName()` 落库。配置（开关/模型/标题长度/thinking 档位）从 `<agentDir>/config/rename-session-ext-config.json` 读取，另有 xyz-agent runtime 的 `auto-rename-enabled` flag 文件做 live 覆盖（[COMPAT] 契约，有明确移除计划 Remove after v1.0.0，不在本次范围）。

session-manager 注册 6 个工具（create/send/history/status/list/abort）。工具 execute 不直接做事，而是把 `{action, params}` JSON 序列化后经 `ctx.ui.select(SESSION_MANAGER_MARKER, [payload], {timeout})` 发出；runtime 的 event-adapter 检测 marker 后路由到 `SessionManagerHandler`，handler 执行归属校验/列表过滤/历史截断等编排，把结果 JSON 经 select value 通道回写。**marker 通道** = 用 pi 的 `select` 对话框 title 携带哨兵值 `\x00XYZ_SESSION_MANAGER` 当路由标记的通信机制——pi 0.84.4 无自定义 extension_ui_request 方法，这是双端对接的唯一可用通道（`ASK_USER_MARKER`/`GUI_WIDGET_MARKER`/`BRIDGE_MARKER` 同构先例），本质复杂度，不可砍。

## 2. 设计目标

1. **配置面收敛**：rename-session 的配置源从 4 层（env > flag > config > default）收敛为 3 层（flag > config > default），删除 `PI_RENAME_*` 全部解析、合成与文档代码；原验收场景（模型不可用静默跳过）改走真实配置路径仍可达成。
2. **协议死面清零**：session-manager 协议中无发送方的 4 个请求字段与无消费方的 `SessionManagerRequest` 类型双端删除；6 工具的 LLM 可见行为与 runtime 编排零变化。
3. **跨包耦合显式化**：isSubagentSession 依赖的 `subagents/<enc>/sessions` 目录布局登记为架构约束（constraints.json），布局漂移进入 review 视野；双端源码互相注释指向。
4. **已裁决保留项关闭**：preview 双维护（§6.4）与 llm.ts 管线函数 export 面（§6.5 E 项）经裁决落定，不再作为悬置发现。

**In-scope**：`extensions/universal/rename-session/`（src + tests + README + skills 文档）、`extensions/universal/session-manager/`（src + tests + README）、`packages/extension-protocol/src/extensions/session-manager/`、`packages/runtime/src/transport/session-manager-handler.ts`、`docs/constraints.json`（+ 生成的 constraints.md）。
**Out-of-scope**：`auto-rename-enabled` flag 契约（[COMPAT]，Remove after v1.0.0 另行处理）；`ModelSelector type:"ref"` 单变体判别联合（已是落盘 config 格式，稳定性对冲投机性，审计判定不可砍）；session-manager 的 universal 分组归属迁移（发现 8 的分组层面，涉 mandatory 清单与 AGENTS.md 列举联动，仅做最小修复见 §6.5 C 项）；`SessionService.create` 的 `modelOverride/thinkingOverride` 参数本体（GUI 侧有真实消费，只删 session-manager 协议的死字段）。

## 3. 现状：使用者眼里是什么样的

### 3.1 rename-session 配置解析的真实样子（取自 `src/pure.ts`）

`loadRenameConfig()`（pure.ts:239-254）每次 `turn_end` 都按 4 层优先级合成配置：

```
1. 环境变量覆盖   PI_RENAME_ENABLED / PI_RENAME_MODEL / PI_RENAME_MAX_TITLE_LENGTH / PI_RENAME_THINKING_LEVEL
                  （getEnvOverrides，pure.ts:74-114，live 读取，无效值静默忽略）
2. flag 文件      <agentDir>/auto-rename-enabled 存在 → enabled 强制 true（[COMPAT]，保留）
3. config 文件    <agentDir>/config/rename-session-ext-config.json（mtime+size 缓存）
4. 默认值         enabled:false, model:{type:"ref",ref:""}, maxTitleLength:50, thinkingLevel:"off"
```

文档面同步维护着这 4 层：README.md:47-49 与 skills/rename-session-ext-config/SKILL.md:68-88,119-120 各有一份优先级表 + 「环境变量未显式设置时 flag 才生效」的交互解释 + 容器化/CI 示例。而全仓 grep `PI_RENAME_` 的生产代码只有 pure.ts 自身；测试消费在 pure.test.ts:261-404（「环境变量覆盖」describe，含 17 个用例与 env 保存/恢复脚手架）；唯一的生产式用法是历史验收 `docs/design/usage-page-fixes.impl-plan.md:41,102,123,147`——U8-V8 场景用 `PI_RENAME_MODEL=invalid-provider/nonexistent-model` 验证「模型不可用静默跳过、不阻断主 turn」。

### 3.2 session-manager 契约的真实样子与 M25 死契约位置图

工具侧（`extensions/universal/session-manager/src/index.ts`）每个 action 的工具 schema 只暴露真实参数——create 是 `{cwd, label?, prompt?}`（:15-19），list 是空对象 `Type.Object({})` 且 `toParams: () => ({})`（:31,:212）。请求经 :78 `JSON.stringify({ action, params })` 手拼，**不经过协议类型检查**。

协议侧（`packages/extension-protocol/src/extensions/session-manager/types.ts`）却声明了更宽的请求面。**死契约**（0 发送方 + 消费点仅为维护自身而存在）的位置：

| 死面 | 协议侧（extension-protocol） | runtime 消费侧（session-manager-handler.ts） | 发送侧证据 |
|---|---|---|---|
| `create.model`（:37） | 字段声明 + 守卫 `isOptionalString(v.model)`（:96） | `handleCreate` 解构（:205）并透传 `modelOverride`（:215） | create schema（extension index.ts:15-19）无此字段 |
| `create.thinkingLevel`（:39） | 同上（:97） | 同上透传 `thinkingOverride`（:216） | 同上 |
| `list.spawnSource`（:63） | 字段声明 + 枚举守卫（:128） | `handleList` 读取并兜底 `'agent'`（:336-337,:346） | list schema 为空对象（:31,:212） |
| `list.parentAgentSessionId`（:65） | 字段声明 + 守卫（:129） | handler 明确忽略——`wantParent` 恒取路由上下文（:338），types.ts:64 注释自认「仅作显式收窄提示」 | 同上 |
| `SessionManagerRequest` 类型（:12-16） | 定义 + index.ts:57 re-export + README.md:33 | runtime event-adapter 按 unknown 鸭子解析（event-adapter.ts:615-633 `as { action?, params? }`），handler 用查表路由，两端都不经它类型检查 | extension 手拼（:78） |

注意区分：**结果类型** `SessionManagerSessionSummary` 的 `spawnSource`/`parentAgentSessionId`（types.ts:171-172）是 handler 响应里真实产出给 agent 的字段（handler :352-359），有真实消费，**保留**；死的只是请求参数侧。

### 3.3 真实失败模式

- **F1（幽灵配置层）**：用户 shell 里残留 `export PI_RENAME_ENABLED=false` 时，桌面 UI 的开关显示 ON 而 rename 实际关闭（env 静默压制 flag 与 config）——SKILL.md:75 需要专门一段解释这个交互，本身就是复杂度自证。该层无任何生产 setter，4 键中 3 键从未被任何人用过。
- **F2（纸面 SSOT 误导）**：协议类型 `SessionManagerRequest` 与 4 个死字段让维护者以为「创建时指定模型」「列表过滤」是已暴露的能力——实际唯一客户端从未发送，runtime 侧守卫与消费点在为不可达路径缴税（每字段 = 类型 + 守卫 + handler 路径三处维护）。
- **F3（无守卫的跨包耦合）**：isSubagentSession（llm.ts:36-38）判定 `sessionDir.includes(path.sep + "subagents" + path.sep)`，而该目录布局的 SSOT 在 subagent-core 的 `getSubagentSessionDir`（path-encoding.ts:33-38，`subagents/<enc>/sessions`）。该布局**已经变过一次**（path-encoding.ts:34-36 注释：曾改为 `subagents/sessions/<enc>/` 后回退，[MF#1]）；再变则 rename-session 静默误判（子 session 被改名 / 主 session 被跳过），两个包之间无编译期引用、无守卫、无登记，漂移只能靠人肉记忆。
- **F4（分组元数据失真）**：session-manager 标注 role=universal（独立 pi 用户可单独安装），但应答方唯一存在于 xyz-agent runtime——独立 pi CLI 里 6 工具全部等待超时（create/history 60s、其余 30s）后返回 cancelled，README.md「运行要求」一节自认。工具 description 未告知此依赖，agent 每次误调用白烧 30-60s。

### 3.4 根因

**两类根因**。其一，**为想象中的部署形态预置通用性**（second-system）：env 覆盖层的 docstring 声称服务「容器化部署、CI/CD」（pure.ts:230-237），但 pi extension 运行在用户桌面/CLI，仓库不存在容器化形态；协议死字段赌「工具面将来要暴露模型覆盖/列表过滤」，当前 0 发送方。其二，**契约的双端物理分离**：session-manager 的请求形状知识同时活在协议类型（没人用）、extension 手拼（运行时真相）、event-adapter 鸭子解析（运行时真相）三处，类型层成了纸面摆设；isSubagentSession 则是同一磁盘布局知识在两个无依赖关系的包里各写一份。

## 4. 物理数据流（现状 vs 终态）

> **配置源** = rename-session 决定一次 turn 是否 rename 时读取的优先级层。就是 §3.1 那张 4 层表。

配置解析（现状 4 源 → 终态 3 源）：

```
turn_end → loadRenameConfig()
  现状：env(getEnvOverrides live 读) > flag 文件 > config JSON > 默认
  终态：flag 文件 > config JSON > 默认        ← env 层整体消失，无第二读方
模型解析：resolveModel(ctx, config.model) → null（解析不到）→ warn "model not available, skipping" → 跳过 rename，主 turn 不受影响
  （llm-shared resolve.ts:22 parseRef 对空串/缺"/"返回 null → resolveRef null → llm.ts:244-249 同一 !model 守卫汇合）
```

session-manager 契约流（终态仅删不可达分支，链路形状不变）：

```
LLM 调工具（schema 可见面 = 真相面，终态前后一致）
  → extension index.ts:78 JSON.stringify({action, params})   ← 手拼，终态不引入类型依赖
  → ctx.ui.select(SESSION_MANAGER_MARKER, [payload], {timeout})
  → event-adapter.ts:749 marker 路由 → :615 鸭子解析 action/params
  → handler routes 查表 :141-168（守卫 isParams → run）
  → respond(select value 通道) → extension executeTool 解析 → isError/content
```

## 5. 终态：使用者眼里将是什么样的

### 5.1 成功路径（桌面用户，rename + 子 session 编排）

```
[用户] 桌面 SystemPage 打开自动重命名 → runtime 写 flag 文件 → 新 session 发首条消息
[pi]   turn_end(stop) → loadRenameConfig()（flag 命中 enabled=true）→ config.model 有值且可解析
       → LLM 生成标题 → setSessionName → 侧栏显示标题（与现状一致，唯一变化：shell 里的
         PI_RENAME_* 变量不再有任何效果）
[agent] 调 create_managed_session {cwd, label} → handler create 四步 → {sessionId, status:"created"}
       调 list_my_sessions {} → 本 agent 的子 session 列表（与现状一致）
```

### 5.2 失败路径（带恢复指引）

- **model 配置了不存在的 provider/model**（config 手写错）：`resolveModel` 返回 null → logger.warn「model not available, skipping」→ 主对话完全不受影响。恢复：改 config 文件修正 ref（无 env 路径后这是唯一模型配置入口）；排查看 `~/.pi/agent/logs/`（XYZ_AGENT_DEBUG=1）。
- **独立 pi CLI 用户误调 session-manager 工具**：select 等待至超时返回 `Session manager <action>: cancelled or timed out`（isError:true）。终态下 description 已声明依赖（§6.5 C），恢复：改在 xyz-agent 桌面环境使用，或卸载本扩展。
- **目标 session 不归属发起方**（abort/status/send）：与现状一致返回 `not managed by this agent` / `not_found`——剩余守卫全部保留，删除的 4 字段原本就不可达，错误闭环面零变化。

## 6. 关键决策与权衡

**本章结论：4 个决策——env 层整体删除（D1）、死面单 commit 双端同删（D2）、路径耦合登记不收敛（D3）、preview 双维护保留（D4）+ 一张执行项总表（§6.5）。**

### 6.1 D1：env 覆盖层删除形态（选定：四键整体删除 + V8 场景改走真实路径）

- **采用**：删除 `getEnvOverrides`（pure.ts:74-114）、`ENV_PREFIX`/`MODEL_REF_PART_COUNT` 常量（:53-57）、`loadRenameConfig` 内 env 合成段（:243-251，含 `!("enabled" in envOverrides)` 判断——flag 检查简化为无条件 `existsSync`）、pure.test.ts「环境变量覆盖」describe 整块（:261-404）、README/SKILL 的 env 文档行。原 U8-V8 验收场景（模型不可用静默跳过）改走**默认空 ref 真实路径**：`enabled=true`（flag）+ 不配 model → `DEFAULT_RENAME_CONFIG.model = {type:"ref", ref:""}` → `parseRef("")` 返回 null（resolve.ts:22）→ 与「无效 ref」在同一 `!model` 守卫汇合（llm.ts:244-249）→ 同一 warn + 跳过 + 主 turn 成功。零注入、零系统写入。
- **被否**：
  - **保留 `PI_RENAME_MODEL` 单键**——覆盖层骨架（getEnvOverrides/优先级合成/4 源文档/测试脚手架）全部保留，复杂度几乎没减，1 键的维护费照付，且「单键 env 覆盖」仍在赌「不经文件注入配置」场景。
  - **保留全部 4 键**——F1 幽灵配置层永续。
  - **V8 场景备选「PI_CODING_AGENT_DIR=<tmp> 隔离 + 手写 config」**（e2e/README 已有该模式先例）——保真度更高（连 config 解析路径一起测），但需迁移 auth.json，仅当 V3 等价性探针失败时启用（见 §6.6 探针表）。
- **证据**：`rg "PI_RENAME_" --glob '!node_modules' -l` 全仓仅 pure.ts / pure.test.ts / SKILL.md / README.md / usage-page-fixes.impl-plan.md（历史签收记录，不改）5 文件；`rg "PI_RENAME_" packages apps` 0 命中；startup-config-declaration.test.ts 断言 package.json `startupConfig.content` 与 `DEFAULT_RENAME_CONFIG` 深相等——默认值不动，该守卫不受影响；commands.ts 的 /auto-rename 双写只走 config/flag，不受影响。
- **效果**：目标 1；§5.1 成功路径成立；F1 消灭。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 四键全删 + V8 走空 ref（选） | 配置源 3 层与文档/测试/现实一致；删 ~60 行 src + ~140 行测试 | 低：pure.ts + 1 测试块 + 2 文档 | V8 等价性依赖「空 ref 与无效 ref 汇合同一守卫」（探针 P1 把关） | ✅ |
| 保留 PI_RENAME_MODEL 单键 | 覆盖层骨架永续，4 源文档继续解释优先级 | 低 | F1 残留 + 「env 压制 flag」交互继续要文档 | ❌ |
| 全部保留 | 与审计结论相悖 | 零 | 幽灵配置层 + UI 开关语义被 shell 污染 | ❌ |

### 6.2 D2：session-manager 死契约处理（选定：删除方向 + 单 commit 双端同批）

- **采用**：删除上表 5 个死面——协议侧删字段声明与对应守卫行（types.ts:37,39,63,65 + :96-97 + :128-129）、删 `SessionManagerRequest` 及其 re-export（index.ts:57）与 README.md:33 引用；runtime 侧 `handleCreate` 删 model/thinkingLevel 解构与透传（:205,:215-216）、`handleList` 删 spawnSource 读取（wantSpawn 固化 `'agent'`，:336-337）；同批更新协议包测试（validation.test.ts 的导出断言、session-manager.test.ts 类型标注）与两端 README/注释。**批次 = 单 commit 跨包同删**：extension-protocol 被 runtime 与 extension 双向依赖，字段/类型删除必须与消费点删除同 commit，否则 typecheck 红；也无独立可验收的中间态。
- **被否**：
  - **方向 B「在工具 schema 暴露使其有发送方」**——create.model/thinkingLevel 暴露 = agent 创建子 session 时自选模型，当前无真实场景（投机能力 + 工具 schema 膨胀）；list.spawnSource 暴露**方向性错误**：handleList 注释（:331-334）明确「LLM 可控 params 不得放宽过滤」，暴露它等于给 agent 开枚举用户 session 的口子。协议是同仓双端内部契约，删除后真有需求可低成本加回——无兼容负担。
  - **分批删除（先协议后 runtime 或按字段分两批）**——中间态编译红或死面半删，无验收价值。
- **证据**：发送侧唯一客户端 schema 从未暴露 4 字段（extension index.ts:15-19,:31,:212）；`rg "SessionManagerRequest\b"` 生产 import 0（仅协议包自身导出/测试/README + extension 注释引用）；event-adapter.ts:615-633 鸭子解析不依赖该类型；结果类型 `SessionManagerSessionSummary` 字段（types.ts:171-172）有 handler 真实产出，保留。
- **效果**：目标 2；F2 消灭；6 工具 LLM 可见行为与 runtime 编排 by construction 零变化（删的全是不可达分支）。

### 6.3 D3：isSubagentSession 路径耦合（contested 裁决，选定：登记 constraints.json + 双端注释）

- **采用**：登记新约束 **C-ext-21**（scope：`packages/subagent-core/src/execution/path-encoding.ts` + `extensions/universal/rename-session/**`；authority：本文档 §6.3 锚点；enforcement：review-arch-boundary；登记后跑 `node scripts/render-constraints.mjs` 重新生成 constraints.md），摘要声明「`<agentDir>/subagents/<enc>/sessions` 布局是 subagent-core 与 rename-session 的跨包契约，变更布局必须同批改 isSubagentSession」。双端注释互相指向：llm.ts isSubagentSession 注释补「布局 SSOT：subagent-core path-encoding.ts getSubagentSessionDir，约束 C-ext-21」；path-encoding.ts getSubagentSessionDir 注释补「消费方：rename-session isSubagentSession 路径嗅探（C-ext-21）」。
- **被否**：
  - **收敛实现之「读 spawn env 标记」**（subagent-core 已有 `PI_SUBAGENT_DEPTH` 等四键贯穿子进程，subagent-service.ts:271-274）——耦合并未消除，只是从「目录布局契约」换成「env 注入契约」，后者同样是 subagent-core 单方主导的**内部递归身份协议**（注释自认「env 描述子进程自己的身份」）；让 rename-session 读它 = 内部协议升格跨包公共契约，契约面反而扩大。
  - **收敛实现之「universal 包 import subagent-core」**——方向倒挂：role=universal 要求独立 pi 用户可单独安装，依赖 xyz-agent 内部包即失格。
  - **不登记维持现状**——布局已变更过一次（[MF#1]），漂移风险真实存在且命中模式是「静默误判」；登记是唯一零行为变更的对冲。
- **证据**：path-encoding.ts:34-36 [MF#1] 回退注释；subagent-service.ts:265-274 env 语义注释；发现 2 自评 low 的依据「影响面限于 best-effort 标题噪音」——不值得为它动 spawn 链路或引入反向依赖；constraints.json 现有 C-ext-01..20，新条目顺延 C-ext-21，格式对齐 C-ext-19 先例。
- **效果**：目标 3；F3 从「无守卫静默耦合」变为「登记约束 + review 可见」；行为零变更（纯注释 + 登记）。

### 6.4 D4：preview 格式双维护（contested 裁决，选定：接受现状）

- **采用**：不改代码。llm.ts `previewText`（:181-189，≤300 码点全文 / >300 head 200 + … + tail 100）与 e2e/harness.mjs `rebuildPreview`（:204-216）的同构实现保留，互指注释保留（llm.ts:179 已写「两处必须同步改」并点名 harness.mjs rebuildPreview），harness.test.mjs「rebuildPreview 三分支边界」单测（:23-73）继续锁定行为。
- **被否**：
  - **harness .ts 化**（改用 tsx/vitest 跑 run-a*.mjs）——e2e 是本地人工触发的验收资产（e2e/README，真实模型不进 CI），为消一处双维护改运行时形态，成本大于收益。
  - **抽共享 .mjs 供 llm.ts import**——src 混入 js 源文件，坏味道大于收益。
  - **接受现状的关键依据（审计未明说，本设计补全）**：双维护的漂移方向**两端都会被断言抓出**——run-a1 的内容匹配主判别器是「日志文本 == rebuildPreview(原始文本)」，任一侧单改阈值/格式，另一侧旧实现产生的重构文本必不匹配 → E2E 假红（可发现），不存在静默假绿。残留风险仅「e2e 不进 CI 故漂移在下次人工验收才暴露」，与 e2e 资产自身的定位一致。
- **效果**：目标 4 关闭；零代码改动。

### 6.5 执行项总表

| # | 包 | 位置（2026-09-11 实读） | 改动内容 | 性质 |
|---|---|---|---|---|
| A1 | rename-session | src/pure.ts:53-57,74-114,243-251 | 删 env 覆盖层（常量 + getEnvOverrides + 合成段，flag 检查简化） | D1 直接执行 |
| A2 | rename-session | src/__tests__/pure.test.ts:261-404 | 删「环境变量覆盖」describe 整块 | D1 直接执行 |
| A3 | rename-session | README.md:47-49、skills/.../SKILL.md:68-88,119-120 | 删 env 优先级行与示例，4 源改 3 源 | D1 直接执行 |
| A4 | extension-protocol | src/extensions/session-manager/types.ts:37,39,63-65,90-99(:96-97),124-131(:128-129),12-16；src/index.ts:57；README.md:33 | 删 4 死字段 + 对应守卫行 + SessionManagerRequest 及引用 | D2 直接执行 |
| A5 | runtime | src/transport/session-manager-handler.ts:205,:215-216,:336-337 | 删 handleCreate model/thinkingLevel 透传、handleList spawnSource 读取（固化 'agent'） | D2 直接执行（与 A4 同 commit） |
| A6 | extension-protocol | validation.test.ts、session-manager.test.ts | 删 SessionManagerRequest 导出断言与类型标注，改用各 params 类型 | D2 直接执行（同 commit） |
| B1 | session-manager | src/index.ts:60-64,:112,:130,:135 + __tests__/tool-error-handling.test.ts details 断言 | 删 SessionManagerToolDetails 三态联合与三处构造（写后无人读：pi TUI renderResult 不消费自定义工具 details，renderer 无消费，isError+content 已满足判错）；测试删 details 断言 | low 直接执行 |
| B2 | session-manager | src/index.ts:53-58 | 删本地 SessionManagerRawError 声明，改 import 协议包 SessionManagerErrorResult（:7 已 import 该包，形状知识归单点） | low 直接执行 |
| B3 | session-manager | src/index.ts:157-173（registerSessionTool） | description 统一追加「Requires the xyz-agent desktop runtime; standalone pi CLI will time out」（发现 8 最小修复；分组迁移 out-of-scope，登记待办） | low 直接执行 |
| C1 | 两包 + subagent-core | llm.ts:35-38 注释、path-encoding.ts:33-38 注释、docs/constraints.json + constraints.md | C-ext-21 登记 + 双端互指注释 | D3 直接执行 |
| C2 | rename-session | —（无代码） | D4 裁决记录，本文档即落点 | 裁决零改动 |
| C3 | rename-session | —（无代码） | llm.ts 管线函数/prompt 常量 export 仅测试消费（发现 4）：不执行——包入口只 re-export default，不构成公共 API 面；如需收紧由 code-simplify 批量加 `@internal`，不单包先行 | 登记不执行 |

## 6.6 探针清单（⛔ 实施期门）

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P1 | 默认空 ref 与无效 ref 汇合同一 `!model` 守卫：enabled=true + 不配 model → warn「model not available, skipping」+ 主 turn 成功 + 落账 0 + 无标题 | 本地 pi CLI：`PI_CODING_AGENT_DIR=<tmp>` 隔离 + flag 文件 + 无 model config，发一条消息，核对日志与 session JSONL（复用 e2e/README 的最小样例） | ⛔ 合入前 | 失败（空 ref 走了不同分支）→ V8 场景降级用 §6.1 备选「PI_CODING_AGENT_DIR 隔离 + 手写无效 ref config」，D1 结论不变 |
| P2 | M25 删除后 runtime 契约链不回归：marker 路由 → 查表守卫 → handler 编排 → select 回写 | `packages/runtime` 既有 session-manager-e2e-probe.test.ts 全绿 + GUI 实测（§7 V4） | ⛔ 合入前 | 失败 → 核对被删行与剩余守卫差异；确认删除误伤则回滚该字段并在此登记「有隐性发送方」，D2 重审 |

## 7. 验收（真实场景，非单测非 mock）

**本章结论：改动规模「中」（删配置源 + 删死面，LLM 可见行为不变），5 个真实场景，每个回溯 §2 目标。**

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| V1 | rename 主流程（pi CLI 实测） | 目标 1 | `PI_CODING_AGENT_DIR=<tmp>` + auth.json 迁移 + flag 文件 + config 写真实可解析 model（如 `xiaomi-token-plan-cn/mimo-v2.5-pro`，参照 e2e/README 最小样例）→ 新 session 发消息 | 标题落库（侧栏/session 名可见）；XYZ_AGENT_DEBUG=1 日志显示 rename with model；config/flag 路径工作正常 |
| V2 | env 残留负面（邻居不变量） | 目标 1 | 同 V1 环境但 shell 预置 `PI_RENAME_ENABLED=false PI_RENAME_MODEL=bad/x` 再跑 | 行为与无该变量完全一致（rename 正常、模型按 config）——「不该发生的不发生」：删掉的层不再有幽灵效果 |
| V3 | 模型不可用静默跳过（原 V8 等价） | 目标 1 | 同 V1 但不写 model config（默认空 ref） | 主 turn 成功 + logger.warn「model not available, skipping」+ session JSONL 落账条目（customType=rename-session）为 0 + 无标题 |
| V4 | session-manager 真实调用链 | 目标 2 | `pnpm dev` 起应用：agent 经 subagent-workflow 或直接调 create_managed_session（带 label）→ list_my_sessions → abort_session | create 返回 sessionId 且侧栏出现子 session；list 只含本 agent 的子 session（过滤语义不变）；abort 后状态 stopped；全程无守卫/回写回归 |
| V5 | 6 工具协议面回归 + 守卫保留 | 目标 2 | runtime 包既有 session-manager-e2e-probe / send-queue 测试全绿；GUI 中 agent 调 get_session_status 指向不归属的 session | 测试全绿；返回 not_found/error（不可见=不存在语义不变）——删除未误伤剩余守卫 |

补充：unit/typecheck 层面 `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` + runtime 包 vitest 全绿是合入门禁但**不计入验收**；V1/V3 共享一套临时环境可一次跑完；验收记录（日志摘录 + JSONL 片段）贴实施 PR。

## 8. 实施与下一层拆分

### 8.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 | 验收挂点 |
|---|---|---|---|
| M1 | D1 rename-session env 层删除（A1-A3） | 配置 3 源终态 | V1/V2/V3 + extensions 三连绿 |
| M2 | D2 双端死面删除（A4-A6，单 commit）+ D3 登记（C1） | 协议死面清零 + 耦合显式化 | V4/V5 + render-constraints --check 绿 |
| M3 | session-manager low 批（B1-B3） | 包内死面清零 + 依赖声明 | extensions 三连绿 + V4 复跑一次 |

M1/M2 可并行（不同包不同 commit）；M3 随 M2 之后。包版本：rename-session 配置面变更建议 minor bump，session-manager 无 LLM 可见行为变化 patch bump，extension-protocol 随 M2 patch bump（最终按仓库版本策略由实施定）。

### 8.2 下一层拆分清单

| 单元 | 说明 | justification |
|---|---|---|
| u1 = M1 | rename-session 单包自包含 | 单包可独立验收回滚，不牵协议包 |
| u2 = M2 的 A4-A6 | 双端契约删除 | 契约两端必须同 commit（编译闭包），跨包但单一主题 |
| u3 = M2 的 C1 | 约束登记 + 注释 | 纯登记零行为，独立 review 面（constraints.json 结构校验是独立门禁） |
| u4 = M3 | session-manager low 批 | 同包三个同性质 low 合一 commit，避免碎片提交 |

### 8.3 待验证检查点

- 探针 P1 实测结果（空 ref 等价性——源码依据充分但纪律上以实跑为准）。
- V4 在 dev 数据目录隔离（`~/.xyz-agent-dev`）下复跑一次，排除 builtin 打包 staging 差异（AGENTS.md「extension 改动优先在本地 pi CLI 实测」的交叉验证；session-manager 的应答方在 runtime，必须 GUI 实测）。
- usage-page-fixes.impl-plan.md:123 的 V8 程序描述在删除后失效——该文件是历史签收记录不改写；若未来重跑该 wave，按本设计 §6.1 的新程序执行（实施时在 PR 描述注明）。
- B3 的 description 追加措辞会进 LLM prompt 面（6 工具各 +1 句），实施时核对总 token 增量可忽略（估 <100 token/会话）。

---

## 附录 A：审计修正记录（审计快照 20260911 vs 实读 20260911）

1. **行号漂移（发现本身全部成立）**：session-manager-handler.ts 消费点（四问记录 :255-262/:346-352 → 实读 handleCreate :205,:215-216 / handleList :336-337）；extension-protocol list 守卫（:148-156 → :124-131）；pure.ts（:54-107 → 常量 :53-57 + 函数 :74-114）；session-manager src 描述「7 文件 248 行」→ 实为 src/ 单源文件 index.ts 232 行（+4 测试文件）。本文一律用实读值。
2. **补充事实（审计未载，影响裁决）**：① subagent-core 已有 `PI_SUBAGENT_*` 四键 env 贯穿子进程，但语义是内部递归身份协议（subagent-service.ts:265-274 注释），不构成比路径嗅探更优的判定源（D3 被否证据）；② list.spawnSource 的「暴露」方向与 handleList 自身安全注释（:331-334「LLM 可控 params 不得放宽过滤」）冲突，为删除方向加安全票；③ preview 双维护的漂移两端都会被 E2E 内容匹配断言抓红，无静默假绿（D4 强化依据）。
3. **不可砍项确认**：`ModelSelector type:"ref"` 单变体判别联合保持不动（落盘 config 格式 + startupConfig 声明守卫 + 前向兼容测试，稳定性对冲投机性）；select+marker 握手、6-action 生命周期、SELECT_TIMEOUT_MS 分档、标题生成管线分解、fire-and-forget detached promise 均为四问记录「疑似本质复杂度」判定项，本设计不触碰。

## 附录 B：变更历史

- v1（2026-09-11）：初稿。覆盖审计 M20/M25 + 单元 low 发现 2/3/4/6/7/8；4 个决策（D1-D4）+ 执行项总表 + 探针 P1/P2 + 5 验收场景。
