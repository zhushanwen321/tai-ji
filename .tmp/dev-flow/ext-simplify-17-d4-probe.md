# ext-simplify-17 D4 探针报告：bte subagent 进程判据重锚定（实施前置）

- 日期：2026-09-14
- 仓库：dev-0.9.21 worktree（分支 dev-0.9.21，HEAD 含 ext-simplify-17 开发中状态）
- 设计依据：`docs/architecture/ext-simplify-17-shared-extraction.md` §3.1 D4（探针实施前置 + V6 回归）、§5 验收「V6 D4 探针」条目
- 结论先行：**正向断言证实、反向断言证实**——重锚定门禁通过，D4 修复可执行。③④ 两既有失效读者按设计要求登记不修。

## 1. 断言结果

### 1.1 正向断言（subagent 进程 env）：证实

| 断言项 | 结果 | 证据 |
|--------|------|------|
| `XYZ_AGENT_SUBAGENT=1` 存在 | 证实 | bash 输出 + 引擎进程 env（双证据） |
| `PI_SUBAGENT_ROOT_SESSION_ID` 不存在 | 证实 | 同上（grep 单行返回，无 PI_SUBAGENT 匹配） |
| `PI_SUBAGENT_SELF_RECORD_ID` 不存在 | 证实 | 同上 |

真机链路：xyz-agent dev 实例（dev-0.9.21 分支代码）→ GUI 会话发「派 subagent 跑 env 命令」→ 主 agent（mimo-v2.5-pro）经 subagent 工具派发 pi 引擎任务（record sa-d549c0fa）→ runtime spawn 引擎进程 `node .../apps/electron/resources/engines/pi/index.js`（PID 22351，staged 引擎副本）→ 引擎内 spawn 真 pi binary → subagent 内 bash 执行探针命令。

输出级证据（subagent session 文件原文摘录，`~/.xyz-agent-dev/agent/subagents/--private-tmp-ext-simplify-gui-accept-cwd--/sessions/2026-09-14T10-52-25-603Z_01a09f8b-f883-719a-9002-4c24784966b1.jsonl`）：

```
toolCall bash: env | grep -E 'XYZ_AGENT_SUBAGENT|PI_SUBAGENT' || echo NO_MATCH
assistant final text: "Here is the complete raw output:\n\n```\nXYZ_AGENT_SUBAGENT=1\n```"
```

bash 输出为单行 `XYZ_AGENT_SUBAGENT=1`：新标记存在，`PI_SUBAGENT_*` 全族零匹配（`|| echo NO_MATCH` 未触发说明 grep 有命中行，且命中行不含任何 PI_SUBAGENT 键）。

进程级证据（`ps eww -p 22351`，pi 引擎进程，相关键摘录）：

```
XYZ_AGENT_SUBAGENT=1
XYZ_SUBAGENT_RELAY_SOCKET=/Users/zhushanwen/.xyz-agent-dev/run/relay-20708.sock
XYZ_SUBAGENT_RELAY_NODE=/Users/zhushanwen/.nvm/versions/node/v24.11.1/bin/node
XYZ_SUBAGENT_RELAY_SCRIPT=.../resources/extensions/@zhushanwen/pi-subagent-workflow/relay/relay.mjs
（无任何 PI_SUBAGENT_* 键；PI_ 前缀仅 PI_CODING_AGENT=true / PI_CODING_AGENT_DIR）
```

补充第二引擎证据：主 agent 首次误派 zcode 引擎（record sa-cb043ec0，后自动终止），其引擎进程（PID 22220，`node .../engines/zcode/index.js`）env 同构——`XYZ_AGENT_SUBAGENT=1` 在、无 `PI_SUBAGENT_*`。两引擎（pi/zcode）均走 `buildEngineChildEnv`，结论一致。

### 1.2 反向断言（顶层主进程 env）：证实

| 断言项 | 结果 | 证据 |
|--------|------|------|
| 顶层会话内 `XYZ_AGENT_SUBAGENT` 不存在 | 证实 | bash 输出 NO_MATCH + 顶层 pi 进程 env（双证据） |

同一 dev 实例、同一会话（顶层 pi 进程 PID 22052，`--mode rpc --model xiaomi-token-plan-cn/mimo-v2.5-pro`）直接执行同款探针命令。

输出级证据（主会话 session 文件原文摘录，`~/.xyz-agent-dev/agent/sessions/--private-tmp-ext-simplify-gui-accept-cwd--/2026-09-14T10-52-10-230Z_01a09f8b-bc76-7f20-a454-c580b01ad296.jsonl`）：

```
toolCall bash: env | grep -E 'XYZ_AGENT_SUBAGENT|PI_SUBAGENT' || echo NO_MATCH
toolResult text: "NO_MATCH\n"
```

进程级证据（`ps eww -p 22052`）：`XYZ_AGENT_SUBAGENT` 与 `PI_SUBAGENT_*` 均无匹配。

含义：重锚定后 `isSubagentProcess()`（锚 `XYZ_AGENT_SUBAGENT === "1"`）不会在顶层普通会话误命中——重锚定的 guard / D14 background 降级只在引擎链 subagent 内触发。

### 1.3 门禁裁决

两项断言均证实 → **D4 修复（bte `subagent-guard.ts` 判据重锚定 + ext-guards 收敛 + smart-context 单键版顺带收敛 + SDK `env.ts:70` 注释清扫）按设计预授权执行**。

## 2. ③④ 既有失效读者登记（只登记不修）

### ③ subagent-core 孤儿恢复「单扫描者」防线失效

- 锚点：`packages/subagent-core/src/execution/service/record-access.ts:133-134`（任务简报写的 `packages/subagent-core/src/record-access.ts` 为简写，实际路径如左）
- 现状：`recoverOrphansIfRootProcess()` 以 `ENV_SELF_RECORD_ID`（= `"PI_SUBAGENT_SELF_RECORD_ID"`，定义于 `packages/subagent-core/src/execution/service/service-constants.ts:27`）判子进程身份。本探针证实引擎链子进程 env 恒无该键 → `isChildProcess` 恒 false → **所有进程（含引擎链子进程）都被当根进程执行孤儿恢复扫描**。
- 失效后果（函数头注释 :125-131 自述）：递归编排中任一子进程启动时恰有兄弟记录 marker 缺失或超软超时 → 活记录被无关进程盖 `.finalized` sidecar，closed entry 写进别的进程的 session 文件（跨进程互写，无锁）。
- 定性（按设计 D4 ③）：既有缺陷，非本设计引入，属 subagent-core 债务且超出 extensions 域，修复另行裁决，本设计不扩范围。

### ④ subagent-workflow identity entry 恒不写

- 锚点：`extensions/universal/subagent-workflow/src/session-lifecycle.ts:278-314`（活函数；活调用 :552）
- 现状：`appendSubagentIdentityEntry()` 读 12 个 `PI_SUBAGENT_*` 键（:279 SELF_RECORD_ID / :282 MODE / :288 AGENT / :290 TASK / :291 SLUG / :292 STARTED_AT / :293 ROOT_SESSION_ID / :294 PARENT_RECORD_ID / :296 DEPTH / :300 FORK_DEPTH / :303 CHAT_MODE / :306 WORKTREE）。`:279-280 if (!selfRecordId) return`——引擎链子进程该键恒空 → 恒提前返回 → **subagent-identity custom entry 恒不写**。
- 真机佐证：本探针 subagent session 文件 entry 类型统计 = `{session:1, model_change:1, thinking_level_change:1, message:4}`，无任何 custom/identity entry——与「恒不写」推演一致。
- 处置（按设计 D4 ④）：登记恒不写事实另行裁决，**禁止实施时误删该活函数**。

## 3. 探针方法记录

链路选择：GUI 全链路真机（任务指引首选），未动用引擎直调脚本退路。

命令序列（时序）：

1. `cd /Users/zhushanwen/Code/xyz-agent-workspace/dev-0.9.21 && XYZ_DEV_BACKGROUND=1 pnpm dev`（后台启动，输出 /tmp/d4-probe-dev.log）
2. `node apps/electron/scripts/dev-instance.mjs --print` → Vite 1499 / CDP 9255 / runtime 3540；数据目录 `~/.xyz-agent-dev/instances/dev-0.9.21`
3. browser-automation（pw.js 连 `http://localhost:9255`）：确认 list-pages URL 为本实例 `localhost:1499/?windowId=win-1` → click「新建任务」→ fill contenteditable 输入框（role=textbox）→ Enter 发正向任务 prompt（明确指示「必须派发 subagent，不要主会话直接跑」）
4. `ps aux | grep dev-0.9.21` 定位引擎进程 → `ps eww -p 22351`（pi 引擎）/ `ps eww -p 22220`（zcode 引擎）/ `ps eww -p 22052`（顶层 pi）dump env（只摘 XYZ_/PI_/ELECTRON_ 前缀，未全量贴防 token 泄漏）
5. 同会话再发反向任务 prompt（明确指示「不要派 subagent，主会话直接跑」）
6. 读 session JSONL 提取 bash toolCall 与原始输出（绕开主 agent 转述层，取证到 bash 输出原文）

代码链核实（探针前完成，与真机结果互证）：

- 注入点：`packages/subagent-core/src/execution/engine/client/engine-client.ts:343` `buildEngineChildEnv(baseEnv, {...})` → `packages/subagent-engine-sdk/src/env.ts:157` `env.XYZ_AGENT_SUBAGENT = "1"` 恒注入（L0 层最后写入）
- 旧键写入面：全仓 grep `PI_SUBAGENT_*` env 赋值零命中（仅常量定义 `service-constants.ts:27` / `session-baselines.ts:53-55` 与只读消费；`pi-subagent-cli/src/spawn-runner.ts:196` 仅作 standalone/裸 CLI fallback 读）——设计「全仓无写入」预设核实成立
- 引擎内二次 spawn：`packages/pi-subagent-cli/src/spawn-runner.ts:184-201` `buildOutboundChildEnv({parentEnv: process.env, ...})` 全量继承引擎进程 env（SDK 版缺省无白名单过滤，仅 deny 剥除）→ 真 pi bash 可见 `XYZ_AGENT_SUBAGENT=1`（真机已证）

## 4. 环境噪音观察（登记备查，非断言对象）

探针期间用户生产版 TaiJi.app **v0.9.20** 正在跑 subagent 任务（另一 worktree，认知外进程，仅只读观察未干预）。`ps eww` 其 subagent 进程（PID 17436）env **同时含** `XYZ_AGENT_SUBAGENT=1` 与全套旧键族（`PI_SUBAGENT_ROOT_SESSION_ID` / `PI_SUBAGENT_SELF_RECORD_ID` / `PI_SUBAGENT_AGENT` / `PI_SUBAGENT_SLUG` / `PI_SUBAGENT_TASK` / `PI_SUBAGENT_MODE=background` / `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_STARTED_AT` / `PI_SUBAGENT_ROOT_CWD` / `PI_SUBAGENT_CHAT_MODE`）。

解释：v0.9.20 打包版走 subagent-workflow session-runner 旧直 spawn 链（仍注入 PI_SUBAGENT_* 全键族）；dev-0.9.21 引擎协议化后该注入链已删（见 §3 写入面核实）。二者不矛盾——本探针对象是 dev-0.9.21 代码，断言结论不受生产版影响。含义：生产 v0.9.20 上 bte 旧判据（PI_SUBAGENT_*）仍可命中（D14 降级仍生效），重锚定随版本升级后切换到 `XYZ_AGENT_SUBAGENT` 单键——两代行为按版本演进衔接，无空窗。

dev 装配器噪音键（`XYZ_DEV_BACKGROUND=1` / `XYZ_CDP_PORT` / `XYZ_VITE_PORT` 等随 shell 继承进顶层 pi 与引擎进程）：与本探针断言键无交集，不影响结论。

## 5. 决策清单（全托管模式）

1. SDK 实际路径为 `packages/subagent-engine-sdk`（任务简报写的 `extensions/shared/subagent-engine-sdk` 不存在），按实际路径报告；`env.ts:157` 恒注入事实与简报一致。
2. 探针链路选 GUI 全链路（任务首选项），引擎直调脚本退路未启用。
3. 主 agent 先误派 zcode 引擎 subagent 后换 pi 引擎：两引擎 env 均取证，zcode 作第二引擎补充证据纳入报告，不视为失败重试。
4. ③ 的 file:line 按实际路径 `packages/subagent-core/src/execution/service/record-access.ts:133-134` 登记。
5. 生产 v0.9.20 进程的旧键观察作为「环境噪音」段登记（§4），只读不干预，避免后续读者混淆「为何生产版有旧键而探针说没有」。
6. subagent session 文件无 identity entry 的真机佐证补入 ④（设计未要求，属顺手取证的增量证据）。

## 6. 清理证据

- 探针 dev 进程树（全部为本探针启动）：TaskStop 后台任务 exec_f6aa4c46 + 逐 PID `kill`（20167 Electron 主进程 / 20127 vite / 20707+20708 runtime tsx / 22052 顶层 pi / 22351 pi 引擎 / 22220 zcode 引擎 / 20690+20691+20693 Electron helpers / 20725 esbuild）
- 残留检查：`ps aux | grep dev-0.9.21`（排除 grep 自身）= 空，零残留
- 认知外生产进程（TaiJi.app v0.9.20）未受影响，仍在运行
- 临时产物：截图 /tmp/d4-probe-shot1.png、/tmp/d4-probe-final.png、启动日志 /tmp/d4-probe-dev.log（/tmp 系统自清理）；探针产生的 dev 会话数据落在 `~/.xyz-agent-dev/instances/dev-0.9.21` 与 `~/.xyz-agent-dev/agent/`（dev 数据目录，非真实数据目录，保留作证据可复查）
- 零代码改动：本探针只读 + 本报告落盘，未修改任何仓库文件（git status 与探针前一致，仅 `.tmp/dev-flow/ext-simplify-17-shared-extraction.impl-plan.md` 既有认知外改动未触碰，本报告为 .tmp 新增文件不入库）
