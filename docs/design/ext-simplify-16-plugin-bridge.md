# ext-simplify-16：plugin-bridge 过度设计收敛（注入透传死分支收窄 + 协议死面双端删除 + 形状单源化）

> **一句话结论**：plugin-bridge 的 select+marker 通道机制（三条硬约束、sync 循环、准入闸、失败折叠）经四问核实全部为本质复杂度，零简化空间；真正的过度设计集中在六个死面——注入结构化透传（零供给方且与已登记的 string-only 注入定案相抵）、`BridgeSyncPayload.commands` 恒空死字段、`isToolNotFound` 的 error 形态分支（零供给方）、Bridge* 形状三处定义手工同步、details ok 变体全量重复、`getSessionId` 不可达防御（后两项为语义层审计新增）。本设计全部做删除/单源化/去重，不新增任何机制。

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-plugin-bridge`（v0.2.2，483 行，taiji 组 infrastructure tier）是 2026-09-05 bridge-rewrite（[bridge-rewrite-pi-0.84.md](bridge-rewrite-pi-0.84.md)）的产物：把 runtime PluginService 的插件工具清单经 `ctx.ui.select`+`BRIDGE_MARKER` 通道同步进 pi（`registerTool`），工具 execute 与 pi 事件经同一通道往返 runtime。协议 v2 形状 SSOT 在 `@xyz-agent/extension-protocol` 的 plugin-bridge 模块（marker.ts + types.ts）。
- **C（冲突）**：2026-09-11 过度设计审计将 M21（注入 `Inject*Content` 透传机制）标记为 contested 留待设计裁决，另登记 3 个 low 死面；本轮（2026-09-14）证据刷新追加证实——注入生产端已由 plugin-intercept-injection 设计拍板 **string-only 方案**（管线层逐插件校验恒产出 `string[]`），桥侧结构化透传分支在已登记契约下**结构性不可达**；`commands` 字段双端恒空、`Tool not found` error 形态零供给方、Bridge* 回包形状在 extension-protocol / runtime / plugin-sdk 三处各持一份定义靠注释手工同步；语义层四问扫描另发现 details ok 变体全量重复持久化与 `getSessionId` 不可达 try/catch 两项。
- **Q（问题）**：如何删净六个死面并让协议形状回归单一定义源，同时保证插件工具调用、事件转发、拦截注入三条 live 链路零回归，且不触碰通道机制的三条硬约束？
- **A（答案）**：D1 收窄注入映射为 string-only（裁决 contested 项）；D2 双端同 commit 删 `commands` 死字段；D3 删 `isToolNotFound` error 形态死分支；D4 Bridge* 回包形状单源化到 extension-protocol（runtime 与 plugin-sdk 改为 re-export，取代索引原登记的「补一致性测试」方案）；D5 details ok 变体去重（三失败 kind 保留）；D6 `getSessionId` 删不可达防御直呼。

## 1. 背景：plugin-bridge 是什么

- **职责**（mandatory-extensions.json，tier=infrastructure，不可禁用）：register plugin tools into pi and relay events/intercepts via select marker channel。契约两端（pi extension ↔ runtime plugin-service）都在 xyz-agent 体系内，故归 taiji 组。
- **规模**：生产代码仅 `src/index.ts` 483 行 + 2 个测试文件（734 行）；runtime 对端 `bridge-handler.ts`（纯路由）+ `bridge-interop.ts`（塑形）；协议端 `packages/extension-protocol/src/extensions/plugin-bridge/`（marker.ts 17 行 + types.ts 65 行）。
- **本设计不触碰的机制**（四问核实为本质复杂度，证据快照见 §7「已核实非过度」）：
  1. 三条硬约束（src/index.ts:8-18 头注释）：factory 禁顶层 await / observe fire-and-forget / timeout 按请求类别分档（Gate B 实证修正）；
  2. 启动 sync 循环 + 2s 通道级 timeout 自愈 + Degraded 终态（Gate B 帧丢失实证）；
  3. 首个 prompt 准入闸（R2 真相修复：防弱模型记忆污染，5s 有界）；
  4. `callBridge` 失败折叠 null + 非 JSON 留痕（E5/E7）；回包形状守卫族（失配防御，runtime guard 约定）；
  5. `blocked=true` 只 log 注入照常（pi result 契约无 block 槽位，plugin-intercept-injection D2 行为闭环定案）。

## 2. 设计目标与非目标

**目标**：
1. M21 裁决落地：注入映射收窄为 string-only，删除结构化透传死分支（D1）；
2. 协议死面双端删除：`commands` 字段、`Tool not found` error 形态分支（D2/D3）；
3. Bridge* 回包形状单源化：三处定义 → extension-protocol 一处（D4）；
4. `details` ok 变体去重、三失败 kind 保留（D5）；
5. `getSessionId` 删不可达防御（D6）；
6. bridge-rewrite §3.2「类型零丢失」承诺同步降格登记（登记即债务修复即清账）。

**非目标**：
- 不动 select+marker 通道机制与三条硬约束；
- 不动 sync/准入闸/失败折叠等已核实非过度机制；
- 不收紧协议层 `injectedMessages: unknown[]` 类型（与 plugin-intercept-injection D3「协议层不收紧」定案一致，见 D1 被否栏）；
- 不动 SDK 侧 worker 通道专属类型（`BridgeSyncRequest`/`BridgeSyncResponse`/`BridgeState`/`BridgeToolExecuteRequest`——与协议形状是真差异：worker↔main RPC 概念域，字段结构不同源）；
- 不动 runtime 侧 `bridge-handler`/`bridge-interop` 的路由与塑形逻辑（纯路由铁律、D1 取值链均有独立设计登记）。

## 3. 现状：六个死面的位置图

### 3.1 M21：注入结构化透传（contested → 本设计 D1 裁决）

**机制现状**：`before_agent_start` handler 把 runtime 回包的 `injectedMessages` 映射为单条 CustomMessage 的 content 数组（src/index.ts:458-480）。映射分三路（:463-475）：

| 路由 | 判定 | 产出 | 生产供给方 |
|---|---|---|---|
| 结构化透传 | `isTextContent`/`isImageContent`（:111-117，接口 :99-109） | content 原样进数组（「类型零丢失」） | **零**（见下） |
| string 直用 | `typeof content === "string"` | `{type:'text', text: content}` | **runtime 唯一形态** |
| 兜底序列化 | 其余 | `{type:'text', text: JSON.stringify(content)}` | 版本失配防御 |

**零供给方证据链**（三层）：
1. **管线层拍板 string-only**：plugin-intercept-injection 设计（已随流水线清理退役，决策原文存 git `7a3797d0b:docs/design/plugin-intercept-injection.md`，退役于 `fadd8b8b4`）v1 方案对比即定「推荐 A：string-only 注入」；D5 形状守卫表：插件返回注入条目非 string → **管线层丢弃该条目 + warn**。现行实装 `bridge-interop.ts:259` 自述：「输入恒为管线产出的合法 string[]——无校验无日志职责」，把每条 string 包一层 `{content}`。
2. **桥侧守卫永远不触发**：runtime 产出恒为 `{content: string}`，`isTextContent`/`isImageContent` 的输入恒为 string，两个守卫在生产链路上结构性不可达。
3. **测试供给是自造的**：透传测试（forwarding.test.ts:295-313）的 image/text 结构化回包是测试自己扮演 runtime 伪造的——测试引用只证明「可被调用」，不证明「有人需要」。

**与既有定案的关系**：bridge-rewrite §3.2 对比三 a 登记过「类型零丢失 ✅核实 CustomMessage.content: string | (TextContent|ImageContent)[]」的承诺（pi-agent-core/dist/harness/messages.d.ts:18-25 ✅本轮复核实证一致）。该承诺的**非平凡内容**（结构化段透传）以结构化供给存在为前提；供给端随后被 plugin-intercept-injection 拍板为 string-only，承诺的非平凡部分已空转。本设计 D1 落地时同步降格该承诺表述（u3 文档同步）。

### 3.2 B1：`BridgeSyncPayload.commands` 恒空死字段

**机制现状**：协议类型 `commands: Array<{name: string}>`（extension-protocol plugin-bridge/types.ts:49）。全消费面 grep：

| 位置 | 角色 |
|---|---|
| extension-protocol types.ts:49 | 定义（协议 SSOT） |
| runtime plugin-types.ts:103 | 定义（runtime 本地第二份，见 §3.4） |
| bridge-interop.ts:152 | 构造 `{tools, commands: [], success: true}`——恒空 |
| bridge-handler.ts:91 | fallback 构造——恒空 |
| plugin-bridge src/index.ts:257 | 「commands 恒空忽略……死代码不复制」——不消费 |
| 测试 fixtures（sync-and-registration.test.ts:58/:207 等） | 恒 `commands: []` |

**零消费者**：pi 侧命令发现走 `getCommands` 独立通路（bridge-rewrite §3.3-D7 已裁决「commands 分支删除（死代码）」——该裁决删了旧 bridge 的消费分支，但协议字段本体留在两端）。字段是「带注释承认死亡的活协议面」。

### 3.3 B2：`isToolNotFound` error 形态死分支

**机制现状**：`isToolNotFound`（src/index.ts:121-125）双形态识别：① `{error: "Tool not found…"}` 错误闭环；② `{content: "Tool not found…", isError: true}` 工具结果。

**供给方核查**：runtime 全仓 `Tool not found` 生产点**仅一处**——bridge-interop.ts:167 `return { content: \`Tool not found: ${request.toolName}\`, isError: true }`，即形态②。error 形态①（bridge-handler 的 error 闭环产出 `malformed bridge request` / `Unknown bridge method` / 通用 catch `{error: String(e)}`，均非 "Tool not found" 前缀）**零供给方**；ADR-0012 与 bridge-rewrite 设计均无该形态的生产登记。测试 :205-215 的 error 形态同样是自造供给。

双端 co-deployed（bridge 为 infrastructure tier 随应用打包，无版本偏斜窗口），形态①是防御性冗余。

### 3.4 B3：Bridge* 回包形状三处定义手工同步

**机制现状**：同一形状多处定义，靠注释约定同步：

| 形状 | extension-protocol（协议 SSOT，:33-35 自称） | runtime | plugin-sdk |
|---|---|---|---|
| `BridgeSyncPayload` | types.ts:47-51 | plugin-types.ts:101-105 本地定义 | 已剥离（SDK :512 自述） |
| `BridgeToolExecuteResponse` | types.ts:41-44 | 经 SDK re-export（plugin-types.ts:41） | types.ts:752-755（@internal） |
| `BridgeInterceptResponse` | types.ts:54-58 | 经 SDK re-export（plugin-types.ts:38） | types.ts:713-717（@internal） |

**同步税**：协议 types.ts:33-35 注释「以下形状与 packages/runtime/.../plugin-types.ts 的同名接口逐字段对应（runtime 是实现侧权威；runtime 侧改动时同步此处）」——与同文件头「协议 v2 形状 SSOT 在 extension-protocol」自相矛盾（两个权威）。SDK 侧 Bridge* 全部标 `@internal — runtime 内部`（:713/:752），消费面仅 runtime 的 plugin-types re-export 链一条（全仓 grep 证实无其他 import 方）；SDK 是 `"private": true` 包（package.json:5），无发布面顾虑。runtime 侧声明「BridgeSyncPayload 依赖 runtime 内部 service port 不上收」的理由（plugin-types.ts:7-8）已失实——现行定义 :101-105 是纯数据形状，无任何 port 引用。

**为什么不是「补一致性测试」**：索引原登记 low 项建议补跨包形状一致性测试。测试只能冻结重复、不能消除重复——每次形状演进仍要三处同改 + 测试断言维护。单源化（D4）后测试无存在必要。本设计以 D4 取代该 low 项。

### 3.5 B4：`PluginBridgeToolResult.details` 的 ok 变体全量重复

**机制现状**：工具执行结果的 `details` 字段为四 kind 判别联合（src/index.ts:176-184）：`ok{result}`/`error{error}`/`cancelled`/`unexpected{response}`，三个 Result 构造器（:186-216）与 ok 内联构造（:360-365）各自填充。

**过度部分定位（语义层审计精化）**：
- **ok 变体是唯一硬过度**：每笔成功调用的 JSONL 持久化 `details.ok.result.content` ≡ `content[0].text` **全量重复**（result 原样回填整个回包对象），高频路径纯浪费。
- **三个失败 kind 不可从 isError 派生**：error/cancelled/unexpected 三者 content 均为 isError:true，kind 是 JSONL 里区分「失败原因族」的唯一结构化信号（errorResult 的 content 文本虽携带 error+hint，但按文本解析 = 脆弱耦合）。三 kind 保留。
- **消费方为零但流转存在**：details 经 core 泛化通道路由进前端 ToolCall 状态（registry.ts:635-637 deriveToolCallEndOverlay，devtools/状态树可见），但全仓 grep `details.kind` 对 plugin 工具零读取方——诊断面是「人读 JSONL/devtools」，非程序化消费。
- **失实注释**：类型注释自称「session-manager 同款：details 供下游消费」（:174）——session-manager 经 15 号 u2 已收敛为 `details: undefined`（extensions/universal/session-manager/src/index.ts:97-126），「同款」引用已失实；details 写入本身是仓内真实惯例（ask-user / cw-tool / rename-session 等多处在用），非孤例。

### 3.6 B5（本轮审计新增）：`getSessionId` try/catch 不可达防御

**机制现状**：`getSessionId`（src/index.ts:164-172）以 try/catch 包裹 `ctx.sessionManager.getSessionId()`，注释辩护理由是「session 文件可能尚未落盘（pi 延迟写入）」。

**不可达证据（pi 0.84.4 实装亲验）**：`dist/core/session-manager.js:720-722` 的 `getSessionId()` 是纯字段读 `return this.sessionId`——不可能 throw；`types.d.ts:219` `sessionManager: ReadonlySessionManager` 非可选（无缺失形态）。注释辩护的「session 文件延迟落盘」与守卫对象（内存字段读取）**错位**——延迟落盘影响的是文件读取链路，不影响本调用。4 个调用点（:343/:380/:398/:438）各背一层「何时会失败」的假问题。

## 4. 物理数据流（现状 vs 终态）

### 4.1 拦截注入链路（D1 触达点）

```
插件 hook 返回 injectedMessages
  → HookPipeline.execute 逐插件形状校验（非 string 条目丢弃 + warn）
  → handleBridgeIntercept 纯映射：string[] → [{content}]（bridge-interop.ts:259）
  → select 通道回包（JSON）                        ← 协议 injectedMessages: unknown[]（不动，D3 定案）
  → 桥侧 isInjectedMessage 守卫（:91-93，要求含 content 键）
  → content 映射（:463-475）：
      现状：isTextContent/isImageContent 透传 → string 直用 → JSON.stringify 兜底（三路）
      终态：string → {type:'text', text} ；非 string → JSON.stringify 兜底（两路）
  → CustomMessage{customType:'plugin-inject', content: TextContent[]}（pi messages.d.ts:21 契约内）
```

终态产出形态 `Array<{type:'text'; text:string}>` 结构性满足 `TextContent[]`（✅本轮核实 pi-ai types.d.ts:237-241），`customType`/`display:false`/`details.count` 不变。

### 4.2 sync 链路（D2/D4 触达点）

```
现状：pluginService.getBridgeSyncPayload() → BridgeToolCache.getSyncPayload()
      → {tools, commands: [], success: true}（runtime 本地类型）
      → bridge-handler JSON.stringify → select 通道
      → 桥侧 isBridgeSyncPayload 守卫（只查 success+tools，不查 commands）
      → registerToolsFromPayload（commands 恒空忽略）

终态：{tools, success: true}（协议类型，runtime re-export）
      → 桥侧守卫零改动；registerToolsFromPayload commands 注释删除
```

## 5. 终态：使用者眼里将是什么样的

**使用者 = 插件作者 + xyz-agent 维护者**（bridge 是 infrastructure 通道，终端用户无感知面）。

### 5.1 成功路径（不变）

- 插件作者：注册工具 → 模型调用 → 拿到结果；`before_agent_start` 返回 `string[]` 注入 → 下轮 prompt 开头出现注入文本。**与现状逐字节一致**（D1 收窄只删生产不可达路由，string 路由不变）。
- 维护者：协议形状改一处（extension-protocol）全链路生效，无手工同步注释税。

### 5.2 失败路径（带恢复指引）

| 场景 | 现状行为 | 终态行为 | 差异 |
|---|---|---|---|
| 工具清单 miss | `Tool not found` → 重同步一次 → isError 返回 | 同（形态②判定不变） | 无 |
| runtime 回包非预期形状 | unexpectedResult（isError + 换版指引，details.kind=unexpected 带原样 response） | 同（kind 与 response 保留，content 文本不变） | 无（本行不触 D5） |
| 插件工具调用成功 | 正常回包 | 同，但 JSONL 不再重复持久化 `details.ok.result`（content 单份） | D5 唯一用户可见差异：JSONL 体积 |
| 插件注入条目非 string | 管线层丢弃 + warn（不达桥侧） | 同 | 无（守卫在管线层） |
| 版本失配产生结构化 content | 桥侧透传（多模态语义保留） | JSON.stringify 进 text 段（信息保留、多模态语义降格）| **D1 唯一行为取舍**，见 D1 小取舍段 |

## 6. 关键决策与权衡

### 6.1 D1：M21 注入透传——收窄 string-only（contested 裁决）

| 方案 | 内容 | 论证 |
|---|---|---|
| **a. 收窄（选定）** | 删 `InjectedTextContent`/`InjectedImageContent` 接口 + `isTextContent`/`isImageContent` 守卫 + 透传分支（:99-117、:463-467），content 映射恒走「string 直用 / 非 string 序列化」两路 | 供给端已拍板 string-only（管线层非 string 丢弃 + warn），透传分支结构性不可达；结构化注入若未来立项，必然先动管线层 D5——消费端透传届时随联合设计恢复，恢复通道存在 |
| b. 保留 forward-ready | 现状不动，登记「已知无供给方」 | 结构化注入的「门」在管线层不在桥侧：桥侧保留透传不使未来更容易（管线仍要改）；4 概念 + ~30 行无当下需求方持续收持有税（YAGNI 持有成本） |
| c. 协议层收紧 `injectedMessages: string[]` | 动 protocol + runtime 两端类型，删 runtime `{content}` 包装 + pi 侧 `isInjectedMessage` 守卫 | 与 plugin-intercept-injection D3「协议层不收紧（成本大于收益，运行时守卫已承担约束）」定案冲突——且该形态（包装 ↔ 守卫环形配合）是 r1 审查 MF-1 **已裁决过**的选择（「runtime 侧组装仍按 `{content}` 单键形态产出（与守卫预期对齐）」为定案原文），非新事实；净删除量 ~6 行不足以推翻已审查定案。被否，登记为未来结构化注入立项时的合并议题（附录 §A.5） |

- **小取舍**：牺牲「版本失配下结构化 content 的多模态语义保留」——该形态生产不可达（co-deployed 无偏斜窗口），可触发前提（管线层松绑 string-only）必然先于需求存在，届时恢复。
- **大简化**：删 4 概念（2 接口 + 2 守卫）+ ~30 行 + 1 个自造供给的测试重写为 string-only 断言。
- **核心无损锚**：调用方证据——透传路由的生产调用方为 0（§3.1 三层证据链）；string 路由逐字节不变。
- **连带登记**：bridge-rewrite §3.2「类型零丢失」表述降格为「string 注入零转换；非 string（失配形态）序列化保信息」（u3）。

### 6.2 D2：`commands` 死字段双端删除（B1）

- 删除点（按领地归属，r1 审查 MF1 闭合）：**u2**——协议 types.ts:49 字段、runtime plugin-types.ts:103、bridge-interop.ts:152 构造、bridge-handler.ts:91 fallback 构造、runtime 侧测试 fixtures（bridge-marker-channel.test.ts:58、plugin-hooks-integration.test.ts:193）；**u1**——桥侧 :257 注释、extensions 测试 fixtures（sync-and-registration.test.ts :58/:209 两处字面量的 `commands: []`）、:191-198「commands 恒空被忽略」守护用例**删除**（字段消失后守护对象不复存在；改写为「未知键忽略」属无新生需求的投机守卫，不设——`isBridgeSyncPayload` 本就不查未知键）。
- 桥侧守卫 `isBridgeSyncPayload` 只查 `success`+`tools`（:71-73），零改动——**删除对消费方透明**。
- 与 bridge-rewrite §3.3-D7「死代码不复制」裁决同向收口：D7 删了消费分支，本设计删掉字段本体。
- **执行纪律（r1 审查 MF1 修正）**：双端**同批同 PR**——extensions 侧删除点与协议/runtime/plugin-sdk 侧分属 u1/u2 两个 dev unit（单文件属主原则：两文件本就在 u1 领地，不做跨单位文件级串行），同批合入；批间无行为窗口（注释与 fixture 不参与运行时）。bridge 为 infrastructure tier 随应用 co-deployed，无版本偏斜窗口。

### 6.3 D3：`isToolNotFound` 收敛单形态（B2）

- 删 error 形态分支（:123），保留形态②判定（runtime bridge-interop.ts:167 唯一实装形态）。
- 函数保留（调用点 :354 语义命名清晰），仅删分支；测试 :205-215 的 error 形态用例删除，形态②用例（:187-203）保留。
- 兼容登记：若未来 runtime 把 miss 改报错误闭环形态，桥侧重同步将失效——该演进属 runtime bridge-interop 行为变更，届时同批改桥侧（co-deployed 同 PR 纪律覆盖）。

### 6.4 D4：Bridge* 回包形状单源化到 extension-protocol（B3，取代「补测试」）

- **选 a. 单源化（选定）**：三形状（`BridgeSyncPayload`/`BridgeToolExecuteResponse`/`BridgeInterceptResponse`）以 extension-protocol 为唯一定义源——
  - runtime `plugin-types.ts`：删本地 `BridgeSyncPayload` 定义，改 `export type { ... } from '@xyz-agent/extension-protocol'`（runtime 已依赖该包 package.json:18；13 号 `utils/protocol-background-task.ts` 已有 runtime 引协议先例）；经 SDK re-export 的两形状改指协议源；
  - plugin-sdk：`BridgeToolExecuteResponse`/`BridgeInterceptResponse` 改 re-export 自协议（`ToolExecuteHandler` 返回类型 ：759-763 的作者契约面保持编译不变）；package.json 增 `@xyz-agent/extension-protocol: workspace:*` 依赖（SDK 为 private 包，协议包零依赖叶节点，无环）；
  - 协议 types.ts:33-35 手工同步注释删除（单源化后失义），「runtime 是实现侧权威」矛盾表述一并清理。
- **选 b. 一致性测试（否，即索引原 low 项建议）**：测试冻结重复不消除重复，三处同改税照旧。被取代登记。
- **选 c. 维持现状（否）**：三处定义 + 双权威矛盾注释，每次形状演进手工同步。
- **真差异保留**：SDK 的 `BridgeSyncRequest`/`BridgeSyncResponse`/`BridgeState`/`BridgeToolExecuteRequest`（worker↔main RPC 概念域）不动——与协议形状字段结构不同源，非重复定义。
- **大简化**：删 3 份重复定义 + 1 段失实理由注释（plugin-types.ts:7-8「依赖 runtime 内部 service port」）+ 1 段手工同步契约注释；概念数 -3（读者从「三处形状 + 同步纪律」降为「一处 SSOT」）。

### 6.5 D5：details ok 变体去重（B4，语义层审计精化后收敛）

- **选 a. ok 去重 + 三 kind 保留（选定）**：`details` 联合改为 `{ kind: "ok" } | { kind: "error"; error: … } | { kind: "cancelled" } | { kind: "unexpected"; response: unknown }`——ok 变体去掉 `result: raw` 全量回填（content[0].text 已完整携带同一信息）；error/cancelled/unexpected 保留（不可从 isError 派生的失败原因族信号，且处于低频失败路径）；类型注释「session-manager 同款：details 供下游消费」改为如实表述（details 写入是仓内惯例，本包无程序化消费方，诊断面为 JSONL/devtools 人读）。
- **选 b. 全量收敛 `details: undefined`（否，v1 草稿原推荐）**：语义层审计举证三 kind 的不可派生诊断价值 + details 写入为仓内多包真实惯例（非孤例），全量删除的收益（再省 3 个 kind 概念）低于诊断结构损失；ok 重复才是硬过度。b 被推翻登记。
- **小取舍**：ok 路径 JSONL 不再有第二份完整回包副本——排查「回包形状异常」时改看 content 文本或 runtime 日志（unexpected kind 的 response 原样保留，覆盖真正的形状异常场景）。
- **大简化**：删 1 处高频字段全量重复（每笔成功调用 JSONL 体积近半减负）+ 1 段失实注释；概念数净变化 0（联合形制不变，ok 载荷清空）。
- **核心无损锚**：调用方证据——`details.ok.result` 全仓零读取方（grep 证实），content 文本为唯一被渲染面。

### 6.6 D6：`getSessionId` 直呼（B5，本轮审计新增）

- **裁决**：删 try/catch，直呼 `ctx.sessionManager.getSessionId()`；注释保留「sessionId 缺省时 runtime 按 marker 请求自身路由」的下游语义（该语义真实），删除「session 文件延迟落盘」的错位辩护（延迟落盘影响文件读取链路，与本调用无关）。
- **依据**：pi 0.84.4 实装纯字段读不可 throw（dist/core/session-manager.js:720-722）+ `sessionManager` 非可选（types.d.ts:219）——守卫无可达故障形态（规则 13：运行时行为断言先验证，本轮已亲验）。
- **大简化**：删 5 行防御 + 4 个调用点的假故障面；无行为变化（null 回退路径生产不可达，测试 harness 本就恒提供 sessionId）。

### 6.7 执行项总表

| 项 | 内容 | 领地 | 对应决策 |
|---|---|---|---|
| u1 | D1 收窄（删 4 概念+透传分支，测试重写）+ D3 删 error 分支（删 1 用例）+ D5 ok 去重（断言调整）+ D6 直呼 + D2 桥侧尾巴（:257 注释、fixtures :58/:209、:191 守护用例删除） | extensions/taiji/plugin-bridge | §6.1/§6.2/§6.3/§6.5/§6.6 |
| u2 | D2 commands 双端删除 + D4 形状单源化（协议/runtime/plugin-sdk 三包 + 测试 fixtures 同 commit） | extension-protocol + runtime + plugin-sdk | §6.2/§6.4 |
| u3 | 文档同步：bridge-rewrite §3.2 承诺降格 + §3.3-D7 回写关闭登记 + 协议注释清理随 u2 | docs/design + 协议包内注释 | §6.1 连带登记 |

版本 bump / changeset 不在本设计执行面（merge 阶段统一，B 组既定纪律）。

### 6.8 探针清单

| 探针 | 验证点 | 阶段 |
|---|---|---|
| P1 | bridge-interop.ts:259 现行产出恒 `{content: string}`（已核实，实施前复核未漂移） | u1 前 |
| P2 | 协议单源化后 `pnpm extensions:typecheck` + runtime typecheck 全绿（三包 import 面无断裂） | u2 后 |
| P3 | fixture 插件工具经真机链路 round-trip（见 §7 A1） | u2 后 |

## 7. 验收（真实场景，非单测非 mock）

**验收环境**：dev 实例（`XYZ_DEV_BACKGROUND=1 pnpm dev`）+ fixture 插件（写入实例 plugins 目录的最小插件模块：1 个工具 `probe_echo` + 1 个 `before_agent_start` hook 返回 `["TOKEN_INJECT:<n>]"`）——bridge-rewrite Gate B V 系列同款机制。

| # | 场景 | 通过标准 |
|---|---|---|
| A1 | fixture 插件经 bridge 同步注册，模型调用 `probe_echo` | 工具出现在模型工具清单；调用返回 echo 内容（isError 缺省）——D2/D3/D5 删除面零回归。（r1 审查 S1：原③「runtime 日志见 bridge:tool_execute 往返」删除——runtime 对 tool_execute 无日志点，取证通道不存在） |
| A2 | fixture 插件 hook 注入 string，下一轮 prompt 前触发 | 模型可见 `TOKEN_INJECT:*` 文本（session JSONL 中 plugin-inject CustomMessage.content 为 `[{type:'text',text:'TOKEN_INJECT:*'}]`）——D1 收窄后 string 路由逐字节不变 |
| A3 | sync 快照消费 | 插件工具注册成功 + 桥侧 sync debug 日志可见（XYZ_AGENT_DEBUG=1 下 extension-logger 输出 `synced N plugin tool(s)`）——D2 消费方透明性；「负载无 commands 键」由 N1 rg + u2 单测断言（r1 审查 S1：sync 回包经 pi stdin 静默 resolve、不在 stdout tee 内，无真机取证物，诚实以单测兜底） |
| N1 | 负面 rg 断言 | `commands` 在协议/runtime/plugin-sdk/bridge 四包的**bridge sync payload 语义域**（类型、构造点、注释、测试 fixtures）零命中（r1 审查 MF1 扩面；豁免 = 各包既有 commands 域：plugin-sdk manifest `PluginContributesCommand` 域、runtime commands-api/get_commands 域、bridge-interop commands-executor 注释——这些不在 D2 删除面，勿误伤）；`isTextContent`/`InjectedImageContent` 零命中；error 形态分支不存在（`startsWith("Tool not found")` 仅形态②一处）；`getSessionId` 调用点无 try/catch 包裹 |
| N2 | fallback 序列化（失配形态） | 单测覆盖非 string content → JSON.stringify text 段（生产不可达路径，诚实以单测兜底不设真机场景） |
| A4 | 既有测试回归 | `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 三连绿 + runtime plugin-service 相关测试绿 |

**已核实非过度**（本设计不触碰，审计增量基线）：

- src/index.ts:131-162 `callBridge` 折叠语义：本质复杂度——四种失败源（cancel/通道异常/非 JSON/timeout）真实存在（bridge-handler 回包契约 + rpc-mode 原生行为），折叠 null 统一消费方语义。快照：调用方 4 处（sync/execute/event/intercept），20260914。
- src/index.ts:262-325 sync 循环 + 防抖 + 准入闸：Gate B/R2 实证机制（帧丢失自愈 + 记忆污染防御），超时量级符合规则 19 分档。快照：设计登记 bridge-rewrite §3.3-D4/D5，20260914。
- src/index.ts:58-93 形状守卫族（`isBridgeErrorResponse` 等 6 个）：runtime 对端真实产出形态一一对应（bridge-handler :78/:92/:105/:151 逐一核对），runtime guard 约定豁免。快照：对端产出点清单，20260914。
- src/index.ts:404-411 事件显式注册 ×8：pi.on 字面量重载保类型推断（字符串循环会失类型），零 as 断言约定。快照：pi types 重载签名，20260914。
- bridge-interop.ts:261-267 blocked 透传注入：plugin-intercept-injection D2 行为闭环定案（阻止与留言互不吞没），非死代码（hook 可返回 blocked）。快照：退役设计 D2 原文 git `7a3797d0b`，20260914。
- src/index.ts:228-325 防抖 `ensureSynced` + `runSyncLoop` 循环体兜底：真实并发形态（同进程多 session 复用 + miss 重同步并发，背靠背双 session_start 有测试）+ 防 `void ensureSynced` 的 unhandled rejection 进程级逃逸（registerTool 是 pi 外部 API 边界）。快照：sync-and-registration.test.ts:253-299，20260914。
- src/index.ts:186-216 Result 构造器三件 + :335 args 折叠：单调用点但集中编码结果契约；errorResult 的 hint 拼接对应真实生产点（bridge-handler.ts:166 malformed 回包带 hint）；args 非对象折叠是 LLM 输出不可信边界防御。快照：构造器调用点 ：347/:358/:360-365/:367，20260914。

## 8. 实施与下一层拆分

### 8.1 迁移路径

u1/u2 无依赖可并行（文件级零交集：u1 持 extensions 三文件、u2 持协议/runtime/plugin-sdk）；D2 跨 u1/u2 的双端面以「同批同 PR」收敛（§6.2 执行纪律，r1 审查 MF1 修正）；u3 随 u2 同批或紧随。全链走 dev-flow：impl-plan 基线 → dev units（后台 subagent， territory diff + 测试重跑硬验证）→ 一致性分区审查 → Gate A → 真机验收（§7）→ 终态同步。

### 8.2 下一层拆分清单

- u1：src/index.ts 单文件 + forwarding.test.ts / sync-and-registration.test.ts（D1 测试重写 / D3 用例删除 / D5 断言调整）。
- u2：extension-protocol types.ts + runtime（plugin-types.ts :3-5 头注释与 :101-105 本地定义 / bridge-interop.ts / bridge-handler.ts / 相关测试 fixtures bridge-marker-channel.test.ts、plugin-hooks-integration.test.ts）+ plugin-sdk（types.ts / package.json）；plugin-types.ts:3-5 头注释的 D28「SDK 零依赖自包含」叙事与「仅保留两个 runtime 专属内部类型」清点随 D4 同步（r1 审查 S3）。
- u3：docs/design/bridge-rewrite-pi-0.84.md（§3.2 降格 + D7 关闭登记 + :208 miss 形态描述 `{error: 'Tool not found: ...'}` 与 :238 E2 行 `isError: 'Tool not found: <name>'` 讹写同批修正——:208 是 isToolNotFound 双形态的历史来源（r1 审查 S2），:238 把 isError 速写成携带消息字符串、实装为 `{content: 'Tool not found: <name>', isError: true}`（r2 复审补登））；bridge-interop.ts:254-258 注释中退役文档引用随 u2 改动面顺手修正为「决策原文见 git `7a3797d0b` 版 plugin-intercept-injection §D3（文档已退役于 `fadd8b8b4`）」。

### 8.3 待验证检查点

- CP1：plugin-sdk 增加对 extension-protocol 的 workspace 依赖后，SDK 的 TS 项目引用/tsconfig 解析链是否需同步；并盘点 SDK 在 workspace 外的既有消费形态（file:/link / 打包内嵌等），确认 re-export 协议类型不使类型解析面意外变宽（r1 审查 S4）（u2 首个验证点；若 SDK 构建面有零依赖断言检查则回退方案：SDK 侧维持本地定义 + 本设计仅做 runtime 侧单源化，D4 收窄为半程并登记）。
- CP2：`pnpm gen:builtin-providers` / bundle 链对协议包导出面变化的敏感度（D2 删字段不动导出结构，预期零影响；u2 后跑 `node scripts/bundle-extensions.mjs` 复核）。
- CP3：details 收敛后 session JSONL 的 plugin 工具条目在会话重开渲染无异常（复用「对话流状态重开仍可见」既有验收口径）。

## 附录：语义层审计记录

**方法**：语义层由独立 subagent 按四问框架（Parnas 信息隐藏 / Ousterhout 深浅模块 / Rule of Three / 反模式清单）对 src/index.ts 全量扫描；主 agent 对每条投机结论抽验调用方（hook-pipeline.ts:96/:248-252、pi dist session-manager.js:720-722、types.d.ts:219、registry.ts:635-637 均实际读源核实）。审计日期 20260914。

| # | 发现 | 四问结论 | 处置 |
|---|---|---|---|
| A.1 | Injected*Content 接口族 + 透传分支（:99-117/:463-476） | 投机（0 变体，pass-through + leaky 命中；仅测试引用） | 采纳 → D1 |
| A.2 | isToolNotFound 双形态（:119-125） | 形态①投机（0 生产点）；形态选择权争议经核辨消解——runtime 对 miss 的 `{content, isError}` 形态与 crash/timeout/execution-error 三个失败点（bridge-interop.ts:172/:199/:208）同族一致，`{error}` 闭环是通道级失败专用（malformed/unknown/catch-all），两族语义分工自洽 | 采纳 → D3（删 pi 侧死分支，runtime 形态不动） |
| A.3 | details 四 kind（:176-184） | ok 变体硬过度（全量重复持久化）；三失败 kind 不可派生、保留有据；「session-manager 同款」注释失实 | 采纳（精化）→ D5 |
| A.4 | getSessionId try/catch（:164-172） | 不可达防御（pi 实装纯字段读 + sessionManager 非可选，亲验）；注释错位论证 | 采纳 → D6 |
| A.5 | `{content}` 包装 ↔ isInjectedMessage 守卫环形配合（协议层，:91-93 ↔ bridge-interop.ts:254-259） | 包装唯一目的是满足守卫、守卫唯一原因是包装——信息零增的形状税；但该形态是退役设计 r1 审查 MF-1 已裁决项，净删除量小 | **不采纳**（与 plugin-intercept-injection D3 定案冲突，登记为未来结构化注入立项时的合并议题——届时协议收紧、包装/守卫删除、结构化透传三案合并裁决） |
| A.6 | commands 恒空死字段（协议层） | pi 侧处理正确不过度（不消费+守护测试），死重在协议类型本体 | 采纳 → D2 |

**P3 备查（不在本设计执行面）**：`forwardToolExecute` 把 callBridge 的通道异常也折叠为「cancelled.」文案——留痕在（callBridge logger.error 携带 reason）、isError 正确，仅 content 文案语义轻微涂抹（通道故障显示为 cancelled）。1 行级文案修正，移交 code-simplify 备选，不顺手改。

## 变更历史

- v1（2026-09-14）：初版。证据刷新自 2026-09-11 审计登记（M21 contested + 3 low）：追加证实注入生产端 string-only 定案（管线层 hook-pipeline.ts:96/:248-252 + 退役设计 D3/D5 原文，主 agent 亲验）、`Tool not found` error 形态零供给、Bridge* 形状三处定义手工同步矛盾（「补一致性测试」改道单源化）；同日语义层四问扫描（附录 A.1-A.6）新增 B4 ok 变体去重（对 v1 草稿的全量收敛裁决做精化收窄）与 B5 getSessionId 不可达防御两项，登记 A.5 包装/守卫环形为未来合并议题。D1 完成 contested 项裁决（收窄 string-only）。
- v1.1（2026-09-14）：对抗式审查 r1（报告 [ext-simplify-16-plugin-bridge.review.md](ext-simplify-16-plugin-bridge.review.md)，NEEDS-FIX 1 MF / 4 S，事实底座 33 组声称 0 伪问题 0 失实）**全修**：MF1 执行契约闭合——D2 桥侧尾巴（:257 注释 / fixtures :58/:209 / :191 守护用例删除）划入 u1（单文件属主），「双端同 commit」修正为「同批同 PR」，N1 扩面至类型/构造点/注释/fixtures 全部零命中；S1 删除 A1③ 与 A3 指向不存在产出物的取证判据（runtime 对 tool_execute 无日志点；sync 回包经 pi stdin 静默 resolve 不在 stdout tee），改挂真实观测物（桥侧 sync debug 日志 + u2 单测）；S2 u3 补 bridge-rewrite :208 miss 形态描述同步（`{error}` → 实装 `{content, isError}`，双形态历史来源）；S3 u2 补 plugin-types.ts:3-5 头注释 D28 叙事同步；S4 CP1 补 SDK workspace 外消费形态盘点。
- v1.2（2026-09-14）：聚焦复审 r2（PASS，0 must-fix / 1 suggestion 残留，追加于 review 报告「r1 修复聚焦复审（R2）」节）——MF1/S1/S3/S4 落地经独立源码复核全部吻合、未引入新矛盾；残留 suggestion 当轮修：u3 补 bridge-rewrite :238 E2 行 `isError` 讹写修正登记。审查循环闭环，设计就绪。
