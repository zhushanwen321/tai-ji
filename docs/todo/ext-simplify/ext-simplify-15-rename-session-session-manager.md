# ext-simplify-15：rename-session + session-manager 过度设计收敛（删 PI_RENAME_* env 覆盖层 + 协议死面双端删除）

> **一句话结论（v2）**：本设计 rename-session 侧（D1 删 `PI_RENAME_*` env 覆盖层、D3 C-ext-21 登记、D4/C3 裁决）**已被兄弟设计 rename-session-three-modes 吸收实施或关闭**，本文档不再重复执行；D2 与 B1-B3 已实施落地（u1=6d73d3399 / u2=56a8ea995）——**本文档全部条目已实施或改道关闭**。v1 全文以「待执行」口吻起草，v2 全面改道登记（见状态框），v2.2 终态回写（见变更历史）。

> **状态框（v2，2026-09-13）**：
>
> | 本文档条目 | 状态 | 权威登记 |
> |---|---|---|
> | D1（删 env 层，A1-A3） | **已实施** | rename-session-three-modes.md D6（吸收 ext-simplify-15 D1）；pure.ts:188-192 [HISTORICAL] 注释自证 |
> | D3（C-ext-21 登记，C1） | **已实施** | rename-session-three-modes.md D7；constraints.json C-ext-21 已存在（authority 指向其 §3.3 D7） |
> | D4（preview 双维护）/ C3（export 面） | **已关闭** | rename-session-three-modes.md 附录 A「零改动裁决随本设计关闭」 |
> | V1/V2/V3 验收场景 | **已被取代** | three-modes V1（主流程）/ V8（env 残留负面）/ V7（空 ref 改道显式无效 ref，见 MF2 改道登记） |
> | D2（M25 双端死面删除，A4-A6） | **已实施**（u1=6d73d3399） | 本文档 §6.2 |
> | B1-B3（session-manager low 批） | **已实施**（u2=56a8ea995） | 本文档 §6.5 |

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-rename-session`（v0.9.0，三模式版本）在 session 首个成功 turn / 首请求 / agent 工具调用后用 LLM 生成会话标题；`@zhushanwen/pi-session-manager`（v0.1.7）提供 6 个 agent 自管子 session 工具，经 `ctx.ui.select(SESSION_MANAGER_MARKER)` 通道对接 xyz-agent runtime 的 `SessionManagerHandler`，嵌套 `{action, params}` 契约 SSOT 在 `@xyz-agent/extension-protocol`（v0.9.0）。两包均为 builtin feature tier 扩展（可禁不可卸）。
- **C（冲突）**：2026-09-11 过度设计审计证实——rename-session 的配置解析存在 4 层优先级（env > flag 文件 > config 文件 > 默认），其中 env 覆盖层全仓 0 个生产 setter（**该项已被兄弟设计吸收实施，见状态框**）；session-manager 协议有 4 个请求字段 + 1 个请求类型无任何发送方/消费方（唯一客户端的工具 schema 从未暴露它们，runtime 侧却有守卫与消费点在维护）——**该项已由本设计实施删除（u1=6d73d3399）**；isSubagentSession 用路径段嗅探判定子 session，与 subagent-core 的目录布局决策双端硬编码（**已登记 C-ext-21**）。
- **Q（问题）**：如何删掉 session-manager 的协议死面与包内 low 死面，同时保证 6 工具真实调用链零回归？（rename-session 侧的同类问题已由 rename-session-three-modes 解决，本文档只保留其审计结论与改道登记。）
- **A（答案）**：死面从协议类型、运行时守卫、handler 消费点三处双端同批删除（单 commit 编译闭包）；B1-B3 low 批同批清理；rename-session 侧各项按状态框指向 three-modes，不在本文档重复执行。

**层声明**：本文档是「技术方案设计」层（下一层产物 = 可实施的代码任务 + 测试改造清单），准则 5/6/7 全适用。

**证据基线**：pi SDK 断言核对自本 worktree 实装 `node_modules/@earendil-works/pi-coding-agent@0.84.4`（npm ls 确认）；v1 行号为 2026-09-11 实读，v2 于 2026-09-13 在 HEAD 0e714d2a1 上复核刷新（漂移明细见附录 A 第 4 条；与审计快照的行号差异见附录 A 第 1 条）。rename-session 侧现状断言以 rename-session-three-modes 实施后的源码为准。

---

## 1. 背景：被设计的两个 extension 是什么

**两个包解决的是同一个主题（session 生命周期）的两端：标题的可读性与子会话的可管理性。**

rename-session 挂 `turn_end` / `message_end` 事件并提供 `rename_session` 工具（三模式，rename-session-three-modes 终态）：开关检查 → 排除 subagent 子 session → 触发判定 → fire-and-forget 调 LLM 生成 slug 式标题 → `pi.setSessionName()` 落库。配置（开关/模式/模型/标题长度/thinking 档位）从 `<agentDir>/config/rename-session-ext-config.json` 读取（3 层优先级：flag > config > default，env 覆盖层已被 three-modes D6 删除），另有 xyz-agent runtime 的 `auto-rename-enabled` flag 文件做 live 覆盖（[COMPAT] 契约，有明确移除计划 Remove after v1.0.0，不在本次范围）。**本设计不再改动 rename-session 任何代码**。

session-manager 注册 6 个工具（create/send/history/status/list/abort）。工具 execute 不直接做事，而是把 `{action, params}` JSON 序列化后经 `ctx.ui.select(SESSION_MANAGER_MARKER, [payload], {timeout})` 发出；runtime 的 event-adapter 检测 marker 后路由到 `SessionManagerHandler`，handler 执行归属校验/列表过滤/历史截断等编排，把结果 JSON 经 select value 通道回写。**marker 通道** = 用 pi 的 `select` 对话框 title 携带哨兵值 `\x00XYZ_SESSION_MANAGER` 当路由标记的通信机制——pi 0.84.4 无自定义 extension_ui_request 方法，这是双端对接的唯一可用通道（`ASK_USER_MARKER`/`GUI_WIDGET_MARKER`/`BRIDGE_MARKER` 同构先例），本质复杂度，不可砍。

## 2. 设计目标

1. ~~**配置面收敛**~~：**已由 rename-session-three-modes D6 达成**（配置源 4 层 → 3 层，env 解析/合成/文档代码全删，原验收场景改道），本文档不再执行，保留 v1 审计结论作历史记录。
2. **协议死面清零（已达成，u1=6d73d3399）**：session-manager 协议中无发送方的 4 个请求字段与无消费方的 `SessionManagerRequest` 类型双端删除；6 工具的 LLM 可见行为与 runtime 编排零变化。
3. ~~**跨包耦合显式化**~~：**已由 rename-session-three-modes D7 达成**（C-ext-21 已登记 + 双端互指注释已在），本文档不再执行。
4. ~~**已裁决保留项关闭**~~：**已随 rename-session-three-modes 附录 A 关闭**（D4 preview 双维护接受现状 / C3 export 面登记不执行）。
5. **low 批清零（已达成，u2=56a8ea995）**：session-manager 包内 3 处 low 死面（SessionManagerToolDetails 三态联合、SessionManagerRawError 本地重复声明、description 缺依赖声明）同批清理。

**In-scope（v2 收敛后）**：`extensions/universal/session-manager/`（src + tests + README）、`packages/extension-protocol/src/extensions/session-manager/`、`packages/runtime/src/transport/session-manager-handler.ts`。
**Out-of-scope**：rename-session 包的全部代码与文档（已被 three-modes 吸收实施，见状态框）；`auto-rename-enabled` flag 契约（[COMPAT]，Remove after v1.0.0 另行处理）；`ModelSelector type:"ref"` 单变体判别联合（已是落盘 config 格式，稳定性对冲投机性，审计判定不可砍）；session-manager 的 universal 分组归属迁移（发现 8 的分组层面，涉 mandatory 清单与 AGENTS.md 列举联动，仅做最小修复见 §6.5 B3）；`SessionService.create` 的 `modelOverride/thinkingOverride` 参数本体（GUI 侧有真实消费，只删 session-manager 协议的死字段）。

## 3. 现状：使用者眼里是什么样的

### 3.1 rename-session 配置解析的审计现状（v1 基线；**已被 three-modes D6 实施消灭**）

> **状态**：以下为 2026-09-11 审计基线的记录（M20 立论依据，保留作历史）。env 覆盖层已随 rename-session-three-modes D6 删除——现行 `loadRenameConfig()`（pure.ts:193-203）为 3 层（flag > config > default），pure.ts:188-192 有 [HISTORICAL] 注释点名吸收关系；负面回归（预置 `PI_RENAME_*` 变量无幽灵效果）由 pure.test.ts:336-377 的 TC-D6-1..3 锁定。

`loadRenameConfig()`（v1 基线 pure.ts:239-254）每次 `turn_end` 都按 4 层优先级合成配置：

```
1. 环境变量覆盖   PI_RENAME_ENABLED / PI_RENAME_MODEL / PI_RENAME_MAX_TITLE_LENGTH / PI_RENAME_THINKING_LEVEL
                  （getEnvOverrides，pure.ts:74-114，live 读取，无效值静默忽略）
2. flag 文件      <agentDir>/auto-rename-enabled 存在 → enabled 强制 true（[COMPAT]，保留）
3. config 文件    <agentDir>/config/rename-session-ext-config.json（mtime+size 缓存）
4. 默认值         enabled:false, model:{type:"ref",ref:""}, maxTitleLength:50, thinkingLevel:"off"
```

文档面同步维护着这 4 层：README.md:47-49 与 skills/rename-session-ext-config/SKILL.md:68-88,119-120 各有一份优先级表 + 「环境变量未显式设置时 flag 才生效」的交互解释 + 容器化/CI 示例。而全仓 grep `PI_RENAME_` 的生产代码只有 pure.ts 自身；测试消费在 pure.test.ts:261-404（「环境变量覆盖」describe，含 17 个用例与 env 保存/恢复脚手架）；唯一的生产式用法是历史验收 `docs/design/usage-page-fixes.impl-plan.md`（U8-V8 场景用 `PI_RENAME_MODEL=invalid-provider/nonexistent-model` 验证「模型不可用静默跳过、不阻断主 turn」）。**注**：该 impl-plan 文件已于 commit fadd8b8b4（retire 139 pipeline artifacts）删除，本段引用仅为审计历史记录，v1 的 :41,102,123,147 行号引用现为 git 历史指针（`git show fadd8b8b4^:docs/design/usage-page-fixes.impl-plan.md` 可考）。

### 3.2 session-manager 契约的真实样子与 M25 死契约位置图

> **状态（v2.2 终态回写）**：以下为 2026-09-13 实施前基线（行号为当时实读值）。5 个死面已随本设计 u1（6d73d3399）双端同批删除——终态 = create 仅 `{cwd, label?, prompt?}`、list params 为 `Record<string, never>` 结构性拒绝、无 `SessionManagerRequest` 类型。

工具侧（`extensions/universal/session-manager/src/index.ts`）每个 action 的工具 schema 只暴露真实参数——create 是 `{cwd, label?, prompt?}`（:15-19），list 是空对象 `Type.Object({})` 且 `toParams: () => ({})`（:31,:212）。请求经 :78 `JSON.stringify({ action, params })` 手拼，**不经过协议类型检查**。

协议侧（`packages/extension-protocol/src/extensions/session-manager/types.ts`）却声明了更宽的请求面。**死契约**（0 发送方 + 消费点仅为维护自身而存在）的位置：

| 死面 | 协议侧（extension-protocol） | runtime 消费侧（session-manager-handler.ts） | 发送侧证据 |
|---|---|---|---|
| `create.model`（:37） | 字段声明 + 守卫 `isOptionalString(v.model)`（:96） | `handleCreate` 解构（:205）并透传 `modelOverride`（:215） | create schema（extension index.ts:15-19）无此字段 |
| `create.thinkingLevel`（:39） | 同上（:97） | 同上透传 `thinkingOverride`（:216） | 同上 |
| `list.spawnSource`（:63） | 字段声明 + 枚举守卫（:128） | `handleList` 读取并兜底 `'agent'`（:336-337,:346） | list schema 为空对象（:31,:212） |
| `list.parentAgentSessionId`（:65） | 字段声明 + 守卫（:129） | handler 明确忽略——`wantParent` 恒取路由上下文（:338），types.ts:64 注释自认「仅作显式收窄提示」 | 同上 |
| `SessionManagerRequest` 类型（:13-16） | 定义 + index.ts:57 re-export + README.md:33 | runtime event-adapter 按 unknown 鸭子解析（event-adapter.ts:644-663 `as { action?, params? }`），handler 用查表路由，两端都不经它类型检查 | extension 手拼（:78） |

注意区分：**结果类型** `SessionManagerSessionSummary` 的 `spawnSource`/`parentAgentSessionId`（types.ts:171-172）是 handler 响应里真实产出给 agent 的字段（handler :352-359），有真实消费，**保留**；死的只是请求参数侧。

### 3.3 真实失败模式

- ~~**F1（幽灵配置层）**~~：**已消灭**（three-modes D6 删 env 层；负面回归 TC-D6-1..3 锁定「预置变量无幽灵效果」）。v1 记录：用户 shell 里残留 `export PI_RENAME_ENABLED=false` 时，桌面 UI 的开关显示 ON 而 rename 实际关闭（env 静默压制 flag 与 config）——SKILL.md:75 需要专门一段解释这个交互，本身就是复杂度自证。该层无任何生产 setter，4 键中 3 键从未被任何人用过。
- ~~**F2（纸面 SSOT 误导）**~~：**已消灭（u1=6d73d3399）**。v1 记录：协议类型 `SessionManagerRequest` 与 4 个死字段让维护者以为「创建时指定模型」「列表过滤」是已暴露的能力——实际唯一客户端从未发送，runtime 侧守卫与消费点在为不可达路径缴税（每字段 = 类型 + 守卫 + handler 路径三处维护）。
- ~~**F3（无守卫的跨包耦合）**~~：**已登记**（C-ext-21 + 双端互指注释，three-modes D7）。v1 记录：isSubagentSession 判定 `sessionDir.includes(path.sep + "subagents" + path.sep)`，而该目录布局的 SSOT 在 subagent-core 的 `getSubagentSessionDir`（`subagents/<enc>/sessions`）；该布局曾变更过一次（[MF#1] 回退注释），再变则 rename-session 静默误判。
- **F4（分组元数据失真）——description 缺声明已修复（B3/u2=56a8ea995）；分组迁移仍登记待办（out-of-scope）**。v1 记录：session-manager 标注 role=universal（独立 pi 用户可单独安装），但应答方唯一存在于 xyz-agent runtime——独立 pi CLI 里 6 工具全部等待超时（create/history 60s、其余 30s）后返回 cancelled，README.md「运行要求」一节自认。工具 description 未告知此依赖，agent 每次误调用白烧 30-60s。

### 3.4 根因

**两类根因**。其一，**为想象中的部署形态预置通用性**（second-system）：env 覆盖层的 docstring 声称服务「容器化部署、CI/CD」（pure.ts:230-237），但 pi extension 运行在用户桌面/CLI，仓库不存在容器化形态；协议死字段赌「工具面将来要暴露模型覆盖/列表过滤」，当前 0 发送方。其二，**契约的双端物理分离**：session-manager 的请求形状知识同时活在协议类型（没人用）、extension 手拼（运行时真相）、event-adapter 鸭子解析（运行时真相）三处，类型层成了纸面摆设；isSubagentSession 则是同一磁盘布局知识在两个无依赖关系的包里各写一份。

## 4. 物理数据流（现状 vs 终态）

> **配置源** = rename-session 决定一次 turn 是否 rename 时读取的优先级层。**该部分已随 three-modes D6 实施收敛**（3 层终态即本设计 v1 的 A1-A3 目标态），此处仅保留终态事实与 D5 改道登记。

配置解析（**现状已是 3 源**）：

```
turn_end / message_end / rename_session 工具 → loadRenameConfig()（pure.ts:192-202）
  现状（= 终态）：flag 文件 > config JSON > 默认        ← env 层已删（three-modes D6）
模型解析（three-modes D5 终态语义，llm.ts:272-280）：
  config.model.ref === ""（未配置）→ ctx.model 跟随会话主模型（rename-session 开箱即用）
  config.model.ref 非空但解析失败 → resolveModel 返回 null → !model 守卫 → warn "model not available, skipping" → 跳过 rename，主 turn 不受影响
  〔v1 改道登记〕本设计 v1 曾以「空 ref → parseRef("") → null → 同一守卫」为原 V8 验收等价路径——
  该前提被 three-modes D5 推翻（空 ref 语义改为跟随主模型），等价性验证已改道为显式无效 ref
  （invalid-provider/nonexistent-model，parseRef 成功 → modelRegistry.find 失败 → null → 同一守卫），见 three-modes V7 与其附录 A 冲突裁决
```

session-manager 契约流（**现状口径**：不可达分支已删（u1），链路形状不变——阶段 5 实测；块内行号为实施前快照，按附录 A 先例以符号名定位）：

```
LLM 调工具（schema 可见面 = 真相面，终态前后一致）
  → extension index.ts:78 JSON.stringify({action, params})   ← 手拼，终态不引入类型依赖
  → ctx.ui.select(SESSION_MANAGER_MARKER, [payload], {timeout})
  → event-adapter.ts:778 marker 路由 → :644-663 鸭子解析 action/params
  → handler routes 查表 :141-168（守卫 isParams → run）
  → respond(select value 通道) → extension executeTool 解析 → isError/content
```

## 5. 终态：使用者眼里将是什么样的

### 5.1 成功路径（桌面用户，rename + 子 session 编排）

> rename 部分已由 rename-session-three-modes 交付并实测（其 V1/V4 场景）；此处保留 v1 描绘的终态以说明 D2 改动与用户可见面正交——本设计实施部分（D2/B1-B3，u1/u2）对以下两条路径**零可见变化——阶段 5 V4/V5 桌面实测 PASS**。

```
[用户] 桌面 SystemPage 打开自动重命名 → runtime 写 flag 文件 → 新 session 发首条消息
[pi]   触发判定命中 → loadRenameConfig()（flag 命中 enabled=true）→ 模型解析（空 ref 跟随主模型 /
         非空 ref 按 config）→ LLM 生成标题 → setSessionName → 侧栏显示标题（与现状一致）
[agent] 调 create_managed_session {cwd, label} → handler create 四步 → {sessionId, status:"created"}
       调 list_my_sessions {} → 本 agent 的子 session 列表（与现状一致）
```

### 5.2 失败路径（带恢复指引）

- **model 配置了不存在的 provider/model**（config 手写错，非空 ref）：`resolveModel` 返回 null → logger.warn「model not available, skipping」→ 主对话完全不受影响。恢复：改 config 文件修正 ref（config 是唯一模型配置入口）；排查看 `~/.pi/agent/logs/`（XYZ_AGENT_DEBUG=1）。（空 ref 不属失败路径——D5 终态语义为跟随会话主模型，开箱即用。）
- **独立 pi CLI 用户误调 session-manager 工具**：select 等待至超时返回 `Session manager <action>: cancelled or timed out`（isError:true）。现状 description 已声明依赖（§6.5 B3 已实施），恢复：改在 xyz-agent 桌面环境使用，或卸载本扩展。
- **目标 session 不归属发起方**（abort/status/send）：与现状一致返回 `not managed by this agent` / `not_found`——剩余守卫全部保留，删除的 4 字段原本就不可达，错误闭环面零变化。

## 6. 关键决策与权衡

**本章结论（v2.2 终态）：本文档全部条目闭环——D1/D3/D4/C3 已由 rename-session-three-modes 吸收实施或关闭；D2 与 B1-B3 已由本设计实施（u1=6d73d3399 / u2=56a8ea995）。各节保留 v1/v2 论证作审计记录。**

### 6.1 D1：env 覆盖层删除形态（**已由 three-modes D6 吸收实施**；v1 选型记录保留）

> **状态**：选定方案「四键整体删除」已由 rename-session-three-modes D6 实施完成（A1-A3 并入其 u1/u2），本节不再执行。v1 对「原 U8-V8 场景改走默认空 ref 真实路径」的论证**前提已被 three-modes D5 推翻**——空 ref 现语义为「跟随会话主模型」（llm.ts:274-275 `config.model.ref === "" ? ctx.model : resolveModel(...)`），不再走 `parseRef("") → null → 静默跳过`；该验收场景已由 three-modes 改道为 V7（显式无效 ref `invalid-provider/nonexistent-model`，parseRef 成功 → modelRegistry.find 失败 → null → 同一守卫），见其 D5 冲突裁决与附录 A。v1 的备选方案（PI_CODING_AGENT_DIR 隔离 + 手写无效 ref config）与改道后路径实质一致，已被采纳为 V7 程序。

- **采用（v1 选型，已实施）**：删除 `getEnvOverrides`（pure.ts:74-114）、`ENV_PREFIX`/`MODEL_REF_PART_COUNT` 常量（:53-57）、`loadRenameConfig` 内 env 合成段（:243-251）、pure.test.ts「环境变量覆盖」describe 整块（:261-404）、README/SKILL 的 env 文档行。
- **被否（v1 记录）**：保留 `PI_RENAME_MODEL` 单键（覆盖层骨架永续）；保留全部 4 键（F1 幽灵配置层永续）；V8 场景备选「PI_CODING_AGENT_DIR=<tmp> 隔离 + 手写 config」——保真度更高，已被 three-modes V7 采纳为改道形态。
- **证据（v1 记录）**：`rg "PI_RENAME_" --glob '!node_modules' -l` 全仓仅 pure.ts / pure.test.ts / SKILL.md / README.md / usage-page-fixes.impl-plan.md 5 文件；`rg "PI_RENAME_" packages apps` 0 命中；startup-config-declaration.test.ts 断言不受影响；commands.ts 的 /auto-rename 双写只走 config/flag。
- **效果**：~~目标 1~~（已由 three-modes 达成）；F1 已消灭（TC-D6-1..3 负面回归锁定）。

### 6.2 D2：session-manager 死契约处理（**已实施，u1=6d73d3399**；选定：删除方向 + 单 commit 双端同批——与实施完全一致，单 commit 跨 4 包 8 文件）

- **采用**：删除 §3.2 表 5 个死面——协议侧删字段声明与对应守卫行（types.ts:37,39,63,65 + :96-97 + :128-129）、删 `SessionManagerRequest` 及其 re-export（index.ts:57）与 README.md:33 引用；runtime 侧 `handleCreate` 删 model/thinkingLevel 解构与透传（handler :205 解构、:215-216 透传）、`handleList` 删 spawnSource 读取（wantSpawn 固化 `'agent'`，:337，连带 :346 过滤行）；同批更新协议包测试（validation.test.ts 的导出断言、session-manager.test.ts 类型标注与 create 用例中的 `model: 'm'`/`thinkingLevel: 'high'` 字段）与两端 README/注释。**批次 = 单 commit 跨包同删**：extension-protocol 被 runtime 与 extension 双向依赖，字段/类型删除必须与消费点删除同 commit，否则 typecheck 红；也无独立可验收的中间态。
- **被否**：
  - **方向 B「在工具 schema 暴露使其有发送方」**——create.model/thinkingLevel 暴露 = agent 创建子 session 时自选模型，当前无真实场景（投机能力 + 工具 schema 膨胀）；list.spawnSource 暴露**方向性错误**：handleList 注释（:331-334）明确「LLM 可控 params 不得放宽过滤」，暴露它等于给 agent 开枚举用户 session 的口子。协议是同仓双端内部契约，删除后真有需求可低成本加回——无兼容负担。
  - **分批删除（先协议后 runtime 或按字段分两批）**——中间态编译红或死面半删，无验收价值。
- **证据**：发送侧唯一客户端 schema 从未暴露 4 字段（extension index.ts:15-19,:31,:212）；`rg "SessionManagerRequest\b"` 生产 import 0（仅协议包自身导出/测试/README + extension 注释引用）；event-adapter.ts:644-663 鸭子解析不依赖该类型；结果类型 `SessionManagerSessionSummary` 字段（types.ts:171-172）有 handler 真实产出（:352-359），保留。
- **效果**：目标 2；F2 消灭；6 工具 LLM 可见行为与 runtime 编排 by construction 零变化（删的全是不可达分支）。

### 6.3 D3：isSubagentSession 路径耦合（**已由 three-modes D7 吸收实施**；contested 裁选型记录保留）

> **状态**：选定方案「登记 constraints.json + 双端注释」已实施——constraints.json 已存在 C-ext-21 完整条目（authority 指向 rename-session-three-modes §3.3 D7，非本文档）；双端互指注释已在（path-encoding.ts:22-27 点名 rename-session llm.ts isSubagentSession + C-ext-21；llm.ts:38-43 反向）。本节不再执行，v1 论证保留作审计记录。
- **被否**：
  - **收敛实现之「读 spawn env 标记」**（subagent-core 已有 `PI_SUBAGENT_DEPTH` 等四键贯穿子进程，subagent-service.ts:271-274）——耦合并未消除，只是从「目录布局契约」换成「env 注入契约」，后者同样是 subagent-core 单方主导的**内部递归身份协议**（注释自认「env 描述子进程自己的身份」）；让 rename-session 读它 = 内部协议升格跨包公共契约，契约面反而扩大。
  - **收敛实现之「universal 包 import subagent-core」**——方向倒挂：role=universal 要求独立 pi 用户可单独安装，依赖 xyz-agent 内部包即失格。
  - **不登记维持现状**——布局已变更过一次（[MF#1]），漂移风险真实存在且命中模式是「静默误判」；登记是唯一零行为变更的对冲。
- **证据**：path-encoding.ts:34-36 [MF#1] 回退注释；subagent-service.ts:265-274 env 语义注释；发现 2 自评 low 的依据「影响面限于 best-effort 标题噪音」——不值得为它动 spawn 链路或引入反向依赖；constraints.json 现有 C-ext-01..20，新条目顺延 C-ext-21，格式对齐 C-ext-19 先例。
- **效果**：~~目标 3~~（已由 three-modes 达成）；F3 从「无守卫静默耦合」变为「登记约束 + review 可见」；行为零变更（纯注释 + 登记）。

### 6.4 D4：preview 格式双维护（**已随 three-modes 附录 A 关闭**；contested 裁选型记录保留）

> **状态**：裁决「零改动接受现状」已随 rename-session-three-modes 附录 A 登记关闭，不再悬置。本节保留 v1 论证作审计记录。

- **采用**：不改代码。llm.ts `previewText`（:181-189，≤300 码点全文 / >300 head 200 + … + tail 100）与 e2e/harness.mjs `rebuildPreview`（:204-216）的同构实现保留，互指注释保留（llm.ts:179 已写「两处必须同步改」并点名 harness.mjs rebuildPreview），harness.test.mjs「rebuildPreview 三分支边界」单测（:23-73）继续锁定行为。
- **被否**：
  - **harness .ts 化**（改用 tsx/vitest 跑 run-a*.mjs）——e2e 是本地人工触发的验收资产（e2e/README，真实模型不进 CI），为消一处双维护改运行时形态，成本大于收益。
  - **抽共享 .mjs 供 llm.ts import**——src 混入 js 源文件，坏味道大于收益。
  - **接受现状的关键依据（审计未明说，本设计补全）**：双维护的漂移方向**两端都会被断言抓出**——run-a1 的内容匹配主判别器是「日志文本 == rebuildPreview(原始文本)」，任一侧单改阈值/格式，另一侧旧实现产生的重构文本必不匹配 → E2E 假红（可发现），不存在静默假绿。残留风险仅「e2e 不进 CI 故漂移在下次人工验收才暴露」，与 e2e 资产自身的定位一致。
- **效果**：~~目标 4 关闭~~（已随 three-modes 关闭）；零代码改动。

### 6.5 执行项总表（v2.2 终态：全部闭环）

| # | 包 | 位置（v1 为 2026-09-11 实读；★ 项行号为 2026-09-13 实施前快照，按符号名定位） | 改动内容 | 状态 |
|---|---|---|---|---|
| A1 | rename-session | src/pure.ts:53-57,74-114,243-251 | 删 env 覆盖层（常量 + getEnvOverrides + 合成段，flag 检查简化） | **已实施**（three-modes D6/u1） |
| A2 | rename-session | src/__tests__/pure.test.ts:261-404 | 删「环境变量覆盖」describe 整块 | **已实施**（现为 TC-D6-1..3 负面回归 :336-377） |
| A3 | rename-session | README.md:47-49、skills/.../SKILL.md:68-88,119-120 | 删 env 优先级行与示例，4 源改 3 源 | **已实施**（README:47-56 / SKILL.md:105 [HISTORICAL]） |
| ★A4 | extension-protocol | src/extensions/session-manager/types.ts:37,39,63-65,90-99(:96-97),124-131(:128-129),13-16；src/index.ts:57；README.md:33 | 删 4 死字段 + 对应守卫行 + SessionManagerRequest 及引用 | **已实施**（u1=6d73d3399） |
| ★A5 | runtime | src/transport/session-manager-handler.ts:205,:215-216,:337(连带 :346) | 删 handleCreate model/thinkingLevel 透传、handleList spawnSource 读取（固化 'agent'） | **已实施**（u1=6d73d3399，与 A4 同 commit） |
| ★A6 | extension-protocol | validation.test.ts、session-manager.test.ts | 删 SessionManagerRequest 导出断言与类型标注（:33-36/:60-70），create 用例删 `model:'m'`/`thinkingLevel:'high'`（:76-87），改用各 params 类型 | **已实施**（u1=6d73d3399，同 commit） |
| ★B1 | session-manager | src/index.ts:60-64,:112,:130,:135 + __tests__/tool-error-handling.test.ts:66,:79 details 断言 | 删 SessionManagerToolDetails 三态联合与三处构造（写后无人读：pi TUI renderResult 不消费自定义工具 details，renderer 无消费，isError+content 已满足判错）；测试删 details 断言。**实施注记（S1）**：pi `AgentToolResult.details` 为必填字段（pi-agent-core dist/types.d.ts:317-321），完全删键会 TS2739——实施形态为 `details: undefined`（或核对 registerTool 泛型 TDetails 推断允许省略），executeTool 返回类型（:106）同步收窄 | **已实施**（u2=56a8ea995） |
| ★B2 | session-manager | src/index.ts:53-58 | 删本地 SessionManagerRawError 声明，改 import 协议包 SessionManagerErrorResult（index.ts:5 已 import 该包，形状知识归单点） | **已实施**（u2=56a8ea995） |
| ★B3 | session-manager | src/index.ts:157-173（registerSessionTool），description 六处 :182/:191/:200/:209/:218/:227 | description 统一追加「Requires the xyz-agent desktop runtime; standalone pi CLI will time out」（发现 8 最小修复；分组迁移 out-of-scope，登记待办） | **已实施**（u2=56a8ea995） |
| C1 | 两包 + subagent-core | llm.ts:35-38 注释、path-encoding.ts:33-38 注释、docs/constraints.json + constraints.md | C-ext-21 登记 + 双端互指注释 | **已实施**（three-modes D7；authority 归属其文档） |
| C2 | rename-session | —（无代码） | D4 裁决记录 | **已关闭**（three-modes 附录 A） |
| C3 | rename-session | —（无代码） | llm.ts 管线函数/prompt 常量 export 仅测试消费（发现 4）：不执行——包入口只 re-export default，不构成公共 API 面；如需收紧由 code-simplify 批量加 `@internal`，不单包先行 | **已关闭**（three-modes 附录 A） |

## 6.6 探针清单

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P1 | ~~默认空 ref 与无效 ref 汇合同一 `!model` 守卫~~ **前提已被 three-modes D5 取代**（空 ref 现跟随会话主模型，不走静默跳过路径） | 等价性验证已改道为 three-modes V7（显式无效 ref），其探针 P1/P2 已实测闭环（见其 v3.4 变更历史：u1 实测通过零降级 dcc189dc4） | **已关闭（随 D1 吸收一并了结）** | 不适用 |
| P2 | M25 删除后 runtime 契约链不回归：marker 路由 → 查表守卫 → handler 编排 → select 回写 | `packages/runtime` 既有 session-manager-e2e-probe.test.ts 全绿 + GUI 实测（§7 V4） | **已通过**（runtime session-manager 测试族 64/64 + 阶段 5 GUI 实测 V4/V5 PASS；降级路径未触发——无隐性发送方） | 失败（历史口径）→ 核对被删行与剩余守卫差异；确认删除误伤则回滚该字段并在此登记「有隐性发送方」，D2 重审 |

## 7. 验收（真实场景，非单测非 mock）

**本章结论（v2.2 终态）：验收面 = D2 + B1-B3 的 V4/V5。rename-session 侧 V1/V2/V3 已被 rename-session-three-modes 取代（V1→其 V1、V2→其 V8、V3→改道其 V7）。**

> **验收结论（2026-09-14）：V4/V5 桌面真机全 PASS**——`XYZ_DEV_BACKGROUND=1` dev 实例 + CDP 自动化驱动，含对照 session 构造补强（list 过滤证伪力）与 abort 终态 sidecar 取证；记录见 impl-plan 阶段 5 条目（commit a8c04b28a）。

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| V4 | session-manager 真实调用链 | 目标 2 | `pnpm dev` 起应用：agent 经 subagent-workflow 或直接调 create_managed_session（带 label）→ list_my_sessions → abort_session | create 返回 sessionId 且侧栏出现子 session；list 只含本 agent 的子 session（过滤语义不变）；abort 后状态 stopped；全程无守卫/回写回归 |
| V5 | 6 工具协议面回归 + 守卫保留 | 目标 2 | runtime 包既有 session-manager-e2e-probe / send-queue 测试全绿；GUI 中 agent 调 get_session_status 指向不归属的 session | 测试全绿；返回 not_found/error（不可见=不存在语义不变）——删除未误伤剩余守卫 |

补充：unit/typecheck 层面 `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` + runtime 包 vitest 全绿是合入门禁但**不计入验收**；验收记录（日志摘录）贴实施 PR。

## 8. 实施与下一层拆分

### 8.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 | 验收挂点 |
|---|---|---|---|
| ~~M1 | D1 rename-session env 层删除（A1-A3）~~ | ~~配置 3 源终态~~ | **已由 three-modes 实施（其 u1/u2）** |
| M2（实施单元 impl-plan u1） | D2 双端死面删除（A4-A6，单 commit） | 协议死面清零 | **已实施 6d73d3399；V4/V5 PASS** |
| M3（实施单元 impl-plan u2） | session-manager low 批（B1-B3） | 包内死面清零 + 依赖声明 | **已实施 56a8ea995；extensions 三连绿** |

M2 首发（v1 的 M1/M2 并行关系随 M1 吸收而消解）；M3 随 M2 之后。包版本：rename-session 配置面变更的 minor bump **已随 three-modes 实际发布兑现（当前 0.9.0）**；session-manager 无 LLM 可见行为变化 patch bump（description 追加句为提示性文案，不构成行为变更），extension-protocol 随 M2 patch bump（最终按仓库版本策略由实施定）。

### 8.2 下一层拆分清单

| 单元 | 说明 | justification |
|---|---|---|
| ~~u1 = M1~~ | ~~rename-session 单包自包含~~ | **已由 three-modes 实施（其 u1/u2）** |
| u2 = M2 的 A4-A6（已实施 = impl-plan u1） | 双端契约删除 | 契约两端必须同 commit（编译闭包），跨包但单一主题 |
| u3 = M3（已实施 = impl-plan u2） | session-manager low 批（B1-B3） | 同包三个同性质 low 合一 commit，避免碎片提交；与 u2 的验收面（V4/V5）同构，可同窗口推进但独立 commit |

### 8.3 待验证检查点

- ~~探针 P1 实测结果（空 ref 等价性）~~ **已关闭**：前提被 three-modes D5 取代，等价性验证改道其 V7 且已实测闭环（见 §6.6）。
- ~~V4 在 dev 数据目录隔离（`~/.xyz-agent-dev`）下复跑一次~~ **已执行**（阶段 5：XYZ_DEV_BACKGROUND=1 dev 实例 + CDP 自动化 + 对照 session 构造，见 impl-plan 阶段 5 记录）。
- ~~usage-page-fixes.impl-plan.md:123 的 V8 程序描述在删除后失效~~ 该文件已整体删除（commit fadd8b8b4，retire 139 pipeline artifacts），历史版本可经 `git show fadd8b8b4^:docs/design/usage-page-fixes.impl-plan.md` 考查；若未来重跑同类验收，按 three-modes V7 程序（显式无效 ref）执行。
- B3 的 description 追加措辞会进 LLM prompt 面（6 工具各 +1 句）：**已核对**——每句 13 词固定文案，增量确定性极小（<100 token/会话），符合本条估计。

---

## 附录 A：审计修正记录（审计快照 20260911 vs 实读 20260911）

1. **行号漂移（发现本身全部成立）**：session-manager-handler.ts 消费点（四问记录 :255-262/:346-352 → 实读 handleCreate :205,:215-216 / handleList :336-337）；extension-protocol list 守卫（:148-156 → :124-131）；pure.ts（:54-107 → 常量 :53-57 + 函数 :74-114）；session-manager src 描述「7 文件 248 行」→ 实为 src/ 单源文件 index.ts 232 行（+4 测试文件）。本文一律用实读值。
2. **补充事实（审计未载，影响裁决）**：① subagent-core 已有 `PI_SUBAGENT_*` 四键 env 贯穿子进程，但语义是内部递归身份协议（subagent-service.ts:265-274 注释），不构成比路径嗅探更优的判定源（D3 被否证据）；② list.spawnSource 的「暴露」方向与 handleList 自身安全注释（:331-334「LLM 可控 params 不得放宽过滤」）冲突，为删除方向加安全票；③ preview 双维护的漂移两端都会被 E2E 内容匹配断言抓红，无静默假绿（D4 强化依据）。
3. **不可砍项确认**：`ModelSelector type:"ref"` 单变体判别联合保持不动（落盘 config 格式 + startupConfig 声明守卫 + 前向兼容测试，稳定性对冲投机性）；select+marker 握手、6-action 生命周期、SELECT_TIMEOUT_MS 分档、标题生成管线分解、fire-and-forget detached promise 均为四问记录「疑似本质复杂度」判定项，本设计不触碰。
4. **v2 漂移修正（2026-09-13 复核，HEAD 0e714d2a1）**：待执行项行号刷新——event-adapter.ts :615-633 → :644-663（translateSessionManagerSelect）、:749 → :778（marker 分发）；handler :336-337 → :337-338（wantSpawn/wantParent，连带过滤行 :346）；extension index.ts「:7 已 import 协议包」→ :5；types.ts SessionManagerRequest :12-16 → :13-16。协议 types.ts 的 4 死字段/守卫行号（:37,:39,:63,:65,:96-97,:128-129,:171-172）与 handler :204-205/:215-216、extension :15-19/:31/:78/:212、B1 :60-64/:112/:130/:135、B3 :157-173 及 description 六处（:182/:191/:200/:209/:218/:227）未漂移。rename-session 侧历史锚点（供已实施项核对）：llm.ts :36-38→:45-47（isSubagentSession）、:179→:199、:181-189→:202-209；path-encoding.ts :33-38→:39-46；subagent-service.ts :265-274→:147 附近（env 常量段）。实施时以符号名（非行号）定位。

## 附录 B：变更历史

- v1（2026-09-11）：初稿。覆盖审计 M20/M25 + 单元 low 发现 2/3/4/6/7/8；4 个决策（D1-D4）+ 执行项总表 + 探针 P1/P2 + 5 验收场景。
- v2（2026-09-13）：按 over-engineering-audit 审查报告（ext-simplify-15-rename-session-session-manager.review.md）修订——MF1 状态标注：rename-session 侧 D1/D3/D4/C3 已被 rename-session-three-modes 吸收实施/关闭（头部状态框 + §2 目标重排 + §6.5 执行项表状态列 + §7 删 V1-V3 + §8.1 删 M1 + §8.3 死链改 git 历史指针），待执行范围收敛为 D2（A4-A6）+ B1-B3；MF2 空 ref 等价性前提按 three-modes D5 终态改道登记（§4 数据流 + §6.1 + §6.6 P1 关闭）；S1 B1 补 pi AgentToolResult.details 必填实施注记（details: undefined 形态）；S2 版本基准更新（rename-session 0.9.0 / session-manager 0.1.7 / extension-protocol 0.9.0）；S3 待执行项行号刷新（附录 A 第 4 条）。D2 与 B1-B3 的方案本体无变化。
- v2.2（2026-09-14）：dev-flow 阶段 6 终态回写（design-code-sync 审查 9 must-fix doc_errors + 2 suggestion 全修）——头部结论/状态框/§1/§2/§3.2/§3.3/§4/§5/§6/§6.5/§6.6/§7/§8 全部由「待执行」改「已实施」终态口径（u1=6d73d3399 / u2=56a8ea995）；P2 探针关闭（runtime 64/64 + GUI 实测 PASS）；§7 补验收结论；§8.3 补 token 核对结论。代码侧孤儿 JSDoc（index.ts:57）由 u2 dev 同批删除。设计交付完成。
