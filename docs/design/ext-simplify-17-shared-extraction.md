# ext-simplify-17：shared 抽取统一设计（B 组 5 包 + scheduler 扫描合并）

> 状态：v6 终态（20260914），双审查至双 PASS 0 must-fix：主审（tech-design-review）R2 PASS；影响面（tech-design-impact-review）v5 最终确认 PASS（消费点 4 处经独立 grep 确证、三消费点等价论证逐点核验、批次表消歧确认；唯一 INFO——§6 :86 旧行号——已顺手修正）。完整轨迹：r1 主审 2 MF + 6 S / 影响面 1 MF + 2 S 全修（MF1 D3 误列 bte、MF2 SDK 归属失实、M1 PI_SUBAGENT_* 键族 4 读者全集 + session-lifecycle 活函数误定性核正）；r2 双审独立发现同一 MF（rename-session isRecord 块外消费点），r3 影响面补全至 4 处消费点（:67 随删 / :84、:100、:110 改 import）并核正自身 r2 清单漏报（sed 截止 :95）。
> 来源：20260914 两路独立扫描合并——①B 组 5 包（todo / rename-session / session-manager / base-tool-enhance / plugin-bridge）逐包 subagent 深度审查；②scheduler 全 12 源文件 jscpd + 语义层 scan。全部候选经主 agent grep/实读核实后采信，无伪问题。
> 用户裁决（20260914，本设计的前提）：①执行范围 = 先出统一设计文档，过对抗审查后另行实施；②bte subagent 进程判据重锚定**预授权**——探针证实 PI_SUBAGENT_* 两键无人注入即修，证伪则只记录；③isRecord 全仓归一**做**，随批次顺带。
> **分支基线声明**：本设计覆盖两个 worktree。凡标注「[B 基线]」的行号/文件以 `feat-optimize-extension-overengineering-group-b` 分支为准（B 组 07/15/13/16 已实施终态）；标注「[A 基线]」以 `feat-optimize-extension-over-engineering` 分支为准（scheduler steer 直投重构后）。两分支对同一文件的行号可能不同，实施时以标注为准，禁止跨基线套用。

## 1. 背景与目标

ext-simplify 16 份设计（01-16）消解的是「包内过度设计」；本设计消解的是另一轴：**跨包重复——多个 extension 各自持有同构逻辑，未收敛进共享层**。两路扫描共产出约 20 个候选，经核实分层后：

- 4 条有**实测漂移实证**（重复已经产生过真实 bug 或判据失效）；
- 5 条同构确凿、收益明确；
- 其余为包内收敛项或不抽取项（负面清单，§3.4/§4）。

目标：把前两类收敛进共享层三归宿（ext-guards / llm-shared / extension-protocol）+ 各包包内收敛，全程行为等价（显式列出的 3 处行为微变除外，见 §3 各 D 项「行为变化」标注）。

**非目标**：

- 全域 `instanceof Error ? err.message : String(err)` 样板的全量采用（实测 106 处/60 文件，含 packages/ 层）——本批只采用 scheduler / bte / llm-shared 自身，其余登记为各包后续改造顺带议题。
- TUI 新包（`pi-tui-kit`）立项——双列合并内核量级为每包约 10 行，处于可做可不做边际，登记缓行（§4 附表）。
- scheduler importer.ts 退役——一次性迁移通道（0.1.1 store → append-only）有真实老用户迁移义务，退役条件是产品决策，另行裁决。
- 消除 ext-guards/extension-logger 等既有共享包的 API 面——本设计只做「新增导出 + 消费方迁移」，不改既有导出签名。

## 2. 现状与证据

### 2.1 共享层现状（消费基线）

- `extensions/shared/ext-guards`：`oncePerProcess`（进程级一次性守卫）/ `toErrorMessage` / `STALE_CTX_MARKER` + `guardStaleCtx`。零依赖纯函数。charter（`toErrorMessage` JSDoc 原文）：「收敛各 extension 包散落的样板，本包是 extensions 体系的共享归宿」。
- `extensions/shared/llm-shared`：`resolveModel` / `callLLM` / `extractText` / `loadConfig`/`saveConfig`（mtime+size 缓存 + 锁内原子写）/ `migrateLegacyConfig` / `ModelSelector` 类型。
- `extensions/shared/file-lock`、`extension-logger`：本批无新增导出（各包消费正确，两路 scan 均确认 plugin-bridge/todo 为「共享层正确消费的正面样本」）。
- `packages/extension-protocol`：跨包契约 SSOT。core 层有 Gui 组件原语 + `GuiContext` 结构化类型（零 pi 依赖先例）；5 个 marker 协议模块（marker 常量 + types + 守卫同住惯例）；`pending-entries` 差集两层 API [B 基线]（13 号下沉时新增，A 分支无此文件）；13 号设计下沉的 background-task 行为原语（pid 判据 / tail 读取 / LRU / 原子写）经 `./background-task` 子出口 [B 基线]。

### 2.2 有实测漂移实证的候选（优先级锚点）

| # | 候选 | 漂移实证（已核实） |
|---|------|--------------------|
| P1-a | ThinkingLevel 白名单三份手写副本 | `packages/pi-subagent-cli/src/spawn-args.ts:24` 自称镜像 `model-ref.ts` 字面量面，但六值缺 `xhigh`；pi-ai 上游 `ModelThinkingLevel` 七值**确认含 xhigh**（`node_modules/@earendil-works/pi-ai/dist/types.d.ts:25`）——上游 `:xhigh` 后缀被本包白名单静默拒掉降级 undefined，确认滞后 |
| P1-b | bte 未接入 ext-guards `toErrorMessage` | bte 生产代码 13 处 inline（[B 基线] `grep -rn "instanceof Error ? " extensions/universal/base-tool-enhance/src/` 实测 13；[A 基线] 19，差异来自 B 组 13 号改造删 reaper.ts 等）；7 个兄弟包已迁移，bte 连 package.json 依赖都没有 |
| P1-c | bte subagent 进程判据失效 | `subagent-guard.ts:14-21` 查 `PI_SUBAGENT_ROOT_SESSION_ID` + `PI_SUBAGENT_SELF_RECORD_ID`；全仓 grep **无任何代码向子进程 env 写入这两键**（`spawn-runner.ts:191` 只读继承，注释自述「保留给 standalone/裸 CLI 形态」；`state-marker.ts:32` 明文「旧注入链消失」）。现行统一标记 = `XYZ_AGENT_SUBAGENT=1`（`subagent-engine-sdk/env.ts:157` 恒注入、`nesting-guard.ts:26` `NESTED_SPAWN_ENV`）。SDK `env.ts:70` 注释仍声称 `PI_SUBAGENT_ROOT_SESSION_ID` 由 bte 消费——注释漂移，同批清扫 |
| P1-d | ModelSelector 恢复函数双写 | rename-session `pure.ts:171-178` 与 smart-context `pure.ts:62-68` 核心谓词同构；两包都 import llm-shared 的 `ModelSelector` 类型，序列化形态的恢复逻辑却各持一份，类型扩形态时静默漂移 |

### 2.3 同构确凿的候选（已逐处实读核实）

| # | 候选 | 同构证据 |
|---|------|----------|
| P2-a | select+marker 通道 RPC 原语（4 处同构） | session-manager `index.ts:61-89`（`callSessionManager`）、plugin-bridge `index.ts:106-137`（`callBridge`）、subagent-workflow `host/inflight-reporter.ts:126-139`（发送半边）、protocol `extensions/ask-user/helpers.ts:36-60`（`askUserInteract`）。核心语句同构（`ctx.ui.select(MARKER, [JSON.stringify(payload)], {timeout?, signal?})`），失败折叠语义同构（取消/超时/通道异常 → null + logger.error 留痕），plugin-bridge:130 与 session-manager:78 注释逐字同款。**两路 scan 独立发现、互相印证** |
| P2-b | 错误回包形状双定义 | [B 基线] protocol `extensions/session-manager/types.ts:160` `SessionManagerErrorResult {error, hint?}` ≈ [B 基线] `extensions/plugin-bridge/types.ts:60` `BridgeErrorResponse {error, hint?: string}`，逐字段相同（[A 基线] session-manager/types.ts 同形状在 :77，行号随 13 号下沉漂移）；消费侧 session-manager 内联检测（`index.ts:115-123`）与 plugin-bridge `isBridgeErrorResponse`（`:63-65` + `:167-175` hint 拼接）近似变体 |
| P2-c | `firstContentText` 三包同构 | todo `render.ts:157-160` ≈ subagent-workflow `interface/format.ts:555-563`（`renderTextFallback`）≈ plan `tool.ts:125-126`（内联副本），逐字符同构（`content[0]` → type==="text" 三元 → `text ?? ""`） |
| P2-d | `isEnoentError` 两成员 | scheduler `importer.ts:97`（instanceof + code 版）≈ subagent-workflow `jsonl-run-store.ts:230`（typeof-object 宽版），语义微差 = 非 Error 对象带 code 的接受度 |
| P2-e | pending reason→status 落盘知识分居两包 | bte `notify.ts:76-90`（`toPendingReason`）产出 reason、`pending-reconcile.ts:93` 以 `status: pendingReason` **identity 假设**落盘（notify 侧无 status 写点，emit 只带 reason）；权威实现在 pending-notifications `index.ts:283-293`（`mapReasonToStatus`，自注「落盘契约组成部分」）。与 13 号 M13 所修漂移同构：pending 改映射表，bte 写出的 entry status 即静默漂移 |

### 2.4 用户裁决收录

isRecord（11 文件副本、2 语义变体：排数组 vs 允数组）：两路 scan 中两份报告列低优先候选、rename-session 报告反对（单行惯用法，跨包 import 依赖成本高于重复成本）。用户裁决**做**，随批次顺带——canonical 取排数组严版（`Record` 语义本义，plugin-bridge 与 subagent-inflight 两副本已是此形态）。

## 3. 方案

### 3.1 桶 1 · ext-guards（零依赖守卫收容所）

**D1 `toErrorMessage` 采用批**（零行为变化）。三处采用：scheduler 7 处 [A 基线]（runtime.ts:389 / replay.ts:52,70 / importer.ts:260 / service.ts:62 / index.ts:138,160——index 两处为 `throw new Error(\`Error: ${...}\`)` 形态，等价替换为 `Error: ${toErrorMessage(err)}`）；bte 13 处 [B 基线]（机械替换 + package.json 加 ext-guards 依赖 + extension-dependencies.json 登记）；llm-shared 自身 6 处（call.ts:146 / config.ts:115,187,197,199,209）。llm-shared 新增 ext-guards 依赖（零依赖包引零依赖包，无环）。

**D2 `isEnoentError(err: unknown): boolean` 新导出**（建议新增，命名标注）。canonical = scheduler 严版（`err instanceof Error` + `'code' in err` + `code === 'ENOENT'`，避免 taste/no-unsafe-cast 的 Record 收窄写法）。subagent-workflow `jsonl-run-store.ts:230` 宽版迁移为严版：Node fs 回调契约恒 Error 子类，宽版对「非 Error 带 code 对象」的接受是防御冗余，收严无真实场景损失。scheduler `importer.ts:97` 与 subagent-workflow 各改 import。

**D3 `isRecord(value: unknown): value is Record<string, unknown>` 新导出**（建议新增）。canonical = 排数组严版（`Record` 语义本义，plugin-bridge 与 subagent-inflight 两副本已是此形态）。**本批迁移面 = plugin-bridge + rename-session 两处**：plugin-bridge `index.ts:58-60`（排数组版，函数体零改动搬 import，已依赖 ext-guards）；rename-session `llm.ts:58-61`（允数组版，grep 全文件核实消费点共 4 处——r3 影响面 MF 补全，此前两轮清单各漏报）——分流处置：`joinTextBlocks` 内 :67 随 D7 整块删除自然消失；`extractUserPromptText` 内 :84、`extractFinalText` 内 :100、`extractMessageText` 内 :110 均在 D7 删除块之外，三处改 import ext-guards 严版——rename-session 随之新增 ext-guards 依赖。收严行为等价论证（可证伪，三消费点同构）：数组 message 输入下，严版 `isRecord=false` 直接 `continue` / `return ""`；允数组版通过守卫后——:84 被 `message.role !== "user"` 拦下 continue、:100 经 `joinTextBlocks(message.content)` 因 content 非 Array 返回 ""、:110 经 `typeof message.content === "string"` 为 false 再由 `joinTextBlocks(undefined)` 返回 ""——路径不同结果相同，无行为差异；对象输入两版同路径。bte `spawn-background.ts` **无 isRecord 副本**（v1 误列，实为 `isRecordedPidStillOriginal` 前缀撞名误命中，r1 主审 MF1 核正；bte 包内真正的 object 守卫是 `config.ts:55` `isPlainObject`，维持 §4 负面清单「D1 实施时顺带评估」口径）。其余副本（cache-probe / smart-context ×2 / session-reader（`core/workflow.ts`；`discovery/subagents.ts` 的 `isRecordManifest` 是 manifest 形状守卫非泛用副本，r2 主审 INFO）/ system-prompt-trace）登记为各包后续改造顺带的长期采用议题。**明确排除**：packages/ 层 7 处副本与 extension-protocol 内部 2 处（[B 基线] `session-manager/types.ts:62-64`、`subagent-inflight/types.ts:53-55`）——理由：protocol 被 runtime 双端消费，若 protocol 依赖 ext-guards，runtime 将传递依赖 `@zhushanwen/pi-ext-guards`（extensions 层包），制造反向分层边；protocol 内部 2 处副本登记不动。允数组其余副本若未来迁移须先逐包核对真实数组输入场景（本批两处迁移面中 plugin-bridge 本就是排数组版，rename-session 处已给三消费点全量等价论证）。

**D4 bte subagent 进程判据重锚定**【已预授权，探针证实即修】。
- 实施前置探针（可证伪）：真机跑一次 pi subagent 任务（`pi --mode rpc` + subagent spawn `env`），断言子进程 env 含 `XYZ_AGENT_SUBAGENT=1` 且不含 `PI_SUBAGENT_ROOT_SESSION_ID` / `PI_SUBAGENT_SELF_RECORD_ID`。证实 → 执行重锚定；证伪 → 只记录不修，回报用户。
- 修法：`subagent-guard.ts` 判据改锚 `XYZ_AGENT_SUBAGENT === "1"`；谓词与常量收敛进 ext-guards（建议新增 `isSubagentProcess()` + `SUBAGENT_MARKER` 导出），bte 改 import。smart-context `pure.ts:258-260` 的单键版同谓词顺带收敛（其消费语义与 bte 同源）。
- **键族读者全集与逐个处置**（r1 影响面 M1 增补）：`PI_SUBAGENT_*` 键恒空的失效波及 4 个读者，处置各异——
  ① bte `subagent-guard.ts`（本项修复对象，探针 + 重锚定）；
  ② smart-context 单键版（顺带收敛进 ext-guards，见上）；
  ③ subagent-core `record-access.ts:133-134` `recoverOrphansIfRootProcess()` 以 `PI_SUBAGENT_SELF_RECORD_ID` 判子进程，实现孤儿恢复的「单扫描者」防线——键恒空时子进程恒被当根进程，**防线现处失效态**（注释自述失效后果：活记录被无关进程盖 .finalized sidecar、跨进程互写无锁）。定性：**既有缺陷，非本设计引入，属 subagent-core 债务且超出 extensions 域**——探针报告必须登记该发现，修复另行裁决，本设计不扩范围；
  ④ subagent-workflow `session-lifecycle.ts:278` `appendSubagentIdentityEntry`（:552 活调用）读 12 个 `PI_SUBAGENT_*` 键写 identity entry（r2 主审 INFO 核正键数）——**活函数**（v1 误定性为悬空注释，r1 影响面核正）：键恒空时 `if (!selfRecordId) return` 恒提前返回，**identity entry 恒不写**。处置 = 探针报告登记恒不写事实另行裁决，**禁止实施时误删该活函数**。
- 行为变化（有意）：判据从「两个已无人注入的键」变为「引擎 spawn 链恒注入标记」。旧判据在 standalone/裸 CLI 形态（人工 `export PI_SUBAGENT_ROOT_SESSION_ID`）会命中——新判据不认，即「宁缺勿污」口径：只有引擎链上的真 subagent 才触发 D14 background 降级。此项为预授权范围，实施 PR 说明须复述本段。
- 同批清扫：SDK `env.ts:70` 注释（仍声称 PI_SUBAGENT_ROOT_SESSION_ID 由 bte 消费）改为现行事实。

### 3.2 桶 2 · llm-shared（LLM 域原语归一）

**D5 ThinkingLevel 白名单单点化**。llm-shared 新增（建议新文件 `thinking.ts` 或并入 `resolve.ts`）：

```ts
const THINKING_LEVELS: ReadonlySet<string> = new Set(["off","minimal","low","medium","high","xhigh","max"]);
export function isThinkingLevel(v: unknown): v is ModelThinkingLevel;
```

消费方迁移：rename-session `pure.ts:48-77`（`THINKING_LEVELS` + `isThinkingLevel` 删除改 import）、permission `config.ts:57-68`（同）。**双登记裁决**：llm-shared 持 extensions 侧唯一副本，与 subagent-core `THINKING_ORDER`（`model-ref.ts:40`）注释互指，不建跨包 import（universal 角色禁 import subagent-core，反向破坏分层）；spawn-args 手写字面量面是被迫的（package.json 明文「never subagent-core」+ W9 守卫），本项只补值不收敛结构。
**机器守卫补强**（r1 主审 S2 采纳）：钉值单测只锚副本自身字面量，副本间漂移不触发任何红灯——P1-a 即该代价已兑现的实证；pi 版本门禁探针族守 runtime 注册表面、不校验 extensions 侧词表（已核实 `check-pi-semantics.mjs` / `diff-probe-thinking.mjs` 锚定范围）。随批次 2 交付构建期词表比对：小脚本从 pi-ai dist `types.d.ts` 提取 `ModelThinkingLevel` 联合成员，与 llm-shared `THINKING_LEVELS` Set 比对，不一致即非零退出，接入现有 pre-commit 按路径触发链（符合「SSOT + 机器守卫」架构偏好）。实施时评估接入成本，若明显超出预期则降级为如实登记「副本间漂移无机器守卫」并在本文档留痕。
**配套 [A 基线]**：`packages/pi-subagent-cli/src/spawn-args.ts` 六值白名单补齐 `xhigh`（P1-a 实锤滞后）。行为变化（有意）：`:xhigh` 后缀从「静默拒掉降级 undefined」变为「接受传递」——与上游类型对齐，恢复上游能力。

**D6 `normalizeModelSelector(raw: unknown): ModelSelector | null` 新导出**（建议新增）。落 `resolve.ts`（`ModelSelector` 类型 SSOT 所在地）。rename-session `pure.ts:171-178` 删本地改 import；smart-context `pure.ts:62-68` 改为 `normalizeModelSelector(r.compactModel) ?? { type: "ref", ref: "" }` 保留其回退语义，行为零变更。

**D7 `joinTextBlocks(content: unknown): string` unknown 安全内核**（建议新增）。落 `call.ts`：过滤 `type==="text"` block 并 `join(" ")`；`extractText` 重构为委托内核再 trim（trim 契约与既有消费点 `call.ts:136/141` 行为不变）。rename-session `llm.ts:57-80` 删 `isRecord`+`joinTextBlocks` 本地副本：joinTextBlocks 改 import llm-shared 新导出（`extractUserPromptText` :89 的调用随之指向新导出）；**删除块之外的剩余 isRecord 消费点（extractUserPromptText :84 / extractFinalText :100 / extractMessageText :110，全量清单与等价论证见 D3）改 import ext-guards 严版**（r3 影响面 MF 补全，行号经 `git show` 精确核实）——消灭「靠注释对齐惯例」的漂移面（`llm.ts:78` 注释自认）。**边界**：`extractUserPromptText`（`llm.ts:82-92`）的「扫到首条 user 即返回」控制流是 rename 标题输入业务语义，不并入；`extractFinalText` / `extractMessageText` 两导出函数本体不动，仅换守卫来源。

### 3.3 桶 3 · extension-protocol（协议/传输域）

**D8 select+marker 通道 RPC 原语**（建议新增 `core/select-rpc.ts`，本桶唯一建议先轻量设计评审的项——跨包契约新增 + 4 消费方迁移 + 1 处行为微变）。

API 形态（两路 scan 收敛结论）：

```ts
type MarkerRpcResult = { ok: true; value: string } | { ok: false; reason: "cancelled" | "timeout" | "channel-error" | "non-json" };
callMarkerRpc(ctx, marker, payload: unknown, opts?: { signal?: AbortSignal; timeout?: number; log?: (msg: string, detail?: object) => void }): Promise<MarkerRpcResult>;
```

- 判别结果而非抛错；parse 为 opt-in（session-manager 返回 raw string 语义不破）；传输核与失败折叠契约共享，回包消费三态（解析 JSON / raw string / ack 前缀）、日志策略、timeout 策略留在调用方（真差异保留）。
- **cancelled/timeout 判别机制**（r1 主审 S1）：pi 实装两态不可区分（用户取消与超时均 resolve undefined）。原语以 `signal.aborted` 反推：传入 signal 且 aborted → `"cancelled"`；其余情况（含未传 signal）→ `"timeout"`。判别粒度以底层信息源为界，不虚报可区分性。
- 前置：`GuiContext.ui.select` 签名补 `timeout` 字段（实装已支持——session-manager:74 与 plugin-bridge:118 均在传，协议类型缺声明）。
- 消费方迁移：plugin-bridge `callBridge` 整体替换（非 JSON 留痕语义由原语承担）；session-manager `callSessionManager` 替换；inflight-reporter 仅用发送+折叠半边（fire-and-forget + ack 判定语义保留，不强制全量 RPC 化）；ask-user `askUserInteract` 本批不动（已半规范化在协议包内，作为原语形态参照，是否收编留待原语落地后评估）。
- **行为变化（有意，改进向）**：session-manager 非 JSON 回包从「catch 后 `parsed=undefined` 静默当成功文本返回」（`index.ts:112-114`）统一为「logger.error 留痕 + isError」——对齐 plugin-bridge 形态。实施 PR 说明须列明。
- 配套：错误回包形状单源化——protocol core 新增底层形状（如 `ChannelErrorResult {error: string; hint?: string}`，命名标注建议新增）+ `isChannelErrorResult` / `formatChannelErrorText`；`SessionManagerErrorResult` / `BridgeErrorResponse` 改为引用底层形状的 type alias（保留各自导出名，public API 零破坏；runtime plugin-service / session-manager-handler 等 re-export 消费方不受影响）。plugin-bridge `errorResult` 与 session-manager 内联检测改用共享守卫。

**D9 `firstContentText(result): string` 新导出**（建议新增，落 protocol core 或 `core/helpers`）。todo / subagent-workflow / plan 三包改 import，删各自副本。4 行零依赖纯函数，pi toolResult 通用形状，非领域结构，与 protocol「领域数据结构不进协议层」头注不冲突。**依赖传播面**（r1 影响面 S1）：todo / subagent-workflow 已依赖 extension-protocol；plan **无 protocol 依赖且不在 mandatory 清单**，改 import 需新增该依赖（workspace 内新增，lockfile 随动，守卫规则 3 豁免 packages/ 包条目登记不会拦截）——实施时随包提交 package.json + lockfile 变更。

**D10 pending reason→status 映射单点**。protocol `pending-entries.ts` [B 基线] 新增 `mapReasonToStatus` 导出（string 签名，`PendingStatus` 类型留在 pending-notifications）；pending-notifications 权威实现改为委托导出；**bte 改引落点 = `pending-reconcile.ts:93` 的 `status: pendingReason` identity 假设处**（notify.ts 无 status 写点，emit 只带 reason——r1 主审 INFO 核正），消灭 identity 假设。与 13 号 M13 所修漂移同构，13 号未覆盖此处（E4/E6 只收差集规则），本项为其补遗。

**D11 Bridge 回包形状守卫族迁移**。plugin-bridge `index.ts:63-88` 的 `isBridgeErrorResponse` / `isBridgeToolExecuteResponse` / `isBridgeSyncPayload` / `isBridgeInterceptResponse` / `isSyncedTool` 五函数零改动搬入 protocol `extensions/plugin-bridge/`（新 `guards.ts`，随形状定义同住——session-manager/subagent-inflight 模块已确立「marker + types + 守卫」同住惯例）。**范围排除**：`isInjectedMessage`（16 号附录 A.5 已登记合并议题，迁移是给已判死刑的代码搬家）、`isToolNotFound`（D3 后与 runtime bridge-interop 唯一生产形态 co-deployed 同 PR 纪律覆盖）。诚实声明：守卫族全仓无第二份拷贝，迁移当下零去重收益，价值 = 惯例对齐 + 为 runtime `bridge-handler.ts` 的 5 处 `as string` 断言（:112/114/127/129/146，r1 主审 INFO 核正数量）换校验铺路（第二消费方，后续批次）。

### 3.4 桶 4 · 包内收敛（不进 shared）

**D12 scheduler 包内 [A 基线]**：
- B1 `'pi-scheduler:task'` 字面量收敛 types.ts 常量（代码位点 backend.ts:90 / replay.ts:60 / importer.ts:141；importer.ts:140 注释自认「改一处必改两处」的已知风险随之消除）。
- B2 任务↔快照三转换器收敛两纯函数：`toTaskSnapshot` / `snapshotToTask` 各留一份（runtime.ts:397 解构式与 importer.ts:74 显式 14 字段为同方向重复；`normalizeLegacyTask` 已补全 `Partial<ScheduledTask>` 为不含运行时字段的完整对象，解构式同样正确剥离——importer 注释的「显式更安全」前提不成立）；消费方 runtime/importer/replay 三处。
- B3 cron-invalid 停用回退 ×2 抽 `disableForInvalidCron(task)` 私有方法（runtime.ts:129-133 / :343-347）。
- B4 history push+trim ×3 抽 helper（runtime.ts:318-319 / :335-336 / replay.ts:112-113）。
- B5 backend.ts 类型字面量文件内 type alias ×2（pi 根入口不导出 `CustomMessage`，鸭子解耦只能文件内收敛；接口 backend.ts:33-36 与实现 :82-85）。
- B6 types.ts:38 注释悬空引用 `handleSettled`（steer 重构已删）清扫；backend.ts:29 历史叙述有意保留不动。
- B7 tool.ts:5 死 TODO 删除（`docs/standards.md` 已无 renderResult/renderCall 锚点，已核实）。

**D13 rename-session 码点截断包内合并** [B 基线]：`pure.ts:285-287` / `llm.ts:122-126` / `llm.ts:201-209` 三处 `Array.from` 骨架合并为包内 `truncateCodePoints(text, max, tail)`。不进 shared（跨包第二消费方排查不存在：system-prompt-trace diff.ts 是 UTF-16 码元语义、ask-user 走 pi-tui 显示宽度——真差异）。**注意**：`previewText` 的 300/200/100 数值与 `e2e/harness.mjs:209` `rebuildPreview` 是 15 号 §6.4 D4 裁决的 E2E 双维护契约，重构必须保持行为一致。

**D14 todo `fixedWidth` 就地替换** [B 基线]：`render.ts:31-38` 删除，替换为 pi-tui 0.84.4 实装 `truncateToWidth(text, width, "...", true)`（签名与三分支语义已对照 node_modules dist JS 核实逐一等价；ask-user `question-view.ts:288` 已有 pad 参数生产使用先例）。同步删 `ELLIPSIS_MIN_WIDTH`（:28）。第三方已提供的能力不做第二实现，故此项不进 shared。

## 4. 负面清单（排查过、判定不抽取——防「为什么没提」复查）

| 项 | 判定 | 理由 |
|---|------|------|
| 事件折叠泛化 helper（scheduler replay / pending-notifications / goal ports） | 不抽 | 共享的只有 4 行鸭子接口 + for 骨架；op 语义、类型守卫、边界策略（owner 过滤/损坏跳过/配对计数）是真差异，泛化 = 投机抽象 |
| `tokenizeQuoted`（scheduler commands.ts） | 不抽 | 全域仅 1 处；permission matcher.ts 命中是注释假阳性（消费 AST argv，自己不分词） |
| `generateTaskId` 8-hex id | 不抽 | goal 用 randomUUID()，格式/消费方真差异 |
| ServiceResult 类型外移 | 不抽 | `{success, error?}` 配置写入语义 vs `{success, message, data?}` 用户文案语义，假同构 |
| duration / relative-time 工具外移 | 不抽 | 跨包命中的多为 1 行常量；session-reader elapsed 格式化是单向语义（无 in/ago），输出契约不同 |
| scheduler parsing/format 整体外移 | 不抽 | 无任何包反向依赖 pi-scheduler（grep 已核实），无需求信号 |
| 双列行合并内核（todo/ask-user/subagent-workflow） | 缓行 | 三处 fit 语义刻意真差异（截断加省略号/左补齐硬截/ANSI 感知截断），只能抽合并循环 fit 注入；每包约 10 行，边际收益。若未来立项，以 subagent-workflow tui-kit 通用件为包种子 |
| `migrateTodo`（todo model.ts） | 不抽 | 与 Todo 三态域强耦合（verifying/failed/cancelled 映射）；与 llm-shared `migrateLegacyConfig`（文件路径搬移）仅名字近似，假同构 |
| 双形陷阱检测（todo tool.ts text/texts、id/ids） | 不抽 | 07 号设计 out-of-scope 明列保留；各包字段与文案不同，抽出只剩一行判空 |
| `isSubagentSession` 路径嗅探（rename-session llm.ts） | 不抽 | 15 号裁决：contested → 登记 C-ext-21，env 标记方案已否决；shared 化扩大契约面正是裁决拒绝的方向。与 D4 是不同机制（session 文件路径嗅探 vs 进程 env 判据），不合并 |
| `firstPromptInFlight` 闭包标志 / scheduler `dispatchesInFlight` / plugin-bridge `ensureSynced` 在途防抖 | 不抽 | 与 ext-guards `oncePerProcess`（结果永久缓存重放）是三种真差异语义；「在途 Promise 合流」变体全仓仅 plugin-bridge 一处 |
| `formatDurationMs` 三份（bte/scheduler/goal） | 不抽 | 输出格式语义不同（补零 h/m/s / 单单位 interval 文案 / 无上限分钟），合并需格式参数 = 投机泛化 |
| error+hint 文本拼接（plugin-bridge:169 ≈ session-manager:117） | 不单独立项 | 真重复但 1 行模板、形状微差，低于抽取阈值；随 D8 错误形状单源化自然消解 |
| `isPlainObject` 三份 extensions 副本 | 不抽 | 3 行体量、全仓 10 份中 7 份在 packages/（extensions 侧收敛不可达）；D1 实施 bte 时可顺带评估其 1 份 |
| observe 事件显式注册 ×8（plugin-bridge） | 不抽 | pi 类型系统约束（字面量重载保 handler 类型推断），16 号已核实非过度 |

## 5. 验收

### 5.1 确定性检查（每条可证伪）

- V1 采用批零残留：D1/D3/D9/D13/D14 完成后，`grep -rn "instanceof Error ? " <对应包 src/>` 为 0（排除注释与测试夹具）；`grep -rn "function isRecord\|function firstContentText\|function fixedWidth" <对应包 src/>` 为 0。
- V2 新导出钉值：llm-shared THINKING_LEVELS 七值逐一断言（含 xhigh）的单测；isEnoentError / isRecord 的 canonical 行为单测（含排数组断言）。
- V3 三连绿：`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 全绿（两 worktree 各自跑各自改动面）。
- V4 protocol 契约：D8/D9/D10/D11 新增导出的单测；`SessionManagerErrorResult`/`BridgeErrorResponse` re-export 消费方（runtime plugin-service / session-manager-handler）typecheck 绿。
- V5 spawn-args：`:xhigh` 后缀用例从降级变为接受的单测；六值→七值钉值断言。

### 5.2 真机验收（pi CLI 优先，按 AGENTS.md 本地实测规范）

- V6 D4 探针（实施前置 + 修后回归）：subagent 真机任务 dump env，断言 `XYZ_AGENT_SUBAGENT=1` 存在、`PI_SUBAGENT_*` 两键不存在；修后 subagent 内 `background:true` 恢复 D14 降级（旧行为对照：当前判据失效背景下该降级未生效）。**反向断言**（r1 主审 S4）：非 subagent 主进程（env 无 `XYZ_AGENT_SUBAGENT`）中 `background:true` 任务正常后台化，重锚定后的 guard 不误命中降级。探针报告同时登记 §3.1 D4 ③④ 两处既有失效读者的发现。
- V7 D8 双通道：session-manager 真机调一 action（raw 回包路径）+ plugin-bridge 真机 sync+tool 调用（JSON 回包路径）+ 构造非 JSON 回包断言 isError + 留痕日志（session-manager 行为微变的直接验证点）。**构造手段**（r1 主审 S5）：临时 dev patch runtime session-manager-handler 的 respond 链注入畸形字符串，验收后还原不留痕。**宿主不变口径**（r1 主审 S3）：runtime 侧本设计零代码改动 + V4 导出面 typecheck 守卫，二者合构成为宿主消费面行为不变论证（已核实 session-manager 回包消费方 = agent toolResult，renderer 无专属展示路径）。
- V8 D5/D6：rename-session 真机改名（thinking level 传递 + 模型恢复路径）。

### 5.3 三视角

构建者白盒（各 D 项单测）+ 使用者黑盒（V7/V8 真机调用含 DOM/文案断言）+ 观察者形态（迁移后包的导出面收敛断言——删除的本地符号不再出现在 index barrel）。

## 6. 实施拆分与分支归属

**归属原则：共享包（ext-guards / llm-shared / extension-protocol / subagent-engine-sdk）统一在 group-b worktree 实施**（该分支持 protocol 13 号下沉后的最新形态，且本批主要消费方终态在此）；A 组 worktree 只做 scheduler / pi-subagent-cli 本地项，降低共享包双改冲突。**已核实 subagent-engine-sdk 两分支逐字零差异**（r1 主审 MF2 核正，v1「A 组分支持 SDK 最新」前提失实），按本原则统一归 group-b。合并时共享包改动随 group-b → 集成分支传播；**非 shared 的 universal 包迁移项（rename-session / smart-context / permission / todo / bte）同规则随 group-b 实施与传播，A 侧不重复改动同批项**。permission 两分支已分叉（16 文件），但迁移落点 `config.ts` 两侧同源（r1 主审已核实），落点安全。scheduler [A 基线] 改动不触碰 extension-dependencies.json 与 pnpm-lock.yaml（已核实其 ext-guards 依赖与登记齐备），与 B 侧依赖文件改动零冲突。

| 批次 | 内容 | worktree |
|------|------|----------|
| 批次 1（机械，零行为变化） | D1 全部采用 + D3 isRecord（批次 1 内动作 = ext-guards 新导出 + plugin-bridge 消费迁移；rename-session 侧随批次 2 D7 同 PR）+ D12 B1-B7 + D13 + D14 + bte extension-dependencies.json 清扫（reaper.ts/kill-tree.ts/withFileLock 悬空引用——附带发现） | D1 之 bte 13 处 + D3 之 plugin-bridge + D13 + D14 + json 清扫 → group-b；D12 + D1 之 scheduler 7 处 → A 侧 |
| 批次 2（归一新导出，行为等价） | D2 isEnoentError + D5/D6/D7 桶 2 三件套 + spawn-args xhigh + SDK 注释清扫（env.ts:70）+ smart-context 单键判据收敛（D4②）+ 词表比对脚本 | 主体 group-b；spawn-args xhigh → A 侧（pi-subagent-cli 本地项） |
| 批次 3（契约新增） | D8（先按本节形态过一次聚焦评审再实施）+ D9 + D10 + D11 | group-b |
| 批次 4（预授权探针项） | D4：探针 → 证实即修 → V6 回归；SDK 常量/注释配合改动统一 group-b（两分支零差异，无选侧问题） | 探针双侧无害；修在 group-b |

**changeset 登记**（r1 影响面 S2）：批次收尾各发布包随批提 changeset——ext-guards / llm-shared / extension-protocol 新增导出均 **minor**；llm-shared 新增 runtime dependency（`@zhushanwen/pi-ext-guards`）使独立 pi 用户安装闭包扩大，changeset body 须说明；bte / plan / rename-session 依赖新增随包提（初判 patch；r2 影响面 INFO：按 llm-shared 闭包扩大同口径可 argue minor，type 最终人工定）；系列先例：ext-simplify-01/02/12 设计均登记 changeset 面。

**实施前置**（r2 环境事实）：group-b worktree 目录已于 20260914 会话期间被删除，分支 ref 仍在（`origin/feat-optimize-extension-overengineering-group-b`，即本地 .bare）。实施批次 1/2/3/4 的 group-b 侧前须先重建：`git worktree add <path> feat-optimize-extension-overengineering-group-b` + `pnpm install`（ELECTRON_SKIP_BINARY_DOWNLOAD=1）。重建属实施动作，须经用户确认后执行。

- 批次 1/2 可并行推进（D3 迁移面为 plugin-bridge + rename-session 两处，与批次 1 的 bte/scheduler 项不同包；rename-session 的 isRecord 迁移（llm.ts 块外三消费点改 import ext-guards，清单见 D3）随批次 2 的 D7 同 PR 闭合——同文件（llm.ts）改动一次完成，无跨批次先后依赖，r2 主审 MF 修复口径）。llm-shared 跨批次被 D1（自身 6 处 toErrorMessage 采用）与 D5/D6/D7（新导出）先后触碰，不同文件区域，按批次顺序实施即可。
- 批次 4 探针不依赖任何批次，可最先执行。
- 全部批次完成后：更新 `docs/design/ext-simplify-index.md`（两分支各记一笔，17 号条目 + 本设计登记的跨包债务清账情况）。

## 7. 风险与回退

- 全部迁移为等价替换，回退通道 = git revert 对应 commit（无数据迁移、无持久化形态变化）。
- 3 处行为微变均已显式登记：session-manager 非 JSON 回包 → isError（§3.3 D8）；`:xhigh` 接受（§3.2 D5）；bte 判据重锚定（§3.1 D4，预授权）。三者各自独立成 commit，便于单独回退。
- extension-dependencies.json 清扫须与 bte 依赖新增同批核对（新增 ext-guards 条目 + 删除悬空引用一次到位）。
