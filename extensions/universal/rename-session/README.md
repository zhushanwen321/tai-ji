# @zhushanwen/pi-rename-session

Pi rename-session 扩展 — 三种触发模式下自动/自主为会话生成 slug 式标题并落库（`setSessionName`），让 session 列表摆脱默认的日期/序号占位，一眼可辨。

## 功能

- **三种触发模式**（`mode` 配置，默认 `first-stop` 零行为迁移）：
  - `first-stop`（默认）：新 session 的**首个成功 round 末**自动生成 slug 式标题
  - `first-prompt`：**首条 user 消息发出即命名**（不等回复）——标题只基于 prompt 本身；pi 事件链 await handler，rename LLM 请求构造性早于首条 assistant 回复开始
  - `agent-tool`：**不自动生成**——注册 `rename_session` 工具，由 agent 在对话中自主改名（零额外 rename LLM 调用）；工具改名允许覆盖任何既有名（agent 显式调用语义等同手动 rename）
- **触发时机（first-stop 路径）**：只在 round 的最终 turn（`stopReason === "stop"`）评估——工具中间轮 / error / aborted / length 轮不评估，error 轮延迟到下一个成功轮命名
- **两段输入（自动路径）**：`[user(首条 prompt), assistant(最终回复)]` 两段信号（各截断 4000 码点），不含 toolCall/toolResult 过程数据，token 成本不随工具数增长；first-prompt 模式无 assistant 段（降级两条）
- **独立选模**：标题生成用独立的 `ModelSelector` 配置（仅支持 `ref` 精确指定 provider/model）；**未配置（空 ref）时跟随会话主模型**（`ctx.model`），开箱即用
- **可靠性行为**：固定 30s 超时；落库前重查手动名（防覆盖 LLM 调用窗口内的竞态，agent-tool 工具路径除外——显式改名允许覆盖）；任何失败静默跳过保留原 label，绝不阻断 agent 循环
- 标题直接 `setSessionName` 落库，不进 session history（不污染对话记录）
- **子 session 自动排除**：subagent 子进程 session 不触发 rename（避免给临时产物起名）

## 安装

```bash
pi install npm:@zhushanwen/pi-rename-session
```

## 配置

配置文件：`<agentDir>/config/rename-session-ext-config.json`（`<agentDir>` 默认 `~/.pi/agent`，`PI_CODING_AGENT_DIR` 可覆盖；xyz-agent 隔离环境为 `~/.xyz-agent/pi/agent`）。

```json
{
  "enabled": true,
  "model": { "type": "ref", "ref": "deepseek/deepseek-chat" },
  "mode": "first-stop",
  "maxTitleLength": 50,
  "thinkingLevel": "off"
}
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `false` | 自动重命名开关（受 flag 文件覆盖，见下） |
| `model` | `ModelSelector` | `{ "type": "ref", "ref": "" }` | 标题生成模型，仅支持精确指定 `{type:"ref", ref:"provider/modelId"}`；**空 ref 跟随会话主模型**（开箱即用），非空但解析失败（配错）才静默跳过 |
| `mode` | `"first-prompt" \| "first-stop" \| "agent-tool"` | `"first-stop"` | 触发模式（三值互斥）：首条请求即命名 / 首个成功 round 末命名（现状）/ agent 自主经 `rename_session` 工具命名。事件面每次事件 live 读（GUI 切换对活跃 session 的自动命名即时生效）；工具注册面只在 pi 进程启动加载 extension 时求值一次（切换后已存活 session 的工具清单不回溯，残留工具由 execute 内 live mode 守卫拒绝并给恢复指引） |
| `maxTitleLength` | `number` | `50` | 标题最大长度（Unicode 码点数，须正整数） |
| `thinkingLevel` | `ModelThinkingLevel` | `"off"` | 标题 LLM 的 thinking 级别（`off` = 不传 reasoning，provider 默认） |

文件缺失/坏 JSON 返回默认值，不抛错。改完保存即生效（mtime 读时刷新，每个 `turn_end` / `message_end` 重新 load）。

## 开关优先级（重要）

`enabled` 有三层来源，优先级从高到低（`src/pure.ts` `loadRenameConfig`）：

1. **`<agentDir>/auto-rename-enabled` flag 文件**（存在 = 开）：xyz-agent runtime 的开关契约——桌面端 SystemPage 开关、首启默认开启都写这个文件。**xyz-agent 用户请通过桌面端开关或 `/auto-rename` 命令管理，不要手改 JSON 的 `enabled`**（flag 存在时视为开，手改会被覆盖）。
2. **config 的 `enabled` 字段**（默认 false）：flag 不存在时生效，是原生 pi CLI 用户的开关。
3. **默认值**（false）：以上两层均未设置时。

> [HISTORICAL] 原最高优先级的 `PI_RENAME_*` 环境变量覆盖层已删（全仓 0 生产 setter，4 键中 3 键从未被用过）——预置该前缀的环境变量不再有任何效果。rename-session 相关精简项裁决见原设计文档 rename-session-three-modes.md 附录 A（已删除，git 可追溯）。

## 命令

```
/auto-rename          # 查看当前状态
/auto-rename on       # 开启（创建 flag 文件）
/auto-rename off      # 关闭（写 config.enabled=false + 删 flag，双写同步）
```

## 工作原理

三个入口共用同一条落库管道（`callRenameLLM` → 防覆盖重查 → `setSessionName`），按 `mode` 分派：

1. **入口分派（事件面 live 读 mode）**：`message_end` 入口（first-prompt）过滤 `role === "user"`；`turn_end` 入口（first-stop）按下方流程；`agent-tool` 模式不激活自动命名逻辑（两 handler 常驻注册、命中即静默返回），改为 extension load 时注册 `rename_session` 工具。
2. **开关 + subagent 过滤**（自动路径共用）：开关关闭（flag 不存在且 `enabled=false`）直接返回；session 路径含 `subagents` 段视为子进程 session，跳过。
3. **O(1) 快速路径（first-stop）**：只有 `stopReason === "stop"` 的 turn 才继续——**rename 一定在 round 末触发**（最终 turn 的 message 即最终 assistant 回复，final text 零遍历可得），不会在首个 iteration 中途命名。first-prompt 入口的对应守卫：首条 user 判定 = handler 执行时 `getEntries()` 中 user message 计数 === 0（pi 的 extension handler 先于该条 message 的 entries append 执行，本条即 session 首条 user；steering/follow-up 消息到达时首条已入 entries，天然不重复触发）。
4. **首 round 判定（first-stop）**：session entries 中成功（stop）assistant 回复数 === 1 才触发（后续 round 不重复 rename；error 轮的 assistant 回复不计数，延迟到下一个成功轮）。
5. **两段输入构造**：`[user(首条 prompt), assistant(最终回复文本), user(instruction)]`——任务意图 + 轮次结论恰好与标题语义对齐，不含 toolCall/toolResult 过程数据；两段文本各截断 4000 Unicode 码点（中文场景约 4k token/段，成本可控且不随工具数增长）。assistant 段为空（first-prompt 模式 / 纯工具结束的 round）时降级为两条——标题主信号本就是 prompt。
6. **LLM 生成 slug 标题**：独立精简 system prompt（<200 字符的 slug 词组约束，非整个 agent prompt）+ instruction（正反例 few-shot，作为追加 user message 发送）+ `tools: []` + `maxTokens: 64`，按 `config.model` 独立选模（空 ref 跟随会话主模型）发起一次 LLM 调用；固定 30s 超时（超时归一为失败，走静默跳过）。
7. **落库**：cleanTitle 清洗（去首尾引号 / markdown 强调标记 / 句尾标点、空白归一、按码点截断）后 `setSessionName` 写入。**落库前重查** `pi.getSessionName()`——LLM 调用窗口（2-30s）内用户手动命名的竞态由此兜住，已有名则 skip 不覆盖。**不**写入 session history，对话记录不受影响。
8. **`rename_session` 工具（agent-tool）**：execute 内守卫链依次为——先拒绝 subagent session（子会话是临时产物，subagent 排除守卫覆盖 message_end / turn_end / 工具三入口，C-ext-21）；再 live 读 config 守卫——mode 已切走时拒绝（错误文案含恢复指引：切回 agent-tool / 手动改名）；title 经 cleanTitle 清洗，空值拒绝；非空直接 `setSessionName` **不走防覆盖守卫**（agent 显式调用 = 代表用户的意图，允许覆盖任何既有名，含自动名/语义名）。

### 可靠性行为

rename 是 best-effort 副作用，任何失败静默跳过、绝不阻断 agent 循环：

| 情形 | 行为 |
|---|---|
| 中间 iteration（工具轮）的 turn_end | skip（stopReason=toolUse），round 末才评估 |
| error / aborted / length 轮 | skip（stopReason=<X>），error 上下文不用于命名，延迟到下一个成功轮 |
| 非 round-1（成功回复数 ≠ 1） | skip（count=N），一次性语义 |
| 非 first-prompt 模式收到 user message_end | skip（mode=<mode>），事件面 live 分派 |
| 非 session 首条 user message（first-prompt） | skip（userCount=N），一次性语义 |
| LLM 调用失败 / 超过 30s | 记录失败日志，保留原 label（不做重试；用户可手动命名） |
| 标题清洗后为空 | skip（title empty） |
| 落库前发现已有手动名（自动路径） | skip（name exists），不覆盖 |
| `rename_session` 工具被调用但 mode 已切走 | execute 守卫拒绝（isError 文案含恢复指引） |
| 标题模型不可用 | 记日志静默跳过 |

### 日志通道（appendEntry 常开 + debug 文件日志）

所有日志经 `@zhushanwen/pi-extension-logger` 输出，两个通道：

- **appendEntry（session entry，常开）**：`logger.warn` / `logger.error` 写入 session JSONL 的 custom entry（`type: "custom"`、`customType: "rename-session:log"`），不进 LLM 上下文、不显 TUI。`data.message` 由 logger 自动补 `[rename-session]` 前缀，格式为 `msg + 结构化 data`（error 等详情在 entry `data.data` 字段，不冒号拼接进 message）。
- **文件日志（`XYZ_AGENT_DEBUG=1` 时）**：`<agentDir>/logs/rename-session-<date>.log`。

下列 debug 日志（仅 `XYZ_AGENT_DEBUG=1` 时经 `logger.warn` 发出）的**文案字面值是 E2E 断言硬契约**（断言对象 = appendEntry entry 的 message 内容；变更须同步 `e2e/` 场景脚本与单测）：

| # | 日志 | 发出侧 | 含义 |
|---|---|---|---|
| 1 | `skip: stopReason=<r>` | turn_end handler（带 `turnIndex=<n>`） | 快速路径拦截（toolUse/error/aborted/length） |
| 2 | `skip: count=<n>` | turn_end handler（带 turnIndex） | 非首成功 round |
| 3 | `skip: name exists` | handler `.then()`（turn_end 原样 / message_end 带 `firstPrompt` 前缀） | 落库前防覆盖命中 |
| 4 | `renamed to "<title>"` | turn_end handler（带 turnIndex）/ message_end handler（`firstPrompt renamed to "..."`） | 标题生成并落库成功（`setSessionName` 之后打出；竞态命中时只打 #3，无此条） |
| 5 | `skip: no user prompt` | llm | session 无 user message（理论不发生） |
| 6 | `skip: title empty` | llm | cleanTitle 清洗后为空 |
| 7 | `LLM request messages: <JSON>` | llm | 传给 callLLM 的 messages 内省（role + text 的 head 200 码点 + … + tail 100 码点预览，截断单位与 truncateForTitle 统一为 Unicode 码点），在请求发起前打出 |
| 8 | `rename with model <provider>/<id>` | llm | 成功路径模型记录（原常开日志；为避免污染 Pi 输入框改为 debug 输出，带 t=ISO 时间戳） |
| 9 | `skip: mode=<mode>` | turn_end handler（`turnIndex=<n>`）/ message_end handler（`firstPrompt skip: mode=...`） | mode 分派拦截：本入口对当前 mode 不负责（事件面 live 读，切走即停） |
| 10 | `skip: userCount=<n>` | message_end handler（`firstPrompt skip: userCount=...`） | 非 session 首条 user message（first-prompt 一次性语义） |
| 11 | `skip: empty prompt` | message_end handler（`firstPrompt skip: empty prompt`） | user message 载荷无文本（理论不发生） |
| 12 | `tool renamed to "<title>"` | rename_session 工具 execute | agent-tool 路径落库成功（`setSessionName` 之后打出，无防覆盖前缀） |

另有两条**非 debug 常开**日志（无条件经 `logger.warn` 落 appendEntry entry）：`rename LLM call failed`（`logger.warn(msg, { error })` 形态，error 详情在结构化 data 字段；超时时 llm-shared callLLM 内部的 extractText 将空错误文本归一为 `unknown error`——extension 侧 `result.error ?? "unknown error"` 只兜 null/undefined，空串兜底发生在 llm-shared 层）、`model not available, skipping`（选模失败）。handler 侧日志 message 带 `t=<ISO时间>` 与 `turnIndex`；llm 侧带 `t=<ISO时间>`、无 turnIndex。

## E2E 验收

E2E 是本地人工触发的验收资产（真实 pi 进程 + 真实模型，不进常规 CI），覆盖七个场景：A1 触发时机证据链（流序/内容匹配/负向/行序/结构五重——结构断言 = 仅一条 LLM request + [user,assistant,user] 三元组）、A2 slug 风格 ×3、A3 防覆盖（静态/竞态/一次性）、A4 error 轮两阶段（`--session` 续跑）、A5 超时兜底（hang provider）、A6 first-prompt 模式（触发时点 = 首条 assistant `message_start` 前 rename LLM 请求已发出 + 标题仅基于 prompt + 后续 round 不再改名；完成序不做 gate）、A7 agent-tool 模式（工具改名即时落库覆盖既有名 + first-stop 对照进程零 `rename_session` toolCall entry）。

```bash
cd extensions/universal/rename-session
node e2e/run-a1.mjs    # 单场景独立可跑（run-a1 ~ run-a7）
node e2e/run-all.mjs   # 顺序全跑：单场景失败不阻断后续，汇总表 + exit code（任一失败（含 KEBAB_NON_COMPLIANT）→ 1）
```

- 环境要求与探针结论（auth 迁移 / RPC 协议格式 / `--session` 续跑 / 坏 provider 与 stub socket 配置写法）：`e2e/README.md`
- harness API 与断言纯函数（单测 `e2e/harness.test.mjs` 随 vitest 跑）：`e2e/harness.mjs`
- A2 的标题记录与人工抽查表（词组形态/语义相关/语言跟随三列）：`e2e/RESULTS.md`（run-a2 自动追加，人工填写）
- 保留现场调试：`E2E_KEEP_TMP=1 node e2e/run-all.mjs`
- 测试模型固定 `xiaomi-token-plan-cn/mimo-v2.5-pro`（项目规范，禁 kimi）

## 子 session 自动排除

subagent 子进程的 session 目录形如 `.../subagents/...`，是临时产物。本扩展通过检测路径中的 `subagents` 段判定子 session，自动跳过 rename，避免给这些临时 session 生成噪音标题。

## 文件结构

```
rename-session/
├── index.ts              # 工厂入口（re-export src/index.ts）
├── package.json
├── vitest.config.ts
├── README.md
├── e2e/                  # E2E 验收资产（本地人工触发，不进常规 CI）
│   ├── README.md         # 探针结论 + 运行指南
│   ├── harness.mjs       # pi 进程/RPC/交错时间轴/断言纯函数
│   ├── harness.test.mjs  # 断言纯函数单测（随 vitest 跑）
│   ├── run-a1.mjs ~ run-a7.mjs   # A1-A7 场景脚本
│   ├── run-all.mjs       # 总结 runner（汇总 + exit code）
│   ├── scenarios.test.mjs        # A1-A7 的 vitest 包装（仅 e2e config 收录，不进常规 CI）
│   ├── vitest.e2e.config.ts  # E2E 专用 vitest 入口（--config 显式指定，include 含 scenarios.test.mjs）
│   └── RESULTS.md        # A2 标题记录 + 人工抽查表
├── skills/rename-session-ext-config/SKILL.md   # 配置指南（pi 内 agent 可发现）
└── src/
    ├── index.ts          # 工厂入口（message_end/turn_end handler 按模式分派 + rename_session 工具注册 + /auto-rename 命令）
    ├── commands.ts       # /auto-rename on|off|status 命令（enable/disable 别名）
    ├── llm.ts            # callRenameLLM / 两段输入构造 / debug 内省 / 超时
    ├── pure.ts           # 纯函数（配置 / 首轮计数 / cleanTitle）
    └── __tests__/        # 单测（pure / commands / llm mock / index 集成）
```
