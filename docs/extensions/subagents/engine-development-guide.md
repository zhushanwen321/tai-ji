# Subagent 引擎开发指南（契约面 + 评估 checklist）

> **状态**：已填充（2026-09-18；同日经三份对抗式审查（术语一致性/简洁性/架构补缺）修复，采纳项锚点二次核实）；最后全量复核 = 2026-09-19 漂移修复。单 hash 锚点声明已废弃——行号随源码演进漂移不可作锚，锚点后的语义级变更同 commit 登记于 §15 变更追记（引用行号前 grep 实测为准）。
> **定位**：面向**引擎作者与引擎改造评估者**的契约义务清单——「对接/开发/改造一个 subagent 引擎要实现什么、声明什么、验收什么」。回答「是什么 + 怎么评」；「这套体系由什么组成、机制落在哪」由 [architecture.md](architecture.md)（现状 SSOT 导航页）承载，本指南不重复。
> **读者/读取时机**：新引擎接入或既有引擎改造的 tech-design 设计期（评估 checklist 输入）、dev-flow 实施期（义务对照）、CR（契约面核对）。
> **断言分级**：反引号内符号 = 现行代码引用（doc-symbol-drift 守卫已登记本指南，登记事实见 §12）；「已裁决未实施」= 设计已经审查收敛、随对应设计实施落地，不得当现状引用。本指南涉及两项已裁决未实施的 zcode 改造：**设计 3（zcode 续聊 native resume）**——同 session 续写、锚稳定、两级降级链；**设计 4（zcode schemaEnforcement 升级 + MCP 提交工具自纠闸门）**。易混淆点：zcode 现状已落地的 resume 读失败单级朴素降级（§7 读失败分支，[U3] 2026-09-19）不属设计 3 的两级降级链，勿据其认定设计 3 已部分实施。两项裁决正文暂在仓外工作流产物（不入库），本指南 §7/§10 的登记即唯一仓内权威，勿按编号外部检索；实施落地时设计文档归宿另行裁决。可靠性模式沉淀于 §10。
> **更新触发（同 commit 义务）**：engine-protocol 版本、capability 枚举值、错误码词表、引擎生命周期语义（轮终/abort/timer/接管点）、引擎子进程 spawn/env 契约（§9，约束 C-proc-12）、SessionView 契约任一变更 → 本指南对应节必须同批更新（登记于根 AGENTS.md 主题索引；机器守卫见 §12）。

**实施期定型项**（台账，变更管理用；本指南登记其契约义务，行为细节随对应设计实施落地后回写——首次通读可跳过本表，术语见对应节）：

| 项 | 所属节 | 状态 |
|---|---|---|
| zcode 续聊 native resume 主路径（同 session 续写、锚稳定）与两级降级链 | §7 resume 轮 / §10 | 设计 3 已裁决未实施；现状 resume 轮 = cold 注入形态 + 读失败锚失效声明段继续形态（[U3] 2026-09-19，§7 如实描述）——设计 3 两级降级链仍未实施 |
| zcode MCP 提交工具 + 自纠重试闸门（闸门续轮形态） | §7 闸门续轮 / §9 mcp 目录 / §10 | 设计 4 已裁决未实施 |
| `schema_gate_exhausted`（设计 4 拟新增）错误码登记（进宿主词表） | §4 | 设计 4 已裁决未实施；登记义务先例已成立 |
| capabilities `conversation`/`resume` 升 `native`（两镜像 + 四处注释清扫） | §3 | 设计 3 已裁决未实施 |

## 0. 使用方式

- **新引擎接入**：从 §13 checklist 走，逐条回链 §1-§11 义务节。
- **既有引擎改造**（加能力/换通道/动生命周期）：从 §14 checklist 走——先查 §3 能力位与 §12 映射表确定波及面，再对照义务节评估。
- 两类入口的共同前置：读 [architecture.md](architecture.md) §1 包拓扑与 §3 协议面（本指南只列义务细节，不重复拓扑）。

**术语速查**（领域词见 [CONTEXT.md](../../CONTEXT.md)；下表为本指南定义或锚定的术语）：

| 术语 | 定义落点 |
|---|---|
| gate 位 / 非 gate 位 | §3——被 `assertTaskShapeSupported`/`assertGateCapabilitiesMatched` 判据涉及的能力位（steer/conversation/maxTurns/sandbox）与其余非 gate 位 |
| 接管点 | §7——引擎确立 session 身份的时点（create 应答 / 后续形态的装载确认），宿主侧副作用在此复刻 |
| 降级链族分层 / 族差分级告警 / 瞬态防护 / 宽限窗 / 溢流阀声明 / 探针声明纪律 | §10（本指南定义的可靠性模式名，源自两设计的审查裁决） |
| 锚换钉 | §10——record 的 sessionRef 被替换为新会话锚（历史连续性就此切断的最差降级形态） |
| 锚（`ResumeAnchor`） | §5——跨 run 续写的会话定位载体（`sessionRef` + `journalPath?`），经 `run.params.resume` 携带 |
| 杀链 / 收割 | §2.1/§7——宿主杀进程组终结在途任务的兜底路径；cancel 超窗或 abort 超窗触发，共享进程被收割时在途任务走崩溃路径（连坐） |
| 闸门续轮 | §7——同一 session 内的自纠重试续轮形态（设计 4，已裁决未实施） |
| live≡reload | §6/§8——事件 live 流与 journal 重放构造性等价（同 reducer），重开 session 对话流一致 |

## 1. 引擎准入形态

引擎 = 独立子进程，与宿主的唯一跨进程边界是 engine-protocol v1 NDJSON stdio（[architecture.md](architecture.md) §1）。core 壳侧零内建引擎——`pi` 亦经发现装载（`engine-discovery-roots` → `engine-discovery-scan` → `engine-inspect-package` → `registry.ts` → `routing.ts`，[architecture.md](architecture.md) §4 引擎装载行）。

**发现根义务**（引擎包必须落在可被扫描的位置，`engine-discovery-roots.ts:17-64`）：① L1 env `TAIJI_AGENT_ENGINE_ROOTS`（`path.delimiter` 分隔的绝对路径列表，全形态有效）；② L2 node_modules 上溯（宿主入口 `argv[1]` 所在目录逐级上溯收集，npm 安装形态；打包态/vendor 态无 node_modules 结构，L2 结构性无效）；③ staged 根（打包/dev 形态：runtime `services/session/engine-roots.ts` 推导——打包 `<cwd>/engines`（sidecar cwd = Resources）、dev `resources/engines`，目录存在时经 L1 env 显式注入）。入仓引擎的打包链两条均不写死清单：`scripts/bundle-extensions.mjs` 按 `packages/` 下 manifest（`taiji.subagentEngine.id`）动态发现并 bundle 到 `apps/electron/resources/engines/<id>/`，`electron-builder.yml` `extraResources` 按目录整体映射（`resources/engines` → `engines`）——新引擎入仓放对位置 + manifest 齐备即被覆盖，改动打包布局时两文件同批核对。

**manifest 义务**（package.json 顶层 `taiji.subagentEngine` 段；解析权威 = `packages/subagent-core/src/execution/engine/engine-manifest.ts`，检查管线 = 同目录 `engine-inspect-package.ts`）：

| 字段 | 必填性 | 校验行为（`engine-inspect-package.ts`） |
|---|---|---|
| `id` | 必填 | 非空字符串；缺失 → skip（:84-90） |
| `bin` | 必填 | 非空字符串，按 package.json npm `bin` 的 key 解析为入口绝对路径；解析不出或不可执行 → skip/unusable（:118-139、`canExecute` :279-286） |
| `protocol` | 必填 | 整数且落 `SUPPORTED_PROTOCOL_RANGE` [1,2)（:95-111；越界 → unusable，判据 `isProtocolVersionCompatible`，`engine-protocol.ts:44-50`） |
| `capabilities` | 必需 | 段缺失 = 全保守值 + warn；缺键/坏值 = 该键保守值 + warn；未知键忽略 + warn（`engine-manifest.ts:84-139`；保守值表 `CONSERVATIVE_CAPABILITIES` :32-44） |
| `envPrefixes` | 可选 | 非法条目（非 `^[A-Za-z0-9_]+$` / 含 `*` / 命中宿主保留前缀 `TAIJI_` 族）丢弃该前缀 + warn，包仍可用（:142-172；保留字 :23） |
| `modelCatalog` | 可选 | 缺省（不写该字段）、`null`、对象三态在解析后必须保持可区分，解析器不得归并（:182-207）：缺省/`null` = 不注入（宿主侧表现为「无枚举面」——模型校验整体跳过，该形态必须保持可达）；对象 = `{dynamic(缺省 true), models[]}`，models 键缺失/非数组时归一为 `null` + warn；models 数组存在但条目全无效时保留 `{dynamic, models: []}`——`models: []` 是「有枚举面但为空」的作者显式声明，解析器不得代填 |
| `displayName` / `description` | 可选 | 形态校验，坏值忽略 + warn（`engine-inspect-package.ts:146-161`） |

包级义务：`package.json` `version` 盖章进 descriptor（registry 稳定标识比较字段——包升级触发 dispose 换新实例，:254-256）。检查产物三态：ok（装载）/ skip（必需字段缺失，warn 跳过）/ unusable（protocol 不兼容、bin 不可执行，标记不可用）（:31-34）。依赖红线：引擎包只依赖 SDK（`@zhushanwen/subagent-engine-sdk`），不依赖 core（[architecture.md](architecture.md) §2.3）；SDK 消费入口仅限其 exports 两入口——`.`（契约根）与 `./protocol`（协议面），深路径 import 不在支持面。包命名与 `taiji.role` 分组约束见 [extension-conventions.md](../extension-conventions.md)。

现役 manifest 完整示例（zcode，与包内 package.json 逐键核对一致）：

```json
"taiji": {
  "subagentEngine": {
    "id": "zcode",
    "bin": "zcode-subagent-cli",
    "protocol": 1,
    "envPrefixes": ["ZCODE_"],
    "capabilities": { "schemaEnforcement": "emulated", "steer": "unsupported", "conversation": "cold", "personaInjection": "prompt", "eventGranularity": "stream", "sandbox": "emulated", "sessionRead": "full", "resume": "cold", "interrupt": "kill-only", "permissionMode": "native", "maxTurns": false },
    "modelCatalog": { "dynamic": true, "models": [] },
    "displayName": "zcode",
    "description": "ZCode app-server resident engine (...)"
  }
}
```

`modelCatalog` 与 §2 `listModels`/`validateModel` 的联动（`remote-engine.ts:108-182`）：manifest 省略 catalog 或 `models: null` → `validateModel` 成员**整体摘除**（消费方 `typeof validateModel !== "function"` → 跳过校验恒放行）；`dynamic: false`（静态目录）未命中 → 同步拒；`dynamic: true` 未命中 → 放行运行期自证。作者按引擎模型目录的真实形态选 `dynamic`：静态可枚举 → false，代价是未命中模型在派发前即被同步拒；动态（无法预先枚举）→ true，未命中放行、由引擎运行期自证。声明与实际形态不符会在错误的方向上放行或拒绝。

## 2. 协议实现义务（engine-protocol v1）

传输 = stdio NDJSON（`engine-protocol.ts:6-11`）：stdout 独占协议帧（应用日志走 `host/log` + stderr 兜底，禁写 stdout——SDK `cli-entry.ts:49`）；stderr 常驻排空，内存环形缓冲尾 400 字符（`STDERR_TAIL_CHARS`，`engine-protocol.ts:79`）供崩溃现场。帧型四类与 id 形态（正向 number / 反向 string）：`protocol/frames.ts:1-13`。

### 2.1 正向 9 方法逐方法语义（`protocol/methods.ts:32-54` 方法集；载荷 :119-238）

| 方法 | 调用时机 | 时序约束 | 超时分级 | 幂等 | 失败形态 |
|---|---|---|---|---|---|
| `initialize` | 引擎进程启动后、首个 run 前握手（`engine-client.ts:422-441`） | 必须是首个请求；应答仅诊断面——capabilities/models 与 manifest 不一致 → warn 留痕，不参与同步成员判据（`methods.ts:11-13`、:126） | 控制面：`HANDSHAKE_TIMEOUT_MS` = 10s（`engine-protocol.ts:60`） | 否（每连接一次） | 超时 → `engine_handshake_timeout` 引擎不可用；版本越界 → `engine_protocol_mismatch`；gate 位多声明 → `engine_capability_mismatch`（§3） |
| `probe` | 宿主诊断（可用性/版本漂移检测、fallback 三守卫输入） | 连接就绪后（`remote-engine.ts:184-190`） | 无宿主墙钟——引擎实现须快速返回；引擎内部子进程探测自设上限（先例 SDK `node-executor.ts:33` **PROBE_TIMEOUT_MS** = 5s） | 是（zcode `probeCache`，`force` 旁路，`zcode-engine.ts:213`） | `ProbeReport.ok=false` 时 `error{code,recovery}` 必填（`contract-types.ts:227-235`）；宿主归 `engine_probe_failed` |
| `run` | 任务派发（chat 域 `executeViaEngine` / workflow 域 SAR（SubprocessAgentRunner）.run） | 握手后；期间事件经 event 通知、句柄经 `host/handleReady` 回传；**应答到达即终态**（`methods.ts:153`） | **任务级无墙钟**（宿主不传 timeoutMs——`engine-client.ts:539`；超时治理 = 宿主显式 `timeoutMs` 走 cancel 链 + 引擎侧回收层 timer，§7） | 否（每 runId 一次） | 运行中失败不 reject——合成 error outcome + handle 正常返回（`remote-engine.ts:196-200`）；error 帧码按 §4 透传；进程崩 → `engine_crashed`（附 stderr 尾 400 字） |
| `cancel` | 用户取消或宿主超时链触发，仅 run 在途时 | 应答仅受理确认；**终态本体由该 run 的 run 应答承载**（`methods.ts:164-170`） | 控制面：`CANCEL_SETTLE_GRACE_MS` = 3s（`engine-protocol.ts:63`；`engine-client.ts:602`）——超窗 core 走杀链 | 是（`ok:true` 恒定） | 引擎须 3s 内收敛终态；stop 生效 = 终态在窗内到达；超窗 = 共享进程收割、在途任务走崩溃路径（zcode 实装 §7 abort 链） |
| `read` | SessionView 读取（降级链①级，§8） | handle 有效即可；`dataDir` 必填（存量定位依赖，`methods.ts:172-176`） | 任务级无墙钟（大会话慢读不设限，`remote-engine.ts:272-279`） | 是（纯读） | 引擎抛错 → 宿主降级链②③级承接（§8） |
| `listModels` | 模型目录诊断 | **宿主现行实装不发协议帧**——RemoteEngine 直读 manifest 快照三态映射（`remote-engine.ts:134-144`）；协议方法保留（`methods.ts:178-186`，`models: null` = 无枚举面） | 同步内存判定，无超时语义。引擎仍须实现并应答（属 9 方法集），宿主现行不调用 | 是 | 无（三态：null / [] / 数组） |
| `validateModel` | 模型 ref 校验 | manifest 同源判定（`remote-engine.ts:155-182`）；`dynamic:false` 且未命中（含 undefined 查缺省）→ 同步拒 **record 不创建** | 同步内存判定 | 是 | `engine_model_unknown`（同步拒）；`dynamic:true` 放行原样 ref，运行期引擎拒绝 → `engine_model_mismatch`（run 失败 + record 标 failed，`error-codes.ts:15`） |
| `dispose` | 引擎停机 / 包升级换实例 / 杀链清理 | 收尾阶段；应答 `ok:true` | 控制面：**DISPOSE_GRACE_MS** = 3s（`engine-client.ts:95`，杀链路径 :645） | **是**（协议明文「dispose 幂等」，`methods.ts:14`） | 超时不重试（杀链兜底）；幂等重入无害 |
| `ping` | 健康检查 | 连接就绪后任意时点（`engine-client.ts:593-597`） | 任务级（不设墙钟） | 是（`pong:true` 恒定） | **ADR-0047：静默 ≠ 卡死，不据此杀任务**（`methods.ts:14`）——ping 失败仅作诊断信号 |

超时分级的依据：控制面单请求（握手/取消受理/停机）= 秒级具名常量；run/read/ping 等任务级 = 无墙钟——任务执行正常路径禁自带超时，回收层兜底允许默认有界（opt-out），见根 AGENTS.md「超时默认原则」与 [crash-forensics-and-watchdog.md](../../architecture/crash-forensics-and-watchdog.md) 附录 E。zcode 引擎侧双 timer（idle 30min / ceiling 60min，`zcode-subagent-cli/src/constants.ts:113`/:122）即回收层默认有界的实装先例（env 可关）。

**run 的事件时序不变量**：事件 emit 完成先于 run resolve（不变量 5——journal 完整性依赖此序，journal 接线面 = workflow 域见 §6：coarse 事件在终态收口处补发，`zcode-engine.ts:900`）——引擎不得在 run 应答发出后再补发该 run 的事件。**进程自灭义务**：stdin 关闭（宿主退出/杀链断管）后引擎进程必须自行退出（SDK `armEngineSelfDestruct` 守卫，`spawn.ts:163`；bin 级 e2e 断言⑤「dispose 幂等 + 进程随 stdin 关闭退出」）——宿主不承诺显式 dispose 每个引擎进程。

### 2.2 反向通道 6 条（`protocol/reverse-channels.ts:24-55`；超时二分 `engine-protocol.ts:85-92`）

| 通道 | 超时类 | 载荷要点 | 用途与义务 |
|---|---|---|---|
| `host/log` | data-plane（10s） | level/component/message（:62-67） | 引擎日志落宿主日志；stderr 兜底未就绪/失败时日志不丢（SDK `cli-entry.ts:49-60`）；引擎任务子进程 stderr 须 tee 落盘 + 轮转（SDK `logs/stderr-rotation.ts` 单源——50MB/7 天参数读宿主同款 `TAIJI_LOG_*` env，两引擎包薄包装先例），漏接线则进程死后丢失唯一取证面 |
| `host/askUser` | **interaction（不设统一超时）** | runId + `UiRequest`（:70-74） | UI 请求经宿主 UI 通道呈现用户；**ack 两阶段**——宿主先回 `{ack:true}`，结果异步到达（`frames.ts:82-88`；已 ack 的等待不计入任何 in-flight 超时）；未实现回 `{unsupported:true}` 引擎自行降级不重试 |
| `host/streamDelta` | data-plane | runId + delta（:85-88） | UI 实时渲染加速（与 event 通知并行；关联键恒 runId） |
| `host/handleReady` | data-plane | runId + sessionRef（:95-98） | **运行中句柄回填**：create 应答后、早于 run resolve（AGENTS.md 关键规则 9「重开 session 仍可见」的前提）；引擎在确立 session 身份的时点必须发出 |
| `host/childSpawned` | data-plane | pid + recordId（:105-108） | 一次性子进程注册（isResumable 镜像谓词 + 诊断留痕）；**不供杀链/收割**（收割只靠进程组）；常驻进程不报（归 dispose） |
| `host/childStateChanged` | data-plane | pid + recordId + state + `killed`（**必含**）:115-123 | 子进程状态上报（宿主镜像 `hasLiveProcessHandle`/`isResumable` 同步读，不跨进程查询） |

data-plane 10s 未答 = 引擎故障 → 杀进程 + 在途 run 失败（`REVERSE_REQUEST_TIMEOUT_MS`，`engine-protocol.ts:57`）。已退役通道（已删通道名按守卫惯例不加反引号，避免被当作现行代码符号）：host/permission（骨架未接线死通道）与 host/poolResolved（池抽象降级）已删，通道集收敛为 6。

**SDK 协议码的 core 侧处置表**（引擎作者需知的失败语义，`error-codes.ts:7-20`）：

| 协议码 | 产生点 | core 处置 |
|---|---|---|
| `engine_not_found` | 配置/清单 id 无对应包 | 列出已发现引擎 + 配置路径 |
| `engine_protocol_mismatch` | 握手版本越界（`engine-protocol.ts:9-11`） | 该引擎标记不可用；升级 core 或引擎包；不影响其他引擎 |
| `engine_capability_unsupported` | **core 生成**（gate 同步拦，非引擎 error 帧透传） | 派发前同步拒，record 不创建 |
| `engine_capability_mismatch` | 握手发现 manifest 多声明（gate 位） | 该 run 失败 + record 标 failed + 清理前置副作用；非 gate 位不一致仅 warn |
| `engine_model_unknown` | validateModel 未命中且 `dynamic:false` | 同步拒（record 不创建） |
| `engine_model_mismatch` | `dynamic:true` 运行期引擎拒绝 | run 失败 + record 标 failed |
| `engine_handshake_timeout` | initialize 超时（10s） | 引擎不可用 |
| `engine_crashed` | 进程意外退出 | 在途 run 失败（附 stderr 尾 400 字）；**崩溃重建上限 3 次、指数退避 1s/2s/4s**（`CRASH_REBUILD_MAX_ATTEMPTS`/`CRASH_REBUILD_BACKOFF_MS`，`engine-protocol.ts:65-76`），超限标记不可用至宿主重启 |
| `engine_probe_failed` | probe 失败 | 既有 fallback 三守卫不变 |

**conformance 锁定面**：协议一致性由 `packages/subagent-core/src/execution/engine/__tests__/conformance/engine-conformance.live.test.ts` 套件锁定（引擎 manifest、relay 常量镜像、run 帧映射）；SDK 侧封闭断言在 `subagent-engine-sdk/src/__tests__/protocol.test.ts`（方法集/通道集同源互证）与 `contract-closure.test.ts`（core↔SDK 双向可赋值）；两引擎各有 bin 级协议 e2e（如 `zcode-subagent-cli/src/__tests__/protocol-e2e.test.ts`：握手/反向请求/event seq 单调/终态/dispose 幂等 + 进程随 stdin 关闭退出，五断言）。chat 域独立协议面已退役：续聊轮 = 新 run + `RunParams.resume` 锚点（约束 C-proc-13；`engine-protocol.ts:24-32`）。

## 3. capabilities 声明契约

**能力位全集 11 位**（`contract-types.ts:193-224` `EngineCapabilities`；声明的是本仓 subagent 链路实际接通的能力，不是引擎 RPC 层的理论能力）：

| 位 | 值域 | 语义与消费方 |
|---|---|---|
| `schemaEnforcement` | native/emulated | 结构化输出约束（§5 `task.schema` 分流依据） |
| `steer` | native/emulated/unsupported | 运行中注入；与 fork 通道族判定联动（`capability-gate.ts:85-94`） |
| `conversation` | **native/cold/unsupported** | 「怎么续」形态轴兼 message 资格轴：非 unsupported = 可续聊（`chat-rounds.ts:774`）；cold = 冷恢复重建 + 新 run + resume 锚点（`engine-manifest.ts:50-55`） |
| `personaInjection` | file/flag/prompt | persona 路由通道 |
| `eventGranularity` | stream/coarse | 粗粒度引擎 GUI 降级为阶段态 |
| `sandbox` | native/emulated/none | worktree 隔离（none → worktree 任务同步拒） |
| `sessionRead` | full/partial/outcome-only | read ①级保真度上限（§8） |
| `resume` | native/cold/unsupported | 冷续锚点兑现能力（§5 `resume` 键） |
| `interrupt` | native/kill-only | 优雅中断 or 只能杀进程（公共杀链兜底） |
| `permissionMode` | native/fixed/ignored | 权限档位映射 |
| `maxTurns` | boolean | 轮数上限执行能力（false → `maxTurns` 参数同步拒，`capability-gate.ts:95-102`） |

**声明点两处镜像必须同批改**：引擎类 `capabilities()`（`zcode-engine.ts:180-208`）与引擎包 package.json `taiji.subagentEngine.capabilities` 块（zcode 两处现行同为 `conversation: "cold"` / `resume: "cold"` 等 11 键，两侧逐键核对一致）。capability 头注必须与声明同批改写。设计 3（native resume，已裁决未实施）的清扫清单：`zcode-engine.ts:186-190` 头注、:322-327 续聊注释、`session-channel.ts` resumeSession 头注、`conversation-continuation.ts` resumeAnchor 注释——升位时若不与声明同批改写，声明旁会残留与新版声明自相矛盾的旧依据。

**消费判据与 gate 三方向**（`capability-gate.ts`）：

1. 放行判据 = `!== "unsupported"` 分支（`chat-rounds.ts:774`、`capability-gate.ts:143-148`）——升位不破坏消费方；`cold` 与 `native` 等价放行。
2. **少声明**（任务要求的能力 manifest 未声明）→ 派发前同步拒 `engine_capability_unsupported`（`assertTaskShapeSupported` :80-111；fork 通道族判据：manifest 的 steer 与 conversation **任一非 unsupported 即视为具备 fork 能力**（OR 判据，:149-158，manifest 与握手应答成对比较））。
3. **多声明**（manifest 支持而实装不支持）→ gate 读不到（同步面只有 manifest），由首个 run 握手发现 → `engine_capability_mismatch`：该 run 失败 + record 标 failed + 清理前置副作用（worktree 已建则清理）（`assertGateCapabilitiesMatched` :138-165）。
4. **非 gate 位**（personaInjection/eventGranularity/sessionRead/resume/interrupt/permissionMode/schemaEnforcement）不一致 → 一律 warn 留痕不阻断（头注 :33-35，`EngineClient.warnOnManifestDiagnostics`）。

**升降位裁决条件**：声明升级必须先改链路再改声明（`zcode-engine.ts:178`）。反向先例：zcode `schemaEnforcement` 维持 `emulated` 不升 `native`——位语义（native = 上游原生 schema 注入通道）未满足，升位会误导宿主按 native 假设分流（设计 4，已裁决未实施）。正向先例：设计 3（native resume，已裁决未实施）将 `conversation`/`resume` 升 `native`（实施期定型项）。manifest 是能力同步权威（注册期直读），握手应答仅诊断（`contract-types.ts:189-192`）。

## 4. 错误码与恢复指引契约

**两层词表分工**：

1. **宿主词表**（`packages/subagent-core/src/execution/engine/common/errors.ts:20-33`）：`ENGINE_ERROR_CODES` 封闭枚举 12 条——`engine_not_found` / `engine_probe_failed` / `engine_credential_missing` / `nested_spawn_rejected` / `schema_emulation_failed` / `engine_timeout` / `engine_capability_unsupported` / `engine_capability_mismatch` / `engine_session_not_resumable` / `model_not_available` / `prompt_too_large` / `engine_run_failed`。`DEFAULT_RECOVERY_HINTS` 为 `Record<EngineErrorCode, string>` 全集覆盖（:77-114）——**新增错误码漏写恢复模板在此处编译失败**（机器守卫；恢复模板全文以 errors.ts 为准，本指南不复制）。
2. **SDK 协议码**（`packages/subagent-engine-sdk/src/protocol/error-codes.ts:23-33`）：`ENGINE_PROTOCOL_ERROR_CODES` 9 条固定词表（全文见 `error-codes.ts:23-33`）+ 透传前缀判定（`ENGINE_ERROR_CODE_PREFIX = "engine_"`，:46-52）——非固定词表但带 `engine_` 前缀的引擎自报码由 core **原样透传，不解释文案**。

**引擎新增错误码的登记义务**：引擎侧合成码不进 SDK 词表（透传面自管），但**必须登记进宿主 `ENGINE_ERROR_CODES` 枚举 + `DEFAULT_RECOVERY_HINTS`**——否则 GUI 无法按 code 分流、宿主词表出现未收录码。先例：zcode `schema_emulation_failed`（`zcode-engine.ts:893` 形态——SDK 词表无此码，宿主词表有）；待登记先例：`schema_gate_exhausted`（设计 4 拟新增，已裁决未实施；实施期定型项）。

**错误消息可操作性要求**：结构化错误载体恒为 `<code>: <detail>` 前缀格式（宿主 `EngineError`，`errors.ts:50-60`；协议侧 `EngineSdkError` → `ProtocolError{code,message,recovery,data}`，`frames.ts:18-27`、`error-codes.ts:67-84`）。`recovery` 必须指向具体恢复动作（命令/配置路径/替代方案），非安慰性文案——「错误 → 权威源 → 重试」闭环。动态参数文案走具名构造器先例：`engineProtocolMismatchError`（含双方版本 + 升级指引，`error-codes.ts:90-101`）、`engineTimeoutDetail`（stdout 尾 2000 字 + 建议，:164-170）。

## 5. run.params 与 ctx 载体

**字段全集与必选矩阵**（`protocol/methods.ts`）：

| 载荷 | 字段 | 必填性 | 义务 |
|---|---|---|---|
| `RunParams`（:141-151） | `runId` | 必填 | 宿主分配；事件通知 / streamDelta / cancel 全靠它关联 |
| | `task: AgentCallOpts` | 必填 | 任务声明引擎面子集（下表） |
| | `ctx: RunContextParams` | 必填 | 运行上下文（下表） |
| | `resume?: RunResumeParams` | 可选 | **唯一会话形态键**（:110-113）——`recordId`（core 预建 record 关联键，引擎据此回填 handle.sessionRef 与 childSpawned/state 的 record 键）+ `resume?: ResumeAnchor`（冷续锚点；缺省 = 新 session）。additive 可选：旧引擎忽略未知字段，undefined 不上 wire |
| `RunContextParams`（:63-91） | `cwd?` | 可选 | worktree 隔离时 = worktree 路径；缺省引擎回退自身进程 cwd |
| | `model?` | 可选 | 请求模型 ref（未传 = 引擎缺省模型） |
| | `schemaEnv?` | 可选 | schema 的 env 注入形态（降级通道）——**引擎自选消费**：pi 消费（`PI_WORKFLOW_SCHEMA`）、zcode 不消费只读 `task.schema`（引擎中立原则：resolver 产出双通道，设计 4（schemaEnforcement 升级，已裁决未实施）裁决） |
| | `ctxModel?` / `engineFallback?` / `streamMode?` | 可选 | ctx 模型 ref；fallback 留痕：宿主在 ctx 传入 `{from, reason}` 种子，引擎回填进 outcome.engineFallback；事件粒度请求（按 `capabilities.eventGranularity` 实际能力执行） |
| | `sessionRootId?` | 可选 | **relay 身份键权威源**——引擎据此重写子进程 relay 归属 env（SESSION_ID/RECORD_ID），不靠 env 继承（[architecture.md](architecture.md) §3） |
| | `sessionDir?` | 可选 | 权威 subagent session 目录（宿主以 `getSubagentSessionDir` 推导，引擎不自推导；缺省走引擎内 legacy fallback） |

`AgentCallOpts` 引擎面子集 17 字段（1 必填 + 16 可选，`contract-types.ts:336-378`；core 全量 23 字段——SDK 侧字段裁决注写的「22」已滞后——其中 model/schemaEnv/cwd 改挂 ctx 不双写，`engineFallback` 本就是 ctx 独有字段、从不在任务面，engine/timeoutMs/returnMeta 宿主自持不透传，字段裁决注 :323-331）：任务语义（`prompt` 必填、`schema?`、`thinkingLevel?`、`skill?`/`skillPath?`、`agent?`、`appendSystemPrompt?`、`description?`、`scene?`）、轮次预算（`maxTurns?`/`graceTurns?`/`idleTimeoutMs?`——显式 0/负 = 禁用 idle GC）、隔离与权限（`worktree?`/`fork?`/`forkSource?`/`denyTools?`/`permissionMode?`）。`forkSource`：无此概念的引擎按未知可选字段忽略、行为与不传一致——fork/fork-from 的同步拒发生在宿主能力门 `assertTaskShapeSupported`（steer/conversation 双 unsupported 时拒并附引导 message，`capability-gate.ts:85-94`），不到引擎侧。

**resume 锚形态**：`ResumeAnchor = { sessionRef: Record<string,string>, journalPath? }`（`contract-types.ts:154-159`）；zcode 锚 = `sessionRef {sessionId, dbPath}`，pi 锚 = `{recordId?, sessionFile?}`（`EngineHandleData` 注释 :132）。引擎按锚分派 create/resume（`zcode-engine.ts:297-338` 形态）。锚只在协议层经 `run.params.resume` 携带，形状 = `{ recordId, resume?: ResumeAnchor }`（锚本体在 `params.resume.resume.sessionRef`；`RunContextParams` 无 resume 键）。zcode 判别函数（:1098-1110）读该键做形状收窄 + dbPath 白名单校验；其源码形参名叫 ctx 是引擎内部命名，勿与协议层 `RunContextParams` 混同。

## 6. 事件族与投影义务

**事件类型全集 9 种**（`contract-types.ts:109-118` `AgentEvent`；core 语义锚定注释 `subagent-core/src/execution/assembly/types.ts:305-318`）：

| 事件 | 载荷 | 语义义务 |
|---|---|---|
| `tool_start` | toolName + args | 工具调用开始；args 携带义务（:110） |
| `tool_end` | toolName + args + result? + isError? | **必须带 result**——reducer 收口进 `turn.toolCalls` 无需翻译层旁路（assembly/types.ts:307-308） |
| `text_delta` / `thinking_delta` | delta | 正文/推理流式增量（reasoning 与 answer 分流的引擎不得混流——zcode 实装口径，`zcode-engine.ts:475-479`） |
| `turn_end` | summary? | turn 闭合（`Turn.closed` 置位的驱动） |
| `message_end` | usage?（`AgentUsage` 四项 + cost?）+ error? | token 增量上报（§8 usage 聚合的源头） |
| `compaction` | 无 | 上下文压缩发生 |
| `activity` | 无 | **纯活性信号**：双侧 reducer no-op、不开 turn、不写状态、不落 journal，只承诺「引擎活跃时周期性出现」——供宿主无进展守护刷新判活（长工具执行期）；节流属生产者实现细节不进协议承诺（:101-108） |
| `error` | message | 事件流内错误（不替代 run 终态应答的 error outcome） |

**上游实名对照义务**（教训：taiji SDK 命名 ≠ 引擎上游实名）：SDK `tool_start`/`tool_end`（`contract-types.ts:110-111`）在 zcode bundle 实名是 `tool.updated`（kind=scheduled 的 input 可 omitted/inputRef 变体，kind=result 含 result+duration）——引擎适配层负责实名映射与 args 完整性不假设；zcode 现状不向 `ctx.onEvent` 投影 tool 事件，活性经 `session/event` 非终态非增量帧 → `activity`（`zcode-engine.ts:480-485`，真机探针实证约 1s 一帧）。

**journal 落盘义务**（`subagent-core/src/execution/engine/common/journal-wiring.ts:61-88`，已实现；接线面 = workflow 域两处——`workflow-dispatch.ts:333` + `run-orchestration.ts:650`，chat 域不接 event journal）：先落盘再转发（:67-79）；`activity` 豁免 append——双侧 reducer 对其 no-op，豁免不破坏 live≡reload 重放等价性；seq 由 append 铸造、过滤在 append 前，故无 seq 空洞（:73-74）；close 在 run 终态（成功/失败均达）flush + fsync 一次、不抛（②级尽力而为数据源，:14-16）。

**投影决策义务**：引擎层新观察到的事件是否向 `ctx.onEvent` 投影须显式声明消费方面——journal/SessionView/workflow trace 三消费方随投影新增面。裁决先例（设计 4，已裁决未实施）：submit_result 工具调用选择不投影——仅在引擎层内部提取，三消费方零新增面。该先例确立的判据：投影有消费方面成本；确需投影时必须同步补 apply-entry-equivalence 的 zcode tool_end 用例。

**schema 分流义务**（`task.schema` × `capabilities.schemaEnforcement`）：native 引擎直传 schema 通道，宿主对其 `parsedOutput` **不做二次校验**（D4 硬分流——`AgentOutcome.parsedOutput` 注释，`contract-types.ts:284`）；emulated 引擎自行仿真（prompt 约定 + 容错提取 + ajv，SDK `schema-emulation.ts`），终报失败走 `schema_emulation_failed`。coarse 粒度引擎（`eventGranularity: "coarse"`）须在 run resolve 前补发离散语义事件（`synthesizeCoarseEvents` 调用点 `zcode-engine.ts:900`）——text_delta 等增量可省，tool/turn 边界与 message_end 不可省（reducer turns 收口依赖）。

## 7. 生命周期与接管点义务

**轮终语义**（create 轮时序。下序以 zcode 为参照：带〔契约〕的步骤/标注是协议义务，任何引擎必须满足等价行为；带〔zcode〕的是该引擎实装形态，只须满足其中标注的〔契约〕义务，不必照抄内部结构；带〔宿主〕的是宿主侧行为，引擎作者对照面）：

0.〔宿主〕编排前置：journal 接线面 = workflow 域两处——`workflow-dispatch.ts:333` 与 `runAndFinalize`（`run-orchestration.ts:650`，函数头自述 workflow 域专用）各自 `wireEventJournal`（taskId = record.id，journal 是事件唯一出口或转发 workflow liveRecord）；chat 域 Continuation 轮不接 event journal（`chat-rounds.ts:273-274` 明文，pi 子代理 session JSONL 即原生数据源），其 §8 降级链②级结构性不可达——降级链实际覆盖 = ①级 read + ③级 outcome-only → 派 run 帧。
1.〔契约〕宿主派 run 帧 →〔zcode〕引擎 `runViaAppServer`（`zcode-engine.ts:297-338`）：pre-aborted 短路（:299-303，取消先于启动不建会话）→ 模型解析 → resume 前缀构造（:328）→ 首轮执行 + schema 仿真重试（:334）。
2.〔zcode〕引擎 → `SessionChannel.runTurn`（`session-channel.ts:749-796`）：`createSession`（:756）→〔契约〕**create 应答即接管点回调**（下文）→ `openTurn` 挂双 timer（:839-869）→ `subscribe`（:762，〔契约〕deliveryKind 必填否则终态事件不达）→ send → 事件流（text/thinking/activity 三回调 → `ctx.onEvent`，journal 落盘仅随 workflow 域接线面——步骤 0）→ 终态 → `readBestEffort`（:774）→〔契约〕**finally 无条件 `closeSession`**（:791-795——终态后循环/续发类机制必须在 close 前发生，见闸门续轮）。
3.〔zcode〕回引擎层：`parsedAppServerAttempt`（`zcode-engine.ts:1446-1459`，`interrupted` 不在 `isFailedTerminalStatus`、不误判失败——:1440-1445 注释）→〔契约〕schema 校验 → outcome + handle → run 应答。
4.〔契约〕宿主：run 应答到达即终态（`methods.ts:153`）→ handle 回填（`backfillRoundHandle` 整替语义 + 同值幂等；journal 终态路径 `backfillHandle` 补 journalPath，`journal-wiring.ts:84-86`）。

**resume 轮（现状 cold 形态）**：宿主带 `run.params.resume` 锚 → 引擎读锚（`zcode-engine.ts:322-328`）→ `buildResumeHistoryPrefix`：`channel.resumeSession(anchor.sessionId)`（读通道）取结构化历史 → 24k token 预算裁剪（保尾丢旧，至少保 1 条）→ 拼注入前缀 → **执行仍 create 新 session**（原地 resume 续写会命中上游 -32031 卡死——设计期 bundle 探针结论）→ 新 sessionRef 经 `onHandleReady` 回传 → 宿主同值幂等整替锚。**读通道失败分支（[U3] 2026-09-19）**：读失败即判定锚真失效——resume 走 app-server resident 内存态，resume 结果就是锚活性权威信号（宿主侧 zcode 锚库投影预检查已退役收窄 pi 锚专属——库投影滞后于 create 应答致预检查系统性误判，`conversation-continuation.ts` reviveOrThrow 注），引擎经 `buildResumeUnavailableNoticeSegment`（`zcode-engine.ts:1163`）注入 `[会话延续提示]` 锚失效声明段继续执行——run 不失败、零世代推进（锚失效不走 reopen 降级，round/epoch 不动），模型知情后基于最新消息独立续推。native resume 主路径（同 session 续写、锚稳定、24k 语义收敛）= 设计 3（native resume，已裁决未实施），实施期定型项。

**闸门续轮形态**（设计 4 已裁决未实施，实施期定型项）：自纠重试循环落在 `runTurn` **内部**（turn 终态 → 缺 parsedOutput 且未耗尽 → 同 session 再 send → 新 turn，≤3 次）→ 终态 → read 兜底 → finally close——**循环必须在 close 之前**（finally 无条件 `closeSession` 是硬约束，`session-channel.ts:791-795`）；idle/ceiling 双 timer 以 run 边界为界不随 steer turn 重置（防闸门轮被 TurnTimeoutError 打断改新会话重试，破坏同会话语义）；每轮 steer 决策前检查 `ctx.signal.aborted`——`interrupted` 终态直接出口，不进闸门、不因新轮拖延 settle 触发 killChain 连坐。

**abort/取消链**（zcode 实装锚）：`ctx.signal` abort → `onAbort` → `appServerAbortChain`（`zcode-engine.ts:506-512`）；链体（:595-667）：stop 帧（`ZCODE_APPSERVER_STOP_TIMEOUT_MS` = 3s）→ grace 窗（`ZCODE_APPSERVER_ABORT_GRACE_MS` = 3s，`constants.ts:160`）内 turn 落定即止（共享进程不杀）→ 超窗 `killChain` 收割共享进程（**接受连坐**——协议已不可信，在途其他任务走崩溃路径，:611-616）；abort 与 create 竞态（signal 先到、session 未建）→ 等会话建立（带上限）再发 stop。引擎义务：cancel 受理 3s 内收敛（§2.1）；用户取消不得被任何续跑机制强制续烧 token。

**timer 语义**：引擎侧回收层双 timer（idle 主判定 `ZCODE_TURN_IDLE_TIMEOUT_MS` = 30min 刷新重挂 + 总上界 `ZCODE_TURN_MAX_TIMEOUT_MS` = 60min 固定倒数，`session-channel.ts:839-854`；显式传参/env 覆盖/关闭通道齐备）——任一 fire → 类型化 `TurnTimeoutError` reject，宿主分流走可重试形态。任务级正常路径无墙钟（§2.1），此为回收层 opt-out 兜底。

**接管点副作用复刻义务**：`onSessionCreated`（`zcode-engine.ts:486-495`）承载两个宿主侧副作用——`rt.activeSessions.add(sessionId)`（TTL sweep 豁免集 + dispose close-fire 目标集；`rt.activeSessions` 全仓唯一调用点即此，:720-729 sweep 消费）与 `ctx.onHandleReady` 回传（sessionRef 同源 `zcodeSessionDbPath`）。**任何「会话确立」的新形态（resume 装载确认等）必须在装载确认时点复刻两者**——漏登记的竞态后果（设计 3（native resume，已裁决未实施）实装推演）：超 30 天高龄会话整轮在途期间不在豁免集，TTL sweep（运行时建立 +50ms defer 触发，`ZCODE_SESSION_SWEEP_DEFER_MS`，`constants.ts:241`）可删其库条目，`persistence:"immediate"` 下对已删行续写行为上游未定义。

**宿主侧轮活性守护（引擎的配合义务）**：宿主 run 域共用 settled-watchdog（`subagent-core/src/execution/lifecycle/settled-watchdog.ts`）两段式守护——中段无进展检测（刷新源 = run 事件通道既有事件，**含 `activity` 变体**：引擎在长工具执行期周期性发 activity 即履行刷新义务，静默 ≠ 卡死 ADR-0047）+ 收尾段固定上界（交棒 = run 应答驱动）。引擎义务由此推出：① 活跃产出期保证事件流不断流（至少 activity）；② 终态应答必须可达（subscribe deliveryKind 缺失则终态事件不达、会话假死——`session-channel.ts:70`）。宿主 idle 回收（`lifecycle/lifecycle-manager.ts` per-record idle timer，`armIdleKeepalive` 轮成功收口翻入保活）在轮间生效，与引擎内 timer 正交。

**嵌套派发拒绝义务**：引擎内不得再派发 subagent（无界递归守卫）——SDK `nesting-guard.ts` 引擎侧原语（双层：跨进程 `TAIJI_AGENT_SUBAGENT=1` env 统一标记，宿主 spawn 必达；引擎 adapter 检测到即拒 `nested_spawn_rejected` + 剥离各引擎原生嵌套标记防继承泄漏；进程内 ALS 深度计数单点同一文件）——恢复指引 = 当前任务内直接做，不委派。深层原因：嵌套子 record 挂在父进程内存，父轮末回收经 `disposeAllRecords` 连带收起、父 relay 断开触发 kill-on-disconnect（[architecture.md](architecture.md) §4 嵌套生命周期行）——嵌套子**结构性不能活过父的当前轮**，引擎放行嵌套只会制造必失败任务。

## 8. 读取与 SessionView 投影义务

**SessionView 契约**（`contract-types.ts:174-182`）：`engineId` / `sessionId?` / `turns: ReplayedTurn[]` / `usage?: AgentUsageTotal` / `source: "native" | "journal" | "outcome-only"`。`source` 是 GUI 降级标记数据源；三级降级链：①引擎原生 `read` → ②宿主 event journal 重放（`handle.journalPath` 自描述定位；重放实现 = SDK `journal-replay.ts`，与宿主 execution-record 共用「双侧 reducer no-op 对 activity」语义，事件流重放 ≡ live 落盘）→ ③outcome-only（只剩终态 content，`sessionRead: "outcome-only"` 引擎的事实标准形态）。

**usage/contextTokens 字段语义边界**（混用后果 = 系统性高估）：

- `SessionView.usage` = 各 turn `usageDelta` 聚合——**消费累计**语义（含已淘汰历史，不作窗口占用数据源）。
- `contextTokens` 只在 run 应答链 `AgentOutcomeUsage`（`contract-types.ts:248-256`）——**窗口占用**语义：zcode 取 `projection.contextUsed`（`parser.ts:68`，`mapZcodeOutcomeUsage` 内 `firstFinite(p.contextUsed, r.totalTokens, 0)`）。

**zcode ①级读取链实装锚**：`readZcodeSessionView`（`reader.ts:342`，三级 JOIN 按会话全量读；db 缺失/表漂移 → 结构化错误交降级链）；`usageFromStepFinish` 只填 input/output/cacheRead/cacheWrite 四项（:107-119）；`ReplayedTurn.closed` 恒 true（重放物无进行时语义，`contract-types.ts:161-168`）。

**读取安全义务（dbPath 白名单）**：dbPath 白名单判定**内聚引擎包**（zcode 先例：`zcode-engine.ts` read 方法内单点判定——`zcodeDbPathAllowlist(dataDir)` 封闭集合成员判定，集合 = 隔离库路径 + 宿主库存量兼容锚点，非集合内路径拒绝①级降 journal）；宿主两条读取链（`session-view-service` ①级投影 + `EnginePort.read` 协议 read）经协议 read 复用同一判定，不自行校验。新引擎若在 sessionRef 携带文件路径类定位键，必须在**引擎 read 内**同型加封闭白名单判定，防路径注入面。

**已知投影形态（必须写进验收防误报**，设计 3（native resume，已裁决未实施）两点）：① 中间轮 user 消息不进 `turns`（reader 只取 assistant 视角，`turnsToMessages` 只前置 record.task 一条 user）——多轮续聊详情页呈「task + 全部 assistant turns、无中间提问」，问答对应关系不可见，属已知形态非 bug；② usage 聚合挂最后一个 turn（`session-view-service.ts:305-310`）——全量累计值展示在末条 assistant 上，与单轮语义有别。引擎新增投影形态同样入此清单。

## 9. env 与数据目录契约

**env 双向契约**：

- **出站**（宿主 → 子进程）：进程创建点子 env 必须经 `buildOutboundChildEnv`（`packages/shared/src/spawn-env-contract.ts:121`）构建，deny 清单剥 `TAIJI_AGENT_PACKAGED` / `TAIJI_RUNTIME_TOKEN`（约束 C-proc-09；守卫 `.githooks/check_spawn_env_boundary.py`）。引擎 spawn 自己的子进程（如 pi 引擎 spawn pi、MCP 子进程）同受此约束。
- **引擎侧任务子进程 spawn/env（约束 C-proc-12）**：引擎 spawn 任务子进程必须经 SDK `spawnEngineChild` 唯一入口（`spawn.ts:49`——`detached:false` 硬编码、子进程 stdin 恒自有 pipe 不继承引擎 fd；传 `detached`/`stdio`/`stdin` 形态键直接抛错），子 env 必须来自 `buildEngineChildEnv` 三层契约终态（类型即契约，`env.ts:194`；L0 基础设施注入 / L1 deny+显式剥除 / L2 manifest 前缀放行——L1 剥 `TAIJI_AGENT_API_KEY` 等凭据键，引擎不向宿主索要凭据、自取供给）；引擎宿主死亡自灭守卫 `armEngineSelfDestruct`（`spawn.ts:163`）双判据：stdio EOF 主判据 + 未 ack 反向请求计时辅判据。机器守卫 `.githooks/check_spawn_env_boundary.py` 扫描面覆盖引擎侧。
- **入站**（宿主进程 env 准入）：`ENV_WHITELIST_PREFIXES` SSOT 只许定义在 `packages/shared/src/constants.ts:79`（main/runtime 只 import）。
- **manifest envPrefixes**：引擎声明自己消费的第三方前缀（如 zcode 的 `ZCODE_`）；宿主保留前缀 `TAIJI_` 族禁声明（`engine-manifest.ts:23`、:161-165）。
- 经 env 传载荷的尺寸上限先例：`SCHEMA_ENV_MAX_BYTES` = 256KiB（`pi-subagent-cli/src/constants.ts:24`），注入前按 UTF-8 字节 fail-fast 拒绝（`spawn-args.ts:88-101`，防 execve E2BIG 难归因错误）——新增 env 载荷通道照此办。

**引擎数据目录布局**（根 = `getEngineDataDir()`，`subagent-core/src/execution/engine/common/data-dir.ts:43-62`：`TAIJI_AGENT_DATA_DIR` env 优先，缺省回退宿主数据根 + warn 一次）：

| 落点 | 义务 |
|---|---|
| `engines/<id>/shared/`（journal） | 固定分组（SDK `SHARED_POOL_KEY`，路径构造即终值，`journal-wiring.ts:61-66`）；30 天 mtime TTL 回收 = 唯一清理机制（`pool-manager.ts` `cleanupExpiredJournals`）——引擎不得在 journal 目录自建第二套清理 |
| 会话库隔离模式（zcode 先例） | spawn env 覆写 `ZCODE_SESSION_DB_PATH` + 清空别名键；路径单一来源 `zcodeSessionDbPath()`（`<engineDataDir>/engines/zcode/session-db/db.sqlite`）；与 GUI 引擎库分离（约束 C-ext-20，[zcode-session-db-isolation.md](../../architecture/zcode-session-db-isolation.md)）。隔离条目 TTL sweep 引擎侧（C-data-22：30 天同窗 / 活跃豁免集 / 进程级 24h 节流，`zcode-engine.ts:720-729`） |
| 新增写入面登记义务 | 引擎新增任何磁盘写入面必须显式登记清理通道，或登记「无清理可接受」判定及理由。先例（设计 4（schemaEnforcement 升级，已裁决未实施）裁决）：`mcp/` 脚本目录——单文件恒覆盖、内容随包版本、无累积增长 → 「无清理通道」判定可接受 |

**路径动态推导红线**：禁硬编码绝对路径，一律从 `getDataDir()` / `getEngineDataDir()` 等动态推导（pre-commit 路径白名单检查；根 AGENTS.md 规则 22）。

## 10. 可靠性模式库（降级与可观测）

引擎改造反复用到的裁决模式，新设计对照取用，不重新发明。**诚实纪律**：标注「模式已裁决，随对应设计实施落地」的项不得写成现状已实现；已有实现的照常引锚。

| 模式 | 完整表述 | 状态与实例锚 |
|---|---|---|
| **降级链族分层**（本指南定义：按失败通道给降级形态分层的裁决模式） | 降级通道与主路径共享同一物理 RPC/子通道时，主路径失败则降级的输入前缀/数据必同样缺席——**不得假设「降级后仍可用全量」**。按失败通道逐族定义「降级后还剩什么」；每族给标记值：`degradedReason` 标量字段（设计 3 拟新增）标注最新一次降级的族别，随轮覆写，允许冷重建丢（诊断态非账务数据，丢 = 回无标记态，下轮降级重写） | 已裁决未实施（设计 3 D6：send 门族 → 带历史降级 `cold-resume-with-history`（拟新增）；RPC 族 → 无历史降级 + 锚换钉 `cold-resume-no-history`（拟新增）——历史连续性永久断的最差形态显式暴露）。[U3 2026-09-19] 边界注记：zcode resume 读失败已落地的单级朴素降级（无标记值——`degradedReason` 标注与 `cold-resume-*` 标记值机制均未实施，形态见 §7 读失败分支）不是本模式已实施例；zcode cold 形态每轮新 session 锚整替（§7）是设计内常态，与 D6「降级致锚换钉」的拟新增语义在 zcode 侧已消解。已实现参照：journal `activity` 豁免的「同通道同失败」判别（`journal-wiring.ts:71-79`） |
| **族差分级告警 + 不设连续性计数器**（本指南定义） | 最差形态单次即 error、较轻形态 warn；**不做「连续 N 次升级」计数器**。两段论证：① Worker Thread 多实例下「同进程连续」无全序语义；② 「夹成功即清零」语义空洞（失败-成功-失败与连续失败不可区分）。常态化信号 = 标记/日志持续出现（日志检索判）——感知线已由族差分级 + 标记持续出现承载 | 已裁决未实施（两设计审查各自独立裁决后收敛同型：设计 3 D6 / 设计 4 D8） |
| **瞬态防护**（本指南定义：幂等 RPC 失败的快速重试前置） | 幂等 RPC 失败先**一次快速重试**再落最差形态；重试限同进程代内（进程代际重建由连接层自动处理，不计入重试预算）——防一次瞬时超时直接触发不可逆降级（如锚换钉永久断历史）。前提 = 操作幂等已核实 | 已裁决未实施（设计 3 D6，前提 resume 幂等已经 bundle 探针核实） |
| **宽限窗**（本指南定义：异步就绪观察的显式窗口） | 异步注册/就绪观察给显式窗口防竞态误降级：窗口内到达即正常，超窗未到才降级；窗长挂实施期探针定型（量级预期亚秒），禁拍脑袋写死 | 已裁决未实施（设计 4 D8：MCP 工具注册观察窗——subscribe 后至首 send 前） |
| **溢流阀声明**（本指南定义：必然到达态的设计内声明义务） | 必然到达态（如上下文耗尽）按**设计内行为**显式声明，三要素缺一不可：① 锯齿形态描述（触发后复位到什么状态、周期性再现的信号标记是什么——非永久降级）；② 信号位数据源（从哪读出逼近事实——须选窗口占用语义源如 run 应答链 `contextTokens`，禁用 read ①级 usage——消费累计会系统性高估，§8）；③ 重审条件（量化阈值 + 数据源 + 误差方向） | 已裁决未实施（设计 3 D8b：长对话上下文触顶——带历史降级 ≈24k 新锚后复位、`cold-resume-with-history`（拟新增）周期性再现即信号；重审条件 = 单会话 contextTokens 超模型上下文 70%） |
| **探针声明纪律** | 运行时行为断言逐条分级：「设计期已验证」（bundle 掐段/探针已跑，给 offset/复现锚）vs「实施期探针」（go/no-go 门，**先于任何生产代码**，失败触发设计回退点）；实施期项必须带回退链（主路径不通 → 次选通道 → 降级方案 → 回报裁决） | 方法论已裁决（设计 3 D10 / 设计 4 D10 各自登记示范：如「隔离库 resume+send 无 -32031」为实施期硬门、`mcpServers` 键面已设计期逐键核实仅对照复核） |

**选用与反模式判据**：① 六模式是配套族——降级链族分层是骨架，族差分级告警/瞬态防护/宽限窗是其上的观测与防误判面，溢流阀声明只适用于「必然到达态」（偶发失败态不套用，套用会把 bug 洗成设计内行为）；② 反模式一：降级通道与主路径同通道失败仍宣称「降级保全量」（族分层要抓的第一类错）；③ 反模式二：用连续计数器当常态信号（多实例无全序 + 清零语义空洞，已被两次独立裁决否决）；④ 反模式三：实施期探针项未跑探针先写生产代码（go/no-go 门失效，设计回退点悬空）；⑤ 模式落地时每族标记值必须进 record 诊断字段并允许冷重建丢——为诊断态补持久化容器（per-round 数组/水合面）属过度工程，已裁决砍除。

## 11. 验收基线

**测试分层**（细则 SSOT：[TEST-STRATEGY.md](../../TEST-STRATEGY.md)）：单测/协议级用 fake fixture（fake app-server / 合成 config，禁碰真实凭据与真实数据目录）；真实 LLM 轮次真机场景**按改动面空载串行**执行、禁全量扫跑（跨包并发会饱和 CPU，真实 LLM 延迟会越过事件预算）；PR/merge/CI 门禁不跑真实 LLM e2e。可沉淀为 fake fixture 的真机项随改动单测化（先例：跨代恢复 → 「connection 代际重置 + resume 回源」单测化路径）。

**go/no-go 探针先行的强制形态**：外部系统对接（上游 RPC 通道、新协议面）先写独立探针脚本验证行为面再编码，用完归档移除；探针是方案成立性门，先于生产代码，失败触发设计回退点而非原地硬修（先例：两设计（均已裁决未实施）的 go/no-go 探针同款形态；键面可设计期逐键核实的，探针火力收敛到行为面）。

**真机场景通过标准写法**：可证伪断言（禁「绝对不会出错」式表述）+ **已知投影形态写进标准防误报**（§8 两点形态入验收场景的预期形态栏，避免当 bug 报）+ 库侧硬证据优先（如「隔离库内该 record 恰 1 条会话条目」直接证锚稳定）。验收计划结构先例（两设计同型）：单测表（U 编号 × 用例 × 回溯目标）+ 真机表（V 编号 × 步骤 × 通过标准，实施期探针场景显式标注其 go/no-go 门身份）+ 变体覆盖（正常链 / 参数变体 / 降级路径各一）。

**Electron 形态复验义务**：本地 CLI 探针的 execPath 是真 node；生产环境引擎与 app-server 跑在 Electron `process.execPath + ELECTRON_RUN_AS_NODE=1` 形态——执行器矩阵与探针义务的权威源 = `packages/subagent-engine-sdk/src/node-executor.ts`（矩阵头注 :10-18：①打包宿主注入 `TAIJI_AGENT_ENGINE_NODE` + Electron 二进制同点注入 `ELECTRON_RUN_AS_NODE=1`、②runtime sidecar `process.execPath + ELECTRON_RUN_AS_NODE=1`、③standalone 走 PATH node；`probeNodeExecutor` :43-70 首用探针，失败 → `engine_not_found` + 指引）。引擎构造子进程 command 时必须传 `process.execPath` 字面值并附该 env，否则 Electron 下会拉起 GUI 实例；**探针须在 Electron 环境复验一次 spawn 面**（本地 node 探针通过 ≠ 生产形态通过）。

## 12. 契约面 → 守卫与资产映射表

| 节 | 权威源（源码模块） | 机器守卫（现状） | 关联文档 |
|---|---|---|---|
| §1 准入 | `subagent-core/src/execution/engine/engine-manifest.ts` + `engine-inspect-package.ts` + `engine-discovery-*.ts` + `registry.ts`/`routing.ts` | discovery 检查管线三态判定；extensions 结构守卫 | [architecture.md](architecture.md) §1/§2.3、[extension-conventions.md](../extension-conventions.md) |
| §2 协议 | `subagent-engine-sdk/src/protocol/`（methods/frames/reverse-channels/engine-protocol） + `subagent-core/.../engine/client/`（engine-client/remote-engine） | `protocol.test.ts` 封闭断言 + `contract-closure.test.ts` 双向可赋值 + conformance 套件 | [architecture.md](architecture.md) §3、C-proc-13、[subagent-chat-run-unification.md](../../architecture/subagent-chat-run-unification.md) |
| §3 capabilities | `protocol/contract-types.ts`（`EngineCapabilities`）+ 两引擎声明点（`zcode-engine.ts` `capabilities()` + 各包 manifest） + `capability-gate.ts` + `chat-rounds.ts` | 新增能力位同批：`EngineCapabilities` 类型 + manifest **CAPABILITY_ENUMS** 词表 + `CONSERVATIVE_CAPABILITIES` 保守值 + gate 判据 + 两引擎两镜像声明（枚举编译校验拦截漏改）；gate 双向判定 | C-ext-20 |
| §4 错误码 | `subagent-core/.../engine/common/errors.ts` + SDK `protocol/error-codes.ts` | **封闭枚举 + `DEFAULT_RECOVERY_HINTS` Record 全集编译强制** | — |
| §5 run 载荷 | `protocol/methods.ts`（`RunParams`/`RunContextParams`）+ `contract-types.ts`（`AgentCallOpts`/`ResumeAnchor`） | 帧级 schema（`protocol-schema.test.ts`/`resume-schema.test.ts`） | C-proc-09（relay 身份键）、[zcode-session-db-isolation.md](../../architecture/zcode-session-db-isolation.md) |
| §6 事件 | `contract-types.ts`（`AgentEvent`）+ `assembly/types.ts`（语义锚定）+ `journal-wiring.ts` | apply-entry-equivalence 等价测试族（投影变更须补用例） | C-proc-13 |
| §7 生命周期 | `zcode-subagent-cli/src/session-channel.ts` + `zcode-engine.ts` + `constants.ts`（引擎侧）；`assembly/conversation-continuation.ts`（宿主侧） | conformance 套件；settled-watchdog 活性守护（`lifecycle/settled-watchdog.ts`） | C-proc-09/13、[crash-forensics-and-watchdog.md](../../architecture/crash-forensics-and-watchdog.md) 附录 E |
| §8 读取投影 | `zcode-subagent-cli/src/reader.ts` + `parser.ts` + `db-path.ts`（`zcodeDbPathAllowlist` 白名单集合）+ `contract-types.ts`（`SessionView`）+ `session-view-service.ts` | — | C-data-20/22 |
| §9 env/目录 | `packages/shared/src/constants.ts`（`ENV_WHITELIST_PREFIXES`）+ `spawn-env-contract.ts` + `engine/common/data-dir.ts` + `engine/paths.ts` + SDK `spawn.ts`/`env.ts`（引擎侧 spawn/env 契约） | `check_spawn_env_boundary.py`、路径白名单检查、`check_env_whitelist_sync.py` | [env-propagation-boundary.md](../../architecture/env-propagation-boundary.md)、C-proc-09、C-proc-12、C-ext-20、C-data-22 |
| §10 可靠性模式 | 本指南自定义（模式源 = 设计 3/4 对抗审查裁决，裁决正文暂在仓外，见头部）；已实现参照 `journal-wiring.ts`（`activity` 豁免的「同通道同失败」判别） | — | — |
| §11 验收 | `subagent-engine-sdk/src/node-executor.ts`（执行器矩阵）+ [TEST-STRATEGY.md](../../TEST-STRATEGY.md) | `check-vitest-guard.mjs`（测试防线挂载） | [TEST-STRATEGY.md](../../TEST-STRATEGY.md)、docs/testing/ |
| 投影守卫（已建，2026-09-18） | `scripts/check-guide-contract-projection.mjs`——本指南 §3 能力位表 / §4 两层词表 ↔ 源码词表投影 diff（pre-commit 按指南与契约源码路径触发，install-hooks.sh 对应块；先例：CSS token SSOT check） | 投影失同步即拦截（计数 + 集合双向对账） | 根 AGENTS.md 主题索引「更新触发」行 |

本表已登记进 doc-symbol-drift 守卫（`scripts/check-doc-symbol-drift.mjs` 的 **DOC_MODULE_MAP**，7 条模块路径——SDK 全 src / core 引擎子域 / `path-encoding.ts` / 两引擎包全 src / shared 两常量文件）；登记蓝本 = 本表（按实际引用符号逐模块登记，宁缺勿滥）。非导出的模块内常量不进守卫符号表，以粗体非反引号形态引用（**DOC_MODULE_MAP** 本身即先例）。

## 13. 新引擎接入 checklist

1. 读 [architecture.md](architecture.md) §1-§3（拓扑 + 协议面）。
2. 按 §1 准入形态建包：manifest 必填三字段 + capabilities 必需（缺键即保守值降级）、依赖红线（只依赖 SDK，消费入口仅 `.` 与 `./protocol`）；落点按 §1 发现根选择——入仓引擎放 `packages/`（staging 按 manifest 动态发现、`extraResources` 目录映射，均不写死清单，打包布局改动时同批核对两文件）；GUI icon 经 **ENGINE_ICON_REGISTRY** 单点登记（新引擎加一行，未登记 id 防御回中性圆点，C-ext-18）。
3. 按 §2 实现 9 方法 + 6 反向通道（控制面超时上限记牢；run 无墙钟；conformance 过 + bin 级协议 e2e 五断言）。
4. 按 §3 声明 capabilities（引擎类 + package.json 两镜像同批；头注同批写依据）。
5. 按 §4 登记错误码（引擎合成码进宿主枚举 + 恢复模板，漏登记编译失败）。
6. 按 §5-§9 落 params/事件/生命周期/读取/env 义务（接管点复刻、journal 义务、写入面登记逐条过）。
7. 按 §11 产出验收计划（go/no-go 探针先行、Electron 形态复验、已知投影形态入标准）。
8. 上游引擎（pi/zcode 之外）对接另加：上游语义断言单点登记（先例 C-pi-02——pi 语义断言以 node_modules 实装版为权威源；机器登记 + 探针 + 版本门禁承载见 C-proc-08）。

## 14. 既有引擎改造评估 checklist

1. 定位改动面在 §12 映射表的节（波及面 = 该节权威源 + 守卫 + 关联文档）。
2. §3 查能力位是否需升/降位（先改链路再改声明；两镜像 + 头注同批；消费判据 `!== "unsupported"` 确认升位不破坏）。
3. §7 查生命周期时序约束（close/abort/timer/接管点四族：新形态必须在 close 前发生、cancel 3s 收敛、回收层 timer 才允许默认有界、会话确立时点必须复刻 activeSessions + onHandleReady）。
4. §10 查可靠性模式（六模式是设计期对照取用的裁决结论，非现状实现：新降级/重试/观察窗设计逐条对照取用，禁重新发明；涉及未实施项的落地义务见其状态栏）。
5. §12 列文档同步面（登记资产同 commit 更新；实施期定型项落地后回写本指南）。
6. §11 产出验收挂钩（单测 fake fixture 先行、真机按改动面、可证伪标准）。
7. 上游引擎版本升级视同改造：走本清单 1-6 重验（升级面 = 协议行为与能力位漂移；上游语义断言锚定实装版——先例 C-pi-02/C-proc-08）。

## 15. 变更追记

锚点后语义级变更的同 commit 登记处（头部「状态」两级锚点结构的追记半边，取代已废弃的单 hash 锚点声明）。每笔登记：变更语义 + 波及节；漏同步的历史漂移补登时标「补登」。

| 日期 | 变更 | 波及节 | 备注 |
|---|---|---|---|
| 2026-09-19 | 漂移修复：锚点单 hash 声明废弃，改「最后全量复核 + 本追记节」两级结构；journal 接线域归属修正为 workflow 域两处（chat 域不接，②级降级结构性不可达）；DOC_MODULE_MAP「登记待办」表述事实化 | 头部 / §2.1 / §6 / §7 / §12 | 本次修订首笔 |
| 2026-09-19 | W2（commit 45c511aa6，2026-09-18）：zcode sandbox 声明值 none → emulated（解锁 worktree 任务），§1 manifest 示例同步更正 | §1 | 补登——变更当时漏同步指南 |
| 2026-09-19 | U3（commit f98d9e459，2026-09-19）：zcode resume 读失败分支由静默降级改为注入 `[会话延续提示]` 锚失效声明段继续执行（run 不失败、零世代推进；宿主 zcode 锚预检查退役收窄 pi 专属），§7/§10/台账登记 | 头部 / §7 / §10 / 台账 | 补登——变更当时漏同步指南 |
| 2026-09-19 | 漂移修复：§8 读取安全义务主体修正——dbPath 白名单判定内聚引擎包（zcode-engine read 方法内单点，zcodeDbPathAllowlist 封闭集合成员判定），宿主两读取链经协议 read 复用同一判定不自行校验（原表述误写为宿主侧判定）；§12 权威源表 §8 行补 db-path.ts | §8 / §12 | 补登——文档单侧漂移，对齐审查发现 |
| 2026-09-19 | 漂移修复：§1 modelCatalog 归一条件精确化——「声明了对象却无有效 models 时归一 null」有歧义（实装：models 键缺失/非数组才归一 null + warn；数组存在但条目全无效保留 models: []），对齐解析器实装改写 | §1 | 补登——文档单侧漂移，对齐审查发现 |
