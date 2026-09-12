# subagent 体系三组架构深化设计（post-convergence deepening）

> 层声明：本文档是「架构重构方案层」设计——把双轨收敛收官（912440a6f，2026-09-03）后的架构走查发现收敛为三组可实施深化方案。下一层产物是**各组的实现计划与代码任务**，不跨层到逐函数实现细节。
>
> 上游资产：[subagent-dual-track-convergence.md](subagent-dual-track-convergence.md)（双轨收敛，已落地）、[subagent-core-package-extraction.md](subagent-core-package-extraction.md)（core 抽包 + D5 barrel 定稿，已落地）、[subagent-engine-abstraction.md](../architecture/history/engine-abstraction-2026-09/subagent-engine-abstraction.md)（引擎中立抽象，已被引擎协议化取代）。

## 1. 背景目标

**一句话结论**：双轨收敛解决了「一个概念两份实现」，本轮解决收敛后暴露的三类**结构性**遗留——组合根无 seam（workflow 域生命周期逻辑内联 index.ts）、core 契约面与实际消费面脱节（114 处深路径 import 全部游离在 semver 之外）、以及三个可独立完成的小收敛（sync 死轨 / TUI 零件 / 测试桩基建）；chat 轮次机器抽出经对抗式审查被源码证据撤销（§3.2 B-3 被否谱系留档）。

### SCQA

- **S（情境）**：双轨收敛重构刚收官（8 单元 + 双 Gate 全绿）：10 对双轨归一、假兑现清零、SubagentService public 27→12、壳 interface 层测试 seam 立住（temp-prompt mock 20→2）。
- **C（冲突）**：收敛聚焦「core↔壳之间的双轨」，没有触碰三块结构性遗留：①收敛把 subagent 域恢复逻辑抽进 core，workflow 域的等价逻辑却仍内联在组合根 index.ts——两域不对称；②收敛期间的文件迁移（u-2a/u-2c）让壳对 core 的深路径 import 从 63 涨到 114（+81%），全部游离在 D5 定稿的 semver 契约面之外；③四项独立小收敛（resource-discovery sync 死轨、subagent-service 五轴混居、TUI 零件双份、测试手写桩）没有 owner。
- **Q（问题）**：如何在不破坏「pi 宿主行为零回归」底线的前提下，给组合根一个可测试的 seam、把壳↔core 的消费关系纳入契约面、并清掉剩余的独立摩擦？
- **A（答案）**：三组五项（A：组合根 seam；B：core 契约面 + 死轨；C：TUI 零件），文件交叠趋零可并行，共享一次 pi CLI 实测验收。C5 轮次机器抽出经三轮审查撤销（§3.2 B-3）。

### 系统是什么（给不熟悉内部的读者）

沿用 [dual-track-convergence §1](subagent-dual-track-convergence.md) 的体系图：壳 `extensions/universal/subagent-workflow`（工具面 + TUI + injectors + index.ts 组合根，~10.7k 行）依赖 `packages/subagent-core`（execution / orchestration / shared 三域 + core 宿主端口，~31.4k 行，npm 发布包）。core 通过 `HostServices` 端口反向依赖宿主，pi 闭包红线（core 禁 pi SDK）决定所有吃 pi SDK 的实现只能住壳。

**术语**：seam / deep / shallow / deletion test 等架构词汇同 dual-track 文档（定义见 improve-codebase-architecture LANGUAGE.md）。本文新用：

- **bootstrap seam**：组合根暴露给测试的「会话生命周期装配」seam——测试经它注入 fake 依赖、验证装配行为，而不必挂载整个 index.ts 再整类打桩 12 个模块。
- **barrel（契约面）**：`packages/subagent-core/src/index.ts` 的显式导出 + package.json exports。D5 定稿：exports 面即 semver 契约，收窄不放宽。
- **深路径 import**：壳侧 `from '@zhushanwen/subagent-core/<内部路径>'` 形态——在 workspace 内经 `./*` 通配免费可达，但 publishConfig 发布面不含该通配，外部消费者形态下即 broken。

### 设计目标（从使用者体验倒推）

受益者排序同前序设计：③ 开发者（维护者/AI agent）> ② xyz-agent 用户（GUI/TUI 正确性）> ① 模型（工具面不变）。

1. **组合根回归纯装配**。index.ts 只做「接线」：想验证 session_start 里某一步为行为（如 WTM reaper 扫描），测试注入 fake 到一个 seam 函数即可，不再整类 mock 六层依赖。
2. **core 的 semver 契约面 = 壳的实际消费面**。core 内部移动/重命名文件不再是对壳的隐性 breaking——壳消费的每个符号都有契约保护，barrel 演进有真实消费清单做依据。
3. **机制无死轨**。resource-discovery 的 sync 轨（~160 行零生产调用 + 注释谎言）删除，「待决策」事项定案。
4. **~~subagent-service 五轴减一~~（C5 本轮撤销，r2 审查裁决）**。chat 轮次机器经对抗式审查被源码证据推翻：runAndFinalize 实测有三个调用点（:1130 在 engine 编排轴的 public executeAndAwait 内、:1738 runTicketRound、:758 经 kickOff），chatPiEngine 有非随迁消费方（deliverChatMessage :727），真实依赖闭包 ≥15 个 Service 私有成员——任何切法都是文件搬家而非 locality 收益。登记 follow-up（触发条件见 §3.2 B-3 被否谱系），本轮目标替换为：**该边界裁决被记录**，后续轮次的架构审查不必重新发现。
5. **TUI 零件单点**。两个全屏视图（subagents / workflows）消费同一套终端兼容零件（边框 / 终端行数兜底 / 分页常量），同步不再靠注释人肉。
6. **测试打桩面收窄**。手写桩与共享 stub 的逐字重复（38 处）收敛到共享桩 module；指向已改名旧路径的静默 no-op mock 清零。

### in / out of scope

**in**：五项——C1 组合根 seam、C6 测试桩基建、C2 barrel 收口、C3 sync 死轨删除、C4 TUI 零件收敛。（C5 chat 轮次机器抽出**经 r2 对抗式审查撤销**，证据与被否谱系见 §3.2 B-3——依赖闭包深度使抽出退化为文件搬家。）落在壳 `extensions/universal/subagent-workflow/` 与 `packages/subagent-core/`。

**out**：①新引擎接入（EnginePort 预留位，另一设计）；②notifier ledger/delivery-kernel 双路径（pi-boundary-reliability 刻意降级链）；③journal compaction 的 GUI 可见性（新增行为非收敛，D1 被否谱系维持）；④桌面 workflow 发现空问题（impl-plan 残留风险 #7，独立排查项，本轮 C2 不触碰发现链）；⑤subagent-service 五轴的进一步拆分（含 chat 轮次机——C5 经 r2 审查撤销，见 §3.2 B-3 被否谱系；无新触发条件不预拆）；⑥runtime（packages/runtime）读取侧——u-1a 收敛后已复用 core module，本轮仅 2 个文件的 import 行归一 barrel（符号进 barrel，不新增子入口，见 §3.2 B-2 / D3），runtime 逻辑零改动。

## 2. 现状与问题分析

**首句结论**：三块遗留的共性是「收敛做对了 core 侧，壳侧与消费面没跟上」——workflow 域恢复逻辑留在组合根（subagent 域对应物已在 core）、壳消费 core 走深路径网格（barrel 被 D5 豁免后无人管）、独立小摩擦无人认领。

### 2.1 使用者视角的现状（真实例子）

**例一（开发者/测试视角，在错误的 seam 上打桩）**：开发者想验证「session_start 是否调了 WorktreeManager.scan」（ADR-035 启动恢复的一行行为）。现状没有 seam 可注入——被测逻辑内联在壳 `src/index.ts:514`（`new WorktreeManager(agentDir); await wtm.scan()`），测试只能挂载整个 index.ts，整类 mock 六层依赖（pi-ai、typebox、worktree-manager、session-file-gc、model-config-service、subagent-service）加 jsonl-run-store 等共 12 个 vi.mock（`session-start-reaper.test.ts` 全套，重构前后持平未改善）。被测行为一行，打桩面 12 个模块——「整类 mock SubagentService」的 7 个测试文件全部如此。

**例二（开发者视角，core 内部移动文件 = 隐性 breaking）**：u-2c 把 SubagentService 拆出聚合面时，壳侧 8 个文件的 `from '@zhushanwen/subagent-core/execution/subagent-service'` 若有一处漏改即编译失败——这不是假设，是 u-2a/u-2c 两轮迁移都真实付过的成本（深路径 63→114 的增量主要来自此）。而 npm 发布面（publishConfig）不含 `./*` 通配：今天壳消费的 114 处深路径里任何一处，在「外部消费者」形态下都是 broken import。D5 豁免壳侧深路径的本意是「端口演进无宿主触点证据不放宽」——但豁免被用成了「永不放宽」：barrel 现 35 符号，壳实际消费 46 个内部文件的符号（最高频 `execution/types.ts` ×14、`subagent-service.ts` ×8），barrel 使用率 0%。

**例三（模型/用户视角，一切正常但 TUI 零件在等下一次漂移）**：subagents 全屏列表与 workflows 全屏视图各持一套终端兼容零件：`TERM_ROWS_FALLBACK = 24` 双定义（`list-component.ts:65` 私有 vs `format.ts:570` 导出）、`PAGE_SCROLL_DEFAULT = 10` 双定义（`list-view.ts:65` vs `format.ts:568`）、边框 helper 家族两套同构实现（`list-component.ts:272-295` 方法形态 vs `WorkflowsView.ts:92-110` 自由函数形态，后者注释自认「对齐 list-component」）、`termRows()` duck-type 兜底三份。D7-① 收敛了纯函数（views/format.ts 并入 format.ts）但零件没收——每加一个全屏视图要再抄一套，同步靠注释。

### 2.2 六项摩擦清单（实证，deletion test 结论）

走查方法：三分支并行 explorer 走查（壳 interface 层 / 壳↔core 消费面 / 测试拓扑）+ 主 agent 抽查实证（2026-09-03，全部 file:line 级证据已在走查报告中复核）。

| # | 摩擦 | 证据 | deletion test |
|---|------|------|---------------|
| C1 | index.ts 945 行，纯装配仅 ~80 行；session_start handler 278 行（:336-613）六职责混居（引擎同步/identity 重建/ledger 装配/双 Service 装配/GC+恢复/kill-9 恢复循环） | `index.ts:336-613`；另 `resolveMainSessionFileById`(:200) / `resolveSessionDir`(:273) fs 探测、`lazyDeps` 8-getter+2-直传 pass-through + storeHealthy 守卫双份（:813-898） | 非「可删」而是「该抽未抽」：抽出后 index.ts 减 ~350 行（设计期估算；实施期校准见 §4 A-V4：实际减 309 行，终态 636/HEAD 650），两域恢复逻辑对称化 |
| C2 | 壳 114 处深路径 import 穿透 core 48 个内部文件；barrel（35 符号）使用率 0%，连已导出的 configureCore/abortRun/HostServices 壳都走深路径；另有 **runtime 2 处生产深路径**（`subagent-extractor.ts:44` / `subagent-engine-history.ts:26`，u-1a 引入，仅靠 `./*` 通配解析） | rg 全量实测；根因 = barrel 覆盖面远小于消费面（execution 领域类型/Service 聚合面 barrel 未给） | 收口后复杂度集中到 barrel 一处，48 文件网格消失 |
| C3 | resource-discovery sync 轨 ~160 行零生产调用；注释仍称「agent-registry 同步路径专用」（租户已迁 async + getCachedFile） | `resource-discovery.ts:676-835`，非测试调用者 = 0 | 删即净（死代码 + 注释谎言） |
| C5 | subagent-service.ts 1963 行五条变化轴中三条已部分出列（finalize-record / cold-resurrect 已随 dual-track D4 拆为独立 module；round-settlement 同批拆出，后随 W3 协议化删件失去消费方、于 design-code-sync R1 删除，结算闭包内联回 subagent-service.settleChatRoundFromResponse），但**装配点与执行主体仍混居**：chat 轮次机器的编排方法（kickOffChatRound(:1656)/runTicketRound(:1737)/settleRound(:297)/resumeColdRound(:759)）与执行主体 runAndFinalize(:1485-1643) 及 chatPiEngine(:290) 全部内嵌 | `subagent-service.ts`；runTicketRound 是对 runAndFinalize 的 8 参纯委托；runAndFinalize 实测三调用点（含 executeAndAwait :1130），依赖闭包 ≥15 私有成员 | deletion test **不过**：抽出物删掉后复杂度原样回到 Service——本轮撤销（§3.2 B-3 谱系），登记 follow-up |
| C4 | TUI 零件四组双定义（见例三）；format.ts 36 导出中 15 个（7 常量 + 8 个 trace/badge 格式化函数）仅 views/ 两文件消费 | `format.ts:550-578`（views 专属常量被抬入）、:645-660（两个 elapsed 格式化器靠注释保持同输出） | 抽 tui-kit 叶 module，~120 行同构复制消失 |
| C6 | 38 处手写桩与共享 stub 逐字重复（getLogger ×11、pi-ai StringEnum ×11、getAgentDir ×9、typebox ×7）；3 个 mock 静默指向已改名旧路径（`../commands/subagents.ts` 等，no-op）；agent-registry/notify-ledger/session-pending 三个 core module 的唯一测试覆盖落在壳套件 | `session-start-reaper.test.ts:99-107`（死路径）、:12-23（同文件重复注册 pi 两包） | 共享桩 module → 桩更新一处生效 38 处 |

**测试拓扑投影**（C1/C6 的 interface 证据）：壳 vi.mock 总量 126 处（29 文件）；整类 mock SubagentService 的测试 7 文件全部 import 真实 index.ts。对照组样板已存在——`tool-action.test.ts`（487 行，0 mock，typed fake 注入）与 `gui.test.ts`（0 mock）证明 interface 层 seam 已立住，残余问题全部集中在组装根。

### 2.3 根因

1. **双轨收敛以「core↔壳双轨」为判定单位，组合根内部的职责混居不在其视野**——subagent 域恢复逻辑抽进 core 是因为那是对应物在 core；workflow 域恢复逻辑吃 pi SDK（`pi.events.emit` / `pi.appendEntry`）只能住壳，于是无人认领，留在 index.ts。
2. **D5 的豁免条款没有退出条件**。「仓内壳侧深路径消费不受 barrel 约束」在抽包期是正确的风险隔离（避免一次 import 大迁移与重构叠加），但没有登记「何时收口」——豁免从实施期措施固化为终态，深路径随每轮重构继续增殖（63→114）。
3. **小摩擦无 owner**：sync 死轨的决策条件（agent-registry 消费形态）在 u 系列重构中悄然满足，没人回头销案；测试桩的 D15 决策（alias 管类型、内联管运行时）执行走样无人纠偏。

## 3. 解决方案

### 3.1 组 A 终态：组合根纯装配 + bootstrap seam

**使用者视角（开发者写测试）**：验证 ADR-035 reaper 行为的测试变成——

```ts
import { setupSessionLifecycle } from "../session-lifecycle";
const fakePi = createFakePi();           // typed fake：appendEntry/events/on 三成员
const result = await setupSessionLifecycle(fakePi, fakeCtx, deps /* 含 fakeWorktreeManager */);
expect(deps.worktreeManager.scanCalls).toBe(1);   // 一行行为，一个注入点，零整类 mock
```

index.ts 的 session_start 退为：

```ts
pi.on("session_start", async (_e, ctx) => {
  await setupSessionLifecycle(pi, ctx, makeLifecycleDeps(ctx));  // 全部编排随迁
});
```

**seam 形状（D1/D2）**：新文件 `src/session-lifecycle.ts` 导出单一入口 `setupSessionLifecycle(pi: ExtensionAPI, ctx: ExtensionContext, deps: SessionLifecycleDeps): Promise<SessionLifecycleResult>`。随迁内容（从 index.ts:336-613 原样搬移，本设计不改行为）：

| 随迁块 | 原位置 | deps 形态 |
|--------|--------|----------|
| identity env→appendEntry 重建（类型 13 字段含 1 个 @deprecated parentSessionId，写入 12） | :351-393 | 经 pi（fake 可断言 appendEntry 调用） |
| notify ledger host 装配（5 方法） | :395-426 | 经 pi/ctx |
| 双 Service 装配 + initSession | :428-490 | deps 注入工厂（见下方「单例语义保持」） |
| GC / manifest / worktree 恢复 | :492-520 | deps.worktreeManager 等 |
| kill-9 恢复循环 + evict | :536-586 | deps.createRunStore |
| SAR + engine 基线 + sessionState.set | :588-612 | 返回 SessionLifecycleResult（store/runs/runner 等），index.ts 写入 sessionState |

**单例语义保持（关键不变量）**：现状装配是 `getSubagentService() ?? new` + 仅 `!existing` 时 `setSubagentService(service)`（index.ts:429-487）——jiti 多实例分裂靠 globalThis Symbol 单例防护，`/resume` `/fork` 复用既有实例（SR-3/SR-4 语义）。随迁工厂封装为 `createOrReuseServices(pi, ctx): { service, modelService, reused: boolean }`，**完整保留 existing-??-new + 条件 set 整段**——deps 默认实现即调它，测试传 fake 覆盖；裸 `new` 禁止出现在 deps 默认实现里（否则每个 session_start 新建实例，GC timer 翻倍、record store 状态分裂）。**init 无条件语义钉死**：initModel(:434)/initSession(:457) 对 new 与 reused **均无条件执行**（SR-3：/resume /fork 复用实例时注入 handler 覆盖旧值、更新 sessionId；SR-4：dialogQueue 注入）——`reused` 返回标志仅供测试断言与日志，禁止任何「reused=true 跳过 init」的分支（否则上一 session 的 uiRequestHandler/sessionId 残留）。单例访问器（getSubagentService/setSubagentService/getModelConfigService/setModelConfigService，4 个符号，设计期壳 3 文件生产消费：index.ts / interface/subagent-tool.ts / interface/subagents.ts；u-4 实施终态 5 文件——随迁出的 src/session-lifecycle.ts 消费全部四件、src/injectors/engine-awareness.ts 消费 getModelConfigService）随 B-2 进 barrel——semver 承诺可接受（形态自抽包起未变）。

`resolveMainSessionFileById`（:200）/`resolveSessionDir`（:273）两个 fs 探测函数随迁为 module 私有（唯一消费方就是随迁块）。`lazyDeps`/`getDeps` 的 storeHealthy 守卫双份（:813-898）合并为单一 `getWorkflowDeps(sessionId)`（返回 `{ ok: true, deps } | { ok: false, reason }`，两个消费点——`pi.__workflowRun`（返回错误对象，D-8 API 面）/ lazyDeps getter（throw）——各自决定 throw 还是返回错误对象，二者被 workflow tool 与 workflows command 共同消费）；原 8-getter 转发 + 2 处直传的 lazyDeps 合并为 10 成员 getter 对象（属性访问触发 getWorkflowDeps 守卫 + makeDeps 求值；偏差 #10：功能等价惰性回调设计，阶段 4 修复后成员面完整恢复含 scheduleTimeBudget/onWorkflowCall）。

**错误处理不变**：identity/ledger/cleanup 各 try-catch 的「失败记日志不阻断」语义原样保留（错误规格见 §3.4 表）。

### 3.2 组 B 终态：契约面 = 消费面 + 死轨清零

**B-1（C3）sync 死轨删除**：删 `resource-discovery.ts` sync 五函数（discoverResourcesSync/scanDirectorySync/readPackageManifestSync/processPackageSync/scanNpmDirSync，~160 行）及「agent-registry 专用」注释；async/sync parity 测试改为 async 单侧契约。前置核验：全仓（含 bench/）非测试调用零命中（走查已实证，实施期复跑 rg 门）。

**B-2（C2）barrel 扩面 + 壳 import 归一**：

- **与 D5 纪律的调和**：D5「无宿主触点证据不放宽」的判据是「有没有真实消费者」。壳（~114 处）就是最大宿主触点证据——扩面不违反 D5，是 D5 判据首次被执行。extraction 设计的 D5 段落由本设计补注「壳侧收口完成，深路径豁免终止」。
- **扩面清单**（进 barrel 的判定标准：壳非测试代码实际消费 ≥1 处）：`execution/types.ts` 的领域类型族（ExecutionRecord/ExecutionMode/SubagentIdentityData 等 ×14 消费）、SubagentService 与单例访问器四件（SubagentQueries/SubagentChatActions 实测无壳非测试消费，未进 barrel——u-2a deviation 记录）、record-store 消费面、`orchestration/models/*` 类型族（WorkflowRun/AgentCallOpts/RunStore 等 ×8）、`shared/` 消费符号（agent-ref/xml-injection/meta-parser/resource-discovery 的 `discoverResources`/model-ref）。逐名列出（维持 D5「diff 可审」纪律），设计时预估 35 → ~100 符号，实施终态 137（消费面实测大于估算，以 barrel 逐名清单为准）。
- **壳 import 归一**：114 处深路径（含 bench/ 6 处）机械替换为 barrel 顶层；**保留** package.json 现有 4 条语义子入口与 `./workflows/*`（引擎集成点与资产入口，非本范围）；`./*` 开发态通配**删除**（收口的牙齿：今后壳再写深路径即 tsc 编译失败，不再是风格问题）。
- **runtime 2 处生产深路径处置（删通配的前置条件）**：`subagent-extractor.ts:44`（`execution/engine/common/session-view-types.js`）与 `subagent-engine-history.ts:26`（`.../session-view-service.js`）是 u-1a 引入的 module 级复用点——**符号进 barrel，runtime import 归一顶层**（r2 曾裁决补 2 条子入口，r3 改归一 barrel，理由见 D9：每新增一条子入口 bundle 就多一份 host-services 副本，而 barrel 单入口形态天然无分裂）。runtime 代码仅改 import 行。
- **跨包测试助手处置（随 u-2 本体）**：壳测试引 core `__tests__` helpers 的 7 文件，与删通配物理冲突。处置：**壳 vitest alias**——`vitest.config.ts` 加两条 alias：testing 字符串条目（`@zhushanwen/subagent-core/testing` → core `src` 根；alias 落点是 src 根而非某个 `__tests__` 目录，故 specifier 必须自带 `<域>/__tests__/<file>` 段——helpers 物理位置 = `src/execution/__tests__/helpers/` 与 `src/orchestration/__tests__/`），7 个壳测试 import 改走 alias specifier。**实施期扩补（偏差 #17）**：另加正则条目 `/^@zhushanwen\/subagent-core\/(.+\.ts)$/` → core `src/$1` 兜底测试残留深路径（62 个仅测试消费符号按 D3 标准不进 barrel，HEAD 实测 69 条 from + 33 处 vi.mock + 5 处动态 import 合计 107 处深路径零改写——精确数以 rg 实测为准，口径随 u-5b/u-5c 改写漂移）——生产 barrel import 无路径段、4 条子入口 specifier 无 .ts 后缀，均不命中该正则；「生产走 exports / 测试走 alias」的双轨解析对删通配免疫。**守卫空缺（偏差 #23）**：测试侧深路径经 alias 解析且 tsconfig exclude `__tests__`——测试侧无编译期牙齿，深路径回流只能靠收口 rg 门一次性拦截。选型对比：❌ `./testing` 发布子入口（r1 方案，被 r2 否决）：进 publishConfig = 测试基建进 semver 公共面（与「测试基建不属发布契约面」原则矛盾）；helper 迁出 `__tests__/` 即离开 `check-subagent-core-closure.mjs` 的豁免面（:24），`mock-extension-api.ts` 的 pi type import 命中 BANNED_PREFIXES、`test-mocks.ts` 的 vitest 运行时值 import 进 dist 即缺依赖。✅ alias：helpers 物理零移动（闭包守卫豁免面不变）、零契约面变化、壳 vitest.config.ts 已有 alias 机制先例；vite resolve.alias 前置重写为绝对路径后不再走 exports（r3 核验），不受删通配影响，且壳 typecheck 的 extensions/tsconfig.json exclude 含 `**/__tests__`，测试文件不在 tsc 面内。
- **dist 双形态评估（tsup 单 bundle 不拆 chunk）**：r2 版「模块级可变状态盘点为无」被 r3 源码盘点推翻——**实测至少 7 处非 globalThis 持有的模块级可变状态**：`host-services.ts:49 let configuredHost`（configureCore 写入目标，注释自认「模块级配置态」）、`notify-ports.ts:106` 配置态、skill-discovery 的 skillMemo Map、argv-mirror / pi-invocation 的 memo、sessions-index 的 tmpSeq。影响链：任一子入口 bundle 若闭包含 host-services 副本，npm 双入口形态下 configureCore 只写主 bundle 副本，子入口侧恒 undefined。**修复（u-2 内根治动作）**：① host-services 的 configuredHost 与 notify-ports 的配置态迁移为 `globalThis[Symbol.for]` 持有（与单例访问器四件、engine registry 既有范式一致）——所有 bundle 形态免疫分裂；② 本设计不新增任何子入口（runtime 归一 barrel），新分裂面为零；③ 静态门保留：枚举主 bundle 与**现有 4 条子入口** bundle 的重叠 module 清单，确认剩余模块级状态（skillMemo/memo/tmpSeq）不处于「双入口且状态可写」的消费路径——现有子入口消费者仅 runtime（workspace 走 src 单源）与 zsw vendor（已于 u-2c 实施期核对：单入口消费形态——zsw vendor 仅 vendored dist/index.cjs 主 bundle，零子入口 bundle，无状态分裂面）。
- **dist 静态验证门**：① dist 重复 module 比对（主 bundle × 4 现有子入口，重叠面中的模块级状态 module 需逐个确认 globalThis 化或消费路径单入口）；② 子入口导出面符号白名单（exports 条目 ↔ bundle 实际导出一致）；③ `smoke-core-dist.mjs` 挂 require smoke（dist 文件存在且可 require——pack --dry-run 发现不了 dist 缺文件）。
- **发布面核验**：publishConfig 已无 `./*` 通配（现状即如此），扩面后 `npm pack --dry-run` 面检查新增导出随 dist 正常发布。

**B-3（C5）chat 轮次机器抽出——本轮撤销（r2 审查裁决，被否谱系）**：

r1 方案（编排五方法 + runAndFinalize + ChatRoundMachineDeps 整体随迁）被 r2 源码证据推翻：

- **runAndFinalize(:1485-1643) 实测三个调用点**：:1738（runTicketRound，轮次轴）、:758 经 kickOff（轮次轴）、**:1130 在 public executeAndAwait(:1064) 方法体内**——executeAndAwait 是 public 面 12 之一且是 piEngineServiceAdapter 第一成员（engine 编排轴核心入口）。「两个消费方均在随迁清单内」「engine 编排轴不消费它」两条裁决依据均不成立。
- **chatPiEngine(:290) 有非随迁消费方**：deliverChatMessage(:723，PiEngineService port 成员) 在 :727 调 `this.chatPiEngine.interactRecord`——随迁即断链或产生未声明反向依赖。
- **真实依赖闭包 ≥15 个 Service 私有成员**（resumeColdRound :760-851、runAndFinalize :1485-1643 实测：execNesting/forkDepthBaseline/effectiveMaxConcurrentFor/finalizeAborted/finalizeFailed/assertReady/buildSessionRunnerContext/pool/store/resumesInFlight/forkDepthAls/notifyHost/streamSink/chatRoundTickets/serviceAdapter）——ChatRoundMachineDeps 无论怎么定义都是第二个 Service interface，抽出退化为文件搬家 + 新增 port 间接，locality 收益不成立（deletion test 不过：删掉新 module 复杂度原样回到 Service）。

**被否谱系**（供后续审查免重发现）：
- `<runAndFinalize 整体随迁>` —— 击穿反例：executeAndAwait(:1130) 第三调用点，随迁迫使「public 方法跨 module 调轮次机器」或「executeAndAwait 也随迁破坏 public 面承诺」二选一。
- `<runAndFinalize 留 Service + 轮次机器只承接编排层>` —— 击穿反例：runTicketRound 对它是 8 参纯委托，留 Service 则抽出物是跨 module 转发空壳；resumeColdRound 自身依赖 6+ 私有成员，同样无法干净切断。
- `<chatPiEngine 随迁>` —— 击穿反例：deliverChatMessage(:727) 断链。

**follow-up 触发条件**（满足其一时重新立项，需先消解上列反例——例如 runAndFinalize 消费方收敛为 ≤1 个轴、或 PiEngineService port 面重构使轮次依赖可具名化）：① 轮次不变量出现真实回归（chatmode 系列测试开始漏 bug）；② 轮次语义需要独立演进（如新增轮次模式）且与 Service 其他轴产生变更冲突。本轮 B 组 = C2 + C3 两项。

### 3.3 组 C 终态：tui-kit 单点零件

新叶 `src/interface/tui-kit.ts`：`TERM_ROWS_FALLBACK` / `PAGE_SCROLL_DEFAULT` 单定义、边框 helper 家族（b/dash/dashes/titleBorder/plainBorder/walled，统一为自由函数形态——WorkflowsView 形态胜出，类方法绑定无额外价值）、`termRows()` 单份。**实施期补记（偏差 #11）**：边框家族的填充/对齐需要 ANSI 可见宽度计算（titleBorder→segFillColored→truncLine、walled→padToVisible），布局家族四函数（truncLine/wrapText/padToVisible/segFillColored）自 format.ts 随迁入 kit——「零依赖 format.ts」与「不复制实现」的唯一自洽解；format.ts 经 re-export 四符号维持既有导入面（bg-notify-render / tool-render / 测试零改动）。两视图族（list-component/list-view 与 WorkflowsView）改消费 kit。views 专属常量 6 个（SIDEBAR_WIDTH/PROMPT_FOLD_LINES/OUTPUT_TRUNCATE_BYTES/BOX_BORDER_CHARS/BUDGET_TOKENS_DIVISOR/MAX_TOOL_CALLS_DISPLAY，实施终态口径，落位 `views/view-constants.ts`）从 format.ts 沉回 `views/`；两个 elapsed 格式化器合并为单函数（workflow trace 风格参数化前缀），`formatTraceEventLine` 维持独立（概念域真差异，format.ts:674 注释为证）。list-shared.ts 的 7 参 KeyHandler 本轮**不动**（破循环摆渡车是结构选择产物，tui-kit 不触及按键路由；避免与 C4 主线耦合）。

### 3.4 错误规格（本设计不新增错误路径，全部为现状语义的守护声明）

| 边界 | 现状语义 | 本设计动作 |
|------|---------|-----------|
| identity appendEntry 失败 | logger.warn 不阻断（:388-392） | 随迁原样 |
| ledger bind 失败 | warn 不阻断，通知退内核路径（:421-426） | 随迁原样 |
| store.loadAll 失败 | storeHealthy=false，workflow 域 fail-fast（:580-586） | 随迁 + 守卫合一后单一出口 |
| kill-9 恢复 save 失败 | error 日志不阻断其余 run（:553-560），下次 session_start 幂等重试 | 随迁原样 |
| barrel 缺导出（收口后壳新写深路径） | 现状：静默可达（workspace 通配） | **变为 tsc 编译错误**（通配删除）——错误信息指向 barrel，恢复动作 = 在 barrel 逐名追加（diff 可审） |

### 3.5 方案对比（每组 ≥2）

**组 A seam 放置**：

| 方案 | 长期合理性 | 短期成本 | 风险 |
|------|-----------|---------|------|
| ✅ 壳 `src/session-lifecycle.ts` 单入口函数 | 恢复逻辑吃 pi SDK + 壳 RunStore 实现，与 jsonl-run-store 同理只能住壳；一个 seam 两个 adapter（pi 全家桶 prod / typed fake test）= real seam | 原样搬移 ~350 行（设计期估算，实测 309，见 §4 A-V4）+ deps 工厂化，1 个单元 | 搬移引入行为漂移 → 靠 V1 实测门 + 搬移前后 rg 行为锚点 diff 守护 |
| ❌ core orchestration 定义 SessionRecoveryPort 后壳实现 | 当下仅一个 adapter——one adapter = hypothetical seam，违反本架构审查第一原则 | 多一步端口抽象 + 双层间接 | 端口形状凭空设计，第三宿主接入时大概率重改 |
| ❌ 不抽，仅给 index.ts 补导出测试 hook | 测试仍需挂载整个 index.ts，12-mock 打桩面不降 | 最低 | C6 的整类 mock 问题原样留存 |

**组 B barrel 策略**（用户已裁决单 barrel 扩面，此处记录被否谱系）：

| 方案 | 长期合理性 | 短期成本 | 风险 |
|------|-----------|---------|------|
| ✅ 单 barrel 扩面 + 删 `./*` 开发通配 | 一个 semver 契约面；编译期牙齿防深路径回流；diff 可审纪律维持 | barrel 35→~100 符号逐名列出 + 114 处机械替换 | barrel 变大 → 按域注释分段（现状三段式延续）可控 |
| ❌ 分域子入口（./execution 等 3 条） | 把深路径合法化为 3 条新契约面，壳 import 仍分多处；每条子入口都是独立 semver 面 | package.json exports + publishConfig 三处声明 | 契约面数量翻倍，与「一个面」目标背道而驰 |
| ❌ 维持现状（深路径豁免） | 每轮 core 重构继续产生隐性 breaking（63→114 已实证）；发布面永久与仓内形态不一致 | 零 | 摩擦单调递增，无退出条件 |

**C5 时机与裁决**（r2 终态：撤销，谱系见 §3.2 B-3）：

| 方案 | 长期合理性 | 短期成本 | 风险 |
|------|-----------|---------|------|
| ✅ 本轮撤销，登记 follow-up 触发条件 | 依赖闭包证据（三调用点 + 15 成员）显示抽出无 locality 收益；边界裁决留档避免后续轮次重发现 | 零 | 无（不动该文件内部结构） |
| ❌ 本轮做（r1 曾纳入组 B） | runAndFinalize 三轴共享、chatPiEngine 双消费方、deps ≥15 成员——任何切法都是文件搬家 + port 间接 | 一个单元 + 回归验证 | 空壳 module / 回调环 / public 面破裂三重反例（r2 已实证） |
| ❌ 排后但无触发条件 | 同「撤销」但无边界裁决记录，后续审查重新发现同样反例 | 零 | 重复劳动 |

**C4 tui-kit 形态**：kit 为零依赖叶 module（零壳内部 module 依赖；唯一外部依赖 = pi-tui 的 `visibleWidth` 纯函数——实施期口径，偏差 #12：边框家族的 ANSI 可见宽度计算需要它，设计期「仅依赖 node/tty 探测」描述作废，kit 无任何 node/tty import），不依赖 format.ts（布局家族随迁后依赖方向为 format.ts → kit 单向 re-export，见 §3.3 偏差 #11 补记）——两个方案中被否的是「并入 format.ts」（format 已 36 导出过宽，再吸收零件加剧三合一问题）。

### 3.6 关键决策清单

- **D1**：seam 放壳（单入口函数 `setupSessionLifecycle`）。被否：core 端口（hypothetical seam）/ 仅导出 hook（不降打桩面）。证据：§2.2 C1 + 测试拓扑投影。
- **D2**：随迁以「原样搬移」为纪律，行为变更（守卫合一、lazyDeps 改惰性回调）单独成条且各配测试。被否：借搬移顺手重构（漂移风险不可归因）。
- **D3**：barrel 扩面判定标准 = 壳非测试代码实际消费 ≥1 处；`./*` 开发通配删除作为回防牙齿，**删除前置条件** = runtime 2 处深路径符号进 barrel 归一顶层（r3 改判，不新增子入口——见 D9）+ 壳 vitest alias 直引 core `__tests__` helpers（7 壳测试改走 alias specifier，helpers 物理零移动；实际形态为 testing 字符串条目 → core `src` 根 + 正则条目兜底测试残留 .ts 深路径，见 B-2 偏差 #17 扩补），全部随 u-2 本体完成。被否：分域子入口 / 维持豁免 / `./testing` 发布子入口（r1 方案——进 semver 公共面 + 撞 check-subagent-core-closure 的 `__tests__` 豁免面，pi type import 命中 BANNED_PREFIXES + vitest 运行时 import 进 dist 缺依赖，r2 否决）/ **session-view 2 条子入口（r2 方案——每新增子入口 bundle 即多一份 host-services 副本，configureCore 分裂面扩大，r3 否决）**。
- **D4**：sync 轨删除定案（决策条件已满足：agent-registry 已迁 async，走查零生产调用实证）。
- **D5-补注**：extraction D5「壳侧深路径不受约束」豁免终止，由本设计收口——非推翻 D5，是 D5 判据（宿主触点证据）的首次执行。
- **D6**：**C5 撤销**（r2 裁决，被否谱系与反例见 §3.2 B-3；follow-up 触发条件已登记）。ChatRoundTicket 双形态维持 dual-track u-3b 裁决不变；subagent-service 五轴本轮零内部拆分。
- **D7**：C4 kit 为零依赖叶；list-shared KeyHandler 不动。
- **D8**：单例语义在 deps 工厂中整体保留（existing-??-new + 条件 set 封装为 createOrReuseServices；裸 new 禁止出现在 deps 默认实现；initModel/initSession 对 new/reused **均无条件执行**，reused 标志仅供测试断言）；单例访问器四件进 barrel。
- **D9**：dist 双形态：模块级可变状态实测 7 处非 globalThis 持有（要害 host-services.ts:49 configuredHost——configureCore 写入目标）——**根治动作**：configuredHost 与 notify-ports 配置态 globalThis 化（u-2 内，与单例访问器范式一致）；本设计不新增任何子入口（runtime 归一 barrel），新分裂面为零；验证走静态门（dist 重复 module 比对 + 子入口导出面白名单 + require smoke；zsw vendor 双入口消费已于 u-2c 核对为单入口消费，一次性人工结论——zsw vendor 清单在外部仓，本仓不可机器复验），不用运行时探针（同 specifier 二次 import 恒真，无效）。静态门①②已脚本化为 scripts/check-core-dist-gate.mjs（一致性审查修复产物），③由既有 scripts/smoke-core-dist.mjs 承载。

## 4. 验收

按组给真实场景（AGENTS.md 钦定实测路径：本地 pi CLI + subagent-workflow 源码 extension；`pi --mode rpc --session-dir <dir> --model ... --extension <path>` + stdin JSONL）。每个场景标注回溯目标。

### 组 A（回溯目标 1「纯装配」/ 6「打桩面收窄」）

- **A-V1（session_start 链路零回归，实测）**：隔离 pi CLI（/tmp session 目录，避开 workspace-root 探测坑）spawn 一个 background subagent → 断言：identity custom entry 落 session JSONL（写入字段 12 项与基线 diff 零差异；类型 13 项含 1 个 @deprecated parentSessionId 不写入）、notify ledger revive 日志形态不变、worktree reaper scan 执行（debug 日志锚点）。对照基线：搬移前同环境采集（沿用 dual-track V4 方法）。通过标准 = 行为锚点逐项一致。
- **A-V1b（reused=true 路径，实测——同进程二次 session_start）**：pi CLI 同进程二次 session_start（设计时选 TUI `/new`；2026-09-03 Gate B 实测触发 = `new_session` RPC 命令——/new 的 RPC 等价物，同 pid 内触发 reason="new" 的 session_start） → 断言（锚点 `XYZ_AGENT_DEBUG=1` 扩展日志）：无第二个 SubagentService 实例（getSubagentService 引用同一）、initSession 覆盖生效（sessionId 更新、uiRequestHandler 换新）、GC timer 不翻倍（单 timer 锚点）。守护 D8 的 init 无条件语义。
- **A-V2（kill-9 恢复实测）**：构造 running 态 state 文件 + kill 主进程 → 重启 session_start → 断言 run 转 done/failed、pending:unregister 事件、state 落盘。通过标准 = 与搬移前行为一致（幂等重试语义保留）。
- **A-V3（测试打桩面，机器可验）**：改写整类 mock SubagentService 的 **7 个测试文件**（session-start-reaper / index-session-start / index-session-start-identity / crash-recovery / stream-sink-guard / command-handlers / subagent-tool-path-guard）为 seam 注入或访问器 mock 形态后，`rg 'vi.mock' 壳/src/__tests__` 计数：单文件 vi.mock ≤3 且不含 SubagentService/pi-ai/typebox 手写整类桩（共享桩转发的 vi.mock 不在此列）。通过标准 = 7 文件全覆盖 + 计数达标 + 全量测试绿。
- **A-V4（组合根纯度，机器可验）**：index.ts 行数 ≤650（实施期校准 2026-09-03：初稿 ≤350 与 §3.1 随迁表不相容——u-4 随迁实际减量 309 行（945→636），阶段 4 恢复 lazyDeps 2 成员后 +14（HEAD 650）；行数线取 650 是「D2 原样搬移纪律下的实际可达值、压线余量为 0」的记录；设计期曾有 ~408 上限估算，实测未达——随迁块内注释/类型签名保留在组合根）且 `rg 'new (SubagentService|ModelConfigService|WorktreeManager|JsonlRunStore)' src/index.ts` 零命中（构造全部进 deps 工厂 / session-lifecycle）。
- **A-V5（C6 负面行为反向验证，机器可验）**：`rg 'vi\.mock\("\.\./commands|vi\.mock\("\.\./tools|vi\.mock\("\.\./tui' 壳/src/__tests__` 零命中（死路径 mock 清零）；同文件同模块重复 vi.mock 注册 = 0（lint 级检查随 u-5 写入共享桩 module 的使用约定）。

### 组 B（回溯目标 2「契约面=消费面」/ 3「死轨清零」）

- **B-V1（import 收口，机器可验）**：`rg "from '@zhushanwen/subagent-core/" 壳/src 壳/bench packages/runtime/src` 生产代码命中仅为显式子入口（现有 4 条）与 `./workflows/*`——runtime 2 处已归一 barrel；壳测试另允许 vitest alias specifier（`@zhushanwen/subagent-core/testing/<域>/__tests__/<file>` 形态，7 文件）与正则 alias 兜底的残留 `.ts` 深路径（`from` / vi.mock / 动态 import 三种形态，数量以 rg 实测为准——见 B-2 偏差 #17）；门的扫描范围排除 `**/__tests__/**`（生产口径，偏差 #18）——与 §3.2 B-2 保留声明逐条对齐；tsc 全绿即通配删除后无残留深路径。
- **B-V2（发布面 + dist 静态门，实测）**：`npm pack --dry-run` 输出面包含全部新增 barrel 导出（无新增子入口）；CORE_PACKAGE_VERSION bump minor（新增导出走 minor，D5 纪律）；dist 静态门（D9：主 bundle × 4 现有子入口重复 module 比对 + 导出面白名单 + smoke-core-dist.mjs require smoke；zsw vendor 双入口消费核对为 u-2c 一次性人工结论，不在复跑门内）通过。
- **B-V3（chat 域零回归，实测）**：pi CLI 实测 chat 模式 subagent（fork-from-session 场景含）→ record 机器字段形态与 u-2a 基线 diff 归因模型非确定性（沿用 A1 判定方法）——B 组未动轮次机（C5 撤销），此项为 barrel 收口对 execution 面的回归守护。
- **B-V4（sync 删除，机器可验）**：`rg 'discoverResourcesSync|scanNpmDirSync' 全仓` 代码与测试零命中（docs/历史文档引用除外——设计文档与 ADR 记录被删函数名属正常）；resource-discovery 测试全绿（async 单侧契约）。
- **B-V5（workflow 域冒烟，实测）**：pi CLI 跑一个两步 workflow 脚本（agent() ×2）成功完成——B-2 动了 execution/orchestration 消费面，冒烟确认编排无回归。

### 组 C（回溯目标 5「零件单点」）

- **C-V1（视觉对照，实测）**：pi CLI TUI 打开 subagents 全屏列表与 workflows 视图各截图，与改动前对照：边框/分页/长任务耗时显示（>1h 显示 `1h15m` 形态）逐项一致。通过标准 = 双视图零视觉回归。
- **C-V2（单点，机器可验）**：`rg 'TERM_ROWS_FALLBACK|PAGE_SCROLL_DEFAULT' 壳/src` 各 1 处定义（同文件使用与消费点 import 不计——TERM_ROWS_FALLBACK 定义 1 + tui-kit 同文件使用 1、PAGE_SCROLL_DEFAULT 定义 1 + 消费点 6，偏差 #14 按定义口径）；`rg 'titleBorder' 壳/src/interface` 仅 tui-kit 与实际消费方（list-component；WorkflowsView 无标题框形态不消费 titleBorder，其边框族消费 b/dashes/plainBorder/walled/termRows）。

### 收尾门（三组共享）

extensions 三连（typecheck/lint/test）+ core 全量 + runtime 全量全绿；壳测试总数不降（改写测试不允许静默删用例——数量对账写进 impl-plan）。**打包验证门（对齐 dual-track V4③ 先例，壳是 builtin staged mandatory 包，114 处 import 切换 + index.ts 重构正触打包事故最高发面）**：`pnpm run build` + `bash scripts/validate-runtime-bundle.sh` exit 0（u-2 与 u-4 各自单元门跑一次，收尾门复跑）；staged 产物符号探针（新 barrel 符号在 bundle 中可解析）。

## 5. 下一层拆分

实施顺序与依赖（文件交叠趋零，B-1 独立先行；A 与 B-2 之后可并行）：

```
u-1 (C3) sync死轨删除 ──┐
u-2 (C2) barrel扩面+import归一（壳/bench/runtime）+配置态globalThis化+壳测试alias
u-4 (C1) session-lifecycle抽出 ──→ u-5 (C6) 测试桩收敛+卫生+迁包
u-6 (C4) tui-kit（与上述全并行）
```

（u-3「chat-round-machine 抽出」随 C5 撤销移除，编号保留空洞避免后续文档引用错位。）

| 单元 | 内容 | 文件改动地图（估） | justification / 待验证 |
|------|------|------------------|----------------------|
| u-1 | C3：删 sync 五函数 + 注释 + parity 测试改单侧 | core `shared/resource-discovery.ts`（-160）+ 其测试 | 最小风险先行，验证 B 组工作流；前置 rg 门（非测试调用零命中）实施期复跑 |
| u-2 | C2：barrel 扩面逐名清单（含 session-view 2 符号）+ 壳/bench 114 处归一 + runtime 2 处归一 barrel + **host-services/notify-ports 配置态 globalThis 化（D9 根治）** + 壳 vitest alias（7 测试改引，helpers 物理不动）+ 删 `./*` 通配 + minor bump + dist 静态门 | core `src/index.ts` + `package.json` + `core/host-services.ts` + `core/notify-ports.ts` + 壳 ~40 文件 import 行 + `vitest.config.ts`（alias）+ runtime 2 文件 import 行 | 删通配的击穿面（runtime/测试助手）随本单元一体处置，合入即套件绿；**待验证**：tsc 增量报错清单与 rg 深路径清单（含 runtime）一致（收口完整性门）；dist 重复 module 比对清单 + zsw vendor 双入口消费形态（D9） |
| u-4 | C1：session-lifecycle 抽出 + deps 工厂（createOrReuseServices 保单例语义，init 无条件）+ 守卫合一 + lazyDeps 改惰性回调 | 壳 `src/session-lifecycle.ts`（新 ~400，实施终态 488）+ `index.ts`（945→~300 为设计期估算；实施校准见 §4 A-V4：终态 636/HEAD 650） | 原样搬移纪律（D2），行为变更点独立成条；A-V1/V1b/V2 实测门在段末 |
| u-5 | C6：共享桩 module + 死 mock 清零 + 重复注册清零 + 3 测试迁回 core | 壳 `mocks/runtime-stubs.ts`（新）+ ~15 测试文件改写 + 3 文件迁移 | 依赖 u-4（seam 先立，7 个整类 mock 测试才有改写目标）；D15 决策补注「运行时桩收敛至共享 module」 |
| u-6 | C4：tui-kit + views 常量下沉 + elapsed 合并 | 壳 `src/interface/tui-kit.ts`（新 ~120，实施终态 278——含布局家族随迁，偏差 #11）+ format/list-*/WorkflowsView | 全并行；视觉对照门 C-V1 |

每单元验收独立可跑（对应 §4 场景），impl-plan 按本表展开为逐文件迁移清单 + 测试切换清单（下一层产物）。

## 6. 与既有决策/ADR 的关系核对

- **extraction D5**：补注而非推翻（§3.6 D5-补注；extraction 文档 D5 段落已落终止注记，2026-09）——豁免终止的依据是 D5 自身判据。
- **dual-track D6（ChatRoundTicket 双形态）**：维持，C5 不触碰（u-3b 偏差表已固化理由）。
- **dual-track D7-①（views/format 并入）**：延续执行（C4 是其未完成半程的收尾，非翻案）。
- **ADR-0035（worktree 启动恢复）/ ADR-0049（per-session 隔离）**：行为随迁不改语义，A-V1/V2 实测守护。
- **无 ADR 冲突项**：本设计不与任何 constraints.json 登记约束冲突（不触碰 pi 版本锚点 / env 边界 / CSP 面）。
