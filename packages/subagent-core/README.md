# @zhushanwen/subagent-core

跨宿主共享的 subagent 执行层与 workflow 编排核心：pi extension（`@zhushanwen/pi-subagent-workflow`）与 zcode 插件（zsw）双宿主引用同一实现，消灭两套平行实现导致的逻辑漂移。

- **双形态包（D4）**：workspace 消费 TS 源（exports 的 `import` 条件指向 `src/`），npm 消费 tsup 产物（dist ESM + CJS，`publishConfig` 在 publish 时整体替换 `exports`）。CJS 产物对 `@xyz-agent/extension-protocol` 设 tsup noExternal 防御性 bundle 边界——其 npm dist 仅 ESM，而 CJS 宿主（zsw，node>=20）的 require 链不能承载外部 ESM 依赖（设计 D4，见本仓 `docs/architecture/subagent-core-package-extraction.md` §3.3；当前 entry 闭包无 protocol 运行时引用、dist 实测零常量命中，未来一旦引入即 bundle）。其余依赖（ajv / yaml / proper-lockfile）保持外部依赖形态，均为常规 CJS 可 require 的双格式包。
- **依赖闭包（D3）**：`@xyz-agent/extension-protocol` + `proper-lockfile` + `ajv` + `yaml`；宿主服务（日志 / 数据根 / 发现根 / 通知）经 `HostServices` 端口注入，core 闭包不含 pi SDK。
- **workflows 资产（D1）**：内置 workflow 脚本（`.js` / `.cjs`）不参与编译，包内 `workflows/` 目录 src=dist 同字节直发，经 `./workflows/*` 子入口按原文件访问。
- **公共 API 面即 semver 契约（D5）**：breaking 走 major；导出面收窄不放宽，新增导出走 minor。**0.x 例外**：`<1.0.0` 阶段按 npm 0.x 惯例 minor 可携带 breaking（caret 消费者被锁定在 `0.x` 精确版本，破坏面可控；已声明的行为变更如 `normalizeRef` 拒绝 `..` 段即以此承载）；1.0 起 breaking 严格走 major。

## 公共 API

### 主入口（`@zhushanwen/subagent-core`）

| 导出 | 类别 | 说明 |
|------|------|------|
| `configureCore(host)` | fn | 注入宿主服务（`HostServices`）；未注入即消费 `dataRoot()` 抛 `core_host_not_configured` |
| `DEFAULT_DATA_ROOT` | const | core 内建缺省数据根（`~/.subagent-core`），供宿主显式选用（消除缺省静默漂目录） |
| `HostServices` | type | 宿主服务端口：`dataRoot` / `log` / `discoveryRoots` |
| `DiscoveryRoot` | type | 发现根条目 `{ dir, source }`（source 标签供遮蔽报告与测试断言） |
| `getLogger(component)` | fn | facade 代理 logger——每次调用动态解析当前宿主实现，`configureCore` 前后透明切换 |
| `CoreLogger`, `LogLevel` | type | logger 端口类型（`HostServices.log` 契约成员） |
| `configureNotifyDomain(ports)` | fn | 注入通知域窄端口（投递内核工厂 + pending 活跃计数），成员可选、缺席降级 |
| `NotifyDomainPorts` | type | 通知域端口结构（结构化签名，core 不 import 通知实现包） |
| `EnginePort` | type | subagent 执行引擎唯一契约点（run / interact / read / probe 四能力面） |
| `RunContext`, `EngineRunResult` | type | `EnginePort.run` 的运行期上下文与结果 |
| `AgentTaskSpec`, `AgentOutcome`, `AgentEvent` | type | 任务声明 / 执行结果 / 事件流（引擎中立） |
| `SessionView`, `ReplayedTurn`, `EngineHandle`, `EngineHandleData` | type | 会话视图 / 回放轮次 / 运行句柄 |
| `EngineCapabilities`, `ProbeReport`, `PersonaSpec` | type | 能力声明 / 探针报告 / persona 声明 |
| `InteractAction`, `InteractResult` | type | 交互控制面（chatMode message/close/cancel + idle） |
| `ModelInfo`, `SubagentStream` | type | `RunContext` 成员类型（type-only，`SubagentStream` 由 core 内部构造） |
| `routeEngine(opts)` | fn | 三层路由（调用参数 > frontmatter > 全局默认）+ probe fallback 编排的单一权威点 |
| `EngineRouteOptions`, `EngineRouteResult`, `EngineRouting`, `EngineRoutingInput`, `EngineRoutingSource` | type | 路由层类型 |
| `runWorkflow(spec, deps, signal?)` | fn | workflow run 生命周期入口（返回 runId） |
| `abortRun(runId, deps, ...)` | fn | 终止 run（done 态 no-op） |
| `RunSpec`, `LifecycleDeps` | type | `runWorkflow` 参数类型 |
| `terminateRunningRuns(deps, reason)` | fn | session 切换/关闭时批量终止全部 running run（转 done,failed 落盘） |
| `evictDoneRunsBeyondCap(runs, keepDone)` | fn | done run 内存淘汰（按 completedAt 升序裁超出保留窗口的项） |
| `MAX_RETAINED_DONE_RUNS` | const | done run 内存保留窗口（K=20），`evictDoneRunsBeyondCap` 生产入参 |
| `scheduleTimeBudget(runId, deps, budgetTimeMs)` | fn | run 级墙钟预算计时器（到期 abortRun `time_limited`；溢出值 fail-fast） |
| `runAndWait(name, args, deps, ...)` | fn | 阻塞至 done 的 launcher 入口（registry 查找 + lint + 轮询，返回 `WorkflowRunResult`） |
| `executeNestedWorkflow(name, args, parentRun, deps)` | fn | 嵌套 `workflow()` 调用执行体（循环检测 + budget 共享；宿主 `onWorkflowCall` 注入用） |
| `WorkflowRunResult` | type | `runAndWait` 返回（status 恒 done + reason/scriptResult/error） |
| `LauncherDeps` | type | launcher 依赖（`LifecycleDeps` + `registry` 脚本发现） |
| `WorkerHostImpl` | class | `WorkerHost` port 的 worker_threads 实现（`deps.workerHost` 默认装配） |
| `WorkflowScriptRegistryImpl` | class | 脚本注册表 Infra 实现（`LauncherDeps.registry` 默认装配，config-loader 之上包装 `WorkflowScript` 实体） |
| `lintScript(source)` | fn | workflow 脚本静态检查（执行前 fail-fast） |
| `LintFinding`, `LintResult` | type | lint 发现项 / 结果 |
| `discoverWorkflows(configOrCwd?)`, `loadWorkflows()`, `getWorkflow(name)`, `getWorkflowByPath(ref)`, `invalidateCache()` | fn | workflow 发现/加载/缓存失效（宿主 list 面与 registry 构造消费） |
| `WorkflowScanConfig`, `CachedWorkflowMeta`, `WorkflowMeta`, `WorkflowSource` | type | 发现层类型（扫描目录声明 / 缓存 meta / 资源 meta / 来源标签） |
| `FileRunStore` | class | `RunStore` port 的宿主无关文件实现：落盘 `<dataRoot>/workflow-state/<runId>.jsonl`（append-only 全量快照，`loadAll` 取每文件最后一条有效行、损坏行跳过并 warn）。zsw 等无 pi session 设施的宿主装配 `deps.store` 用 |
| `AgentRunner`, `RunStore`, `WorkerHost`, `WorkerHandlers` | type | 编排层 port 契约（宿主自写 Infra 实现时的契约面） |
| `registerZcodeEngine(engineDataDir?)` | fn | 把 `zcode` 引擎登记进 registry（组合根调用，幂等、工厂惰性） |
| `createZcodeEngine(deps)` | fn | zcode 引擎 DI 工厂（测试/宿主注入 `ZcodeEngineDeps`） |
| `killAllSpawnedChildren(signal?)` | fn | 全量收割记账（宿主 shutdown 钩子消费）：镜像整体置死，返回记账条数；实际终止经协议 cancel/close / EngineClient killAll，本函数不直接发信号（`signal` 参仅为旧签名兼容，已忽略） |
| `CORE_PACKAGE_VERSION` | const | 包版本常量（与 package.json 同步维护） |

### 语义子入口（双端复用链专用）

| 子入口 | 内容 |
|--------|------|
| `@zhushanwen/subagent-core/engines/zcode/reader` | zcode 引擎 session 历史读取（`readZcodeSessionView` / `ZcodeReaderError`） |
| `@zhushanwen/subagent-core/engines/zcode/constants` | zcode 引擎常量（`ZCODE_ENGINE_ID` / 路径后缀 / 缺省模型等） |
| `@zhushanwen/subagent-core/engine/paths` | 引擎数据目录路径推导（engines 根 / 池目录 / journal 路径） |
| `@zhushanwen/subagent-core/relay-env` | relay 通道 env 名与协议常量 SSOT（extension / runtime / 代理三方共用） |

### 资产子入口

| 子入口 | 内容 |
|--------|------|
| `@zhushanwen/subagent-core/workflows/*` | 内置 workflow 脚本原文件（`chain.js` / `parallel.js` / `scatter-gather.js` / `map-reduce.js` / `review-fix-loop.js` + `review-fix-loop-utils.cjs` / `_shared/`），`require` 与 `import` 条件同径（D1 同字节直发） |

仓内壳侧（pi extension）另有 `./* -> src/*` 通配深路径消费（`<pkg>/<域>/<路径>.ts` 形态）——该通配仅仓内保留，npm 发布面刻意收窄到上列受控入口（D5：exports 面即 semver 契约）。语义子入口精确条目优先于通配（Node exact-match-beats-pattern）。

## 宿主接入示例

两段示例同时是 `core_host_not_configured` 错误恢复指引的落点：**看到该错误 = 宿主壳未调 `configureCore`，按下述示例补注入后重试。**

### pi 壳（workspace 引用）

活例：本仓 `extensions/universal/subagent-workflow/src/host/pi-host.ts`（`createPiHostServices`）。要点：`dataRoot` / `discoveryRoots` 每次调用现取 `getAgentDir()`（禁模块级缓存——pi 实例按 session dir 隔离），log 桥接 `@zhushanwen/pi-extension-logger`，notify 桥接 `@xyz-agent/session-delivery` + `@zhushanwen/pi-pending-notifications`。扩展初始化最早处：

```ts
import { configureCore, configureNotifyDomain } from "@zhushanwen/subagent-core";
import { createPiHostServices, createPiNotifyDomainPorts } from "./host/pi-host.ts";

configureCore(createPiHostServices());
configureNotifyDomain(createPiNotifyDomainPorts());
```

### zsw / 独立宿主（npm 引用，纯 CJS）

最小接入 = `configureCore({ dataRoot, log })` + `getLogger`。错误闭环：未注入时消费 core API 抛 `core_host_not_configured`（错误信息指向本节）→ 按下例补 `configureCore` → 重试：

```js
// Node >= 20，CommonJS
const {
  configureCore,
  getLogger,
  DEFAULT_DATA_ROOT,
} = require("@zhushanwen/subagent-core");

configureCore({
  dataRoot() {
    return DEFAULT_DATA_ROOT; // 或宿主自有数据根，如 path.join(os.homedir(), ".zcode", "zsw")
  },
  log(level, component, message, data) {
    // 接宿主日志设施；最小实现可直接走 console（core 缺省 sink：warn/error 走 console、debug no-op）
    (level === "error" ? console.error : console.debug)(`[${component}] ${message}`, data ?? "");
  },
  // discoveryRoots 可选：不传则用 core 内建缺省（user 级 agents/workflows 根）
});

const logger = getLogger("zsw"); // facade：configureCore 前后透明切换宿主实现
logger.debug("host configured");
```

### 失败形态与恢复指引

| 错误 | 触发 | 恢复 |
|------|------|------|
| `core_host_not_configured` | 未 `configureCore` 即消费 | 按上节示例补注入后重试（错误信息内含指引） |
| `core_module_load_failed`（require 链） | 安装形态 / node 版本问题 | node 版本要求 >= 20；`rm -rf node_modules && npm i` 重装；确认经包 `exports` 的 `require` 条件加载 dist CJS，而非手工深引 `dist/` 内部路径 |
| `core_module_load_failed`（worker scriptPath） | workflow worker 启动时 `workerData.scriptPath` 缺失 | D1：workflow 脚本以 **scriptPath 目录锚定**加载——宿主 spawn worker 时必须注入脚本绝对路径（`workerData.scriptPath`），staged / npm 安装布局下无 node_modules 解析面可回退；请检查宿主 worker 宿主点的注入代码，勿改脚本内 require 包名 |

## 构建

```bash
pnpm run build         # tsup 多入口：主入口 + 4 语义子入口保形输出（dist/<entry> 与 src 同构，d.ts/d.cts 全覆盖）
pnpm run build:bundle  # 自包含 CJS bundle：dist.bundle/index.cjs（见下节）
pnpm run test
pnpm run typecheck
```

发布走本仓 changeset 管线；`publishConfig` 中的发布面与开发态 `exports` 必须同步维护（新增子入口时两处同改）。

### 自包含 bundle 构建（`build:bundle`）

`dist.bundle/index.cjs` 是**单文件自包含 CJS 产物**：tsup `noExternal` 把全部运行时依赖（`@xyz-agent/*`、`ajv`、`yaml`、`proper-lockfile`）内联进产物，require 链上只剩 node 内建模块。

用途：**无 node_modules 解析面的宿主 vendoring**——典型是 zcode 插件（zsw）：插件目录被整体复制进 marketplace 缓存 / inline 加载，没有依赖安装链，`require("@zhushanwen/subagent-core")` 无从解析。这类宿主把 `dist.bundle/index.cjs` 复制进自身目录后直接 `require("./vendor/subagent-core/dist/index.cjs")`（vendored 落位统一为 `vendor/subagent-core/dist/`），只认文件不认解析链。

与常规 `dist/` 的分工：`dist/` 面向有正常 node_modules 解析面的消费者（npm 安装形态，依赖留外部）；`dist.bundle/` 面向 vendoring 形态。两档构建按 script 名分流（`tsup.config.ts` 读 `npm_lifecycle_event`）：`build` 行为不变，`build:bundle` 独立产出。

vendoring 宿主接入片段：

```js
// 宿主目录内（无 node_modules）
const {
  configureCore, getLogger, FileRunStore, WorkerHostImpl,
  runWorkflow, abortRun, terminateRunningRuns, discoverWorkflows,
} = require("./vendor/subagent-core/dist/index.cjs");

configureCore({
  dataRoot() { return "/path/to/host/data-root"; }, // FileRunStore 落 <dataRoot>/workflow-state/
  log(level, component, message, data) { /* 接宿主日志 */ },
});
```
