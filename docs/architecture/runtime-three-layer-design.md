# Runtime 三层架构设计（方案 C：端口-适配器）

**版本**: 1.0 · **日期**: 2026-06-18 · **分支**: refactor-architecture-design
**取代**: [design.md §D4](design.md) 的「transport/services/adapters/infra 四层」中 runtime 部分
**适用范围**: `packages/runtime/`（Main 进程不在本次范围）
**plugin-service**: 暂不动（已自洽，作为黑盒保留在 services/）

---

## 阅读指引

- **第一部分**：决策——为什么从四层改为三层
- **第二部分**：目标架构图 + 三层职责边界
- **第三部分**：ports 接口清单（依赖倒置的载体）
- **第四部分**：现有 67 文件逐个归位表
- **第五部分**：迁移步骤（分阶段，低风险优先）

---

# 第一部分 · 决策

## 为什么放弃四层（D4 的 transport/services/adapters/infra）

D4 的本意是区分「怎么连外部系统」(infra) 与「怎么翻译外部格式」(adapters)。概念上正确，但实证暴露 3 个问题：

| 问题 | 证据 |
|------|------|
| **adapters 名存实亡** | `pi-config-bridge.ts` 是 pi 模块的聚合 re-export（转发 `PiProviderConfig`/`readModels` 等原始 pi 类型与 CRUD），不是翻译层。`config-service` 自己写 `mapTypeToApi`（pi 格式映射），翻译职责漏到 service |
| **PiXxx 类型四处泄漏** | `types.ts`(444行) 全是 `Pi*` 类型却放根级；`config-service`/`tree-service`/`session-service` 都直接吃 `PiMessage`/`PiModelDefinition`/`PiHistoryMessage` |
| **infra 反依赖 adapters** | `infra/rpc-client.ts` import `adapters/pi-config-bridge`（infra→adapters 反向），四层声称的单向依赖 `adapters→infra` 不成立 |

**根因**：pi 的「路径配置」与「协议传输」被切到不同层（adapters vs infra），但后者需要前者，于是 adapters 退化成「公共工具层」，翻译职责落空。

## 为什么不选 Clean Architecture（领域中心 + 依赖倒置）

实证 runtime 的**领域逻辑非常薄**——它是 pi 引擎的 Node.js 宿主 + 协议适配层，真正 AI 业务规则在 pi 进程内部。逐项核查：

| 代码 | 性质 | 是独立领域吗 |
|------|------|-------------|
| `mapTypeToApi`（anthropic→anthropic-messages） | pi 格式映射 | ❌ 翻译，非规则 |
| provider/skill/agent CRUD | 纯转发 pi 的 models.json | ❌ CRUD 代理 |
| `ALLOWED_GIT_PREFIXES`（只允许 https/ssh/git@） | infra 输入校验 | ❌ infra 职责 |
| `ensureActive` + `restoringSessions` 去重 | 并发防护 | 🟡 编排不变量 |
| `isGenerating` 状态机 / `rebindAfterFork` | session 生命周期 | 🟡 编排不变量 |

强行做 domain/ 层，里面只有几个薄状态机，会退化成「把 service 方法签名抄一遍」的空壳。Clean Architecture 的收益（领域独立可测、不被 infra 污染）在领域本身贫乏时兑现不了。

## 决策：方案 C —— 三层 + ports 依赖倒置

采纳 Clean Architecture 的精髓（**依赖倒置 + 内部不被外部格式污染**），但去掉空的领域层：

```
transport/  ← 协议入口
services/   ← 业务编排（定义 ports，依赖接口）
infra/      ← pi 适配（实现 ports，连接 + 翻译合并）
```

**C 解决四层的全部 3 个问题**：
1. ❌ adapters/infra 边界模糊 → **合并，不存在模糊**
2. ❌ PiXxx 泄漏 service → **ports 接口用内部类型签名**，service 摸不到 PiXxx
3. ❌ infra 反依赖 adapters → **没有 adapters，infra 是最底层**

**保留 D4 的有效部分**：transport 纯路由、services 按域切、session 已拆分（lifecycle/dispatcher/scanner）、plugin-service 自治切片——这些全部保留。

---

# 第二部分 · 目标架构

## 架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                    RUNTIME (Node.js 子进程)                           │
│              entry: index.ts (组合根：DI 接线 + 信号)                  │
└─────────────────────────────────────────────────────────────────────┘
      ▲
      │ WebSocket: ClientMessage(56) → ← ServerMessage(~70)
      │
 ═════╪══════════════════════════════════════════════════════════════════
      │
      │  ┌───────────────── ① transport/ 协议入口 ──────────────────┐
      │  │  server.ts        HTTP /health + WS accept + 心跳 + 广播   │
      │  │  router.ts        type → handler 声明式 map（T1 落地）     │
      │  │  handlers/*.ts    参数提取 → 调 service → 组装响应          │
      │  └────────────────────────┬────────────────────────────────┘
      │                           │ 调 IService 方法 / 经 IBroker 回推
      │  ┌────────────────────────┴────────────────────────────────┐
      │  │                ② services/ 业务编排                       │
      │  │                                                          │
      │  │  ports.ts  ★ 依赖倒置载体（service 定义的「我需要什么」）  │
      │  │     IPiEngine    prompt/abort/steer/getHistory/compact    │
      │  │     IPiProcess   createSession/destroy/绑定               │
      │  │     IConfigStore Provider/Skill/Agent 的 CRUD（内部类型）  │
      │  │     IModelSource 模型聚合 + API 发现                      │
      │  │     IPiEvents    pi 事件订阅（返回内部事件，非 PiEvent）   │
      │  │     IInstaller   npm/git 安装                             │
      │  │     IBroker      WS 广播（已有，保留）                     │
      │  │                                                          │
      │  │  session/        config        model         tree          │
      │  │  ├ lifecycle     (Provider/    (聚合 +       (navigate     │
      │  │  ├ dispatcher     Skill/        IModelSource  树编排)       │
      │  │  └ scanner        Agent CRUD)   发现)                      │
      │  │  (会话+对话，      ──── 全部只依赖 ports 接口 ────)         │
      │  │                                                          │
      │  │  plugin-service/  ← 黑盒保留（已自洽，经 IPluginService）  │
      │  └────────────────────────┬────────────────────────────────┘
      │                           │ 只依赖 ports 接口 + 内部类型
      │  ┌────────────────────────┴────────────────────────────────┐
      │  │            ③ infra/ pi 适配（连接 + 翻译合并）             │
      │  │                                                          │
      │  │  ★ 唯一出现 PiXxx 类型的层；对上只暴露内部类型              │
      │  │                                                          │
      │  │  pi/                                                     │
      │  │  ├ pi-client.ts     spawn('pi') + stdin/stdout JSONL     │
      │  │  │                   实现 IPiEngine + IPiEvents           │
      │  │  ├ process-pool.ts  session→pi 绑定，实现 IPiProcess      │
      │  │  ├ pi-config.ts     models.json CRUD + Provider↔Pi 翻译   │
      │  │  │                   实现 IConfigStore                    │
      │  │  ├ pi-events.ts     pi 事件→内部事件，实现 IPiEvents 翻译 │
      │  │  ├ pi-history.ts    pi JSONL 历史→Message[] 翻译          │
      │  │  ├ pi-tree.ts       pi JSONL 树→树模型翻译                │
      │  │  ├ pi-paths.ts      pi/xyz-agent 路径解析（独立，无反依赖）│
      │  │  └ pi-protocol.ts   Pi* 协议类型（仅 infra 内部可见）      │
      │  │  installers/                                            │
      │  │  ├ npm-installer.ts registry HTTPS，实现 IInstaller       │
      │  │  ├ git-installer.ts  execFile('git', clone)              │
      │  │  └ extension-resolver.ts 扩展路径解析                     │
      │  │  scanners/                                             │
      │  │  ├ scanner-base.ts  skill/agent 扫描基类                  │
      │  │  ├ skill-scanner.ts                                    │
      │  │  └ agent-scanner.ts                                    │
      │  │  system/                                               │
      │  │  ├ git-info.ts     git 分支查询（带缓存）                 │
      │  │  └ trash.ts        废纸篓删除                            │
      │  └──────────────────────────────────────────────────────────┘
      │
      ▼
┌──────────────┐  ┌──────────────┐  ┌───────────────────┐
│ pi 子进程 ×N  │  │  文件系统      │  │  外部网络            │
│ (AI 引擎)    │  │ ~/.pi/       │  │ LLM API · npmjs    │
│              │  │ ~/.xyz-agent/│  │ · git              │
└──────────────┘  └──────────────┘  └───────────────────┘
```

## 三层边界规则

| 层 | 可依赖 | 禁止 | 核心约束 |
|----|--------|------|---------|
| **transport** | services(接口) + shared | 不碰 node: 内置；不做业务决策 | 纯路由：参数提取→调 service→组装响应 |
| **services** | ports(自己定义的接口) + shared + 内部类型 | **不 import infra**；**不出现 PiXxx 类型** | 业务编排，经 ports 访问外部能力 |
| **infra** | 外部系统 + node: 内置 + shared | 不知道 WS 协议；不知道 session 业务语义 | 实现 ports；**PiXxx 类型仅在此层内部** |

### 跨切面例外（受控违背「services 不 import infra」铁律）

三层边界规则要求 services 层不直接 import infra。但存在两类「跨切面基础设施」模块——它们或是无业务语义的横切关注点，或是无状态无副作用的纯函数——其 import 不经 port 而直接静态依赖 infra 模块，属**受控例外**。声明如下，使后续架构审查（如 R5 收尾验证 `rg "from '.*infra/" services/`）不把这些 import 误报为违规。

#### ① logger —— 跨切面日志基础设施

`infra/logger.ts` 是全局日志基础设施：日志文件落盘 + 按天/按大小轮转 + monkey-patch 全局 `console` 实现 terminal-tee（架构约定 §4「Runtime/pi 日志必须落盘 + 轮转 + 动态数据目录」）。它**无 pi 状态依赖、无业务语义**，是纯横切关注点（cross-cutting concern）。为它定义 port（如 `ILogger`）并注入只会增加无意义的间接层——services 层几乎所有模块都可能记日志，强制经 port 注入会污染全部 service 构造函数签名；且 logger 是 process-wide 单例，不存在「换实现」的依赖倒置需求。

当前 services 层以下 **8 处**静态 import `logger`，属受控例外（合规）：

| 文件 | 行 | 用途 |
|-----|---|------|
| `services/quota-cache.ts` | 15 | 配额缓存命中/失效日志 |
| `services/quota-service.ts` | 21 | 配额查询编排日志 |
| `services/migration/parsers/codex-parser.ts` | 23 | codex 迁移解析日志 |
| `services/quota-providers/minimax.ts` | 14 | minimax 配额探测日志 |
| `services/quota-providers/mimo.ts` | 13 | mimo 配额探测日志 |
| `services/quota-providers/opencode.ts` | 13 | opencode 配额探测日志 |
| `services/quota-providers/kimi.ts` | 11 | kimi 配额探测日志 |
| `services/worktree-config-helper.ts` | 23 | worktree 配置读取日志 |

#### ② pi-paths —— kernel 纯路径函数

`infra/pi/pi-paths.ts` 是纯路径解析函数集（`getSessionsDir` / `getPiAgentDir` / `getSubagentSessionDir` / `getExtensionsDir` / `getNpmDir` / `getTmpDir` / `encodeCwd` 等），**无 pi 状态、无副作用、无 IO**，仅依据 `getDataDir()` / `getConfigDir()`（来自 shared/paths）做字符串拼接。它与 `shared/paths.ts` 同性质——纯路径计算——故归为 **kernel 层**（与 infra 平级的共享内核，任意层可如 shared 般直接 import），不强制走 port。

当前 services 层以下 **6 处**依赖 `pi-paths`，属 kernel 直接依赖（合规）：

| 文件 | 行 | 使用的函数 |
|-----|---|-----------|
| `services/config-service.ts` | 39 | `getConfigDir` |
| `services/worktree-config-helper.ts` | 22 | `getPiAgentDir` |
| `services/extension-service.ts` | 32 | `getExtensionsDir`, `getNpmDir`, `getTmpDir` |
| `services/session/session-lifecycle.ts` | 27 | `getSessionsDir` |
| `services/session/session-service.ts` | 33 | `getSubagentSessionDir`, `getPiAgentDir` |
| `services/session/subagent-extractor.ts` | 28 | `getSubagentSessionDir` |

#### ③ 纯解析函数（git-status-parser / ignore-parser）—— kernel 纯函数

`infra/git/git-status-parser.ts`（`parseGitStatus` / `deriveCounts` / `parseNumstat` / `parseNumstatByFile`）与 `infra/fs/ignore-parser.ts`（`compileIgnoreRules` / `matchPath` / `IgnoreMatcher`）是纯解析/匹配函数集——**输入字符串/规则，输出结构化数据，无 IO、无状态、无副作用**。与 pi-paths 同性质（纯计算），归 kernel 层，services 可直接 import。

当前 services 层以下依赖这两个模块，属 kernel 直接依赖（合规）：

| 文件 | 行 | 使用的函数 |
|-----|---|-----------|
| `services/git-service.ts` | 21 | `parseGitStatus`, `deriveCounts`, `parseNumstat`, `parseNumstatByFile` |
| `services/file-service.ts` | 21-22 | `IgnoreMatcher`(type), `compileIgnoreRules`, `matchPath` |

#### ③b crash-journal —— 跨切面取证日志设施（2026-09-11 增补）

`infra/crash-journal.ts` 是统一崩溃台账 writer（[crash-forensics-and-watchdog](../design/crash-forensics-and-watchdog.md) 设计 D1）：append-only JSONL + 10MB×3 段轮转，与 ① logger 完全同类——**无业务语义、process-wide 单例、best-effort**（写失败降级不抛进业务链）。services 层在死亡/自愈决策点双写台账行（crash/deleted/reaped/reclaimed 等），为它定义 port 并注入只会复制 logger 裁决已否定的无意义间接层。归受控例外（合规），`.githooks/check_services_infra_import.py` 白名单同名登记。

#### ③c mem-pressure —— os 级内存压力即时查询（2026-09-11 增补）

`infra/mem-pressure.ts` 是 os 级内存压力即时查询（[crash-forensics-and-watchdog](../design/crash-forensics-and-watchdog.md) 设计 D3 高水位延迟 / D4 采样形态裁决；u5 交付、u7c 滚动重启硬升级后续消费），与 ① logger / ③b crash-journal 同类的横切关注点——**无业务语义、无状态、无副作用、best-effort**：每次调用重新读 os（node:os freemem/totalmem + 平台 swap 探针），零采样环/缓存（D4「即时查询」裁决的字面要求），查询永不 reject。services 层消费方 = startup-reattach（D3 高水位延迟）；为它定义 port 并注入只会复制 logger 裁决已否定的无意义间接层。归受控例外（合规），`.githooks/check_services_infra_import.py` 白名单同名登记。

> **新增 services→infra import 时的判断准则**：logger 类横切关注点（无业务语义、process-wide 单例）可直接 import——含 logger、crash-journal（取证台账，2026-09-11 增补）与 mem-pressure（os 级内存压力即时查询，无状态只读，2026-09-11 增补）；kernel 类纯函数（无状态、无副作用、无 IO，与 shared 同性质）——含 pi-paths 路径解析、git-status-parser/ignore-parser 等纯解析/匹配函数——可直接 import。其余 infra 模块——含 pi 协议类型、RPC 子进程、有状态/有 IO 的文件操作、安装器等——一律经 port 访问，不得直接 import。

#### ④ node:fs / node:child_process 直用 —— 基线债登记（非合规例外，R3 收编）

> 与 ①-③ 不同：本条登记的**不是**受控例外，而是与目标态存在差距的未收编基线债。登记目的是让架构审查遇到下述形态时有豁免依据，不误报为「新增违规」；债本身待 R3 统一清偿。

**现状**：services 层 45 个生产文件 value import `node:fs`（2026-09-01 实测；复核命令 `grep -rl "from 'node:fs'" packages/runtime/src/services/ | grep -v '\.test\.ts'`，含 `node:fs/promises` 前缀命中），与 C-comm-03 正文「services 层 IO 一律经 port」的目标态存在长期差距——这是**未收编的基线债，不是合规形态**。

**机器防线现状**：`check_services_infra_import.py` 只拦截 services→infra 方向的 value import（白名单与基线模块清单见该脚本 docstring）；node:fs 直用**无机器拦截**，目前仅靠 review-arch-boundary 审查面把关（本轮 must-fix 即由该审查面报出后回落到本登记）。

**本批显式列入清单**：`services/session/background-task-reaper.ts`（555 行，直用 node:fs + node:child_process spawnSync）。它是后台收殓任务（孤儿后台任务补杀 + registry 终态回写），横切基础设施性质与 ① logger 同类，不在业务请求路径上；判定逻辑已有测试覆盖 175/175 行（runtime incremental coverage）。裁决理由：单独 ports 化这一个文件将与存量 45 文件形成 1:45 双轨，违反一致性；留待 R3 ports 收编统一治理。

**补登（2026-09-12，crash-resilience 批次新增文件随批登记，review MF-8；crash-resilience.md 设计文档已删除，git 可追溯）**：
- `services/startup-reattach.ts`（node:fs `existsSync`/`unlinkSync`）：启动重附探测的残留 checkpoint 文件清理——启动期一次性路径，与 background-task-reaper 同类不在业务请求路径上；
- `services/session/runtime-checkpoint.ts`（node:fs 多符号）：runtime checkpoint 读写本体（崩溃取证/恢复链的自有文件 IO，非 pi 文件），文件即该模块的存在理由；
- `services/session/rolling-restart.ts`（node:v8 `getHeapStatistics`）：滚动重启硬升级判定的 heap 水位读取——os 级只读探针语义与 ③c mem-pressure 同类（无业务语义、无状态、best-effort），v8 而非 os 模块仅为数据源差异；
- `services/session/history-reverse-read.ts`（node:fs `openSync`/`readSync`/`closeSync`/`fstatSync`）：通用 JSONL 逆序分块读工具——按「通用 fs IO 工具不属 services 业务层」裁决**已迁 utils/history-reverse-read.ts**（与 jsonl.ts 同层，infra/services 双向消费方合法依赖），不再占本清单。

**收编路线**：新增 services 代码优先经 port 接口访问文件系统；存量文件随阶段 R3（ports 接口落地）分批迁移；迁移完成前，本登记作为架构审查对该形态的豁免依据。

**依赖方向**：`transport → services ← infra`（services 定义 ports，infra 实现 ports，箭头都指向接口）。**无环**。

---

# 第三部分 · ports 接口清单

ports 是依赖倒置的载体：services 定义「我需要什么能力」，infra 实现。接口签名**只用内部类型或 shared 类型**，绝不出现 PiXxx。

> 现有 `interfaces.ts` 已有部分接口（ISessionService/IConfigService 等），但它们是 service 对 transport 暴露的。ports 是反方向的——service 对 infra 要求的能力契约。两者并存，不冲突。

```ts
// services/ports.ts —— service 层定义、infra 层实现的依赖倒置接口

/** pi 引擎交互（每个 session 一个实例） */
export interface IPiEngine {
  prompt(content: string): Promise<void>
  abort(): Promise<void>
  steer(content: string): Promise<void>
  followUp(content: string): Promise<void>
  compact(): Promise<void>
  setModel(provider: string, modelId: string): Promise<void>
  setThinkingLevel(level: string): Promise<void>
  getHistory(): Promise<Message[]>              // ← 返回内部 Message，非 PiMessage
  getCommands(): Promise<Command[]>             // ← 返回内部 Command
}

/** pi 进程池（session↔pi 绑定） */
export interface IPiProcess {
  createSession(sessionId: string, cwd: string, opts: SessionOptions): Promise<IPiEngine & IPiEventSource>
  destroySession(sessionId: string): Promise<void>
  getClient(sessionId: string): (IPiEngine & IPiEventSource) | undefined
  hasClient(sessionId: string): boolean
  onExit(cb: (sessionId: string, code: number | null) => void): void
}

/** pi 事件流（翻译后内部事件） */
export interface IPiEventSource {
  onEvent(listener: (event: PiTranslatedEvent) => void): () => void  // ← 内部事件类型
}

/** 配置存储（Provider/Skill/Agent CRUD，内部类型） */
export interface IConfigStore {
  listProviders(): ProviderInfo[]
  upsertProvider(id: string, data: ProviderInput): ProviderResult
  deleteProvider(id: string): ProviderResult
  getDefaultModel(): ModelRef | null
  setDefaultModel(ref: ModelRef): void
  loadSkills(root: string): SkillInfo[]
  saveSkills(root: string, skills: SkillInfo[]): void
  loadAgents(root: string): AgentInfo[]
  // ... Agent/Skill CRUD
}

/** 模型发现（HTTP 探测 + 聚合） */
export interface IModelSource {
  aggregateModels(providers: ProviderInfo[]): ModelInfo[]
  discoverFromApi(baseUrl: string, apiKey?: string, type?: string): Promise<ModelMeta[]>
}

/** 安装器（npm/git） */
export interface IInstaller {
  installNpm(spec: string): Promise<InstallResult>
  installGit(url: string): Promise<InstallResult>
}
```

**内部事件类型**（`PiTranslatedEvent`，取代泄漏的 `PiMessage`）：在 `services/types.ts` 定义，由 `infra/pi-events.ts` 从 pi 原始事件翻译而来。这是「断开 PiXxx 泄漏」的关键——service 只见翻译后的内部事件。

---

# 第四部分 · 现有文件归位表

逐文件标注 `[层] 子目录/动作`。`git mv` = 纯移动；`重构` = 需改逻辑/加翻译。

## adapters/（8 文件，全部消失——拆入 infra）

| 文件 | 行 | 性质 | 归位 |
|------|----|----|------|
| event-adapter.ts | 511 | 真翻译（pi事件→ServerMessage） | `[infra/pi/] pi-events.ts` 重构：翻译为内部事件（PiTranslatedEvent），实现 IPiEvents |
| message-converter.ts | 129 | 真翻译（pi历史→Message[]） | `[infra/pi/] pi-history.ts` 重构：实现 history 翻译 |
| session-tree-reader.ts | 299 | 真翻译（pi JSONL树→树模型） | `[infra/pi/] pi-tree.ts` 重构 |
| navigate-interceptor.ts | 76 | pi 扩展消息拦截 | `[infra/pi/] navigate-interceptor.ts` git mv |
| pi-config-bridge.ts | 182 | re-export 杂物间 | **拆解**：路径→`pi-paths.ts`；re-export 的 CRUD→`pi-config.ts`；re-export 的类型→废弃 |
| pi-provider-store.ts | 461 | pi 的 models.json CRUD（原始 pi 类型） | `[infra/pi/] pi-config.ts` 重构：CRUD 保留，翻译 Provider↔PiProviderConfig |
| pi-paths.ts | 50 | 路径解析 | `[infra/pi/] pi-paths.ts` git mv |
| session-file-utils.ts | 185 | session 文件操作 | `[infra/pi/] session-files.ts` git mv |

## infra/（8 文件 → infra/ 重组织）

| 文件 | 行 | 性质 | 归位 |
|------|----|----|------|
| rpc-client.ts | 388 | pi 子进程 stdin/stdout | `[infra/pi/] pi-client.ts` 重构：实现 IPiEngine，去 PiMessage export |
| process-manager.ts | 267 | session→pi 绑定 | `[infra/pi/] process-pool.ts` 重构：实现 IPiProcess |
| npm-installer.ts | 460 | registry HTTPS | `[infra/installers/] npm-installer.ts` git mv，实现 IInstaller |
| extension-resolver.ts | 358 | 扩展路径解析 | `[infra/installers/] extension-resolver.ts` git mv |
| skill-scanner.ts | 166 | skill 扫描 | `[infra/scanners/] skill-scanner.ts` git mv |
| agent-scanner.ts | 139 | agent 扫描 | `[infra/scanners/] agent-scanner.ts` git mv |
| scanner-base.ts | 35 | 扫描基类 | `[infra/scanners/] scanner-base.ts` git mv |
| trash.ts | 24 | 废纸篓 | `[infra/system/] trash.ts` git mv |

## transport/（7 文件，保留 + 微调）

| 文件 | 行 | 归位 |
|------|----|------|
| server.ts | 359 | `transport/server.ts` 重构：handler 移到 setServices 后构造，去 `as unknown` |
| session-message-handler.ts | 134 | `transport/handlers/session.ts` git mv |
| tree-message-handler.ts | 118 | `transport/handlers/tree.ts` git mv |
| extension-message-handler.ts | 165 | `transport/handlers/extension.ts` git mv |
| plugin-message-handler.ts | 80 | `transport/handlers/plugin.ts` git mv |
| settings-message-handler.ts | 138 | `transport/handlers/settings.ts` git mv |
| bridge-handler.ts | 95 | `transport/handlers/bridge.ts` git mv |

## services/（session/ + 根级，需去 PiXxx 依赖）

| 文件 | 行 | 归位 | 改动 |
|------|----|------|------|
| session/* (5文件) | 767 | 保留原位 | 改 import：`PiMessage`→`PiTranslatedEvent`；adapter 创建经 IPiEvents |
| config-service.ts | 308 | 保留 | **重**：去 `pi-config-bridge` import，改依赖 IConfigStore port；`mapTypeToApi` 移入 infra/pi-config |
| model-service.ts | 138 | 保留 | 去 pi 类型，改依赖 IModelSource port |
| tree-service.ts | 207 | 保留 | 去 `PiMessage` + adapters import，经 ports |
| extension-service.ts | 694 | 保留 | git clone 逻辑抽到 infra/git-installer，经 IInstaller port |
| extension-timeout-manager.ts | 101 | 保留 | 无改动（纯超时管理） |
| git-info.ts | 83 | `[infra/system/]` git mv | 从 service 移到 infra（它查 git，是外部系统连接） |
| session-history.ts | 56 | 保留或并入 session/ | 去 `convertPiHistory`/`scanPiSessions` import，经 ports |
| plugin-service/ (27) | 5173 | **保留原位不动** | 黑盒，已自洽 |

## 根级（3 文件）

| 文件 | 行 | 归位 |
|------|----|------|
| index.ts | 174 | 保留，调整 DI 接线（构造 infra 实现，注入 service） |
| interfaces.ts | 275 | 保留（service→transport 契约）+ 新增 `ports.ts`（service→infra 契约） |
| types.ts | 444 | **拆**：`Pi*` 类型移入 `infra/pi/pi-protocol.ts`；内部类型留 `services/types.ts` |

## 其他

| 文件 | 行 | 归位 |
|------|----|------|
| utils/path-utils.ts | 17 | 保留 `utils/` 或并入 `infra/`（纯函数，任意层可用） |
| plugins/demo/ | — | 不动（示例插件） |

---

# 第五部分 · 迁移步骤

> **铁律**：每阶段独立 commit、独立验证（`pnpm run build:runtime` + `validate-runtime-bundle.sh` + vitest）。禁止跨阶段部分回滚。plugin-service 全程不动。

## 阶段 R0 · 文档与认知（0 代码风险）

- 本设计文档 + ports 接口定义（本文件 + `services/ports.ts` 骨架）
- 在 design.md 标注 D4 被 supersede，指向本文件
- **验证**：无

## 阶段 R1 · PiXxx 类型收敛（低风险，机械）

**目标**：把 `types.ts` 的 `Pi*` 类型移到 infra 内部，断开根级共享。

1. 新建 `infra/pi/pi-protocol.ts`，`git mv` types.ts 里的 `Pi*` interface/type 过去
2. 全仓 import 路径修正（infra 内部从 pi-protocol 引，service/transport 引不到）
3. `services/types.ts` 只留内部类型（Message/Provider/Session 等，本就来自 shared 或新定义）
- **验证**：tsc + build + vitest
- ⚠️ 中间态：service 仍可能通过相对路径引到 Pi* —— R3 彻底断开

## 阶段 R2 · adapters/infra 合并 + 目录归位（机械，低风险）

**目标**：消灭 adapters/ 目录，全部归入 infra/，按外部系统建子目录。

1. 建 `infra/pi/`、`infra/installers/`、`infra/scanners/`、`infra/system/`
2. `git mv` 按「归位表」执行（纯移动，不改逻辑）
3. 修正所有 import 路径
4. **关键**：`pi-paths.ts` 移入 infra/pi/，`rpc-client` 改 import 同层 pi-paths → **消除 infra→adapters 反向依赖**
- **验证**：tsc + build + validate-runtime-bundle.sh + vitest

## 阶段 R3 · ports 接口落地（中风险，核心）

**目标**：service 不再 import infra，改依赖 ports 接口。

1. 在 `services/ports.ts` 定义 IPiEngine/IPiProcess/IConfigStore/IModelSource/IPiEvents/IInstaller
2. infra 侧：`pi-client` 实现 IPiEngine、`process-pool` 实现 IPiProcess、`pi-config` 实现 IConfigStore、`model-source` 实现 IModelSource、`pi-events` 实现 IPiEvents
3. 定义 `PiTranslatedEvent`（内部事件类型），`pi-events.ts` 把 pi 原始事件翻译成它
4. service 改 import：`config-service` 去 `pi-config-bridge` 改 IConfigStore；`mapTypeToApi` 移入 infra/pi-config
5. index.ts 组合根：构造 infra 实现，注入 service 的 ports
- **验证**：tsc + build + vitest（重点跑 session/config/model 测试）
- ⚠️ 这是改动最大阶段；建议先写 ports 的 vitest（mock 实现）验证 service 行为不变

## 阶段 R4 · transport 清理（低风险）

1. server.ts 的 handler 构造移到 `setServices()` 后，去掉 `as unknown as` 强转
2. （可选）switch 路由改声明式 map（T1）
3. handlers/ git mv 进 `transport/handlers/`
- **验证**：tsc + build + 手测 WS 消息流

## 阶段 R5 · 收尾验证

- `pnpm run build:runtime` + `validate-runtime-bundle.sh`
- `rg "Pi[A-Z]" services/ transport/` → **应为空**（PiXxx 不再泄漏）
- `rg "from '.*infra/" services/` → **应为空**（service 不直接 import infra，只经 ports）
- 全量 vitest

---

## 与现有 phase 计划的关系

| 现有 phase | 状态 | 与本设计关系 |
|-----------|------|-------------|
| phase-2 (runtime 分层) | ✅ 已完成 | 本设计是 phase-2 的**修订**——phase-2 建了四层，本设计改为三层 |
| phase-3 (拆 session-service) | ✅ 已完成 | **保留**，session 三拆分质量高，不动 |
| phase-4 (命名对齐) | ✅ 已完成 | 保留 |
| phase-5 (防护加固) | 未开始 | 本设计的 R5 验证项覆盖部分 phase-5 |

**plugin-service 在所有 R 阶段均不动**（已自洽，作为黑盒）。

---

## 一句话总结

runtime 是 pi 引擎的 Node.js 宿主，领域薄、适配重。放弃 D4 的四层（adapters 独立）改为三层（infra 合并连接+翻译），用 ports 依赖倒置断开 PiXxx 泄漏。改动以 git mv + 加翻译为主，业务逻辑基本不动，分 5 阶段（R0-R5）低风险推进，plugin-service 全程不碰。
