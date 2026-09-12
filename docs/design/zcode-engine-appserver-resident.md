# zcode engine app-server 常驻化改造设计（core 侧）

> **2026-09 breaking 修订（用户拍板，`refactor-zcode-engine-shared-home` 分支落地）**：
> ① **删除 CLI spawn 降级链**——`XYZ_ZCODE_MODE` 钉扎、probe 冒烟门控（appserver-probe.ts）、
> protocol-drift 首败降级全部移除；launcher.ts / appserver-home.ts / appserver-probe.ts 整文件删除。
> 协议漂移不再降级保底，直接报可操作错误。本文 D2（降级链）章节随之**作废**。
> ② **删除 HOME 池化，共享宿主 HOME**——spawn env 不再覆写 HOME（db/plugins/MCP 继承
> 宿主 HOME，会话与 GUI 共写同一 SQLite，WAL 并发安全）；**凭据经 fs 拦截 launcher 注入**
> （appserver-launcher.ts 落盘 wrapper 进程：CLI 形态 app-server 只从 `~/.zcode/cli/config.json`
> 读凭据而 GUI 登录态落在 `~/.zcode/v2/config.json`，wrapper patch fs 把对前者的读取重定向为
> 「真实文件 + v2 provider 注入」内存合并，同 id 时 v2 整条优先——v2 是权威凭据源）。
> D7（常驻 HOME）章节随之**作废**。已接受代价：GUI 会话列表可见 headless 会话（**已由 2026-09
> 会话库隔离撤销**——写入面改落独立库后不再可见，见下方修订块）；登录态
> 轮换后常驻连接需引擎进程重启才用新凭据（凭据内容 hash 刷新机制删除）；zcode 升级
> schema migration 竞争无契约担保。新漂移面：zcode 升级若改变配置读取路径/方式，失败信号
> 为 missing baseURL / Model config is missing 明确报错（不静默坏）。收益：HOME 依赖副作用
> （pnpm store 随 HOME 翻转等）根治；锁/pidfile/孤儿回收/派生目录整章复杂度删除。poolKey
> 固定 `'shared'`（与 pi 引擎
> PI_POOL_KEY 同构，journal 落 `engines/zcode/shared/`）；handle.sessionRef.dbPath 为
> 绝对路径（隔离库 `<engineDataDir>/engines/zcode/session-db/db.sqlite`，`zcodeSessionDbPath()`
> SSOT；存量 record 的宿主库绝对路径由 `zcodeDbPathAllowlist()` 集合第二项兼容放行——见下方修订块）。
> 未作废章节（D1 连接/D3 abort/D4 会话自包含/D5 capabilities/D6 停机面）仍然有效。

> **2026-09 会话库隔离修订（承接 [zcode-session-db-isolation.md](zcode-session-db-isolation.md)，2026-09-09）**：
> spawn env **覆写** `ZCODE_SESSION_DB_PATH`（并清空别名键 `ZCODE_SESSION_DB`），subagent 会话落
> xyz-agent 引擎数据目录下的独立会话库 `<engineDataDir>/engines/zcode/session-db/db.sqlite`
> （路径单一来源 `zcodeSessionDbPath()`，选址在池目录之外），不再与 GUI 共写宿主引擎库——
> subagent 会话不再进 ZCode GUI 侧边栏。上方修订块中三处口径随之撤销/改写：「会话与 GUI 共写
> 同一 SQLite」「已接受代价：GUI 会话列表可见 headless 会话」「handle.dbPath 锚定宿主库
> `ZCODE_HOST_DB_SUFFIX`」。**HOME 保持共享**（凭据 / 插件 / MCP / pnpm store 语义零变化）、
> 凭据 fs 拦截注入、poolKey 恒 `'shared'`、常驻连接 / abort 链 / 会话自包含 / capabilities /
> 停机面全部不变。两条读取链按 `zcodeDbPathAllowlist(dataDir)` 白名单集合成员判定放行
> （隔离库 + 宿主库存量兼容锚点）。

> 层声明：当前层 = 技术方案设计；下一层 = 可实施代码单元（W1-W6，见 §5）。
> 决策依据：zsw 仓 `docs/design/zcode-engine-appserver-decision-record.md`（commit e70ca71，用户 2026-08-30 确认终态）。本设计是该决策记录的落地实施设计，方向/位置/接口不变性均以决策记录为准，不重新讨论。
> 状态：**设计就绪**。审查轨迹：r1（2026-08-30）3 must-fix + 4 suggestion + 1 doc_error → r2 复审 2 must-fix + 4 suggestion + 1 doc_error + 4 info → r3 终审 2 must-fix + 2 suggestion + 1 doc_error + 1 info，三轮全部逐条修复；r3 预登记「MF1/MF2 修完即设计就绪」，终批 6 条已同批修完（收敛轨迹 8→11→6，问题从机制级收敛到一句话级钉死）。

## §1 背景目标

**一句话结论**：core（`@zhushanwen/subagent-core`）的 zcode engine 从「spawn 单轮」升级为「app-server 常驻」，EnginePort 接口除新增一个可选 `dispose()`（引擎停机面）与 RunContext 一个可选回调 `onHandleReady`（运行中句柄回填通道，§3.4 不变量 3）外零改动——两处字段级扩展均已在本文登记，满足 port.ts 头注纪律；宿主（xyz-agent pi 壳 / zsw 壳）零改动获得引擎升级收益（收益边界：GUI live 逐字推送依赖 relay 通道另行建设，grace 兜底仅在宿主存活时生效——见 G2 与 D6①）；漂移防御内化到 core 的 probe + capabilities + conformance 体系。

**SCQA**：

- **S（现状）**：subagent-core 双宿主运行——xyz-agent（pi 壳，chat 域 + workflow 域）与 zsw CLI（zcode 壳，daemon 模式）。zcode 引擎现为 spawn 单轮：每任务起一个 `zcode.cjs --json --prompt` 进程，stdout 收一个终态 JSON，进程即起即灭。
- **C（冲突）**：zsw rebind（2c，commit 84b63a0）按当时首期范围退役了旧 app-server 常驻通道，让渡四项能力：长驻零冷启动、实时事件流、per-session model、热会话恢复。用户已于 2026-08-30 确认终态决策：app-server 常驻模式就是 zcode 执行通道的目标形态，实施位置锁定在 core zcode engine 的 launcher 层内部，宿主永不私连。
- **Q（问题）**：core 需要改哪些东西才能把 zcode 引擎换成 app-server 常驻形态，且不破坏 EnginePort 接口契约与现有 conformance 保障？
- **A（答案）**：一处接口层补充（`dispose()` 停机面）+ zcode 引擎目录 8 文件中 6 个实质重写（连接层/会话层/引擎编排）+ 测试面迁移；pi 引擎、公共降级层、宿主编排层全部不动。

**系统是什么**（给不熟悉 subagent-core 的读者）：`packages/subagent-core/` 是从 xyz-agent 抽出的引擎中立 subagent 执行核心，核心抽象是 EnginePort（6 成员接口：capabilities / probe / run / interact / read / listModels），现有 pi 与 zcode 两个引擎实现。任务经 `run(task, ctx)` 进入引擎，`ctx.onEvent` 回调流出 AgentEvent 流（8 种事件类型），AbortSignal 负责取消。zsw 壳把执行链整个委托给 core 的 zcode 引擎。

**设计目标**（从使用者体验倒推）：

| # | 目标 | 使用者视角 |
|---|------|-----------|
| G1 | 长驻进程 + 零冷启动 | zsw 用户跑 map-reduce 多任务，第 2 个起 subagent 启动耗时从 ~1.5s 降为 ~0 |
| G2 | 实时事件流（coarse→stream） | 引擎以 stream 粒度实时流出事件：zsw workflow 终端 live 输出实时刷新；xyz-agent 侧 journal 增量落盘且**运行中**的 record entry 即携带 ①②级读取钥匙（sessionRef/poolKey/journalPath，W4 回填机制——①级命中依赖 sessionRef），subagent 详情页中途打开可见当时进度快照、重开与 live 一致。GUI live 逐字推送（`subagent.stream_delta` WS 帧）依赖 relay 通道建设（`subagent-realtime-channel.md` 已论证 launcher 层模式可复制），**不属本设计**——chat 域 engine 任务的 onEvent 现只接 journal 落盘，无 GUI 广播通道（subagent-service.ts runEngineTask） |
| G3 | per-session model | 同一常驻进程上，任务 A 用 GLM-5.3、任务 B 用 mimo-v2.5，互不干扰 |
| G4 | 宿主零改动 | pi 壳与 zsw 壳不改一行代码、不发 breaking 版本即获得上述收益 |
| G5 | 漂移防御内化 | zcode 平台升级导致协议漂移时，core probe/golden/conformance 承接，宿主无感或按 capabilities 声明自适应 |

**in scope**：zcode engine 常驻化（连接层 + 会话层 + launcher 双模式）；EnginePort `dispose()` 停机面；abort 链从杀进程改 `session/stop`；capabilities 升级（仅 eventGranularity）；probe / golden 语料 / conformance 套件适配；spawn 降级路径保留（见 D2）。

**out of scope**：steer（运行中插话）——旧 app-server 实测 send-while-running 恒 `-32010` 硬错误，RPC 面无此能力，属引擎 turn-steer 面的后续升级项；conversation 热会话续聊 / 热会话 idle 复用 / `-32004` 四步恢复序——`EnginePort.interact` 生产代码零调用方，zsw 侧已登记 upstream gap，配套恢复序留 conversation 阶段；pi 引擎与其他引擎；GUI relay 实时通道建设（`subagent-realtime-channel.md` 已论证模式可复制，launcher 层加环境分支即可复用，不提前建设）；zsw 宿主与 pi 壳的任何改动。

## §2 现状与问题分析

### 2.1 现状：spawn 单轮链路

使用者视角的现状：zsw 用户执行 `zsw run --root <id>`，每个 subagent 任务：

1. core 按 provider+model 计算隔离池目录（`poolKey = home-<provider>-<model>`），在池目录写 `config.json`（模型 + 凭据）；
2. spawn `node <zcode.cjs> --json --cwd <dir> --mode yolo [--disallowed-tools ...] --prompt <全文>`，prompt 走 argv（128KB 预算上限，超限报 `prompt_too_large`）；
3. 进程跑完退出，stdout 是一个终态 JSON（sessionId / response / usage / projection）；
4. parser 合成两个 coarse 事件 `{message_end, turn_end}` 一次性 emit（zcode-engine.ts:385-386 不变量 5），任务结束。

四项让渡能力的现状（退役前后对照，来自 zsw 决策记录 §3 与退役代码）：

| 能力 | 旧 app-server 通道（已退役） | 现状 spawn 单轮 |
|------|------------------------------|----------------|
| 冷启动 | 常驻进程 + 驻留会话，`coldStartMs: 0` | `coldStartMs: 1500`，每任务一进程 |
| 事件粒度 | `session/event payload.delta` 实时文本流 | stdout 终态单 JSON，coarse 两事件 |
| per-session model | create 参数带 `model/thoughtLevel/toolAllowlist/toolDenylist` | argv 无白名单通道（`--allowed-tools` help 列出但解析器拒收） |
| 进程托管 | runtime 持有常驻进程，崩溃重建 | 每任务一进程退出即终（故障隔离反而更好） |

### 2.2 根因：不是 bug，是首期范围决策的既定让渡

spawn 单轮是 D-010（`.xyz-harness/subagent-engine-abstraction/decisions.md:29`，2026-08-25 confirmed）确认的首期范围：接口按六引擎全集设计（EnginePort 的 onEvent/AbortSignal 常驻友好，C3），zcode 首期只落 spawn。终态决策（e70ca71）改变了实施优先级：app-server 常驻化不再是 P3 远期项，而是当前要做的改造。**本设计不修改 EnginePort 接口语义**——接口层从设计之初就为常驻预留（port.ts:40-42 头注明证），这是「引擎内部升级」定位成立的前提。

### 2.3 代码盘点结论：接口零改断言的核实

对 `packages/subagent-core/` 全量盘点（2026-08-30，本分支 HEAD），「常驻化 = 纯引擎内部替换」的断言**除一处外全部成立**：

**已具备（不需要动）**：

- `RunContext.onEvent` 回调式事件流全程贯通：engine → journal 增量落盘（`event-journal.ts` append/flush 天然支持流式）→ workflow liveRecord → journal-replay 复用 live reducer。pi 引擎已是 stream 粒度，下游消费链路中 journal ②级读取（reload 路径）与 zsw workflow liveRecord 对 stream 事件无兼容问题；**xyz-agent GUI live 推送不在此列**——chat 域 engine 任务的 onEvent 只接 journal.append，无 stream 通道与 WS 广播（实时逐字依赖 relay 通道，另行设计）。
- AbortSignal 传递链完整（workflow 域 `mergeTimeoutSignal` / chat 域 record controller → `ctx.signal` → 引擎 abort listener）。
- `eventGranularity` 能力位**生产代码零消费方**（全仓 grep 证实；唯一 capabilities() 生产消费是 `assertEngineParamSupport`，只看 conversation/steer/sandbox）——coarse→stream 翻转对上层零影响。
- 隔离池/并发池/降级层（schema-emulation、kill-chain、persona-router）与进程形态解耦。

**接口层缺口（A 级，两处）**：

- **缺口一：常驻进程无停机面**。EnginePort 无 `dispose/shutdown` 方法。宿主唯一收割器 `killAllSpawnedChildren`（session-runner.ts:351-377）遍历 `spawnedChildren: Map<recordId, ChildProcess>`，**每 record 恰一个 child 的 set 覆盖语义**：共享常驻进程若按任务注册会被重复 SIGTERM，若不注册则 shutdown 后泄漏孤儿 app-server 进程。单任务 abort 若沿用 `proc.abort` → killChain 会**杀死共享进程殃及全部在途任务**。
- **缺口二：运行中句柄不可达（r2 审查发现）**。`record.engineHandle` 现状在 `await engine.run` resolve 后才回填（subagent-service.ts:1746），而 RunContext 现有回调面（onEvent / onPoolResolved / onChildSpawned，port.ts:43-92）没有任何通道能在 run resolve 前把引擎内部的 sessionRef 传给编排层——运行中 GUI 经 entry 重建 record 时 engineHandle 为 undefined，读取链恒落 ③级 outcome-only（subagent-engine-history.ts:122-129）。

**B 级（引擎目录内部）**：launcher.ts（唯一持有 spawn 权）、parser.ts（stdout 单 JSON 解析）、zcode-engine.ts（run 编排/abort/重试）、constants.ts、golden-sample.ts、registration.ts 需实质改动；preparer.ts（凭据/池）与 reader.ts（node:sqlite 三表 JOIN 读 SessionView，零进程依赖）基本不动。

### 2.4 物理数据流：现状 vs 目标

```
现状（spawn 单轮，每任务）：
task → prepare(按model写池HOME) → spawn zcode.cjs --prompt → [1.5s 冷启动+模型跑]
    → 进程退出 → stdout 单 JSON → parser 合成 {message_end, turn_end} → resolve

目标（app-server 常驻，进程跨任务共享）：
task ─┐
task ─┼→ engine.run → 共享连接(NDJSON stdio) → 常驻 zcode.cjs app-server
task ─┘                    │ ① session/create {workspace, mode, model, ...}
                           │ ② session/subscribe {sessionId, deliveryKind}
                           │ ③ session/send {sessionId, content} → {accepted:true}
                           │ ④ 推送流：session/event payload.delta → onEvent(text_delta)
                           │ ⑤ 终态：v4/telemetry/event kind=turn.terminal
                           │ ⑥ session/read 兜底取全文 → message_end/turn_end → resolve
                           │ ⑦ session/close（会话即用即毁，SQLite 保留）
引擎 dispose（宿主 shutdown 触发）：close 全部会话 → SIGTERM → grace → SIGKILL
```

关键差异：进程从「每任务一个」变「每引擎实例一个」；prompt 从 argv 变 RPC `content`（argv 128KB 预算限制随之解除）；事件从「终态后合成两个」变「运行中逐个流出」；abort 从「杀进程」变 `session/stop`。

## §3 解决方案

### 3.1 终态（使用者视角）

**成功路径（zsw 用户）**：`zsw run` 一个 map-reduce workflow（1 个主任务 + 3 个并行 subagent）。第一个任务触发常驻进程惰性启动（首任务仍含一次进程冷启动），三个 subagent 任务在同一条连接上各自 create 会话、并发 send、`turn.terminal` 判定终态、read 取全文、close 会话。`zsw status` 可见三条 record 的耗时中不再有每任务 ~1.5s 的进程启动段；record 留痕 `engineHandle.sessionRef.sessionId` 为 app-server 会话 id。

**成功路径（xyz-agent GUI 用户）**：chat 域发起 zcode 引擎 subagent，任务运行中途打开详情页——record entry 在 journal writer 创建后即已回填 ②级读取钥匙（W4 回填机制，create 应答后并入 sessionId），详情页可见打开时刻的进度快照（journal 已增量落盘的 text_delta）；任务进行中刷新/重开 session，详情页渲染与 live 所见一致（读取链 ①级 sqlite / ②级 journal 无论哪级命中，内容一致）。GUI 内的逐字实时推送属 relay 通道建设（out of scope，见 G2 边界）。

**失败路径 1（协议漂移）**：zcode 升级后 `session/create` 返回 `-32602`（参数校验失败）。引擎按错误分类归档 `protocol-drift`，本任务自动降级 spawn 单轮重跑（结果 record 标注 `degraded: spawn`），后续任务直接走 spawn。降级标志（`driftDegraded`）为引擎内存态且判定先于探针门控——CLI mtime 变化不触发重探，恢复 = 宿主进程重启后经探针门控重建（zsw daemon 常驻场景 = 需重启 daemon），core 修复协议适配后重启即恢复。用户在任务输出中看到降级标注与「升级冒烟失败，已回退 spawn 通道」提示。注意区分：探针失败降级（另一路径，probe 未过、无漂移命中）的探针结论为内存缓存、与 CLI mtime 绑定，mtime 变化后首个任务前重新真探——mtime 重探语义仅属该路径，不构成漂移降级的自动恢复。

**失败路径 2（常驻进程崩溃）**：进程意外退出 → 连接 onClose → 全部在途任务 fail（错误信息附 stderr 尾部 400 字符）→ 用户重试任务 → 下一次 `engine.run` 自动重建进程。单任务失败语义与 spawn 现状等价（进程死 = 任务失败），不劣化。

**失败路径 3（模型配置缺失）**：`session/create` 返回 `-32603 "Model config is missing"` → 引擎报 `engine_credential_missing`（与现有 prepare 期错误同码），恢复指引指向 config bootstrap。

### 3.2 方案对比

**方案 A：单常驻进程 + per-session model（推荐）**

每 ZcodeEngine 实例持一条惰性启动的 app-server 连接；单一常驻 HOME（engineDataDir 下 `engines/zcode/home-appserver/`，config.json 写入全部可用 provider——沿用旧 zsw `allProviders:true` 实证方案）；任务间用 create 参数按会话选 model。

- 长期合理性：好——复刻旧 zsw 1.x 已被 60+ fake-server 用例 + 真机 e2e（E7/E9/E10：4 会话并发不串线）验证过的形态；单进程单 HOME 运维面最小；per-session model 能力（G3）天然回收。
- 短期成本：中——连接层（帧分发/请求关联/反向请求应答）+ 会话层（create→subscribe→send→终态→read→close）需新写，但有旧实现可参照（协议断言逐字级保留）。
- 风险：单进程多会话连坐（引擎崩溃 N 任务同被击落）——缓解：在途任务失败可重试 + 进程自动重建，且这是旧通道已验证可接受的代价；单 HOME 多 provider 凭据集中——与旧方案等同，非新增面。

**方案 B：per-model 常驻进程池（被否）**

每个 (provider, model) 维持独立常驻进程，各绑自己的池 HOME（沿用现 preparer 的 `home-<provider>-<model>` 布局）。

- 被否理由：①内存与进程数随模型数线性增长（用户机器上常见 3-5 个模型配置 = 3-5 个 12.5MB node bundle 进程常驻）；②per-session model 能力（G3）直接丢失——create 参数的 model/thoughtLevel/toolAllowlist 通道没有用武之地，与终态目标背离；③池生命周期管理（空闲回收时机）引入新的复杂度，而收益只有「进程崩溃时故障隔离」——该收益用「任务失败可重试」已等价获得。
- 若用它，§3.1 的成功路径会变成：跨 model 的 map-reduce 需要起多个进程，冷启动收益打折；G3 无法验收。

**方案 C：zsw 宿主直连 app-server（被否，决策记录 C7 已锁死）**

- 被否理由：宿主层私连正是旧 1.x 6500 行防御工事的教训——漂移防御责任错放在宿主。xyz-agent 侧 pi 壳也用 core，宿主直连意味着两套防御。决策记录已明确「zsw 宿主 NEVER connects app-server directly」，本设计不重开此题。

**降级策略对比（独立于 A/B 的正交决策）**：

- **保留 spawn 兜底（推荐，D2 详述）**：app-server 探针失败 / 首任务漂移类错误 → 自动降级 spawn 重跑，后续任务直走 spawn。
- **app-server 单路径硬失败（被否）**：zcode 平台无公开契约（决策记录 §1 明示），3.8→3.10 升级窗口已实际发生 schema 级漂移风险（`--stdio` 之疑、`--surface` 新增均为实证信号）；无兜底 = 每次平台升级后 subagent 功能硬断，直到 core 发版修复。spawn 路径已存在、已验证、golden 已就位，保留成本 ≈ launcher 一个模式分派。

### 3.3 关键决策与权衡

**D1 进程粒度 = 每引擎实例一条连接，全任务共享**（承接方案 A）
- 选择：惰性启动（首个任务才 spawn）；进程退出即失效，下次使用重建；probe 用独立短命连接，不污染主连接。
- 被否：per-model 进程池（方案 B）；per-task 进程（= 现状 spawn，无冷启动收益）。
- 证据：旧实现 `_ensureConnection` 复用粒度（runner-appserver.js:872-886）+ E10 四会话并发不串线真机实证（Gate B 2026-08-29）。

**D2 降级链 = app-server 优先 + probe 门控 + 首败降级 spawn 重跑**（长期方案）
- 选择：①引擎启动时（或 zcode 版本变更后首个任务前）跑协议探针（独立连接 create 探针会话 → close → shutdown，**不发模型请求**，10s 预算）；②探针失败 → 本任务起直接走 spawn；③探针通过但首任务运行中命中漂移类错误（`-32601/-32602`）→ 本任务降级 spawn 重跑一次，后续任务直走 spawn，record 标注降级原因；④显式 env（如 `XYZ_ZCODE_MODE=appserver|spawn`）可定向指定，定向时不探不降。
- 被否：硬失败单路径（§3.2 已论证）；把降级链做成宿主可配置（违反 G4 宿主零改动与 C7 宿主不防御原则）。
- 证据：这是旧 zsw 防御链的引擎内精简版——旧实现三层（probe 缓存落盘 + 失效重探 + 降级重跑）在宿主层花了 ~6500 行，core 内只需引擎类内部状态（探针结论 + 降级标志），漂移检测主体交给 golden 回归（D8）。
- 说明：降级为任务级兜底而非能力级降级——capabilities 声明不变（见 D5），record 留痕降级事实。

**D3 abort 链 = session/stop 优先，杀进程为最后手段**
- 选择：任务收到 AbortSignal → ①发 `session/stop {sessionId}`（协议明示 stop 是唯一绕过请求串行队列的方法）②等待 grace 窗口确认终态 ③stop 失败或超时 → killChain 杀共享进程（接受连坐，因为此时协议已不可信）→ 在途其他任务走崩溃路径。
- 被否：直接杀进程（殃及全部在途会话，G1/G3 的共享收益随时可被单任务取消摧毁）；只发 stop 不设兜底（stop 本身可能因协议漂移失效）。
- 证据：旧实现同序（timeout → stop 兜底 → stop 失败才 kill 共享进程）。
- capabilities.interrupt **维持 `kill-only` 不升级**：改链路先于改声明（C4 原则），stop 链路经 conformance 真机验证后再评估升 `native`（另行小改）。

**D4 会话生命周期 = 每任务自包含（create → run → close），不做热会话复用**
- 选择：每任务独立会话，`turn.terminal` 判定终态、read 取全文后即 `session/close`（SQLite 持久化保留，仅回收驻留内存）。
- 被否：任务间 idle 会话复用（收益=省一次 create RPC，成本=驻留池管理 + `-32004` 四步恢复序全套 + 与 conversation 能力耦合——interact 生产零调用方，无消费方）；不 close 留驻留池（占引擎驻留配额 targetCount=8，且订阅会防驱逐，长期运行泄漏面）。
- 证据：会话创建是进程内 RPC，成本远低于进程冷启动；旧实现的四步恢复序（resume{runtimeModel} → 重挂 subscribe → 重试 send → 终态窗口）是热会话续聊的配套复杂度，首期无消费方。
- 连带：进程崩溃在途任务直接失败（与 spawn 现状语义等价），**恢复序整体 out of scope**，留 conversation 阶段。

**D5 capabilities 升级序 = 本设计只升 eventGranularity，其余不动**
- 选择：`eventGranularity: "coarse" → "stream"`（delta → text_delta 实时流出，turn.terminal → turn_end，收尾帧 usage → message_end.usage）；`steer/conversation/resume/interrupt` 维持现值（`unsupported/unsupported/cold/kill-only`）。
- 依据：改链路再改声明（C4）；`eventGranularity` 生产零消费方（盘点证实），翻转无下游风险；其余能力位的消费方（assertEngineParamSupport）会在能力未就绪时正确拒绝。
- 版本语义：capabilities 声明变化属消费方可见语义变化 → core 发 minor 版本。

**D6 停机面 = EnginePort 新增可选 `dispose?(): Promise<void>`，`killAllSpawnedChildren` 编排扩容**（唯一 A 级改动）
- 选择：①`EnginePort.dispose?()`——引擎释放常驻资源（close 全部会话 → SIGTERM → grace → SIGKILL，幂等）；②registry 重注册同名引擎时先 dispose 旧实例（防泄漏）；③宿主唯一收割入口 `killAllSpawnedChildren` 改为「先遍历 registry dispose 引擎，再杀 per-record children」——**宿主调用点零改动**即覆盖常驻进程回收（zsw shutdown 与 pi 壳 dispose 都走这个入口）。
- 常驻进程**不进** `spawnedChildren: Map<recordId, ChildProcess>`（避免 per-record 重复注册/重复 SIGTERM/单任务 abort 误杀全局）；其生命周期完全归引擎 dispose。`onChildSpawned` 对常驻连接不调用（port.ts:88-90 已明文允许「引擎内部不 spawn 进程时不调用」——常驻进程归引擎所有，同理不逐任务注册；契约文案随实施补充一句）。
- 被否：EnginePort 加必选 dispose（breaking，pi 引擎等所有实现被迫补方法——用可选方法保持向后兼容）；常驻进程注册进 per-record Map（盘点已证语义冲突）。
- 证据：盘点 §2.3 硬缺口；zsw 壳现役 shutdown 链（runner-core.js → killAllSpawnedChildren）零改动验证（A7 场景）。
- **子决策①（签名与等待策略）**：dispose 双面——同步面：`killAllSpawnedChildren` 在返回前**先 fire 全部 `session/close` 帧、后同步发出 SIGTERM**（`child.kill()` 为同步系统调用，顺序规定避免 SIGTERM 先发致 close 帧必丢；close 帧不等待应答），保证「调用返回时终止信号已发出」；异步面：`dispose?(): Promise<void>` 走完整序列（close → SIGTERM → grace → SIGKILL）。**异步面的现役消费方为空**——pi 壳 `SubagentService.dispose(): void` 同步（subagent-service.ts:525），zsw `CoreRunner.shutdown()` 虽 async 但不 await killAllSpawnedChildren（runner-core.js:383-388），且两者均受 G4 禁改；grace→SIGKILL 兜底仅在宿主进程存活时生效（zsw daemon shutdown 后若进程继续存活数秒则 grace 链生效，否则仅同步 SIGTERM 面）——此边界如实声明，异步面供未来宿主/测试消费（A7 判据按此口径）。
- **子决策②（dispose 触发粒度与 pi 壳收益边界）**：pi 壳的 dispose 挂在 session_shutdown（每 session 关闭触发，subagent-service.ts:521-536）——即常驻进程随 session 结束回收。接受该边界：**G1 在 xyz-agent 侧的收益面 = session 生命周期内多任务零冷启动**（每 session 一次进程冷启动，摊薄到 session 内任务数）；zsw daemon 生命周期长，收益完整。被否：跨 session idle 保活常驻进程——违背 dispose = 防泄漏语义，且 pi 壳在 G4 约束下无法感知进程归属，保活即泄漏面。
- **子决策③（孤儿自愈）**：宿主 SIGKILL 级崩溃时 dispose 不执行，孤儿窗口从 spawn 模式的秒级任务进程扩大为常驻进程。自愈机制：常驻 HOME 内写 pidfile（`appserver.pid`，含 pid + 启动时间戳）；引擎实例初始化（首任务或显式 probe 触发——引擎惰性实例化，**不是**宿主启动时）发现 pidfile 时按三重判据回收：**pid 仍活 AND `ps lstart` 启动时间与 pidfile 记录一致 AND 命令行匹配 `app-server` 形态**——时间戳判据封死 pid 复用误杀（残留 pidfile + 同形进程被复用）；命令行匹配对 wrapper 形态（A5-② 测试）假阴性漏回收可接受（仅泄漏不误杀）。**时序：先过 D7 目录锁判定——lockfile.pid 归宿主进程（pid 归属分离见 D7），锁被活宿主持有时派生新 HOME、不触碰他人 pidfile；仅在锁无主（持锁宿主已死，接管 HOME）后才执行本回收**。宿主崩溃 → 下次引擎初始化（首任务/probe）时完成回收（A7 场景 2 验证）。

**D7 HOME/config = 常驻 HOME 即池目录（锚定不变量保持）+ allProviders 引导 + 凭据刷新 + 所有权隔离**
- 选择：①**poolKey = 常驻 HOME 目录名**（固定名 `home-appserver`），常驻 HOME = `resolvePoolDir(engineDataDir,'zcode','home-appserver')`——严格维持 spawn 模式的锚定不变量 **poolDir == HOME == db 所在目录**：SQLite 落 HOME 内 `.zcode/cli/db/db.sqlite`，sessionRef.dbPath 相对路径锚 HOME，GUI ①级读取（runtime `readZcodeNativeTier` 按 handle.poolKey 推 poolDir + `isStrictlyUnder` 白名单）对新 record 持续可用、零 runtime 改动。journal 同落该池目录（journal 文件名 = record id，任务间无冲突）。config.json 写入**全部**可用 provider（带 apiKey 者全写）；per-session model 经 create 参数传递。spawn 降级路径继续用现 `home-<provider>-<model>` 池（锚定不变量本就成立）。
- 依据：app-server 进程启动即要求 `$HOME/.zcode/cli/config.json` 有模型配置（缺失则 create 恒 `-32603 "Model config is missing"`，二进制字符串级验证仍在）；单 HOME + allProviders 是旧实现实证方案（「先 bootstrap 再 probe，否则 appserver 永远误降级 spawn」的教训一并承接——**探针连接也用已引导的 HOME**）。凭据写入与 spawn 池同源（preparer 的 sources 解析复用），不新增凭据来源。
- **凭据刷新**：常驻进程生命周期内凭据可能变化（spawn 池每任务 mtime 免重写检查即生效，常驻 HOME 无对应物则新 provider 恒撞 `-32603`）。补：每任务比对 sources 配置（内容 hash）与常驻 HOME config.json，不一致 → 重写 config + 重建连接（kill 旧进程、新进程读新配置）；在途任务走崩溃路径（失败可重试），换取凭据变更下一任务生效。**hash 范围限定（实现口径 appserver-home.ts `hashProviderRegistry`）：只覆盖 provider 注册表段，`model.main` 不参与**——per-session model 走 create 参数传入，计入 hash 会在每次换模型时误判「凭据变更」杀掉常驻进程（冷启动收益归零）。
- **所有权隔离（跨进程并发）**：zsw daemon 若在 xyz-agent 会话内被调用，`XYZ_AGENT_DATA_DIR` 经出站白名单传播（C-proc-09）→ 两宿主进程可能共用同一 engineDataDir。策略：常驻 HOME 目录锁（lockfile：O_EXCL 创建 + pid + 心跳 mtime）。**pid 归属钉死（r3）：lockfile.pid = 持锁宿主进程（引擎实例所在进程）的 pid，心跳 mtime 由该进程更新；常驻 app-server 进程的 pid 只归 pidfile（`appserver.pid`）记录——两文件两 pid 严格分离**。宿主死 ⇒ 锁无主 ⇒ 接管方接管 HOME 并经 pidfile 回收孤儿（D6③）；宿主活 ⇒ 锁活。**「活持有」判定钉死为 lockfile.pid 活 ⇒ 一律视为持有（新实例派生后缀目录）**——心跳 mtime 不参与活持有的否决（桌面睡眠/长 GC 致心跳过期时误判死 → 偷锁双写同一 SQLite，不可接受），仅用于 pid 已死时的锁破坏加速（区分崩溃残留 vs 活持有）。**双接管者竞争闭环：接管 = 删旧锁 + O_EXCL 重建新锁；O_EXCL 失败 = 他方已先行接管，失败方重走锁判定循环（读到对方活 pid → 派生）**。派生目录（`home-appserver-2`…）作自己的 HOME，record 的 handle.poolKey 记**实际**目录名 → ①级锚定随 handle 走，不受派生影响。**派生目录清理语义（钉死）**：journal 文件**永不**随池目录清理（对齐 paths.ts 登记不变量 D5「journal 生命周期跟随 record，不随池删除」）；首期**不自动删除**派生目录（碰撞是罕见场景、目录体量小，破坏性操作判据成本 > 收益）；未来若需清理，前提是无存活引用（存活引用 = 仍有未过 30 天 TTL 的 record 引用该 poolKey），届时另行设计，不预设触发条件。两进程各持 HOME 各自 bootstrap，无 SQLite 并发写竞态。

**D8 probe / golden = 协议冒烟探针 + 帧序列 golden 语料替换**
- 选择：①probe 改为 app-server 协议冒烟（独立连接：create 探针会话 → close → shutdown，校验应答形状与 sessionId 提取，预算 10s，不触发模型请求、不产生费用）；**探针连接 env 携带实现期新增标记 `ZCODE_APPSERVER_PROBE_CONN=1`（constants.ts `ZCODE_APPSERVER_PROBE_CONN_ENV`）**——探针用独立短命连接但 env 与主连接同源（同一常驻 HOME），该标记供真机 wrapper / fake 侧区分「探针连接」与「主连接」（测试断言探针帧序、故障注入只命中主连接的判据；A5-② 的 wrapper 探针放行即依赖此标记）。②golden 语料从「stdout 单 JSON」换为「NDJSON 帧序列」（create 应答、推送流、终态帧、read 应答四类样本，fixture 双副本 diff 机制保留）；③探针结论记录 CLI mtime，zcode 升级（mtime 变化）后首个任务前重探。
- 被否：保留 stdout 单 JSON golden（协议换掉后无消费方）；真模型请求探针（有费用与速率限制副作用，旧实现探针也不发 send）。
- 证据：旧 probe 全链（10s 预算、create→close）真机验证；本机 zcode.cjs 0.16.5 二进制方法注册表/错误码/字段全量字符串验证命中（附录 A.4），协议未漂移到方法级，但 schema 细节（zod strict）无法靠字符串验证——探针冒烟是唯一低成本运行时防线。

**D9 反向请求应答 = 常量表应答 + 未知一律回空 result**
- 选择：`session/requestRuntimePreferences` 回固定常量（`nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1'`）；其他一切反向请求（如 `permission/request`）回 `{id, result: {}}`。
- 依据：反向请求不答 15s 超时并**拖死共享连接上全部会话**（旧实测 `-32022`；当前版本错误码存疑，见附录 A.5 未确认项，但「必须应答」行为已验证）；常量表逐字来自旧实现实测。

**D10 启动参数 = 实施期探针矩阵定案**（实施后注：R4 已按基线不带 flag 落地，三态矩阵留待跨仓真机段补验——见 §5 检查点回填）
- 现状：0.16.5 全局参数 schema 实测含 `stdio:{type:"boolean"}` 与 `surface:{type:"string"}`（`--surface` 取值归一 `terminal`/`zcode_desktop`，作用于 headless prompts/app-server）；旧实现两者皆未传也能用（r1 审查修正：`--stdio` 字符串在 bundle 全局参数 schema 中存在，旧调研「GUI 用 app-server --stdio」并非无据）。
- 选择：实施期探针矩阵（基线不带 flag / `--surface terminal` / `--stdio` 三态 × create/send/流式三链路）确认后定案；设计上不预设。启动基线 = `node <cliPath> app-server --cwd <dir>` + env（隔离 HOME、`ZCODE_MODEL_TELEMETRY_ENABLED=false`、nesting guard 剥离注入沿用）。
- 标注：这是唯一留白到实施期的决策，不影响结构。

**错误规格（新增/变更路径全集）**：

| 触发 | 协议信号 | core 行为 | 用户可见/恢复 |
|------|---------|----------|--------------|
| 方法不存在 / 参数变形 | `-32601` / `-32602`（error.data 带 zod 诊断） | 归档 protocol-drift；首任务降级 spawn 重跑，后续任务直走 spawn | record 标注 `degraded: spawn` + 提示「zcode 升级冒烟失败已回退」；恢复 = core 修适配 |
| 模型配置缺失 | `-32603 "Model config is missing"` | 报 `engine_credential_missing`（prepare 期同码） | 检查 provider 凭据配置后重试 |
| 会话不在内存 | `-32004 "Session is not active"` | 首期任务自包含 + 用后即 close，正常不出现；出现则按任务失败上报（含会话 id） | 任务重试（新会话） |
| send 时已有轮在跑 | `-32010` | 任务失败上报（不重试——旧实证 busy 不排队不打断） | 单会话一任务是结构保证，出现即 bug，错误信息引导报告 |
| 反向请求超时断连 | 连接 onClose（旧码 `-32022`） | 全部在途任务失败 + 进程标记失效 | 重试任务自动重建进程 |
| 进程意外退出 | onClose + stderr 尾 400 字符 | 同上 | 同上 |
| abort | 宿主 signal | stop → grace → killChain（D3） | record 终态 exitCode=null（杀链合成语义沿用） |
| 探针预算耗尽 | probe 10s | 结论 failed → 降级 spawn | 同漂移降级 |

### 3.4 实施不变量（从决策推导，conformance 承接）

1. **事件不变量沿用 C3 全量**：stream 模式下 text_delta 拼接 == read 全文；终态唯一（turn.terminal 权威）；message_end.usage 完整；tool_start/tool_end 配对（app-server 推送帧能提供 toolCallCount，但首期事件面若无逐工具帧，tool 事件不合成——granularity 声明与实际流出一致即可）。
2. **run resolve 先于 journal close**：事件 emit 完成先于 run resolve（现有不变量 5 在流式形态下自然成立——turn.terminal 后 read 兜底完成才 resolve）。
3. **onPoolResolved 先于首事件 + 运行中 entry 携带读取钥匙**：常驻通道 poolKey 为静态常量（'home-appserver' 或派生目录名，W4 已定案），onPoolResolved 可在连接建立前极早调用；**传递通道（r3 钉死）：RunContext 新增可选回调 `onHandleReady(partial: Pick<EngineHandleData, 'sessionRef' | 'poolKey'>)`**——与 onPoolResolved 分立两个时点（poolKey 在 prepare 期经 onPoolResolved，sessionRef 在 create 应答后经 onHandleReady；字段级扩展已在本设计登记，满足 port.ts 头注纪律）。编排层收到回调后立即回填 `record.engineHandle = { sessionRef, poolKey, journalPath }` 并经 `reportRecordTransition` 落 entry（record-store.ts:434 既有上报通道）——运行中的 GUI 经 entry 重建 record 即拿到 ①②级读取钥匙，不再等 `engine.run` resolve 后的回填（subagent-service.ts:1746 现状）。
4. **dispose 幂等**：重复调用无副作用；dispose 后首个 run 自动重建（与「进程死后重建」同一代码路径）。

## §4 验收（真实场景）

> 全部场景用真实 zcode.cjs（本机 0.16.5）+ 真实模型配置；fake-server 仅作单元层回归，不作为验收依据。每个场景标注回溯目标。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| A1 | zsw 多任务零冷启动 | 真机 `zsw run` 一个 map-reduce（主任务 + 3 subagent），对比改造前同 workflow | 第 2-4 个 subagent 任务无进程启动段（record 耗时显著低于首任务；`ps` 全程只见 1 个 app-server 进程，**探针窗口的独立短命连接除外**）；结果与改造前等价 | G1 |
| A2 | stream 事件流出 + 快照一致性 | ①zsw 真机跑 workflow，观察终端 live 输出实时刷新；②xyz-agent dev 起 zcode 引擎 subagent，任务运行中打开详情页、任务中途重开 session | ①workflow live 输出随任务运行实时出现（非终态一次性）；②详情页打开可见当时进度快照，重开后渲染与 live 一致（①级 sqlite / ②级 journal 无论哪级命中，内容一致） | G2 |
| A3 | per-session model | 同进程上并发两任务：任务 A `model: glm-5.3`，任务 B `model: mimo-v2.5` | 两任务各自成功、响应面无串线（sessionId/usage 各归各）；record 各自留痕正确 model | G3 |
| A4 | abort 不连坐 | 两任务并发在途，取消其一 | 被取消任务终态 exitCode=null；另一任务正常完成不受影响（session/stop 只作用于目标会话） | G1/G3 |
| A5 | 漂移降级 + 重探重建 | 三层：①单测 fixture 注入 `-32602`（回归门）；②真机首败降级——**缺省模式（不设 `XYZ_ZCODE_MODE`，走 D2①② probe 门控路径）** + `XYZ_ZCODE_CLI` 指向包装脚本（转发真 CLI；wrapper 按探针 env 标记 `ZCODE_APPSERVER_PROBE_CONN=1` 识别探针连接并放行——标记语义见 D8，定向时不探不降（D2④）故不可用 `XYZ_ZCODE_MODE=appserver` 定向构造本场景——仅对主连接的首个 create 注入一次 `-32602`），跑真实任务；③真机 mtime 重探——`touch` 真 CLI 文件本体（非 wrapper，避免与 ② 混跑歧义）伪造 mtime 变化后跑下一任务（须独立新进程实例——漂移降级标志随进程重启清零，同进程残留降级态会直走 spawn、不进探针门控） | ①降级 spawn 重跑成功、record 标注、后续直走 spawn；②真连接上首败降级全链成立（错误分类 → 池/HOME 切换 → spawn 重跑 → record 标注）；③mtime 变化触发重探（日志可见 probe 重跑）；另真机显式 `XYZ_ZCODE_MODE=spawn`（无 wrapper 直连）通道全绿（兜底始终可用） | G5 |
| A6 | 崩溃重建 | 任务运行中 `kill -9` 常驻进程 | 在途任务失败（错误含 stderr 尾）；紧接的下一任务自动重建进程并成功 | G1 |
| A7 | 无孤儿进程（三种退出形态） | ①zsw daemon 正常退出（现役 shutdown 链零改动——异步面现役消费方为空，实际生效的是同步 SIGTERM 面，见 D6①）；②宿主 SIGKILL 后重启宿主，**跑一个 zcode 任务（或触发 probe）后再 ps**（引擎惰性实例化，回收挂在引擎初始化而非宿主启动，见 D6③）；③pi 壳 session 关闭触发同步 dispose | ①②每次之后 `ps` 无残留 `app-server` 进程——②的判据为**重启并触发引擎初始化后完成 stale 回收**（pidfile 机制）；③SIGTERM 已随 dispose 同步发出、session 内无泄漏（grace→SIGKILL 兜底边界见 D6 子决策①） | G4 |
| A8 | conformance 全绿 | 跑 engine conformance 套件（真机 gate）+ zcode 单测族迁移后全量 | C1-C8 适配后全绿；golden 帧序列语料 diff 通过；pi 引擎测试零改动零回归 | G4/G5 |
| A9 | 宿主零改动验证 | zsw 仓与 pi 壳**自有代码**不改（vendor 刷新除外——zsw 经 vendored 副本消费 core，`lib/vendor/subagent-core/` 刷新属依赖升级载体不算改动；pi 壳 workspace 引用同理走 core 版本 bump），重跑 A1 | zsw 壳 runner-core.js 等自有源码 diff 为空、vendor 目录刷新除外，功能全部成立；待 npm 自包含 bundle 通道就绪后以真依赖升级复验一次 | G4 |

A1/A2/A3/A4/A6/A7 为必过门（真机）；A5 的 ①为回归门、②③为真机门；A8 为合入门。

## §5 下一层拆分

| 单元 | 内容 | 文件改动地图 | justification / 验收挂钩 |
|------|------|-------------|------------------------|
| W1 停机面 | `dispose?()` 接口 + registry 重注册 dispose + `killAllSpawnedChildren` 编排扩容 + onChildSpawned 契约文案 | port.ts、registry.ts、session-runner.ts（各小改） | 唯一 A 级，先行独立可验（A7 可在旧引擎上先验证编排正确）；其余单元依赖它兜住进程生命周期 |
| W2 连接层 | AppServerConnection：NDJSON 帧分发（4 帧型）、请求 id 关联、反向请求应答（D9 常量）、崩溃 onClose、惰性启动/重建、stderr tee 落盘 | 新文件 `engines/zcode/connection.ts` + 单测（fake server fixture 从 zsw 仓移植改造） | 协议层与业务层解耦，fake-server 60+ 用例模式可低成本移植；A6 的基础 |
| W3 会话层 | create/subscribe/send/终态判定（turn.terminal 权威 + 宽松匹配防洪堤）/read 四层兜底链/close | 新文件 `engines/zcode/session-channel.ts` + golden 帧序列语料（替换 golden-sample.ts） | 旧实现同等层（`_createTurn`/`_fetchFinalResponse`）已验证，逐字级协议断言迁移；A2/A3 的基础 |
| W4 引擎接线 | launcher 双模式分派（app-server 常驻 / spawn 单轮）、run 重写（事件时序前移）、abort 链（D3）、capabilities（D5）、per-session model 透传（task.model → create 参数）、poolKey='home-appserver' 锚定 + journal 同池 + 凭据刷新 + 目录锁/派生 + pidfile 孤儿自愈（D6③/D7）、**运行中 engineHandle 回填**（RunContext 新增可选 `onHandleReady` 回调 + 编排层回填 record.engineHandle + reportRecordTransition 落 entry，§3.4 不变量 3——chat 域经 subagent-service 接线；**workflow 域 SAR 无需同类回填**：zsw live 消费 onEvent 事件流自足，taskId 非 record id、无运行中 record 读取方，防实施者误扩展） | port.ts（RunContext 增可选回调 onHandleReady）、launcher.ts、zcode-engine.ts、preparer.ts（spawn 池语义保留）、appserver-home.ts（appserver home 引导/刷新/锁/pidfile 孤儿自愈——D7 语义自 preparer.ts 拆出的独立模块，语义等价）、constants.ts、registration.ts、persona-router 调用点、subagent-service.ts（onHandleReady 接线 + engineHandle 回填，core 内部） | 核心改造单元；A1-A4 的落点；poolKey 锚定不变量（poolDir==HOME==db）保持是 ①级读取零改动的结构前提；运行中回填是 A2-②「中途打开可见快照」的通道支撑（不回填则运行中 GUI 恒落 ③级 outcome-only） |
| W5 降级链 | probe 冒烟改写（D8）、首败失效降级、`XYZ_ZCODE_MODE` 定向、record 降级标注 | zcode-engine.ts、probe 相关 | 独立于 W4 主链可并行；A5 的落点 |
| W6 测试迁移 + 文档同步 | zcode 单测族迁移（~40+ 用例）、conformance C3/C4 口径、golden 双副本、live gate 4 用例改写；文档同步（见下） | `__tests__/` 7 文件 + conformance 8 文件 + 文档 4 处 | 测试与实现同步交付（不留尾巴）；A8 的落点 |

**文档同步清单**（W6 内完成，防再次出现决策滞后）：

1. `docs/architecture/subagent-engine-abstraction.md`：D10 与 §1 scope-out 行补「已由 app-server 终态决策超越（2026-08-30），实施见本设计」注记；实施状态段补 W1-W6 落地记录。
2. `docs/design/subagent-core-package-extraction.md` D6-⑥：补「P3 常驻回归已提前实施，见 zcode-engine-appserver-resident.md」注记（原文保留——2c 退役是当时的正确事实）。
3. zsw 仓决策记录：状态从「待实施」更新为实施进度（跨仓 PR 同步）。
4. `.xyz-harness/subagent-engine-abstraction/decisions.md` D-010：追加 revisit 行（终态决策时间与出处），不改写原决策记录。

**版本与排序**：core 当前待发 0.3.0（host-surface，changeset 已备）。本设计落 **core 0.4.0**（capabilities 声明变化 = 消费方可见语义变化，minor）。与 convergence 设计（原计划 0.4.0，W1-W9）的先后排序是**用户决策点**：本设计与 convergence 正交（决策记录 §5 已论证），推荐本设计先行（用户当前优先级），convergence 顺延 0.5.0；两设计无文件级冲突面（convergence 不动引擎）。

**待验证检查点（实施期，R1-R6 落地后 2026-08-31 回填）**：①`--surface` / `--stdio` 矩阵（D10）——**已定案基线不带 flag**（connection.ts 落地，旧 runner 不带实测可用的依据），三态矩阵留待跨仓真机段补验；②stream.chunk 帧是否偶发携带文本字段——实现已做宽容双形态兜底（session-channel 推送泵对带文本的 stream.chunk 一并消费），真机实录待跨仓段替换合成语料；③`-32022` 当前版本错误码——未确认，实现按「连接 onClose + 全部在途 reject」形态处理（与错误码无关），真机待验；④`session/read` 的 `step-finish` tokens 结构——实现按宽容解析（usage 权威取收尾帧，read step-finish 仅兜底，字段缺席不抛）；⑤**GUI ①级锚定**——实现面已落（poolKey 静态常量 + 派生目录记实际名 + read 侧 resolvePoolDir 重定位；live 用例已写入 zcode-engine.live.test），真机验证（RA2-②）属跨仓验收段。

---

## 附录 A：协议事实基准（实测来源与置信度）

> 本附录是 D1-D10 的证据层。**所有字段名逐字来自旧实现代码（zsw 仓 `84b63a0^:lib/runner-appserver.js` 等）与本机 0.16.5 二进制字符串级验证**；真机往返抓包锚点是桌面 App 3.8.1 时代（2026-08-23），当前机器为 App 3.10.1 / zcode.cjs 0.16.5——方法注册表/错误码/关键字段在 0.16.5 二进制全部命中（未漂移到方法级），schema 细节仍需实施期冒烟复核。

### A.1 传输与帧型

stdio NDJSON，非标准 JSON-RPC（**不带 `jsonrpc` 字段**，未知键被 strict 校验拒收）。四帧型：客户端请求 `{id, method, params}` / 应答 `{id, result}` 或 `{id, error:{code,message,data}}` / 服务端推送 `{method, params}`（无 id）/ 服务端反向请求 `{id, method, params}`（**必须应答**）。无 initialize 握手、无版本协商；首帧可能是 `{protocol:{name:"ZCode Protocol",version:1}}` 自报，忽略即可。

### A.2 任务生命周期帧序列

```
① session/create {workspace:{workspacePath, workspaceKey}, mode:"yolo",
    model?:{providerId,modelId,variant?},        ← strict 对象，字符串被 -32602 拒收
    thoughtLevel?, toolAllowlist?, toolDenylist?, persistence:"immediate"}
   ← 反向请求 session/requestRuntimePreferences（必须回，见 D9）
   → result.session.sessionId（projection.sessionId 恒 "unknown"，勿用）
② session/subscribe {sessionId, deliveryKind:"desktop-continuous"}   ← deliveryKind 必填
③ session/send {sessionId, content} → {accepted:true}                 ← 字段是 content 不是 text
④ 推送流：
   state.updated {patch:{status:"running"}, reason:"prompt_started"}
   v4/telemetry/event {kind:"stream.chunk", channel:"text", chunkLength, firstChunk, assistantMessageId}  ← 无文本
   session/event {sessionId, payload:{delta:"<实时文本>", assistantMessageId}}                            ← 文本在此
   工具执行期（2026-09-10 真机探针实证，~1.0s 固定 cadence）：
   session/event {type:"tool.updated", payload:{kind:"progress", toolCallId, toolName, elapsedMs, pid,
                    stdoutBytes, stderrBytes, outputBytes, stdoutTail}}                                  ← 工具进度（宿主活性面）
   v4/telemetry/event {kind:"tool.lifecycle", phase:"progress", toolCallId, toolName}                     ← 同 eventId 镜像
⑤ 终态权威：v4/telemetry/event {kind:"turn.terminal", status:"success"|...}
   收尾帧：session/event {payload:{response:"<全文>", usage:{inputTokens,outputTokens}}}
⑥ session/read {sessionId} → {messages:[{info:{role}, parts:[{type:'text',text} | {type:'step-finish',tokens}]}], ...}
⑦ session/close {sessionId}
```

workspaceKey 算法不限（旧实现 `'ws-' + sha256(path).slice(0,16)`）。会话状态枚举 `idle|running|waiting|paused|completed|error`。

### A.3 错误码表

`-32601` 方法不存在（漂移）/ `-32602` 参数校验失败（漂移，error.data 带 zod 诊断）/ `-32603` 内部错误（含 "Model config is missing"）/ `-32004` "Session is not active" / `-32010` "A prompt is already running for this session"（不排队不打断）/ `-32031` 恢复失败（runtimeModel 不可用）/ `-32022`（旧实测：反向请求 15s 不答超时断连；当前版本语义存疑见 A.5）。

### A.4 0.16.5 二进制验证命中清单（2026-08-30）

`app-server` 子命令存在（help 原文 "Run the ZCode Protocol stdio app server"，别名 `agent-server`）；方法注册表 24 个 `session/*` + `workspace/*` 方法逐字命中（含 create/resume/list/subscribe/send/stop/close/read/messages/setModel/setThoughtLevel/updateRuntimeModelConfig）；`turn.terminal`、`stream.chunk`、`state.updated`、`desktop-continuous`、`deliveryKind`、`toolAllowlist/toolDenylist`、`thoughtLevel`、`runtimeModel`、`restoreWarning`、`"immediate"|"deferred"` 枚举、`Model config is missing`、`-32004/-32010/-32031` 错误构造全部命中。全局参数 schema 实测含 `stdio:{type:"boolean"}` 与 `surface:{type:"string"}`（`--surface` 归一取值 `terminal`/`zcode_desktop`，作用于 headless prompts/app-server）——两者旧实现均未传。**spawn 通道 help 漂移前科**（`--allowed-tools`/`--max-turns`/`--settings` help 列出但解析器拒收）——help 输出不构成契约。

### A.5 未确认项（实施期探针矩阵覆盖）

`--surface` / `--stdio` 的实际行为差异与是否需要显式传（r1 审查修正：`--stdio` 存在于全局参数 schema——旧调研「GUI 用 `app-server --stdio`」有据，待矩阵实测；旧 runner 不带该 flag 实测可用，基线按不带实现）；`-32022` 当前版本错误码；stream.chunk 是否偶发携带文本字段；`session/read` 在 0.16.5 的 `step-finish`.tokens 字段结构；`expectedRevision` 乐观并发参数形态（`-32009`，仅 bundle 逆向）；`protocol` 自报帧到达时序保证。
