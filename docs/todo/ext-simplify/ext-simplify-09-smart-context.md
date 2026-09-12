# ext-simplify-09：smart-context 过度设计简化（估算口径归一 + 类型归一 + 门控单一来源）

> **一句话结论**：smart-context 包（@zhushanwen/pi-smart-context 0.2.0）的审计发现全部收敛——被压段 token 估算从自制 chars/4 换成 pi 已导出的 `estimateTokens`（修复工具重会话被收缩校验系统性误拒的行为缺陷）；Like\*Event×5 与 ToolInfoLike 归一到 pi SDK 类型面（contested 裁决：采纳 code-right；包根缺席的 2 个符号走省略标注/类型推断，边界断言经实读证实无需保留）；门控谓词双写收敛为 `isGatingActive` 单一来源；4 项非 contested low 清理点显式移交 code-simplify。

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-smart-context` 是 universal 组的 agent 自决上下文压缩 extension——注册 `compact_context` 工具 + 接管 `session_before_compact` 压缩生成（same-model KV 缓存对齐 / cross-model 廉价模型双模式）+ 3 档阈值提醒。接管生成后有一道「收缩校验」（摘要 token ≥ 被压段 token → 拒绝落盘），是防「摘要比原文大」反噬的单向门。
- **C（冲突）**：2026-09-11 过度设计审计（候选 12 + 四问记录 9 条发现）证实：收缩校验的分母（被压段 token 估算）是一份自制 chars/4 复刻，漏计 toolCall arguments 与 thinking 块，分母系统性偏小 → 正常摘要被误判「膨胀」→ 无谓拒绝接管并累积熔断；同包另有门控谓词双写、5 个宽松事件类型重声明（注释自述 TS 逆变摩擦绕行）等重复知识。
- **Q（问题）**：如何在不触碰双模式接管机制与 3 档阈值提醒（已核实本质复杂度）的前提下，把估算口径、事件类型、门控谓词三处知识收敛到 SDK/单一来源，并消除误拒熔断这条用户可见的劣化链？
- **A（答案）**：3 个决策（估算口径统一方式、Like\*Event 归一方式、门控收敛方式）+ 1 个 contested 裁决（projectTools 保留），全部行为等价或行为修复；4 项 low 清理点移交 code-simplify 批量执行。

**层声明**：本文档是「技术方案设计」层（下一层产物 = 可实施的代码任务 + 测试改造清单），准则 5/6/7 全适用。

**证据基线**：pi SDK 断言全部核对自本 worktree 实装 `node_modules/@earendil-works/pi-coding-agent@0.84.4`（npm ls 确认版本），非 clone 参照。四问记录 = `~/.pi/agent/tmp/session-view-01a09070-77fd-74a1-a3ae-9e8c6640df3e.md`（grep 证实与 smart-context 匹配）。本文行号均为 2026-09-11 实读值（分支 HEAD `2f78fac77`，本包最近提交 `f1a495816`）。

---

## 1. 背景：被设计的系统是什么

**smart-context 解决的问题是「上下文压缩的质量与时机不受控」**：pi 内建压缩只有单一生成路径，smart-context 提供三条增强——① `compact_context` 工具让 agent 在合适时机自决压缩（D6 阈值保护防滥用）；② `session_before_compact` 接管压缩生成本身（same-model 模式复用完整上下文做 KV 缓存对齐的生成，cross-model 模式用配置的廉价模型）；③ 3 档阈值提醒（200K/400K/600K）在 agent 空闲时投递一次性提示。

接管生成有一道安全阀——**收缩校验（D13-1）**：生成的摘要 token 数 ≥ 被压段 token 数 → 判定「摘要没压小反而膨胀」→ 拒绝采用（回落 pi 原生生成，不落盘），并记录该段不再重试。判定两侧都是估算值：摘要侧 `estimateTextTokens`（chars/4，摘要本身是纯文本），被压段侧 `estimateShadowedTokens`（本设计的核心问题所在）。连续失败 3 次（`TAKEOVER_FAILURE_LIMIT`）触发熔断，本 session 后续所有压缩回落 pi 原生。

关键不变量（本次必须全部不回归的面）：

| 面 | 内容 | 消费方 |
|---|---|---|
| D5 门控矩阵 | enabled + excludedModels 精准匹配，决定工具可用性与接管是否放行 | `compact_context` 工具（拒绝态带恢复指引）、接管 handler、阈值提醒、跨界通知 |
| D13-5 缓存对齐 | same-model 生成请求的 systemPrompt/tools/messages 前缀与主会话完全一致 | 前缀缓存命中率（mismatch = 全 miss） |
| CompactionResult.details | `{engine:"smart-context", mode, model}` 逐字落盘 compaction entry | runtime 用量页 compaction 归属（usage-stats-service.ts:162/:279） |
| 配置 schema | `smart-context-ext-config.json` 四字段（enabled/compactModel/reminderThresholds/excludedModels） | xyz-agent 设置页（SystemSmartContextSection.vue）读写 |

## 2. 设计目标

**改造后维护者能做到：token 估算只认 pi 一个口径源、事件类型只认 SDK 一个权威源、门控规则只改一处；agent 的工具重会话不再被收缩校验误拒。**

1. **G1 估算口径归一（行为修复）**：被压段估算与 pi 自身核算同源（`estimateTokens`），toolCall arguments 与 thinking 块计入分母，工具重会话的合法摘要不再被误判膨胀（验证 §7 场景 1）。
2. **G2 类型权威源唯一**：Like\*Event×5 与 ToolInfoLike 删除，事件/工具类型 = pi SDK 类型面（包根缺席的符号经 `on()` 重载/函数体类型推断对齐，见 §5.1）；SDK 演进编译报错而非静默漂移（验证 §7 场景 3）。
3. **G3 门控单一来源**：D5 门控判定只在 `isGatingActive` 一处，接管 handler 不再手写第二份（验证 §7 场景 2）。
4. **G4 宿主表面不变**：配置 schema、compaction entry details 形状、renderer 设置页读写零变化（验证 §7 场景 4）。

**In-scope**：`extensions/universal/smart-context/`（src + tests）。
**Out-of-scope**：
- 移交清单 T1–T6（§5.7，非 contested low 项，移交 code-simplify 批量执行）；
- 双模式接管机制、3 档阈值提醒、R2 降级态（fire-and-forget + steer 注入）——四问记录「疑似本质复杂度」7 条全部核实为本质复杂度，不动；
- `SimpleResponseLike`（llm.ts:37-48，completeSimple 返回的宽松形状）与 `CompactionResultLike`（tool.ts:42-48，onComplete 回调 guard）——不在审计 Like\*Event×5 清单内，且前者消费的 completeSimple 响应类型不在本次核对面；
- `estimateTextTokens`（摘要侧 chars/4）维持现状——pi 无 string 级估算导出（四问记录本质复杂度第 7 条）。

## 3. 现状：使用者眼里是什么样的

**现状的代价是一条用户可见的劣化链：工具重的会话压缩悄悄变差，且无任何提示。**

### 3.1 现状的真实样子（取自代码）

**(a) 收缩校验的分母是一份漏计的估算复刻**（pure.ts:305-325）：

```ts
export function estimateShadowedTokens(
	messagesToSummarize: ReadonlyArray<{ role: string; content?: unknown }>,
): number {
	let chars = 0;
	for (const m of messagesToSummarize) {
		const content = m.content;
		if (typeof content === "string") {
			chars += content.length;
		} else if (Array.isArray(content)) {
			for (const b of content as ReadonlyArray<{ type?: string; text?: string }>) {
				if (typeof b.text === "string") chars += b.text.length;   // ← 只数 text
			}
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}
```

pi 包根已导出 `estimateTokens(message: AgentMessage)`（dist/index.d.ts:5，签名 compaction.d.ts:62），实装按 role 分支全量计数（compaction.js:186-224）：assistant 消息计 text 块 + **thinking 块**（`block.thinking.length`）+ **toolCall 块**（`name.length + JSON.stringify(arguments).length`），另有 user/custom/toolResult/bashExecution/branchSummary 各分支。pi 自己的压缩用量核算就用它（compaction.d.ts:51 注释）。自复刻只数 string content 与 text block——一个典型的编码会话被压段（多轮读改文件）里，toolCall arguments 与 thinking 恰恰是内容主体。

**量化偏差例子**（一段「读改文件 + 汇报」的典型被压段）：

| 消息 | 内容 | 旧口径 | pi estimateTokens |
|---|---|---|---|
| user | "修复 src/auth.ts 的登录超时 bug"（24 chars） | 6 | 6 |
| assistant | thinking 块 1,600 chars（推理过程） | **0** | 400 |
| assistant | toolCall `edit`，arguments JSON 2,400 chars | **0** | 600 |
| assistant | text 块 24 chars（"已修复并跑通测试"） | 6 | 6 |
| toolResult | 输出 3,200 chars | 800 | 800 |
| **合计** | | **812** | **1,812** |

此时摘要 3,400 chars → `estimateTextTokens` = 850 tokens——对一个实际承载 ~1,800 token 内容的段落，850 是合法的收缩（53%）。但旧口径下 `isSummaryInflated(850, 812) = true` → **误判膨胀**；新口径 `850 < 1,812` → 正常放行。

**(b) 门控谓词双写**：D5 门控规则（enabled 且模型不在排除列表）在 pure.ts:105-109 有权威实现 `isGatingActive`（tool.ts:119、index.ts:114/:155 共 3 处生产消费），但接管 handler 工厂在 compact-handler.ts:301 手写了第二份否定式：

```ts
// D5 门控：禁用/排除 → 空返回（pi 原生生成）
if (config.enabled !== true || currentModelId === "" || config.excludedModels.includes(currentModelId)) {
	return {};
}
```

与 `isGatingActive` 逐支语义等价（`enabled !== true` ≡ `!enabled`，enabled 声明为 boolean），但未 import——同一规则两处维护。

**(c) Like\*Event×5 宽松重声明**：`BeforeCompactLikeEvent`（compact-handler.ts:43-59）、`BeforeCompactDecision`（:62-65）、`AgentSettledLikeEvent`（index.ts:36-38）、`ModelSelectLikeEvent`（index.ts:41-46）、`SessionCompactLikeEvent`（index.ts:50-56）。pi 0.84.4 包根已导出全部对应具名类型（dist/index.d.ts:7）且 `on()` 按事件名重载自动推导 handler 参数（types.d.ts:913/:914/:926/:937）。index.ts:48-49 注释自述绕行动机：

```ts
/** session_compact 事件形状（compactionEntry 只消费 type；interface 无隐式 index signature，
 * 禁用 `& Record<string, unknown>` 交叉目标——会破坏 on() 重载的参数逆变匹配）。 */
```

本地类型是 SDK 类型的降级子集：`ModelSelectLikeEvent.source: string` vs SDK `ModelSelectSource` 字面量联合 `"set"|"cycle"|"restore"`（types.d.ts:630）；`BeforeCompactDecision` 与 SDK `SessionBeforeCompactResult`（types.d.ts:857-860）**逐字段相同**（cancel?/compaction?）。注意：5 个对应 SDK 符号中 `SessionBeforeCompactResult` 与 `ModelSelectEvent` 两个**不在包根导出**（仅深层 `dist/core/extensions/index.d.ts` 可见，import 路径核实见 §5.1 审计修正）。批 A 已有两个同模式先例归一到 SDK 类型：`docs/design/ext-simplify-02-system-prompt-trace.md` D4（taiji 4 接口归一，typecheck 即探针）、`docs/design/ext-simplify-03-goal.md` D1（goal 7 接口归一，忽略点省略标注 + 单点显式 import），均无逆变摩擦。

### 3.2 真实失败模式

- **F1（估算误拒 → 熔断，用户可见劣化）**：§3.1(a) 的量化场景在工具重的会话里重复出现——每次接管都被收缩校验拒绝（compact-handler.ts:333-337），`failStreak` 累积到 3 触发熔断（:307），此后本 session 全部压缩静默回落 pi 原生（只有 debugLog，无用户提示）——same-model 缓存收益 / cross-model 降本 / fileOps 重注入 / 结构化模板全部失效。
- **F2（门控分叉）**：给 D5 门控新增维度（如按 session 类型排除）时改了 `isGatingActive` 漏改 ：301——工具入口已拒绝而接管 handler 仍放行（或反向），双入口行为分叉。
- **F3（类型静默漂移）**：SDK 升级改事件字段名（如 `firstKeptEntryId`）或 `source` 新增枚举值时，本地宽松类型编译零报错，消费点拿到 `undefined` 到运行时才暴露。check-pi-sync 门禁只锁版本锚点与构建期派生锚点，管不到字段级漂移。

### 3.3 根因

**与批 A 同根：对 pi SDK 能力面的过时假设 + 局部摩擦的绕行式解法。** 估算复刻形成时赌「chars/4 粗判量级够用」（pure.ts:307-308 注释自认「保守替代」），但漏计的不是精度问题而是结构性缺块——被压段里工具内容占比越高，偏差越大，方向恒定（分母偏小）；类型绕行是因为本地尝试的 `& Record<string, unknown>` 交叉类型确实破坏逆变匹配（index.ts:48-49），但正确的解法是直接 import SDK 类型让交叉不再需要，而不是自造宽松形状（goal 设计 ext-simplify-03 D1 被否项 B3 已论证同一点）。

## 4. 终态：使用者眼里将是什么样的

**终态下三条链路各剩一个权威源：估算 = pi `estimateTokens`，事件类型 = SDK 具名导出，门控 = `isGatingActive`；工具重会话的压缩接管恢复正常。**

### 4.1 成功路径

```
工具重会话（被压段实际 ~1,800 tokens，其中 thinking/toolCall 占 ~55%）触发压缩：
  session_before_compact → 接管生成 → 摘要 850 tokens
  estimateShadowedTokens（= pi estimateTokens 逐条求和）= 1,812
  isSummaryInflated(850, 1812) = false → 接管落盘 ✓
  compaction entry details = {engine:"smart-context", mode, model}（形状不变，用量归属照常）
  日志：takeover ok: mode=same-model reason=manual summaryTokens=850 shadowedTokens=1812（E2 补记 shadowedTokens 字段，见 §5.6）
维护者视角：
  SDK 升级给 ModelSelectEvent.source 加枚举值 → pnpm extensions:typecheck 红（负防腐生效）
  改门控规则 → 只改 pure.ts isGatingActive 一处，工具/接管/提醒/通知四入口同步生效
```

### 4.2 失败路径（带恢复指引）

- **摘要真实膨胀**（模型输出超长摘要）：收缩校验行为不变——拒绝 + 记录该段 + failStreak+1，回落 pi 原生。排查口径看 `XYZ_AGENT_DEBUG=1` 下 `~/.pi/agent/logs/` 的 `summary inflated` warn（含两侧 token 数）；若观察到**误拒**（摘要明显小于被压段仍被拒），核对两侧估算调用是否被改动偏离本设计（👉 回读本节 §5 D2 核对口径）。
- **类型迁移单点编译错**：① SDK 类型与某 handler 参数在 tsc 下逆变报错 → 该参数回退「省略标注靠 on() 重载推导」（goal 先例 P-like-1 同款降级）；② 包根符号不存在（TS2724）→ 返回/参数类型省略标注走推断（本设计 D1/D2 已按此写定，见 §5.1/§5.2 被否谱系）；均不影响其余迁移点。
- **熔断已触发的存量 session**：本设计不重置运行期状态——熔断是 session 级闭包（session_start 重建），新开 session 即恢复；已落盘的 pi 原生压缩结果不受影响。

## 5. 关键决策与权衡

**本章结论：4 个决策——Like\*Event 归一（contested 裁决采纳 code-right）、估算口径统一（pi estimateTokens）、门控收敛（单一函数）、projectTools 保留（contested 裁决），加一组移交清单。**

### 5.1 D1：Like\*Event×5 归一方式（contested 裁决，选定：SDK 类型面归一——直标/省略标注/函数体推断）

- **采用**：删 5 个本地接口；`BeforeCompactLikeEvent` → `SessionBeforeCompactEvent`（包根直标）、`AgentSettledLikeEvent`/`SessionCompactLikeEvent` → handler 参数省略标注（`on()` 重载推导，事件体整个忽略）、`ModelSelectLikeEvent` → **handler 参数同样省略标注**（该 handler 是内联箭头函数，上下文推断给出完整 `ModelSelectEvent` 类型——含 model/previousModel/source 字段，消费点不损失类型）。`BeforeCompactDecision` 删除，**factory/generate 的返回类型省略标注、由函数体对象字面量推断**：handler 内 `return {}` / `return { compaction: result }` 推断出的结构化返回类型（`{cancel?; compaction?: CompactionResult}` 形状）与 SDK `SessionBeforeCompactResult`（types.d.ts:857-860）逐字段同形，注册点 `pi.on("session_before_compact", beforeCompact)` 重载要求的 `ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>` 按结构兼容赋值校验通过——该链路已用 tsc 探针验证可编译（✅ 已测 2026-09-11，`--moduleResolution bundler`，含 generate→factory→on() 全链推断与 `event.preparation` 直传 nativeCompact 的 cast 删除形态；探针临时文件已删除）。返回类型不写名义标注的原因：`SessionBeforeCompactResult` **不在包根导出**（见审计修正），任何显式标注该名的写法都不可 import。`CompactionResult` 本身包根可用（dist/index.d.ts:5，现 :15 已 import），generateSameMode/generateCrossMode 的 `Promise<CompactionResult | null>` 标注保留。联动删除两处因宽松类型而存在的 cast：compact-handler.ts:261-264 `event.preparation as Parameters<typeof nativeCompact>[0]`（SDK 类型下 `event.preparation` 本就是 `CompactionPreparation`，compaction.d.ts:142 compact 首参即它）与 :185 `event.branchEntries as SessionEntry[]`（SDK 事件中已是 `SessionEntry[]`）；index.ts:99-100 只为携带类型标注而存在的箭头包装收敛为 `pi.on("session_before_compact", beforeCompact)`；:48-49 逆变摩擦注释随接口删除。
- **被否**：
  - *D1-v1（初版方案，被第 1 轮影响面审查击穿）：`BeforeCompactDecision` → `SessionBeforeCompactResult` 直接换名 + factory 返回签名 `Promise<SessionBeforeCompactResult>`*——击穿反例：该符号**不在包根导出**（`dist/index.d.ts` 全文 36 行无此名，:7 为显式白名单且无 `export *`），`import type { SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent"` 报 TS2724（tsc 探针实证）；省略「单字段标注」救不了显式写的返回类型标注，P1 探针必红且彼时降级清单未覆盖「符号不存在」失败模式。已改为上文省略标注 + 推断方案。
  - *D1-v2：深层导出路径 import（`@earendil-works/pi-coding-agent/dist/core/extensions/index.js`）*——击穿反例：包 `exports` 字段仅 `"."`/`./rpc-entry`/`./client` 三入口，bundler 解析下深层路径报 TS2307（tsc 探针实证）；即使绕过也是 dist 内部私有路径，pi 升级随目录布局漂移，违背「公共 API 面」纪律。
  - *D1-v3：保留本地 `BeforeCompactDecision` + 注释锚定「与 SDK SessionBeforeCompactResult 同形」*——可编译，但留下第二份知识（D1-B2「手抄维护义务」理由的单点残存），与 G2 权威源唯一矛盾；作为推断方案失败时的兜底保留（见 P1 降级路径）。
  - *B1 保留 Like\* 短期不动（审计原 contested 立场，理由是逆变摩擦 + check-pi-sync 门禁对冲）*——摩擦的前提已证伪：摩擦来自「接口无隐式 index signature 破坏 `& Record` 交叉」，SDK 类型直标后根本不需要交叉；批 A 两先例（taiji 4 接口、goal 7 接口）编译验证均无逆变问题。用户已拍板 contested 全部执行。若用它，§3.2 F3 静默漂移面原样保留。
  - *B2 保留 Like\* 但字段升级对齐 SDK*——手抄维护义务照旧，漂移面不变，只是抄得更像（goal D1-B 同款否决）。
- **证据**：dist/index.d.ts:7 导出清单实读——`SessionBeforeCompactEvent`/`SessionCompactEvent`/`AgentSettledEvent` 在白名单内，**`SessionBeforeCompactResult` 与 `ModelSelectEvent` 不在**（全文 36 行 grep 计数 0，:7 为显式白名单无 `export *`）；`SessionBeforeCompactResult` types.d.ts:857-860（`{cancel?; compaction?: CompactionResult}`）与本地 BeforeCompactDecision 逐字段相同实读；on() 重载 types.d.ts:913/:914/:926/:937（:913 即 `ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>`）；`ExtensionHandler<E, R>` 定义 types.d.ts:902（`Promise<R | void> | R | void`）；先例 `docs/design/ext-simplify-02-system-prompt-trace.md`（taiji）与 `docs/design/ext-simplify-03-goal.md`（goal）归一后 typecheck 绿；推断方案的可编译性见采用段 tsc 探针。
- **审计修正（包根缺席例外 ×2）**：审计候选 3 称「pi 0.84.4 包根已导出全部具名事件类型」——实读存在**两处**例外，符号仅在深层 `dist/core/extensions/index.d.ts:9` 导出、包根 dist/index.d.ts 全文 0 次出现（grep 计数），包根形式 `import type` 均不可用：① `ModelSelectEvent` → model_select handler 走省略标注 + 上下文推断（类型仍精确、零本地符号）；② `SessionBeforeCompactResult`（第 1 轮审查新发现，初版方案因此击穿，见被否 D1-v1）→ decision 返回类型走省略标注 + 函数体推断。两处均非 goal 先例的显式 import——goal 的 D1-B2 否决理由（「全文件无一处事件类型 import 权威源不可见」）在本包不触发：before_compact 链路的 `SessionBeforeCompactEvent`/`CompactionResult` 显式 SDK import 保持了权威源可见性，仅返回类型与 model_select 两处例外。
- **效果**：G2 成立。**对审计方向的修正**：审计方向为「导入 pi 类型、边界一次断言」——实读证实 SDK 类型直标后事件在 handler 边界已是精确类型，包内纯函数层的宽松形状（`FileOpsLike`/`EntryLike`）保持为纯函数入参接口而非事件重声明，`FileOperations`（utils.d.ts:6-10，Set 三字段）结构兼容 `FileOpsLike`（Iterable 三字段）无需断言——**任何运行时边界断言都不可达，无需保留**，优于审计方向且与 goal 先例同构。
- **探针**（⛔ 实施期门）：

| ID | 验证的行为 | 探针 | 状态 | 失败降级路径 |
|---|---|---|---|---|
| P1 | SDK 事件类型直标/省略标注 handler 后 tsc 通过（含 factory/generate 返回类型推断链、两处 cast 删除、直接注册） | `pnpm extensions:typecheck` | ⛔ U1（方案形态已由设计期 tsc 探针预验 ✅ 2026-09-11） | 失败模式分三类：① 单点逆变报错 → 该参数省略标注靠重载推导；② 包根符号不存在（TS2724，`SessionBeforeCompactResult` 已实证）→ 返回类型省略标注走函数体推断（本设计已按此写定，非降级；若推断仍报错）→ 兜底恢复本地结构类型 + 注释锚定 SDK（被否 D1-v3 形态，实施期登记）；③ 两处 cast 删除若报错 → 恢复原 cast 并登记（其余迁移不受影响） |

### 5.2 D2：被压段估算口径统一方式（选定：import pi estimateTokens 逐条求和）

- **采用**：pure.ts `import { estimateTokens } from "@earendil-works/pi-coding-agent"`，`estimateShadowedTokens` 改为对 `messagesToSummarize` 逐条 `estimateTokens(m)` 求和；参数类型 `ReadonlyArray<Parameters<typeof estimateTokens>[0]>`——**经 pi 实装函数签名反推消息类型**（解析结果即 pi-agent-core dist/types.d.ts:283 的 `AgentMessage`，与调用点 `event.preparation.messagesToSummarize`（`CompactionPreparation` 字段，compaction.d.ts:120）同型，无需边界 cast；不直接 import `AgentMessage` 名义的理由见被否 B3/B4）；:305-309 注释由「保守替代」改写为「与 pi 核算同源」；`CHARS_PER_TOKEN_ESTIMATE` 常量保留（摘要侧 `estimateTextTokens` 仍用）。该签名形态已用 tsc 探针验证可编译（✅ 已测 2026-09-11，含「调用点 SDK 精确类型实参 → 推导参数类型」的赋值方向）。
- **被否**：
  - *B1 保留 chars/4 但手写补齐 thinking/toolCall 分支*——复刻维护义务原样保留，pi 口径演进仍需人工跟齐，正是审计命中的 abstraction inversion 本体。
  - *B2 函数移到 compact-handler.ts（pi-facing 层）以保 pure 层零 pi import*——`isSummaryInflated` + `estimateShadowedTokens` 是 D13-1 收缩校验的语义对，拆两文件降低内聚；且 `estimateTokens` 本身是纯函数，pure 层纪律是「无副作用/无 fs」而非「无 SDK」。
  - *B3（第 1 轮影响面审查击穿初版写法）`import type { AgentMessage } from ...` 名义导入*——`AgentMessage` 唯一来源 `@earendil-works/pi-agent-core`（dist/index.d.ts 末行 `export * from "./types.ts"`），pi-coding-agent 包根全文 0 次出现；smart-context package.json **未声明该依赖**（deps 仅 workspace 包，peerDeps 仅 pi-coding-agent/pi-ai/typebox），本仓 `.npmrc` 为 `node-linker=hoisted`（无 phantom deps 防护）→ tsc 静默解析成功、`check-extension-dependencies.mjs` 不查外部依赖声明，**无守卫拦截**，实施后将静默落库成全仓 extensions 首个幽灵依赖，且 npm 源码直发形态下外部消费者 TS 解析有失败风险。
  - *B4 package.json 补 peerDep `@earendil-works/pi-agent-core`*——为解决一个类型名的可读性，触碰 C-build-07「extensions peerDeps」构建期派生锚点（check-pi-sync 守卫，升级 PR 必须锚点同步），并给全链版本门禁新增一个包——成本与收益不成比。`Parameters<typeof estimateTokens>[0]` 推导别名随 pi 升级自动跟随（推导非手抄），与 B1 的「人工跟齐」有本质区别。
- **反面证据的处理**：`docs/design/composer-multi-skill-injection.md:213` 记有「pi estimateTokens chars/4 对中文低估 2~4 倍故不可照抄」——该场景是注入**预算的绝对量**估计（低估直接超预算），不可照抄成立；本场景是「摘要 vs 被压段」的**同启发式比值**比较，两侧同为 chars/4 族，**文本形态同族时**系统性偏差在比值中抵消；且 pi 自身压缩核算就用 estimateTokens（compaction.d.ts:51），口径对齐 pi 核算正是本项的目的。故该证据不阻塞本决策。
- **口径不对称子场景的显式判定（已接受代价，第 1 轮审查补）**：上述抵消论证只在两侧文本形态同族时成立；本包常态恰是形态不对称——被压段以 toolCall JSON/thinking（代码与英文密集，chars/4 相对准）为主，摘要侧是中文结构化模板（chars/4 低估 2~4 倍）。新分母 ≥ 旧分母恒成立（estimateTokens 逐分支计数是旧实现超集），放行集合随之扩大：新增放行区间（旧分母, 新分母）内的摘要，在「摘要侧低估程度 > 分母侧」时存在**真膨胀仍被放行的漏判窗口**——旧口径的小分母在此子场景反而偶发拦住真膨胀摘要。四要素判定：①量级 = 真膨胀本身罕见 ∩ 形态极端不对称的交集，边缘场景；②恢复路径 = 无自动恢复，后果是单条偏大摘要落盘（可被后续压缩再处理，非不可逆），D13-1 本就是 chars/4 启发式单向门而非精确防线，误拒链（F1）的清除收益完全压倒该窗口；③重审条件 = 验收（§7 场景 1）或运行中若观察到接管摘要 tokens 显著大于被压段内容量级，回查摘要侧 `estimateTextTokens` 口径是否需跟随升级；④显式判定 = 接受该窗口，方向为净正收益。
- **证据**：estimateTokens 导出 dist/index.d.ts:5 + 签名 compaction.d.ts:62 + 实装 compaction.js:186-224（assistant 分支计 thinking 与 toolCall name+JSON.stringify(arguments)——§3.1(a) 漏计块实读）；`estimateShadowedTokens` 生产调用仅 compact-handler.ts:31/:332；四问记录证实该函数**零直接测试覆盖**（grep __tests__ 零命中），现有「收缩校验失败」用例（compact-handler.test.ts:143-154）的被压段是纯 user 文本（400 chars → 新旧口径同为 100），迁移后数值不变用例仍绿。
- **效果**：G1 成立——§3.1(a) 量化例子中 850-token 合法摘要从「误拒 + 熔断加速」变为「放行」。
- **契约测试口径断言**（审计指定）：pure.test.ts 新增用例——仅含 toolCall 块（arguments 为大 JSON）的 assistant 消息 → `estimateShadowedTokens` > 0（旧实现为 0）；仅含 thinking 块同理。锁口径回归，防将来有人改回文本版。用例 fixture 必须是合法 block 数组消息（形态约束与禁止 as 硬塞的理由见 §8.3）。
- **探针**（⛔ 实施期门）：

| ID | 验证的行为 | 探针 | 状态 | 失败降级路径 |
|---|---|---|---|---|
| P2 | compact-handler.test.ts 的整模块 vi.mock 工厂补入 estimateTokens 后测试链路可用（pure.js 经 mock 通道拿得到实现） | 改用 `vi.mock(..., async (importOriginal) => ({ ...await importOriginal(), buildSessionContext/convertToLlm/compact 覆盖 }))` 保留真实 estimateTokens，跑该测试文件 | ⛔ U2 | importOriginal 形态异常 → 工厂显式补 `estimateTokens: 实装引用的透传`；仍异常 → 该文件对 pure 的 import 断言降级为口径数值直测（不改变断言强度） |

### 5.3 D3：门控谓词收敛方式（选定：handler 改调 isGatingActive）

- **采用**：compact-handler.ts:301 一行替换为 `if (!isGatingActive(config, currentModelId)) return {};`（`isGatingActive` 已在 :34 import 清单外——需补 import；语义等价核对见 §3.1(b)）。
- **被否**：
  - *B1 反向收敛（保内联、删 isGatingActive）*——`isGatingActive` 另有 3 处生产消费（tool.ts:119 gatingProbe 默认实现、index.ts:114、index.ts:155），不可删。
  - *B2 双写保留 + 注释互指*——注释不构成编译期约束，F2 分叉面照旧。
- **证据**：四问记录发现 1（medium，code-right）；两侧语义逐支等价实读（§3.1(b)）。
- **效果**：G3 成立——D5 门控知识单一来源，现有门控双用例（compact-handler.test.ts:79-80 空返回、tool.test.ts 门控拒绝 throw）背书行为等价。

### 5.4 D4：projectTools / ToolInfoLike 处置（contested 裁决，选定：保留函数 + 类型归一）

- **采用**：`projectTools`（llm.ts:29-35，唯一生产调用 compact-handler.ts:191）**保留**——函数名 + 头注承载「投影即透传、勿改造」的 D13-5 缓存对齐知识（parameters 原样透传是前缀缓存命中的关键不变量），是该不变量的可检索命名锚点；`ToolInfoLike`（llm.ts:18-23）删除改 `import type { ToolInfo }`（types.d.ts:1192-1194，`pi.getAllTools()` 返回 `ToolInfo[]`，types.d.ts:997）；函数体内 `parameters as LlmTool["parameters"]` cast 预期可一并删除（两侧均为 typebox TSchema），由 P1 typecheck 定案。
- **被否**：
  - *B1 删函数、调用点 inline map + 注释迁移*——省约 10 行，但「勿改造」知识埋进 generateSameMode 60 行函数体，下一个想「顺手规范化 parameters」的人失去锚点；pass-through 反模式的「删掉行为不变」判定在此成立，但该层的价值不在行为在知识命名。
  - *B2 原样全保留（ToolInfoLike 不动）*——宽松重声明的负防腐缺失照旧，与 G2 的权威源收敛矛盾。
- **证据**：四问记录发现 8（contested，记录自身倾向「保留可辩护」）；ToolInfo 导出 types.d.ts:1192-1194 实读。
- **效果**：G2 补全（类型权威源无第二份），D13-5 知识锚点保留。

### 5.5 方案对比总览（决策级）

| 决策 | 选定方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|---|
| D1 | SDK 具名类型直标/省略标注 | 事件类型权威源唯一；SDK 演进编译期可见；两处 cast 与包装箭头随之消失 | 低：3 文件 + 测试 fixture，typecheck 一次覆盖 | 单点逆变摩擦（P1 探针 + 省略标注降级） | ✅ |
| D1-B1 | Like\* 保留不动 | 双轨类型持续缴税，漂移面永续 | 零 | F3 静默漂移原样保留 | ❌ |
| D1-B2 | Like\* 字段对齐 SDK | 手抄维护义务仍在 | 中（逐字段核对） | 漂移面不变 | ❌ |
| D2 | import estimateTokens 求和 | 分母与 pi 核算同源；删一份复刻知识 | 低：1 函数重写 + 1 测试用例 | pure 层新增一个 pi value import（estimateTokens 本身纯函数）；参数类型经签名推导，零名义依赖（B3/B4 被否） | ✅ |
| D2-B1 | chars/4 手写补块 | 复刻维护义务照旧 | 中（对齐 pi 8 分支） | 口径漂移风险原样 | ❌ |
| D2-B2 | 函数移 compact-handler | D13-1 语义对拆两文件 | 低 | 内聚下降 | ❌ |
| D3 | handler 改调 isGatingActive | 门控知识单一来源（4+1 消费方同一函数） | 极低：一行替换 | 无（语义逐支等价 + 双用例背书） | ✅ |
| D3-B1 | 反向删 isGatingActive | 不可行 | — | 另有 3 处生产消费 | ❌ |
| D4 | 保留 projectTools + ToolInfo 类型归一 | D13-5 缓存对齐知识保持命名锚点 | 低：换 import + 或删一处 cast | cast 去留由 typecheck 定（有降级） | ✅ |
| D4-B1 | 删函数 inline | 省 ~10 行 | 低 | 勿改造知识失去可检索锚点 | ❌ |

**被否若用（可感知取舍）**：D1-B1 下，pi 升级给 `source` 加 `"restore"` 之外的新枚举值时 smart-context 无感继续跑（`source: string` 吞掉），直到某 handler 开始消费才暴露。D2-B1 下，pi 估算器每次演进（如新增消息 role）都要人工同步本地 8 分支，漏一处即分母再现结构性偏差——§3.1(a) 的误拒场景以新形态复发。

### 5.6 执行项总表（全部直接执行）

| 项 | 来源 | 内容 | 位置 | 决策/直接执行 |
|---|---|---|---|---|
| E1 | 审计候选 3（Like\*×5）+ D1 | 5 接口删除：事件类型 SDK 直标/省略标注，decision 返回类型省略标注走函数体推断（§5.1）；:261-264 与 ：185 两 cast 删除；:99-100 包装收敛直接注册；逆变注释删除 | compact-handler.ts:42-65/173-177/185/239-243/261-264/295、index.ts:16-22/35-56/93-100/103/111/131 | D1 裁决执行 |
| E2 | 审计候选 12（C12）+ MF 修正 | estimateShadowedTokens 改 estimateTokens 求和 + 参数类型 `Parameters<typeof estimateTokens>[0]` 推导 + 注释改写 + pure.test.ts 口径断言用例 + compact-handler.test.ts mock 工厂 importOriginal 化与 fixture 补齐（signal / message timestamp / **assistant content 改合法 block 数组**，见 §8.3）+ **compact-handler.ts:341 `takeover ok` debugLog 补记 `shadowedTokens` 字段（一行，§7 场景 1 的观测依据）** | pure.ts:305-325、pure.test.ts、compact-handler.ts:333-342、compact-handler.test.ts:5-12/21-41 | D2 执行 |
| E3 | 四问发现 1（门控双写） | :301 一行替换 `!isGatingActive(config, currentModelId)` + 补 import | compact-handler.ts:301、:22-40 import 清单 | D3 执行 |
| E4 | 四问发现 8（projectTools） | ToolInfoLike → SDK ToolInfo；cast 视 typecheck 定去留 | llm.ts:18-23/29-35 | D4 裁决执行 |

### 5.7 移交清单（非 contested low 项，登记即移交 code-simplify 批量执行）

| # | 项（四问发现号） | 位置与现状 | 方向 | 备注 |
|---|---|---|---|---|
| T1 | deps 注入缝（发现 3） | llm.ts:80-85（`deps?: {getApiKeyAndHeaders?, call?}` 声明）、:104-106（解析与默认包装）；生产唯一调用 compact-handler.ts:192-199 不传 deps，测试经 vi.mock 整模块（compact-handler.test.ts:11）不走此缝 | 整段删除（净删约 15 行），callSameModelCompaction 直调 `ctx.modelRegistry.getApiKeyAndHeaders` / `completeSimple` | 与 tool.ts:108-112 的 deps 对照——后者有真实测试消费（tool.test.ts:72-75），**保留** |
| T2 | details 五字段（发现 5） | tool.ts:50-59 `CompactContextDetails`、:201-207 返回——`launched: true`/`fellBack: false` 为写死字面量（:204/:206），全仓零消费（rg `CompactContextDetails` 仅定义+返回点；renderer features/chat details 零命中，本设计实读复核） | 删 launched/fellBack 两常量字段；mode/compactModel/compactionCount 保留并注明「仅供 session JSONL 事后排查」；tool.test.ts:93 toMatchObject 断言同步 | **勿误删** compact-handler.ts:94-100 的 `SmartContextDetails`（compaction entry details）——它有 runtime 用量归属真实消费方 |
| T3 | PI_DEFAULT_RESERVE_TOKENS 复刻（发现 6） | reminder.ts:17（`16_384` 字面量）、:75（downshift 触发线 = newWindow − 该值）；pi 已导出 `DEFAULT_COMPACTION_SETTINGS`（dist/index.d.ts:5），实际值可被用户 settings.jsonl 改写 | import `DEFAULT_COMPACTION_SETTINGS.reserveTokens` 替换字面量（sdk-contract.test.ts:13 测试已导入同源） | 错报后果轻（提示文案），low。**行为变化判定（第 1 轮审查补）**：跟随用户 settings.jsonl 配置属修正错报而非引入风险；量级仅 downshift 提醒文案时机；重审条件无（提醒链路无持久后果） |
| T4 | isSessionManagerSessionFileLike 恒真守卫（发现 7） | compact-handler.ts:102-114 定义 + :122-123 唯一调用；守卫仅 `typeof object && !== null`，零信息量 | 删守卫，`ctx.sessionManager as SessionManagerSessionFileLike \| undefined` 单行等价（注释保留） | 后续可评估直用 `ReadonlySessionManager.getSessionFile()`（ext-simplify-02 已核实声明存在，session-manager.d.ts:140/:208）再收一层——超本设计范围 |
| T5 | getCurrentModelId re-export 双路由（发现 9） | pure.ts:99 re-export（tool.ts:22/index.ts:28/compact-handler.ts:36 均从 pure 取）vs compact-handler.ts:23 resolveModel 直连 llm-shared | 删 re-export，三处改直连 `@zhushanwen/pi-llm-shared` | 纯 import 路径统一 |
| T6 | suggestions 两条（四问记录 Suggestions） | ① tool.ts:117+:142 每次 execute 两次 `loadSmartContextConfig()`（mtime 缓存下仅两次 statSync）；② pure.ts:18 `MAX_THRESHOLD_TIERS` | ① probeGating 默认实现与 execute 复用一次读取；② **实施期先确认** | ② 审计修正：记录称「截断上限无收益」不准确——pure.ts:75 `.slice(0, MAX_THRESHOLD_TIERS)` 会截断用户配置超过 3 档的数组，删除即行为变更；若「3 档上限」是产品决策则保留。另：sdk-contract.test.ts:6 头注版本号 0.84.1 漂移（实装 0.84.4），触达时顺带修正 |

## 6. 实现机制（把终态落到代码层）

**本章结论：改动收敛在 4 个源文件 + 3 个测试文件，净变化约 -60 行；E2 是唯一行为变更项。**

文件改动地图（实施清单，非代码）：

| 文件 | 动作 | 承载项 |
|---|---|---|
| `src/pure.ts` | 改 | E2：import estimateTokens；estimateShadowedTokens 重写（求和 + `Parameters<typeof estimateTokens>[0]` 推导参数）+ :305-309 注释改写。T5（移交）触达 ：99 |
| `src/compact-handler.ts` | 改 | E1：BeforeCompactLikeEvent/BeforeCompactDecision 删除（事件类型 SDK 直标、返回类型省略标注推断），generateSameMode/generateCrossMode 签名保留 `Promise<CompactionResult \| null>`，:185/:261-264 cast 删除，factory 返回类型省略标注；E2：:341 `takeover ok` debugLog 补 `shadowedTokens` 字段；E3：:301 谓词替换 + import 补充 |
| `src/index.ts` | 改 | E1：三 Like 接口删除（:35-56 含逆变注释）；session_before_compact 直接注册（:99-100）；session_compact/agent_settled/model_select handler 参数省略标注（model_select 的事件体消费靠上下文推断完整类型，见 §5.1 审计修正） |
| `src/llm.ts` | 改 | E4：ToolInfoLike → SDK ToolInfo |
| `src/__tests__/compact-handler.test.ts` | 改 | E1/E2：vi.mock 工厂 importOriginal 化（P2）；makeEvent fixture 补齐——`signal`（SDK 必填，:448-453）、message `timestamp`（UserMessage/AssistantMessage 必填，pi-ai types.d.ts:302-320）、**assistant content 由 string 改合法 block 数组**（AssistantMessage.content 是纯 block 数组；禁止 `as` 断言硬塞 string——新口径下 estimateTokens 对 string content 逐字符迭代计 0，测试数值静默失真）；assistant 必填字段（api/provider/model/usage/stopReason）以 tsc 报错为准补齐 |
| `src/__tests__/pure.test.ts` | 改 | E2：新增口径断言用例（toolCall-only / thinking-only 消息 > 0） |
| `src/__tests__/tool.test.ts` | 不动 | E1-E4 均不触达（T2 移交项触达时由 code-simplify 同步 ：93 断言） |

不变量守护：`SmartContextDetails`（compaction entry details）、`SameModelCallResult` 判别联合、D13-5 缓存对齐约束（llm.ts 头注）、R2 降级态时序——全部不动。文档同步（C-proc-10）：删除符号（BeforeCompactLikeEvent 等）已 grep docs/ 零引用；`ext-simplify-index.md` 的「09 号行」**部分需实施时同步**（行号无关锚点：09 号行位于「设计文档清单」表第 9 数据行）——同行「C12 estimateShadowedTokens→SDK estimateTokens」是设计编号描述不受影响，但同行的裁决摘要「Like\*Event×5（contested→裁决：导入 SDK 类型+边界断言）」与本文档最终结论漂移（边界断言已被 §5.1 修正为「不可达、无需保留」），实施时将该行裁决摘要更新为「SDK 直标/省略标注推断、边界断言不可达」并顺带更新「待设计」状态；`docs/extensions/smart-context/design.md:296` D13-1 语义描述（「摘要 tokens ≥ 被压段 tokens」）在新口径下不变，无需回写；`node scripts/check-doc-symbol-drift.mjs` 由 pre-commit 把关。

## 7. 验收（真实场景，非单测非 mock）

**本章结论：改动规模「中」（1 项行为修复 + 类型归一 + 单行等价替换），用 4 个真实场景 + 1 个邻居不变量场景验收；单测仅作回归辅助，不计入验收。**（extension 改动按项目规约在本地 pi CLI 实测，不在 xyz-agent 桌面。）

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| 1 | 工具重会话压缩接管不被误拒（C12 行为修复主场景） | G1 | `XYZ_AGENT_DEBUG=1 pi --mode rpc --session-dir <tmp> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension extensions/universal/smart-context`，stdin JSONL 驱动 agent 连续读改 3-5 个真实文件（制造 thinking/toolCall 占主体的被压段）→ 触发 compact_context（或 /compact）→ 读 `~/.pi/agent/logs/` smart-context 日志与 session JSONL 的 compaction entry | compaction entry `details.engine === "smart-context"`（接管成立）；日志 `takeover ok` 行含 `summaryTokens` 与 `shadowedTokens` 两侧数值（E2 补记字段）且 `summaryTokens < shadowedTokens`；无 `summary inflated` warn；shadowedTokens 与被压段内容量级相称——对照 session JSONL 中被压段消息的字符量抽查（chars/4 量级，明显大于纯文本量即说明 thinking/toolCall 已计入） |
| 2 | 排除模型双入口行为一致（门控收敛等价性） | G3 | 同链路，配置 `excludedModels` 命中当前模型 → 分别触发 /compact 与调用 compact_context | /compact 走 pi 原生（日志无 takeover、entry 无 engine 标记）；compact_context 调用被拒且报错含恢复指引（既有行为）；两入口判定同源无分叉 |
| 3 | 类型归一编译与运行时冒烟 | G2 | `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 三连；另跑一次场景 1 会话覆盖 model_select（对话中切模型）与 agent_settled（提醒链路）事件 | 三连零红；会话中模型切换通知/阈值提醒/压缩接管三链路无运行时错误（事件 handler 仍被正确派发） |
| 4 | 宿主表面不变（邻居系统场景） | G4 | dev 应用设置页（SystemSmartContextSection）开关 smart-context、改 excludedModels 保存 → 检查 `smart-context-ext-config.json` 字段；打开场景 1 的 session 看 trace/用量页 | 配置文件四字段 schema 不变、设置页读写正常；compaction entry details（engine/mode/model）形状不变、用量归属显示正常；renderer 无新告警 |

回归辅助（不计入验收）：现有 compact-handler.test.ts 门控/收缩校验/熔断/cross-model 四组用例 + tool.test.ts 全套保持绿；口径断言新用例锁定 E2 的估算分母不再漏块（其中 toolCall-only 用例在旧实现下必为 0——用例对旧口径有判别力，非恒真断言）。

## 8. 实施

**分 3 个独立 commit 顺序交付，行为修复与类型归一分离，移交清单只登记不改码。**

### 8.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 | 独立验收 |
|---|---|---|---|
| M1 = U1 | E1 + E4（类型归一批） | G2 全部 | P1 typecheck + 场景 3 |
| M2 = U2 | E2（估算口径，含契约测试与 mock/fixture 调整） | G1 全部 | P2 + 场景 1 |
| M3 = U3 | E3（门控一行） | G3 全部 | 场景 2（可并入 M2 commit，若同批触达 compact-handler.ts） |

顺序理由：U1 先行使 `event.preparation.messagesToSummarize` 在调用点已是 SDK 精确类型（`CompactionPreparation` 字段），U2 重写时 `ReadonlyArray<Parameters<typeof estimateTokens>[0]>` 推导参数与调用点实参同型，无需任何边界 cast（审计方向中「宽松类型边界处一次收窄」的前提随 U1 消失）；U2 是唯一行为变更项，独立成批使场景 1 的验收归因干净；U3 单行等价随时可落。每阶段独立 commit；完成后跑 `pnpm extensions:typecheck && extensions:lint && extensions:test` 三连 + pre-commit 全量正面修复。

### 8.2 下一层拆分

| 单元 | 说明 | justification |
|---|---|---|
| U1 = M1 | E1+E4：SDK 类型归一（compact-handler/index/llm 三文件 + 测试 fixture） | 同一编译单元的类型变更拆开会留红窗口；typecheck 即验收，先行铺路 |
| U2 = M2 | E2：估算口径重写 + 口径契约测试 + mock 工厂调整 | 唯一行为变更项独立验收（场景 1），回滚面独立 |
| U3 = M3 | E3：门控谓词单行替换 | 单行等价替换，现有双用例背书，无独立风险面 |
| U4（登记） | T1-T6 移交清单交付 code-simplify | 非 contested low 不占本设计实施面；登记保证据链与行号锚点 |

### 8.3 待验证检查点（设计阶段无法确定，诚实标注）

- **projectTools 的 parameters cast 去留**：ToolInfo.parameters 与 LlmTool["parameters"] 均为 TSchema，预期 cast 可删，以 P1 typecheck 实际结果为准；报错则保留单点 cast + 注释（不阻塞）。
- **vitest 4 的 importOriginal 部分覆盖形态**（P2）：真实 estimateTokens 进入被 mock 的测试模块图后其余用例是否受影响，跑该文件定；降级路径见 P2 行。
- **测试 fixture 的合法消息形状**：`signal`（SDK 事件必填）与 message `timestamp`/assistant 必填字段（api/provider/model/usage/stopReason，pi-ai types.d.ts:302-320）的确切必填集以 tsc 报错为准逐个补齐；**禁止用 `as unknown as` 硬塞 string-content assistant**——新口径下 estimateTokens 对 string content 逐字符迭代无块匹配计 0 tokens（compaction.js 实装），口径断言用例会静默失去判别力，assistant content 必须是合法 block 数组（含 text/thinking/toolCall 块时数值才非 0）。数值等价性：makeEvent 默认 assistant 改为 `[{ type: "text", text: "y".repeat(4_000) }]` 后新口径仍计 1,000（text 块 chars/4），与旧口径数值等价。**fixture 形态约束：makeEvent 默认 assistant 的必填字段补齐仅限标量字段（api/provider/model/usage/stopReason），content 数组形态锁定为该单 text 块，实施者不得自行追加 thinking/toolCall 块**——追加块 tsc 合法且无守卫拦截，但会抬高 shadowedTokens 使本等价声明静默失效；若实施时偏离该形态，须重核本等价声明（D2 的口径断言用例不受此限——其 block 数组消息为用例自建，不依赖 makeEvent 默认值）。既有用例影响面（实测收窄）：现有用例全部为行为断言（`toEqual({})`/failStreak/details 形状/mock 调用参数），无一例断言具体 token 数值，行为分支判定不变（shadowed 增大只会让膨胀分支更易触发，判别方向单调，用例仍绿）；唯一数值敏感的收缩校验失败用例（compact-handler.test.ts:143-154）自行 override 被压段为纯 user 文本（:146 override messagesToSummarize），根本不依赖 makeEvent 默认 assistant 值。
- **index.ts:153 `event.model?.contextWindow`**：SDK 类型下 `model` 非可选，多余可选链若触发 lint 则顺手去掉（行为不变）。
- **场景 1 的偏差观察**：若需量化对比，可在 M2 前先跑一次记录旧口径 shadowedTokens（可选步骤，非门槛）。

## 附录：变更历史与溯源

- v1（2026-09-11）：初稿。来源 = over-engineering-audit 20260911 候选 12（C12）、候选 3 的 smart-context Like\*×5（contested 子项）、low 清单「smart-context 门控谓词双写」，及四问记录 `session-view-01a09070-77fd-74a1-a3ae-9e8c6640df3e.md` 发现 3/5/8 + Suggestions。全部 file:line 于 HEAD `2f78fac77` 实读复核；pi 断言以实装 0.84.4 dist 为准（npm ls 核对）。
- 审计修正记录：① 审计候选 3 称「pi 0.84.4 包根已导出全部具名事件类型」存在**两处**例外——`ModelSelectEvent` 与 `SessionBeforeCompactResult` 均仅在 `dist/core/extensions/index.d.ts:9` 导出，包根 dist/index.d.ts 全文 0 次出现，分别改走省略标注 + 上下文推断、返回类型省略标注 + 函数体推断（§5.1；第 2 处由第 1 轮影响面审查发现，tsc 探针 TS2724 实证）；② 审计对 Like\*×5 的「导入 pi 类型 + 边界一次断言」方向，经实读修正为「SDK 类型直标后边界断言不可达、无需保留」（§5.1）；③ 四问记录 Suggestions 称 `MAX_THRESHOLD_TIERS`「无收益」不准确——pure.ts:75 的 slice 截断用户配置超 3 档数组，删除属行为变更，T6 已标注需确认；④ 四问记录发现 5 的证据段自含矛盾（TraceToolbar.vue:22 命中），实读证实该处是 trace 统计 `stats.compactions` 而非工具 details，「零消费方」结论成立（§5.7 T2）。
- v2（2026-09-11，第 1 轮审查-修复循环）：按主审报告（`.review/ext-simplify-09.md`，1 must-fix + 1 suggestion）与影响面报告（`.review/ext-simplify-09-impact.md`，2 must-fix + 3 suggestion）逐条修复，全部方案性改动经 tsc 探针实证（探针临时文件已删除）：
  - **MF-A（影响面 MF1）**：D1 初版「`BeforeCompactDecision` → `SessionBeforeCompactResult` 直接换名 + factory 返回 `Promise<SessionBeforeCompactResult>`」被击穿——包根 0 导出（TS2724 探针）。重跑方案对比后选定「返回类型省略标注 + 函数体对象字面量推断」，深层路径 import（TS2307，exports 封锁）与本地结构类型锚定（D1-v3）记入被否谱系（§5.1 被否 D1-v1/v2/v3）；证据段「均在包根」清单修正；P1 探针降级路径补「符号不存在」失败模式。**反例重演**：原反例「按 D1 实施必编译红」在新方案下消灭——返回类型不再显式写任何包根缺席符号，推断链 generate→factory→on() 注册已由探针验证 exit 0。
  - **MF-B（影响面 MF2）**：D2 初版「参数类型 `ReadonlyArray<AgentMessage>`」被击穿——`AgentMessage` 包根 0 次出现，唯一来源 pi-agent-core 未声明依赖，hoisted 下幽灵 import 静默通过且无守卫拦截。选定零依赖方案 `Parameters<typeof estimateTokens>[0]` 推导（探针 exit 0）；名义 import（B3）与补 peerDep（B4，触碰 C-build-07 锚点）记入被否谱系（§5.2）。**反例重演**：原反例「幽灵依赖静默落库」在新方案下消灭——不 import 任何 pi-agent-core 符号，类型仍锚定 pi 实装签名且随升级自动跟随。
  - **MF-C（主审 MF）**：§7 场景 1 通过标准原引用 `shadowedTokens`，实读 compact-handler.ts:341 该值正向路径不可观测（仅拒绝路径 ：335-337 warn 落盘）——采纳审查方向①，E2 执行项补「:341 `takeover ok` debugLog 补记 shadowedTokens（一行）」，§4.1 终态日志、§5.6 E2、§6 文件地图、§7 场景 1 通过标准联动同步。
  - **S-1（主审 suggestion）**：fixture 清单补第三项「assistant content 形状」——makeEvent 的 string content 在 E1 后非法（AssistantMessage.content 纯 block 数组，pi-ai types.d.ts:307），且 as 硬塞 string 会被 estimateTokens 逐字符迭代计 0（compaction.js 实装），测试数值静默失真；§5.6 E2 / §6 文件地图 / §8.3 三处写明正确形态与禁令。
  - **S-2（影响面 suggestion）**：§5.2 补「口径不对称子场景显式判定」——抵消论证限定同族形态，不对称漏判窗口按四要素（量级/恢复路径/重审条件/显式判定）登记为已接受代价。
  - **S-3（影响面 suggestion）**：§5.7 T3 行补行为变化判定（跟随用户配置=修正错报；量级=提醒文案时机；重审条件=无）。
  - **S-4（影响面 suggestion）**：§6 文档同步段修正 index:19 判定——裁决摘要「导入 SDK 类型+边界断言」已漂移，实施时同步为最终结论并更新「待设计」状态。
- v3（2026-09-12）：第 2 轮审查-修复循环（聚焦复审 R1 suggestion 闭合）。输入 = `.review/ext-simplify-09-impact.md` 影响面聚焦复审 R1（0 must-fix / 1 suggestion）。逐条对账：
  - **S-1（§8.3 fixture 数值等价句）**：「content 单 text 块」隐含前提升格为 fixture 形态约束（makeEvent 默认 assistant 必填字段补齐仅限标量字段、content 数组锁定单 text 块、实施者不得自行追加 thinking/toolCall 块，偏离须重核本等价声明）；「既有用例数值断言不变」收窄为实测准确表述（现有用例全部为行为断言、无一例断言具体 token 数值；唯一数值敏感的收缩校验用例 compact-handler.test.ts:143-154 自行 override 被压段于 :146，不依赖 makeEvent 默认 assistant 值）。
  - 联动自查：局部声明修正，无机制改动；§5.6 E2 / §6 文件地图对 fixture 的既有描述与本约束一致（E2 的「assistant content 改合法 block 数组」即本约束来源形态，口径断言用例自建消息不受锁定影响），无联动点。
- v4（2026-09-12）：实施后一致性审查（阶段 3）doc_errors 修正：§6 的「ext-simplify-index.md:19」行号锚点错误（该行自文件创建起即在第 20 行），改为行号无关锚点「09 号行」；实施已按内容定位落在正确行，功能未受影响。
