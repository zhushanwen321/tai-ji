# base-tool-enhance extension 技术设计

> 一句话结论：新增 `@zhushanwen/pi-base-tool-enhance` extension，同名 override pi 内置 bash 工具（前台行为委托 pi 官方工厂保持 100% 等价），增量实现 background 模式（强制白名单 + pending-notifications 完成通知（lifecycle 分档接入）+ 轮询接管与孤儿收殓兜底）与双模式可配置超时，随后整包废弃 unified-hooks。

- 层级声明：当前层 = extension 能力设计 → 下一层 = 可实现的接口 / 数据模型 / 技术方案（层敏感准则全适用）
- 状态：已评审通过（7 轮对抗式审查收敛，must-fix 归零；审查报告见 `.review/design-review-base-tool-enhance-20260825*.md`）；**已实施**——M1-M6 全部落地（feat-background-bash 分支），探针 P1-P6 全部实测关闭（无一回退路径触发），unified-hooks 已标记废弃；实施后经三路设计-代码一致性对抗审查（42 核对点），全部发现已修复闭环（registry 回落限定终态 + 跨进程 kill 拒绝 + pid 复用防御 + 文档 4 处补登记 + D18 落地 README），验收 S1-S10 场景实测记录齐全（S2/S9 为审查后补录）
- 机制演变（2026-09-01 事故后）：孤儿收殓 reaper 已下沉 runtime——extension 侧全局扫描实现（`src/reaper.ts`）删除，现行链路见 [file-lock-unification-and-reaper-sink](file-lock-unification-and-reaper-sink.md) 与 §3.5 末「设计演变记录」；registry 契约 SSOT 迁至 `@xyz-agent/extension-protocol`
- 关联：废弃 unified-hooks（已删除，git 历史即归档）；接入 [pending-notifications](../../../extensions/universal/pending-notifications/)

## 1. 背景目标

**S（情境）**：xyz-agent 的 AI agent 通过 pi 内置 bash 工具执行命令。该工具是同步语义：spawn 子进程，等命令退出才把输出返回给模型。

**C（冲突）**：vitest watch、dev server、全量测试这类长时命令会把整个 turn 卡死——模型在命令结束前什么都不能做；用户中断后工作全部作废。现有的 unified-hooks 扩展试图治理这个问题，但方式是「检测到网络/测试类命令且未设 timeout 时直接拒绝执行」，模型必须再花一轮往返补参数，而且两套正则和建议秒数全部硬编码，用户无法调整。

**Q（问题）**：长时命令为什么不能放到后台跑，让 agent 立即返回去干别的、完成后再收到通知？

**A（答案）**：新增 base-tool-enhance extension：bash 支持 background 模式、长时类命令走配置化白名单自动强制后台、前台/后台均可配置默认超时；unified-hooks 整包废弃，其拦截行为由新包以更优方式承接。

### 设计目标（从使用者体验倒推）

| # | 目标 | 使用者可见标准 |
|---|------|--------------|
| G1 | 长时命令可后台化 | 模型发出长命令后**立即**收到 task_id 并能继续其他工作；任务完成后收到结果通知 |
| G2 | 长时命令无需模型自觉 | vitest 等白名单命令即使模型没主动要求后台，也自动进后台 |
| G3 | 超时可配置 | 前台/后台默认超时可通过配置文件调整；不填维持 pi 内置语义（不限时） |
| G4 | unified-hooks 退役 | 测试类拦截行为由新包承接且可配置；网络类挂死保护由可配置前台默认超时弱承接（默认关闭，维持 pi 语义）；无双重拦截 |
| G5 | 异常不泄漏进程 | pi 被强杀或崩溃后遗留的后台任务，在下次 session 启动时被自动收殓 |

### Scope

- **In**：bash 工具同名 override；background 生命周期（启动/查询/kill）；pending-notifications 接入；超时与白名单配置；孤儿 reap；unified-hooks 废弃迁移。
- **Out of scope**：read/write/edit/grep 等 override（包内留 per-tool 扩展位，本期不实现）；桌面端后台任务管理 UI；composer `!` 直执行 bash 管线改动（那是 runtime 侧另一条管线，与工具调用无关）；后台输出的实时流式 UI。

## 2. 现状与问题分析

### 2.1 pi 内置 bash 的真实行为（0.84.1 实装版核实）

内置 bash 工具入参 schema 只有两个字段：

```ts
{ command: string; timeout?: number }   // timeout 单位秒,可选,默认不限时,上限 int32 ms
```

执行链路（物理数据流，现状）：

```
LLM tool_call {command}
  │
  ├─ tool_call hooks（permission 审批、unified-hooks 拦截）──block 则终止,错误回灌 LLM
  ▼
bash.execute: spawn(sh -c "<command>", detached:true)   ← 子进程脱离父进程组
  │ stdout/stderr 经 pipe 回流 pi 进程内存累积
  ├─ LLM 未填 timeout → 无定时器,永远等
  ├─ LLM 填了 timeout → 到点 killProcessTree(pid) + 抛 "timeout:<n>"
  ├─ abort signal     → killProcessTree(pid)
  ▼
输出截断(末尾 2000 行 / 50KB),全量落 temp file,tool result 返回 LLM ← 同步阻塞到此结束
```

与进程收殓相关的既有机制（本设计的地基）：

- 每次 spawn 都把 shell pid 登记进 pi 进程内的 tracked 集合（`trackDetachedChildPid`，bash.js:70）；
- pi 收到 SIGTERM/SIGHUP 时先 `killTrackedDetachedChildren()` 杀光所有登记过的子进程再退出（rpc-mode.js:282-292）；
- **缺口**：runtime 强杀链 SIGTERM→2s 宽限→SIGKILL（rpc-client.ts:94,743）、Electron 崩溃、断电——这些场景 pi 来不及跑清理代码，detached 子进程被 init 收养，永久存活（占端口/句柄）。runtime 自身的孤儿回收（reap-orphan-pi.ts）只认 pi 自己的 argv 特征，不会碰 bash 孤儿。

### 2.2 要废弃的 unified-hooks 现状

真实交互例子（现状的失败模式）：

```
LLM: bash {command:"pnpm test"}
  → [network/test guard] block："请设置 timeout 参数（推荐 60-120s）"
LLM: bash {command:"pnpm test", timeout:120}      ← 白花一轮往返
  → 命令同步跑 120 秒,期间 turn 完全卡死;若测试要跑 10 分钟则到点被杀,前功尽弃
```

机制细节：`tool_call` hook 只拦 bash，正则匹配（network-timeout-guard.ts:15-25、test-timeout-guard.ts:17-60），命中且 `timeout == null` 即 `{block:true}`。**零配置键**——正则表和建议秒数全部硬编码在源码里。另有 tool-error-handler（出错时 appendEntry 审计，无阻断）。不在 mandatory 清单中，靠用户级安装加载。

失败模式汇总：

| # | 失败模式 | 根因 |
|---|---------|------|
| F1 | 长命令卡死整个 turn | bash 同步语义，无 background |
| F2 | block 往返浪费一轮对话 | unified-hooks 只能拒绝，不能代为改写执行方式 |
| F3 | 无法并行（边跑测试边改代码） | 同 F1 |
| F4 | 强杀/崩溃后 bash 孤儿泄漏 | tracked-pid 收殓只在 graceful shutdown 生效 |
| F5 | 拦截策略不可调 | 正则硬编码，无配置文件 |

### 2.3 关键术语

- **task_id**：一次后台任务的标识，形如 `bt-<ts>-<rand>`（时间戳 + 随机串；前缀 `bt-`（bash task）刻意区别于 subagent-workflow 已占用的 `bg-/run-` 前缀，避免 pending 列表里两类 id 命名空间混淆），用于查询与 kill。必须全局唯一——pending 差集算法以 id 全局唯一为前提（state.ts:184），进程内自增序列在 pi 重启后会与旧 entries 撞 id，导致 register 被幂等忽略（state.ts:86-89）或旧 unregister 误消新任务。
- **dataDir**：本包的存储根 = pi 的 `getAgentDir()`（默认 `~/.pi/agent/`，尊重 `PI_CODING_AGENT_DIR`），与 llm-shared getConfigPath 同源（config.ts:37-39）；与桌面端 `~/.xyz-agent/`（runtime getDataDir）按项目隔离铁律完全隔离，两不相涉。
- **ownerPiPid**：registry 条目记录的「发起任务的 pi 进程 pid」，reaper 属主判定的依据——属主进程仍活 = 合法任务跳过；属主已死且任务 pid 存活 = 孤儿补杀。
- **reaper**：孤儿收殓器。任意 session 启动时扫描 registry 全部 sessionId 目录，按属主判定 + pid 死活（start-time 防复用误杀）处置孤儿；不介入属主存活的挂死场景（那由 bash_kill / 用户 kill 处理）。
- **lifecycle 分档**：pending-notifications 的类型级生命周期声明 `session | process`（D16）——process 档统一豁免 TTL/U4 跨 session/shutdown cancelled。
- **killing intent**：bash_kill 已发令但轮询器 exit 边沿未确认的瞬态状态，kill 返回前写入单例表与 registry 两侧（查询面立即可见，无「已 kill 仍 running」倒挂）。
- **pid 注册表**：「task_id → OS pid」的持久化 JSON 文件，是孤儿收殓的依据（区别于 pi 进程内的 tracked Set——后者随进程死亡消失）。
- **强制白名单（force patterns）**：正则列表，命中的命令无论模型是否要求都进后台。
- **同名 override**：extension 以 `registerTool({name:"bash"})` 注册工具，pi 的工具注册表按 name 后注册者覆盖内置定义（agent-session.js `_refreshToolRegistry`，1940-1966 行）；且 pi 公开导出的 `createLocalBashOperations` 工厂 JSDoc 明示供 extension 包装/复用本地 shell 行为（bash.js:37-42）——委托官方工厂是上游设计的用法，不是钻空子。

## 3. 解决方案

### 3.1 终态（使用者视角）

成功路径——模型视角的完整交互：

```
LLM: bash {command:"pnpm test"}
  → （命中白名单,自动转后台）result:
     "Command force-routed to background (matched pattern 'test').
      task_id: bt-1724589012-a3f7  pid: 12345
      Output file: <dataDir>/base-tool-enhance/<session>/bt-1724589012-a3f7.log
      Poll with bash_output {task_id:'bt-1724589012-a3f7'} or omit task_id to list all tasks."
LLM: （继续干别的:读代码、改文件……turn 不被占用）
  → 数分钟后新 turn 注入通知:
     "[background-bash] bt-1724589012-a3f7 finished (exit 0, 3m12s): pnpm test
      Last lines: ... Tests: 42 passed ...
      Full output: <path>; use bash_output for details."
LLM: （需要细节时）bash_output {task_id:"bt-1724589012-a3f7"}  → tail 输出 + 截断标记 + 全量文件路径
```

失败路径与恢复指引：

| 场景 | 模型看到 | 恢复动作 |
|------|---------|---------|
| 后台任务 exit ≠ 0 | 通知带 error 与末尾输出摘要 | `bash_output` 查看完整输出定位原因 |
| 任务挂死需人工终止 | —（用户侧诉求） | 让模型 `bash_kill {task_id}`；工具层不可用时用户直接杀**进程组**（detached 任务自成进程组：`kill -- -<pgid>`，单杀 shell pid 不杀其子孙进程；属主进程仍在运行，轮询器随后收到 exit 边沿、写 exited 终态并 emit unregister）。**reaper 不介入挂死场景**——它按属主判定只处理属主已死的孤儿，属主活着的挂死任务会被判为合法任务跳过；同样不要删 registry 条目（那会让 reaper 失明） |
| 并发后台数达上限 | bash 返回错误"max N concurrent, oldest: bt-x" | `bash_kill` 旧任务后重试 |
| 配置 JSON 写坏 | 工具照常工作（内置默认值），debug 日志 warn | 修复 `config/base-tool-enhance-ext-config.json`，读时刷新自动恢复 |
| kill 一个已死任务 | `{killed:false, reason:"already exited (code 0)"}` | 无需处理，状态即终态 |

用户视角变化：桌面对话流中后台任务的启动/完成以 custom entry 形式出现（复用现有 custom_message 通道，subagent-bg-notify 先例）；其余 UI 不变。**跨进程边界**：`bash_output` 查询与完成通知归属发起任务的 session/pi 进程；桌面端新建 session / fork 是新 pi 进程（runtime 进程模型），在新 session 里查不到其他 session 的后台任务（回发起 session 查询），任务也不因新 session 创建而被杀（reaper 属主判定，§3.5）。

### 3.2 方案对比：如何获得前台 bash 能力

override 后工具的全部行为归新包负责，「前台模式怎么实现」是第一分叉点：

| 方案 | 长期架构合理性 | 短期成本 | 风险 |
|------|--------------|---------|------|
| **A. 完全自研 execute**（自己 spawn/截断/env/收殓） | 差：复刻 builtin 约 300 行核心逻辑，pi 升级时双向漂移，三个月后必然想骂人 | 高 | 截断规则、shellPath 设置、PI_* env、stdin commandTransport 等细节遗漏即行为回归 |
| **B. 同名 override + 前台委托 pi 官方工厂 + background 自研**（推荐） | 好：前台语义永远跟随 pi 版本升级；自有代码只包含真正的增量（background） | 中：需验证工厂函数委托路径 | 委托路径下 tracked-pid 收殓是否继承需实施期探针确认（见 §3.4 探针 P2） |
| **C. 纯 hook 改写 input，不 override 工具** | 差：hook 不能改变「execute 同步等到退出」的语义，background 根本做不出来 | 低（但不可行） | — |

**推荐 B**。pi 主入口公开导出 `createBashToolDefinition(cwd, options)` / `createLocalBashOperations()`（dist/index.d.ts:24），前台分支直接调用官方工厂拿 execute 实现。若用它，§2.2 的往返例子变成：模型发 `pnpm test` → 直接后台启动返回 task_id，零往返、turn 不占死。

### 3.3 关键决策与权衡

已拍板决策（本轮评审确定）：

| # | 决策 | 内容 |
|---|------|------|
| D1 | tier=infrastructure | bash 是核心工具，增强层不可禁用；进 mandatory-extensions.json infrastructure 组（builtin_cannot_disable 守卫生效） |
| D2 | 工具名保持 `bash` | 桌面侧六处硬编码 key 在 `'bash'`：truncate-tool-output、useToolMeta、block-icon、pi-preset BUILTIN_TOOLS 与 deniedTools（同文件两处）、permission extractCommand——改名导致审批退化为逐次弹窗 + 渲染失配；只扩 schema 加 `background?: boolean` |
| D3 | 白名单命中无视 `background` 参数 | 即使模型显式 `background:false` 也强制后台，result 中注明原因（pattern 命中） |
| D4 | 前台不填 timeout 维持不限时 | 与 pi 内置语义一致；网络类挂死风险由「模型显式 timeout + G3 可配置前台默认超时」承接 |
| D5 | 完成通知复用 pending-notifications | emit `pending:register/unregister`（type 新增 `"bash"`，经 D16 lifecycle 分档接入）+ `pi.sendMessage({customType, content, display:true}, {deliverAs:"steer", triggerTurn:true})` 驱动新 turn（实装签名见 notifier.ts:61-64）；goal 的「活跃后台任务时不发 continuation」守卫免费生效（agent-end.ts:177 纯差集） |
| D6 | 后台无本包强加的寿命上限 | 本包不设 TTL/硬上限（区别于 pending 的 1h TTL——`"bash"` 为 process 生命周期档（D16）豁免之，否则长任务被判 expired、D5 守卫失效）；任务寿命可由使用者显式约束——LLM 显式 `timeout`（schema 尊重）或配置 `backgroundTimeoutSeconds`（缺省不注入 = 不限）。出口 = 自然退出 / 到点超时 / `bash_kill` |

本文档补充决策：

> 设计演变记录：D5 的接入形态从「type 注册 + 逐点豁免」演进为 D16 lifecycle 分档——分档源于 pending-notifications 的 session-entry 生命周期与 D12 进程级生命周期的结构性冲突，逐点豁免实际需 6 处 type 特判且逐条腐蚀 D9 立的「通用设施不绑 bash 语义」原则。D17 应对「session 替换重建 eventBus 并重新 load extension」的实装行为（闭包式 exit 监听在新 session 不可达）。suggest-timeout 正则组因配置语义矛盾被删除（见 §3.5）。桌面端进程模型经核实为**每 session 独立 pi 进程且常态并行**（process-manager.ts:142-144）——reaper 属主判定与跨进程边界（§3.5）由此而来。用户拍板的「复用 pending-notifications」决策不变，变的是接入形态。

| # | 决策 | 选择 | 被否方案与理由 |
|---|------|------|--------------|
| D7 | 后台输出治理 | spawn 时 stdout/stderr 直接重定向到日志文件，查询时 tail 读文件 | 内存累积：长任务 OOM + pipe backpressure 会阻塞子进程写入；也不选「完成后一次性回传全量」——中间过程不可查 |
| D8 | 孤儿收殓 | pid 注册表持久化到 `<dataDir>/base-tool-enhance/<sessionId>/registry.json`，session 启动时 reaper 按 pid 死活判孤儿并补杀 | 仅靠 pi tracked Set：进程死亡即消失，兜不住 SIGKILL/崩溃；worktree-manager 已验证同范式（`.alive` 文件 + pid 死活 + SPAWN_GRACE 宽限防误杀），直接借鉴 |
| D9 | 查询/kill 接口形态 | 独立小工具 `bash_output`（task_id 可省略=list）与 `bash_kill`（必填 task_id） | 合并为单工具多 action：kill 与查询的权限语义不同，独立 schema 更清晰，LLM 误用率低；不复用 pending_notifications 工具——它是 infrastructure 通用设施，不应绑定 bash 输出语义 |
| D10 | 并发上限 | `maxConcurrentBackground` 默认 8，超出报错并列出最老任务 | 不设上限：模型失控循环开任务会耗尽资源 |
| D11 | unified-hooks 废弃方式 | 整包 deprecated（package.json deprecate + AGENTS.md 清单移除 + fixture 脚本弱引用清理），test guard 的正则迁入 force-test 白名单（落点 M4），network guard 的挂死保护语义由「模型显式 timeout + 可配置全局前台默认超时」承接（正则不迁入，理由见 §3.5 正则基线），tool-error-handler 审计行为迁入本包 tool_error hook（落点 M1） | 保留包只删 hook：残留安装会与新包双重拦截（两家都拦 bash），必须整包退场 |
| D12 | 后台任务生命周期出口 | **绑定 pi 进程，不绑定 session**：出口 = 自然退出 / 到点超时 / `bash_kill` / pi 进程退出（dispose 或 SIGTERM graceful）。此处 session 替换指 **pi 进程内**替换（CLI `/fork`、session 选择器切换（interactive-mode.js:2341）、或同进程 RPC session.* 命令）——不影响任务运行，extension 层接管见 D17；桌面端新建/fork 走 runtime **每-session-独立-pi-进程**模型（process-manager.ts:142-144，fork 出新进程、源进程保留，session-lifecycle.ts:729-733），任务跟随**发起进程**（registry 记 ownerPiPid），新进程不接管、不查询、不误杀（属主判定见 §3.5） | 绑 session：pi 的 session_shutdown 在 fork/switch/new/reload 全部触发（agent-session-runtime.js:102-160 teardownCurrent 调用点），切一次 session 就误杀全部后台任务，直接推翻 G1，reaper 兜底也随之失去意义 |
| D13 | 强制后台时的 timeout 处置 | 命中白名单强转后台时**忽略 LLM 显式 timeout**，按「配置默认 → 不限」取值并在 result 注明 | 尊重显式值：模型在 unified-hooks 时代被训练出「跑测试带 timeout」习惯，`{pnpm test, timeout:120}` 会在 120s 被杀，精确复刻 §2.2 要解决的失败模式；白名单的存在意义正是「这类命令不该被时限约束」 |
| D14 | subagent 嵌套 | 子 agent 进程内本包**降级**：禁用强制白名单与 background 参数，保持内置同步语义；以 subagent 注入的环境标记识别（探针 P5）。降级**不关闭**前台默认超时注入——`foregroundTimeoutSeconds`「对所有前台命令生效」的 G3 语义与后台化能力正交（§3.5 timeout 优先级无 subagent 例外）。**暂时性约束**：subagent 长任务需求出现时应演进为 per-agent 显式 opt-in，而非永久继承全局白名单一刀切 | 子 agent 内后台化会破坏 workflow 结构化输出契约（预算耗尽时测试未回）；且子进程死后其 registry 目录永远不会再有 session 启动，孤儿无人 reap |
| D15 | 用户中断与后台任务 | abort/interrupt 不传播到已提交的后台任务（execute 已立即返回，abort 仅作用于前台等待路径） | 有意为之；若联动取消，「提交后继续干别的」在中断场景全部作废，与 G1 矛盾 |
| D16 | pending 生命周期分档 | pending-notifications 曾引入分档常量（`Record<PendingType, "session" \| "process">`，subagent/workflow=session，bash=process），register 写入 / normalize 回填 / U3 过期 / U4 跨 session / shutdown cancelled 等行为**按档判定**，不做 type 特判（见 §3.5 接入细则）。**该分档常量已随 ext-simplify-12 删除**——三类型恒 process 档（无 TTL、跨 session/重启续存、shutdown 不清）成为无条件代码自然状态，本行分档判定描述转为历史决策记录，后续实施以 ext-simplify-12 终态为准。独立安装（CLI 通道）的版本耦合：本包对 pending-notifications 声明 peer 门槛——未装则通知链路缺失但 bash 后台功能完整（启动 warn 一次）；装旧版（无 `"bash"` type 与分档）则 bash 会被归一化为 workflow、session 档行为全套复活，启动时 warn 明确不支持 | 逐点豁免（初稿方案）：实际需 6 处 type 特判（TTL 写入侧、TTL 读取侧归一化回填、U4、shutdown、进程退出收尾、id 唯一语义），逐条腐蚀 D9 的通用设施原则；分档一次改动覆盖全部，scheduler 等未来 process 档类型声明即得、零额外改动 |
| D17 | exit 感知与 session 替换接管 | 任务 exit 感知用**模块级轮询器单例**（约 2s 间隔 `kill(pid,0)` 判活），不依赖 ChildProcess exit 闭包；同进程 session 替换（/fork、选择器切换、RPC session.*）后新 extension 实例 load 时刷新轮询器的「当前 pi 引用」，完成通知投递到新 session（subagent-workflow notifier 的 dispose/revive 配对是同题先例，notifier.ts:244-258） | ChildProcess exit 闭包监听：session 替换会创建全新 ResourceLoader/eventBus 并重新 load extension（pending-notifications index.ts:81-88 实装注释，锚 loader.js:338-341、agent-session-services.js:63-68），闭包里的 bus/pi 引用全部 stale——完成通知在新 session 不可达，D12 在 extension 层不成立。轮询 2s 延迟对分钟级任务无感，换取单一机制跨 session 替换免疫 |
| D18 | sunset 条件登记 | 本包登记退役条件：pi 上游出现原生 background bash（或等价长时命令异步化）能力时评估退役；届时前台行为已收敛在 `createBashToolDefinition` 委托面，迁移成本可控 | 不登记：3 年后冗余层无人敢删（不知上游是否已覆盖），override 层与上游能力双轨漂移 |

### 3.4 运行时断言与探针

涉及运行时行为的断言分三档：

**✅ 已核实（本设计的事实地基，实装版源码验证）**

| 断言 | 证据 |
|------|------|
| 同名 registerTool 覆盖内置工具 | agent-session.js `_refreshToolRegistry`:1940-1966，custom definition 后 set 覆盖 base |
| pi 导出前台工厂函数 | dist/index.d.ts:24 `createBashToolDefinition/createLocalBashOperations` 等 |
| 内置 timeout 单位秒、默认不限、超时 killProcessTree | bash.js:17-27、79-103 |
| detached spawn + SIGTERM 收殓 + SIGKILL 缺口 | bash.js:60,70、rpc-mode.js:279-293、rpc-client.ts:94,743 |
| pending TTL 硬编码 1h（历史事实，机制已删除） | 引入时 state.ts:68 硬编码 1h TTL 常量——该常量与全部 TTL 清理已随 ext-simplify-12 整体删除，现行无任何 TTL 清理 |
| pending 读取侧归一化对缺失 expiresAt **回填** 1h TTL（历史行为，已删除） | 回填分支（当时 state.ts:250 `normalizeRegisterEntry`）已随 ext-simplify-12 E1 删除——写入侧恒省略 expiresAt，读取侧不消费该键（历史 entry 遗留键同此）；「两侧同改」的坑位已随机器删除消解 |
| session 替换（dispose）重建 eventBus 并重新 load extension；模块级状态跨 reload 保留 | pending-notifications index.ts:81-88 实装注释（锚 loader.js:338-341、agent-session-services.js:63-68）；其模块级 `unsubscribers` 列表跨 reload 保留即模块级轮询器（D17）可行的活证据 |
| sendMessage 实装签名（message 在前，options 在后） | notifier.ts:61-64：`sendMessage({customType, content, display, details?}, {triggerTurn?, deliverAs?})` |
| sendMessage 驱动新 turn 先例 | notifier.ts:10 `deliverAs:"steer", triggerTurn:true` |
| goal continuation 守卫 = 纯差集、刻意不校验 TTL | agent-end.ts:175-193（`countActiveFromEntries(getEntries())`，count>0 时不发 continuation） |
| pending 差集算法以 id 全局唯一为前提 | state.ts:184 注释明示（workflow/subagent id 均带 ts/rand 防撞）；register 同 id 幂等忽略 state.ts:86-89 |
| 桌面端每 session 一个独立 pi 进程且常态并行；新建/fork spawn 新进程、源进程保留；另有 ephemeral 短命附着通道（switchSession 附着既有 session 文件） | process-manager.ts:142-144,146,118-121、session-lifecycle.ts:729-733 |
| pi 的 killProcessTree 未从主入口导出（不可 import） | pi package.json exports 仅 `.`/`./rpc-entry`/`./client`；定义在 dist/utils/shell.d.ts:30 但子路径不暴露 |

**⛔ 实施期探针门（探针不过则对应设计点回炉，禁止跳过）**

| # | 待验证断言 | 探针方法 | 不过时的回退 |
|---|-----------|---------|------------|
| P1 | permission 审批对新增 `background` 字段的兼容性：本设计白名单路由在 execute 内部（不改写 input），permission 审的是原始 input（command + 可选 background/timeout）——需验证 permission hook 对含未识别字段的 input 正常解析与审批，审批展示的 command 与实际执行一致 | strict/approve 模式最小扩展实测：发 `bash {command, background:true}` 与白名单命中命令，观察审批弹窗与批准后行为 | permission 对 background 字段报错/拒绝 → 与 permission 扩展协调把该字段加入其已知字段集，不改回「hook 改写 input」路线 |
| P2 | 前台委托 `createBashToolDefinition` 时，tracked-pid 登记与 SIGTERM 收殓仍生效 | 本包注册的 bash 跑 `sleep 300`，SIGTERM 杀 pi，`pgrep -f sleep` 验证子进程消失 | 不生效则在 background/前台统一走自管 pid 表 + 进程 dispose/SIGTERM 时收殓（D8 机制扩大到前台；不可用 session_shutdown 收殓——它在 fork/switch/new 全触发，与 D12 出口三冲突） |
| P3 | 任务 exit 后调 `pi.sendMessage` 能安全驱动新 turn（execute 已返回后的时机） | 后台任务结束时观察 RPC 流出现新 turn 且消息入列正确。注意：subagent-workflow 的先例经父进程 IPC 委托 session-delivery 内核投递（notifier.ts:10-13），与本包同进程异步时机不同构，不可因先例存在而跳过本探针；调用按实装签名 `pi.sendMessage({customType, content, display:true}, {deliverAs:"steer", triggerTurn:true})` | 降级为「仅 emit unregister entry，不主动 triggerTurn」，模型靠 pending_notifications 轮询（体验降档，功能不缺失） |
| P4 | extension 侧获取 sessionId/dataDir 的 API 形态（注册表路径推导依据） | 读 types.d.ts ExtensionContext 字段 + 最小扩展打印 | 无 session 粒度 API 则注册表按「pi 进程实例」粒度存放于 dataDir 固定名目录（该回退触发时目录结构变为进程粒度，reaper 扫描与 S5 验收同步按进程粒度适配） |
| P5 | subagent 子进程存在可编程识别的环境标记（供 D14 降级判断） | 读 subagent-workflow spawn 时的 env 注入（argv-mirror.ts / session-runner.ts），最小扩展打印 process.env 对照 | 无现成标记则在 argv-mirror 补一个 env（改动点单一）；未落地前 M2 对子进程同样生效并在文档标注风险 |
| P6 | session 替换后接管与对账链路完整：轮询器（模块级单例）跨替换存活、新实例刷新 pi 引用后完成通知投递新 session；对账 appendEntry 消除旧 session 僵尸 register | fork **前**起后台 `sleep 30` → fork 到新 session → 等任务完成：观察新 session 收到 steer 通知、`pending:unregister` entry 落盘（发起于旧 session 的 register 被抵消）；随后**重开旧 session**：其 session_start 对账 appendEntry 消除文件内僵尸（此步才是对账断言的验证时点——fork 复制的僵尸只能等旧 session 重开才消除） | 通知不可达则 session 替换时同步交接（旧实例 dispose 前把任务表 flush 给新实例，仿 notifier dispose/revive 握手）；模块级状态不保留则轮询器挂 `globalThis`；对账 entry 不被差集识别则核对形态与 index.ts:191-195 逐字段一致 |

### 3.5 接口规格

**bash 工具（override 后）input schema**：

```ts
{
  command: string;
  timeout?: number;       // 秒;显式填了尊重(唯一例外:D13 白名单强转后台时忽略)
  background?: boolean;   // 新增;缺省 false
}
```

timeout 解析优先级：LLM 显式值 > 配置文件默认值 > 不限时（前台）/ 不限（后台）。注入只发生在「LLM 未填 && 配置了默认」时。**唯一例外（D13）**：命中白名单强制后台时忽略 LLM 显式 timeout，按「配置默认 → 不限」取值并在 result 中注明。

**工具 description 重写**：registerTool 的 definition 含 description 字段，官方工厂返回的文案（bash.js:233）不含 background 用法。override 时必须重写 description：说明 background 参数语义、task_id / bash_output / bash_kill 配合方式、白名单自动转发行为——否则 LLM 无法发现新参数，「模型主动要求后台」的路径不可达。

**配置文件** `<dataDir>/config/base-tool-enhance-ext-config.json`（llm-shared `loadConfig` 读时刷新热重载范式，同 smart-context/permission）：

```jsonc
{
  "forceBackgroundPatterns": ["string"],  // 追加到内置白名单之后,匹配整条 command
  "disableBuiltinForcePatterns": false,    // true = 关闭内置 force-test/force-longrun 两组,只用用户正则
  "foregroundTimeoutSeconds": null,        // null = 不注入(D4);数字 = 前台未填 timeout 时的默认
  "backgroundTimeoutSeconds": null,        // null = 不注入;数字 = 后台未填时的默认
  "maxConcurrentBackground": 8
}
```

normalize 校验失败 → 该键回退默认 + logger.warn，**不整体拒载**（部分坏配置不拖垮可用性）：类型错/负数/0 → 回退默认；timeout 值换算毫秒后超 int32 上限 → clamp 至上限 + warn；`forceBackgroundPatterns` 中单条非法正则（compile 失败）→ 仅丢弃该条 + warn——一条坏正则不让所有前台命令全挂。

**内置正则基线（两组，包内常量）**：

| 组 | 来源 | 示例 | 默认动作 |
|----|------|------|---------|
| force-test | 迁自 unified-hooks test-timeout-guard 正则（test-timeout-guard.ts:17-60） | npm/pnpm test、npx vitest/jest/playwright、pytest、go test、cargo test… | 强制后台（D3/D13） |
| force-longrun | 新增（unified-hooks 无此类） | dev server、`--watch`、`tail -f` 等长驻命令（判定标准 = 命令语义上无自然退出点，按命令名与 flag 组合匹配，不做 `--watch` 字面量子串匹配——`rg --files \| grep watch` 不命中） | 强制后台 |

**匹配语义**：组内正则一律锚定**命令位置**（行首，或 `;` / `&&` / `||` / `|` / 换行之后的命令起始位），不做裸子串匹配——防 `git commit -m "fix: npm test"` 这类参数文本误伤（F2 的往返浪费不得在误伤面回归）。正则近似匹配的固有局限（诚实登记）：引号内换行 / heredoc 内容理论上可构造误伤样例、`$(...)` 命令替换内的命令会漏报、wrapper 形态（`sudo npm test` / `timeout 300 npm test` / `xargs npm test`——wrapper 名占命令位置、目标命令退到参数位）同样漏报——force 命中转后台是非破坏性的（模型可 `bash_output` 查输出，误伤代价一轮查询），漏报由模型显式 `background:true` 兜底。force-longrun 完整清单 M4 期定稿，原则 = 命令语义上无自然退出点。

网络类命令（install / curl / git push / docker build 等，unified-hooks network-timeout-guard 的拦截对象）**不设 force 正则**：这类命令时长不定且结果常被立即需要，强制后台反而增加取结果往返。其挂死风险的承接方式 = 模型显式 timeout（pi 原生）+ G3 的 `foregroundTimeoutSeconds`（配置后对**所有**前台命令生效，无需正则清单）。network-timeout-guard 的正则不迁入——若正则 gate 注入，`foregroundTimeoutSeconds` 会出现「全局默认」与「仅命中才注入」两种解读（二轮审查发现的规格矛盾），删除该组使配置语义唯一。

配置开关 × 组的行为矩阵：

| 配置状态 | force-test | force-longrun |
|---------|-----------|---------------|
| 零配置（默认） | 生效（强制后台） | 生效（强制后台） |
| `disableBuiltinForcePatterns: true` | 关闭 | 关闭 |
| 用户 `forceBackgroundPatterns` | 追加合并，匹配任一即强制后台 | 同左 |

**后台任务生命周期数据流**：

```
execute({command, background})
  │ ①白名单判定(命中 → 强制 background,D3)
  │ ②并发上限检查(满 → 报错返回最老 task_id)
  │ ③spawn sh -c cmd,detached,stdio→append 打开的 <task_id>.log
  │ ④registry.json 写入 {task_id: bt-<ts>-<rand>, pid, command, outputFile, startedAt, state:running}
  │ ⑤emit pending:register {id:task_id, type:"bash", name:command 前 80 字符}
  │    (bash 属 process 档,entry 不写 expiresAt——D16)
  ▼ 立即 return(task_id/pid/log 路径/使用提示)

任务 exit 感知(D17:模块级轮询器单例,约 2s 间隔 kill(pid,0) 判活;
  不依赖 ChildProcess 闭包 → session 替换后天然可接管)
  │ ⑥exit 边沿:读输出文件组装 {exitCode,duration,tail 摘要}
  │ ⑦registry 终态(exited,保留供 bash_output 查询,LRU 上限 50 条)
  │ ⑧emit pending:unregister {id,result|error}
  │ ⑨pi.sendMessage({customType,content,display:true},{deliverAs:"steer",triggerTurn:true})  ← 探针 P3
  ▼    (pi 引用 = 轮询器持有的"当前 extension 实例"引用,session 替换后新实例 load 时刷新)

session 替换(同进程:CLI /fork、session 选择器切换、RPC session.*):extension 重新 load,
  轮询器为模块级单例不受影响——任务表无需恢复,单例表条目唯一来源 = 本进程 execute 的 spawn;
  session_start 时对账(接入细则第 4 条)——任务不中断(D12/D17)

pi 进程退出(dispose / SIGTERM graceful,含桌面删除 session 的 destroySession) →
  轮询器停止 + 遍历**单例表** running 条目 killProcessTree
  (单例表 = 本进程任务全集,天然不含他进程条目——不遍历 registry,
   否则 ephemeral 附着进程退出时会误杀属主进程的任务)
  + registry 条目写终态 exited(reason:"process-exit") + 尽力补 emit pending:unregister
  (pi API 若仍可用;registry/entry 写不进则条目停留 running——由 reaper 的
   「属主死+pid死」分支转终态、由对账的 pid 判活兜底,registry 终态闭环不依赖单一路径)
  (同进程 session 替换不触发收殓——D12:任务绑定进程,不随 session 替换终止;
   删除发起 session = pi 进程退出 → 其后台任务随之收殓终止,输出 .log 文件保留)
pi 被强杀/崩溃 → 任意后续 session 启动时 reaper 扫 <dataDir>/base-tool-enhance/ 全部
  <sessionId>/ 目录,双重判活:
  ①属主判定——registry 条目记 ownerPiPid(发起任务的 pi 进程),
    属主进程仍活(桌面端并行 session 的进程/ephemeral 附着之外的常驻进程) → 跳过,
    那是活进程的合法任务,不是孤儿
  ②孤儿判定——属主已死且任务 pid 存活 → 补杀 + registry 标 orphaned;
    任务 pid 死活加 start-time 校验防 pid 复用误杀
  ③终态收尾——属主已死且任务 pid 已死但条目仍 running
    (graceful 收殓的 registry 写入没写完/写不进) → 不补杀,仅转终态 orphaned——
    保证 registry 终态闭环,对账判据才有依据
  多 pi 进程并发由 extensions/shared/file-lock 串行化(防扫描/写入冲突;
  误杀由属主判定防,file-lock 不承担);
  pending 收尾统一由 session_start 对账兜底(接入细则第 4 条)
```

> **设计演变记录（2026-09 收殓下沉 runtime）**：上文数据流末段（「pi 被强杀/崩溃 → ……reaper 扫……」）及 §2.3 术语 reaper、§3.3 D8、接入细则第 4 条的「reaper 先、对账后」执行顺序、S5/M5 中的 reaper，均指 **extension 侧全局扫描 reaper 的历史实现**，已于 2026-09-01 事故（pi factory 二调下 reaper 双跑触发 jiti × proper-lockfile 锁崩溃杀死 pi 进程）后随 [file-lock-unification-and-reaper-sink](file-lock-unification-and-reaper-sink.md) 设计落地而删除——收殓职责归位 pi 生命周期的所有者。现行链路：孤儿后台任务收殓由 `packages/runtime/src/services/session/background-task-reaper.ts` 双触发面执行——触发面 A `reapSessionBackgroundTasks(agentDir, sessionId)` 挂 session 销毁汇聚点（精确时点收殓，fire-and-forget 不阻塞销毁链），触发面 B `reapAllSessionsBackgroundTasks(agentDir)` 挂启动期全量兜底扫描（承接跨运行遗留孤儿，硬序在孤儿 pi 收殓完成后）；三分支判定（属主活跳过 / 孤儿补杀 / 终态收尾）自本文 reaper 逐段移植，registry 契约（目录布局 / 终态枚举 / ownerPiPid 语义）SSOT 迁至 `@xyz-agent/extension-protocol`（background-task.ts）。extension 侧保留 `reconcilePendingEntries` 对账（session 级操作，每 session_start 执行，不受下沉影响）；registry 写侧（spawn/exit 后台任务时）仍在本包，写锁与 runtime 收殓侧互斥同一 lockfile。另登记已接受边界（ext-simplify-13 E11）：bte 作为 universal 包支持纯 CLI 独立安装（无 xyz-agent runtime），该形态下无 runtime 收殓兜底——孤儿处置依赖 pi 进程自身生命周期（process-exit 收殓）与 session_start 对账的 pid 判活兜底，跨进程孤儿收殓仅在 xyz-agent 桌面环境可用。

**进程级任务表与 registry 的两层存储分工**（D8 的 per-session registry 目录与 D12/D17 进程级任务表的粘合规格）：

- **轮询器单例的任务表 = 运行时权威**：`bash_output` / `bash_kill` / 完成通知全部读单例表。**条目唯一来源 = 本进程 execute 的 spawn**——同进程 session 替换后单例表直接延续（模块级单例未死，无需「恢复」）；他进程的 running 条目**永不进单例表**（ephemeral 短命附着、resume 被强杀 session、桌面新建进程同此规则：新进程对 running 条目零恢复零接管，处置权统一归 reaper 属主裁决——属主死则补杀标 orphaned，属主活则跳过；终态条目 exited/orphaned 可从 registry 读，仅供 bash_output 查历史）。fork/switch 前发起的任务条目跨同进程替换持续在表——S8 场景 A「新 session 列出旧任务」由单例表兑现。轮询器随任务惰性启停：单例表无 running 条目时停止（清除定时器，防空转泄漏），下一个任务登记时重启；进程退出 dispose 一并清除。单例表终态条目与 registry 对称采用 LRU 50 淘汰，淘汰后查询回落 registry 文件。条目保留 spawn 返回的 ChildProcess 引用——**不用于事件监听**（D17），仅用于读 exitCode（退出码唯一来源；libuv 自动 reap 后 `kill(pid,0)` 仍可判死而 exitCode 仍可读）；外力终止（用户杀进程组）与自然退出在观测上不可区分，reason 记 `natural`（`killed`/`process-exit`/`timeout` 仅覆盖本包主动路径）。
- **已知竞态窗口（诚实登记）**：同进程 session 替换的 dispose → 新实例 load 之间（毫秒级）任务恰好完成时，轮询器持有的 pi 引用尚属旧实例，完成通知可能落旧 bus 丢失一条——对账在该 session 重开时补 unregister（差集恢复正确性），完成内容可由 `bash_output` 查询；窗口极窄且后果可恢复，不为此加同步握手。
- **registry 文件（per-sessionId 目录）= 持久化权威**：① reaper 的孤儿发现源（扫全部 sessionId 目录，M5）——条目登记 **ownerPiPid**（发起任务的 pi 进程 pid），reaper 以**属主进程死活**定孤儿身份（worktree-manager `.alive` 范式的本义：判属主 pid，非判目标 pid）：属主仍活（桌面端并行 session 的进程）→ 跳过；属主已死且任务 pid 存活 → 补杀 + orphaned。桌面端新建/fork 是新 pi 进程（session-lifecycle.ts:729-733），在新进程里起 reaper 不会误杀源进程的任务——属主判定是这道防线的全部依据。②已知崩溃窗口（诚实登记）：spawn 成功到 registry 写入完成之间（毫秒级）进程崩溃 → 无条目、reaper 失明；概率极低的残余风险，不为它引入 starting 预写状态机（复杂度不匹配概率）。
- **跨进程边界**：不做跨进程接管、不做跨进程查询——新 pi 进程的单例表不含他进程任务，`bash_output` 查询与完成通知归属发起进程（用户回发起 session 查询，§3.1 边界声明）；跨进程接管的通知落点已失去锚定，责任链复杂度远超收益。
- 新任务登记同时写两侧（单例表内存条目 + 发起 session 的 registry 目录文件）；终态与 killing intent 同步两侧。

**bash_kill 终态收尾的单点归属**：`bash_kill` 只负责杀进程树（实现见上）；终态写入（终态、`pending:unregister`、通知）统一由轮询器 exit 边沿处理——kill 返回前**单例表与 registry 两侧**先标 killing intent（bash_kill/bash_output 读单例表判活，intent 必须在查询面立即可见：kill 返回后 bash_output 即显示 killing，无「已 kill 仍 running」倒挂窗口），轮询器边沿据此转 exited 终态（reason:"killed"）并 emit unregister，**不 sendMessage**（kill 调用方就在当前 turn 内等结果，再发 steer 通知是双发噪音）。

**pending-notifications 接入细则**（M3 实际改动面；二轮审查后从「type 注册 + 逐点豁免」改为 D16 lifecycle 分档泛化）：

pending-notifications 现有语义是 **session-entry 生命周期**（sessionId 归属判定 U4、TTL 过期 U3、shutdown 标 cancelled），与 bash 任务的**进程级生命周期**（D12）结构性冲突。分档泛化如下：

1. **type 注册**：`PendingType` 增加 `"bash"`（state.ts:18）；type 归一化两处（state.ts:246、index.ts:282 的「非 `"subagent"` 一律归 `"workflow"`」）为 `"bash"` 开直通行；查询工具 description（index.ts:244）同步提及 bash 类型。
2. **lifecycle 分档（历史机制，已随 ext-simplify-12 删除）**：曾包内新增分档常量（subagent/workflow=session，bash=process），下列五处行为**按档判定**（非 type 特判）——分档常量删除后，process 档语义成为无条件代码自然状态，下列明细转为历史决策记录：
   - register 写入（index.ts:150）：process 档不计算 expiresAt（entry 与 appendEntry 均省略该字段）；
   - `normalizeRegisterEntry`（当时 state.ts:250）：process 档**不回填** TTL——读取侧归一化当时对缺失 expiresAt 会回填 `registeredAt + 1h`，只改写入侧会被这里抵消，D6 豁免完全失效（二轮审查证实的坑；该回填分支已随 ext-simplify-12 E1 删除）；
   - U3 过期判定（state.ts:229）：expiresAt 缺失（undefined）的条目跳过；
   - U4 跨 session 判定（state.ts:224）：process 档跳过——fork/switch 后任务仍在跑（D12），不能标 expired 补 unregister（否则 goal 守卫读到差集归零误判「无活跃任务」）；
   - session_shutdown cancelled 标注（index.ts:226-237）：process 档跳过（任务跨 session 替换继续运行，D12）。
3. **task_id 全局唯一**：`bt-<ts>-<rand>`（§2.3）——差集算法前提（state.ts:184）；进程内自增序列在 pi 重启后撞旧 id：register 被幂等忽略（state.ts:86-89）→ 新任务 pending 注册静默丢失，或旧 unregister 误消新任务差集 → goal 守卫失效。
4. **session_start 对账**（pending 收尾的统一兜底）：本包在 session_start 时读 registry，对「session entries 差集显示 active、但任务已终态」的任务补收尾——判据 = registry state ∈ {exited, orphaned} **或**（state=running 且 `kill(pid,0)` 判死：收殓/写盘失败遗留的 running 条目按事实终态处理）。收尾写法 = **直接 `pi.appendEntry("pending:unregister", {id, reason, status})`**（entry 形态逐字段对齐 pending-notifications index.ts 的 unregister 落盘形态）——差集消费方 goal 从**持久化 entries** 算差集（agent-end.ts:177 `getEntries()`；pending 无内存状态，entries 是唯一状态源——其内存 registry/rebuild/changed 机制已随 ext-simplify-12 删除），appendEntry 对守卫直接生效。**不走 bus emit 作为权威路径**：pending-notifications 的 unregister listener 落盘前置是对 entries 现算 `isPendingActive`，而本包对账的 appendEntry 同步入账先于 emit 执行——emit 到达时该 id 必已注销 = 恒 no-op，「不走 emit 作为权威」的结论在新口径下更强；依赖 listener 存活/加载顺序的反对依然成立（两个 extension 的加载/派发顺序 CLI `--extension` 用户可控、mandatory 清单序无守卫）。appendEntry 之外可尽力补一次 emit（listener 就绪时同步其内存视图，缩短 `pending_notifications` 工具列表的不一致窗口，失败无害）——该 emit 步骤已随 ext-simplify-13 删除：pending 内存 registry 已随 ext-simplify-12 删除后 listener 对 entries 现算、对账 appendEntry 同步入账，emit 到达时必已注销 = 恒 no-op；appendEntry 即唯一权威路径。覆盖三类 otherwise 悬空场景：①进程 graceful 退出收殓时 pi API 已不可用、unregister 没写成 entry；②强杀后 reaper 只改 registry（标 orphaned）碰不了 session 文件；③fork 后任务完成通知写进新 session，旧 session 文件的 register 成僵尸。goal 守卫读到对账 unregister 后不再永等一个不会来的通知。执行顺序：同一 session_start 处理链内 **reaper 先、对账后**（先按属主判定处置孤儿/补写 registry 终态，再对账 pending）——即使顺序颠倒也无静默错误（对账先见 running+pid 活则判据不满足不动作，reaper 后到收尾，下一 session_start 对账兜底），最坏效果是 S5 断言推迟一个 session 周期，验收可捕获。
5. **已知限制（诚实登记）**：goal 的 continuation 守卫基于本 session 的 entries 差集（agent-end.ts:177）。fork 复制 session 文件 → 新 session entries 含 register（process 档跳过 U4，守卫生效）；但 switch 到另一既有 session 时该 session 的 entries 无此任务的 register——守卫仅覆盖「同 session（含 fork 继承）内发起并等待」场景，switch 场景靠完成通知本身驱动（通知投递到当前活跃 session，用户视角跟随）。

**bash_output**：`{task_id?}` → 省略时 list（单例表与 registry 终态条目合并，同 task_id 两处都有时以单例表为准——它的状态更新）：`{tasks: [{task_id, command(前 80 字符), state, exitCode?, reason?, startedAt, durationMs?}]}`；指定时返回 `{state, exitCode?, reason?, durationMs?, output(tail 2000 行/50KB 截断,同内置规则), outputFile, truncated}`。state 枚举：`running | killing | exited | orphaned`；exited 的 `reason`：`natural | timeout | killed | process-exit`（`killing` 是 bash_kill 已发令、轮询边沿未确认的瞬态）。

**bash_kill**：`{task_id}` → `{killed:boolean, reason}`；实现 = 自实现进程树 kill，分支语义对齐 pi 内置（Windows `taskkill /F /T`、POSIX 进程组）——pi 的 killProcessTree 未从主入口导出（exports 仅 `.`/`./rpc-entry`/`./client`），不可 import。**kill 目标限定本进程单例表条目**；registry 回落（含 bash_output 查询回落）**限定终态条目**（exited/orphaned，终态对 kill 直接返回 already exited）——registry 中他进程的 running 条目不可查、不可 kill（跨进程边界：处置权归发起进程，孤儿由 reaper 属主判定收殓）。kill 前校验 pid 判活与 start time 匹配（防 registry 陈旧条目遇 pid 复用误杀无关进程，宁不杀勿误杀）。

### 3.6 错误规格

| 错误 | 触发 | 模型看到的恢复指引 |
|------|------|------------------|
| 并发上限满 | ② 检查 | 「oldest task bt-x (cmd…)，kill it or wait」 |
| spawn 失败（cwd 不存在/shell 缺失） | ③ | 沿用内置文案风格，指出 cwd 校验失败原因 |
| config 解析失败 | 任一次读取 | 工具按默认值继续工作；warn 落 debug 日志指向配置文件路径 |
| output 文件被外力删除后查询 | bash_output | 返回 `{output:"<lost>", state}` 不崩溃 |
| kill 目标不存在 | bash_kill | `{killed:false, reason:"no such task", hint:"use bash_output to list"}` |
| registry.json 损坏（写半程/外力编辑） | 读取时 | 写入沿用 temp+rename 原子写（同 llm-shared 范式，正常路径无半程文件）；损坏时重命名 `.corrupt` 保留现场 + 按空表重建 + debug 日志 warn 指向文件路径；running 条目丢失的残余风险（reaper 对其失明）诚实登记；输出 `.log` 文件不受影响，可降级查询 |
| reaper 误判防御 | pid 被系统复用 | 判活时校验进程 start time（/proc 或 ps），不匹配视为已死不误杀无辜新进程；无法取 start time 的平台保守跳过（宁延迟勿误杀，同 worktree-manager 原则） |
| bash_kill 误判防御 | registry 陈旧条目遇 pid 复用 | kill 前校验 pid 判活 + start time 匹配（同 reaper 原则）；不匹配视为复用嫌疑拒绝 kill 并说明，宁不杀勿误杀 |

## 4. 验收（真实场景）

实施完成后的真实验证，每场景标注回溯目标。环境基准：本地 pi CLI 实测（extension 改动的 MANDATORY 通道，非 xyz-agent 桌面直测）+ 桌面 dev 模式集成验证。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| S1 | 测试命令自动后台 + 完成通知 | 在含 vitest 的项目装好扩展，prompt「跑一下这个项目的测试」，期间追问一个无关问题。**变体**：prompt 明确发 `pnpm test` 且自带 `timeout:120` → 应仍进后台且不被 120s 杀（D13） | ①首轮回立即含 task_id（未被测试占死）②追问正常回答 ③测试结束后新 turn 收到 exit code 与结果摘要 ④对话流重开后仍可见该通知 ⑤变体中任务跑过 120s 仍存活 | G1 G2 D13 |
| S2 | 后台 dev server 全生命周期 | prompt「后台起 dev server，然后告诉我端口通没通」 | ①curl 验证由模型在前台完成（证明并行）②`bash_output` 能看到持续输出 ③`bash_kill` 后 `lsof -i:<port>` 确认释放 | G1 |
| S3 | 超时配置双模式 | 配置 `foregroundTimeoutSeconds:10` 跑 `sleep 30`（前台）→ 10s 报 timeout；改配 `backgroundTimeoutSeconds:15` 跑后台 `sleep 60` → 15s 终止且通知注明；删掉两项配置重跑均不受限 | 各分支行为与 §3.5 优先级一致；热重载生效（不重启 session） | G3 |
| S4 | unified-hooks 平滑退役 | 卸载 unified-hooks、安装本包后重复 S1；另验 `disableBuiltinForcePatterns:true` + 用户自定义正则 `["sleep \\d+"]` → `sleep 999` 自动后台；触发一次工具报错看审计 entry | 测试类行为等效（网络类按 D11 弱承接语义：不再 block 往返、挂死保护依赖显式 timeout / 可配置默认超时）且无双重拦截日志；配置正则即时生效；审计 entry 由新包产生（tool-error-handler 已在 M1 迁入） | G4 D11 |
| S5 | 孤儿收殓 + pending 对账 | 起 background `sleep 3600` → `kill -9 <pi_pid>` → 确认 sleep 仍存活（复现缺口）→ 重启 session（桌面端用 new-session 形态，非 resume 同一 session）→ 再 resume 原被强杀的 session | reaper 扫描到孤儿目录并补杀；`pgrep -f "sleep 3600"` 为空；resume 后 `pending_notifications` 列表该任务非 active（session_start 对账补了 unregister，goal continuation 不被僵尸卡死——接入细则第 4 条） | G5 |
| S6 | infrastructure 打包集成 | xyz-agent `pnpm dev` 桌面端跑 S1 全流程；尝试禁用该 builtin | 对话流出现后台任务 entry；禁用请求被 `builtin_cannot_disable` 守卫拒绝 | D1 D2 |
| S7 | permission 协同 | strict/approve 模式下发后台危险命令 | 照常弹审批；批准后实际执行形态与审批内容一致（探针 P1 结论落地） | G1（审批协同是 G1 的安全侧面） |
| S8 | 任务跨 session 存活（按通道拆分） | **A（CLI 通道，pi 进程内 session 替换）**：起后台 `sleep 30` → CLI `/fork`（同进程替换）→ 等任务完成 → 重开旧 session。**B（桌面通道，runtime 新 pi 进程）**：session A 起 background dev server → 桌面新建 session B / fork 出 session C（新进程）→ 在 A 中 `bash_output` 查询 → 收尾：删除 session A | A：fork 后完成通知以 steer 注入新 session（任务发起于旧实例而通知落新 session——D17 接管的兑现）；新 session 的 `bash_output` 能列出该任务（单例表跨进程内替换存活）；重开旧 session 后其 pending 差集无僵尸 active（对账 appendEntry 生效）。B：任务进程仍存活（端口仍在——reaper 属主判定防新进程误杀）；新 session B/C **查不到** A 的任务（跨进程边界，§3.1）；回到 A 仍能列出查询；A 删除后任务随进程收殓终止（`pgrep` 为空、端口释放），输出 `.log` 保留 | G1 D12 D17 |
| S9 | subagent 嵌套降级 | 经 subagent-workflow 派子 agent 跑测试套件 | 子 agent 内 bash 保持同步语义（无强制后台）；主 agent 白名单照常生效（探针 P5 结论落地） | D14 |
| S10 | 用户中断不传播后台任务 | 起后台 `sleep 300` → 立即中断当前 turn（abort） | `bash_output` 确认任务仍 running、进程存活——中断只作用于前台等待路径（D15） | D15 |

单测另按 TEST-STRATEGY 三视角编写（fake timers 测 timeout 分支、真实 spawn 测生命周期），但不替代上表。

## 5. 下一层拆分

| 单元 | 内容 | justification | 可独立验收 |
|------|------|--------------|-----------|
| M1 包骨架 + 前台等价 | 包结构（universal 组模板）、登记清单：① mandatory-extensions.json（packages/shared/src/，infrastructure 组）加条目 ② 根 AGENTS.md universal 组列举更新 ③ 包骨架（package.json：xyz-agent.role=universal、pi 字段、dev/test 脚本）④ vitest.config.ts + tsconfig 接入（extensions 三连可跑）⑤ check-extension-dependencies.mjs 校验通过 ⑥ builtin staged 打包验证（打包按 mandatory-extensions.json SSOT 拾取、产物存在）；registerTool 同名覆盖跑通、前台委托官方工厂、description 重写、tool_error hook 注册 + 工具报错审计 entry（迁自 unified-hooks tool-error-handler，D11 落点） | 先证明「替换后一切照旧」是后续所有增量的安全网 | M1 后跑任意前台命令与 builtin 行为一致 + 工具报错产生审计 entry + S7 的审批兼容子断言（permission 对含 background 字段的 schema 审批正常——探针 P1；S7 完整场景归 M2）+ S6 的禁用守卫部分 + 探针 P2 |
| M2 background 核心 | spawn 落盘、registry.json（task_id 全局唯一 bt-\<ts\>-\<rand\>、ownerPiPid）与轮询器单例任务表（两层存储分工见 §3.5）、exit 感知（D17）、bash_output/bash_kill、并发上限、进程退出收殓（遍历单例表 + registry 终态）、subagent 环境降级分支（D14，探针 P5） | 功能主体，不依赖通知即可独立工作（轮询查询可用） | S2 S7 S9 S10 + S1 的①②（模型显式 background:true 即可验 task_id 即时返回；⑤ 的 D13 变体依赖 M4 白名单，归 S4/M4 验） |
| M3 通知接入与接管 | pending-notifications lifecycle 分档泛化（type 注册 + 五处行为分档，见 §3.5 接入细则；`PendingEntry.expiresAt` 类型连带改 `number \| undefined`——跨包 public API，goal/subagent-workflow 直接 import，同步核对消费方）+ 本包 emit register/unregister + sendMessage steer（探针 P3）+ 模块级轮询器的 pi 引用刷新与 session 替换接管（探针 P6）+ session_start 对账（appendEntry 权威路径） | 依赖 M2 的 registry 结构；对 infrastructure 包的分档泛化需独立评审；接管机制是 D12 在 extension 层成立的必要条件 | S1 的 ③④ + S8 场景 A（含对账断言）+ S6 桌面全流程 + 探针 P3/P6 |
| M4 配置体系 | llm-shared 范式配置读写、normalize、两组白名单矩阵与 timeout 注入逻辑（§3.5）、热重载 | 纯增量策略层，接口稳定后可并行开发 | S3 S4 |
| M5 孤儿 reap | 注册表持久化完善、reaper 扫全目录 + 属主判定（ownerPiPid 死活，防桌面并行进程误杀）+ file-lock 串行化、start-time 防误判、orphaned 终态写入（供 M3 对账消费） | 兜底机制，依赖 M2 的 registry 结构定稿；扫全目录防御「subagent 降级（D14）未落地的中间态」遗留的子进程 registry 残留 | S5 + S8 场景 B（属主判定防误杀）+ 探针 P4 |
| M6 unified-hooks 废弃 | package deprecate、AGENTS.md/mandatory 相关文档清理、fixture 脚本弱引用清理、README 归档注记；确认 tool-error-handler 审计行为已由新包承接后才摘除旧包 | 必须最后做（M4 白名单上线后才可摘除旧拦截） | S4 |

待验证检查点（进入 M1 前允许未知，M1 期内必须关闭）：P1–P6。

## 附：本次分析的关键事实源

- pi 实装版：node_modules/@earendil-works/pi-coding-agent/dist/{core/tools/bash.js, core/extensions/types.d.ts, modes/rpc/rpc-mode.js, index.d.ts}
- unified-hooks：已删除（2026-09，ext-simplify-01），原 timeout-guard 源码 `git log --follow` 可查
- pending-notifications：extensions/universal/pending-notifications/src/{index,state}.ts
- goal continuation 守卫（差集消费方）：extensions/universal/goal/src/adapters/event-handlers/agent-end.ts
- 通知先例：extensions/universal/subagent-workflow/src/execution/notifier.ts
- 收殓先例：extensions/universal/subagent-workflow/src/execution/worktree-manager.ts
- 桌面耦合：packages/runtime/src/infra/pi/{rpc-client,process-manager}.ts、packages/core/src/domain/chat/{truncate-tool-output,timers}.ts、packages/shared/src/pi-preset.ts
