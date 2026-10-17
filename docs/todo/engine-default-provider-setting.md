# TODO：subagent 引擎 provider 来源统一 + settings 页 per-engine 默认模型

## 状态

已实施，登记关闭（2026-10-12 经设计包 `.tmp/tech-design/engine-provider-unification.md` 实施落地：provider 启动同步链 + 引擎校验源副本锚点 + per-engine 默认模型全链——配置键 sanitize / 派发插层 / RPC / settings 页——已提交，git 可追溯）。2026-10-11 用户裁决方向：provider 来源统一——zcode 与 pi 的 provider 大部分一致，差异仅在 zcode 自有 built-in provider（zhipu/zai 系账号认证体系，用户在 ZCode 端提前配置好即可）；做法 = 将 taiji 侧 pi provider（含 zhipu/zai 相关）映射一份给 zcode 引擎消费，每次 taiji 启动时同步。本登记「现状核实」「方案」两节为该设计包的前置输入，登记随设计包交付关闭，保留作溯源。

后续修订（2026-10-16，ADR-0139）：本节「不写 `~/.zcode/` 任何文件」的绝对表述已被 ADR-0139 的窄例外取代——standalone 账号链仅写入两条**非秘密**账号元数据键（`account-provider:<pid>:identity` / `:auth-source`），provider 配置仍零写入、其余 `~/.zcode/` 文件仍零写入。

## 要做什么

两件事，同一配置域：

1. **provider 来源统一（pi → zcode 同步映射）**：taiji 启动时把 pi 侧 provider 配置映射为 zcode 引擎可消费的个人 provider 清单，落 taiji 数据目录（**不写 `~/.zcode/` 任何文件**；例外见 ADR-0139：仅两条账号元数据键）；zcode 引擎的模型校验链与凭据注入链消费该清单。效果：用户在 taiji 配一次 provider，pi 主会话与 zcode 引擎都能用。
2. **settings 页 per-engine 默认模型**：与「默认引擎」单选归并到同一配置域（`<dataDir>/agent/subagents/config.json`）；消费链优先级：task 显式指定 > agent frontmatter 声明 > settings 用户偏好 > 引擎缺省。

## 现状核实（2026-10-11，文件:行号）

### ① pi 侧 provider 配置形态与位置

- **配置根**：`<dataDir>/agent/`（`packages/runtime/src/infra/pi/pi-paths.ts:67-77`，`getPiAgentDir()`/`getModelsPath()`/`getSettingsPath()`；prod = `~/.taiji/agent/`，dev 实例 = `~/.taiji-dev/instances/<worktree>/agent/`）。
- **models.json**：`{ providers: { <providerId>: PiProviderConfig } }`。schema = `packages/runtime/src/infra/pi/pi-provider-store.ts:59-94`——provider 级 `name / baseUrl / apiKey / api / enabled / headers / authHeader / models[] / modelOverrides`（`authMethod`、`quota` 是寄生字段，权威在 `config/providers.json` 扩展域，`pi-paths.ts:110-112`）；模型级 `id / name / api / baseUrl / reasoning / enabled / input / contextWindow / maxTokens / headers / cost / compat / thinkingLevelMap`。读写层同文件 `readModels/writeModels/upsertProvider/removeProvider`（:187-364）。
- **凭据双源**：models.json 内联 `apiKey`（自定义 provider 常态）+ `auth.json`（`<agentDir>/auth.json`，键 = providerId，值 `{type, key}`；catalog provider 如 `zai-coding-cn`/`xiaomi-token-plan-cn`/`kimi-coding` 的 key 落这里）。pi 引擎侧同语义锚点：`packages/pi-subagent-cli/src/engine-query.ts:85-91`（`credentialedProviderIds` = auth.json 键集 ∪ 内联 apiKey 声明集）。runtime 侧读取经 `AuthStorage`（`packages/runtime/src/index.ts:582`）与凭据 resolver 单通道（`pi-provider-store.ts:246-271`）。
- **catalog 合并视图**：catalog provider（builtin 42 个，`packages/runtime/src/generated/builtin-providers.json`，含 `zai` / `zai-coding-cn`）的模型清单不在 models.json，来自 catalog 快照 ∪ 远程 overlay——合并单点 `getMergedCatalogModels`（`packages/runtime/src/services/provider-catalog.ts`）。
- **settings.json**：`defaultProvider` + `defaultModel`（宿主级缺省，`engine-query.ts:192-207` 拼全 ref `provider/model`）+ `enabledModels` 白名单（`provider/model` 串数组；空 = 全启用，非空 = 仅白名单内启用，判定 = `deriveEnabled`，`pi-provider-store.ts:519/527`）。
- **api 枚举（node_modules 实装 `@earendil-works/pi-ai` dist/types.d.ts:15 KnownApi）**：`openai-completions | openai-responses | mistral-conversations | azure-openai-responses | openai-codex-responses | anthropic-messages | bedrock-converse-stream | google-generative-ai | google-vertex | pi-messages`。

### ② zcode 侧配置文件字段形态（本机真实文件只读参照）

- **`~/.zcode/v2/provider_config.json`**（个人 provider 单源，引擎显式模型校验源 + CLI 缺省解析的 providerOrder 来源）：
  - `schemaVersion: 1`；
  - `config.providerOrder: string[]`（providerId 序，CLI 缺省解析取首位可用 provider 的可用模型）；
  - `config.providerConfigRules.providerRules[]`：`{ providerId, providerName, config: { group: "standard-personal", access: { type: "api-key", apiKey }, api: { type, baseUrl }, personalModelIds: string[], modelOrder: string[] } }`；实测 `api.type` 仅见 `openai-chat-completions` 与 `anthropic-messages` 两值【推断标注：完整值域未从 zcode 官方 schema 核实（外部应用无源码），以本机样本 + 既有 wrapper 注释为准】；
  - `config.modelConfigRules.providerModelRules[]`：`{ providerId, modelId, config: { enabled?, properties: { contextWindow?, inputFormat?, supportsJsonSchemaOutput? } } }`；`manualProviderModelRules: []`。
- **`~/.zcode/v2/config.json`**（GUI 凭据权威源）：`provider` 字典 `{ <id>: { name, kind: "anthropic"|"openai-compatible", options: { apiKey, baseURL }, enabled, source: "custom", models: { <modelId>: { reasoning, limit, modalities } }, systemDisabledReason? } }` + `model.main`。内含 built-in/account 家族（`builtin:bigmodel-coding-plan` / `builtin:bigmodel-start-plan` / `builtin:zai-coding-plan` / `builtin:zai-start-plan` / `builtin:bigmodel` / `builtin:zai`，plan 家族经 entitlement 门控）。
- **`~/.zcode/cli/config.json`**（CLI 形态 app-server 实际读取的用户 config）：`model.main / plugins / mcp / subagents / provider` 字典（provider 条目形态同 v2）。

### ③ 既有 v2 注入链（凭据供数）

- **wrapper 源**：`packages/zcode-subagent-cli/src/appserver-launcher.ts:55-286`（内嵌字符串落盘 `engineDataDir/engines/zcode/appserver-launcher.cjs`）。关键锚：`ZCODE_ENG_CLI_PATH`（必填）、`ZCODE_ENG_V2_CONFIG`（缺省 `~/.zcode/v2/config.json`，:62）、`ZCODE_ENG_PROVIDER_CONFIG`（缺省 `~/.zcode/v2/provider_config.json`，:63）。
- **合并逻辑** `injectedConfigText()`（:79-160）：对 `~/.zcode/cli/config.json` 读取做 fs 拦截（readFileSync/readFile/existsSync，:167-206），返回「真实 cli config + v2 provider 字典注入（同 id 时 v2 整条优先，v2 是权威凭据源）+ provider_config 补注入 + model.main 缺失透传」的内存合并结果。provider_config 补注入段（:101-151）为「仅存在于 providerRules 的个人 provider（v2 字典未物化）」合成 cli-config 条目：须 `access.apiKey` 非空 + `api.baseUrl` 非空，`kind: 'openai-compatible'`，models 由 modelOrder ∪ modelRules 合成（`enabled:false` 模型跳过）。
- **引擎侧接线**：`packages/zcode-subagent-cli/src/zcode-engine.ts:641-649`（`ensureAppServerRuntime` 设置三个 env，`sources ?? default`）；生产 deps.sources 恒 undefined（`registration.ts:48-59` 不传 sources）→ 全走 default 路径。
- **校验链**：`packages/zcode-subagent-cli/src/preparer.ts:149-163`（`ZcodeSourcePaths` + 两个 default 路径函数）；`resolveZcodeModelRef`（:312-370）对「带 apiKey 的个人 provider 注册表」校验（provider 不存在 → `model_not_available`；无 apiKey → `engine_credential_missing`）；`listZcodeModels`（:374-392）同判据聚合清单。
- **create 帧消费**：`zcode-engine.ts:313-319`（run prepare 期：`task.model` trim 非空才走 `resolveZcodeModelRef`，缺席 = undefined）；`buildAppServerCreateParams`（:1337-1361，modelRef 缺省不设 model 键——zcode CLI 自身缺省解析，无内嵌缺省模型字符串）；`validateModel`（:893-895）委托 preparer。

### ④ engine-manifest modelCatalog 三态

`packages/subagent-core/src/execution/engine/engine-manifest.ts:192-225`（`parseModelCatalog`）：缺省 → `undefined`（不注入——「无模型清单」形态可达，源码注释原词「无枚举面」）；`null` → `null`（合法等价省略）；对象 → `{ dynamic: 缺省 true, models: [{ id, aliases?, canonicalRef? }] }`。现状：pi 与 zcode 两引擎 manifest 均声明 `{ dynamic: true, models: [] }`（各自 package.json `taiji.subagentEngine`）——动态清单、无静态条目。

### settings / 派发消费链现状

- settings 页仅「默认引擎」单选：`packages/renderer/src/components/settings/agent/SubagentEngineSection.vue`；RPC `session.getSubagentEngineConfig` / `session.setSubagentDefaultEngine`（`packages/shared/src/protocol.ts:141`，reply 形态 `{ engines: string[]; defaultEngine: string }` :2264-2265）。
- 配置 SSOT：`<dataDir>/agent/subagents/config.json`（读 `packages/runtime/src/services/session/session-records.ts:1081-1122`，engines.json 动态清单 + defaultEngine；写 `:1124-1153`，`withFileLockSync` 原子 RMW）；subagent-core 侧同路径（`packages/subagent-core/src/execution/assembly/config.ts:48-53`）。
- 派发模型解析（非 pi 引擎）：`packages/subagent-core/src/execution/service/run-orchestration.ts:534-553`——`engineModel = opts.model ?? agentConfig?.model`（调用参数 > agent frontmatter），缺席交引擎自身缺省；pi 路由 `engineModel = undefined`（pi 链自有三层解析：ctx 继承 > pi settings 缺省）。

## 方案

### 决策总览（一句话）

taiji runtime 启动时把 pi provider 配置映射成一份 zcode `provider_config.json` 形态的**合并副本**（真实 zcode 文件条目透传 + pi 映射条目追加）落 taiji 数据目录，zcode 引擎把「个人 provider 校验源」锚（`ZCODE_ENG_PROVIDER_CONFIG`，校验链与 wrapper 补注入链共用）重定向到该副本——两个消费方（引擎校验链、wrapper 补注入链）零改动即同时看到 pi 映射条目；settings 默认模型写入同一 `subagents/config.json` 配置域，派发层在 `opts.model ?? agentConfig.model` 之后插一层用户偏好。

### 一、pi → zcode 同步映射

#### 触发点与时机

- **执行者**：taiji runtime 进程（pi 配置的三个读取源——models.json / auth.json / catalog 合并视图——全部只在 runtime 侧可达，`pi-provider-store` / `provider-catalog` / 凭据 resolver 均为 runtime 资产）。
- **时机**：runtime 组合根启动段（`packages/runtime/src/index.ts`，`sanitizeInvalidProviders` 之后——同为「启动时一次性配置自愈」先例位）。「每次启动」= 每次 taiji runtime 进程启动（Electron 主进程拉起 runtime；dev 即每次 `pnpm dev`）。zcode 引擎进程是后来者（惰性 spawn），落盘文件是共享介质：无论派发来自 runtime 进程还是 pi 会话内 extension 进程（`TAIJI_AGENT_DATA_DIR` 两形态均携带，引擎侧 `resolveEngineDataDir` 同源推导），读到的都是同一份副本。
- **产物路径**：`<dataDir>/engines/zcode/pi-synced-provider-config.json`（与 session-db / launcher 落盘同域，`engineDataDir/engines/zcode/` 布局先例 `appserver-launcher.ts:47-48`）。

#### 映射规则（字段级对照）

**哪些 pi provider 参与映射**：models.json 全部 provider ∪ auth.json 有凭据的 catalog provider，逐条判定：

| 判定 | 结果 |
|------|------|
| 凭据可得（models.json 内联 `apiKey` 非空，或 auth.json `key` 非空） | 继续映射 |
| `enabled: false`（provider 级）或 `deriveEnabled(pid, enabledModels) === false`（白名单禁用） | 整条跳过 |
| `baseUrl` 不可得（provider 级 → 首模型级 → catalog 三链全空） | 跳过 + warn（残缺条目比不注入更糟——同 wrapper 补注入纪律，`appserver-launcher.ts` :123-126） |
| `api` 无 zcode 对应协议（见下表） | 跳过 + warn |
| providerId 与 zcode 真实 `provider_config.json` 既有条目（providerRules 或 providerOrder 成员）同名 | zcode 侧保留、pi 映射让位（引擎本机配置优先）+ 日志登记 |

**api 协议映射**：

| pi api（KnownApi） | zcode `api.type` | 依据 |
|-------------------|------------------|------|
| `openai-completions` | `openai-chat-completions` | 同一协议族（OpenAI Chat Completions），两侧命名不同 |
| `anthropic-messages` | `anthropic-messages` | 同名直传 |
| 其余（`openai-responses` / `mistral-conversations` / `azure-openai-responses` / `openai-codex-responses` / `bedrock-converse-stream` / `google-generative-ai` / `google-vertex` / `pi-messages`） | 无对应 | zcode 个人 provider 协议面本机实测仅两值（见现状②），不做无把握合成——错配的协议错误在请求期才暴露，不如映射期拒绝并留日志 |

api 取值链：provider 级 `api` → 首模型 `api` → catalog 声明。

**字段转换表（pi 条目 → zcode providerRule）**：

| pi 字段 | zcode 字段 | 转换 |
|---------|-----------|------|
| providerId（models.json 键 / catalog id） | `providerId` | 直传（如 `zai-coding-cn`、`StepFun`；与 zcode built-in `builtin:*` 前缀体系天然不撞名） |
| `name` | `providerName` | 直传，缺失回退 providerId |
| 内联 `apiKey` 或 auth.json `key` | `config.access.apiKey` | 二源取非空者；`access.type` 固定 `"api-key"` |
| `baseUrl`（三链取值） | `config.api.baseUrl` | 直传 |
| `api`（映射表） | `config.api.type` | 见上表 |
| —— | `config.group` | 固定 `"standard-personal"` |
| 模型清单 = models.json override ∪ catalog 合并视图（`getMergedCatalogModels` 同源），过滤 `enabledModels` 白名单与模型级 `enabled:false` | `personalModelIds` + `modelOrder` | 两侧同清单同序（pi 声明序：override 先、catalog 后） |
| 模型 `contextWindow` | `modelConfigRules.providerModelRules[].config.properties.contextWindow` | 数值直传（无值不写该条 rule） |
| 模型 `reasoning` / `input` / `thinkingLevelMap` / `headers` / `cost` / `compat` | —— | **丢弃**（zcode 个人 provider 侧只消费 contextWindow，wrapper 合成同口径 `appserver-launcher.ts:130-137`） |
| `authMethod` / `quota` / `modelOverrides` / `authHeader` / provider `headers` | —— | **丢弃**（pi 私有/寄生字段，zcode 无对应消费点） |

**合并副本结构**（完整 `provider_config.json` 形态）：`config.providerOrder` = zcode 真实文件 providerOrder 透传 + pi 映射 id 追加（zcode 本机配置优先于 pi 映射——用户在 ZCode 端的既有排序不被外部同步改写；显式默认模型由 settings 偏好层承接，不依赖 providerOrder 先后）；`providerRules` = 真实条目透传 + 映射条目；`providerModelRules` / `manualProviderModelRules` 同法透传 + 追加。真实文件缺失/损坏 → 副本退化为仅 pi 映射条目（zcode 侧本来也无从消费，无损失）。

**built-in/account 家族处理（「用户提前配置好」的前提落点）**：zcode 的 `builtin:*` / `account:*` provider 家族（zhipu/zai 系账号认证体系）**不经同步**——它们由 ZCode 桌面端登录/配置产生（`~/.zcode/v2/config.json` + entitlement 门控），taiji 不读不写不映射。前提落在用户侧的一次性动作：在 ZCode 桌面端完成登录/内建 provider 配置。pi 侧若也配了 zhipu 个人 key（如 catalog `zai-coding-cn`），映射产物与 zcode 内建家族并存不冲突（不同 endpoint：coding paas 网关 vs anthropic 网关，id 不同域）。

#### 幂等与失败语义

- **幂等**：映射是 pi 配置的纯函数；落盘前内容比对，同字节跳写；写 = tmp + rename 原子替换（`atomicWrite` 先例）。重复启动、并行 dev 实例（各写各的 dataDir）均安全。
- **失败语义（同步失败不阻断引擎启动）**：pi 侧读取失败 / zcode 真实文件读取失败 → 副本不落盘（保留上次产物）+ warn 日志；引擎侧副本缺失 → 校验源回落真实 `~/.zcode/v2/provider_config.json`（与现状行为一致）。辅助功能降级纪律：provider 同步是可用性增强，不是引擎启动前置条件。
- **会话内变更边界**：pi 配置在 runtime 存活期内变更（settings 页增删 provider）不会自动重同步——下次启动生效。扩展点：provider CRUD 服务层（`upsertProvider`/`removeProvider` 的调用方）追加一次同步调用即可覆盖，本期不做（登记为实现要点可选项）。

#### 与既有 v2 注入链的关系（选型理由）

**扩展同一锚，不并行新链**。既有链的消费方有两个——引擎校验链（preparer 读 `sources.personalProviderConfigPath ?? defaultPersonalProviderConfigPath()`）与 wrapper 补注入链（读 `ZCODE_ENG_PROVIDER_CONFIG` env）——二者本就同锚（`zcode-engine.ts:649` 显式对齐「引擎侧模型校验源同锚」）。方案把合并副本接到这一锚上：引擎装配处（zcode-engine.ts 与 preparer 的 default 解析链）改为「副本存在 → 用副本，缺失 → 回落真实文件」。理由：

- 校验链与凭据注入链两个消费方**零逻辑改动**即同时看到 pi 映射条目（wrapper 的补注入段天然把 providerRules 里带 apiKey+baseUrl 的条目合成为 app-server 注册表条目）；
- 不新增 env 键、不加第二注入通道——单数据源；
- 备选否决记录：**(a) 直写 `~/.zcode/v2/provider_config.json` 真同步**——taiji 写外部应用管理面文件，与 ZCode GUI 互为多写方（last-write-wins 互踩、回滚语义缺失），违数据目录隔离纪律；**(b) 新增独立 env 键把 pi providers 直传 wrapper 特殊处理**——wrapper 与引擎校验链各加一套第二源合并逻辑，双源双写。两者都不取。

### 二、settings 页 per-engine 默认模型与消费链

#### 配置域与持久化

- 归并进 `<dataDir>/agent/subagents/config.json`（与 `defaultEngine` 同文件、同锁、同 RPC 通道）：新增键 `engineDefaults: Record<engineId, string>`（值 = 模型全 ref，zcode 形态 `providerId/modelId`）。
- 写入：新 RPC `session.setSubagentEngineDefaultModel`，handler 复用 `setSubagentDefaultEngine` 的 `withFileLockSync` 原子 RMW 形态（`session-records.ts:1124-1153` 同款）；写入前校验 ref ∈ 该引擎模型清单。

#### settings 页形态

`SubagentEngineSection.vue` 扩展（同卡片归并）：

- 「默认引擎」单选保留不动；
- 新增 per-engine 默认模型行，**只对能提供模型清单的引擎渲染**：
  - **zcode**：Select 列出合并副本派生的模型清单（`providerName · modelId` 显示，value = `providerId/modelId`；清单派生规则与 `listZcodeModels` 同判据——带 apiKey 的 provider × 其模型序）。数据来源 = `session.subagentEngineConfig` reply 扩展字段（runtime 直接读同步副本派生，不 spawn 引擎进程）。
  - **pi**：不渲染配置行，显示说明文案——pi 引擎模型由 pi 自身解析（继承主会话模型 > pi 自身缺省），taiji 级偏好层无意义（零配置叙事，2026-09-27 裁决沿用）。
  - **未来引擎**：manifest `modelCatalog.dynamic:false` 时列静态 models；`dynamic:true` 且宿主侧不提供清单 → 同 pi 形态显示「由引擎自身解析」。

#### 消费链（优先级落点）

派发层单点注入：`packages/subagent-core/src/execution/service/run-orchestration.ts:544` 的解析式扩为

```
engineModel = isPiRoute ? undefined : (opts.model ?? agentConfig?.model ?? engineDefaults[route.engineId])
```

即四层：**task 显式指定（`opts.model`）> agent frontmatter 声明（`agentConfig.model`，作者显式声明不被用户全局偏好压掉——既有层保持）> settings 用户偏好（新层）> 引擎缺省（create 帧省略 model 键，zcode CLI 自解析）**。pi 路由恒 `undefined` 不插层。zcode 引擎侧零改动：显式 model 走既有校验（`resolveZcodeModelRef` 对合并副本校验——同步保证 settings 偏好值必在副本内有效）+ create 帧 per-session model 注入（`buildAppServerCreateParams`）。

`workflow-dispatch.ts` 的 `globalDefaultEngine` 同源消费点（:442）核对同步补 `engineDefaults` 透传。

### 三、改动文件清单与实施步骤

| # | 文件 | 改动 |
|---|------|------|
| 1 | `packages/runtime/src/services/zcode-provider-sync.ts`（新增） | 映射纯函数（pi 三源 → providerRule）+ 合并副本编排（读真实文件透传 + 追加映射 + 原子落盘 + 模型清单派生）；复用 `readModels` / `getMergedCatalogModels` / `getEnabledModels` / 凭据 resolver |
| 2 | `packages/runtime/src/index.ts` | 组合根启动段调用同步（`sanitizeInvalidProviders` 之后） |
| 3 | `packages/zcode-subagent-cli/src/preparer.ts` | `defaultPersonalProviderConfigPath()` 解析链扩为：`<engineDataDir>/engines/zcode/pi-synced-provider-config.json` 存在 → 用之，缺失 → `~/.zcode/v2/provider_config.json`（`resolveEngineDataDir` 同源推导，不新增 env） |
| 4 | `packages/zcode-subagent-cli/src/zcode-engine.ts` | `ensureAppServerRuntime` 的 `ZCODE_ENG_PROVIDER_CONFIG` 赋值（:649）走 #3 同一解析函数（校验源与 wrapper 补注入源继续同锚） |
| 5 | `packages/subagent-core/src/execution/assembly/config.ts` | `engineDefaults` 键 sanitize/读取（`sanitizeDefaultEngine` 先例 :139-155） |
| 6 | `packages/subagent-core/src/execution/service/run-orchestration.ts`（+ `workflow-dispatch.ts` 核对） | model 解析链插 `engineDefaults` 层（:544） |
| 7 | `packages/runtime/src/services/session/session-records.ts` | `getSubagentEngineConfig` reply 扩展（`engineModels` 清单派生 + `engineDefaults`）；新 `setSubagentEngineDefaultModel`（同锁 RMW） |
| 8 | `packages/shared/src/protocol.ts` | 新 RPC 类型 + reply 形态扩展 |
| 9 | `packages/renderer/src/components/settings/agent/SubagentEngineSection.vue` + locale 两文件 | per-engine 默认模型行（zcode Select / pi 说明文案） |
| 10 | 测试 | 映射纯函数字段级对照断言（含丢弃字段、跳过分支、api 映射表）；合并副本幂等；config sanitize；派发四层优先级；RPC handler |

实施顺序：#1-4（同步链，可独立验收：zcode 引擎显式模型 + 缺省解析吃到 pi provider）→ #5-9（配置域与 UI）→ #10 随步。可选项（后续）：provider CRUD 后触发重同步。

### 四、风险与边界登记

- **zcode 侧 schema 漂移**：zcode 升级若改 `provider_config.json` 结构，映射产物失效。失败信号显式（引擎校验 `model_not_available` / 注册表缺条目报错，不静默坏）——与既有漂移面①（`appserver-launcher.ts:21-23`）同级姿态，登记为 wrapper 漂移面③。
- **api 协议值域是推断**：zcode `api.type` 完整值域未从官方 schema 核实（现状②推断标注）；若 zcode 实际支持更多协议，映射表可扩，不影响结构。
- **OAuth 形态 provider**：pi 的 OAuth 凭据（auth.json type 非 api-key 形态）不可映射为 zcode api-key 条目——映射期按「凭据形态不可转」跳过 + warn。
- **多写方**：合并副本唯一写方 = runtime 同步模块；`subagents/config.json` 既有跨进程锁形态沿用（`engineDefaults` 进同一锁域）。

## 新发现登记（2026-10-11 核实，待裁决）

**pi 引擎的 provider 配置目录与 taiji 主会话不同源**。env 链核实：`ENV_WHITELIST_PREFIXES` 不含 `PI_` 前缀（`packages/shared/src/constants.ts:74-85`），Electron 主进程 spawn runtime 不注入 `PI_CODING_AGENT_DIR`（`apps/electron/main/supervisor/process-control.ts:423-430`、`safe-env.ts`）；runtime 派发 pi 引擎时 EngineClient 构造不带 `baseEnv/identityEnv`（`engine-inspect-package.ts:197-210`，基座 = `{...process.env}`）→ pi 引擎 CLI 及其孙 pi 进程按 `resolvePiAgentDir` 缺省回落 **`~/.pi/agent`**（`engine-query.ts:50-54`），而 taiji 主会话 provider 配置在 `<dataDir>/agent/`（`pi-paths.ts:63-69`）。两者不是同一份配置（本机实测内容亦不同）。影响：用户在 taiji settings 配的 provider 对 pi 引擎派发不生效，pi 引擎用的是独立 pi 的配置。本期方案不处理（zcode 同步源取 taiji 数据目录侧，与 taiji 管理面一致）；完整收敛「provider 来源统一」需后续裁决是否给 pi 引擎注入 `PI_CODING_AGENT_DIR=<dataDir>/agent`（pi 会话内 extension 派发形态本就携带该 env，两形态当前行为不一致）。另注：pi 引擎内部对 env 的注释假设（`engine-query.ts:45-48`「taiji 托管形态下宿主注入的托管目录」）在 runtime 派发形态下不成立。

## 实现要点（届时从这起步）

- 同步模块（#1）先写映射纯函数 + 字段级对照单测（本登记「映射规则」两表即断言清单），再接组合根。
- 引擎侧改动（#3/#4）保持「副本存在 → 用副本」单点判定，禁止在 wrapper 内加第二套合并逻辑。
- settings 消费链（#6）注意 `stampEngineOnRecordOpts` 的 model 覆写同步（frontmatter 透传语义不变，偏好层仅补缺席）。
- 旧「实现要点」中「wrapper 内嵌字符串消双源」一条已过时删除（`ZCODE_FALLBACK_DEFAULT_MODEL` 常量已随 account 体系迁移删除，create 帧缺席不设键已是现行行为）。
