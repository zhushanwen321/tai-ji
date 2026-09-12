# subagent 引擎协议化与外移（engine 插件化：pi-subagent-cli / zcode-subagent-cli）技术设计

> **[HISTORICAL] 部分退役注记（2026-09-11，U7 符号清扫批）**：本文「引擎协议 + 编排壳」主体（发现注册 / NDJSON stdio / manifest 能力位 / conformance 套件）仍现行；但文中 chat 域协议面已随 [subagent-chat-run-unification.md](subagent-chat-run-unification.md)（H1）退役——EnginePort 的 `interact` 成员（§3.3.5 契约签名 F1 行）、协议正向方法 `interact`（方法映射表，现存方法 9 个）、第 9 反向通道 `host/roundLifecycle`（现存通道 8 条）、契约类型 SSOT 清单中的 `InteractAction`/`InteractResult` 均已删除；续聊 = 新 run + resume 锚点（`RunParams.resume`）。W11 收口注记与 A2 的 chat 域验收描述为 v1.x 时代史实记录，不逐处改写。读现行协议面以 `packages/subagent-engine-sdk/src/protocol/{methods,reverse-channels}.ts` 与 [subagent-chat-run-unification.md](subagent-chat-run-unification.md) 为准。

> **一句话结论**：把 subagent-core 从「内建多引擎实现」改成「**引擎协议 + 编排壳**」——
> core 只保留路由 / 公共降级层 / journal / record / 协议客户端 / conformance 套件；
> 每个引擎成为独立 CLI 包（`pi-subagent-cli` / `zcode-subagent-cli` …），用**元数据自注册**
> （package.json manifest + 配置覆盖）挂进 core 的引擎注册表，core 通过 **NDJSON stdio 协议**
> 驱动它们。新增引擎 = 装一个包，**不再改 subagent-core**。

> 层声明：当前层 = 技术方案设计（协议 + 壳边界 + 发现注册 + 迁移策略）；
> 下一层 = 可实施代码单元（W1–W12，见 §5）+ **每引擎一份提取设计**（pi / zcode）。
> 状态：**设计就绪（R4~R7 全修 + v6 减法 + R8 4 must-fix/4 suggestion 全修，待复审）**。
> 事实基准：2026-09-08 代码盘点（§2.3 逐条给锚点，行号已 read 源核准）。
> 修订记录：
> - v1（2026-09-08）：首版。
> - v2（2026-09-08，R1 修复）：①**同步能力位**改为 manifest 声明 + 握手校验（原「未握手返回保守值」会误拒 pi）；
>   ②新增 **D7 引擎 SDK 包**（解决「公共降级层引擎无关」与「引擎不得 import core」的互斥）；
>   ③**runtime 升为第三个宿主**并给出①级读的进程模型与降级语义；④协议补 `read.dataDir`、
>   反向通知 `host/poolResolved|handleReady|childSpawned`、反向请求超时值；⑤删内置引擎清单 +
>   定义「缺省引擎包缺失」的路由规格；⑥v1 **关闭事件合并**（原 16ms/4KB 与 A1 逐字段等价不可兼得）；
>   ⑦宿主零改动改为**兼容公共面**；⑧补伴生写入面、env 契约归属、打包发现路径传递、relay 透传、
>   pi 等价验收与宿主表面不变量场景；⑨硬耦合清单补齐 pi 的静态 import 面与测试消费面。
> - v3（2026-09-08，R2 修复）：①**同步面补全**——`validateModel`/`listModels` 也是同步成员（manifest `modelCatalog` +
>   握手后缓存，未知 ref 按 `dynamic` 分流；显式放宽「record 创建前拒绝」不变量）；②**能力位时序钉死**——免探路径
>   首个 gate 用 manifest，但首个 run 前强制 `initialize`，弱于/强于按方向处置（弱于 → run 失败）；
>   ③**路由/执行时序契约显式登记**（§3.5.3：同步返回保留，下游「首个 await 前触达 executeAndAwait」作废）；
>   ④**D7 依赖方向重写**（逐模块列 core import → 拆 seam；契约类型 SSOT 在 SDK + core 反向 re-export；新增「SDK 不得 import core」不变量）；
>   ⑤**`spawnedChildren` 归属修正**（持有方=引擎进程，core 持状态镜像 + `host/childStateChanged`）；⑥**zsw 兼容面补 deps→CLI 映射
>   + vendored 定位通道**，A7 改为「业务逻辑零改动」；⑦**基线三层**（协议层 fixture 回放 / 引擎层 golden / 真机手动门）+ 录制复跑口径；
>   ⑧**新增影响面**：引擎专属 env 命名空间放行清单、stderr 日志轮转归引擎包、runtime 侧进程生命周期与量级、
>   H5 冷启动回退源迁移、SDK 进 runtime `noExternal`、引擎 CLI 三平台启动解析规格；⑨A13 新增 + A5/A6/A7/A10/A11/A12 判据可执行化 + H→W 承接列。
> - v4（2026-09-08，R3 修复）：①**能力位分两类**（被 gate 四类以 manifest 为权威，少声明即同步拒 + 恢复指引改写；非 gate 位才适用「强于→放行」）+ 注释回写；
>   ②**镜像失效语义**（载荷含 `killed` + 引擎退出/重建/dispose/killAll 时整体置死 + 未收 `childSpawned` 前无句柄）；
>   ③**D7 类型闭包表**（`execution/types.ts` / `orchestration/models/types.ts` / `model-resolver` / `paths.ts` / extension-protocol 逐项处置 + 守卫基线）；
>   ④**同步源闭合**（`initialize` 应答携带 `models` 作缓存唯一生产者 + `validateModel` 与 `listModels` 同源 + `modelCatalog` 生成/保鲜 + `canonicalRef` 语义 + 降级文案按实装）；
>   ⑤**env 基座/deny 来源与优先级**（SDK 内联 + 同步守卫、`envPrefixes` 校验、显式剥除/deny 高于 manifest 放行）；
>   ⑥**启动解析改「宿主 × 平台」二维**（打包 pi 宿主的 execPath 是 Bun binary → 注入执行器 + node 探针）；
>   ⑦**数据根单一 env**（删新造的 `XYZ_AGENT_ENGINE_DATA_DIR`，统一 `XYZ_AGENT_DATA_DIR` + 三宿主注入矩阵）；
>   ⑧**stderr 轮转带实例维度 + 参数**、**宿主侧 stderr 不落盘**、**引擎卸载后目录归属登记**；
>   ⑨**冷启动回退源单源化**（runtime 自身发现，A12⑦ 改「含第三方可见」）；
>   ⑩退出钩子落点点名 + `dispose` 3s 上界；S：计数/编号/fixture 路径、env 剥除 rationale、§3.5.3 措辞 + §3.10 第 9 条、pi 代理构造点。
> - v5（2026-09-08，R4 修复）：①**env 契约改四层**（L0 基础设施键 core 后置注入 > L1 deny/剥除（含凭证 `XYZ_AGENT_API_KEY`）> L2 manifest 放行（保留前缀拒绝表）> L3 extras）+ **relay 按实装名**（SOCKET/NODE/SCRIPT 透传；SESSION_ID/RECORD_ID 剥除并覆写）+ 基座常量**构建期从 shared SSOT 生成**（不引入 core→shared 运行时依赖）；
>   ②**能力位恢复指引改为「修 manifest」**（删空转项）+ 非 gate 弱于统一口径 + 多声明登记「清理前置副作用（worktree）」；
>   ③**镜像失效补机制**（独立进程组 spawn + 按 pid 补杀 + A8 观测点）；
>   ④`initialize.models` **三态映射**；⑤`canonicalRef` 改在 core 侧处理无斜杠 ref（第 4 条契约变更）；
>   ⑥启动解析执行器单一 env `XYZ_AGENT_ENGINE_NODE` 经 L0 注入（不依赖继承）+ `ELECTRON_RUN_AS_NODE` 归 L0；
>   ⑦数据根矩阵补 **standalone pi**（core 侧解析注入）；⑧stderr 清理判据 = 同前缀 + pid 未存活 + mtime（参数读 `XYZ_LOG_*`）；
>   ⑨**删冷启动静态 JSON 兜底**（与投影规则冲突）；⑩fixture 路径三处统一、双向可赋值断言、错误码补 `engine_capability_unsupported`、A11 时效断言改「dispose 发起后 1s」。
> - v6（2026-09-08，**减法收敛**——R5 四个 reviewer 因会话压缩被中止、无报告；按 `flow/write.md` §101「轮次问题同级 → 回到方案对比重做」先做减法）：
>   ①**同步面单源化**：删「握手后缓存 + 失效时机 + 保鲜/陈旧守卫」整套机器 → 同步成员只读 manifest（`capabilities` / `modelCatalog`），握手降为诊断面（不一致 warn，不参与判据）；
>   ②**env 四层压回三层**：删 L3 `engines.<id>.env` extras（优先级歧义源）+ L3 config 去 `env` 键；
>   ③**镜像收割单一机制**：删「按镜像 pid 补杀」（pid 复用面 + 需 pid→句柄映射）→ 只留 `detached:true` 进程组收割。
> - v7（2026-09-08，R5 修复——zcode 引擎重跑 R5，两批 reviewer 共 10 must-fix + 8 suggestion，取并集全修）：
>   ①**三态语义钉死**（manifest 省略/`null` = 无枚举面 → `buildCoreAlignedHint`；显式 `models:[]` = 空；缺省**不注入**）+ **`RemoteEngine.listModels()` 成员形态映射**写死（省略 → 不实现/返回 `null`）；
>   ②**relay 三键列入 L0**（r5 实测：L1 拒绝表禁 `XYZ_SUBAGENT_`、L2 是 manifest 面 → 两层都到不了，嵌套 relay 会静默消失）；
>   ③**被 gate 面修正**（实装 gate 读 `conversation`/`steer`/`maxTurns`/`sandbox`，不是形态名 `fork`；A6② 非 gate 例证改 `personaInjection`）；
>   ④**「握手不参与任何判据」改确切边界**（不参与同步成员判据；能力位方向判定仍以 manifest 权威，握手仅在「被 gate 位多声明」时阻断）；
>   ⑤**进程组收割两前提登记**（Windows `taskkill /T /F`；引擎一代子进程禁 `detached:true` + conformance）+ §3.9 补「detached 孤儿」与「modelCatalog 静态化」两条已接受代价；
>   ⑥**stderr 清理判据改 OS 探测** `process.kill(pid,0)`（「活进程表」全仓零命中，不可实现）；⑦W2 删残留「按 pid 补杀」+ §3.7 删「(extras)」；⑧A6 补「listModels 不一致 → 仅 warn + 任务仍跑通」验收；⑨「缓存」术语统一为「manifest 快照」；⑩dev-link 表述改正（只管 `extensions/`，引擎包走 L3 config）。
> - v8（2026-09-08，R6 修复——5 must-fix + 4 suggestion）：
>   ①**非 gate 能力位行去 `steer`/`sandbox`**（实装 gate 读四者，二者属被 gate 面）+ **不一致一律 warn、不阻断 run**（删除「该 run 依赖则失败」——与「握手降为诊断面」自相矛盾）；
>   ②**Windows spawn 侧写死**（`detached:false` + `windowsHide:true`，避免 console 窗口闪现；收割走 `taskkill /T /F`）；
>   ③**conformance 禁 detached 落到承接单元**（W10 新增断言 + A3 验收项）；④**A11 补 Windows 等效断言**（`tasklist`/`taskkill`）；
>   ⑤**省略 `modelCatalog` 时 `validateModel` 成员形态写死**（不实现 → 跳过校验）；⑥A6 补 fork 判据 OR 语义（任一可用即放行）；
>   ⑦W1 重复行删除；§3.9 modelCatalog 代价补「陈旧展示」用户可见面。
> - v9（2026-09-08，R7 修复——2 must-fix + 3 suggestion）：
>   ①**conformance 禁 detached 改为可执行机制**（SDK `spawnEngineChild` 原语不暴露 detached + 静态断言「引擎包无绕过 helper 的直接 spawn」+ POSIX `kill(-pid,0)` 组探测挂 A3；Windows 显式登记无外部判据）；
>   ②**宿主崩溃场景双向兜底**（引擎侧反向请求超时自灭 + 宿主启动 pidfile 清扫；§3.9 新增登记 + A8④ 验收）；
>   ③删除 v8 残留重复行；④W2 补齐 `validateModel` 省略态映射；⑤modelCatalog 代价补恢复路径。
> - v10（2026-09-08，R8 修复——4 must-fix + 4 suggestion）：
>   ①**pidfile 带宿主/实例维度**（`engine.<hostKind>.<hostPid>.pid`，不共用单文件）+ 清扫**三条件**（pid 存活 + cmdline 校验 + 宿主已死）+ A8④ 改「**同宿主内**不双实例、双宿主互不误杀」；
>   ②**自灭主判据改 stdio EOF**（stdin EOF/EPIPE），超时只对 **in-flight 反向请求**计时（env 改 `XYZ_ENGINE_HOST_REQUEST_TIMEOUT_MS`），A8④ 补「静默长任务不被自灭」负向验收（ADR-0047 反向通道版）；
>   ③**「孙进程零残留」限定范围**（一代子进程 + 组内后代；pi rpc-mode detached 后代按 §3.9 已接受代价，量级表述据实修正）；④conformance 静态断言加 allowlist（探测/收割命令例外）。
>
> - v11（2026-09-08，**分层拆分**）：设计层收敛后，按 dev-flow 分层把**实现级细节**下沉到 [`subagent-engine-protocolization.impl-plan.md`](subagent-engine-protocolization.impl-plan.md)（帧字段级 JSON / env 键表与生成物名 / manifest 字段表 / pidfile 命名与清扫判据 / 自灭阈值 / conformance 断言形式 / W 单元领地与测试命令）；
>   本文件保留决策、不变量、数据流、错误语义、验收场景与粗粒度拆分。R9 的实现级残留改在 plan §7.2 跟踪。
> **分层声明（2026-09-08）**：本文件是**设计层**（决策 / 不变量 / 数据流 / 错误语义 / 验收场景 / 下一层拆分）。
> **实现级细节（帧字段级 JSON、env 键表与生成物名、pidfile 命名与清扫判据、自灭阈值、conformance 断言形式、
> 单元领地与测试命令）的 SSOT 已下沉至 [`subagent-engine-protocolization.impl-plan.md`](subagent-engine-protocolization.impl-plan.md)**。
> 后续改动实现级细节改 plan，不改本文件；本文件只在**决策或语义**变化时修订。

> 关联：`zcode-session-db-isolation.md`（前置小改，其改动最终落在 `zcode-subagent-cli` 包内）；
> `../architecture/subagent-engine-abstraction.md`（EnginePort 抽象层；其中「reader 划为双端复用共享只读模块」
> 的裁决由本设计**显式反转**，见 D9）。

---

## §1 背景目标

**SCQA**

- **S（现状）**：`subagent-core` 已有引擎中立抽象——`EnginePort`（9 成员）+ 中立类型 + 公共降级层 +
  三层路由 + conformance 套件，`pi` 与 `zcode` 两个引擎**以 TS 模块形式内建在 core 里**，
  经进程内 `registry.ts` 的 `id → factory` 注册表取用。
- **C（冲突）**：抽象层做得对，但**分发形态绑死了扩展方式**：
  ① 新增引擎要改 core 源码；② 引擎与 core 版本耦合；③ 引擎无法独立演进/测试/授权；
  ④ 打包把引擎烘进 extension bundle，宿主只能整包 vendor core。
- **Q（问题）**：怎么让「引擎」变成**可独立安装、可独立演进、core 零改动**的插件，
  同时不破坏 EnginePort 语义、既有 record/journal 数据、两个宿主的零改动承诺？
- **A（答案）**：**引擎协议化 + 实现外移**。core 保留「壳」；引擎变成 CLI 包，
  通过 **manifest 自注册** + **NDJSON stdio 协议（engine-protocol v1）**与 core 通信。

**系统是什么**（给不熟悉内部的读者）：`subagent-core` 是跨宿主（xyz-agent 的 pi 壳 / zsw 的 zcode 壳）
共享的 subagent 执行与 workflow 编排核心。模型调用 `subagent` / `workflow` 工具后，
core 负责：选引擎 → 建 journal → 派发任务 → 收集事件流 → 落 record → 供 GUI 读历史。
「引擎」= 真正干活的 coding agent（pi / zcode / 未来 claude-code、codex…）。
今天引擎是 core 里的一个目录；本设计后，引擎是**一个独立的可执行程序**。

**设计目标**（从使用者/接入者视角倒推）

| # | 目标 | 视角 |
|---|------|------|
| G1 | 新增引擎零改 core | 接入者：写一个 npm 包（CLI 入口 + manifest），装上即出现在引擎选择器并可用 |
| G2 | 引擎与 core 解耦演进 | 接入者：引擎包按自己节奏发版；协议版本协商 + conformance 套件守契约 |
| G3 | 宿主/使用者零感知 | 使用者：subagent / workflow 的入参、返回、GUI 展示、record、历史详情完全不变 |
| G4 | 故障隔离 | 使用者：引擎进程崩溃/挂死只影响该引擎在途任务，不拖死宿主与其他引擎 |
| G5 | 现有能力零回归 | 使用者：pi / zcode 迁移后行为等价（事件、abort、凭据、池化、历史读取、chat 续聊） |
| G6 | 三形态分发一致 | workspace 开发态、Electron 打包态、npm + zsw vendor 态下发现与运行一致 |

**迁移范围（用户裁决 2026-09-08，硬约束）**：**`pi` 与 `zcode` 两个引擎都必须完成外移**，
**不允许任何内置引擎例外**。驱动细节重写归各自提取设计（§5 末），但「迁移完成」属本设计验收范围，
> **【2026-09-09 实施期裁决注记 → 已收口（2026-09-09 协议 v1.x）】** zcode 已全量外移（engines/zcode 删除）；pi 的 **chat 续聊域**曾存在一处**临时显式豁免**——v1 协议 8 反向通道未含 HostBridge 载荷面（ChatRoundTicket/长驻轮/resume），chat 域 inproc 分支保留（engines/pi 仅余 chat 专用面）。**该豁免已随协议 v1.x 载荷扩展落地收口**：第 9 反向通道 `host/roundLifecycle`（settled/idle+anchor/failed）+ `RunParams.chat` 会话形态 + `interact` 激活承载续聊/插话/关断，`engines/pi` 整目录删除（含旧 143 误分类器），pi 引擎单一 CLI 形态达成。权威源 = [chat-domain-v1x-liveness-governance.md](chat-domain-v1x-liveness-governance.md)（D1/D3/D5）。
完成定义见 §3.8 D6。

**in scope**：引擎协议 v1；引擎 SDK 包；core 壳侧边界；发现与注册（manifest + 配置 + 搜索路径 + 时机）；
引擎进程生命周期；三个宿主的接线与改动清单；打包与分发三形态；迁移策略与回退；conformance 套件；
错误规格与恢复指引；宿主伴生写入面登记。

**out of scope**：
① 具体引擎的驱动细节重写——归各自提取设计；细节外置**不豁免** DoD；
② 引擎协议的**网络/远程**形态（v1 只做本机 stdio）；
③ 引擎市场 / 自动下载安装（v1 只做「本地已安装包的发现」）；
④ EnginePort 成员签名变更（本设计不改签名，只改「谁实现它、跑在哪」）；
⑤ `~/.zcode/cli/{artifacts,exec,log,…}` 伴生写入面治理（由 `zcode-session-db-isolation.md` §2.4.1 登记）。

---

## §2 现状与问题分析

### 2.1 现状架构（进程内多引擎）

> **[v1.x 已收口]** 本图为协议化交付时点（2026-09-08 事实基准）的结构快照：`engines/zcode/` 已随协议化外移删除（W11，commit `6d5f6747d`——W5 仅完成引擎包迁移拷贝，core 侧目录双轨保留至 W11 删除）、`engines/pi/` 残余已随 chat 域协议 v1.x 收口整体删除（commit `0df9ef8b3`）——`engine/engines/` 目录现不存在，见 §1 迁移范围的收口注记。现引擎形态 = `zcode-subagent-cli` / `pi-subagent-cli` 两 CLI 包（§3.1 目标架构）。

```
宿主进程（pi 扩展进程 / zsw CLI 进程）—— runtime 进程是第三处消费方（见 P8）
 └─ @zhushanwen/subagent-core（同一进程内）
      ├─ orchestration/   SAR、workflow 引擎、record-store、journal
      ├─ execution/engine/
      │    ├─ port.ts        EnginePort（9 成员，:153-211）
      │    ├─ registry.ts    id → factory（globalThis slot 单例）
      │    ├─ routing.ts     三层优先级 + probe + fallback（:116-198）+ pi 同步短路（:262-278）
      │    ├─ engine-discovery.ts  registry → <agentDir>/subagents/engines.json
      │    ├─ common/        capability-gate / schema-emulation / persona-router /
      │    │                 kill-chain / nesting-guard / journal-replay / session-view-service
      │    └─ engines/
      │         ├─ pi/       PiEngine + session-runner + reader + …（12 个 .ts）
      │         └─ zcode/    ZcodeEngine + connection + session-channel + reader + …（10 个 .ts）
      └─ index.ts  barrel（registerPiEngine / registerZcodeEngine / killAllSpawnedChildren 等公共面）
```

引擎与 core **同进程、同依赖树、同版本**；引擎通过 `EnginePort` 被调用，
通过 `RunContext` 回调（onEvent / onHandleReady / onPoolResolved / onChildSpawned / stream / schemaEnv / ctxModel）
与宿主交互。

### 2.2 问题清单（每条都指向「分发形态」而非「抽象设计」）

| # | 问题 | 证据锚点 | 后果 |
|---|------|---------|------|
| P1 | 新增引擎要改 core | `registry.ts:130 registerEngine` 只接受**进程内工厂**；`index.ts:96/98` barrel 逐个导出 registration | 第三方无法接入；每次接入 = core 发版 |
| P2 | 引擎与 core 版本耦合 | 引擎实现 import core 内部路径，dist 双形态下靠 `exports` 收窄约束 | 引擎升级必须跟着 core 发版 |
| P3 | 打包烘焙 | `scripts/bundle-extensions.mjs` esbuild inline 全部 value 依赖（仅 pi virtualModules external） | 换引擎 = 重新打包整个扩展 |
| P4 | 宿主 vendor 粒度 | zsw 只能 `lib/vendor/subagent-core`（整包 dist） | 换一个引擎要 vendor 整包 |
| P5 | 引擎实现混入宿主面 | pi 引擎依赖 `PiEngineService`（`pi-engine.ts:140/168`）、`lifecycle-manager`、`spawnedChildren` | 外移时无法直接搬 |
| P6 | 动态发现只到「清单」 | `engine-discovery.ts` 从**代码注册表**生成 `engines.json`；扩展 `package.json.xyz-agent.subagentEngines` 只是**冷启动回退清单**（`runtime/session-records.ts:334-392`） | 有「清单」但没有「装载」 |
| P7 | 故障域共享 | 引擎适配器与宿主同进程 | 适配器崩溃/挂死可拖垮宿主 |
| P8 | **第三处消费方被漏掉** | `packages/runtime` 直消费 `readSubagentHistoryMessages`（`runtime/src/services/session/subagent-engine-history.ts:26/59`）做 GUI 详情页①级读；该进程**从不 `configureCore`**、无引擎注册 | reader 外移后 runtime 无路可走 → 历史详情静默丢内容 |

### 2.3 事实基准（代码盘点，2026-09-08；行号已 read 源核准）

| # | 事实 | 锚点 | 置信 |
|---|------|------|------|
| F1 | EnginePort 契约：`id / capabilities() / probe() / run() / interact() / read() / listModels?() / validateModel?() / dispose?()` | `execution/engine/port.ts:153-211`（文件 211 行） | 【实测】 |
| F2 | 注册表是**进程内**的：`EngineFactory = () => EnginePort`，`globalThis` slot 单例 | `registry.ts:24/73-186` | 【实测】 |
| F3 | 路由是纯决策层：三层优先级（`:57-68`）+ 守卫 fallback（`:116-187`、`fallbackTargetId:189-198`）+ pi 同步短路（`routeEngineForHost:262-278`） | `routing.ts` | 【实测】 |
| F4 | 引擎清单已有**元数据出口**：`xyz-agent.subagentEngines` + `engines.json`（契约 `v:1, engines: string[]`），GUI 选择器消费 | `extensions/universal/subagent-workflow/package.json:34`、`runtime/src/services/session/session-records.ts:334-392`、`engine-discovery.ts:1-61`、`extension-protocol/src/extensions/subagent-engine/contract.ts:20-32`、`renderer/src/components/settings/agent/SubagentEngineSection.vue` | 【实测】 |
| F5 | zcode 引擎**目录自包含但依赖 core 公共层**：静态 import `common/schema-emulation`（`zcode-engine.ts:45-47`，调用 969/1237）、`common/kill-chain`（`:49`、`connection.ts:42`）、`common/nesting-guard`（`connection.ts:43`）、`common/journal-replay`（`:51`）、`paths.ts`（`:64`）、`common/data-dir` + `registry.ts`（`registration.ts:11-12`）——**「只依赖 logger/错误工具」不成立**，这是 D7 的直接动因 | 上述行号 | 【实测】 |
| F6 | pi 引擎**与宿主强耦合**：`PiEngine({getService})` 消费 `PiEngineService`（`pi-engine.ts:140-159`，含 `executeAndAwait`、`run:296`）；静态 import `session-runner.ts`（`:48-49`）、`lifecycle-manager.ts`（`:50-55`）、`stdin-writer.ts`（`:57-62`）；`engines/pi/reader.ts:32` import `session-reconstructor.ts`（core 基础设施，`record-store.ts:44` 也在用） | 上述行号 + `subagent-service.ts:377/2555-2580` | 【实测】 |
| F7 | core 与宿主的唯一环境契约是 `HostServices`（`dataRoot`/`log`/`discoveryRoots?`），**只有 agents/skills/workflows 三个 kind，无 engines** | `core/host-services.ts:28-45`、`extensions/universal/subagent-workflow/src/host/pi-host.ts:138-150` | 【实测】 |
| F8 | 已有**同款协议先例**：relay 代理用 NDJSON 握手 + `v` 版本 + reject reason + 退出码 10–13 | `relay/relay.mjs:1-30`、`execution/relay-env.ts:14-33`、`docs/architecture/subagent-realtime-channel.md` | 【实测】 |
| F9 | 出站 env 有强制契约：子进程 env 必须经 `buildOutboundChildEnv`（C-proc-09）；**该函数在 `@xyz-agent/shared`（产品包，zsw 不可依赖）**；守卫 `check_spawn_env_boundary.py` 的 `SCAN_ROOTS` 只含 `packages/runtime/src` + `apps/electron/main`；pi 侧 `buildChildEnv` 直接 `{...process.env}`（`session-runner.ts:1759-1799`，未剥 5 个泄漏变量） | `packages/shared/src/spawn-env-contract.ts:121`、`.githooks/check_spawn_env_boundary.py:37-41` | 【实测】 |
| F10 | 打包把引擎 inline；external 边界 = pi virtualModules；runtime 用 `noExternal` + **bare `import("sqlite")` 守卫** | `scripts/bundle-extensions.mjs:23-56/281`、`packages/runtime/tsup.config.ts:54/85-95` | 【实测】 |
| F11 | 宿主**直接调用将被删除的公共符号**：扩展 `src/index.ts:37/103`（`killAllSpawnedChildren`）；zsw `lib/runner-core.js:75/161/428`（`registerZcodeEngine`/`createZcodeEngine`/`killAllSpawnedChildren`）+ 自持引擎表 + 注入 `probe/getEngineFn/...` | 上述行号 | 【实测】 |
| F12 | 测试面深路径消费：14 个扩展测试文件 import `engines/pi/session-runner.ts` 等；core 内 `session-runner.test.ts`/`kill-all-escalation.test.ts`/conformance 随目录存在 | `extensions/universal/subagent-workflow/src/__tests__/*` | 【实测】 |

### 2.4 为什么「只做目录拆分 / 只做进程内插件」不够

| 候选 | 为什么不解决根本问题 |
|------|---------------------|
| 把 `engines/` 移到单独 workspace 包，仍 `import` 进 core | 仍是**编译期耦合 + 同版本发布**（P2）；打包仍 inline（P3）；第三方仍需改 core 依赖清单 |
| 用 `import()` 动态加载插件包（进程内） | 插件必须与 core **同进程同依赖树**（版本/依赖冲突无隔离）；插件崩溃拖垮宿主（P7）；插件要用 core 内部类型 = 仍耦合内部（P2 换形式） |
| 只做 manifest 清单（现状延伸） | 只能「列出」，不能「装载」（P6） |

**结论**：只有**进程边界 + 协议**能同时满足 G1/G2/G4/G6——协议是唯一的解耦面。

---

## §3 解决方案

### 3.1 目标架构

```
宿主进程（pi 扩展 / zsw CLI）——业务代码零改动（靠 §3.6 D8 兼容公共面保证）
 └─ @zhushanwen/subagent-core（壳）
      ├─ 编排层（不变）：SAR / workflow / record-store / journal / session-view 投影
      ├─ 路由层（签名不变）：三层优先级 + probe + fallback（routing.ts）
      ├─ 注册表（改造）：id → EngineDescriptor（只持有「怎么启动」+ 声明的能力位）
      │     └─ 发现器：manifest 扫描 + 配置覆盖 + 宿主发现根
      ├─ 协议客户端（新增）：spawn / 帧编解码 / 请求关联 / 反向通知 / 崩溃重建 / 背压
      ├─ 公共降级层（不变，且只保留引擎无关部分，见 D7）
      └─ 依赖 @zhushanwen/subagent-engine-sdk（协议类型 + 引擎侧原语）
                    │
                    │  NDJSON stdio（engine-protocol v1）
                    ▼
      ┌──────────────────────┬──────────────────────┬───────────────┐
      │ zcode-subagent-cli   │ pi-subagent-cli      │ <新引擎>-cli  │  ← 独立进程、独立依赖树、独立版本
      └──────────────────────┴──────────────────────┴───────────────┘
```

**物理数据流（进程 × 绝对路径）**——P8/H1「谁在哪个进程读①级」的答案：

```
pi 扩展进程 ──spawn──> engine CLI 进程（常驻，per engine id）
     │                       ├─ 会话/原生存储：zcode → <engineDataDir>/engines/zcode/session-db/db.sqlite
     │                       │                  pi    → <pi agent dir>/sessions/*.jsonl
     │                       ├─ launcher wrapper：<engineDataDir>/engines/zcode/appserver-launcher.cjs
     │                       └─ stderr 日志：<engineDataDir>/logs/zcode-appserver-stderr-<pid>.log
     ├─ journal：<dataRoot>/engines/<engineId>/<poolKey>/journal-<taskId>.jsonl（core 写）
     ├─ record：宿主 record 存储（core 写）
     └─ engines.json：<agentDir>/subagents/engines.json（core 写，runtime/GUI 读）

runtime 进程（GUI 详情页①级读）──spawn（按需 + idle 复用）──> engine CLI 进程
     └─ 失败 → 降②级 journal（core 的读取链内部降级）
```

### 3.2 方案对比

| 方案 | 做法 | 长期架构合理性 | 短期成本 | 风险 | 结论 |
|------|------|---------------|---------|------|------|
| **A 进程边界 + CLI 协议（推荐）** | 引擎 = CLI 包，core spawn 之，NDJSON 协议 | **好**：语言无关、依赖隔离、版本独立、崩溃隔离、可单独分发 | 中：协议 + 客户端 + 发现 + 三宿主接线 + 迁移 | 中：协议面设计不当会锁死演进；流式 IPC 开销（事件合并默认关闭，见 §3.3） | ✅ 推荐 |
| B 进程内插件（动态 import） | 引擎 = 导出 `register()` 的包 | 差：同进程同依赖树、无版本隔离、崩溃连坐 | 低 | 高：依赖冲突不可控 | 不采用（仅作过渡期兼容手段） |
| C 混合（A 为目标 + 过渡期双模） | 双模注册表：内建 factory 或 external descriptor，逐个迁移 | 好：迁移可控、可回退 | 中低（A 的一部分） | 低 | ✅ **A 的落地形态**；双模是过渡态（DoD 后删内建） |

**推荐 A（以 C 的形态落地）**，理由：① 只有进程边界能同时兑现 G2（版本独立）与 G4（故障隔离）；
② 协议是唯一能让第三方引擎与 core 解耦的界面；③ EnginePort 语义可映射到协议方法
（**含 7 处 `RunContext` 字段的反向通道补齐**，见 §3.3 映射表）；
④ 过渡期双模 + 开关给出回退路径（适用期见 D3）。

### 3.3 引擎协议 v1

**传输**：stdio NDJSON（每行一个 JSON 对象），与 zcode app-server / relay 同风格。
**帧型**（四类）：

```jsonc
// ① 请求（core → 引擎）
{ "id": 1, "method": "run", "params": { ... } }
// ② 应答（引擎 → core）
{ "id": 1, "result": { ... } }   |   { "id": 1, "error": { "code": "...", "message": "...", "recovery": "...", "data": {...} } }
// ③ 通知（引擎 → core，无 id）
{ "method": "event", "params": { "runId": "...", "seq": 1, "event": { "type": "text_delta", "delta": "..." } } }
// ④ 反向请求（引擎 → core，**必须应答**）：数据面类（`host/log`/`streamDelta`/`poolResolved`/
//    `handleReady`/`childSpawned`/`childStateChanged`）10s 未答 = 引擎故障 → 杀进程 + 在途 run 失败；
//    人机交互类（`host/askUser`/`host/permission`）**不设统一超时**——core 先回 `{ack:true}`，
//    结果异步到达；按 ADR-0047「静默 ≠ 卡死」用无进展检测/用户取消，不据此判引擎故障
{ "id": "rev-1", "method": "host/askUser", "params": { ... } }
```

**方法集（v1）**

| 方法 | 方向 | 映射 | 说明 |
|------|------|------|------|
| `initialize` | core→引擎 | 握手 | `{protocolVersion, hostInfo:{name,version,dataRoot}, engineConfig}` → `{protocolVersion, engineId, engineVersion, adapterVersion, capabilities, models?}`；**应答仅作诊断**（与 manifest 不一致 → warn 留痕，不参与判据，见下「同步成员清单」）；**`engineConfig` = L3 显式配置的 `engines.<id>.config`（`Record<string,string>`，缺省 `{}`）**，作为引擎自身配置入口透传（不放凭据）；版本越界 → `engine_protocol_mismatch`；能力位与 manifest 不符 → 按方向处理（见下「能力位」段） |
| `probe` | core→引擎 | `probe` | `{force?}` → `ProbeReport` |
| `run` | core→引擎 | `run` | `{runId, task, ctx:{poolKey, cwd, model?, schemaEnv?, ctxModel?, engineFallback?, streamMode?}}`；期间发 `event`；终态应答 `{handle, outcome}` |
| `cancel` | core→引擎 | AbortSignal | `{runId, reason}`；引擎须在 3s 内收敛终态；超时 core 走杀链 |
| `interact` | core→引擎 | `interact` | `{handle, action}` → `InteractResult` |
| `read` | core→引擎 | `read` | `{handle, dataDir}` → `SessionView`（**`dataDir` 必填**：存量池时代相对 `dbPath` 需要它） |
| `listModels` | core→引擎 | `listModels?` | `{}` → `{models: [...] \| null}`（**诊断面**；宿主侧同步成员读 manifest，不经本方法） |
| `validateModel` | core→引擎 | `validateModel?` | `{modelRef?}` → `{canonicalRef}`（**诊断面**；宿主侧同步成员读 manifest） |
| `dispose` | core→引擎 | `dispose?` | `{}` → `{ok:true}`；幂等 |
| `ping` | core→引擎 | 健康检查 | 诊断/重建判据（ADR-0047：静默 ≠ 卡死，不据此杀任务） |
| `host/log` | 引擎→core | 日志 | 引擎日志落宿主日志 |
| `host/askUser` / `host/permission` | 引擎→core | 交互 | 未实现的能力回 `{unsupported:true}` |
| `host/streamDelta` | 引擎→core | `ctx.stream` | UI 实时通道（双通道之一） |
| `host/poolResolved` | 引擎→core | `onPoolResolved` | **journal 落盘路径的单一权威**（须在首个事件 emit 前调用） |
| `host/handleReady` | 引擎→core | `onHandleReady` | 运行中句柄回填（AGENTS.md 关键规则 9 的前提） |
| `host/childSpawned` | 引擎→core | `onChildSpawned` | 上报引擎内一次性子进程 pid（**用途 = `isResumable` 镜像谓词 + 诊断留痕**；**不再声称「供杀链/收割」**——v6 已删按 pid 补杀，收割只靠进程组，见 §3.6 D2；常驻进程不报，归 `dispose`） |
| `host/childStateChanged` | 引擎→core | `onChildSpawned` 的**状态面** | `{pid, recordId, state: running\|exited, killed: boolean, exitCode?, signal?}`——core 侧镜像用于 `hasLiveProcessHandle`/`isResumable`（同步读镜像，不跨进程查询）；**载荷必含 `killed`**（实装判据 `child !== undefined && !child.killed`） |

**RunContext 字段映射表**（逐条钉死）：

| RunContext 成员 | 协议承载 | 缺失后果 |
|----------------|---------|---------|
| `taskId` / `poolKey` | `run.params.ctx` | journal 归属错 |
| `signal` | `cancel` 帧 + 杀链 | 无法取消 |
| `onEvent` | `event` 通知 | 无事件流 |
| `stream` | `host/streamDelta` | UI 实时刷新丢失 |
| `onPoolResolved` | `host/poolResolved` | journal 路径与 handle.poolKey 分叉 |
| `onHandleReady` | `host/handleReady` | 运行中 GUI 详情页恒③级 |
| `onChildSpawned` | `host/childSpawned` + `host/childStateChanged` | 子进程泄漏 + `isResumable` 同步谓词失真 |
| `ctxModel` / `schemaEnv` / `engineFallback` | `run.params.ctx` | model 兜底/结构化输出降级 |

**同步成员清单（`EnginePort` 的四个同步面，逐条给源——协议化后无同步源即锁死）**：

> **单一同步源原则（v6 减法收敛）**：同步成员**只读 manifest**，**不读任何握手产物、不设缓存**。
> 被否谱系：「握手后填充缓存 + 失效时机 + 保鲜/陈旧守卫 + 三态映射」——四轮审查中该机制每轮都新生一处矛盾
> （缓存生产者与失效时机互相打架 / `initialize.models` 三态未写死 / 免探路径握手永不发生而缓存恒空），
> 而它解决的问题（同步可用）**用 manifest 直读即可解决**。握手降为**诊断面**：应答与 manifest 不一致 → warn 留痕，
> **「不参与判据」的确切边界（防绝对句过宽）**：握手应答**不参与同步成员（`capabilities` / `listModels` / `validateModel`）的判据**；
> 能力位**方向判定**仍以 manifest 为权威，握手仅在两处生效：① **被 gate 位多声明** → run 失败（**唯一阻断面**）；
> ② **非 gate 位不一致** → **仅 warn 留痕，绝不阻断 run**（即使该 run 名义上「依赖」该位——文档不为它设阻断路径，否则与「握手降为诊断面」自相矛盾；若依赖未满足导致运行期失败，按引擎自报错误走）。

| 同步成员 | 消费者（实测锚） | 同步源 | 失败/降级语义 |
|---------|----------------|--------|--------------|
| `capabilities()` | `capability-gate.ts:53-88`（`subagent-service.ts:2010` / `subprocess-agent-runner.ts:159`） | **manifest `capabilities`**（注册期读，无缓存） | 见下「能力位」段 |
| `listModels()` | `model-prompt.ts:145-146`（system prompt **同步**拼串，经 `index.ts:128` 导出） | **manifest `modelCatalog.models`**（构建期生成） | **三态映射（照实装 `model-prompt.ts:143-150`，源改为 manifest）**：manifest **省略 `modelCatalog`（或 `models: null`）** = 「引擎无枚举面」→ `buildCoreAlignedHint`；**显式 `models: []`** = 「有枚举面但空」→ `buildEmptyModelsHint`；数组 → 正常段。**「省略」态必须可达**——解析器**不得**把省略填成 `models: []`（否则恒走空列表提示，与事实不符，见 §3.4 缺省策略） |
| `validateModel()` | `model-validation.ts:57-64/169-174` → `subagent-service.ts:1913` / `subprocess-agent-runner.ts:168`（**record 创建前**） | **与 `listModels` 同源**：manifest `modelCatalog`（同一字段，不设第二份）；带 `dynamic: bool`。**成员形态映射（必写死）**：manifest 省略 `modelCatalog` → **成员不实现（`typeof validateModel !== "function"` → 跳过校验，等价恒放行）**；显式声明 → 按 `dynamic` 判 | 命中 → 返回 `canonicalRef`；未命中且 `dynamic:false` → 同步拒（`engine_model_unknown`，语义不变）；未命中且 `dynamic:true` → **放行** + 运行期以引擎为权威，不配套则 run 失败（`engine_model_mismatch`）+ record 标 failed——**显式放宽原「record 创建前拒绝」不变量**（契约变更，A6⑤ 两方向）。**`canonicalRef` 拆分在 core（实测 `subagent-service.ts:1918-1927` + `record.model = provider/id` `:1956`）**：放行时引擎只能回原样 ref → core 必须**改 `resolveIdentityForEngine` 与续聊回读（`:1398-1405`）对无斜杠 ref 的处理**（`provider=""`、`id=ref`，整串进 `name`），否则落成 `"<ref>/"` 畸形；该改动是**第 4 条契约变更**，回写 `port.ts:194` / `model-validation.ts:48` 的「canonical 全名」注释 |

**`modelCatalog` 生成与一致性**：引擎包**构建期导出**（`pnpm --filter <pkg> gen:model-catalog` 写进 package.json manifest）+ CI 校验
（与引擎声明的模型清单一致）；运行时引擎 `listModels` 应答与 manifest 不一致 → **warn 留痕（诊断）**，不参与判据。
（被否：「握手应答更新缓存」——免探路径握手永不发生 → 缓存恒空 → `validateModel` 回落静态目录仍能跑，等于缓存无意义；且缓存失效时机在多轮审查中持续产生新矛盾。）
| `probe()` | `routing.ts:132`（非 pi 路径先 await，本就在异步路径） | 协议 `probe` | 既有三守卫不变 |

**能力位（capabilities）**：`EnginePort.capabilities()` 是**同步**接口。协议下权威分两步：
**①manifest 声明（同步可用，注册期即读）**；**②握手校验**——**时序钉死**：免探路径（pi 缺省，`routing.ts:262-278`）
的首个 gate 判定**仍用未校验 manifest**，而协议客户端在**首个 `run` 前强制 `initialize`**。
但 `capability-gate`（`capability-gate.ts:53-88`）在 **record 创建前同步拦四类**：`conversation` / `fork` / `maxTurns` / `worktree`
（调用点 `subagent-service.ts:2010` / `subprocess-agent-runner.ts:159`）——**gate 先于 `initialize`**，故：

| 能力位类型 | 权威 | 不一致处置 |
|-----------|------|-----------|
| **被 gate 的四类任务形态**（`conversation` / `fork` / `maxTurns` / `worktree`） | **manifest 是权威契约**（gate 同步读，无法等握手）。**注意判据涉及的能力位 ≠ 形态名**：实装 `capability-gate.ts:58/67/76/84` 读的是 `conversation`（conversation 形态）/ `steer`+`conversation`（fork 形态）/ `maxTurns` / `sandbox`（worktree 形态）——**这四个能力位同属 manifest 权威面**，其余能力位（personaInjection / eventGranularity / sessionRead / resume / interrupt / permissionMode / schemaEnforcement）归握手诊断面 | 少声明 → **首个调用同步拒**（`engine_capability_unsupported`）；**恢复指引 = 「修 manifest（或升级引擎包）」**——不写「先派一次任务触发握手」（gate 读 manifest，握手不参与同步判据，那个指引是空转）；多声明 → 首个 run 的 `initialize` 发现 → **该 run 失败 `engine_capability_mismatch` + record 标 failed**，并**清理 run 前已建的前置副作用**（worktree：`subagent-service.ts:2053-2077` 在 `kickOffEngineRun` 前创建，`finalizeFailed` `:2725-2736` 不清理 → 本设计新增「run 期失败路径清理 worktree/池」，登记为第 5 条契约变更） |
| **非 gate 能力位**（schemaEnforcement / personaInjection / eventGranularity / sessionRead / resume / interrupt / permissionMode——**不含 `steer` / `sandbox`**，二者属被 gate 面） | **manifest 为权威，握手仅诊断** | **不一致（无论强弱）→ 一律 warn 留痕，不阻断 run**（若该 run 依赖该位而未满足，引擎自行报错；core 不据此失败——与「握手降为诊断面」一致） |

> 「强于 manifest → 放行」**只对非 gate 能力位成立**（被 gate 位少声明时首个调用已被同步拒，握手永不发生——这是 gate 先行的结构性结果，不是遗漏）。
> 同批回写 `capability-gate.ts:12-16` 与 `subagent-service.ts:2005-2009` 的注释（「全部同步拒绝发生在 record 创建前」→ 补「manifest 多声明的情形由 run 期握手失败兼底，并清理前置副作用」）。

**被否**：「未握手时返回保守能力位」——击穿反例：pi 缺省路径的 `conversation:true` / `maxTurns` /
`worktree` 会被 `capability-gate` 全部拒掉（G3/G5 首轮即破）。

**事件与背压**：`event.params.event` 就是现有 `AgentEvent`（8 种）逐字序列化；journal 落盘仍在 core。
**默认关闭事件合并**（`XYZ_ENGINE_EVENT_COALESCE=0`）——A1 要求「事件逐字段等价」，
合并（16ms/4KB）与逐字段等价不可兼得。合并开关保留，启用需另立验收（量级/恢复/重审）后方可默认开。
**stdout/stderr 分工**：stdout 独占 NDJSON（行解析器 + 背压：core 读得慢时靠 OS 管道背压，不做无界缓存）；
**stderr 必须常驻排空**（内存环形缓冲尾 400 字符，崩溃现场由 `engine_crashed` 帧携带）——**宿主侧不落盘**
（落盘会引入宿主侧新写入面，而宿主日志清理只认 `runtime-`/`pi-` 前缀；见 §3.9）；只 pipe 不消费会因管道缓冲满**阻塞引擎进程**（长跑必发生）。

**取消语义**：`cancel` 首选；core AbortSignal → `cancel` → 等 3s → 未收敛则杀引擎进程；
进程死亡 = 该引擎**全部在途 run** 失败（错误含 stderr 尾 400 字符）。

**版本协商**：`ENGINE_PROTOCOL_VERSION = 1`（core 支持 `>=1 <2`）；越界 → `engine_protocol_mismatch`
（含双方版本 + 升级指引），该引擎标记不可用，不影响其他引擎与宿主。

**错误码**

| code | 触发 | core 行为 / 恢复指引 |
|------|------|---------------------|
| `engine_not_found` | 配置/清单里的 id 无对应包 | 列出已发现引擎 + 配置路径 |
| `engine_protocol_mismatch` | 握手版本越界 | 该引擎不可用；升级 core 或引擎包 |
| `engine_capability_unsupported` | **core 的 gate 同步拦**（manifest 少声明被 gate 四类之一） | 文案随本设计变更（「修 manifest / 升级引擎包」）；该码由 core 生成，不属「引擎 error 帧透传」 |
| `engine_capability_mismatch` | manifest 声明 ≠ 握手能力位 | **仅被 gate 位多声明** → 该 run 失败 + 清理前置副作用；**非 gate 位不一致 → 一律 warn（不阻断）** |
| `engine_model_unknown` | `validateModel` 未命中且 `modelCatalog.dynamic=false` | 同步拒绝（record 不创建） |
| `engine_model_mismatch` | `dynamic=true` 时运行期引擎拒绝该 model | run 失败 + record 标 failed（契约变更，见 §3.3 同步成员清单） |
| `engine_handshake_timeout` | `initialize` 超时（10s） | 该引擎不可用；检查引擎包是否可执行 |
| `engine_crashed` | 进程意外退出 | 在途 run 失败（附 stderr 尾）；下次 run 重建（最多 3 次指数退避 1s/2s/4s，超过则标记不可用直到下次宿主启动） |
| `engine_probe_failed` | `probe` 失败 | 既有 fallback 三守卫不变 |
| 其余 `engine_*` | 引擎在 `error` 帧原样给出 | core 透传，文案契约不变 |

**安全与 env（设计级契约；实现级键表/生成物/守卫断言见 `subagent-engine-protocolization.impl-plan.md` §2.12）**：
凭据**不进协议**（引擎包自己解析自己的凭据）；引擎进程 env 由 SDK 的 `buildEngineChildEnv(baseEnv, opts)` 统一构建（D7）。
**三层语义（高者覆盖低者）**：
1. **基础设施层（core 在过滤之后注入）**——引擎数据根、执行器路径、nesting guard、**relay 三键（必须到达引擎，否则嵌套 subagent 静默回落直连）**；
2. **deny / 显式剥除层（恒高于 manifest 放行）**——出站 deny 清单 + 产品凭证键 + 父身份键（relay 的 `SESSION_ID`/`RECORD_ID`）；
3. **manifest 放行层**——引擎专属命名空间前缀；**保留前缀拒绝表**（产品命名空间不得被第三方声明）；非法条目丢弃该前缀并 warn（包继续可用）。
**不变量**：基础设施层键集合与 deny 集合恒不相交（守卫断言）；用户无法为引擎注入其 manifest 未声明、引擎未实现消费的 env（已接受能力放弃，重审触发见 impl-plan）。

**relay 转发语义（与 H12 一致）**：relay 的**连接三键必须透传**（嵌套 subagent 的唯一供数面，缺一即静默回落直连）；**父身份键必须剥除**，由引擎按运行上下文重写（防父身份误归属）。实现级键名与重写位置见 impl-plan §2.12。

**基座常量来源（单源 + 构建期派生）**：SDK 的前缀/deny 常量由 `packages/shared/src/constants.ts` SSOT **构建期生成**
（生成物名 `ENGINE_ENV_PREFIXES` / `ENGINE_ENV_DENY_LIST`，与 `modelCatalog` 同款构建期生成口径）；**守卫断言**：L0 基础设施键集合 ∩ L1 deny/剥除集合 = ∅（防未来 deny 清单误伤 L0 键）。
core 与引擎**统一从 SDK 读**——**不引入 core → `@xyz-agent/shared` 运行时依赖**（该包 `private: true`，会给已发布 core
造成独立用户解析失败）。守卫 = 生成物与 SSOT **逐项相等** + CI 重生成校验（`check_env_whitelist_sync.py` 加**新断言**，
**不**把 SDK 塞进 `FORBIDDEN_DIRS`——那是同名常量唯一性检查，塞进去会自锁）。

**登记回写**：`XYZ_ZCODE_CLI`（`registration.ts:34` 消费）等 B3 出站白名单条目随包迁移，须同批回写
`docs/design/env-propagation-boundary.md`；守卫 `check_spawn_env_boundary.py` 的 `SCAN_ROOTS` 扩展覆盖 SDK 与引擎包，
**同批把 `buildEngineChildEnv` 登记为可接受构建器符号**（否则引擎包内既有 spawn 点 4 处一扩即红）。
**验收**：A6 增「用户旋钮（`ZCODE_APPSERVER_TURN_*_TIMEOUT_MS`）跨进程仍生效」+「`XYZ_AGENT_API_KEY` 零命中」观测点。

### 3.4 发现与注册

**引擎包 manifest**（写进引擎包自己的 `package.json`）：

```jsonc
{
  "name": "@zhushanwen/zcode-subagent-cli",
  "bin": { "zcode-subagent-cli": "./dist/cli.mjs" },
  "xyz-agent": {
    "subagentEngine": {
      "id": "zcode",
      "protocol": 1,
      "displayName": "ZCode",
      "description": "驱动 ZCode app-server 的 subagent 引擎",
      "bin": "zcode-subagent-cli",
      "envPrefixes": ["ZCODE_"],          // 引擎私有 env 命名空间（放行清单，见 §3.3 env 段）
      "modelCatalog": {                   // 同步 validateModel/listModels 的静态源（见 §3.3 同步成员清单）
        "dynamic": true,                  // true = 运行期可能有用户自定义模型 → 未知 ref 放行、运行期裁定
        "models": [ { "id": "glm-4.6", "aliases": ["glm"], "canonicalRef": "zai/glm-4.6" } ]
      },
      "capabilities": {                    // 同步能力位权威（注册期读；握手校验，见 §3.3）
        "schemaEnforcement": "emulated", "steer": "unsupported", "conversation": "unsupported",
        "personaInjection": "prompt", "eventGranularity": "stream", "sandbox": "emulated",
        "sessionRead": "full", "resume": "cold", "interrupt": "kill-only",
        "permissionMode": "fixed", "maxTurns": false
      }
    }
  }
}
```

**manifest 必需字段与缺省策略（设计级语义；字段级 schema 与逐字段缺省表见 impl-plan §2.4）**：
- **自注册的最小集**：`id` / `protocol` / `bin` / `capabilities`（至少声明三项被 gate 判据涉及的能力位）；缺必需键 → 保守值 + warn；
- **`capabilities` 是同步能力位权威**（注册期读，gate 同步消费）；
- **`envPrefixes`**：引擎专属 env 命名空间，保留前缀不得声明，非法条目丢弃该前缀并 warn；
- **`modelCatalog`**：同步 `validateModel` / `listModels` 的唯一源；**缺省 = 不注入**（保持「无枚举面」语义可达）；
  缺省 + `dynamic:true` 的权衡（未知 ref 恒放行、typo 无同步防护）已登记，重审触发见设计 §3.9 代价表。

**搜索路径（三级，无内置回退清单）**

| 层 | 来源 | 用途 |
|---|------|------|
| L1 宿主发现根 | env `XYZ_AGENT_ENGINE_ROOTS`（**分隔符 = `path.delimiter`**，即 `:`/`;`；去重、大小写敏感、非绝对路径丢弃 + warn）+ `HostServices.discoveryRoots()` 新增 `engines` kind | 常规安装路径（**打包态走这里**，见 §3.7） |
| L2 node 解析 | 宿主进程 `node_modules`（`require.resolve`） | 标准 npm 安装（打包态无效：staged 扩展无 node_modules；**zsw vendor 态也无效**——见 §3.6 D8） |
| L3 显式配置 | `subagents/config.json` → `engines: { "<id>": { command, args, config, cwd, enabled } }` | 用户/开发态覆盖（路径注入；**引擎包落位 `packages/`，dev-link 脚本不覆盖，见 §3.7**）；`config` 经 `initialize.engineConfig` 透传（**引擎需自行实现消费，否则是死键**）；**无 `env` 键**（v6 删 extras 层，见 §3.3 env 段被否谱系） |

**为什么砍内置清单**：原「core 自带静态清单保证至少 pi 可用」与 DoD#1「core 内无引擎实现」互斥
（静态清单 ≠ 可用）；pi 引擎包缺失时的行为由 D4「缺省引擎规格」定义。

**发现时机**：与现有 `syncEnginesFile` 同点——**session_start 扫描一次**并缓存；`hasEngine()`
（agent 解析期同步校验，`registry.ts:169`）查缓存快照；未命中时触发一次**同步补扫**（只读 manifest，
不握手），保证「装了包 → 下次解析即可用」。**握手惰性但有限定**：首个 `run` 前**强制** `initialize`
（见 §3.3 能力位段的时序）；**同步成员（capabilities / listModels / validateModel）全部直读 manifest，无缓存、无失效时机**
（v6 减法，见 §3.3 同步成员清单）。

**engines.json 投影面（P0-19 四问）**

| 问 | 答案 |
|---|------|
| 消费方 | runtime RPC（`session-records.ts` 读取 + 冷启动静态声明回退）、renderer 选择器（`SubagentEngineSection.vue`）、写入门 `setSubagentDefaultEngine`（清单外拒绝） |
| 投影规则 | 清单 = **已发现且可执行**的引擎 id 数组；契约 `SubagentEnginesFile{v:1, engines: string[]}` **不改** |
| 速率/单调性 | 每次 session_start 幂等写（内容不变零写） |
| 清理通道 | 引擎卸载 → 下次扫描自动消失；`defaultEngine` 指向已卸载引擎 → 加载期 warn + 回落第一个可用引擎 + record 留痕（D4） |
| 「灰显 + 原因」 | **v1 不做**（需改契约 + renderer，违反 G1/G3）；不可用引擎不进清单，派发时给 `engine_not_found` + 原因 + 恢复指引 |
| **冷启动回退源（H5 连带面，单源）** | 现状二级回退 = `engines.json` 缺失 → 读**扩展包** `xyz-agent.subagentEngines` → 最终 `['pi']`（`session-records.ts:337-392`）。H5 后该字段消失 → **回退源 = runtime 自身发现结果**（W8 三级发现，与派发同源）。**不保留静态 JSON 兜底**：零命中时静态清单列出的 id 恰好**不可派发**（无引擎被发现 = 无 bin 可执行），会让选择器出现「能选不能跑」的项，且与本节投影规则「不可用引擎不进清单」直接冲突；零命中就返回**空清单 + 「未发现任何引擎包」状态**（GUI 按既有语义给 `engine_not_found` + 安装指引）。**量级**：冷启动窗口 = 首次 RPC 前（百毫秒级）；**重审触发条件** = 出现「选择器列出不可派发引擎」或「已装引擎不可见」报告；**判定** = 可接受。同步改两个守护测试（`engines-declaration.test.ts` / `session-service-engine-config.test.ts`）；**A12⑦ 断言 = 「已安装引擎全部可见（含第三方）」** |

**冲突与失败**：manifest 缺字段/不可解析 → warn 跳过该包（不阻断其他引擎）；同 id 覆盖 → info 留痕；
`bin` 不存在/不可执行 → 标记不可用（不进清单）+ 派发错误给原因。

### 3.5 壳侧边界（保留 / 移出）

| 面 | 归属 | 说明 |
|----|------|------|
| 路由三层优先级 + 守卫 fallback | **core 保留** | `routing.ts` 纯决策，改为面向 descriptor/代理 |
| capability-gate / persona-router | **core 保留** | 引擎无关 |
| journal 落盘 / record-store / session-view 投影 | **core 保留** | 数据所有权在宿主 |
| 引擎进程生命周期（spawn/握手/重建/dispose/杀链） | **core 保留**（新增 `EngineClient`） | 与 `AppServerConnection` 同型但**引擎无关** |
| conformance 套件 | **core 保留**（改为**协议黑盒套件**） | 引擎作者可用它自测 |
| **引擎消费型公共层**（schema-emulation / kill-chain / nesting-guard / data-dir / journal-replay 的引擎侧用途） | **移入 SDK 包**（D7） | 它们不是「引擎无关」；但其中 `data-dir` / `journal-replay` / `kill-chain` **当前 import core 内部**，须先拆 seam（D7 逐条表） |
| 具体 agent 驱动（pi RPC / zcode app-server 协议） | **移出** | 各自 CLI 包 |
| 引擎侧凭据/池/HOME 隔离/配置引导 | **移出** | 各自 CLI 包（`appserver-launcher` wrapper 随包迁移） |
| 引擎原生 reader（pi JSONL / zcode sqlite） | **移出**（含白名单守卫） | 走协议 `read`；**反转**既有「双端复用共享 reader」裁决（D9） |
| 引擎专属 golden 样本 / 协议 fixture | **分开处置（裁决）** | **引擎专属 golden 随引擎包**；**core 侧基线 = 协议层 fixture（fake 引擎回放）**，落既有约定路径 `packages/subagent-core/src/execution/engine/__tests__/conformance/__fixtures__/engine-protocol/`（与 §4 基线三层一致，不新建顶层 `__fixtures__/`） |

#### 3.5.1 D7 引擎 SDK 包（新增，解决三处互斥）

**问题**：F5 证明引擎依赖 core 公共层（schema-emulation / kill-chain / nesting-guard / journal-replay / data-dir），
若把它们判为「core 保留、引擎无关」，就与不变量 1（引擎包不得 import core）互斥——二者不可能同时成立。

**答案**：新增 `@zhushanwen/subagent-engine-sdk`（独立包、独立版本）：

| SDK 内容 | 理由 |
|---------|------|
| 协议类型与帧编解码（**契约类型 SSOT**：`AgentEvent`/`EngineHandleData`/`SessionView`/`EngineCapabilities`/`ProbeReport`/`InteractAction`/`AgentCallOpts`/`AgentOutcome`） | 两侧不许各写一份；**core 反向 re-export** 保上层消费面不变（不变量 2） |
| 引擎侧原语：schema-emulation、nesting-guard、日志 facade | 无 core 内部依赖（直接搬） |
| `data-dir` 解析（`resolveEngineDataDir(env)`） | 今天 `data-dir.ts:23` import `core/host-services.ts`（引擎进程无 `configureCore`）→ **拆 seam**：SDK 版参数化/env 优先，core 侧保留 `getHostServices()` 绑定 |
| `journal-replay` 的**纯投影部分**（entry → record 的 reducer） | 今天 import `execution-record.ts:11-15`——所谓「纯 reducer」正是 core 的 `execution-record` → 下沉 SDK，**journal I/O 与②级降级链留 core** |
| `kill-chain` 的**引擎侧部分** | 今天 import `orchestration/models/types.ts:13-16` + `registry.ts`（`DEFAULT_ENGINE_ID`）+ `core/logger.ts` → 契约类型随 SDK 下沉、`DEFAULT_ENGINE_ID` 改**参数注入**、logger 走 SDK facade |
| `buildEngineChildEnv()`（env 契约） | F9：`buildOutboundChildEnv` 在 `@xyz-agent/shared`（zsw 不可依赖）——SDK 是跨宿主 SSOT |
| 身份 env 常量（`PI_SUBAGENT_*`） | 跨扩展契约锚点（`base-tool-enhance` 消费） |

core 依赖 SDK；引擎包只依赖 SDK（**不依赖 core**）。
**不变量（新增）**：**SDK 不得 import core**——守卫 `check-engine-sdk-boundary.mjs` 扫描 SDK 源码 + dist
（禁 `@zhushanwen/subagent-core` 与相对越界 `../../`）。

**类型闭包（「纯 reducer」不是叶子——逐项处置）**：

| 依赖项 | 现状 | 处置 |
|--------|------|------|
| `execution/types.ts`（1095 行，import `@xyz-agent/extension-protocol` + `orchestration/models/types.ts` + `model-resolver.ts`） | 环的中心 | **不整块下沉**：只抽「引擎面最小契约」（`AgentEvent`/`EngineHandleData`/`SessionView`/`AgentCallOpts` 等**结构子集**）入 SDK；core 域类型（`ExecutionRecord`/`Turn`/`AgentFailureKind`/`WorktreeHandle`）**留 core**，SDK 用结构等价类型（不 import） |
| `orchestration/models/types.ts`（390 行，反向 import `execution/types.ts` 成环） | `AgentCallOpts` 住所 | `AgentCallOpts` 的**引擎面子集**移入 SDK（协议 `run.params` 用它）；其余（含 `ExecutionRecord` 引用）留 core；core 侧反向 re-export 保消费面 |
| `model-resolver.ts` | `types.ts` 依赖 | 留 core（SDK 只收「已解析的 modelRef 字符串」） |
| `paths.ts`（`resolvePoolDir`，`zcode-engine.ts:64`） | F5 点名但 D7 表未列 | 纯模块（仅 `node:path`）→ **移入 SDK**（引擎侧需自算池/journal 路径） |
| `@xyz-agent/extension-protocol`（`GuiRenderResult`） | 类型闭包边缘 | 留 core；SDK 侧不引用（引擎不产 GUI 渲染结果） |
| `data-dir` / `journal-replay` / `kill-chain` | 前表已列 | 按前表拆 seam |

守卫 `check-engine-sdk-boundary.mjs` 的**基线断言**：SDK 源码 + dist 不得出现 core 包名、不得出现
指向 `packages/subagent-core/**` 的越界相对路径；挂 W1 验收（新增 SDK 代码前先建守卫）。
在 core 侧加**双向可赋值断言**（`type _A = AssertMutuallyAssignable<CoreX, SdkX>`，core→SDK 方向合法）纳入 `pnpm typecheck`，
挂 W1/W3 验收（否则「结构等价类型」= 第二份定义，字段漂移编译期抓不到；`AgentCallOpts.worktree` 的 `WorktreeHandle` 即这类副本）；
§4 基线三层的运行时序列化比对只盖住 wire 形态，不盖 TS 字段类型/可选性。

**依赖面重估**：zcode 依赖 4 个公共模块（schema-emulation / kill-chain / nesting-guard / journal-replay），
pi 依赖宿主服务面更重——**两者拆分成本都不小**；zcode 仍先迁，理由改为「无 `PiEngineService` 宿主耦合面」。

#### 3.5.2 硬耦合清单（H1–H12，全部 must-clear；**承接单元**列保证 H→W 映射闭合）

| # | 硬耦合点 | 锚点 | 处置 | 承接单元 |
|---|---------|------|------|---------|
| H1 | 公共降级层**直接 import 引擎实现**：`session-view-service.ts` 静态 import zcode `readZcodeSessionView` + `zcodeDbPathAllowlist`（2026-09 会话库隔离 W2 白名单集合化后的现行锚点；改造前旧锚点 `ZCODE_HOST_DB_SUFFIX` 已不再被该文件 import——见 zcode-session-db-isolation.md D2） | `engine/common/session-view-service.ts:38/40`、白名单 `:164`、注册 `:107/131` | 改为经协议 `read`（**runtime 进程模型见 §3.6**）；core 不再静态依赖任何引擎 | W8/W11 |
| H2 | core barrel 重导出引擎符号 | `src/index.ts:96-118/322-323` | 引擎符号迁走；**`killAllSpawnedChildren`/`registerZcodeEngine`/`createZcodeEngine` 保留为兼容薄壳**（D8） | W11 |
| H3 | package.json 暴露引擎子入口 `./engines/zcode/reader`、`./engines/zcode/constants` | `package.json` exports、`tsup.config.ts:25-26` | 随引擎外移删除；runtime 侧真实机制是 `noExternal`（`runtime/tsup.config.ts:54`）+ **bare `import("sqlite")` 守卫**（`:85-95`）——**守卫随 reader 迁往引擎包构建**；**新增**：SDK 必须加入 `noExternal`（否则打包态 `Cannot find module`） | W9/W11 |
| H4 | 引擎进程生命周期导出在 pi 模块：`killAllSpawnedChildren` | `engines/pi/session-runner.ts`、`src/index.ts:97` | 收割逻辑归 core `EngineClient` | W2/W11 |
| H5 | 引擎清单声明在扩展包 package.json | `extensions/universal/subagent-workflow/package.json:34` | 声明迁到各引擎包 manifest；扩展包只声明**依赖**；**回退源 = runtime 自身发现结果**（无静态 JSON 兜底，§3.4 投影面表） | W4/W8 |
| H6 | 引擎代码进 extension bundle | `scripts/bundle-extensions.mjs:23-56/281` | external 边界加引擎包；引擎包单独 staging | W9 |
| H7 | 跨宿主 vendor 粒度 | zsw `lib/vendor/subagent-core` | 增加 `lib/vendor/<engine>-subagent-cli`；**vendor 工具链在 zsw 仓，owner = zsw** | W9（zsw 侧） |
| H8 | pi 引擎静态 import core 内部：`session-runner`/`lifecycle-manager`/`stdin-writer`/`session-reconstructor` | `pi-engine.ts:48-62`、`engines/pi/reader.ts:32` | 逐条定归属（D2 表）：`spawnedChildren` 镜像/杀链 → core `EngineClient`；idle 定时器 → core 回收层；`sendPromptCommand`/EPIPE → pi 包；`session-reconstructor` → 保持 core，pi 包经协议拿会话视图 | W6/W7 |
| H9 | 测试面深路径消费（14 个扩展测试 + core 测试） | F12 | 随目录迁移；DoD 验证含 `pnpm extensions:test` + core test 全绿 | W10 |
| H10 | env 契约归属 | F9 | SDK `buildEngineChildEnv`（含**引擎专属命名空间放行清单**）；守卫 `SCAN_ROOTS` 扩展；pi 侧 `buildChildEnv` 迁移并补齐剥离 | W12 |
| H11 | 引擎落盘面（wrapper / stderr 日志 / 常驻进程） | `appserver-launcher.ts:144-156`、`zcode-engine.ts:656`、`connection.ts:577-578` | 随引擎包迁移；**stderr 日志轮转由引擎包自实现**（宿主 logger 只清 `runtime-`/`pi-` 前缀，看不见它）；写入面登记见 §3.9 | W11 |
| H12 | relay 通道穿透新进程边界 | `relay-env.ts`、`relay.mjs` | 引擎 CLI 必须原样转发 relay env 与 stdio（嵌套 subagent）；A6 增嵌套用例 | W2/W8 |

#### 3.5.3 路由与执行时序契约（跨进程后必须显式登记的契约变更）

- **同步返回成立**：`routeEngineForHost()` 仍**同步**返回 `RemoteEngine` 代理（构造同步，不引入 await）；
  `routing.test.ts:260-268` 的「非 Promise」断言**保留**。
- **下游时序契约作废**：`routing.ts:258` 与 `subprocess-agent-runner.ts:142` 两处声明「run 内首个 await 前已触达 `executeAndAwait`」；
  `subagent-service.ts:1178-1200` 只有「routed 非 Promise，零微任务——缺省路径时序不变」——三者**跨进程后均需改写**
  （spawn + 握手 + 帧往返必经 await）→ 同批改写为「首个 await 前完成**路由决策**；执行经进程边界，时序契约由本设计放宽」。
- **不变量 2 加例外**：EnginePort 成员签名不变，但**上述时序注释及依赖它的假设**属本设计允许变更的契约面。
- **pi 实例构造点（代理形态）**：`subagent-service.ts:377` 的 `new PiEngine({getService})` 是字段初始化器（**构造期 eager**）
  → 代理必须**构造同步、不读 descriptor**（缺包/坏包**不在构造期 throw**，descriptor 首次使用时才解析），
  否则与 D4「派发期 `engine_not_found`、坏包不拖累其他引擎」冲突。
- **观测点**：A2/A3 增「首个 await 前的路由决策可观测（engine id 已定）」「跨进程 run 首帧延迟符合预算」。

### 3.6 宿主面（三个宿主，不是两个）

| 宿主 | 现状 | 改造后 | 改动 |
|------|------|--------|------|
| **pi 扩展进程**（xyz-agent） | 组合根 `registerPiEngine/registerZcodeEngine`；扩展 `src/index.ts:37/103` 调 `killAllSpawnedChildren` | 发现器自动注册；兼容薄壳保留符号 | **零业务改动**（D8） |
| **runtime 进程**（xyz-agent） | 直消费 `readSubagentHistoryMessages` 做①级读；**从不 `configureCore`** | 成为**协议客户端**：发现源 = `XYZ_AGENT_ENGINE_ROOTS` + node 解析 + `config.json` 三级（`engines.json` **仅用于 GUI 投影，不可作发现源**——它只有 id，无 bin/command）→ 按需 spawn 引擎 CLI 调 `read`（idle 复用）→ 失败降②级 journal | 需接线（宿主改动，A7 登记） |
| **zsw CLI** | vendored core + 自持引擎表 + `runner-core.js:75/161/428` 调公共符号 | 兼容薄壳保留符号；vendor 增加引擎包目录 | **业务逻辑零改动**；允许的机械改动 = vendor 刷新 + 发现根注入（D8/A7） |

**runtime 的①级读代价与降级**：冷 spawn 约 150–400ms（本机 zcode CLI 启动量级），idle 复用后 < 50ms；
引擎包缺失/不可执行 → **降②级 journal**（有文本与 turn 结构，缺工具调用细节），GUI 详情页 `source` 字段标注。
**显式判定**：可接受；**重审触发条件**：详情页打开延迟 > 1s 或降级率 > 5% → 改为「runtime 常驻引擎连接」
或「①级结果落盘缓存」。

**runtime 侧引擎进程的生命周期与量级（补齐，P0-12/19/20）**：

| 面 | 规格 |
|----|------|
| 持有方 | runtime 自持 `EngineClient` 实例（与 pi 宿主实例**不共享**——两进程各自 spawn；同 id 会出现**两个常驻 CLI**） |
| 回收层 | idle 5min → 发 `dispose`（**上界 3s，超时即杀**，对齐 `cancel`）并杀进程（定时器 owner = runtime 的 `EngineClient`）；**退出钩子落点 = `packages/runtime/src/index.ts` 的 `shutdown()` 内、与 relay 关停（`deinitRelayServer()`）并行发起（dispose 先发起、后共同收敛，relay 侧 3s 聚合上界）**（该文件只有单一 `shutdown()`、无通用钩子注册表；**不可用 `process.on('exit')`**——其回调不能 await，异步 dispose 会被 `process.exit` 截断） |
| 与 pi 实例的关系 | **不共享连接**；zcode 两实例共享同一宿主 HOME 与**同一隔离库**（WAL 并发，与改造前同语义）；**单一数据根 env** 见下「数据根注入矩阵」 |
| 量级 | 进程数 = 每宿主每 id 1 个常驻 CLI（典型 2 个）+ zcode 背后 app-server（宿主实例惰性建，runtime 侧 `read` 只读 sqlite **不启 app-server**）；首读延迟 150–400ms（冷）/ < 50ms（暖）；RSS 待实施期实测并回写本表 |
| 验收 | A11 扩为「**含 runtime ①级读路径**」：先打开详情页触发 runtime spawn，再退宿主 `pgrep` |

**数据根注入矩阵（单一 env 名，消灭双名风险）**：引擎数据根**只认实装的 `XYZ_AGENT_DATA_DIR`**
（`data-dir.ts:26-46` 读它，缺省回退 `HostServices.dataRoot()`）——**D8 原新造的 `XYZ_AGENT_ENGINE_DATA_DIR` 删除**
（全仓无实装，双名会导致 pi 宿主引擎与 runtime 引擎指向**不同隔离库**→ ①级读静默降②级）。

| 宿主 | 注入方式 |
|------|---------|
| pi 扩展进程（xyz-agent） | **core 侧解析 `getEngineDataDir()` 并注入**（不依赖继承）：`process-manager.ts:119-140` 已注入 `XYZ_AGENT_DATA_DIR: getConfigDir()`，引擎 spawn 时仍显式写入同一值 |
| **standalone pi（env 缺省）** | 宿主 env **无** `XYZ_AGENT_DATA_DIR`（`getEngineDataDir()` 回退 `HostServices.dataRoot()` = `getAgentDir()`，`data-dir.ts:56-70` / `pi-host.ts:120-128`）→ **必须由 core 侧解析后注入**；`resolveEngineDataDir(env)` 的缺省语义写死 = **缺 env 且无注入 → 显式报错 `engine_not_found`（附期望路径）**，不静默回退 |
| runtime 进程 | `getDataDir()`（= `XYZ_AGENT_DATA_DIR`）自身即权威 |
| zsw CLI | D8 deps 映射：`engineDataDir()` → 子进程 env `XYZ_AGENT_DATA_DIR`（若与宿主值不同则 warn + 以显式值为准） |

**A11 断言**：「runtime ①级读打开的库路径 == pi 宿主引擎写入的库路径」+「**独立 pi 安装下引擎落盘根 == core `getEngineDataDir()`**」。

#### D8 兼容公共面（宿主零改动的机械保证）

| 符号 | 兼容形态 | 移除条件 |
|------|---------|---------|
| `killAllSpawnedChildren()` | 转交 `EngineClient.killAll()`（语义不变：杀 per-record children + 触发引擎 dispose） | 两个宿主改用新 API 后 |
| `registerZcodeEngine(engineDataDir)` | 薄壳：确保 id `zcode` 的 CLI descriptor 已注册，并把 `engineDataDir` 记入 descriptor（见下映射） | zsw 改用发现器后 |
| `createZcodeEngine(deps)` | 返回 `RemoteEngine('zcode')`（实现 `EnginePort`） | 同上 |

**deps → CLI 进程映射（zsw 调用面实测：`runner-core.js:163` 传 `{engineDataDir, cliPath?}`，`registration.ts:22` 的
`engineDataDir` 为必填）**：

| 旧 deps 字段 | 新落点 | 说明 |
|-------------|--------|------|
| `engineDataDir(): string` | 子进程 env **`XYZ_AGENT_DATA_DIR`**（与实装同名，见 §3.6 注入矩阵） | **引擎数据根**（隔离库/池/journal 都相对它推导）；与 `initialize.hostInfo.dataRoot`（**宿主**数据根）区分；两者不同值时以显式值为准 + warn |
| `cliPath?` | descriptor `command` 覆盖（L3 等价） | 引擎自身可执行文件路径（不是 zcode CLI 路径——后者由引擎包解析） |
| `processEnv?` | `buildEngineChildEnv` 的 base 合并 | 引擎私有 env 仍需经 `envPrefixes` 放行 |
| `sources`（模型来源/凭据） | **不跨进程** | 引擎侧自行解析自己的凭据（不变量 5） |

**vendored 定位（zsw 无 node_modules → L2 失效）**：两条通道，二选一（都属宿主侧机械改动）：
① **core 相对自身定位** `<coreDir>/../<engine>-subagent-cli`（与 zsw `core-ref.js:15` 同款相对解析，零配置）；
② zsw 显式注入 `XYZ_AGENT_ENGINE_ROOTS`（一行 env）。
**A7 判据因此修订**：**业务逻辑零改动**；允许的机械改动 = vendor 刷新（zsw 仓 `vendor-subagent-core.js` + 新增引擎包目录）
+ 发现根注入（若走通道①则零行）。**代价**：core 保留三个符号的兼容层（预计 < 80 行）；DoD 不要求删除它们
（它们不是引擎实现，是公共面契约）。

#### D9 反转记录（与既有权威文档的冲突，显式登记）

`docs/architecture/subagent-engine-abstraction.md` 二轮审查 must-fix① 裁决「reader 划为**双端复用的共享只读模块**」，
并把 runtime 侧 tsup `noExternal` 登记为复用载体。本设计**反转该裁决**：reader 随引擎包外移，core 侧改为协议 `read`。
**反转理由**：① 双端复用的前提是「同一份 TS 模块」，与「引擎不得 import core / core 不得 import 引擎」互斥；
② 保留它会让 core 永久静态依赖 zcode 实现（H1 无法清除），DoD#3 不可达。
**代价**：runtime 成为协议客户端，①级读引入进程开销与降级面（已量化）。
**被否的替代**：让 runtime 直接 import 引擎包的 reader（仍耦合实现，且 runtime 需知道每个引擎包名）。

### 3.7 打包与分发（三形态）

| 形态 | 引擎包怎么来 | 关键机制 |
|------|-------------|---------|
| workspace 开发态 | pnpm workspace 包 + L2 node 解析 / L3 配置覆盖 | **与 dev-link 同思路（路径注入）但不同通道**——dev-link 的映射 SSOT 扫 `extensions/`（`dev-link-lib.sh:55`），**不覆盖 `packages/` 下的引擎包**；引擎包走 L3 `config.json` 指向源码 `tsx` 入口 |
| Electron 打包态 | staging：引擎包 bundle 到 `apps/electron/resources/engines/<id>/` | ①`electron-builder.yml` 的 `extraResources` 增加该目录；②`postbuild-validate.sh` 三平台校验新增目录；③`bundle-extensions.mjs` external 边界加引擎包；④**路径传递**：runtime 推 `resources/` 位置 → 以 env `XYZ_AGENT_ENGINE_ROOTS` 注入 pi 子进程 → 扩展发现器读它（`HostServices.discoveryRoots` 加 `engines` kind 作为第二通道）。**推导点与安全立场**：沿用既有先例（`extension-resolver.ts:203-205` 的 `projectRoot = process.resourcesPath`、`find-pi-executable.ts:44-47` 的 `process.cwd()`）；但 `plugin-registry.ts:26/72` 明确「**绝不 cwd 探测**，防用户 repo 预置同名目录冒充」→ 本设计取**显式注入**（main/runtime 拼绝对路径）+ 引擎根**只读 manifest、不执行**用户 repo 内同名目录 |
| npm / zsw vendor | 引擎包独立发 npm；扩展 package.json **声明引擎包为 dependencies**（独立 pi 用户升级后引擎自动到位） | zsw `lib/vendor/` 增加引擎包目录（与 core 并列）；vendor 工具链 owner = zsw；**zsw 无 node_modules → L2 失效**，定位走 §3.6 D8 的两条通道之一 |

**引擎 CLI 启动解析规格（三平台，G6 的核心）**：

| 段 | 规则 |
|----|------|
| `bin` 名 → 绝对入口 | manifest `bin` 映射（包目录相对路径）+ 包目录绝对化；**不依赖 PATH**（staging 目录不在 PATH） |
| 运行时选择（**宿主 × 平台二维**） | **设计决策**：打包态 pi 宿主的 `process.execPath` 是 Bun standalone binary（再拉就是又起一个 pi）→ **必须用注入的执行器**，单一名字（不复用 relay 的 node 键）、经基础设施层注入（不依赖继承，否则被剥除）；执行器为 Electron 二进制时同时注入 `ELECTRON_RUN_AS_NODE`；首次使用前跑 node 探针，失败 → `engine_not_found` + 指引。三宿主 × 三平台的完整解析矩阵、探针实现与 env 注入点见 impl-plan §2.9 |
| Windows | 入口为 `.mjs` 时不需 shim；若引擎声明 `.cmd` → 禁止 `shell:true`（注入面），改用显式 `cmd.exe /c` + 参数数组 |
| 安全 | 不 cwd 探测；引擎根只读 manifest，不执行用户 repo 内同名目录 |

**SSOT 与守卫**：引擎包清单**不新增静态 SSOT 文件**（回退源 = runtime 发现结果，见 §3.4）；
`mandatory-extensions.json`——后者语义是 pi 扩展）；**守卫归属修正**：`check-extension-dependencies.mjs` /
`check-extension-files.mjs` 的 `EXT_DIR` 只扫 `extensions/`（`:28`/`:33`），**不能**用来校验 `packages/`——
真实覆盖链已核实：`check-version-changes.sh:80-88` 扫 `packages/*`、`check-publish-surface.mjs:114+` 动态发现
packages 下 dist 发布包、changeset `ignore` 不含 `@zhushanwen/*`；**新增规则**「引擎包不得依赖 core 内部路径」
落到**新脚本 `check-engine-package-boundary.mjs`**（扫描 `packages/subagent-engine-*` 的依赖 + import），
挂载点 = pre-commit（按路径触发）+ CI invariants。**引擎包落位**：`packages/subagent-engine-*`（它们是 CLI/npm 库，
不是 pi 扩展，不进 `extensions/` 的扩展守卫体系）；发布走 changeset + `apply-version.sh` 枚举。

### 3.8 迁移策略

**D1 双模注册表**：`EngineDescriptor` 支持 `{kind:"inproc", factory}`（过渡期）与
`{kind:"cli", command, args, capabilities}`（目标）；上层 `getEngine(id)` 返回代理，两形态透明。

**D2 迁移顺序（两个引擎都必须外移）**

| 序 | 引擎 | 前提/难点 | 完成判据 |
|---|------|----------|---------|
| 1 | **zcode** | 目录自包含但依赖 core 公共层（F5）→ 先落 D7 SDK | A1 等价（§4）；DoD 删除内建实现 |
| 2 | **pi** | 宿主耦合最重（F6）：`PiEngineService` + `spawnedChildren` + `executeAndAwait` | A2/A3 等价（§4）；DoD 删除内建实现 |

pi 的前置工序（**W6，强制**）：把 `PiEngineService` 全 9 成员 + 宿主全局状态拆出，逐条归属：

| 成员/状态 | 归属 | 理由 |
|----------|------|------|
| `executeAndAwait`（`PiEngine.run` 主路径，`pi-engine.ts:141-146/296`） | **HostBridge（core）** | 它是「宿主执行链」而非 pi 驱动细节；pi 包经 `host/*` 反向请求回调宿主执行子进程 |
| `spawnedChildren` Map + 子进程收割 | **持有方 = 引擎进程**；core 只持**状态镜像** | 镜像语义（设计级）：① 未收上报前 = 无句柄；② 引擎 exit / 重建 / dispose / killAll 时**整体置死**（否则通知合并窗口挂住、idle GC 不触发、`resumable` 说谎）；③ 收割 = **进程组级**（POSIX 负 pid / Windows 按 pid 树），只覆盖**一代子进程 + 组内后代**（引擎自身 detached 后代属已接受代价）；④ **宿主崩溃**（反向场景）由**引擎侧自灭 + 宿主启动清扫**兜底。实现级判据（pidfile 命名、三条件清扫、自灭阈值与主判据、conformance 断言形式）见 impl-plan §2.2/§2.10/§2.12 |
| `sendPromptCommand` / EPIPE 兜底 / 冷续轮 resume（`stdin-writer.ts`） | **pi 包** | pi RPC 语义 |
| chat 轮次票据（ChatRoundTicket） | **HostBridge（core）** | 宿主编排 |
| `getRecordForAction` / `collectRecords` / `closeSubagent` / `cancel` / record 状态回写 | **HostBridge（core）** | 数据所有权在宿主 |
| 生命周期定时器（idle / activate lock，`lifecycle-manager.ts`） | **HostBridge（core）** | 回收层兜底，引擎无关（ADR-0047） |

`HostBridge` 方法表（最小示例）：

```ts
interface HostBridge {                        // core 侧实现；pi 包经 host/* 反向请求消费
  executeAndAwait(opts, signal, onEvent, stream): Promise<AgentResult>
  getRecordForAction(id: string): SubagentRecord | null
  collectRecords(limit: number, filter?: StatusFilter): SubagentRecord[]
  closeSubagent(record, force): Promise<void>
  cancel(id: string): Promise<void>
  takeChatRound(taskId): ChatRoundTicket | null
  reportRecordTransition(id, patch): void
  armIdleTimer(id, ms): void; disarmIdleTimer(id): void
}
```

**若 W6 成本超预算**：不允许回退到「pi 永久内置」；改为**拉长排期**（W5 先交付，W6/W7 独立里程碑），
但 DoD 仍以两个引擎都完成外移为完成态。

**D3 开关与回退**：`XYZ_SUBAGENT_ENGINE_MODE=auto|cli|inproc`（默认 `auto`）。**适用期 = 迁移期**；
DoD#5 要求迁移完成后删除 `inproc` 分支。**DoD 之后的恢复路径**：① 引擎包版本回退
（`npm i <pkg>@<old>`）；② 配置 `engines: { "<id>": { enabled: false } }` 禁用；③ 引擎缺失时按 D4 降级/报错。
**重审触发条件**：连续两次引擎包升级导致派发失败 → 重新评估「是否保留 inproc 分支」。

**D4 缺省引擎与 fallback 目标（无内置引擎后的规格）**：`DEFAULT_ENGINE_ID` 语义改为「**配置的缺省引擎 id**」；
加载期若配置值不在已发现清单 → warn + 回落到**第一个可用引擎**（按 manifest `displayName` 稳定序）+ record 留痕；
若一个引擎都不可用 → 派发期 `engine_not_found`（列出「未发现任何引擎包」+ 安装指引）。
`fallbackTargetId()`（`routing.ts:189-198`）的恒 'pi' 改为「首个可用引擎」，无可用引擎则不 fallback（直接报错）。

**D5 存量数据**：record / journal / engineHandle 格式零变化；引擎 id 不变（`pi`/`zcode`），
历史 record 的 `engine` 字段仍能路由到新引擎包。

**D6 迁移完成定义（DoD，硬门）**：九条全绿才算完成（不接受「双模长期共存」）：

| # | DoD 条目 | 验证方式 |
|---|---------|---------|
| 1 | core 内**无任何引擎实现**（`engines/pi`、`engines/zcode` 不存在；fake fixture 不进生产 barrel） | `ls` + 依赖扫描 |
| 2 | core barrel 与 package.json exports **无引擎符号/子入口**（H2/H3 清空；D8 兼容薄壳除外） | 新增 grep 守卫 `check-engine-package-boundary.mjs`（匹配 `exports` 中的 `./engines/` 与 barrel 重导出；`check-publish-surface.mjs` 只负责 files/自包含，**不读 exports**） |
| 3 | 公共降级层**零静态引擎依赖**（H1：`session-view-service` 走协议 `read`） | 依赖图检查 |
| 4 | 两个引擎包各自独立发 npm，能在不装 core 源码的环境里被 core 发现并驱动 | 三形态场景 A5 |
| 5 | `XYZ_SUBAGENT_ENGINE_MODE=inproc` 的**内建分支已删除** | 配置面检查 |
| 6 | zsw vendor 只带 core + 引擎包目录（H7，owner = zsw） | zsw 仓核对 |
| 7 | 两个引擎的真机等价验收（§4 A1 zcode / A2-A3 pi）均通过，历史 record 可读 | 真机门 |
| 8 | 测试面全绿：core test + `pnpm extensions:test` + conformance（协议黑盒） | CI |
| 9 | 文档与约束回写：`check-doc-symbol-drift.mjs` 全绿 + 新增「引擎协议边界」约束登记（`docs/constraints.json` + `render-constraints.mjs`） | pre-commit |

### 3.9 写入面与已接受代价（登记）

| 写入面 | 归属 | 累积性 | 清理通道 | 判定 |
|--------|------|--------|---------|------|
| `<engineDataDir>/engines/zcode/appserver-launcher.cjs` | 引擎包 | 幂等覆盖 | 随引擎数据目录 | 可接受 |
| `<engineDataDir>/logs/zcode-appserver-stderr-<pid>.log` | 引擎包 | append 累积 | **文件名带实例维度**（同路径双实例并发写入会 rename 竞争）；清理通道 = 引擎包自实现，判据 = 同前缀 + **pid 已死（OS 存在性探测，不是进程内表）** + mtime 过期（三者同时成立才删）；参数读宿主 `XYZ_LOG_*`（缺省 50MB / 7 天）；宿主 logger 看不见它 → **W11 落地 + A13**；实现级判据见 impl-plan §2.11 | 可接受（通道自建） |
| **`<engineDataDir>/engines/zcode/session-db/db.sqlite`** | 引擎包 | 单调（引擎无删除 RPC） | 删除即重建（停机窗口）；TTL 策略见前置文档 `zcode-session-db-isolation.md` §3.2 D4 | 可接受（前置文档已登记） |
| 引擎常驻进程（**每宿主每 id 一个**，典型 2 个） | 引擎包 | 常驻 | `dispose` / 杀链 / **runtime 退出钩子**（§3.6） | 可接受 |
| `~/.zcode/cli/{artifacts,exec,log,…}` | 引擎包 | 单调 | 见前置文档 §2.4.1 | 另案（已登记） |
| **宿主侧引擎 stderr** | —— | —— | **不落盘**（仅内存环缓冲，崩溃现场由 `engine_crashed` 帧携带；与不变量 4「引擎不落盘宿主数据」同向） | 无新写入面 |
| **`modelCatalog` 构建期静态化**（同步成员单源化） | 引擎包 | 静态 | 无（构建产物） | **已接受代价**：zcode 侧清单从「运行期凭据感知」（`preparer.ts:210-227`）退化为**静态声明**——用户新配凭据后，同步 `validateModel` 不立即识别（`dynamic:true` 下仍放行、运行期以引擎为权威）；**用户可见面**：新配模型可能**能派发但不出现在 system prompt 的模型段**（陈旧展示，非功能阻断）；第三方引擎**不跑 `gen:model-catalog`** 时 prompt 段落 = `buildCoreAlignedHint`（无枚举面语义，与事实相容）；**恢复路径** = 重新运行引擎包构建期生成（`pnpm --filter <pkg> gen:model-catalog`）后重启宿主；第三方包需作者发版；**重审触发** = 出现「新配凭据后同步校验误拒 / 模型段陈旧」报告 | 已接受代价 |
| **宿主崩溃后的引擎残留**（`kill -9`/断电） | 引擎包 | 单调 | 引擎侧自灭（**主判据 stdio EOF** + in-flight 反向请求超时）+ 宿主启动期 pidfile 清扫（**实例维度文件名 + 三条件判定**） | 可接受（已缓解；残余 = 阈值窗口内的残留，见 A8） |
| **引擎 detached 子进程不收割** | 引擎包 | 单调 | 无（进程组收割覆盖不到） | **已接受代价（四要素）**：量级 = **引擎自身 detached spawn 的后代**（实证：pi rpc-mode `session-runner.ts:582/629` 即属此类——不是「仅当第三方引擎乱用」的假设场景）；恢复路径 = 人工 `kill` + 引擎升级；重审触发 = 出现孤儿进程报告；**首选规避** = conformance 禁止引擎一代子进程 `detached:true`（需 detach 的常驻进程必须自管 dispose 自杀），见 §3.6 D2 |
| **引擎卸载/禁用后的目录**（`<engineDataDir>/engines/<id>/` + **共享日志目录 `<engineDataDir>/logs/`**） | 无主残留 | 单调 | 二选一：① 发现器把「已发现 id 集合」反向用于孤儿目录清理（保留期 + 通道）；② 登记为「无通道风险」+ 人工清理指引 + 重审触发（隔离库 > 2GB 或用户报告磁盘异常）→ **本设计取 ②**（前置文档 D4 的 TTL 只覆盖隔离库，不覆盖 launcher/logs；**日志目录跨引擎共享、无 id 维度**，人工清理判据 = pid 已死且 mtime 过期） | 已登记风险 |

**其余已接受代价（四要素）**：
① **事件 IPC 开销**：量级 = 事件速率 × 帧开销（实施期探针：典型任务 text_delta 数百~数千条，
默认关闭合并下每条约 100–300B）；恢复路径 = 打开 `XYZ_ENGINE_EVENT_COALESCE`；重审触发 = 单任务 IPC
时间占比 > 10%；判定 = 可接受（首版）。
② **引擎进程死亡连坐该引擎在途 run**：量级 = 该引擎在途 run 数（并发上限 6）；恢复 = 重试 + 自动重建
（3 次退避）；重审触发 = 崩溃率 > 1%/百任务；判定 = 可接受。
③ **重建次数上限 3**：超限标记不可用至下次宿主启动；恢复 = 重启宿主 / 修复引擎包；重审触发 = 频繁触顶；判定 = 可接受。
④ **双实例常驻（pi 宿主 + runtime）**：量级 = 每宿主每 id 1 个 CLI（典型 2 个）+ zcode 背后 app-server；
RSS 实施期实测回写 §3.6 表；恢复 = 取消 runtime 路径（降②级）或改为共享连接；
重审触发 = 空闲内存占用 > 200MB 或用户报告卡顿；判定 = 可接受（首版）。
⑤ **stderr 常驻排空 I/O**：量级 = 引擎 stderr 速率（通常低频；异常刷屏时受环形缓冲约束）；
恢复 = 降低落盘等级；重审触发 = stderr 文件增长 > 100MB/日；判定 = 可接受。

**引擎卸载/禁用后目录的处置指引（§3.9 裁决② 落地登记，W11）**：

- **范围**：`<engineDataDir>/engines/<id>/`（池目录 / 隔离库 / pidfile 残留）+ 共享日志目录
  `<engineDataDir>/logs/`（跨引擎共享、无 id 维度）。引擎包卸载或 `engines{}` 配置禁用后，
  这些目录成为无主残留——**无自动清理通道（裁决② 取裁决① 反向清理）**。
- **无通道风险判定**：残留只占磁盘不破坏行为（record/journal 的读链按路径白名单解析，
  越界/缺失路径自动降级 journal/outcome-only，见 A9/DoD#3 读取链）。
- **人工清理指引**：确认引擎已不再使用（卸载 / 禁用）后，停宿主进程窗口内直接删除
  `<engineDataDir>/engines/<id>/`；`logs/` 目录按下述判据手工清理——只删「文件名携带的
  pid 已死（`kill -0` 探测）**且** mtime 超过保留期（缺省 7 天）」的引擎 stderr 文件
  （`zcode-appserver-stderr-<pid>.log` / `pi-task-stderr-<pid>.log` 及其轮转副本；
  与引擎包自实现清理三判据一致，手工通道只是同判据的兜底）。隔离库 TTL 策略另见
  `zcode-session-db-isolation.md` §3.2 D4。
- **重审触发**：隔离库（`engines/zcode/session-db/db.sqlite`）> 2GB，或出现磁盘异常
  用户报告 → 重评「是否升级为发现器反向清理（裁决①）」。

### 3.10 实施不变量

1. **协议是唯一界面**：引擎包不得 import `@zhushanwen/subagent-core`（只可 import SDK）；**SDK 也不得 import core**
   （否则 `core → SDK → core` 成环）——守卫 `check-engine-package-boundary.mjs` + `check-engine-sdk-boundary.mjs`。
2. **EnginePort 成员签名不变**：上层代码与测试不改（除注册表内部与新增协议客户端）；
   **例外**：§3.5.3 的时序契约注释及依赖它的假设属本设计允许变更的契约面。
3. **事件与 handle 序列化逐字兼容**：`AgentEvent` / `EngineHandleData` / `SessionView` 与现有类型同构（golden 对比）。
4. **数据所有权**：journal / record / engines.json 只由 core 写；引擎不落盘宿主数据。
5. **凭据不过协议**：协议里不出现 apiKey / token 字段（schema 层禁止 + 测试断言）。
6. **失败不静默**：引擎不可用必须显式报错（含原因与恢复指引），不静默消失。
7. **回退仅迁移期**：`inproc` 分支与「可切回内建」只在迁移期有效（DoD#5 后由 D3 的包版本回退/禁用取代）。
8. **引擎侧身份 env 契约不变**：`PI_SUBAGENT_ROOT_SESSION_ID` 等注入点随包迁移，消费方（`base-tool-enhance`）行为不变。
9. **契约变更已登记（五条）**：① 「run 内首个 await 前已触达 `executeAndAwait`」作废（§3.5.3）；
   ② 「record 创建前拒绝 model」在 `dynamic:true` 时放宽（§3.3 同步成员清单）；
   ③ 「全部同步拒绝发生在 record 创建前」补「manifest 多声明由 run 期握手失败兼底」（§3.3 能力位段）；
   ④ **无斜杠 `canonicalRef` 的 core 侧处理**（`resolveIdentityForEngine` + 续聊回读，§3.3 `validateModel` 行）；
   ⑤ **run 期失败路径清理前置副作用**（worktree/池，§3.3 能力位段）。
   均需在 W2/W3 同批回写宿主注释（`model-validation.ts:10-12`、`capability-gate.ts:12-16`、
   `subagent-service.ts:2005-2009`、`routing.ts:254-260`、`subprocess-agent-runner.ts:140-154`、`port.ts:194`、`model-validation.ts:48`）。

---

## §4 验收（真实场景）

> 每个场景都在真实宿主上跑（xyz-agent dev / zsw CLI）；fake 引擎只用于协议单元回归。
>
> **基线三层（解决「真实 LLM 逐字段等价不可达」）**：
> ① **协议层（自动、可复跑）**：fake 引擎 CLI 回放 fixture（`packages/subagent-core/src/execution/engine/__tests__/conformance/__fixtures__/engine-protocol/`），
> 断言 `AgentEvent` 序列的**结构等价**——类型序列、顺序、`seq` 单调、字段白名单；
> **排除不可复现字段**（`text_delta` 文本内容等）；沿用既有范式 `conformance/golden-replay.*.test.ts`
> + `assertAgentEventInvariants` + journal 往返保真。
> ② **引擎层 golden（随引擎包）**：引擎专属样本 + 引擎原生帧 → `SessionView` 映射断言，落各引擎包 `__golden__/`。
> ③ **真机层（手动门，不自动比对）**：A1/A2/A3 在真实宿主跑，断言**不变量与关键终态**（事件类型集合、record 状态、
> 历史详情可读、abort 终态），**不做逐字段 diff**。
> **录制/复跑口径**：录制 = W10 提供 `pnpm --filter @zhushanwen/subagent-core record:engine-fixtures`
> （把一次真实 run 的引擎帧裁剪/脱敏后写 fixture，带 schema 版本）；复跑 = `pnpm --filter @zhushanwen/subagent-core test:engine-protocol`
> （fake 引擎回放 + 白名单逐字段比对）。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| A1 | zcode 外移等价性 | `zcode-subagent-cli` 跑：单任务 + 3 路并行 workflow + abort 其一 | ①协议层：事件**结构等价**（类型序列/顺序/seq/字段白名单）；②真机层：record、历史详情、abort 终态与不变量断言一致 | G5 |
| A2 | pi 外移等价性（chat 域） | `pi-subagent-cli` 跑：首轮 / 续聊（`interact message`）/ 冷续轮 resume / abort / record 状态回写 | 同上；chat 轮次票据与 **`spawnedChildren` 镜像（含 `resumable` 字段）**行为等价；EPIPE 兜底路径可复现；**首个 await 前路由决策可观测**（§3.5.3） | G5 |（**2026-09-09 注 → 已恢复可执行**：协议 v1.x 载荷扩展落地（`host/roundLifecycle` + `RunParams.chat`），chat 域 cli 形态验收归 chat-domain 设计 §4 A1 剧本执行，inproc 过渡已删除）
| A3 | pi 外移等价性（workflow 域 + 子进程收割） | workflow 里派发 pi 任务；任务中 `kill -9` 子进程；宿主退出后 `ps`（Windows：`tasklist`） | 事件/record 等价；**SIGKILL 升级与按句守卫不回归**（`childStateChanged` 镜像可观测）；子进程被收割无残留（**POSIX 组杀 / Windows `taskkill /T /F` 两种形态各验一次**；**范围 = 一代子进程 + 组内后代**，引擎自身 detached 后代见 §3.9 已接受代价）；**POSIX：引擎上报的 `childSpawned` pid 做 `kill(-pid,0)` 组探测 → 不在同组即告警**（§3.6 D2 前提②；Windows 无外部判据，仅靠 SDK 层保证）；`killAllSpawnedChildren` 兼容符号行为不变 | G5/G4 |
| A4 | 新引擎零改 core | 写最小 `foo-subagent-cli`（fake），只装包 + manifest（含 capabilities） | 出现在选择器；`engine: foo` 可派发跑通；**core 仓库 diff = 0** | G1 |
| A5 | 三形态分发 | workspace dev / Electron 打包产物 / zsw vendor 各跑一次 A1 | 三形态发现、握手、执行一致；打包产物里引擎包**不在** extension bundle 内；产物无裸 `import("sqlite")`；**产物 grep `require("@zhushanwen/subagent-engine-sdk")` 零命中**（`validate-runtime-bundle.sh` 新增一步——该脚本 DEPS 过滤 `workspace:*`，不能依赖 DEPS 断言）；**三宿主 × 三平台启动解析均通过**（含「打包态 pi 宿主能拉起引擎 CLI」+ **引擎子进程 env 含 `XYZ_AGENT_ENGINE_NODE` 与（Electron 执行器时）`ELECTRON_RUN_AS_NODE=1` 且 argv 生效**）；zsw 形态显式验证「发现并驱动 zcode CLI」 | G6 |
| A6 | 协议与版本/能力协商 | ①`protocol: 99`；②**被 gate 能力位**（如 `conversation` / `sandbox`）manifest 少声明一次 + **非 gate 能力位**（如 `personaInjection` / `eventGranularity`）弱于/强于握手各一次；③嵌套 subagent（relay 透传，**断言引擎子进程内 relay env 可见集合 = {SOCKET,NODE,SCRIPT}**，SESSION_ID/RECORD_ID 已剥并由引擎覆写；**承载层 = L0**）；④用户旋钮 `ZCODE_APPSERVER_TURN_*_TIMEOUT_MS` 跨进程生效 + **未声明前缀的引擎私有 env 不透传** + **`XYZ_AGENT_API_KEY` 零命中**；⑤model 未命中（`dynamic=false` / `dynamic=true` 各一次）+ **manifest 省略 `modelCatalog` 的引擎 prompt 段落 == `buildCoreAlignedHint`** + **显式 `models:[]` → `buildEmptyModelsHint`**；⑥引擎 `listModels` 应答与 manifest 不一致 → **仅 warn + 任务仍跑通**；⑦**fork 判据的 OR 语义**：`steer=unsupported` 但 `conversation` 可用 → fork 放行（实装 `capability-gate.ts:67` 为「任一可用即支持」） | ①`engine_protocol_mismatch`（含双方版本 + 恢复）；②被 gate 位少声明 → **首个调用同步拒** + 恢复指引 = 「修 manifest / 升级引擎包」；非 gate 位不一致 → **仅 warn，不阻断**；③嵌套 relay 正常 + 可见集合断言通过；④旋钮生效 + 未声明 env 被剥且 warn + 凭证零命中；⑤`engine_model_unknown` 同步拒 / `engine_model_mismatch` 运行期失败 + 无斜杠 ref 留痕不畸形；⑥warn 留痕且无阻断；⑦fork 放行 | G2/G4 |
| A7 | 宿主零改动 | xyz-agent 扩展与 zsw **业务逻辑**不改；允许的机械改动 = 依赖升级 + vendor 刷新 + 发现根注入 | A1-A6 通过；扩展 `index.ts:37/103` 与 zsw `runner-core.js:75/161/428` 的**业务调用点未改**而行为不变；zsw deps 映射后 `engineDataDir` 无漂移 | G3 |
| A8 | 引擎崩溃/挂死隔离 | ①run 中 `kill -9` 引擎进程（POSIX）/ `taskkill /F /T`（Windows）；②引擎假死不回帧；③重建连续失败 4 次；④**宿主被 `kill -9`**（反向场景） | ①在途 run 失败（含 stderr 尾），下次 run 重建；**崩溃后：`list` 的 `resumable` 不说谎、后台通知不被 60s 合并窗口挂住、idle GC 可触发、孙进程零命中（POSIX `pgrep` / Windows `tasklist`）**；②按 idle 检测判定（不误杀活跃任务）；③标记不可用 + 派发报错含恢复指引；④**宿主 `kill -9` → 引擎经 stdin EOF 在阈值内自灭、组内后代零残留、同宿主内不出现同 id 双实例、双宿主互不误杀**；**负向**：静默长任务（>30s 无反向流量）**不被自灭**；被 ack 的 `host/askUser` 异步等待不被判超时 | G4 |
| A9 | 迁移完成度（DoD） | 按 §3.8 D6 九条逐条验 | 九条全绿；`grep -r "engines/\(pi\|zcode\)" packages/subagent-core/src` 零生产命中 | G1/G2 |
| A10 | 宿主表面不变量（zcode GUI / DB） | A1-A8 后（**N≥3 轮**）：打开 GUI 看会话列表；`sqlite3 "file:~/.zcode/cli/db/db.sqlite?mode=ro" "select count(*) from session where id in (<record 白名单>)"` 与 `tasks-index` 同查 | 宿主 zcode 会话列表**无新增 subagent 会话**；两库计数 = 0（白名单来源 = 本轮 record 的 `sessionRef.sessionId`，写入方归因即此） | G3 |
| A11 | 宿主表面不变量（engines.json / 进程残留 / 数据根一致） | A1-A8 **含 runtime ①级读路径**（先打开详情页触发 runtime spawn）后（**N≥3 轮**）：检查 `engines.json` 形状；退宿主后 **POSIX**：`pgrep -f '<engine>-subagent-cli'` + `lsof -p <pid>`；**Windows 等效**：`tasklist /FI "PID eq <pid>"` + 无孙进程（`wmic process where "ParentProcessId=<pid>"` 或 `tasklist /V` 人工核）；向 runtime 发 SIGTERM（Windows：`taskkill /PID <runtimePid>`）并计时 | `engines.json` 仍是 `{v:1, engines: string[]}` 且消费方行为不变；**无遗留引擎/组内后代**（**三平台各验一次**：POSIX `pgrep` 零命中 / Windows `tasklist` 零命中；范围同 A3）、无 fd/socket 堆积（lsof 行数不增长）；**SIGTERM 关停后（dispose 发起起算）1s 内引擎进程消失**（退出钩子实效；注意 `shutdown()` 内 `await deinitRelayServer()` 有 3s grace，故 dispose 必须与 relay 关停**并行**）；**runtime ①级读打开的库路径 == pi 宿主引擎写入的库路径**（单数据根） | G3 |
| A12 | 负面行为（反向验收） | ①同 id 两个包；②坏 manifest（含 `envPrefixes` 为 `""` / `"*"`）；③`bin` 缺失；④`defaultEngine` 指向已卸载引擎；⑤`engines:{"<id>":{enabled:false}}`；⑥迁移期 `XYZ_SUBAGENT_ENGINE_MODE=inproc` 回退；⑦**冷启动（无 pi 进程）** | ①后者覆盖 + info 留痕；②坏包跳过（`envPrefixes` 非法条目 → **丢弃该前缀 + warn，引擎仍可用**）、其他引擎正常；③不进清单 + 派发报错含原因；④warn + 回落首个可用引擎 + 留痕；⑤该引擎不进清单 + 派发报错含恢复指引；⑥迁移期回退可跑（适用期至 DoD#5）；⑦**已安装引擎全部可见（含第三方）**——回退源 = runtime 自身发现结果（无静态 JSON 兜底） | G1/G2 |
| A13 | stderr 日志轮转（反向验收，含并发） | ①长跑 N 次任务（或人为刷屏）后检查 `logs/zcode-appserver-stderr-<pid>.log`；②**两个宿主（pi + runtime）同时长跑** | ①文件大小受上限（50MB）约束、超期（7 天）自动清理（**可执行步骤：`touch -d '8 days ago' <log>` 把 mtime 拨回后重跑清理**）；②双实例各自文件独立、**互不删除/重命名对方文件**、无 rename 失败（EPERM）静默丢失（**对方 pid 存活时其文件不得被删**；存活判据 = `process.kill(pid,0)` 跨实例探测） | 已接受代价 |

**探针挂钩**（随代码落地）：
① 协议单元：fake 引擎 CLI 覆盖 **10 个正向方法 + 8 个反向通道 + 错误帧**；
② **协议层基线**：`AgentEvent` / `EngineHandleData` / `SessionView` 序列化**结构等价**（类型序列/顺序/seq/字段白名单）
   + 引擎层 golden 回放（含录制/复跑脚本）；fixture 落位沿用既有约定
   `packages/subagent-core/src/execution/engine/__tests__/conformance/__fixtures__/`（不新建顶层 `__fixtures__/`）；
③ 发现器：manifest 解析 / 覆盖优先级 / 坏包跳过 / `bin` 缺失 / 能力位声明与握手比对；
   **gate 时序探针**：免探路径（pi）首次 gate → 首个 run 前必经 `initialize`，弱于/强于两方向断言（供 A6②）；
④ runtime ①级读：冷 spawn 延迟、idle 复用命中率、降级率（供 §3.6 重审触发条件）；
⑤ 真机：A1/A2/A3 与基线双跑 diff。

---

## §5 下一层拆分

| 单元 | 职责（设计级） | 依赖 | 验收挂钩 | 领地与实现细节 |
|------|----------------|------|---------|------------------|
| W1 协议定义 + SDK 骨架 | engine-protocol v1 帧型/方法/错误码/版本常量/JSON Schema + 边界守卫 | —（DAG 根，与 u-foundation 等价的共享契约根） | A4/A6；§2.1 规格 | impl-plan §2.1 |
| W2 协议客户端 | `EngineClient` + `RemoteEngine implements EnginePort` + 同步成员形态映射 | W1 | A1/A6/A8/A13；§2.2 规格 | impl-plan §2.2 |
| W3 注册表与路由 | `EngineDescriptor` 双模 + manifest 快照 + D4 缺省引擎 + 时序契约改写 + 契约变更④⑤ | W1 | A2/A3/A4/A6/A12；§2.3 规格 | impl-plan §2.3 |
| W4 发现器 | manifest 解析 + 三级搜索路径 + engines.json 投影 + 冷启动回退源单源化 | W1 | A4/A11/A12；§2.4 规格 | impl-plan §2.4 |
| W5 zcode 外移 | 新建 `@zhushanwen/zcode-subagent-cli` 包，搬 `engines/zcode/` + 前置文档改动 | W1–W4 | A1/A5/A9；§2.5 规格 | impl-plan §2.5 |
| W6 pi 宿主面下沉 | `PiEngineService` 9 成员拆 HostBridge + `spawnedChildren` 状态镜像（前置，强制） | W1–W3 | A2/A3/A8 前置；§2.6 规格 | impl-plan §2.6 |
| W7 pi 外移 | 新建 `@zhushanwen/pi-subagent-cli`（依赖 W6 产物） | W6 | A2/A3/A9；§2.7 规格 | impl-plan §2.7 |
| W8 宿主接线 | runtime 成为协议客户端 + 扩展依赖声明 + D8 兼容公共面 + relay 透传 | W2/W4 | A7/A11；§2.8 规格 | impl-plan §2.8 |
| W9 打包与分发 | 引擎包 staging + 启动解析二维矩阵 + 数据根注入矩阵 + 新守卫 | W1/W5/W7 | A5/A11；§2.9 规格 | impl-plan §2.9 |
| W10 conformance 改造 | 协议黑盒套件 + 基线三层 + 录制/复跑 + H9 测试面迁移 | W1/W2/W5/W7 | A1/A2/A4/A9；§2.10 规格 | impl-plan §2.10 |
| W11 壳侧去引擎化（DoD 收口） | 清 H1–H4/H8/H11 + 删内建与 inproc + stderr 轮转引擎侧自实现 | W5/W7/W8/W9/W10/W12 | A5/A9/A11/A13；§2.11 规格 | impl-plan §2.11 |
| W12 环境与文档 | `buildEngineChildEnv` 三层 env + 守卫扩展 + env 文档/约束回写 | W1 | A6/A9；§2.12 规格 | impl-plan §2.12 |

**下一层文档**：`zcode-subagent-cli` 提取设计与 `pi-subagent-cli` 提取设计各自单独成文
（驱动细节、凭据/池策略、事件适配、迁移验收），本设计只钉死它们与 core 的协议面。

**排序与版本**：W1–W4（协议与壳）→ W5（zcode 外移，首个真机验证）→ W6–W7（pi，强制路径）→
W8/W9/W10/W12 并行收口 → **W11（DoD 收口）**。core 发 **major**（引擎注册面与公共面语义变化）；
引擎包首版 0.x；SDK 与协议版本独立于包版本。
**风险与回退**：任一阶段卡住，`XYZ_SUBAGENT_ENGINE_MODE=inproc` 立即回到现状——但该开关是**过渡期专用**，
DoD#5 要求它最终删除；回退只用于「迁移中途救火」，不构成长期形态。
**最大的三个未知（实施期优先证伪）**：① runtime ①级读的进程开销与降级率（§3.6 重审触发条件）；
② pi 宿主面下沉的实际成本（W6）；③ 打包态引擎发现路径传递与三平台启动解析是否均覆盖（W9）。
