# 文件锁统一（SSOT）与后台任务收殓下沉 runtime 设计

| | |
|---|---|
| 状态 | 已审查（4 轮对抗循环收敛：4M+8S → 1M+4S+2I → 1M+1S → 1I → 0，设计就绪）；实施后一致性审查回写（2026-09-02：三区 28R/2U-low/10D，DE1-DE3/D5/D-ERR-2 等文档修正已落本文，实现侧 2U 与注释级 D1-D4 已修复批次处置） |
| 层性质 | 技术方案层（下一层产物：可实施的代码任务，见 §5 三批次拆分） |
| 关联 | 根因调查全文见对话记录；受控复现方法已验证（本文 §4 S1 直接复用） |

## 1. 背景目标

**一句话结论**：把「extension 侧 proper-lockfile 锁在 pi/jiti 环境下崩溃杀死 pi 进程」这一事故，从三个结构性根源上修复——锁原语统一为单一自实现（SSOT）、后台任务收殓职责从 extension 下沉到 runtime、extension 对 pi 运行环境的隐式坑建立显式防线，并把本次排障暴露的观测黑洞补上。

**SCQA**：
- S（情境）：xyz-agent 通过 pi binary spawn 子进程承载会话，20 个 `@zhushanwen/pi-*` extension 经 pi 的 jiti loader 加载；extension 与 runtime 两侧各自封装 proper-lockfile 做跨进程文件锁。
- C（冲突）：2026-09-01 实证：冷启动后首次点击 session，pi 进程必崩（exit 1），用户看到「切换会话失败」；重试成功。根因是 jiti 2.7.0 对嵌套 CJS 依赖 exports 的 Proxy 值缓存违反 ES invariant——同模块图内第二次 proper-lockfile 异步锁必抛 TypeError 且进程级崩溃；触发面是 base-tool-enhance 的 reaper 在 pi factory 二次调用（extension 按 cwd 缓存命中时重复调用、handler 累积注册）下于同一 session_start 事件双跑。
- Q（问题）：如何让这类「extension 运行环境 × 基础设施依赖」的组合缺陷不再发生，而不是只修这一次的症状？
- A（答案）：三批次——①锁原语自实现统一（天然免疫 jiti，替代「继续用 proper-lockfile + 绕过」）；②reaper 收殓下沉 runtime（触发面从结构上消失，职责归位）；③pi 环境守卫骨架 + 观测补齐（防线显式化，下次可观测）。

**系统认知**（受众：会用 xyz-agent 但不了解 extension 体系的开发者）：

- extension 是跑在 **pi 子进程内**的 TS 模块，由 pi 内置的 **jiti loader** 加载（不是 Node/Bun 原生 import）。jiti 会对嵌套 CJS 依赖的 `module.exports` 做带值缓存的 Proxy 包装——这是本次事故的引擎层诱因。
- pi 的 extension 缓存按 cwd 失效：session 替换（switch_session）时 cwd 不变则 **factory 被二次调用且 handler 累积注册**——`session_start` 事件的 handler 真实语义是「每 session × factory 调用次数」，不是「每 session 一次」。
- 跨进程文件锁现状：锁实体是磁盘目录 `<目标文件>.lock`（mkdir=拿锁 / rmdir=释放 / stat mtime>stale=可夺取），**两侧都是 proper-lockfile 封装**——runtime `packages/runtime/src/utils/file-lock.ts`（auth.json/providers.json/settings.json 写锁）与 extension `extensions/shared/file-lock`（registry/ext-config 写锁），靠注释与 parity 测试对齐参数。runtime 侧还与 **pi 内嵌的** proper-lockfile（auth.json）互斥同一把锁。
- 后台 bash 任务收殓现状：base-tool-enhance 在每个 pi 的 session_start 跑 reaper——**全局扫描** `<agentDir>/base-tool-enhance/<任意sessionId>/registry.json`，处置属主已死的孤儿任务，用全局 `reaper.lock` 串行。

**目标**（从使用者体验倒推）：

- G1（用户可见故障归零）：冷启动后首次点击任意 session，100% 成功进入会话，不再出现「切换会话失败：pi process exited with code 1」。
- G2（职责正确）：孤儿后台任务的收殓由 pi 生命周期的所有者（runtime）执行，extension 不再做全局扫描/全局锁；有孤儿时收殓仍然发生（功能不回归）。
- G3（防线显式）：pi 的 factory 二调坑有统一守卫；受影响的 session_start handler 全部接入，双跑不再可能。
- G4（可观测）：pi 进程异常退出时，完整 stderr 与 extension 日志默认落盘可查——本次排障依赖的 20 轮受控实验，下次应是一轮 grep。

**In scope**：上述四目标的代码与测试改动；锁协议兼容性（与 pi 内嵌版互斥）；过渡期新旧 extension 共存。**Out of scope**：不改 pi 源码/不提 PR（项目铁律）；不修 jiti（上游）；不处理 subagent relay 链路的锁（未受影响，见 §3.3 D1 备注）；不重做 extension-logger 的日志库选型。

## 2. 现状与问题分析

### 2.1 崩溃链路（实证复盘）

冷启动首点 session 的完整事件序列（2026-09-01 12:22 真实日志 + 13 轮受控实验逐环验证）：

```
用户点击 session ──→ runtime session.switch ──→ ensureActive ──→ spawn pi（cwd=目标 session cwd）
pi 启动：jiti 加载 19 extension（factory #1，注册 session_start handler ×1）
       ──→ 初始 session 建立触发 session_start(startup)
              └→ base-tool-enhance 维护链跑 reaper：全局 reaper.lock 获取成功
                 （proper-lockfile probe 第 1 次：fs[cacheSymbol] 读入 jiti 值缓存=undefined，
                  defineProperty('ms') 写到 Proxy target）
runtime 发 switch_session ──→ pi 重建 session（cwd 未变）
       ──→ pi extension 缓存命中：factory #2 二次调用，handler 累积注册（session_start handler ×2）
       ──→ session_start(resume) 事件 → 两组 handler 各跑一次 reaper
              └→ 第 2 把 reaper.lock 获取 → probe 第 2 次读 fs[cacheSymbol]
                 jiti Proxy get trap 返回缓存旧值 undefined ≠ target 'ms'
                 ──→ 引擎按 ES Proxy invariant 抛 TypeError（进程级，catch 不可拦）
pi exit(1) ──→ restore 失败 ──→ 前端 toast「切换会话失败：…code 1」
```

**为什么重试成功**（实验 A/B 对照实证）：崩溃在第 2 把锁的 mkdir 成功之后，`reaper.lock` 目录残留为 fresh（<30s）；重试 spawn 的全部 reaper 锁因此 ELOCKED 排队——拿不到锁就不执行 probe，无人触发第二次读，不崩。锁残留超过 30s stale 化后，下次冷启动再崩——这解释了 prod 历史日志中 6 次零散同类崩溃。

### 2.2 三个结构性问题（根因，非症状）

**P1 锁原语双份封装、靠参数对齐**。两侧都是 proper-lockfile 封装，互斥语义靠「lockfile 路径/realpath:false/stale 30s 参数一致 + parity 测试」维持。任何一侧环境差异（本次是 jiti）只在一侧爆。更本质：锁是正确性敏感的跨进程互操作原语，协议极简（mkdir/rmdir/stat/utimes 四个 fs 调用），却引入了对第三方内部行为（probe 的 symbol 缓存）的依赖——第三方假设标准 Node 模块语义，而 extension 实际跑在 jiti 里。

**P2 收殓职责放错层**。孤儿任务收殓是「数据目录所有者」职责（宿主级、全局），现状却是每个 pi 进程在 session_start 全局扫描所有 session 的 registry + 全局锁串行。后果：任意 session 启动都在处置别的 session 的遗留（职责越界）；全局 reaper.lock 成为崩溃触发点；锁的 fresh/stale 磁盘状态成为「崩或不崩」的隐藏状态机；一个维护性兜底任务的故障杀死宿主 pi 进程（连带用户活跃会话）。对照：runtime 已有 `reapOrphanPiProcesses`（启动收殓孤儿 pi）——「收殓」职责本就在 runtime 有先例。

**P3 extension 裸奔在 pi 的隐式契约上**。factory 二调 + handler 累积意味着 handler 必须自证幂等，但没有任何机制提示或守护。实测 12:22 崩溃 pi 的 stdout 里 scheduler/todo 的 UI request 打了 4 组——双跑痕迹不止 reaper 一处。当前 **11 个**活跃 extension 注册了 session_start handler（ask-user / system-prompt-trace / pending-notifications / cache-probe / permission / goal / plan / subagent-workflow / smart-context / **todo**（`handlers.ts:133`）/ base-tool-enhance），幂等性从未被系统性排查。

**P4（观测）排障黑洞**。extension-logger 默认 no-op（仅 `XYZ_AGENT_DEBUG=1` 落盘）；pi 崩溃时 runtime 只保留 stderr 尾部数行。本次根因定位依赖 13 轮受控实验 + relay append 模式侥幸留存的现场，成本极高。

### 2.3 目标态数据流（§3 方案的物理视图）

```
现状：每个 pi session_start ──全局锁──> 扫描全部 session registry ──> 处置孤儿 ──(可能崩掉 pi)

目标态（双触发面）：
  A. 生命周期收殓（精确时点）：runtime 在 onSessionDestroyed 汇聚点（覆盖主动删/进程退出/
     forceQuit/restore 清场）──> 读该 session registry ──> active × ownerPiPid 已死
     ──> kill 任务 pid（start-time 防复用）──> 写终态 orphaned（统一锁）。fire-and-forget，
     不阻塞销毁收敛链。
  B. 启动期全量兜底扫描：runtime 启动后台序列（startup-background-init，与孤儿 pi 收殓
     reapOrphanPiProcesses 同序列）扫 <agentDir>/base-tool-enhance/<sessionId>/registry.json
     全量（目录布局同 U2-1 契约）──> 同上处置。
     **硬序约束：B 必须在 reapOrphanPiProcesses 完成后执行**（孤儿 pi 收殓挂 +5s 独立定时器，
     串行链 t≈0-2s 先跑——若扫描先行，扫描时遗留 pi 尚活被三分支①跳过，+5s 被杀后其
     detached 任务才孤儿化且此后无事件触达，漏收一个 app 周期）。实现形态：链式 await 其
     结果，或并入同一定时器先 reap pi 再扫 registry。硬序只约束先后、不传递成败——pi 收殓
     失败时扫描仍执行（B 处置 registry 遗留，与 pi 收殓成败解耦；一致性审查固化该语义）。
     兜底 A 覆盖不到的三类：上次运行崩溃/SIGKILL 遗留孤儿（本次运行无销毁事件）、
     启动期孤儿 pi 收殓所杀 pi 的 detached 后台任务（不在 SessionService Map，依赖上述硬序）、
     从未激活即被删的 session。
  extension（pi 内）：只写自己 session 的 registry（spawn/exit 后台任务时，统一锁 sync 版）
```

## 3. 解决方案

### 3.1 终态（使用者视角）

- **用户**：冷启动后首点 session 直接进入会话；任何时刻切换 session 不再出现「切换会话失败：pi process exited with code 1」。强杀一个正在跑后台 bash 任务的 pi（forceQuit）后重启 app，该任务在 registry 中显示 orphaned 终态、对应进程已被回收，无需任何手动操作。
- **extension 开发者**：注册 session_start 维护类 handler 时，从 `@zhushanwen/pi-ext-guards` 引入 `oncePerProcess` 包装；写共享文件时从 `@zhushanwen/pi-file-lock` 引入 withFileLock/withFileLockSync——API 与今天完全一致，内部已是自实现，jiti/Node 双环境行为一致。
- **runtime 开发者**：收殓逻辑在 `packages/runtime` 内（Node 环境），pi 崩溃时完整 stderr 落盘在 `<dataDir>/logs/pi-crash-<date>-<sid>.log`，extension 日志默认在 `<agentDir>/logs/` 可查。
- **失败路径与恢复指引**：锁获取失败（ELOCKED 预算耗尽）抛带恢复指引的错误（维持现状语义：「稍后重试本次写入」）；runtime 收殓遇 registry 损坏 → `.corrupt` 隔离 + 空表重建（移植 reaper 现有防御）+ warn 日志，不阻塞；收殓自身任何异常 warn 后跳过该条目，下个事件重试（幂等）。

### 3.2 方案对比

**D1 锁原语统一**

| 方案 | 长期架构合理性 | 短期成本 | 风险 |
|---|---|---|---|
| A（推荐）自实现替换：重写 `@zhushanwen/pi-file-lock` 内部为自实现 mkdir-lock（API 不变），runtime `utils/file-lock.ts` 改为复用该包（tsup noExternal 替换） | 单一源码，协议演化单点；不依赖第三方内部行为；只用 fs 函数调用、**天然免疫 jiti 类模块系统包装** | 中（~120 行自实现 + 测试移植，协议已在本调查中逐行核实） | 自实现正确性——缓解：协议极简（4 个 fs 调用）、与 pi 内嵌版互斥有专项验收（S3）、parity 测试保留升级 |
| B 保留 proper-lockfile + `options.fs` 传浅拷贝对象（原止血方案） | 双份封装与参数对齐仍在；防御点依赖「第三方只用 probe 这一处 symbol」的假设 | 低 | 第三方升级引入新的模块对象操作即复发；治标 |
| C 各自自实现、维持两份（仅替换库） | 仍是参数对齐双轨——本次事故的制度性根源未除 | 中 | 同今天 |

A 的关键约束（不是自由设计）：
- **磁盘协议必须与 pi 内嵌 proper-lockfile 逐字段兼容**（auth.json 锁互斥）——即照抄其协议：`<目标>.lock` mkdir 目录 / rmdir 释放 / stat mtime>stale 判死夺取（夺取 = 先 rmdir 再 mkdir，接受竞态窗口，与 proper-lockfile 语义一致）/ utimes touch 仅在临界区超 stale/2 时才需要（现有契约临界区毫秒级，不做周期 touch，文档声明该边界）/ **graceful exit 兜底 rmdir**（对齐 proper-lockfile 的 signal-exit 清理，一行 `process.on('exit')` 配对，避免优雅退出后依赖 30s stale 兜底。边界声明（一致性审查 D1/D2 补）：①'exit' hook 覆盖正常退出/process.exit，信号默认终止（SIGINT/SIGTERM 无 handler）场景 proper-lockfile 的 signal-exit 额外覆盖而 'exit' 不触发，锁残留回退 30s stale 夺取（同 SIGKILL 路径）；②本方持锁被对端 stale 夺取后，本方 release/exit-hook 的 rmdir 会删除夺取者新建的锁目录（proper-lockfile 同场景由 updateLock 发现而拒绝 unlock，自实现无保活故无此防线）——触发前提为临界区违约超 stale 30s（契约要求毫秒级），风险接受；③proper-lockfile 的 mtime-precision probe 随保活一并移除——probe 不属磁盘协议四操作，其唯一消费方保活定时器已被本设计显式移除，顺带消除了事故根因触发面）。**三方互斥等价性**：同锁文件的参与方为 runtime 自实现、extension 自实现（jiti）、pi 内嵌 proper-lockfile——前两者同源 lock-core（同包双子入口），协议按构造一致，**唯一跨实现互斥对 = 自实现 × proper-lockfile**，S3 两方探针即穷尽；批 1 原子切换两侧（同时发版）排除混协议窗口。
- **路径规范化统一 `realpath: false`**：与 pi auth-storage 及 extension 包现状一致；runtime async 锁现状是默认 realpath:true（历史偏差），切换属纠正——行为变化仅影响 symlink 目标路径的锁路径解析，锁目标路径（auth.json 在 `getPiAgentDir()`、settings/ext-config 在 `getDataDir()` 派生目录）均动态推导、无 symlink 场景，影响面声明为零；symlink 目标不在锁契约内。探针基线锁定 proper-lockfile 4.1.2（与 pi 依赖一致，pi package.json 核实）。
- **锁原语源文件零依赖**：`lock-core.ts` 不 import extension-logger（其依赖链携带 pi SDK peerDep，会经 runtime re-export 穿越 pi 边界）；诊断日志改为可选注入（`opts.log?: (msg) => void`，extension 入口注入 logger，runtime 不注入）。
- **包导出双子入口**：`@zhushanwen/pi-file-lock`（extension 用，现 API 含 logger 依赖）与 `@zhushanwen/pi-file-lock/core`（零依赖锁原语，runtime 用，package.json `exports` 声明子路径）。
被否 B 的教训回放：若用它，§2.1 链路中 probe 缓存问题消失，但 P1 双轨仍在，下一个 jiti×第三方组合缺陷仍要 13 轮实验定位。

**D2 收殓下沉 runtime（双触发面）**

| 方案 | 长期架构合理性 | 短期成本 | 风险 |
|---|---|---|---|
| A（推荐）双触发面：① 生命周期收殓挂 runtime `onSessionDestroyed` 汇聚点（汇聚点本体 session-service.ts removeSessionEntry，覆盖主动删/进程退出/forceQuit/restore 清场，见 §5 U2-2 DE2 澄清），fire-and-forget 不阻塞销毁收敛链；② 启动期全量兜底扫描挂 startup-background-init 后台序列（与 reapOrphanPiProcesses 同序列，**硬序在其完成后执行**，时序论证见 §2.3）——旧 reaper 全局扫描的三类兜底对象（跨运行遗留孤儿、启动期被收殓 pi 的 detached 任务、从未激活即删的 session）由此等价承接。extension 删 session_start reaper（reconcile 对账保留，见 D3） | 收殓发生在「该 session 的 pi 确认死亡」的精确时点；跨运行遗留有启动期等价兜底；extension 不再做运行期全局扫描/全局锁；registry 契约入 `@xyz-agent/extension-protocol`（跨层契约 SSOT 有 session-manager 先例） | 中（~180 行：判定逻辑移植自 reaper.ts 三分支 + 契约定义 + 双挂点接线） | 扫描成本（启动期一次 readdir + 逐 registry 读取，毫秒级×session 数，fire-and-forget）；新旧共存见 §3.3 过渡窗口 |
| B extension 侧保留 reaper 仅加幂等守卫 | 职责仍错层，全局锁/全局扫描仍在；触发面靠 D1 兜底而非消失 | 低 | 治标 |
| B' 仅生命周期收殓、无启动期兜底（Round 0 原案） | 跨运行遗留孤儿永久无人收殓——G2「有孤儿时收殓仍然发生」因果链断裂（旧 reaper 立项场景「SIGKILL 后 detached 任务被 init 收养」静默丢失） | 低 | 功能回归 |
| C 收殓挂 Electron main | pi 生命周期所有者是 runtime，跨层绕路 | 高 | 引入新链路故障面 |

**D3 幂等守卫与影响面**

| 方案 | 长期架构合理性 | 短期成本 | 风险 |
|---|---|---|---|
| A（推荐）批次 1 先内联止血（flag 仅包 reapOrphanedTasks，见下），批次 3 新建 `@zhushanwen/pi-ext-guards`（`oncePerProcess(key, fn)` 高阶函数 ~15 行）替换内联，并按判定准则排查其余 10 个 session_start extension 接入 | pi 环境坑（factory 二调/未来 jiti 类）的防线集中一处；业务 extension 假设标准语义 | 低 | 新包粒度——缓解：包只做「pi 运行环境守卫」一个职责，命名即边界 |
| B 全量直接建包接入，不做批次 1 内联 | 同 A 终态 | 高（止血被拉长） | 崩溃多暴露一个发版周期 |
| C 各 extension 各自内联不建包 | 防线分散，准则漂移 | 低 | 下一个 extension 作者无从知晓 |

**守卫粒度（Round 1 修正）**：flag/oncePerProcess 只包**跨 session 副作用的操作**（reapOrphanedTasks——进程级全局维护，正确频率就是每进程至多一次）。**reconcilePendingEntries 是 session 级操作**（读当前 session 的 pi entries + 当前 session 的 registry，appendEntry 幂等），按判定准则属豁免类，**保持每 session_start 执行、不挂 flag**——桌面端每次激活是 startup+resume 双 session_start，若整体挂进程级 flag，startup 消费 flag 后目标 session 的对账将永远被跳过（M3 对账在主链路被禁用）。reconcile 全同步、不持锁、无 jiti 风险面。需要「每 session 一次」语义的 handler 属另一设计，本设计不提供（避免 clever 机制，出现真实需求再设计）。

判定准则（批次 3 排查用）：handler 体内存在**任一**跨 session 副作用即必须接入——写非本 session 的文件、注册定时器/watcher、扫描目录、进程操作；纯内存初始化（如 permission 的 footer renderer 注册，registry.register 同 id 覆盖）天然幂等可豁免，豁免结论须在排查清单中逐条留痕。

**D4 可观测性**

| 项 | 推荐 | 被否 |
|---|---|---|
| extension 日志落盘 | **xyz 托管环境默认落盘**：新环境变量 `XYZ_AGENT_EXT_LOG=1` 由 runtime spawn pi 时注入（buildOutboundChildEnv extras），extension-logger 见此变量即落盘 INFO 级（DEBUG 全量仍由 XYZ_AGENT_DEBUG 控制）+ 7 天清理。量级：INFO 级事件（session_start/命令/错误）每 session 数十条 × ~200B ≈ 单位数 KB/session。**universal 包独立 pi 用户默认行为不变**（未注入变量 = no-op，零磁盘/行为影响） | 维持 debug-only（P4 黑洞教训）；无条件默认落盘（改变 universal 包独立用户开箱行为，19 extension × appendFileSync 叠加不可控） |
| pi 崩溃 stderr | rpc-client exit handler：异常退出（code≠0 且非主动 kill）时将累计 stderr 全量写 `<logsDir>/pi-crash-<date>-<sid>.log`（logger.ts 新增 helper，复用 pi-*.jsonl 命名惯例）；正常退出不写 | 维持尾部 N 行 ring buffer（本次崩溃现场只剩 2 行，TypeError 之上的输出全部丢失） |

### 3.3 关键决策与权衡（探针标注）

- **D1-A 自实现协议正确性**：mkdir 是 POSIX 原子操作 ✅已测（本次调查第 13 轮通读 proper-lockfile acquireLock 全流程并复刻实验验证）；stale 夺取竞态窗口（两个进程同时判死同时夺取）与 proper-lockfile 现状等同，不引入新风险 ✅已测（协议逐行比对）。**实施期门**：S3 互斥探针不过则 D1 不算完成。
- **D2-A 挂点选择**：onSessionDestroyed 是既有「单一清理入口」（D6a 设计），且经代码核实覆盖比三路径更多——forceQuit 经 message-dispatcher 手动编排显式调 removeSessionEntry（kill 路径的 exit 事件被双层守卫拦截不走 onSessionExit）✅已测。不挂 pm.onSessionExit 的原因：后者只覆盖进程退出，主动 delete/forceQuit 同样遗留孤儿任务。执行形态：**fire-and-forget**（void + catch warn；实现为入口 async + setImmediate 延后一拍执行同步核心——removeSessionEntry 是同步销毁收敛链，spawnSync `ps`（单条 5s 超时）与同步锁 busy-wait 不占当拍，构造性不阻塞），收殓不得阻塞销毁收敛链（旧设计 fire-and-forget 的理由同样适用）。
- **D2 registry 契约归属**：放 `@xyz-agent/extension-protocol` 而非新包——runtime 已依赖该包（tsup noExternal 已收录）✅已测，extension 侧 base-tool-enhance 增加对其的依赖（dev workspace + 发布 dependencies，形态同 session-manager 对接先例）。
- **D3 守卫语义**：`oncePerProcess` 按进程去重（模块级 Map），只用于跨 session 副作用操作（见 D3 粒度段）；需要「每 session 一次」的 handler 属另一语义，本设计不提供（避免 clever 机制，出现真实需求再设计）。
- **D1 备注（排除项）**：subagent relay 链路（zsw）不经 jiti 加载且无 proper-lockfile async 锁使用，不在受影响面；本次调查已 grep 全量 extensions 确认 async 锁调用仅 reaper 一处 ✅已测。
- **D2 过渡窗口（Round 1 重写，Round 2 限定范围）**：用户机器上 **npm 全局层**旧装残留**不会进入 pi 加载**——xyz spawn pi 用 `--no-extensions` 抑制全局发现（rpc-client.ts）+ extension 全部显式 `--extension` 注入（builtin staged / 项目级路径；数量以 mandatory-extensions.json SSOT 为准——写作时 19、当前 17，S1 脚本按 staged 实际枚举不硬编码），12:22 真实 spawn 命令核实无 npm 全局安装层路径 ✅已测。因此不存在「新旧同图双跑」；旧 reaper 的崩溃机制（其代码自带）也无加载机会。**残余通道如实声明**：`--approve` 会信任项目级 `.pi/extensions`——若用户手动在项目层放置同名 base-tool-enhance 旧拷贝仍可进入加载（已知暴露面，pi 侧 TODO 承认），概率极低但非零；S5 含此检查项。（`--no-extensions` 抑制全局发现的佐证在 rpc-client.ts——一致性审查后行号随波次插行漂移，改文件级引用。）**残留处置**：随升级 release note 给卸载指引（`pi uninstall npm:@zhushanwen/pi-base-tool-enhance`，参照 unified-hooks 废弃先例——pi 0.84.4 实装无 `extension uninstall` 子命令，一致性审查 DE1 核实修正），防旧包与新包在**裸 pi 使用场景**（用户脱离 xyz 独立装过）双重注册 bash 拦截。
- **锁残留清理**：D2 落地后 `reaper.lock` 不再产生；启动期兜底扫描顺带 rmdir stale 残留目录，不单独做迁移脚本。

## 4. 验收（真实场景，非单测）

> 复现基线：以下 S1 使用本次调查验证过的受控复现命令（cwd=目标 session cwd 的完整 staged extension spawn + switch_session，数量以 mandatory-extensions.json SSOT 为准——写作时 19、当前 17，脚本化后按 staged 实际枚举不硬编码；崩溃栈与线上逐字一致）。修复前该命令必崩——这是所有验收的可信前提。

| # | 场景（回溯目标） | 步骤 | 通过标准 |
|---|---|---|---|
| S1（G1） | 受控复现归零 | 冷（reaper.lock stale/不存在）环境下跑受控复现命令 ×10，每次全新 agentDir 副本 | 10/10 exit=0、switch_session response success、stderr 无 TypeError |
| S2（G1） | 真实用户路径 | dev app（pnpm dev）冷启动，首点 cwd=Stock 的 session（12:22 原始场景） | 直接进入会话，无 toast；runtime 日志无 auto-restore failed |
| S3（G1/P1） | 锁互操作兼容 | 探针脚本：runtime 侧（Node，新自实现锁）与 pi 内嵌 proper-lockfile 并发对同一测试文件各循环 100 次 lock→write→unlock | 双方全部成功获取（等待互斥），最终文件内容无交错损坏；ELOCKED 等待期间无数据竞争 |
| S4a（G2） | 生命周期收殓不回归 | dev app 中让 session 跑一个 background bash 任务（sleep 300）→ forceQuit 该 pi → 观察 runtime | 孤儿 bash 进程被 kill（ps 核实）；registry 该条目转 orphaned 终态；runtime 日志有收殓记录；销毁收敛链未被阻塞（session 列表即时更新） |
| S4b（G2） | 跨运行遗留兜底（B-only 构造） | 让 session 跑 background bash 任务（sleep 300）后，**直接 `kill -9 <pi pid>`（不经 forceQuit，绕开 A 腿）并立即 SIGKILL 整个 app**（SIGKILL 下 A 腿无执行机会）→ 重启 dev app，等待启动后台序列（含孤儿 pi 收殓 + B 扫描硬序）完成。**硬序验证变体（确定性孤儿化）**：新 session 跑后台任务后 `SIGSTOP <pi pid>` 再 SIGKILL app——SIGTERM 无法投递给 stopped 进程，2s 宽限后必走 SIGKILL（绕开 pi 优雅退出 → D12 exit-guard 收殓 → 无孤儿产生的两条分支） | B 日志在场（启动期扫描收殓记录）；孤儿任务进程被 kill、registry 转终态；**硬序变体**：重启后 detached 任务确定性地由 B 收殓（orphaned 终态由 B 写、B 日志在场）——该变体是 §2.3 硬序约束的唯一真验证场景，不得以「任务已死」替代（可能是 D12 收的） |
| S5（G1） | 旧 npm 残留不混入 | 升级后的 builtin 环境（机器保留 npm 旧装残留）启动 dev app，检查 runtime 日志的 pi spawn 命令与 extension-resolver resolved 列表 | 加载列表全部来自 builtin staged/项目级路径，无 npm 全局安装层路径；项目层 `.pi/extensions` 无同名 base-tool-enhance 旧拷贝混入；release note 文档含旧包卸载指引 |
| S6（G3） | factory 二调下维护链单跑 | 目标 session **预埋一条僵尸 pending:register**（registry 存一条 running 终态可判条目 + pi entries 含对应未抵消 register；**id 必须带 `bt-` 前缀**——`collectUnsettledTaskIds` 只认 `BTE_TASK_ID_PREFIX`，非 bt- 前缀会被差集忽略致预埋失效）。用本次调查的探针方法（观测 factory 调用与 handler 派发；实施形态 = bte dispatch 日志 + S1 复现脚本，见 §5 U3-2 实施修正旁注）跑 switch；观测通道 = `XYZ_AGENT_DEBUG=1` 的 extension 日志（U1-4 在 runSessionStartMaintenance 入口加无条件 debug 日志） | factory 调用 ×2、resume 的 handler 派发 ×2（探针可测）；**效果导向断言**：僵尸的 `pending:unregister` entry 恰好追加一次、无重复条目；维护链入口日志按 handler 派发次数出现、reap 类跨 session 操作只在首个派发执行（批 1）/不再执行（批 2 后） |
| S7（G4） | 崩溃可观测 | 人为制造 pi 崩溃（注入一个必抛异常的临时 extension）→ 查数据目录 | `<logsDir>/pi-crash-*.log` 含完整 stderr；xyz 托管 pi 进程的 extension 日志文件存在且含该 extension 的 INFO 输出；未注入 XYZ_AGENT_EXT_LOG 的裸 pi 环境 extension 日志保持 no-op |

批次对应：批次 1 验收 = S1/S2/S3（+S6 的内联版）；批次 2 = S4a/S4b/S5；批次 3 = S6（守卫包版 + 逐 extension 探针验证点，实施形态见 §5 U3-2 实施修正旁注）/S7。每批独立可验收、可发版。

## 5. 下一层拆分

### 批次 1：锁统一 + 幂等止血（消除崩溃）

| 单元 | 内容 | 文件 | justification / 验收挂钩 |
|---|---|---|---|
| U1-1 锁自实现 | `@zhushanwen/pi-file-lock` 内部替换：新增**零依赖** `lock-core.ts`（mkdir-lock 核心 acquire/release/stale 夺取/graceful-exit rmdir 兜底 + 可选注入 `opts.log`）；async 退避重试（语义对齐现 proper-lockfile retries 参数：10 次 factor2 100ms~10s randomize）+ ELOCKED 错误码；**对外 API 签名与默认常量导出不变**；package.json `exports` 增 `./core` 子入口 | `extensions/shared/file-lock/src/lock-core.ts`（新）、`file-lock.ts`（重写内部，logger 改注入）、`package.json`（exports + 移除 proper-lockfile 依赖） | 移除 jiti 触发面（P1）；S1/S3 |
| U1-2 runtime 侧收敛 | runtime `utils/file-lock.ts` 删除本地实现，改从 `@zhushanwen/pi-file-lock/core` import（零依赖子入口，**不引入** extension-logger/pi SDK 链）；保留本地签名适配层避免调用方改动；tsup noExternal：`proper-lockfile` → `@zhushanwen/pi-file-lock`；runtime package.json 增 workspace 依赖（先例：@zhushanwen/subagent-core） | `packages/runtime/src/utils/file-lock.ts`、`packages/runtime/tsup.config.ts`、`packages/runtime/package.json` | 单一源码（P1）；S3 |
| U1-3 测试迁移与升级 | 现有 file-lock 测试套平移；parity 测试升级为「与 pi 内嵌 proper-lockfile 互斥」集成探针（S3 脚本入测试目录）；新增 jiti 环境冒烟（受控复现命令脚本化，CI 外本地门禁） | `extensions/shared/file-lock/src/__tests__/`、`packages/runtime/test/file-lock-parity.test.ts` | S1/S3 可重复执行 |
| U1-4 幂等止血 | base-tool-enhance `runSessionStartMaintenance` 内**仅对 reapOrphanedTasks** 加模块级 once flag（reconcile 保持每 session_start 执行，见 D3 粒度段）；**入口加一条无条件 debug 日志**（reason + reap 是否将被跳过，S6 的观测通道） | `extensions/universal/base-tool-enhance/src/index.ts` | resume 双发下 reaper 单跑；S6 内联版 |

### 批次 2：收殓下沉 runtime（触发面消失 + 职责归位）

| 单元 | 内容 | 文件 | justification / 验收挂钩 |
|---|---|---|---|
| U2-1 契约定义 | registry.json schema/目录布局/终态枚举/ownerPiPid 语义入 `@xyz-agent/extension-protocol`（新 section + zod/TS 类型） | `packages/extension-protocol/src/background-task.ts`（新）、index.ts 导出 | 跨层契约 SSOT（P2）；D2 决策 |
| U2-2 runtime 收殓器（双触发面） | 判定逻辑移植（reaper.ts 三分支 + isPidAlive/getProcessStartTimeSec/pid 复用防御，Node 环境实现）；**触发面 A**：onSessionDestroyed 汇聚点挂接，fire-and-forget（void + catch warn，含 spawnSync ps 5s 超时不阻塞销毁链）；**触发面 B**：startup-background-init 新增启动期全量扫描（扫 `<agentDir>/base-tool-enhance/*/registry.json`，**硬序：链式 await reapOrphanPiProcesses 完成后执行**，时序论证见 §2.3），顺带 rmdir stale reaper.lock 残留；写 registry 用统一锁 sync 版 | `packages/runtime/src/services/session/background-task-reaper.ts`（新）、`session-service.ts` 挂接（onSessionDestroyed 汇聚点本体 removeSessionEntry——transport/server.ts 为注册方而非汇聚点，DE2 澄清）、`startup-background-init.ts` 挂接（与孤儿 pi 收殓定时器的链式编排）、装配 | 职责归位 + 兜底等价承接（P2）；S4a/S4b |
| U2-3 extension 侧移除 | base-tool-enhance 删 reapOrphanedTasks 及其调用；**reconcilePendingEntries 保留每 session_start 执行**（session 级豁免类，见 D3）；删 reaper.ts；依赖改引 extension-protocol 类型 | `extensions/universal/base-tool-enhance/src/index.ts`、删 `reaper.ts`、package.json 增 `@xyz-agent/extension-protocol` 依赖 | 触发面消失（P2）；S4a/S4b/S6 |
| U2-4 文档同步 | base-tool-enhance 设计文档 §3.5 收殓章节标注下沉（历史沿革 + 新链路指引）；release note 段落：npm 旧装残留卸载指引（参照 unified-hooks 先例） | `docs/design/base-tool-enhance.md`（已随 2026-09 docs 清理删除，git 可追溯）、发布说明草稿 | 文档符号漂移守护（C-proc-10）；S5 |

### 批次 3：pi 环境守卫 + 观测补齐

| 单元 | 内容 | 文件 | justification / 验收挂钩 |
|---|---|---|---|
| U3-1 守卫包 | `@zhushanwen/pi-ext-guards`：`oncePerProcess(key, fn)`（结果缓存形态：同 key 重放首次结果/Promise 实例、fn 抛错不吞不释放 key）；~~U1-4 内联 flag 替换为守卫调用~~（实施修正：该 flag 随 U2-3 reaper 删除一并消失，bte 无跨 session 操作不接守卫；守卫包实际消费者 = u-audit-fix 判定的 permission / subagent-workflow） | `extensions/shared/ext-guards/`（新包）、base-tool-enhance index.ts（实施后无需改动） | 防线集中（P3）；S6 |
| U3-2 影响面排查 | 按 §3.2-D3 准则排查其余 **10 个** session_start extension（ask-user / system-prompt-trace / pending-notifications / cache-probe / permission / goal / plan / subagent-workflow / smart-context / todo），非幂等者接入守卫，豁免者清单留痕；**每个「必须接入」项给一个探针验证点**（S6 探针 extension 通用化：记录 handler 派发与目标操作执行次数）（实施修正：以 docs/design/pi-session-start-handler-idempotency-audit.md §2.5 的效果导向证据链替代——单测入口计数 + bte dispatch 日志 ×N + S1 复现脚本，通用化探针 extension 未建） | 10 个 extension 源文件 + 排查清单文档（附 PR） | P3 系统性收口；S6 逐项 |
| U3-3 extension 日志 xyz 托管默认落盘 | extension-logger 支持 `XYZ_AGENT_EXT_LOG=1`（INFO 落盘 + 7 天清理；未注入保持 no-op）；runtime spawn env 注入（buildOutboundChildEnv extras，env-propagation-boundary 出站契约） | `extensions/shared/extension-logger/src/index.ts`、`packages/runtime/src/infra/pi/rpc-client.ts`（env extras） | P4；S7（含裸 pi 环境 no-op 验证） |
| U3-4 pi 崩溃 stderr 落盘 | rpc-client 异常退出分支（code≠0 且非主动 kill）全量写 `pi-crash-<date>-<sid>.log`（logger.ts helper） | `packages/runtime/src/infra/pi/rpc-client.ts`、`infra/logger.ts` | P4；S7 |

**实施顺序依赖**：批次 1 独立先行（可单独发版消除用户可见故障）；批次 2 依赖 U1-1（统一锁）落地；批次 3 的 U3-1 依赖批次 1/2 完成后替换内联。批次 2/3 可并行。

**待验证检查点（实施期门，不猜）**：
1. S3 互斥探针的实际结果（自实现与 pi 内嵌版在 utimes 精度边界上是否有判定差异——macOS APFS ms 精度 ✅已测无差异预期，但需实跑）。
2. ~~forceQuit 路径触发时序~~ 已由 Round 1 审查从代码关闭：message-dispatcher.ts 手动编排显式调 removeSessionEntry，覆盖成立。
3. `@zhushanwen/pi-file-lock/core` 子入口在 **打包产物**（electron-builder）中的可达性——workspace 协议在发布链路的表现需 pnpm pack 验证（先例 subagent-core 已跑通，预期同路径，实施首日验证）。**降级路径**（若不可达）：lock-core.ts 源码以构建期拷贝方式同步进 packages/runtime（build script cp + 差异断言测试），退化为「同源双拷贝 + 机器对齐」，并在包头部注释登记此降级与回归条件。

---

### 写前自检（Step 6 摘要）

五段骨架齐备；每个决策 ≥2 方案且三栏评估+明确推荐；验收全部真实场景并回溯 G1-G4，含可重复执行的复现基线；运行时断言均带 ✅已测/实施期门标注；scope 限定技术方案层、下一层拆分到代码任务；错误路径带恢复指引；受众假设贯穿（jiti/factory 二调/锁协议均在使用者视角先铺背景）。
