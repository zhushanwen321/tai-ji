# ext-simplify-16：plugin-bridge 过度设计收敛 — 对抗式审查报告

> 审查对象：[ext-simplify-16-plugin-bridge.md](ext-simplify-16-plugin-bridge.md)（v1，2026-09-14）
> 审查方法：对抗式（默认怀疑方案不成立，逐项找反例；声称「失实」前必读源码）+ 事实核对 + 验收可证伪性 + 内部一致性
> 审查日期：2026-09-14。审查基准 = 当前 worktree 源码：plugin-bridge / extension-protocol / runtime plugin-service / plugin-sdk 自 16d69407a（13 号收尾微修）与 c79cd621c（版本 bump）后零源码改动，worktree 干净——设计引用的现状未被改变，无设计↔源码漂移。

## VERDICT: NEEDS-FIX (must-fix 1 / suggestion 4)

**总评**：设计的事实底座是本系列迄今最扎实的一份——30+ 处 file:line 引用逐条核实，pi 实装四处断言（session-manager.js:720-722 / types.d.ts:219 / pi-agent-core harness messages.d.ts:18-25 / pi-ai types.d.ts:237-241）**全部逐字精确命中**，四个「零供给/零消费」声称经独立全仓 grep 复核全部成立，退役设计 git 原文四项援引（推荐 A string-only / r1 MF-1 定案原文 / D5 守卫表 / D2 行为闭环）逐字核对无误。D1-D6 六个裁决反向攻击后全部站得住——尤其 D1 的「结构性不可达」经最深一层验证成立：hook-pipeline 的 injectedMessages 全部写点收敛于 `string[]` 累积，透传分支连理论可达路径都不存在。唯一必须修的问题在执行面：**D2 的删除点清单（§6.2）与 u1/u2 领地划分（§6.7/§8.2）不闭合**——桥侧 :257 注释与 extensions 侧测试 fixtures 被 §6.2 点名为删除点，但 u2 领地列不含 extensions 包、u1 内容列不含 D2，且 N1 的「生产代码零命中」断言范围抓不住这两处漏网。这是实施者按字面派发 subagent 必然踩中的矛盾。

---

## 1. 事实核对表

判定口径：属实 = 声称的现状在源码中存在且行号基本准确（±3 行内不误导）；失实 = 源码中不存在；部分属实 = 主体成立但有影响理解的偏差。

### 1.1 桥侧 src/index.ts（483 行 ✓）

| # | 设计声称 | 核实结果 | 判定 |
|---|---|---|---|
| 1 | §1 生产代码仅 src/index.ts 483 行 + 2 测试文件 734 行 | wc 实测 483；forwarding.test.ts 344 + sync-and-registration.test.ts 390 = 734 | 属实 |
| 2 | §1 三条硬约束头注释 :8-18 | :8-18 逐条在（factory 禁顶层 await / observe fire-and-forget / timeout 分档 Gate B 修正） | 属实 |
| 3 | §3.1 注入映射三路 :463-475、透传分支 :463-467、接口 :99-109、守卫 :111-117 | map 回调 463-476；`if (isTextContent(content) \|\| isImageContent(content)) return content` 在 :467；InjectedTextContent :99-102 / InjectedImageContent :105-109；isTextContent :111-113 / isImageContent :115-117 | 属实 |
| 4 | §3.1 零供给三层：管线层 string-only（hook-pipeline.ts:96/:248-252）+ 桥侧守卫不可达 + 测试自造供给（forwarding.test.ts:295-313） | hook-pipeline.ts:96 `const injectedMessages: string[] = []`；collectInjectedMessages（:243-259）对非 string 条目丢弃 + warn（含 pluginId+序号）；bridge-interop.ts:259 恒产 `{content}`（string 进包装）；透传测试 :294-313 的 image/text 结构化回包确为测试自造 | 属实 |
| 5 | §3.2 commands 六行表（types.ts:49 / plugin-types.ts:103 / bridge-interop.ts:152 / bridge-handler.ts:91 / index.ts:257 / fixtures :58 等） | 逐点核实全部命中：协议 :49、runtime :103、构造 `{tools, commands: [], success: true}` :152、fallback :91、桥侧注释 :257、SYNC_PAYLOAD `commands: []` :58 | 属实 |
| 6 | §3.2 零消费者（pi 侧走 getCommands；bridge-rewrite §3.3-D7 已删消费分支） | isBridgeSyncPayload（:71-73）只查 `success`+`tools`；registerToolsFromPayload 不读 payload.commands；bridge-rewrite-pi-0.84.md:231「commands 分支删除（死代码）」原文在 | 属实 |
| 7 | §3.3 isToolNotFound :121-125 双形态；生产点全仓仅 bridge-interop.ts:167 形态②；error 形态零供给 | 函数 :121-125；全仓 grep「Tool not found」生产点唯一 :167 `{content, isError:true}`；bridge-handler 三处 error 产出（:78 catch-all `String(e)` / :165 malformed / :176 unknown method）均非该前缀；hook-pipeline 无关联；ADR-0012 无「Tool not found」登记 | 属实 |
| 8 | §3.3 测试 :205-215 error 形态自造供给、:187-203 形态②用例 | :205 `it("Tool not found 的错误闭环形态（{error}）同样触发重同步"...`（fixture `{error: "Tool not found: sleep-tool"}`）；:187 形态②用例在 | 属实 |
| 9 | §3.5 details 四 kind :176-184、三构造器 :186-216、ok 内联 :360-365、:174 失实注释 | 接口 :176-184；cancelledResult/errorResult/unexpectedResult :186-216；ok 内联 :360-365（`details: { kind: "ok", result: raw }` 与 content[0].text 全量重复 ✓）；:174「session-manager 同款：details 供下游消费」原文在 | 属实 |
| 10 | §3.5 session-manager 经 15 号 u2 已收敛 details: undefined（session-manager/src/index.ts:97-126） | executeTool 返回类型 `details: undefined`（:97）+ 三处构造全 `details: undefined`（:103-126）；15 号文档 :196 B1 行登记 u2=56a8ea995 ✓ | 属实 |
| 11 | §3.5 details 流转存在但零读取方（registry.ts:635-637） | details 流转证实：core effects/registry.ts :640 `const details = entry.message.details` → :662 条件写入 toolCall.details；`details.kind` 全仓对 plugin 工具零读取方（cw-tool/subagent-workflow 的 `details.ok` 是各自工具的独立 details 形状，非本联合） | 属实（注：引证锚在 :635-637 注释块，details 读取实际在 :640/:662，同句柄不误导；deriveToolCallEndOverlay 本身只读 content） |
| 12 | §3.6 getSessionId :164-172 + 4 调用点 :343/:380/:398/:438 | 函数 :164-172；四调用点逐行精确命中（forwardToolExecute/observeHandler/session_start/before_agent_start） | 属实 |
| 13 | §7 callBridge :131-162「调用方 4 处（sync/execute/event/intercept）」 | callBridge :131-162 ✓；但文本调用点实为 **5 处**：syncOnce :272、forwardToolExecute :336、observeHandler :376、session_start handler :394（自带一笔 event 转发，非经 observeHandler）、before_agent_start :432。按四类语义口径成立，按文本点计数少 1 | 部分属实（口径未注明，不影响折叠语义结论） |
| 14 | §7 形状守卫族 :58-93 共 6 个 ↔ bridge-handler :78/:92/:105/:151 逐一对应 | 守卫 6 个（isRecord 外）:63/:67/:71/:75/:80/:91；对端产出点 :78（catch-all error）/ :92（sync 回包）/ :105（`{content:'Plugin system not available', isError}`）/ :151（intercept 回包）全在 | 属实 |
| 15 | §7 事件显式注册 ×8 :404-411；sync-and-registration.test.ts:253-299 防抖+兜底 | :404-411 恰 8 个 pi.on；测试 :253 防抖用例 + :265 registerTool throw 兜底用例（unhandledRejection 断言）精确命中 | 属实 |

### 1.2 协议 / runtime / plugin-sdk

| # | 设计声称 | 核实结果 | 判定 |
|---|---|---|---|
| 16 | §1 marker.ts 17 行 + types.ts 65 行 | wc 实测 16 / 64 | 部分属实（±1 行，机械性偏差不误导） |
| 17 | §3.4 协议 types.ts:33-35「runtime 是实现侧权威」注释；:47-51/:49/:41-44/:54-58 形状 | :33-35 注释逐字在（含「逐字段对应…同步此处」）；BridgeSyncPayload :47-51（commands :49）、BridgeToolExecuteResponse :41-44、BridgeInterceptResponse :54-58 全命中 | 属实 |
| 18 | §3.4「与同文件头『协议 v2 形状 SSOT 在 extension-protocol』自相矛盾（两个权威）」 | 矛盾实体成立，但「同文件头」定位失准：types.ts 文件头（:1-8）无 SSOT 表述，该引语在 **plugin-bridge src/index.ts:4-5**（「协议 v2 形状 SSOT 在 @xyz-agent/extension-protocol…」）及 workspace 文档——跨文件矛盾被写成了同文件矛盾 | 部分属实（不影响 D4 方向；D4 单源化后矛盾整体消失） |
| 19 | §3.4 SDK Bridge* 消费面仅 runtime plugin-types re-export 链一条 | 全仓 grep：interfaces.ts:669/:671（经 plugin-types.js 类型引用）、bridge-interop.ts:13、plugin-service.ts:2——全走 plugin-types 链；无其他 import 方；SDK 为 `"private": true`（package.json:5）、当前零依赖 | 属实 |
| 20 | §3.4 runtime「BridgeSyncPayload 依赖 service port 不上收」理由失实（:7-8 vs :101-105 纯数据形状） | plugin-types.ts:7-8 原文在；现行定义 :101-105 纯 `tools/commands/success`，无任何 port 引用；SDK types.ts:512「已在 sync 时从 SDK 剥离」注释与 SDK 内零残留互证 | 属实 |
| 21 | §6.4 D4 依赖三声明：协议零依赖、runtime 已依赖（package.json:18）、SDK 零依赖转一依赖 | extension-protocol package.json 仅 devDependencies（tsup/typescript/vitest）；runtime package.json:18 `"@xyz-agent/extension-protocol": "workspace:*"` 逐字命中；plugin-sdk 无 dependencies 块。且 runtime tsup.config.ts:57 noExternal 已同时含 `@xyz-agent/extension-protocol` 与 `xyz-agent-plugin-sdk`——CP2「零影响」预期成立 | 属实 |
| 22 | §6.4 runtime 引协议先例（13 号 utils/protocol-background-task.ts） | 该文件 :32 `from '@xyz-agent/extension-protocol/background-task'` 在 | 属实 |

### 1.3 pi 实装断言（npm ls 实装 0.84.4 ✓）

| # | 设计声称 | 核实结果 | 判定 |
|---|---|---|---|
| 23 | §3.6 dist/core/session-manager.js:720-722 `getSessionId()` 纯字段读 | :720 `getSessionId() {` / :721 `return this.sessionId;` / :722 `}` ——逐行逐字命中 | 属实 |
| 24 | §3.6 types.d.ts:219 `sessionManager: ReadonlySessionManager` 非可选 | dist/core/extensions/types.d.ts:219 逐字命中（ExtensionContext 内，无 `?`） | 属实 |
| 25 | §3.1 CustomMessage.content 契约 pi-agent-core/dist/harness/messages.d.ts:18-25 | :18 `export interface CustomMessage<T = unknown> {` … :21 `content: string \| (TextContent \| ImageContent)[]` … :25 `}`——范围与 content 行号（§4.1 引 :21）双精确 | 属实 |
| 26 | §4.1 终态产出满足 TextContent[]（pi-ai types.d.ts:237-241） | :237 `export interface TextContent {` / :238 `type: "text"` / :239 `text: string` / :240 textSignature? / :241 `}`——精确命中；BeforeAgentStartEventResult（pi types.d.ts:845-849）单 message 槽位 ✓ | 属实 |

### 1.4 跨设计前提与登记

| # | 设计声称 | 核实结果 | 判定 |
|---|---|---|---|
| 27 | §3.1 退役设计「推荐 A：string-only 注入」+ D5 守卫表（管线层丢弃+warn） | git `7a3797d0b:docs/design/plugin-intercept-injection.md` 存在：:139 方案对比表 / :147「**推荐 A（长期方案）**」/ :180 D5 形状守卫 / :254 I2「非 string 条目丢弃，warn 含 pluginId+序号」 | 属实 |
| 28 | §6.1 被否栏 c：r1 审查 MF-1 定案原文「runtime 侧组装仍按 `{content}` 单键形态产出（与守卫预期对齐）」 | 退役设计 :170 逐字命中（「协议层**不收紧**…runtime 侧组装仍按 `{content}` 单键形态产出（与守卫预期对齐）」）；fadd8b8b4（退役 commit）存在 | 属实 |
| 29 | §7 blocked 透传非死代码（退役设计 D2 行为闭环） | 退役设计 :164「block 插件自身的合法注入进已累积…阻止后续插件与向 LLM 留言互不吞没」+ bridge-interop.ts:261-267 实装互证 | 属实 |
| 30 | §1/§6.1 bridge-rewrite §3.2 对比三 a「类型零丢失」承诺待降格；§3.3-D7 裁决援引 | bridge-rewrite-pi-0.84.md:169 原文在（含「类型零丢失 ✅核实 pi-agent-core/dist/harness/messages.d.ts:18-25」）；:231 D7「commands 分支删除（死代码）」在 | 属实 |
| 31 | 开篇 C：2026-09-11 审计登记 M21 contested + 3 low | ext-simplify-index.md:30 原文在（M21 contested→设计裁决 + low 三项：commands 恒空 / isToolNotFound error 分支 / 跨包形状一致性测试） | 属实 |
| 32 | §6.2「15 号 u1 先例：单 commit 跨 4 包 8 文件」；§3.5「15 号 u2 details 收敛」 | 15 号文档 :156（u1=6d73d3399，单 commit 跨 4 包 8 文件）与 :196（B1 details 清理，u2=56a8ea995）双命中——两个 unit 编号援引均准确 | 属实 |
| 33 | §1 plugin-bridge v0.2.2、infrastructure tier | package.json version 0.2.2；mandatory-extensions.json:19 tier=infrastructure | 属实 |

**伪问题计数：0。**33 组声称无一失实；两处部分属实均为定位/口径偏差（#13 计数口径、#18 引语位置），不动摇任何裁决。

---

## 2. must-fix

### MF1：D2 删除点清单与 u1/u2 执行项领地划分不闭合——桥侧 :257 注释与 extensions 侧 fixtures 无归属，且现有验收抓不住漏网

- **设计文档位置**：§3.2 表 + §6.2 删除点清单 vs §6.7 执行项总表 + §8.2 拆分清单 + §8.1「u1/u2 无依赖可并行」+ §7 N1。
- **源码/文档证据**：
  - §6.2 删除点共 6 类，明确包含：**「桥侧 :257 注释」**（extensions/taiji/plugin-bridge/src/index.ts:257）与**「测试 fixtures（sync-and-registration.test.ts :58/:191-207 等）」**（extensions 包测试，实测 `commands: []` 在 :58 与 :209 两处 fixture）。
  - §6.7 **u1 行**内容列只列 D1/D3/D5/D6（对应 §6.1/§6.3/§6.5/§6.6），**不含 D2 任何部分**；**u2 行**领地列写「extension-protocol + runtime + plugin-sdk」——**不含 extensions 包**。
  - §8.2 u2 明细把「相关测试 fixtures」挂在 runtime 名下（runtime 侧 fixture 实测在 bridge-marker-channel.test.ts:58、plugin-hooks-integration.test.ts:193，这些确实归 u2）；u1 对 sync-and-registration.test.ts 只登记「D1 测试重写 / D3 用例删除 / D5 断言调整」，**无 D2 fixture 清理**。
  - §8.1 又声明「u1/u2 无依赖可并行（…双端同 commit 纪律只在 u2 内部）」——而 §6.2 的「双端同 commit」按其自身定义要覆盖桥侧（D2 标题即「双端删除」，§3.2 标题「协议死面双端删除」），桥侧却在 u1 领地。两单位并行时，同 commit 纪律物理上无法跨领地兑现。
- **为什么必须修**：这是实施契约级的自相矛盾，三种读法各有坏结局——①严格按领地表执行：extensions 侧两处删除点（:257 注释、:58/:209 fixtures）成为孤儿，静默残留；②宽读 u2「测试 fixtures 同 commit」含 extensions：则 sync-and-registration.test.ts 同时被 u1（D1/D3/D5）与 u2（D2 fixtures）认领，两个并行 subagent 改同一文件，「无依赖可并行」前提直接失效；③漏了也没人抓：N1 断言范围是「commands 在协议/runtime/bridge **生产代码**零命中」——:257 是注释、fixtures 是测试代码，均不在断言范围；A4 回归也不会红（`isBridgeSyncPayload` 只查 success+tools，fixture 残留 `commands: []` 无行为影响，:191 的「commands 恒空被忽略」用例在字段删除后照常绿——测试守卫的是「不消费」，字段消失后该用例本身已失去存在意义，设计未登记其去留）。注释悬空 + fixture 残留正是本系列要消灭的「带注释承认死亡的活协议面」换个形态还魂，且 C-proc-10 的 check-doc-symbol-drift 不覆盖测试 fixture。
- **建议修法**（任选其一，同步修正 §6.7/§8.1/§8.2 三处）：
  1. **推荐**：把 :257 注释与 extensions 测试 fixtures 明确划入 **u2**（u2 领地列补 extensions/taiji/plugin-bridge 两文件），u1/u2 改为「同批不同 commit」或声明 u1 与 u2 的 extensions 侧改动有文件级依赖需串行——保住 §6.2 的双端同 commit 纪律；
  2. 或：两处划入 **u1**（§6.7 u1 行补「+ D2 桥侧 :257 注释与 fixtures 清理」），§6.2 的「同 commit」放宽为「双端同 PR/同批」，并接受构造点删除与桥侧注释删除之间短暂中间态（无行为风险——注释与 fixture 不参与运行时）；
  3. 同时登记 :191「commands 恒空被忽略」守护测试在 D2 后的处置（删除或改写为「未知键忽略」并注明理由），N1 断言范围同步扩为「协议/runtime/bridge 的类型、构造点、注释、fixtures 全部零命中」。

---

## 3. suggestion

### S1：§7 A1 的第③判据与 A3 的取证通道指向不存在的产出物

- **位置**：§7 A1（「runtime 日志见 `bridge:tool_execute` 往返」）与 A3（「sync 负载无 `commands` 键（pi 侧 JSONL debug 留痕验证）」）。
- **证据**：
  - runtime 对 tool_execute 成功路径**无任何日志点**：bridge-handler.ts 唯一 console.log 是 `bridge:event`（:127），其余为 error/warn 路径（:73/:81/:161/:173）；plugin-service.handleBridgeToolExecute（plugin-service.ts:764）无日志；桥侧 callBridge 成功路径无日志。
  - 「pi 侧 JSONL debug 留痕」不存在：sync 回包走 runtime→pi **stdin**（bridge-handler.ts:92 `sendExtensionUiResponse`）；AGENTS.md 的 tee 只捕 pi **stdout**（= pi→runtime 请求向，sync 请求 `{method:'bridge:sync'}` 本身无负载）；pi rpc-mode 对 extension_ui_response 是静默 resolve（pi-coding-agent dist/modes/rpc/rpc-mode.js:616-624，无日志）；桥侧扩展对 sync 只 log 计数（`synced N plugin tool(s)`）不 log 负载。按字面执行 A3 找不到任何可看的留痕。
- **建议**：A1 ③ 改指真实可观测物——「pi stdout tee（`<dataDir>/logs/pi-*.jsonl`）中 `bridge:tool_execute` 请求帧 + session JSONL 的 toolResult echo 内容（回程证据）」，或声明「实施期加临时探针日志，验收后移除」；A3 的通过标准改由「runtime 单测断言 `getSyncPayload()` 返回键集恰为 `{tools, success}` + N1 负面 rg」承担（A1 的端到端 sync 成功已覆盖消费方透明性）。

### S2：u3 文档同步清单缺 bridge-rewrite :208/:238 的 miss 形态描述修正

- **位置**：§6.7 u3 行 / §8.2 u3。
- **证据**：bridge-rewrite-pi-0.84.md:208（「收到 `{error: 'Tool not found: ...'}` 时，触发一次重新 sync」）与 :238（E2 行「`isError: 'Tool not found: <name>'`」）以 **error 形态①** 描述 miss 行为——这正是 isToolNotFound 双形态的历史来源。D3 删 error 分支后，这两处描述与实装（形态②，bridge-interop.ts:167）及 D3 后的桥侧判定不一致，属于本设计自己在 §3.3 定性过的「设计文档与实装形态错位」。u3 现清单只覆盖 §3.2 降格 + §3.3-D7 关闭登记。
- **建议**：u3 补一项：bridge-rewrite :208/:238 的 miss 形态描述改为形态②（或加注「D3 收窄登记：桥侧仅识别形态②」），与 u1 同批落。

### S3：u2 注释同步清单漏 plugin-types.ts:3-5 头注释（D28 叙事将双重失真）

- **位置**：§6.4（「1 段失实理由注释（plugin-types.ts:7-8）」）。
- **证据**：plugin-types.ts:3-5 头注释自述「single source of truth = packages/plugin-sdk/src/types.ts（对外发布契约，**零依赖自包含**）」。D4 落地后该句双重失真：①SDK 增加了对 extension-protocol 的依赖（不再零依赖）；②Bridge* 三形状的定义源移至 extension-protocol（SDK 对这些形状不再是 SSOT）。设计只点名了 :7-8 的「service port」理由段，:3-5 的 D28 叙事段漏登记——恰是 C-proc-10 要防的注释漂移。
- **建议**：u2 的 plugin-types.ts 改动面补 :3-5 注释同步（如「Bridge* 形状 SSOT 在 @xyz-agent/extension-protocol（D4 单源化）；SDK 保留插件作者契约面 re-export」），SDK 侧 types.ts:512 剥离注释经核仍然为真（BridgeSyncPayload 确不在 SDK）无需动。

### S4：CP1 检查面补「SDK 的 workspace 外消费形态盘点」

- **位置**：§8.3 CP1。
- **证据**：SDK 是 `"private": true`（package.json:5）无发布面，workspace 内消费面已核实仅 runtime 一条链——D4 依赖方向成立。但 D4 后 SDK 的 `BridgeToolExecuteResponse`/`BridgeInterceptResponse` 变为指向协议包的 re-export：任何能在类型层解析 SDK 的环境，都必须连带可解析 `@xyz-agent/extension-protocol`。若存在 workspace 外以 `file:`/link 形态引用 SDK 的插件开发流（如 dsh-test playground 仓），其类型解析面会变宽。CP1 已有「零依赖断言检查则回退」的兜底，但未点名这个消费形态面。
- **建议**：CP1 执行时加一步盘点（grep 仓外已知消费方 / 确认 SDK 引用方清单恒为 workspace 内）；空集即关闭，非空则触发 CP1 的回退方案（SDK 维持本地定义，D4 收窄为 runtime+协议双包单源化）。

---

## 4. 已核实无问题（防重复怀疑）

以下检查过且通过，附证据快照：

1. **四个「零供给/零消费」声称全部经独立 grep 复核成立**：①`Tool not found` 生产点全仓唯一 = bridge-interop.ts:167（形态②；bridge-handler 三处 error 产出与 docs 无该前缀生产登记，ADR-0012 无登记）；②`commands` 消费面 = 协议/runtime 两处定义 + 两处恒空构造 + 桥侧不消费 + 测试 fixture，无读取方（isBridgeSyncPayload :71-73 只查 success+tools）；③`details.kind` 全仓零读取方（cw-tool :38/:80/:115 与 subagent-workflow tool-workflow-script.ts:146 的 `details.ok` 是各自工具的独立 details 形状，非本联合；仅 forwarding.test.ts 断言引用）；④SDK Bridge* 消费面单链 = interfaces.ts:669/:671 + bridge-interop.ts:13 + plugin-service.ts:2，全经 plugin-types re-export。
2. **D1「结构性不可达」最深一层验证成立**：hook-pipeline.ts 的 injectedMessages 全部写点（:96 声明、:120 applyInjectionCollection→:190 collectInjectedMessages、:123 buildBlockedResult→:218 透传同一 `string[]` 累积、:149 回包赋值）全部收敛于 `string[]`——bridge-interop.ts:259 恒产 `{content: string}`，桥侧 isTextContent/isImageContent 的输入恒为 string，透传分支连理论可达路径都不存在（非仅「当前无供给方」）。
3. **D4 依赖方向完全成立**：extension-protocol 零运行时依赖（仅 devDeps，无环）；runtime 已依赖（package.json:18）；plugin-sdk 零依赖转一依赖、private 无发布面；runtime tsup.config.ts:57 noExternal 已同时含两包（打包链零新增面）；类型 re-export 构建期擦除，对 extensions esbuild bundle 零影响；CP1 回退方案（半程单源化）完备且成本可控。
4. **D6 依据双精确 + 行为等价成立**：session-manager.js:720-722 与 types.d.ts:219 逐字命中；catch 本就不拦 `undefined` **返回**（只拦 throw）——即便 sessionId 字段理论性为 undefined，直呼与现 catch 路径返回值相同；「无行为变化」在类型契约前提下严格成立。测试 harness 恒供 sessionId（forwarding.test.ts:41 / sync-and-registration.test.ts:50）✓。
5. **A.5 不采纳裁决成立**：MF-1 定案原文（退役设计 :170）确实已裁决过 `{content}` 包装↔守卫形态且给出成本论证（「协议层不收紧…运行时守卫已承担实际约束」）；被否栏 c 的「净删除量 ~6 行」估算合理（bridge-interop :259 的包装 map + 桥侧 :91-93 守卫 + :458 filter）。将其登记为未来结构化注入立项时的合并议题（届时协议收紧、包装/守卫删除、透传恢复三案合并）是正确的批次划分。
6. **D5 精化收敛有据**：ok 变体重复实证（`details.ok.result.content` ≡ `content[0].text`，:360-365）；三失败 kind 均 isError:true 不可从 isError 派生（:186-216 三构造器逐一核对）；unexpected kind 的 response 原样保留恰好覆盖 §5.2「回包形状异常」排查场景——小取舍（排查改看 content/runtime 日志）与保留面自洽；「session-manager 同款」注释失实声称成立（#10）。
7. **内部一致性（除 MF1 外）通过**：六个死面（§3.1-3.6）↔ D1-D6 ↔ §6.7 三行 ↔ §8.2 三单元 ↔ 附录 A.1-A.6 映射自洽；一句话结论/开篇 C/§2 目标六项口径统一；「15 号 u1/u2」两个编号援引均与 15 号文档一致；非目标四项与 D1 被否栏 c、A.5、§2 SDK worker 类型保留清单（BridgeSyncRequest/BridgeSyncResponse/BridgeState/BridgeToolExecuteRequest 实测在 SDK :722-750）互洽；§2「不动 bridge-handler/bridge-interop 路由与塑形逻辑」与 u2 删这两文件的**死字段构造**不矛盾（逻辑不动、数据面删除，且 u2 领地已显式列名）。
8. **验收骨架可判定**：A1①②（模型工具清单 + echo 内容/isError 缺省，session JSONL 可判）、A2（fixture 注入 → plugin-inject CustomMessage.content 形态断言，session JSONL 可判）、N1/N2（负面 rg + fallback 序列化单测，机械可执行且诚实声明「生产不可达路径以单测兜底」）、A4（extensions 三连 + runtime plugin-service 测试）、CP3（复用「重开渲染」既有口径）——§7 唯二取证通道问题已由 S1 覆盖。fixture 机制「Gate B V 系列同款」有据（bridge-rewrite :306 V 系列探针记录）。
9. **行号可信度**：33 组核对中 31 组精确或 ±3 内；最宽偏差为 bridge-interop 注释引用（:255 引作 :259，±4，落点为同一函数的实现行，不误导）。marker.ts/types.ts 行数 ±1 为机械性偏差，不影响任何引用有效性。
10. **设计自身对边界外问题的处置诚实**：P3 备查（forwardToolExecute 把通道异常折叠为「cancelled.」文案）自行登记移交、不顺手改；u2/CP2 对 bundle 链敏感度给出预期与复核动作；版本 bump/changeset 明确出执行面（B 组既定纪律）。

## 5. 结论

- **A 事实核对**：33 组声称逐条核实，0 伪问题、0 失实，2 组部分属实（计数口径/引语定位，不裁决性）；pi 实装断言与退役设计 git 原文全部逐字成立。
- **B 方案有效性**：D1-D6 六个裁决经反向攻击全部成立，D4 依赖方向与构建链无隐患；唯一 must-fix 在执行项表的领地划分与 D2 删除点清单不闭合（MF1），属实施契约矛盾而非方案矛盾。
- **C 方案自身过度设计检查**：无。全部为删除/单源化/去重，零新增机制；A.5 不采纳与 D3「协议层不收紧」援引均忠于已审查定案原文。

修复 MF1（补齐 :257 注释与 extensions fixtures 的单位归属 + N1 断言范围）并顺带处理 S1-S4 后，本设计可进入实施。

---

## r1 修复聚焦复审（R2）

> 复审对象：[ext-simplify-16-plugin-bridge.md](ext-simplify-16-plugin-bridge.md) **v1.1**（变更历史逐条登记 r1 全修）
> 复审范围：仅验证 r1 五项修复（MF1/S1-S4）是否正确落地、是否引入新矛盾，不重新全量审查。复审基准 = 当前 worktree 源码；r1 已核实且 v1.1 未改动的声称（§3 现状表行号、D1-D6 依据、pi 实装断言等）引用 r1 结论不重复核实。
> 复审日期：2026-09-14

VERDICT: PASS（must-fix 0 / suggestion 1 残留）

### 1. 逐条验证

#### 1.1 MF1 闭合 —— 通过

| 验证点 | 判定 | 证据 |
|---|---|---|
| §6.2 删除点按领地重写 | ✓ | v1.1 §6.2（:179）u2 列协议 types.ts:49 / runtime plugin-types.ts:103 / bridge-interop.ts:152 构造 / bridge-handler.ts:91 fallback / runtime fixtures（bridge-marker-channel.test.ts:58、plugin-hooks-integration.test.ts:193）；u1 列桥侧 :257 注释 + sync-and-registration.test.ts :58/:209 fixtures + :191-198 守护用例删除。源码复核：:257 注释逐字命中（「commands 恒空忽略（设计 §3.3-D7……死代码不复制）」）；sync-and-registration.test.ts:58 fixture、:191-198 用例块精确（`it` :191 起、`}` :198 止，块内 :196 注释随用例整体删除无孤儿）；runtime 侧两 fixture 锚点 :58/:193 均精确命中 |
| §6.7 u1 行含 D2 尾巴 | ✓ | :219 u1 内容列「+ D2 桥侧尾巴（:257 注释、fixtures :58/:209、:191 守护用例删除）」，对应 §6.2 |
| §8.1 同批同 PR + 零交集 | ✓ | :260「同批同 PR」+「文件级零交集：u1 持 extensions 三文件、u2 持协议/runtime/plugin-sdk」。独立核对领地：u1 = extensions/taiji/plugin-bridge 的 src/index.ts、src/__tests__/forwarding.test.ts、src/__tests__/sync-and-registration.test.ts；u2 = packages/extension-protocol types.ts + packages/runtime 的 plugin-types.ts / bridge-interop.ts / bridge-handler.ts / test/bridge-marker-channel.test.ts / test/plugin-hooks-integration.test.ts + packages/plugin-sdk 的 types.ts / package.json——两集合无任何同文件交叉（路径逐一 find 确认）。u3 触达的 bridge-interop.ts:254-258 注释已显式写「随 u2 改动面顺手修正」（:266），不破零交集。r1 MF1 的三种坏结局读法全部消除：孤儿删除点已划归（u1）、并行改同文件已排除（零交集）、漏网可抓（N1 扩面） |
| N1 扩面 | ✓ | :242「`commands` 在协议/runtime/plugin-sdk/bridge 四包的**类型、构造点、注释、测试 fixtures 全部零命中**」——超出 r1 原建议的三包范围（含 plugin-sdk），只宽不窄 |
| :191 守护用例处置理由 | ✓ | §6.2（:179）登记「删除……字段消失后守护对象不复存在；改写为『未知键忽略』属无新生需求的投机守卫，不设——`isBridgeSyncPayload` 本就不查未知键」。理由与源码一致（守卫 :71-73 只查 success+tools，r1 #6 已核），删除优于改写论证成立 |

#### 1.2 S1 —— 通过

- **A1③ 已删且理由属实**：v1.1 :239 删「runtime 日志见 bridge:tool_execute 往返」判据，注明「runtime 对 tool_execute 无日志点，取证通道不存在」。独立复核 bridge-handler.ts 全文：tool_execute 路径（sendBridgeToolExecute :96-118）零日志点；全文件 console 仅 :127（`bridge event`）/ :73、:81（error 路径）/ :161、:173（warn 路径）——删除理由成立。
- **A3 改挂真实观测物**：v1.1 :241 通过标准 = 插件工具注册成功 + `XYZ_AGENT_DEBUG=1` 下桥侧 extension-logger 输出 `synced N plugin tool(s)`。复核 src/index.ts:290 `logger.debug(\`[plugin-bridge] synced ${result.tools} plugin tool(s)\`)` 逐字命中，观测物真实存在。
- **「sync 回包经 pi stdin 不在 stdout tee」声称合理**：bridge-handler.ts:92/:117 回包走 `client.sendExtensionUiResponse`，:75-77 注释自证「内部走 sendRaw 直接写 stdin」；stdout tee 捕的是 pi→runtime 请求向（AGENTS.md 日志约定），sync 请求帧 `{method:'bridge:sync'}` 本身无负载——真机确无该负载取证物。「负载无 commands 键」诚实转由 N1 rg + u2 单测承担，处置正确。

#### 1.3 S2 —— 部分落地（1 处残留，维持 suggestion）

- **已落地**：v1.1 :266 u3 补「:208 miss 形态描述 `{error: 'Tool not found: ...'}` 同步为实装形态 `{content, isError: true}`——该处是 isToolNotFound 双形态的历史来源」。复核 bridge-rewrite-pi-0.84.md:208 现文确为「收到 `{error: 'Tool not found: ...'}` 时，触发一次重新 sync」——声称属实。
- **残留**：r1 S2 点名 **:208 与 :238 两处**，v1.1 只登记 :208。:238（E2 行）现文「`isError: 'Tool not found: <name>'`」仍是失真形态（isError 布尔位挂了 content 文案；同文档 :191 实施注记自证「`isError` 是 extension 侧约定字段……LLM 判错实际依据 content 文本」，:238 与 :191 本就互斥）。D3 落地后若 u3 只按清单修 :208，错误规格表 E2 行仍与实装错位——恰是本设计 §3.3 定性的「设计文档与实装形态错位」及 C-proc-10 防的注释/文档漂移。
- **分级**：不阻塞实施（:238 是退役设计文档的速记失真，不在任何代码删除面上，不影响 D3 裁决与 u1/u2 执行），维持 suggestion：u3 清单补登 :238 E2 行形态同步（改为 `{content: 'Tool not found: <name>', isError: true}` 或加注 D3 收窄登记）。

#### 1.4 S3 —— 通过

v1.1 :265 u2 补「plugin-types.ts:3-5 头注释的 D28『SDK 零依赖自包含』叙事与『仅保留两个 runtime 专属内部类型』清点随 D4 同步」。复核 packages/runtime/src/services/plugin-service/plugin-types.ts:3-5 现文「（D28 方向反转，2026-09-05）：single source of truth = packages/plugin-sdk/src/types.ts（对外发布契约，零依赖自包含）」、:7-8「仅保留两个 runtime 专属内部类型（BridgeSyncPayload / IPluginServiceDeps，依赖 runtime 内部 service port……）」——两处引语逐字命中，同步项登记完整（D4 后 :3-5 失去「零依赖」与「SSOT 在 SDK」两重真实性，:7-8 失去「port 依赖」理由，均在清点范围）。

#### 1.5 S4 —— 通过

v1.1 :270 CP1 补「并盘点 SDK 在 workspace 外的既有消费形态（file:/link / 打包内嵌等），确认 re-export 协议类型不使类型解析面意外变宽」，与既有「零依赖断言检查则回退」兜底衔接（非空触发回退的路径已在 CP1 内闭环）。

### 2. 新矛盾扫描 —— 无新矛盾

1. **「双端删除」措辞 vs「同批同 PR」**：§3.2/§6.2 标题的「双端」描述删除面跨桥侧+协议/runtime 两端；§6.2 执行纪律段（:182）显式说明双端删除经「跨 u1/u2 两 unit 同批合入」兑现，并给出无行为窗口论证（注释与 fixture 不参与运行时 + co-deployed 无偏斜窗口）。措辞与纪律自洽；「两文件本就在 u1 领地」与实际触达文件（src/index.ts + sync-and-registration.test.ts 恰两文件）核对一致。
2. **§6.7 ↔ §8.2 映射**：§8.2 u1 文件清单（src/index.ts + 两测试文件）完整覆盖 D2 尾巴触达面；括号动作注释仅列 D1/D3/D5（v1 起即不穷举，D6 同不在内），D2 fixtures/用例删除动作已在 §6.2、§6.7 两处点名 + §8.1 交叉引用 + N1 扩面兜底——列举粒度差异不构成实施契约漏洞（INFO）。
3. **r1「已核实无问题」条目未被 invalidated**：v1.1 改动全部限定于 r1 修复范围（§6.2/§6.7/§7 A1/A3/N1/§8.1/§8.2/§8.3/变更历史），D1-D6 裁决本体、非目标、附录 A.1-A.6、「已核实非过度」清单零触碰；A1 删③后判据①②仍可判定（与 r1 §4.8 一致）；变更历史 v1.1 条目与实际 diff 逐条对应、对 r1 结论的转述（1 MF / 4 S / 33 组 0 伪问题）与 r1 报告一致。

### 3. INFO（机械性细节，不计数）

- §6.2 u1「:58/:209 两处字面量」：实测第二处 `commands: []` 字面量在 :207（「畸形工具条目跳过」用例 payload 内），±2 行，「两处」数量陈述正确。
- §6.2 u2 fixtures 锚点同文件存在未列举的次要命中：bridge-marker-channel.test.ts:176（测试自造 syncPayload）、plugin-hooks-integration.test.ts:188 注释与 :189 用例名——均属 u2 领地且在 N1「fixtures 全部零命中」断言范围内，无孤儿风险。
- §3.2 现状表（v1 原文未改）fixtures 行「:58/:207 等」与 §6.2 新写的 :209 存在同文档行号轻微不一致——机械性。

### 4. 结论

r1 五项修复中 MF1/S1/S3/S4 完整落地且证据全部复核吻合，MF1 的领地划分、同批同 PR 纪律、N1 扩面三要素闭合且未引入新矛盾；S2 落地 1/2（:208 已补、:238 E2 行残留）。残留 1 项 suggestion 不阻塞实施，可与 u3 执行同批补登。本设计 v1.1 可进入实施。
