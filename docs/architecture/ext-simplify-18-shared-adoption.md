# ext-simplify-18：shared 采用批兑现（17 号长期议题 + 包内收敛）

> 状态：v2 双审查通过（20260914，双 PASS 0 must-fix）。审查轨迹：双审 r1——主审 PASS（0 MF + 7 S + 4 INFO，方案/清单/等价论证经独立复扫全部成立）、影响面 NEEDS-FIX（2 MF + 2 S，均 D6 守卫面：触发面不含 model-ref.ts 且 CI 不跑守卫；extractConstListMembers 正则要求类型标注而 THINKING_ORDER 无标注实装失配）。v2 全修：D6 补触发面扩面 + 提取正则适配决策（MF-1/2，适配正则经三真实源文件实测验证，`\s*=` 吸收无标注形态空格）、§2.2 消费点清单补全至实测全量（S1）、cache-probe:73 论据改锚 pi-ai 实装构造点（S3）、system-prompt-trace 改直接删导出（S6，taiji 组非独立发布，re-export 论据不成立；影响面复审复核成立——mandatory-extensions.json 实证 + 包外零 import）、V1 grep 词边界 / V2b model-picker 钉值 / V4 测试路径 / V6 人工清单 / V8 真机化（S2/S4/S5/S7 + INFO 全收）、负面清单补 relay.mjs、§6 债务清账登记义务（影响面 S-2）。r2 影响面定向复审：MF-1/MF-2/S-1/S-2 全闭合，PASS。
> 来源：①17 号实施终态登记的长期采用议题（isRecord 其余副本、toErrorMessage 全域采用批的 extensions 部分、THINKING_ORDER 纳入词表守卫议题，见 `docs/todo/ext-simplify/ext-simplify-index.md` 17 号行债务清账段）；②20260914 全仓两层重复检测（jscpd 197 克隆聚合 + 三域 subagent 语义扫描，全部候选经主 agent grep/实读二次核实）。本批全部为 17 号已裁决框架内的**纯采用与包内收敛**：ext-guards 零改动、extension-protocol 零改动，唯一共享层新增导出在 llm-shared。
> 用户裁决（20260914）：参考 17 号框架延续，直接走 tech-design 审查 → dev-flow。

## 1. 背景与目标

17 号把「新增导出 + 首批消费方迁移」做完了，但明确把**其余手写副本**登记为长期采用议题（文档 §3.1 D1/D3 + index 债务清账段）。本批兑现这些登记项：ext-guards 既有导出（`toErrorMessage` / `isRecord` / `isEnoentError`）的残余手写副本全量采用 + llm-shared `parseRef` 导出化 + session-reader 包内 SessionHeader 三副本单源 + 词表守卫比对面补第三副本。

目标：extensions 生产代码中上述四族手写副本清零（V1 可证伪），全程行为等价（1 处病态输入微变显式登记，见 D4）。

**非目标**：

- packages/ 层副本（runtime/core/main/subagent-core 的 toErrorMessage/isRecord/isPlainObject 等）——17 号 D3 分层裁决维持（protocol 禁依赖 ext-guards 的反向分层边同理适用于全部 packages 侧）；全仓 packages 侧收敛牵涉 shared/Node 归宿架构决策，独立立项。
- extension-protocol 发布层拆分（9 包私有依赖阻塞 universal 独立发布）、`getSessionsDir()/encodeCwdSlug` 路径推导归宿、extension-logger `rawStderr` 通道——三项为全仓 scan 识别的更大工程，各自独立 tech-design。
- 17 号 D4 ③④ subagent-core 既有债务（record-access 孤儿防线失效 / identity entry 恒不写）——维持另行裁决。

## 2. 现状与证据（全部 20260914 本分支实测）

### 2.1 toErrorMessage 手写残余（extensions 生产代码 26 处 / 11 文件）

`rg "instanceof Error \?" extensions -g '!*.test.ts' -g '!extensions/shared/**'` 实测：

| 包 | 处数 | 位点 |
|---|---|---|
| permission | 7 | config.ts:122 / index.ts:344 / pipeline.ts:225 / ast/analyzer.ts:248 / ast/loader.ts:124 / classifier/classifier.ts:93,232 |
| session-reader | 5 | tool-handler.ts:421,800,815,1007,1212 |
| cache-probe | 5 | index.ts:63,66,68,91,96 |
| structured-output | 3 | loop-gate.ts:487 / workflow-hook.ts:98,113 |
| smart-context | 2 | llm.ts:130 / compact-handler.ts:322 |
| subagent-workflow | 2 | injectors/model-list-injector.ts:90 / host/inflight-reporter.ts:205 |
| ask-user | 1 | index.ts:310 |
| cw-tool | 1 | cw-runner.ts:190 |

26 处中 25 处为逐字同构 `x instanceof Error ? x.message : String(x)`；cache-probe index.ts:66 外层形态 `String(err instanceof Error ? err.message : err)`——内层三元产出 `string | unknown`，非 Error 时 `String(err)`，与 `toErrorMessage` 逐语义等价（同属 25 处）。**排除**：taiji/system-prompt index.ts:250（`${err.name}: ${err.message}` 含 name 前缀，非同构，负面清单）；subagent-workflow bench ×2（`err.stack` 形态 + bench 测试基建非生产）。

依赖现状（package.json `@zhushanwen/pi-ext-guards`）：permission / structured-output / smart-context / subagent-workflow / rename-session / bte / plan / scheduler / plugin-bridge 已有（9 包）；**session-reader / cache-probe / cw-tool / ask-user 四包需新增依赖 + 根 `extension-dependencies.json` 登记**（该 4 包 json 内亦无 ext-guards 条目，已实测）。注：`check-extension-dependencies.mjs` 不校验 package.json dependencies 与 dependsOn 条目的一致性（现状已知盲区，非本批引入）——V6 人工双核对。

### 2.2 isRecord / isPlainObject 副本残余（extensions 8 处，两语义派）

17 号 D3 canonical = ext-guards 排数组严版。残余实测：

| 位点 | 语义 | export 面 |
|---|---|---|
| permission config.ts:53 isPlainObject | 严版（含 `!Array.isArray`） | 私有 |
| bte config.ts:55 isPlainObject | 严版 | 私有 |
| structured-output schema-guards.ts:38 isPlainObject | 严版 | **exported**，包内消费 **10 处位点 / 11 次调用**（schema-guards.ts:82 / tool-definition.ts:96 / execute.ts:50,74,91×2,101,116 / loop-gate.ts:251,254,286；:91 行内双调用）；包内 import 全走 `./schema-guards.js` 深路径（src/index.ts barrel 不 re-export 该名）；包外零消费者 |
| system-prompt-trace types.ts:50 isRecord | **允数组版** | **exported**，包内消费 2 处（baseline.ts:30 / types.ts:56）；包外零 import（rg 证实） |
| cache-probe fingerprint.ts:44 isRecord | 允数组版 | 私有，消费 5 处（:69,73,78,87,117） |
| session-reader core/workflow.ts:17 isRecord | 允数组版 | 私有，消费 12 处（:128-130,150-152,183-185,197,216,238） |
| smart-context tool.ts:70 isRecord | 允数组版 | 私有，消费 3 处（:76-78） |
| smart-context pure.ts:260 isRecord | 允数组版 | 私有，消费 4 处（:272,277,281,282） |

排除：bte spawn-background.ts:283（`isRecordedPidStillOriginal` 前缀撞名，17 号 r1 已核正）；session-reader discovery/subagents.ts:435 `isRecordManifest`（manifest 形状守卫非泛用副本，17 号 r2 已裁定）。

### 2.3 isEnoentError 手写残余（2 包 3 处）

- cw-tool cw-spawn.ts:125,126：`err.code === "ENOENT"` ×2（`child.on("error", (err: NodeJS.ErrnoException))` 回调内，拼 cwd/hint 进错误消息）。
- rename-session pure.ts:114-115：`const code = (e as NodeJS.ErrnoException).code; if (code !== "ENOENT") throw e`（rmSync 吞 ENOENT 模式；顺带消除一处 `as` 断言，taste/no-unsafe-cast 正向）。

ext-guards 严版（instanceof Error + `'code' in err` + `===`）对两处等价性：Node fs/spawn 错误回调契约恒 Error 子类，宽版对「非 Error 带 code 对象」的接受是防御冗余——与 17 号 D2 对 subagent-workflow 宽版收严同一论证。

### 2.4 llm-shared parseRef 私有 vs permission 手拆

llm-shared resolve.ts:70 `parseRef(ref)`（私有）：`indexOf("/")` 首斜杠拆分，缺 `/` 或前后为空返 `null`。permission model-picker.ts 两处手拆同域逻辑：

- computeProviderSelectedIndex（:186-192）：`slashIdx = indexOf("/"); if (slashIdx <= 0) return 0; provider = slice(0, slashIdx)`。
- computeModelSelectedIndex（:230-236）：同骨架，取 `slice(slashIdx + 1)` 为 modelId。

### 2.5 session-reader SessionHeader 读取三副本（包内）

- discovery/subagents.ts:259-303：`HEADER_READ_BYTES=8192` + async `readFirstLine`（FileHandle 定长一次 read）+ `interface SessionHeader {id, cwd?, parentSession?}` + `parseHeaderLine`。
- discovery/find.ts:84-182：同 8KB 常量 + 同 async `readFirstLine`（**与 subagents 版仅局部变量名不同**：text/content、o/obj、h/header）+ 第二个同名 `interface SessionHeader` + `parseHeader`（解析逻辑逐语义相同）。
- tool-handler.ts:188-231：`HEADER_READ_BYTES=4096` + **sync**（readSync）`readSessionHeaderId` 只取 id（头注释自认"parseHeader 同构"）。

04 号 session-reader 设计（find 三次全量扫盘等）未覆盖此项；17 号范围亦未含 session-reader 包。

### 2.6 THINKING_ORDER 不在词表守卫比对面

`scripts/check-thinking-levels.mjs`（C-build-10）现比对面 = pi-ai ↔ llm-shared（T1）↔ pi-rpc（T2）；subagent-core `model-ref.ts:48` `THINKING_ORDER` 数组注释自认「本数组不在比对面，靠本注释提示」——17 号 index 登记的「词表守卫 THINKING_ORDER 第三副本纳入议题」。**两个前置事实（r1 影响面 MF-2 核正）**：①守卫执行点仅 pre-commit（`.githooks/install-hooks.sh:1317` 路径触发正则：llm-shared resolve.ts / pi-rpc types.ts / 守卫脚本 / pnpm-lock.yaml 四项，CI 零引用）——「只改 model-ref.ts」场景下守卫不执行；②`extractConstListMembers` 提取正则要求 `const NAME:` 带类型标注，THINKING_ORDER 实装 `export const THINKING_ORDER = [...] as const` **无标注**——现状正则失配，接入前必须适配（决策见 §3.4 D6）。

## 3. 方案

### 3.1 桶 1 · ext-guards 既有导出采用批（ext-guards 零改动）

**D1 `toErrorMessage` 采用批**（零行为变化）。§2.1 全部 26 处机械替换为 `import { toErrorMessage } from "@zhushanwen/pi-ext-guards"`；session-reader / cache-probe / cw-tool / ask-user 四包 package.json 新增依赖（workspace:*）+ 根 `extension-dependencies.json` 各登记一条（17 号 bte 先例）；structured-output loop-gate.ts:44 已 import 者仅补一处（:487）；全仓 26 处所在文件各自 import。

**D2 `isRecord`（及 isPlainObject 归并）采用批**。8 处副本全量迁移至 ext-guards `isRecord`：

- 严版 3 处（permission/bte/structured-output）：函数体逐字等价，零语义争议直接替换。structured-output 侧迁移策略：包内三消费文件（tool-definition.ts / execute.ts / loop-gate.ts）import 源从 `./schema-guards.js` 改为 ext-guards `isRecord`（消除包内对 deprecated 别名的依赖），`schema-guards.ts` 本地定义删除、**降级为 re-export ext-guards `isRecord` 保留 `isPlainObject` 导出名**（structured-output 独立发布给外部 pi 用户，package.json 无 exports 字段、files 含 src/ → 深路径对外可达，公开名删除是 breaking；re-export 上注明 deprecated 别名）。
- 允数组版 5 处（system-prompt-trace / cache-probe / session-reader / smart-context ×2）：迁移到严版，逐消费点等价论证（D3 方法论，全量消费点见 §2.2 表）：
  - **system-prompt-trace**：baseline.ts:30 `if (!isRecord(parsed)) return null`——数组输入旧路径被紧随的类型分发（:31 `type !== "custom"` 判定，数组无合法 type 字段）拦回 `null`；types.ts:56 `isSystemPromptTraceEntryData` 内字段检查（version/hash/reason 逐 `typeof` 判定）对数组恒 false——两消费点数组输入两版同归 `null`/`false`。**exported `isRecord` 直接删导出**（r1 裁决修订：taiji 组 = xyz-agent 集成包随应用打包、离开 xyz-agent 无功能，「独立 pi 用户 breaking」论据不成立；包外零 import 已实测；保留 = 制造无人消费的兼容面），包内 2 消费点改 import ext-guards。
  - **cache-probe** fingerprint.ts 5 消费点中 4 处（:69,78,87,117）为「守卫失败/字段读出 undefined → default/null」形态，数组输入两版同归；**:73 `if (isRecord(systemInstruction)) return systemInstruction` 是唯一返回值本体消费点**——等价论证（r1 主审 S3 依 pi-ai 0.84.4 实装重锚）：`BeforeProviderRequestEvent.payload` 类型面是 `unknown`，契约锚定在构造点——pi-ai provider 实装 `systemInstruction: sanitizeSurrogates(context.systemPrompt)` 且 `Context.systemPrompt?: string`（google-generative-ai.js:294 / google-vertex.js:368），即**实装流量中 systemInstruction 恒 string 或缺席，两版 isRecord 对 string 同 false → :73 恒落穿 messages 扫描**，宽严两版真实行为逐流量等价；数组仅在手工伪造 entry 的病态输入下可达，旧行为把数组 hash 进指纹（垃圾当合法）、严版落穿扫描同产垃圾指纹，本批不保真病态输入。
  - **session-reader** core/workflow.ts 12 消费点全部为 `if (!isRecord) return default` 或 `isRecord(x) ? x : default` 形态，数组输入旧路径经字段读 undefined → 嵌套 isRecord(undefined)=false → default，与严版立即 default 同归（r1 主审独立复扫确认隐藏前提成立：normalizeCallStatus 对缺字段返 'pending'（workflow.ts:111-114）、mapBudget 纯字段读（:99-107）、:238 pickSessionRefs 数组路径经 :247 双条件判非 OLD 同归 null）。
  - **smart-context** tool.ts 3 处（`isRecord(x) ? x : {}` / null 链）与 pure.ts 4 处（`continue` / `&&` 前置守卫）同上形态，同归。
  smart-context pure.ts/tool.ts 与 system-prompt-trace 的消费语义与 17 号 D4② 已收敛的 smart-context 单键版无耦合，独立迁移。
- **package.json/登记**：session-reader / cache-probe / cw-tool / ask-user 四包依赖随 D1 新增；**system-prompt-trace 无 toErrorMessage 迁移点（§2.1 变体排除后为 0 处），其 ext-guards 依赖由 D2 引入**（第 5 包）——两批合计 5 包新增依赖 + 根 `extension-dependencies.json` 登记；permission/bte/smart-context/structured-output 已有。

**D3 `isEnoentError` 采用批**（零行为变化，§2.3）。cw-tool 两处 `err.code === "ENOENT"` → `isEnoentError(err)`（cw-tool 随 D1 已新增依赖）；rename-session 一处 `(e as NodeJS.ErrnoException).code !== "ENOENT"` → `!isEnoentError(e)`（已有依赖，顺带消 `as` 断言）。

### 3.2 桶 2 · llm-shared 新导出

**D4 `parseModelRef` 导出**（建议新增，minor）。resolve.ts 既有私有 `parseRef` 更名导出为 `parseModelRef(ref: string): { provider: string; modelId: string } | null`（内部调用点同步更名；命名按能力不按来源）。permission model-picker 两处采用：

```ts
const parsed = parseModelRef(this.currentSpec)
if (!parsed) return 0
const provider = parsed.provider // modelId 侧：models.findIndex(m => m.id === parsed.modelId)
```

**行为微变（有意，登记）**：currentSpec 为 `"provider/"`（尾空 modelId）时，旧版 provider 预选命中 `idx+1`、modelId 空串查不到回落 0；新版 `parseModelRef` 返 null → provider 预选也回 Auto。该输入为病态配置（模型 ref 恒 `provider/modelId` 双非空），新版语义更一致（整 ref 无效则整体回 Auto，不预选半截 provider）。独立 commit。

### 3.3 桶 3 · 包内收敛

**D5 session-reader SessionHeader 三副本单源**（零行为变化）。新文件 `src/discovery/session-header.ts`：

- `interface SessionHeader { id: string; cwd?: string; parentSession?: string }`（两 async 版同构接口合一）
- `export const HEADER_READ_BYTES = 8192` + `export async function readSessionHeaderFirstLine(path): Promise<string | undefined>`（subagents/find 两版合一，实现取 subagents 版字面）
- `export function parseSessionHeader(line): SessionHeader | null`（两版解析逻辑逐语义相同，合一）
- `export function readSessionHeaderIdSync(path): string | undefined`（tool-handler sync 4KB 版**原样搬入**——保持 readSync/4KB 窗口/仅取 id 语义，不与 async 版强行统一；其 4KB vs 8KB 窗口差异与 sync 形态是刻意的调用上下文适配，头注释保留说明）

subagents.ts / find.ts 删本地副本改 import（find.ts 的 `parseHeader` 调用点、subagents.ts 的 `parseHeaderLine` 调用点同步改名）；tool-handler.ts 删 `HEADER_READ_BYTES`/`readSessionHeaderId` 改 import。**不进 shared**（跨包第二消费方不存在：runtime 侧首行读取是另一形态——FileHandle 4KB 续读骨架 + 分层禁反向 import；17 号负面清单同口径）。

### 3.4 桶 4 · 机器守卫补强

**D6 THINKING_ORDER 纳入词表守卫比对面**（T3）。四件连带（r1 影响面 2 MF 修复）：

1. **提取适配**：`extractConstListMembers` 正则改类型标注可选——现 `const\s+NAME\s*:[^=]*=` 要求标注，THINKING_ORDER 实装 `export const THINKING_ORDER = [...] as const` 无标注失配；改为 `const\s+NAME(?:\s*:[^=]*)?\s*=\s*(?:new\s+Set\(\s*)?\[`（标注可选；**`\s*=` 吸收无标注形态 `=` 前空格**——起草 v2 期以三真实源文件实测验证：llm-shared Set / pi-rpc 带标注数组 / subagent-core 无标注数组三形态均正确提取七值）。**不选**「给 THINKING_ORDER 加标注」路线：`ThinkingLevel = (typeof THINKING_ORDER)[number]` 依赖 `as const` 字面量联合推导，加 `readonly string[]` 类标注会破坏推导（影响面 MF-2 已注明该坑）。self-test 补第三形态用例（无标注数组）。
2. **触发面扩面**：`.githooks/install-hooks.sh:1317` 触发正则补 `^packages/subagent-core/src/shared/model-ref\.ts$`；hook 头注释（:1310 触发面清单）与 constraints.json C-build-10 summary 触发面描述同批同步。CI 不跑该守卫为现状（pre-commit 唯一执行点），扩面后盲场景收敛为「绕过 hook 提交」，登记不改。
3. **比对面**：提取 THINKING_ORDER 数组单行成员，**排序后**与 pi-ai 联合成员集合比对（THINKING_ORDER 是低→高有序数组，比对语义是成员集合一致性，顺序语义由 subagent-core 自身测试锚定，守卫不判序）。
4. **注释同步**：model-ref.ts 头注释「本数组不在比对面，靠本注释提示」改为指向 T3；守卫脚本头注释比对面清单补 T3。

## 4. 负面清单（排查过、判定不做——防「为什么没提」复查）

| 项 | 判定 | 理由 |
|---|---|---|
| taiji/system-prompt index.ts:250 `${err.name}: ${err.message}` | 不迁 | 含 name 前缀变体，非 toErrorMessage 同构；迁入即行为变化（丢 name） |
| subagent-workflow bench ×2（err.stack 形态） | 不迁 | bench 测试基建非生产代码；stack 语义不同 |
| subagent-workflow relay/relay.mjs:86（err.stack 形态） | 不迁 | 零依赖镜像常量脚本，头注释明言「不能 Import workspace 包」，结构性不可迁移（r1 主审 INFO 补登；路径经区 A 审查勘误——实际在 relay/ 无 src/host/ 段） |
| bte spawn-background.ts:283 / session-reader isRecordManifest | 不动 | 17 号已裁定（撞名 / 形状守卫），复述防重提 |
| packages/ 层 toErrorMessage/isRecord 副本 | 不动 | 17 号 D3 分层裁决（protocol 同理）；全仓 packages 侧收敛独立立项 |
| extension-protocol 发布层拆分（9 包私有依赖） | 不做 | 架构级工程（可发布面包新增），独立 tech-design |
| getSessionsDir/encodeCwdSlug 路径推导 | 不做 | llm-shared 是 LLM 域包，塞 pi 布局知识破坏域纯度；归宿（新 pi-paths 模块）需独立裁决 |
| extension-logger rawStderr 通道 | 不做 | 前置验证缺失（子进程 fileLog 落盘行为未实测），盲接有静默丢日志风险 |
| structured-output isPlainObject 导出名直接删除 | 降级 re-export | 独立 pi 用户可单独安装，公开导出断裂是 breaking；deprecated 别名保留一个发布周期 |
| session-reader 三副本上提 shared | 不做 | 跨包第二消费方不存在（runtime 侧是另一形态 + 分层禁反向 import） |

## 5. 验收

### 5.1 确定性检查（每条可证伪）

- V1 采用批零残留：`rg -n "instanceof Error \? .*\.message" extensions -g '!*.test.ts' -g '!extensions/shared/**' -g '!**/bench/**'` 命中仅剩 taiji/system-prompt:250 变体 1 处；`rg -n "function isRecord\(|function isPlainObject\(" extensions -g '!*.test.ts' -g '!extensions/shared/**'` 为 0（带词边界括号，规避 isRecordManifest / isRecordedPidStillOriginal 两撞名前缀命中）；`rg -n "=== \"ENOENT\"|!== \"ENOENT\"" extensions -g '!*.test.ts' -g '!extensions/shared/**'` 为 0（注释行除外）。
- V2 llm-shared 钉值：`parseModelRef` 单测（合法 ref / 缺斜杠 / "provider/"（尾空 modelId）/ "/model"（首空 provider）/ "a/b/c"（modelId 含斜杠取首个分隔）五形态断言）。
- V2b permission model-picker 钉值：合法 ref（provider 与 model 双预选命中）行为不变断言 + "provider/" 病态输入新行为（provider 预选回 Auto）钉值（D4 微变的直接验证点）。
- V3 三连绿：`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test`。
- V4 session-reader 单源化回归：discovery 既有测试全绿 + `readSessionHeaderIdSync` 行为不变（src/__tests__/tool-handler.test.ts:1057-1058 既有用例锚定首行非 header 返 undefined）。
- V5 守卫 T3：直接执行 `node scripts/check-thinking-levels.mjs` 绿；手工构造 THINKING_ORDER 漂移（临时删一个成员）直接跑脚本触发非零退出，还原后绿；再验证 hook 触发面——staged 改动含 `packages/subagent-core/src/shared/model-ref.ts` 时 pre-commit 实际拉起守卫（验收时执行并还原不留痕）。
- V6 依赖登记：`node scripts/check-extension-dependencies.mjs` 通过；5 包（session-reader/cache-probe/cw-tool/ask-user/system-prompt-trace）extension-dependencies.json 条目与 package.json dependencies **双人工核对**（守卫不校验两者一致性，已知盲区见 §2.1 注）。

### 5.2 真机验收（按 AGENTS.md 本地 pi CLI 实测规范，抽验不改行为的通路）

- V7 cache-probe 真机：`pi -ne --mode rpc --extension <cache-probe 绝对路径>` 发一 prompt，`XYZ_AGENT_DEBUG=1` 查 `~/.pi/agent/logs/` 扩展日志无异常；probe entry 落盘正常（D1+D2 迁移面的运行时通路）。
- V8 permission 真机：pi CLI 本地实测 `/permission model` 交互（预选与切换行为正常，D4 迁移面运行时通路）；单测钉值部分归 §5.1 V2b。
- V9 session-reader 真机：`read`/`find` 工具各一次调用成功（D5 单源化后的家族读取与首行解析通路）。

### 5.3 三视角

构建者白盒（V2/V2b/V4 单测）+ 使用者黑盒（V7-V9 真机工具调用）+ 观察者形态（V1 零残留 grep + 导出面收敛断言——structured-output 的 `isPlainObject` 在原导出文件 schema-guards.ts 内以 deprecated re-export 保留、本地私有定义删除；system-prompt-trace 的 `isRecord` 导出删除；两包 src/index.ts barrel 从未 re-export 该两名，无 barrel 锚点）。

## 6. 实施拆分（dev-0.9.21 单线，两分支已合流）

| 批次 | 内容 | 性质 |
|------|------|------|
| 批次 1 | D1（26 处 toErrorMessage + 4 包依赖/登记）+ D3（isEnoentError 3 处） | 机械，零行为变化 |
| 批次 2 | D2（isRecord 8 副本 + system-prompt-trace 依赖/登记 + 2 处 exported 降级 re-export） | 机械 + 论证已含本文档 |
| 批次 3 | D4（parseModelRef 导出 + permission 采用，**行为微变独立 commit**）+ D6（守卫 T3 四件连带：提取正则适配 + self-test / hook 触发面扩面 + 头注释 / C-build-10 登记 / model-ref.ts 注释） | 小新增 |
| 批次 4 | D5（session-reader 三副本单源） | 包内收敛 |

**收尾义务**：全部批次完成后更新 `docs/todo/ext-simplify/ext-simplify-index.md` 18 号行债务清账段——登记 re-export 别名（structured-output `isPlainObject`）删除时点与各独立立项尾巴（packages 层收敛 / extension-protocol 发布层拆分 / 路径推导归宿 / rawStderr），对齐 17 号行惯例；清理通道由此可追溯（r1 影响面 S-2）。

**changeset**：llm-shared **minor**（新导出 parseModelRef）；消费包 patch：permission / session-reader / cache-probe / cw-tool / ask-user / structured-output / smart-context / subagent-workflow / rename-session / system-prompt-trace / bte / subagent-core（注释）。ext-guards / extension-protocol 零改动无 changeset。

## 7. 风险与回退

- 全部迁移为等价替换（D4 一处病态输入微变独立 commit），回退 = git revert 对应 commit；无数据迁移、无持久化形态变化。
- 允数组→严版 5 处的等价论证已按 17 号 D3 方法论逐消费点给出（§3.1 D2）；实施时若发现论证外消费点（grep 漏网），该包迁移暂停回本设计补论证，不现场发挥。
- structured-output 导出面：schema-guards.ts 内 deprecated re-export 保持深路径公开名零 breaking，删除时点登记进 index 18 号行债务清账段（§6 收尾义务）；system-prompt-trace 直接删导出（taiji 组无外部发布面论据，§3.1 D2）。
