# 长期运行稳定性架构：故障域对齐与分层自愈

> **一句话结论**：Taiji「session 崩溃」的根因不是某个单点 bug，而是**故障域与用户感知的 session 边界不对齐**（一个扩展抛错炸掉整个 pi 进程、runtime 一死全灭、renderer 崩溃无恢复）叠加**长跑资源无治理**与**现场不可取证**。本设计不改变进程拓扑（pi 已是 session 级进程隔离），而是建立五层故障域模型 + 每层自愈闭环 + 统一崩溃台账 + 资源水位治理，目标是 30+ 天长跑中任何单层故障都不被用户感知为「session 崩溃」。

## 开篇（SCQA）

- **S（情境）**：Taiji 是 Electron + Vue 3 + Node runtime 的桌面 AI Agent 工作台，作为日常使用工具会连续运行 30 天以上不重启。每个聊天 session 对应 runtime 管理的一个 pi 子进程，历史持久化在磁盘 JSONL。
- **C（冲突）**：现状是三类不同层的故障（pi 进程崩溃 / runtime 级联重启 / renderer OOM）在用户眼里都长一个样——「某个 session 突然崩了」。2026-09 真实日志三起实锤：9/3 smart-context 扩展在失效 ctx 上抛错炸掉整个 pi 进程（exit 1）；9/5 七个 session 的 pi 在同一秒被 SIGTERM 连杀；9/9 renderer 进程启动 0.3 秒在 malloc 路径 SIGTRAP（系统 swap 11GB/12GB 耗尽背景下的分配失败）。而单独使用 pi CLI 从不崩——GUI 改变了 session 生命周期事件的频率分布，把 CLI 下的低概率坑踩成了高频崩溃。
- **Q（问题）**：在不能修改 pi 上游、不接受大重构重写的前提下，怎么让 30+ 天长跑中任何单层故障都可隔离、可自愈、可取证？
- **A（答案）**：**故障域对齐 + 分层自愈**。建立五层故障域模型（main / renderer / runtime / pi-per-session / plugin-worker），每层配「检测 → 隔离 → 自愈 → 取证」闭环；统一崩溃台账（crash journal）让所有崩溃可事后归因；内存水位治理让资源压力走降级而非崩溃。本文展开这个答案。

## 1. 背景目标

**本章结论**：设计目标从「30 天老用户的日常体验」倒推四条；短期点修（smart-context stale ctx 修复等）不在本文范围，作为本设计的既有基线假设。

### 1.1 系统是什么（进程拓扑现状）

Taiji 运行时是五类进程的集合，**「用户在 GUI 里看到的一个 session」实际是贯穿其中四层的逻辑实体**：

```
┌─ Electron main（1 个）         窗口管理、runtime 子进程监管（supervisor）
├─ renderer（1 个/窗口）          Vue 3 UI，全部 session 的界面状态都在这一个进程里
├─ runtime（1 个 Node 子进程）    WS 服务，托管全部 session 的 pi 进程、plugin worker、relay
├─ pi（每活跃 session 1 个）      pi --mode rpc 子进程，session 的本体（历史在磁盘 JSONL）
└─ plugin-worker（按插件组分）     trusted 插件 Worker Thread / sandbox fork 子进程
```

关键事实：**pi 进程已经是 session 级进程隔离**（ProcessManager 每 session spawn 一个），session 历史的权威存储在磁盘 JSONL 不在内存——这两个事实决定了本设计不需要改变进程拓扑（见 §3.2 方案 A 的否决理由）。

> 术语锚定：**「故障域」** = 一个故障发生时实际被波及的进程集合。例如 pi 进程崩溃的故障域 = 单个 session（理想）；runtime 崩溃的故障域 = 全部 session（§2 案例二的问题所在）。**「自愈闭环」** = 「检测 → 隔离 → 自愈 → 取证」四步链路，例如 renderer 层的闭环 = render-process-gone 检测（§2 案例三已有）→ 循环保护隔离 → 自动 reload 恢复 → 崩溃台账取证。

### 1.2 设计目标（从使用者体验倒推）

- **G1 故障隔离**：任何单个 session 触发的故障，不影响其他 session 的可用性。一个 session 的扩展崩溃，其他 session 连一丝抖动都没有。
- **G2 无感自愈**：可恢复的故障在用户不操作的情况下自动恢复；不可恢复的故障（如连续崩溃）给出明确的死态 UI 与一键恢复入口，绝不做「看起来正常但永远报错」的僵尸。
- **G3 长跑资源稳定**：30 天运行中无单调资源增长导致的死亡。内存压力到来时系统走**降级**（释放缓存、分页加载、滚动重启）而不是崩溃。
- **G4 现场可取证**：任何一次崩溃，事后能从统一崩溃台账回答三个问题——哪层崩的、为什么、影响了谁。不再有「session 崩了但日志里什么都查不到」。

**目标优先级裁决（用户拍板，2026-09-09）**：四条目标不是并列——**G1/G3（根治：崩溃不发生、资源有界）> G4（取证）> G2（自愈）**。自愈是兜底，先于根治落地会把「频繁崩溃」变成「频繁静默恢复」，掩盖真实问题；因此 G2 的实施排在最后（§5 阶段三），且附带防掩盖硬约束：任何自愈动作必须用户可见 + 台账可数，触发率是受监控指标而非免费福利。

### 1.3 Scope

- **In-scope**：五层故障域模型与各自愈闭环的架构设计；崩溃台账（crash journal）与内存水位打点基建；runtime 滚动重启的 session 交接协议方向；extension 错误遏制体系；各子系统的边界、依赖与优先级。
- **Out-of-scope**：
  - **短期点修**（用户另行处理，本文将其视为既有基线）：smart-context stale ctx 修复、`render-process-gone` 最小化自动 reload、WS server→client 帧上限、runtime 全量读 statSync 护栏。短期做「少崩」，本文做「崩了也无感 + 可取证 + 30 天资源稳定」。
  - pi 上游修改（[MANDATORY] 项目铁律：不改 pi 源码、不 fork）。
  - 联网崩溃上报（崩溃台账只落本地，导出由用户手动触发）。
  - 泛化的「全面性能优化」——内存治理只覆盖已被证据指向的崩溃路径（§2.3），渲染性能等不属本文。
- **层声明（当前层 → 下一层）**：本文是**架构层**设计，下一层产物 = 各子系统（E1-E7，见 §5）自己的技术方案设计文档。本文不设计函数签名与协议帧格式细节。

## 2. 现状与问题分析

**本章结论**：三起真实崩溃对应三个结构性根因——**进程同命运**（extension 与 session 共死于 pi 进程）、**恢复链残缺**（renderer 无恢复、pi 只手动恢复）、**长跑无治理**（资源水位无监控、无降级路径）；外加一个放大器——**现场不可取证**（renderer 层零日志）。

### 2.1 使用者视角的现状（真实崩溃案例，全部取自本机日志）

**案例一（2026-09-03，pi 进程崩溃）**：用户在打包版 TaiJi.app 正常使用，某个 session 突然死亡。`~/.xyz-agent/logs/pi-crash-2026-09-03-835c6577-*.log` 记录的崩溃现场：

```
error: This extension ctx is stale after session replacement or reload. Do not use a
captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or
ctx.reload(). ...
  at assertActive (/$bunfs/root/pi:238195:13)
  at sendUserMessage (/$bunfs/root/pi:238338:19)
  at onError (/Applications/TaiJi.app/.../pi-smart-context/index.js:901:33)
Bun v1.3.14 (macOS arm64)
```

因果链：smart-context 的 `compact_context` 工具是 fire-and-forget 设计——工具立即返回「压缩已启动」，压缩完成/失败后在**异步回调**里用注册时捕获的 `pi` ctx 调 `sendUserMessage` 注入结果（`extensions/universal/smart-context/src/tool.ts:183-191`）。用户在压缩进行中切换/重载了 session → ctx 失效 → 回调触发时 pi 的 `assertActive` 同步抛错 → 异步回调里无人 catch → **整个 pi 进程 exit 1，session 死亡**。

**案例二（2026-09-05 17:29，runtime 级联）**：七个 session 的 pi 进程在**同一秒**全部 exit 143（SIGTERM），留下七个 `pi-crash-2026-09-05-*.log`。runtime 日志显示这不是各 session 独立故障，而是一次实例级事件（runtime 重启/收割级联）——**表象是「某 session 崩了」，实际是全部 session 一起死**。

**案例三（2026-09-09 10:57，renderer OOM）**：macOS 崩溃报告 `Electron Helper (Renderer)-2026-09-09-105723.ips`：renderer 进程**启动 0.3 秒后**在 libuv/V8 malloc 路径 SIGTRAP（V8 对分配失败的处理是立即 crash）。当时系统 20 天未重启，swap 已用 11GB/12GB，物理空闲内存仅约 170MB。main 进程对这类死亡的处理是**只打一行日志**（`apps/electron/main/window/window-factory.ts:192-197` 的 `render-process-gone` handler，注释自证「两者目前只打日志便于诊断」）——用户面对一个白屏挂住的窗口，无任何恢复入口。

### 2.2 关键问题：为什么 pi 单独用不崩，套上 GUI 就崩？

这是本设计必须正面回答的问题，因为它决定了方案打在哪个层。

用户（及合理的架构直觉）认为：extension 是底层 pi 的东西，与 GUI/renderer/runtime 最多只有简单数据通知，代码上解耦。**这个判断在静态结构上是对的**——崩溃链条不是代码耦合，而是「**进程同命运 + 行为频率分布改变**」：

1. **pi 的 extension 跑在 pi 进程内**（pi 上游的进程模型，项目铁律不可改）——extension 里任何未被捕获的异步异常 = pi 进程死亡 = session 死亡。这是 CLI 和 GUI 共有的结构性事实。
2. **CLI 用户很少触发 session replacement/reload**（`ctx.newSession/switchSession/reload`）——stale ctx 窗口几乎不出现。
3. **GUI 把这个窗口变成高频路径**：点侧栏切 session、新建任务、重载、compact 进行中切走——每一次 GUI 操作都在制造 stale ctx 窗口。smart-context 的异步回调踩中窗口的概率，从 CLI 的「几乎为零」变成 GUI 的「每次 compact 期间切 session 必中」。
4. 同理，**GUI 会做 CLI 从不做的资源动作**：把整个 session 历史加载进 renderer 内存（活跃 session 的 `getHistory` 全量不截断，`packages/runtime/src/services/session/history-rebuild-cache.ts:229-241`）、多 session 并发驻留、subagent relay 层级连坐（主 pi 崩溃 → relay kill-on-disconnect 杀掉它的全部 subagent 子进程，`packages/runtime/src/infra/relay/relay-registry.ts:437-442`）。

> 术语锚定：**「进程同命运」** = 案例一展示的结构性事实——extension 代码与 session 本体活在同一个 pi 进程里，extension 的未捕获异常必然杀死 session。它不改任何代码依赖关系，但决定了「extension 质量」与「session 稳定性」是同一条命。

### 2.3 失败模式与根因（MECE）

**失败模式 A：pi 进程崩溃，session 死亡，恢复靠手动。** 触发源不止 stale ctx——任何 extension 的未捕获异步异常、pi 自身 bug、系统资源耗尽都可能杀 pi。现状恢复是 lazy 的：用户切回 session 或点「重新打开」才触发 `restoreSession`（`session-service.ts:567-586` 的 `ensureActive`）。这是既有设计 `docs/architecture/pi-exit-notification-and-respawn.md` §6.2 的显式裁决（当时理由：「死亡时没有需要新进程接手的在途操作，立即重建无收益；lazy 天然防 crash-loop」）。**该裁决在「死亡可感知」目标下成立，但在本文 G2「无感自愈」目标下不成立**——lazy 意味着每次扩展崩溃都是一次用户可见、需手动恢复的崩溃。

**失败模式 B：runtime 单进程托管全部 session，一死全灭。** runtime 的 `uncaughtException` 策略是 graceful shutdown + exit(1) 交给 supervisor 重启（`packages/runtime/src/index.ts:771-778`）——策略本身正确，但影响半径是全部 session。supervisor 有指数退避重启（1/2/4/8/16s，上限 5 次，`apps/electron/main/supervisor/restart-policy.ts`）和 liveness 探针，崩溃恢复链相对完整；但重启后所有活跃 session 变成「持久化但未附着」，等用户操作才逐个 `restoreSession`——案例二的「七 session 同秒连杀」就是这个影响半径的实证。**诚实声明**：案例二的具体触发源（什么导致该次实例级事件）本次调研未能定位——dev 实例与打包版共享数据目录期间的重启/收割行为是最大嫌疑，但日志在该时段存在启动 banner 缺失的断档，无法闭环归因。本设计不承诺消灭该类触发源，只改影响半径与恢复速度；触发源取证由 D1 台账承接未来事件。

**失败模式 C：renderer 是唯一没有恢复链路的进程。** 无 `app.config.errorHandler`、无 `window.onerror`、无 `unhandledrejection`（`packages/renderer/src/main.ts:25-35` 只注册 pinia/i18n 后 mount）——任何组件渲染抛错 = Vue 整树卸载 = 白屏无痕。`render-process-gone` 只打日志不 reload。renderer 承载着所有 session 的 UI 状态，它一死，用户视角是「当前这个 session 崩了」（案例三）。

**失败模式 D：长跑资源无治理。** 现状没有任何内存水位监控（runtime/main 全仓 grep 无 `memoryUsage` 采样）；大对象路径无界——活跃 session 历史全量单帧下发（server→client 方向无 WS 帧上限，`MAX_WS_PAYLOAD_BYTES` 16MB 只限 client→server，`packages/shared/src/constants.ts:124`）、renderer 的 `entryStates` 保留未截断的 tool output 全文与 base64 图片（唯一兜底是 LRU=8，且卡在 streaming 豁免态的 session 永不驱逐）、pi stdout tee 日志单文件大小无界（tee 通路不轮转，`packages/runtime/src/infra/logger.ts` 注释自证；既有 `cleanExpiredLogs` 只按 7 天保留期删除，7 天窗口内可单调累积——本机实测单文件 198MB）。30 天维度下，这些是单调增长源。

**失败模式 E（放大器）：现场不可取证。** pi 侧取证好（`pi-crash-*.log` 全量 stderr），但 renderer 崩溃零日志、plugin worker 崩溃零取证、各层崩溃事件无统一台账——本次调研回答「为什么崩」靠人工翻 macOS DiagnosticReports + 拼三个日志文件，不可持续。

### 2.4 物理数据流（崩溃事件的产生与消散）

```
崩溃产生层                     现状信号链                          现状终点
─────────────────────────────────────────────────────────────────────
pi 进程 exit ──→ RpcClient exit handler ──→ pi-crash-*.log（✅ 取证好）
              └─→ ProcessManager → SessionService → session.exited 广播
                  → 前端 dead UI（✅ 感知）→ 等用户手动 restore（❌ 无自愈）

runtime uncaught ──→ shutdown(exit 1) ──→ runtime-*.log（✅ 有日志）
                   → supervisor 退避重启（✅）→ 全部 session 未附着（❌ 级联）

renderer 崩溃 ──→ main render-process-gone ──→ 一行 console.error（❌ 无取证）
                → 窗口白屏挂住（❌ 无恢复、❌ 无用户提示）

plugin worker exit ──→ runtime 日志一行 + 计数重建 ≤3 次（半✅）
                     → 超限后 warn 一条，插件永久静默停摆（❌ 无用户可见性）

系统内存压力 ──→ （无任何监控）──→ V8 malloc 失败 SIGTRAP（案例三）
```

## 3. 解决方案

### 3.1 终态（使用者视角）

**本章结论**：终态下，§2 的三个崩溃案例分别变成「一条系统消息 + 自动恢复」「一次 2-3 秒的界面重载」「一次几秒的后端热重启过渡」；所有崩溃进统一台账，设置页一键导出诊断包。

**场景一（对应案例一：pi/扩展崩溃 → 无感自愈）**

用户在 session A 对话，smart-context 类扩展在后台回调里抛错，pi 进程死亡：

1. runtime 检测到 pi exit → 查崩溃台账分类（扩展错误 / OOM / 信号杀）→ **自动 respawn**：重新 spawn pi + `switchSession` 附加磁盘历史（复用既有 `restoreSession` 路径）。
2. session A 聊天流插入一条系统消息：「会话进程异常退出，已自动恢复，历史完整。正在生成中的回复已中断——[重新发送]」。
3. 恢复期间（1-3 秒）session A 输入框置灰并显示「恢复中…」；**session B/C 完全无感知**。
4. 若 respawn 连续失败（退避 3 次后）：session A 进入明确死态 UI——「会话进程反复崩溃，最近崩溃原因：smart-context 扩展错误（查看崩溃日志）｜[重试] [导出诊断包]」。**恢复指引闭环**：错误消息直接指向「查看崩溃日志」与「导出诊断包」两个具体动作，不是「请检查」。

**场景二（对应案例三：renderer 崩溃 → 自动重载）**

系统内存压力下 renderer 进程 OOM 死亡：

1. main 的 `render-process-gone` handler 记录崩溃台账 → **自动 reload 窗口**（循环保护：5 分钟内第 3 次崩溃则不再 reload，转入崩溃页）。
2. renderer 重载后经既有 WS 断线恢复链（重连 → resubscribe → 状态快照回放）重建全部 session 状态，切回崩溃前的当前 session。
3. 用户看到 2-3 秒加载屏 + 一条 toast：「界面已自动恢复」。**输入框未发送的草稿还在**（草稿防抖持久化到 localStorage）。
4. 转入崩溃页时（循环保护触发）：页面显示「界面反复崩溃」+ 最近三次崩溃原因摘要 + [重试] [导出诊断包]。

**场景三（runtime 内存看门狗 → 降级而非崩溃）**

runtime 连续采样发现 heap 越过告警线（如 heapUsed 达 heap 上限 70%）：

1. 先走**降级**：清空历史重建缓存、通知 renderer 收紧 LRU——多数时候水位回落，用户无感知，台账记一条 `event=memory-relief`。
2. 水位继续越临界线（85% 持续多次采样）：走**优雅滚动重启**——runtime 广播「后端热重启中」→ 逐 session 优雅终止 pi（等其 flush session 文件）→ 以专用退出码退出 → supervisor 识别该退出码**立即重启（跳过退避、不占崩溃计数）**→ 新 runtime 读交接文件自动 reattach 原活跃 session。
3. 用户看到顶部一条非阻塞横幅「后端正在热重启，几秒钟后自动恢复」——**不是**现在的整屏「连接中…」替换。
4. 滚动重启失败（新 runtime 起不来）：回落到既有的 `runtime-failed` 手动重试 UI——恢复通道始终存在。

**场景四（取证：诊断导出）**

任何异常发生后，用户在设置页点「导出诊断包」→ 生成 zip（崩溃台账 + 各层日志尾部 + 内存水位曲线 + 版本信息）→ 保存到用户自选位置。开发者拿到 zip 即可回答「哪层、为什么、影响谁」，无需用户口述复现。

### 3.2 方案对比

**本章结论**：推荐方案 B（故障域对齐 + 分层自愈）。方案 A（全进程隔离）隔离性最强但成本是重写 runtime 与 UI 架构，且边际收益低——pi 已经是 session 级隔离；方案 C（最小自愈）不解决 30 天长跑的资源衰变。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 会话级全进程隔离**：runtime 多进程化（每 session 一个 worker 进程）+ renderer 按 session 拆 BrowserView | 中：故障域物理隔离最彻底；但 session 历史权威存储本就在磁盘 JSONL、pi 进程本已 per-session 隔离，runtime 管理代码再隔离一层的**边际收益**仅限于「runtime 自身 uncaught 的影响半径」；renderer 拆 BrowserView 破坏单 Vue 应用模型（Pinia/路由/全局组件全部重构） | 极高：ProcessManager/MessageBus/SessionService/WS 网关全部跨进程化；renderer 近似重写；跨进程状态聚合与广播路由是新故障面 | 高：重写期引入新 bug 的期望损失大于它消灭的故障类别；内存开销 N 进程 × 固定成本 | ❌ |
| **B. 故障域对齐 + 分层自愈**（推荐）：进程拓扑不变，五层各配「检测 → 隔离 → 自愈 → 取证」闭环；统一崩溃台账；内存水位治理 + runtime 滚动重启 | 高：把「故障域 = session」建立在**恢复速度**而非**进程隔离**上——pi 崩溃 1-3 秒自愈后，用户视角与物理隔离等价；每层闭环独立交付独立回滚；对现有 supervisor/restoreSession/WS 恢复链全部是增量 | 中：7 个子系统（§5）可并行度较高；无重写 | 中：自愈引入新的运行时行为（自动 respawn、滚动重启），需探针验证（§3.4）——用有界退避 + 熔断兜底 | ✅ |
| **C. 最小自愈**：只做 renderer 自动 reload + 崩溃台账，其余维持现状 | 低：pi 崩溃仍靠用户手动恢复（G2 不成立）；30 天资源衰变无治理（G3 不成立）——只解决了三起案例中体感最轻的那个 | 低 | 低，但目标缺口大 | ❌ |

被否方案落到 §2 案例的对比：

- **若用方案 A**：案例一（扩展崩溃）在 A 下依然发生——extension 跑在 pi 进程内是 pi 上游的进程模型，runtime 多进程化改变不了扩展与 session 同命运；案例三的 renderer OOM 在 A 下反而更频繁（N 个 BrowserView 的内存开销大于单 renderer）。A 消灭了案例二（runtime 级联），但代价是整个传输/服务层重写。
- **若用方案 C**：案例一后用户回来看到的仍是「进程已退出」死态 + 手动点恢复，30 天里每次扩展崩溃都是一次手动操作；案例二随使用天数增长内存衰变无人治理，最终仍指向案例三式的 OOM。

### 3.3 关键决策与权衡

**本章结论**：七个决策构成五层闭环——D1 台账是地基（所有层的事件都进台账），D2/D3/D4 分别是 pi/runtime/renderer 三层自愈，D5 遏制扩展错误源，D6 治理长跑资源，D7 打通取证出口。

**D1：统一崩溃台账（crash journal）——所有层崩溃事件的单一事实出口（选定）**

- **采用**：新增 append-only 崩溃台账，物理形态为 `<dataDir>/logs/crashes/` 下两个 JSONL 文件——`main.jsonl`（main 进程写：main 自身 + renderer 崩溃事件）与 `runtime.jsonl`（runtime 进程写：runtime + pi + plugin-worker + extension 崩溃事件），单文件 10MB 轮转。事件 Schema（架构层契约，字段集由各子系统设计继承）：

  ```json
  { "ts": "2026-09-09T02:57:03Z", "layer": "pi|runtime|renderer|main|plugin-worker",
    "event": "crash|oom|unresponsive|auto-respawn|rolling-restart|rolling-restart-forced|shutdown|deleted|memory-relief|reattach-skipped|checkpoint-corrupt|reaped",
    "sessionId": "01a06a87-…", "reason": "extension-stale-ctx|sigkill|oom|…",
    "exitCode": 1, "rss": 402653184, "heapUsed": 301989888,
    "uptimeSec": 86400, "appVersion": "0.9.16", "piVersion": "0.84.4",
    "memPressure": { "swapUsedMB": 11004, "freeMB": 170 },
    "detailDigest": "末 10 行 stderr 摘要内嵌（≤2KB）", "detailPath": "logs/pi-crash-….log" }
  ```

  写入点：pi exit handler、runtime uncaughtException/shutdown、main 的 render-process-gone/unresponsive、plugin-host 崩溃计数器、看门狗降级/滚动重启动作、孤儿收割（`reapOrphanPiProcesses` 的收割记录——kill -9 场景的孤儿 pi 不经任何 exit handler，收割是其退出的唯一信号源）。三个防漏设计：

  1. **detailDigest 内嵌**：归因所需的最小证据（stderr 尾部摘要）直接内嵌进台账事件，`detailPath` 指向的详情日志（pi-crash-*.log 等走 7 天保留期）仅作加分项——台账的归因能力不依赖可能已被清理的外部文件。
  2. **main 层死亡自记**：main 自身致命崩溃无人能实时写台账——补 clean-exit marker：main 启动写 `run/main-running.marker`、正常退出清除；下次启动发现残留即补记 `layer=main, event=crash, reason=unclean-exit`，并在诊断导出时附 macOS 系统报告（`~/Library/Logs/DiagnosticReports/`）的指引。
  3. **renderer 错误上报节流**：renderer 全局错误捕获（D4①）的错误经 IPC 上报 main 落盘前，必须过节流 + 同签名去重窗口——渲染循环类错误可按帧高频重入，无节流的错误洪水本身会压垮 main 的 IPC（自愈机制引入新故障面）。
- **被否**：「复用现有日志 grep」——若用它，场景四变成人工在 runtime-*.log / pi-crash-*.log / DiagnosticReports 三处拼接时间线（正是本次调研的实际成本），G4 不成立。
- **证据**：现状信号链盘点（§2.4）显示 pi 侧取证好、其余四层断链；本机已有 8 个 pi-crash 文件证明落盘取证形态有效。
- **效果**：G4 成立；D2/D3/D4 的自愈动作全部经台账记录，使「自愈是否在工作」可观测。
- **写入面与清理（写入本项目数据目录的声明）**：本设计新增写入面穷举如下，**全部自带轮转/保留期**——既有 `cleanExpiredLogs` 白名单只认顶层 `runtime-*`/`pi-*` 前缀文件（`packages/runtime/src/infra/logger.ts:330`），`crashes/` 子目录与 `renderer-error-*` 前缀均不命中，不得引用该既有通道作清理依据（同时将新文件名纳入其白名单作双保险）：

  | 写入面 | 消费方 | 生命周期与清理通道 | 量级 |
  |---|---|---|---|
  | `crashes/main.jsonl` + `crashes/runtime.jsonl` | 诊断导出（D7）、未来设置页「最近崩溃」视图 | 单文件 10MB 轮转，保留末 3 段（与 D6③ tee 轮转同形态） | 每事件约 300-2.5KB（含 detailDigest），日增量 KB 级 |
  | `logs/renderer-error-YYYY-MM-DD.log`（D4①） | 诊断导出 | writer 自带保留期（7 天）+ 单文件大小上限；叠加 D1 节流去重后日增量 KB 级（非节流场景下渲染循环错误洪水可达数千行/日，节流是量级前提） | KB 级/日（节流后） |
  | `run/runtime-checkpoint.json`（D3 持续交接文件） | 新 runtime 启动 reattach | 原子写（tmp+rename）；**clean shutdown 删除**（只服务崩溃/滚动重启恢复；unlink 失败的边缘场景改写空 session 清单，同样达成「无 reattach」语义）；reattach 成功后删除；reattach 失败时现场快照另存 `checkpoint-failed-<ts>.json` 供诊断——**保留最近 3 份，新失败覆盖最旧**；主文件继续正常生命周期（失败现场不被后续增量覆盖） | 单文件 KB 级 |
  | `run/main-running.marker`（D1 防漏设计 2） | 下次启动的 unclean-exit 检测 | 每次启动覆盖写、正常退出清除、异常退出留存并被下次启动一次性消费（补记台账后清除） | 字节级单文件 |
  | 内存水位日志行（D3 采样） | 诊断导出、人工排障 | 写入既有 `runtime-*.log` 主日志，继承其轮转与 7 天保留期 | 每 5 分钟一行 |
  | renderer 草稿（D4③，localStorage，**落 Chromium userData，prod 不在 dataDir 内**） | renderer reload 后恢复 | 草稿发送成功即删；session 删除时清对应草稿 | 每 session 一条，KB 级 |
  | 诊断导出 zip（D7） | 用户手动保存 | 用户自选位置、用户自管 | 按需 |

**D2：pi 崩溃 bounded proactive respawn——对 pi-exit-notification-and-respawn §6.2 裁决的显式修订（选定）**

- **采用**：pi 异常退出后 runtime **自动 respawn**（复用 `restoreSession`：spawn + `switchSession` 附加磁盘历史），有界退避（3 次：1s/4s/16s）+ 熔断（连续失败 3 次 → dead 态 + 死态 UI 带崩溃原因与诊断入口）。五条架构约束：
  1. **计数语义**：退避/熔断按**连续失败**计数，respawn 成功且稳定运行 60 秒即清零——低频抖动（每周崩一次的扩展）永不误入死态。参数与 supervisor 退避（restart-policy.ts）**语义同构**而非相同。
  2. **崩溃分类差异化**：respawn 前查台账分类——资源类崩溃（OOM 特征 / 伴随系统高水位）延迟首次 respawn（30 秒）并降级提示，避免在内存耗尽背景下（案例三形态）立即三连 respawn 加剧压力；2 分钟后水位仍高则转 dead 态 + 手动恢复入口，不在资源耗尽背景下持续加码；其余类别立即走 1s/4s/16s。
  3. **主动终止抑制通道（覆盖一切 runtime 主动发起的 pi 终止）**：不只 shutdown 与滚动重启两类——**delete/deleteByCwd 的用户删除、restore 清场 `safeDestroy`、create/fork 失败的 `safeDestroy(tempId/forkedId)` 同样是主动终止**。若不抑制，用户删除一个活跃 session 后：`pm.destroySession` 杀 pi → `onSessionExit` 触发 → D2 对已删 session 调度 respawn → `restoreSession` 抛 SESSION_NOT_FOUND（文件已 trash）计为连续失败 → 3 次后对已删 session 写死态 + 台账记假 `crash`——正是本通道要消灭的污染。机制：runtime 维护 **intentional-kill 集合**（按 sessionId 登记，tempId 与 fork 出的 forkedId 同样登记），四条生命周期契约：①**先登记后终止**（登记必须先于 kill 调用，消灭登记竞态窗口）；②**exit handler 消费即删**（命中处理完立即移除条目）；③**TTL 兜底**（条目 60s 过期自动清除——若 kill 后 exit 事件丢失，残留条目会把该 session 下一次真实崩溃误抑制）；④**一切登记同时取消该 sessionId 的 pending respawn 定时器，respawn 执行前前置校验 session 仍存在**（挡住「已调度的 respawn」——session 崩后处于退避等待时被用户删除是自然场景）。命中集合的 exit 事件按退出形态分叉：信号/退出码与预期终止形态相符（如 SIGTERM/143）→ 记 `event=shutdown|rolling-restart|deleted` 不 respawn；**形态不符（如 code 1，登记后 kill 信号到达前恰好自崩）→ 仍记 `crash`（保留真崩溃取证）且不 respawn（尊重终止意图）**。runtime 退出前取消全部 pending respawn 定时器。
  4. **作用域**：仅**用户可见 session** 自动 respawn；hidden 公共 session（`session-lifecycle.ts` 的 `hidden` 标记）崩溃保持 lazy（无用户感知，下次使用经 `ensureActive` 恢复）——proactive respawn 若含 hidden 会无谓抬高进程基数，直接侵蚀 G3 的内存平台期。
  5. **在途 turn**：renderer 侧 pending 发送注册表在重连后发现该 turn 无终态帧时提示用户一键重发（消息级幂等由既有 msg-id 体系兜底）。
- **被否**：「保持 lazy restore（现状裁决）」——若用它，案例一场景里用户回来看到的是死态占位，必须手动点「重新打开」；30 天维度每次扩展崩溃都是一次手动恢复，G2 不成立。该裁决当时的论据是「死亡时无在途操作需要新进程立即接手，lazy 天然防 crash-loop」——**新证据使其不再成立**：① 扩展崩溃已从假设变为现实高频源（9/3 实锤，且 21 个自有 extension 的异步回调是同构风险面）；② crash-loop 风险用有界退避 + 熔断解决，不需要靠「用户手动」当熔断器；③ lazy 的收益（防 loop）与 proactive 的收益（无感）不再互斥。
- **证据**：respawn 路径是既有冷启动恢复路径（`session-lifecycle.ts:830` `restoreSession`），非新机制；退避/熔断与 supervisor 既有退避（restart-policy.ts）**语义同构而非相同**（计数语义差异见采用块第 1 条）。**实施时须同步修订 `docs/architecture/pi-exit-notification-and-respawn.md` §6.2 的裁决记录**（设计文档同步纪律 C-proc-10）。
- **效果**：G2 在 pi 层成立；配合 D5（遏制扩展错误源）使 respawn 触发率随时间下降。
- **代价声明（已接受）**：每次 pi 崩溃杀死该 session 的在途 turn。量级：每次崩溃 0-1 个在途 turn，仅影响该 session；恢复路径：pending 重发提示（采用块第 5 条），历史经磁盘 JSONL 无损；重审触发：台账显示 `auto-respawn` 周均 >5 次 → 说明扩展错误源治理（D5）失效，回头治理源头而非调参；显式判定：**可接受**——崩溃已发生的前提下，「自动恢复 + 提示重发」严格优于现状的「手动发现 + 手动恢复」。

**D3：runtime 内存看门狗 + 优雅滚动重启（选定）**

- **采用**：runtime 内建水位采样（每 60s `process.memoryUsage()` 进内存环 + 每 5 分钟一行水位日志）→ 两级阈值（相对 `v8.getHeapStatistics().heap_size_limit` 的百分比，告警 70% / 临界 85%，具体校准留实施期探针）→ 告警级先降级（清历史重建缓存等可回收物）→ 临界级走**优雅滚动重启**：广播预告 → 逐 session SIGTERM pi（等 flush）→ 专用退出码退出 → supervisor 识别该码**立即重启、跳过退避与崩溃计数** → 新 runtime 自动 reattach 原活跃 session。renderer 侧对「计划内重启」显示非阻塞横幅而非整屏替换。三个支撑机制：
  1. **持续 checkpoint 交接**：`<dataDir>/run/runtime-checkpoint.json` 不由滚动重启临时写，而是 runtime 在 session attach/detach 时**持续增量维护**（活跃 session 清单 + 元数据；原子写 tmp+rename）。新 runtime 启动流程 = 读 checkpoint → 收割孤儿 pi（等既有 `reapOrphanPiProcesses` 完成，或确认该 session 无 live 孤儿——**存在 live 孤儿的 session 必须等收割后再 spawn**，消灭「hung 旧孤儿与新 spawn 短暂双持同一 session 文件」的瞬态窗口，即 EEXIST 历史事故区）→ 按 checkpoint 自动 reattach（spawn + `switchSession`）→ 全部 session 尝试完成后删除主文件（逐 session 容错：失败 session 走 lazy 恢复，不保留主文件等待重试）。**这统一了计划内与非计划重启的恢复路径**——kill -9 崩溃场景（无优雅退出机会）由此也被自动恢复覆盖。五条生命周期契约：
     - **clean shutdown 删除 checkpoint**：自动 reattach 只服务崩溃与滚动重启恢复，**不改变冷启动 lazy 语义**——app 正常退出后下次启动不 eager spawn pi，避免启动期进程基数与内存峰值被常态性抬高（侵蚀 G3）。删除动作置于 shutdown 序**最早的可写点**（早于 pi 杀链与任何 kill 升级，避免「SIGKILL 收尾跑赢删除」）；启动侧双保险——冷启动时结合 main-running.marker 判定 checkpoint 可信度：上次为 unclean exit（marker 残留）→ checkpoint 可信，走恢复；上次为 clean exit 但 checkpoint 残留（删除失败的边缘场景）→ 忽略之并记 `reattach-skipped`，冷启动维持 lazy。
     - **staleness guard**：reattach 前校验 session 文件仍存在——用户在 checkpoint 维护事件后、崩溃前删除的 session 不得被复活（restoreSession 对不存在文件的行为不作为隐式依赖，guard 是架构级契约）；不满足则跳过并记台账 `event=reattach-skipped`。
     - **完整性降级**：crash 发生在 checkpoint 写入中途 → tmp+rename 保证读到的是上个完整版本；仍解析失败则记台账 `event=checkpoint-corrupt` 并退回既有 lazy 恢复（用户操作触发 restoreSession，不劣化于现状）。checkpoint 是 hint 非权威，失败永远可降级回 lazy。**逐 session 容错**：单个 session reattach 失败（文件损坏 / switchSession 拒绝）跳过并记台账，不阻断其余 session 的恢复。
     - **失败现场优先**：reattach 失败时快照另存 `checkpoint-failed-<ts>.json` 供诊断，主文件继续正常生命周期——后续增量维护不覆盖失败现场。
     - **风暴防护与收割时序**：分批 reattach（并发上限 2-3）+ 高水位延迟（系统高压时延迟 reattach 并横幅告知）——若崩溃本身由内存高压诱发（案例三形态），集中 spawn 会诱发二次崩溃；reattach 新 spawn 的 pi ppid = 新 runtime，不在 ppid=1 收割规则内（该论证 macOS 成立；Linux subreaper 场景需实施期重新评估——`reap-orphan-pi.ts` 头注释已登记该边界，Taiji 现为 macOS-only）；但 ppid 论证不覆盖「hung 旧孤儿与新 spawn 双持 session 文件」的瞬态窗口——已由主文启动流程的「live 孤儿必须等收割后再 spawn」约束消灭，P9 探针实测覆盖该瞬态。
  2. **relay 活跃推迟**：滚动重启决策做出后先查 relay 注册表——有在途 subagent 任务则推迟（横幅告知「等待后台任务完成后热重启」，用户可强制立即重启）。无此检查，滚动重启会经 kill-on-disconnect 无预警全灭在途 subagent。推迟必须有界且可升级：**推迟上限 30 分钟**（subagent 任务级无墙钟超时是项目既定原则，故推迟方必须有界）；**硬性升级阈值，双输入维度**——runtime 自身 heap 升至 heap_size_limit 的 92%，**或** schema 已有的系统级 `memPressure` 越阈值（swap 接近耗尽 / 物理空闲低于下限——案例三的真实死法正是系统级而非 runtime 自身视角），任一触发则无视 relay 活跃立即执行（两害相权：推迟期间发生 uncaught OOM 同样经 kill-on-disconnect 全灭 subagent，且叠加全 session 级联 + 丢失优雅退出的 checkpoint 维护机会，是严格更差结局；系统压力可被 pi 进程群 / renderer / 其他应用推高，只看 runtime heap 会留盲区）；「推迟后被硬执行」台账单独记 `event=rolling-restart-forced` 供重审观测。
  3. **计划内终止标记**：滚动重启的逐 session SIGTERM 携带计划内标记，pi exit handler 据此记 `event=rolling-restart` 且不触发 D2 respawn（见 D2 采用块第 3 条）。
- **被否**：① 「只重启不降级」——水位告警期直接重启会频繁打断用户（假阳性代价）；② 「固定 RSS 阈值」——不同机器物理内存差异大，相对 heap 上限的百分比自适应；③ 「runtime 永不重启只靠 GC」——30 天维度的碎片化与第三方库泄漏不可控，滚动重启是公认的兜底形态。
- **证据**：supervisor 重启链已存在（runtime-supervisor.ts），滚动重启只是给它新增「计划内重启」退出码分支；pi 进程独立持有 session 文件读写，优雅 SIGTERM 后 respawn 即可无损 reattach（同 D2 的 restore 路径）。
- **效果**：G3 成立（内存压力走降级/计划重启，不走 uncaught 崩溃）；30 天运行的内存平台期有上限。
- **代价声明（已接受）**：滚动重启期间在途工作中断。量级：每次重启影响 = 当时正在生成的 turn（通常 0-1 个）**+ 当时全部在途 subagent/后台任务**（pi 被 SIGTERM → relay kill-on-disconnect 连坐）——活跃 relay 推迟策略（支撑机制 2）把常规场景的后一项降到 0，残余是「推迟上限到期/硬阈值触发仍强制执行」的场景；**推迟本身的风险敞口**：推迟窗口内 uncaught OOM 概率随时间上升——由 30 分钟推迟上限 + 92% 硬升级阈值封顶，最坏结局退化为现状的崩溃恢复路径（checkpoint 自动 reattach 兜底），不新增无兜底损失；恢复路径：turn 走 D2 的 pending 重发提示，在途 subagent 无自动重跑通道（诚实声明，用户需重新发起）；重审触发：滚动重启实际执行频率 > 每周 1 次、推迟次数月均 >10 次、或 `rolling-restart-forced` 月均 >3 次（说明水位治理不足或阈值失准），回头校准阈值或排查真实泄漏；显式判定：**可接受**——滚动重启是内存底线的罕见兜底路径，换取 30 天不崩的下界保证。

**D4：renderer 自愈闭环——错误边界 + 崩溃自动重载 + 草稿持久化（选定）**

- **采用**：① 全局错误捕获（`app.config.errorHandler` + `window.onerror` + `unhandledrejection`）→ 错误经 IPC 落盘 `logs/renderer-error-*.log` + 台账 + 非阻塞 toast（不再白屏）；主面板级错误边界组件，单个面板崩溃不卸载整树；上报通路带节流 + 同签名去重窗口（D1 防漏设计 3）。② main 的 `render-process-gone` 从「只打日志」升级为「台账 + 自动 reload」，循环保护（**per-window 计数**，5 分钟内同窗口第 3 次崩溃 → 该窗口转崩溃页 + 诊断导出入口；全部窗口适用自动 reload，一窗口的崩溃计数不影响其他窗口）。③ 输入草稿防抖持久化到 localStorage，reload 后恢复；草稿发送成功即删、session 删除时清对应草稿。④ main 定期用 `app.getAppMetrics()` 采样各 renderer 内存，超阈值通知 renderer 收紧 LRU。
- **被否**：「白屏后用户手动 Cmd+R」——若用它，案例三场景下用户不知道可以重载、也不知道会话数据是否还在，G2/G4 同时不成立。
- **证据**：renderer 状态可从 runtime 重建——既有 WS 断线恢复链（重连 + resubscribe + 状态快照回放）已经证明「renderer 进程内状态是可再生的视图态」，reload 与断线重连走同一条路。
- **效果**：G2 在 renderer 层成立；案例三从「白屏挂住」变为「2-3 秒自动恢复」。
- **代价声明（已接受）**：自动 reload 丢失全部**非草稿 UI 暂态**——设置页未保存的编辑（「放弃未保存的改动？」对话框证明该状态真实存在）、滚动位置、面板/浮层展开态、文件选择器内容等。逐项判定：草稿（唯一有用户创作成本的内容）已持久化兜底；其余均为秒级可重建的浏览态。量级：每次 reload 丢失当窗口全部非草稿视图态；恢复路径：无，声明放弃（逐类持久化的复杂度与维护成本远超收益）；重审触发：台账显示 renderer reload 月均 >4 次时评估扩大持久化面；显式判定：**可接受**。另：**草稿明文落盘**（localStorage 在 Chromium userData，prod 不在 dataDir 内）——与 session 历史 JSONL 本就明文落盘同级敏感度，不联网、可随 session 删除清理，隐私判定：可接受。

**D5：extension 错误遏制体系——ext-guards 扩展 + 全包普查（选定）**

- **采用**：在既有 `extensions/shared/ext-guards`（现已有 `oncePerProcess` 等守卫）中新增两类守卫原语：① **异步回调兜底**（包一切 extension 的定时器/事件/Promise 回调：catch 所有异常 → 记日志 + 经 select 通道上报台账，绝不向上抛进 pi 进程空间）；② **stale-ctx 安全调用**（包 `pi.sendUserMessage` 等 ctx 方法：识别 stale ctx 错误降级为 warn 日志）。21 个自有 extension 全量接入 + 接入情况纳入 extensions 检查三连（typecheck/lint/test）。stale ctx 错误的识别串纳入既有 pi 版本门禁探针族（`check-pi-semantics.mjs`）防 pi 升级漂移。
- **被否**：① 「靠 pi 上游修 extension 隔离」——项目铁律不改 pi；② 「只修 smart-context 个案」——同构风险面在全部 21 个包的异步回调，修个案 = 等下一次；③ 「在 runtime 侧兜底」——runtime 与 extension 之间隔着 pi 进程，runtime 无法替 pi 进程内代码 catch 异常，鞭长莫及。
- **证据**：ext-guards 包已存在且定位就是「pi 运行环境隐式坑的守卫集中一处」（包注释原文）；9/3 崩溃堆栈证实错误从异步回调直达进程顶层。
- **效果**：案例一的整个故障类别在自有扩展范围内被结构性消灭；残余风险 = 用户自装的第三方扩展（不受我们守卫覆盖）——由 D2 的自动 respawn 兜底，用户感知从「session 死了」降为「自动恢复 + 一条系统消息」。量级声明：第三方扩展崩溃频率不可控但概率低（默认安装集为 builtin mandatory 清单内包）；重审触发：台账显示第三方扩展崩溃月均 >2 次时评估扩展沙箱立项。

**D6：长跑资源治理——加载预算化 + 驻留有界化 + 日志轮转补全（选定）**

- **采用**（架构方向，协议细节留给子系统设计）：① session 历史加载从「全量单帧」改为**分页预算协议**（按 turn 数 + 字节数双预算，活跃 session 路径同样受限）；② renderer `entryStates` 累积态按条目截断，toolResult 图片落盘引用化；③ pi stdout tee 日志加大小轮转——分段文件命名必须保持 `pi-` 前缀（否则旋段文件逃出 `cleanExpiredLogs` 的 7 天清理白名单，变成新的无清理写入面）；保留最后 N 段（tee 的核心价值是「pi 卡死时的决定性证据」，现场在尾部，保留末段即保全）。**显式登记推翻** `logger.ts` 既有裁决「tee 不轮转：单 session 事件量可控」——本机 198MB 单文件实证推翻了其前提；④ runtime 全量读路径统一过 statSync 预检 + 分块流式解析（短期护栏的协议化演进）。
- **被否**：「不动数据路径，只靠看门狗（D3）兜底」——若用它，每次打开大 session 都是一次内存尖峰，看门狗从「兜底」变成「高频主路径」，违反超时/兜底原则的同样教训（兜底被高频触发 = 正常路径 broken）。
- **证据**：本机 198MB tee 文件与全量加载链路代码事实（§2.3 失败模式 D）。
- **效果**：G3 的内存平台期由「数据路径有界」保证，看门狗回归兜底角色。
- **迁入注记（源：long-run-stability-prevention-deep-dive.md，2026-09-13 文档整合，该文档已删除 git 可追溯；其已实施项不迁，仅以下两条仍长期有效）**：
  - **pi RPC 无倒序分页的外部约束（长期有效）**：pi 的 `get_entries(since)` 只有正向增量游标、无 tail/range 参数（[MANDATORY] 不改 pi）——「pi→runtime 的全量传输」中间成本不可消除，能消除的是全量驻留（缓存只留窗口）、全量下发（帧只含窗口）、renderer 全量 parse；中间峰值以「restore 后首屏走文件尾读 + 后台增量 reconcile 收敛」缓解。此约束是上文 ① 分页预算协议在活跃路径的实现形态依据。
  - **未实施遗留项（renderer 层，登记不展开）**：streaming 超长消息的 markdown 每帧全文行扫描 + 前缀整体拷贝（`markdown.ts` 行扫描路径，MB 级消息 O(n²) CPU）——非崩溃源，归 `taiji-renderer-optimize` skill 领地择机处理；LRU 豁免卡死面已被既有 streaming idle 30min 收口定时器覆盖。

**D7：诊断导出——取证链路的用户出口（选定）**

- **采用**：设置页新增「导出诊断包」：main 进程打包 crashes/ 台账 + 各层日志尾部（截取非全量）+ 内存水位曲线 + 版本/平台信息为 zip，用户自选保存位置。死态 UI 与崩溃页都带「导出诊断包」入口（D2/D4 的错误恢复指引统一指向它）。
- **被否**：「联网自动上报」——隐私与合规成本远超收益，本地手动导出对本项目用户群（开发者）足够。
- **证据**：本次调研的人工取证成本（翻 DiagnosticReports + 拼三个日志）即 G4 不成立的直接证据。
- **效果**：G4 闭环——台账（D1）有出口，「错误 → 恢复指引 → 取证」链路完整。

### 3.4 探针清单（运行时行为断言与验证门）

| ID | 验证的行为断言 | 探针方式 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P1 | pi 异常退出后 runtime 检测、广播 `session.exited`、三 Map 无残留 | 既有设计 pi-exit-notification-and-respawn 的 V1-V3 实测 | ✅ 已验证（该设计已交付） | — |
| P2 | respawn 复用 `restoreSession`（spawn + switchSession 附加磁盘历史）历史完整 | 冷启动恢复是日常在用路径 | ✅ 已验证（既有行为） | — |
| P3 | pi 收到 SIGTERM 后会 flush session 文件再退出（滚动重启无损的前提） | 实施期实测：对活跃 pi 发 SIGTERM，比对退出前后 session 文件尾部 entry | ⛔ E5 实施门前必跑 | 失败 → 改为先 RPC 触发 flush/ compaction 再杀；仍不行 → 滚动重启接受尾部未 flush 丢失并在预告横幅声明 |
| P4 | `app.getAppMetrics()` 在 macOS 打包版能提供 per-renderer 内存读数 | 实施期在打包版打点验证字段可用性 | ⛔ E4 实施门 | 失败 → renderer 内存监控降级为仅台账记录 render-process-gone 时的系统压力快照 |
| P5 | localStorage 在 renderer 进程崩溃后仍保留最近写入（草稿恢复的前提） | 实施期实测：写草稿后对 renderer helper 进程 `kill -SEGV`，重载后读回（打包版 contextIsolation 下 `process.crash()` 不可行，同 V2 结论） | ⛔ E4 实施门 | 失败 → 草稿改经 IPC 同步写 main 侧文件（成本更高但确定性保证） |
| P6 | renderer reload 后经既有 WS 恢复链（重连+resubscribe+快照回放）可重建全部 session 视图态 | 断线重连链已交付并在用；reload 全链实施期实测 | ⛔ E4 实施门 | 失败 → 崩溃页提示用户手动重开 session（现状行为，不劣化） |
| P7 | 水位降级动作（清缓存）足以让大多数告警回落、不频繁触发滚动重启 | 实施期压测：构造大历史 session 反复加载，观测水位曲线 | ⛔ E5 实施门 | 失败 → 阈值/降级动作校准；仍不回落 → 滚动重启升为主路径，频率上限（每天 ≤N 次）防循环 |
| P8 | 滚动重启全程 < renderer WS 重连放弃窗口（60s） | 实施期计时：从广播预告到 renderer 恢复 | ⛔ E5 实施门 | 失败 → 计划内重启由 supervisor 经既有 `runtime-restarting` IPC 通道告知 renderer 进入「热重启」展示态并延长等待；**不动 ws-client 全局 60s 放弃阀的默认语义**（该阀是断线场景唯一终止阀，专用分支只作用于 supervisor 明确告知的计划内重启） |
| P9 | 持续 checkpoint 自动 reattach 与既有孤儿收割（ppid=1 判定）不互相误杀：reattach spawn 的新 pi 不被 reap，旧孤儿不阻碍 reattach；**瞬态双持窗口被消灭**（hung 旧孤儿与新 spawn 从不同时持有同一 session 文件） | 实施期实测：`kill -9` runtime 后重启，验证旧孤儿被收割 + 新 spawn 的 pi 存活 + session 历史完整；专项观测 5s 收割宽限窗内 reattach 先行 spawn 的场景（构造 hung 孤儿）确认无双持 | ⛔ E5 实施门 | 失败 → 调整启动顺序（先 reap 后 reattach 串行化）；仍冲突 → reattach 集合与 reap 集合按 sessionId 求交显式排除 |

## 4. 验收（真实场景，非单测非 mock）

**本章结论**：七个验收场景在**真实打包版 TaiJi.app**（非 dev mock）上以故障注入方式验证四个目标；V1-V3 验自愈，V4-V5 验长跑，V6 验取证，V7 验宿主不变量。

**V1（验 G1+G2，pi 层自愈）**：打包版 app 中开三个 session（A/B/C）各自有对话历史。对 A 的 pi 进程 `kill -9`。通过标准：10 秒内 A 自动恢复（可发消息、历史完整、聊天流有恢复系统消息）；B/C 全程无感知（无状态抖动、无消息错乱）；台账 `runtime.jsonl` 新增 `layer=pi, event=crash` + `event=auto-respawn` 两条记录。**反向验证**：对 A 连续注入 5 次崩溃，第 3 次退避失败后 A 进入死态 UI（不再无限重启），死态带崩溃原因与「导出诊断包」入口，B/C 仍无感知。

**V2（验 G2，renderer 层自愈）**：打包版 app 中，当前 session 输入框有未发送草稿，对 renderer 进程注入真实崩溃：取 renderer helper pid（`pgrep -f "Electron Helper \(Renderer\)"`，多窗口下命中多个 pid 时按目标窗口选最近启动的一个）后 `kill -SEGV <pid>`（与案例三的真实死法同构；打包版 contextIsolation 下页面无 `process` 对象、`chrome://crash` 不可达，DevTools 注入不可行）。通过标准：窗口自动 reload，30 秒内回到当前 session 且历史完整；草稿恢复；toast 提示界面已恢复；台账 `main.jsonl` 新增 `layer=renderer` 记录。**反向验证**：5 分钟内注入 3 次 renderer 崩溃，第 3 次进入崩溃页（不再 reload 循环），崩溃页有原因摘要与诊断导出入口。

**V3（验 G1+G2，runtime 崩溃的自动恢复）**：注入 runtime 崩溃（`kill -9` runtime pid，无优雅退出机会）。通过标准：supervisor 重启 runtime 后，新 runtime 读持续 checkpoint 自动 reattach 原活跃 session（不需要用户逐个点击恢复）；renderer 显示过渡态；恢复后发消息正常、历史完整；台账可区分 `event=crash`（runtime 自身）与各 pi 的退出/收割记录（kill -9 场景孤儿 pi 经收割入账）。**反向验证**：①正常退出 app 与触发滚动重启两种路径下，pi 退出只记 `event=shutdown|rolling-restart`，**不记 `crash`、不触发 auto-respawn**（台账无假崩溃记录）；重启后无新旧两个 pi 同时持有同一 session 文件；正常退出后下次冷启动**不**自动 reattach（维持 lazy 语义）。②删除一个活跃 session 后：无 respawn 调度（含退避等待中的 pending 定时器被取消）、台账记 `event=deleted` 而非 `crash`、该 session 不出现在重启后的恢复集合里；另构造一次 restore 失败（损坏 session 文件头），验证清场退出不触发 respawn 链、不记 `crash`。③checkpoint 两条降级路径：手工写坏 checkpoint 文件 → 启动 → 验证退回 lazy 恢复（无 eager spawn）+ 记 `event=checkpoint-corrupt`；`rolling-restart-forced` 场景（relay 活跃 + 硬阈值）注入复杂度高，下沉到 E5 子系统验收（本文登记该义务）。

**V4（验 G3，内存压力降级）**：构造真实大历史 session（≥50MB 历史文件，用真实对话累积或复制真实大文件），运行时给 runtime 附加 `--max-old-space-size` 限制压缩 heap 上限以加速触发。反复切入该 session + 点「加载更多」。通过标准：水位越告警线时台账出现 `event=memory-relief` 且水位回落或触发滚动重启；全程无 uncaught 崩溃；滚动重启后 session 自动 reattach、历史完整。

**V5（验 G3，长跑 soak）**：打包版 app 真实日常使用连续 14 天（允许夜间锁屏，不要求 24h 活跃；14 天作为 30 天目标的实用代理，通过标准含外推判据）。通过标准：① 台账中所有自愈事件可解释（每条能对应到真实触发源，`shutdown|rolling-restart` 与 `crash` 分类正确）；② runtime/renderer 内存水位曲线无不可逆单调增长（允许平台期波动），**14 天观测到的增长率线性外推至 30 天不越水位阈值**；③ 第 14 天时第 1 天发生的崩溃事件仍可完整归因（detailDigest 内嵌，不依赖已超 7 天保留期的详情日志）；④ 第 14 天所有 session 功能正常，进程基数稳定（无 hidden session 被无谓 respawn 导致的进程数爬升）。

**V6（验 G4，取证闭环）**：V1/V2/V4 每次注入后，设置页导出诊断包。通过标准：zip 内含本次崩溃的台账记录（层/原因/内存水位/版本齐全）+ 对应层日志尾部；仅凭 zip 内容能回答「哪层崩的、为什么、影响了谁」，不需要访谈用户。

**V7（宿主不变量，反向场景）**：V1-V6 全部完成后重启 app。通过标准：session 列表/历史/设置与注入前一致（注入杀死的 session 其磁盘历史完整）；`logs/crashes/` 按 10MB 轮转无无限增长；`~/.xyz-agent` 下无本设计 D1 写入面清单之外的新增无清理通道写入面；日志目录总大小有界。**dev/prod 隔离判据**：验收期间并行运行 dev 实例（`~/.xyz-agent-dev`）时，prod 台账无任何 dev 来源事件（全部新写入面遵循 `getDataDir()` 实例隔离）。

## 5. 下一层拆分（子系统清单与依赖）

**本章结论**：实施优先级遵循「**根治 > 取证 > 自愈**」——自愈是兜底，兜底先于正常路径修复落地会把「频繁崩溃」变成「频繁静默恢复」，掩盖真实问题（兜底被高频触发 = 正常路径 broken 的信号）。因此分三个阶段：**阶段一先做消灭崩溃源头的 E2（extension 遏制）与 E6（资源治理）**，阶段二做取证基建 E1 与出口 E7，阶段三才做自愈 E3/E4/E5——且自愈落地时必须「永不静默」（每次自愈动作对用户可见 + 台账可数，触发率是受监控指标而非免费福利），防掩盖约束写入各子系统设计。E1 中仅「内存水位打点」（每 5 分钟一行日志）提前并入阶段一——它是验证 E6 有效性的必要观测，成本近零。

| # | 阶段 | 子系统（各自需独立技术方案设计文档） | 对应决策 | 依赖 | 为什么这么拆 |
|---|---|---|---|---|---|
| E2 | **一（根治）** | **extension 错误遏制**：ext-guards 新增异步回调兜底 + stale-ctx 安全调用；21 包普查接入；stale 错误识别串入 pi 版本门禁探针族 | D5 | 无硬依赖（日志先走既有 extension-logger） | 消灭最大已实锤崩溃源；独立交付即见效；验收 = 该类别崩溃归零 |
| E6 | **一（根治）** | **资源治理协议化**：历史分页预算协议 + entryStates 截断/图片落盘 + tee 日志轮转 + 大文件读流式化（含内存水位打点） | D6 | 无硬依赖 | 数据路径有界化是 30 天内存平台期的根本保证；水位打点验证自身有效性 |
| E1 | 二（取证） | **崩溃台账与水位打点基建**：crash journal 双文件 writer、Schema 落 `packages/shared`、轮转、`cleanExpiredLogs` 白名单扩展 | D1 | 建议阶段一后（水位打点已提前） | 阶段一落地后崩溃应趋零，台账主要服务残余事件归因与阶段三自愈的可观测 |
| E7 | 二（取证） | **诊断导出**：设置页入口 + 打包逻辑 | D7 | E1 | 取证闭环出口 |
| E3 | 三（自愈） | **pi 崩溃自动自愈**：bounded respawn（连续失败计数 + 熔断 + 分类差异化）+ 主动终止抑制通道（intentional-kill 集合，覆盖 shutdown / 滚动重启 / delete 族 / restore 清场 / create-fork 失败清理，登记枚举含 tempId 与 forkedId）+ respawn 作用域限定 + 死态 UI + 在途 turn 重发提示；同步修订 pi-exit-notification-and-respawn.md §6.2；**防掩盖：respawn 事件必须用户可见（toast/系统消息）+ 台账计数纳入重审触发** | D2 | E1 | 前两阶段完成后残余崩溃频率应已显著下降，自愈的性价比与风险面在此阶段重新评估 |
| E4 | 三（自愈） | **renderer 自愈闭环**：全局错误捕获（含节流去重）+ 面板级错误边界 + render-process-gone 自动 reload（per-window 循环保护）+ 草稿持久化（含清理通道）+ 内存压力联动；**防掩盖：reload 必须带可见 toast 与台账计数** | D4 | E1 | 同上 |
| E5 | 三（自愈） | **runtime 看门狗与滚动重启**：水位采样 → 降级 → 滚动重启（专用退出码 + supervisor 计划内重启分支 + **持续 checkpoint 交接文件**含冷启动/容错/风暴防护契约 + 崩溃/滚动重启统一自动 reattach + relay 活跃推迟（30 分钟上限 + 双维度硬升级阈值）+ 非阻塞横幅）；**防掩盖：滚动重启必须横幅可见 + `rolling-restart-forced` 计数纳入重审触发** | D3 | E1；E3 先行（复用 respawn 设施与抑制通道） | 最复杂、兜底性最强的一个，放最后；届时若阶段一已消除内存压力，可依据水位数据裁剪甚至缓建 |

**文件改动地图（架构级，细节归各子系统设计）**：

- 新增：`packages/runtime/src/infra/crash-journal.ts` + renderer-error 日志 writer（E1）、`apps/electron/main/` 侧台账 writer 与 `render-process-gone` 升级、clean-exit marker（E1/E4）、`extensions/shared/ext-guards` 新守卫原语（E2）、runtime 看门狗模块与 `run/runtime-checkpoint.json` 持续交接文件（E5）
- 改写：`rpc-client.ts` exit handler 接台账与抑制通道（E1/E3）、`session-service.ts`/`process-manager.ts` respawn 编排（E3）、`window-factory.ts` 崩溃恢复（E4）、renderer `main.ts` 全局错误处理与错误边界组件（E4）、`restart-policy.ts`/supervisor 计划内重启分支（E5）、`logger.ts`（`cleanExpiredLogs` 白名单扩展 + tee 轮转，E1/E6）、历史加载链路分页（E6）
- 收敛：`session-history.ts`/`session-file-utils.ts` 全量读路径统一收口到带预检的读取原语（E6）

**待验证检查点（设计阶段无法确定，实施期必须回答）**：P3（pi SIGTERM flush 行为）、P4（getAppMetrics 打包版可用性）、P5（localStorage 崩溃存活）、P9（checkpoint reattach 与孤儿收割的交互）、水位阈值的具体校准值、持续 checkpoint 的字段集。

## 附录：与既有文档的关系

- 本文修订 `docs/architecture/pi-exit-notification-and-respawn.md` §6.2 的「lazy respawn」裁决为「bounded proactive respawn」（理由见 D2），实施 E3 时同步回写该文档。
- 本文与 `docs/design/pi-boundary-reliability.md`（pi 语义吸收层）正交：该设计防「语义漂移」，本设计防「进程死亡与资源衰变」。
- 短期点修清单（smart-context stale ctx 修复、render-process-gone 最小 reload、WS 帧上限、全量读护栏）由用户另行安排，本文 E2/E4/E6 会将其协议化收编，不冲突。
