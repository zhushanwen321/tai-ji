# goal 桥跨扩展通道修复（pi 0.84.4：pi API 对象挂载 → globalThis slot）

> **一句话结论**：goal→plan 的 `__goalInit` 编程式接口因「pi 0.84.4 为每个扩展创建独立 ExtensionAPI 对象」而在运行时恒不可达；本设计将暴露通道从「挂 pi API 对象」迁移到 `globalThis[Symbol.for]` 进程级 slot 直挂函数（C-ext-06 既有惯例形态，仓内单向/单例 slot 十余处现役同款裸挂），桥在独立 pi 与 xyz-agent 桌面双形态恢复可达——`GoalInitFn` 签名与 plan 侧 D2 五值失败出口设计零变更。

**触及最高 P 级**：P2（plan 面板能力，`docs/feature-priorities.md` plan 行；goal 为 P3） · **风险分**：4/10（P2 基数 4 + 可逆性 0：纯进程内通道替换、无持久化数据/协议迁移 + 新颖度 0：仓内 4 个 `Symbol.for` slot 现役实例 + 1 个跨包握手先例） · 主要风险源：slot 内 fn 在 goal 扩展失效后的残留调用（既有 internal-error 出口兜底，§3.3-D5）。

**层性质声明**：当前层 = 技术方案设计，下一层 = 实施单元拆分（impl-plan）。涉及运行时行为 / 数据流 / 错误处理，准则 5/6/7（探针 / 物理数据流 / 错误恢复指引）全部 P0 适用。

**pi 语义断言权威源**：本仓 node_modules 实装 `@earendil-works/pi-coding-agent@0.84.4`（`npm ls` 核对 ✅，2026-09-14）。文中 pi 行为断言均附实装文件:行号；标 ⛔ 的为实施期探针待验项。

**证据基线**：桥断裂现象与根因已由 ext-simplify-06 u0 探针（2026-09-14，`.tmp/dev-flow/probe-06.md`，gitignored）与本设计起草期独立重跑的双扩展最小实验（§4.3 P-1）双重实证；设计起草日行号以当前 HEAD 为准。

---

## 1. 背景目标

### SCQA

- **Situation**：xyz-agent 维护 21 个 `@zhushanwen/pi-*` extension。其中 plan（计划模式工具）与 goal（目标驱动执行）协作：用户在 plan 的 complete 对话框选择「Goal-driven execution (/goal)」档时，plan 需调用 goal 的编程式初始化接口（下称**goal 桥**）在压缩后的会话里预建 goal。
- **Complication**：pi 0.84.4 的扩展加载器为**每个扩展创建独立的 ExtensionAPI 对象**——goal 挂在自己收到的 pi 对象上的 `__goalInit` 字段，plan 在自己收到的（另一个）pi 对象上永远探测不到。桥自旧仓迁移带入以来（本仓 git 史最早 `e726711d0`）从未在真实双扩展环境跑通过，2026-09-14 ext-simplify-06 u0 探针首次真机暴露。
- **Question**：在 pi 0.84.4 无官方跨扩展 API 的前提下，plan 如何可靠读到 goal 的初始化能力，且独立 pi 安装与 xyz-agent builtin 双形态同时成立？
- **Answer**（本设计）：goal 侧把 `GoalInitFn` 直接挂到 `globalThis[Symbol.for("@zhushanwen/pi-goal.goalInit")]` slot，plan 侧在使用时读取——仓内 C-ext-06 进程级共享惯例的通行形态（单向/单例 slot 十余处现役裸挂）。已排除方向（§3.2 展开论证）：等 pi 官方机制（0.84.4 实装无此能力）、xyz-agent runtime 接线（违背 universal 自足性）、plan 运行时 import goal（拿不到 goal 扩展实例闭包 + 倒退 optional peer）。

### 系统是什么（受众背景补足）

假设读者了解 pi extension 基本形态（factory 函数 `export default (pi: ExtensionAPI) => void`），但不懂 plan/goal 内部。三个关键角色：

- **plan 扩展**（`extensions/universal/plan/`，universal 组 = 独立通用包）：提供 `plan` 工具，AI 在计划模式下起草 plan 文件后调 `action=complete` 结束计划期。complete 时弹出执行方式对话框（`resolveCompleteChoice`，tool.ts:245-251），选项由 `buildExecOptions(pi)` 构造——其中 goal 档「Goal-driven execution (/goal)」按 `detectGoalCapability(pi)` 探测结果决定是否出现（tool.ts:225）。
- **goal 扩展**（`extensions/universal/goal/`）：目标驱动执行——`/goal` 命令族 + `goal_control` 工具 + widget 投影 + token 预算。goal 创建有两条入口：用户命令（`/goal <objective>`）与编程式接口 `__goalInit`（service.ts `createGoal` 唯一创建入口，FR-3.1）。**goal 桥**指后者被 plan 消费的通道——这是两包唯一的跨包运行时接触面（类型经 `import type { GoalInitFn } from "@zhushanwen/pi-goal"` 擦除，运行时零依赖，compact.ts:6）。
- **pi 扩展加载器**（实装 `dist/core/extensions/loader.js`）：对每个 `--extension` 路径走 `loadExtensionsInternal`（:499-509 循环）→ `initializeExtension`（:459-472）：先建全新登记表 `createExtension()`（:441-458），再建全新 API 对象 `createExtensionAPI(extension, runtime, cwd, eventBus)`（:209），然后 `factory(load.api)`。官方注释自述设计意图（:204-208）：*"Create the ExtensionAPI for an extension. Registration methods write to the extension object. Action methods delegate to the shared runtime."*——**pi 的共享面是 runtime 与 eventBus（循环外创建一次、逐个传入），API 对象本身从不共享**。

桥的消费时序（设计 06 §6.2 D2 已定，本设计不动）：plan complete 的 goal 档被选中 → compact 档在 `session_before_compact` 的 `onComplete` 回调内调 `tryGoalInit`（goal 状态 entry 须在压缩后世界里创建）→ 成功发 goal steer、失败按五值 reason 发降级 steer + warning notify。

### 目标（从使用者体验倒推）

| # | 目标 | 使用者体验表述 |
|---|------|--------------|
| G1 | goal 桥在独立 pi 双扩展形态产品级可达 | 独立 pi 用户同时安装 goal+plan 两包，plan complete 对话框出现 goal 档；选中后 goal 真实创建、compact 后 `/goal status` 可见、steer 兑现「Execute via /goal」承诺 |
| G2 | xyz-agent 桌面形态同样可达 | 桌面用户（goal 为 builtin 打包、plan 为用户安装——两包注入来源不同但同进程加载）在 plan complete 对话框看到并选中 goal 档，goal widget 出现——双形态同一机制，无宿主特有通路 |
| G3 | 未装 goal 时行为等价于现状 | 只装 plan 时对话框不出现 goal 档、无报错；goal 档缺失只剩「未装」一种合法语义，不再有「装了却看不见」的静默断裂 |
| G4 | D2 显式化设计在真实链路兑现 | ext-simplify-06 D2 的五值失败出口 + 恢复指引从「仅单测 mock 可达」变为真实链路可达——桥修复后其价值立即兑现，无需返工 |

### in-scope / out-of-scope

**In-scope**：goal 侧暴露通道改造（slot 模块 + factory 挂载）；plan 侧探测改造（`getGoalInit`/`detectGoalCapability`/`tryGoalInit` 单点）；两侧测试 mock 形态与真实通道对齐；06/03 设计文档与 `GoalInitFn` docstring 的通道表述回写；changeset。

**Out-of-scope**：`GoalInitFn` 签名与 D2 五值失败出口设计（06 已定稿，本设计只换「从哪读到这个函数」）；goal 本体功能；compact 档 goalInit 的执行时序（onComplete 内，06 已裁决）；pi 上游机制推动（受「不改 pi 源码、不提 PR、不 fork」红线约束，仅登记迁移观察项 §3.3-D6）；subagent-workflow 历史消费方恢复（现无 `__goalInit` 引用，全仓 grep 核实 ✅，无需求方）。

---

## 2. 现状与问题分析

**本章结论**：goal 档恒缺失的直接表现是静默的（无报错、与「未装 goal」合法降级同构），根因是「挂 pi API 对象字段」这条通道形态从诞生起就偏离 pi 的 per-extension 架构，且全部既有验证停留在 mock 层——mock 世界构造的共享 pi 对象掩盖了真实世界的对象隔离。

### 2.1 现状的真实样子

**用户看到的**（2026-09-14 真机实测，probe-06 driver 全链路）：plan complete 对话框恒为 4 选项——`["Subagent-driven execution", "Single-agent (current session)", "Modify the plan first", "Save for later"]`，goal 档「Goal-driven execution (/goal)」恒缺失；goal 扩展本体加载成功（同会话 `/goal status` 响应正常）。

**代码里的**（两侧取自实装，行号为 2026-09-14 HEAD）：

goal 侧挂载（`extensions/universal/goal/src/index.ts:133-143`）——挂在自己 factory 收到的 pi 对象上，闭包捕获 factory 级 `session`（:37-38，`createGoalSession()` factory 闭包持有、进程内唯一，session_start 就地重建其内部 state 而非替换对象）：

```ts
const api = pi as ExtensionAPI & { __goalInit?: GoalInitFn };
api.__goalInit = (objective, budget, ctx, slug?, successCriteria?) => {
  if (!ctx) return false;
  return createGoal(session, objective, budget ?? {}, buildPorts(pi, ctx), slug, successCriteria);
};
```

plan 侧探测（`extensions/universal/plan/src/compact.ts:83-91`）——单一断言点，在自己收到的（另一个）pi 对象上探测：

```ts
function getGoalInit(pi: ExtensionAPI): GoalInitFn | undefined {
  const api = pi as ExtensionAPI & { __goalInit?: GoalInitFn };
  return typeof api.__goalInit === "function" ? api.__goalInit : undefined;
}
export function detectGoalCapability(pi: ExtensionAPI): boolean {
  return getGoalInit(pi) !== undefined;
}
```

### 2.2 怎么出错

单一失败模式，静默且恒定：`detectGoalCapability` 恒 false → goal 档从对话框剔除（tool.ts:225 filter）→ `tryGoalInit` 恒走 `goal-unavailable` 出口（compact.ts:168）。无报错、无 warning——goal 档缺失与「用户未装 goal」的合法降级形态完全同构，用户无从察觉。

**为何长期未发现——mock 世界的裂缝**：plan 的全部既有测试在自建 pi 对象上直接挂 `__goalInit`（如 compact-handler.test.ts:58 `(pi as Record<string, unknown>).__goalInit = fn`；tool.test.ts:189 用例名自带 "mocked pi.__goalInit world" 标注）——mock 世界里桥恒可达，真实世界恒不可达，两个世界从未对齐。桥自旧仓迁入（`e726711d0`）以来从未有真机双扩展验证；ext-simplify-03 设计时将其列为「现有能力（全部保留）」（ext-simplify-03-goal.md:18）并类型规范化为 `GoalInitFn`（API-1 单一权威源）——文档审查视角下纸面自洽，审不出运行时断裂；2026-09-14 ext-simplify-06 u0 探针第一次真机跑 complete 全链路才暴露。

### 2.3 根因 + 物理数据流

根因一句话：**「挂 pi API 对象字段」这条通道形态从诞生起就偏离 pi 的架构意图**——pi 的扩展 API 是 per-extension 的「本扩展登记表写柄 + 共享 runtime 读柄」（loader.js:204-208 官方注释），不是扩展间总线；扩展间真正共享的只有 runtime 与 eventBus，而这两者 pi 0.84.4 都未向扩展暴露跨扩展寻址能力（types.d.ts ExtensionAPI 动作面 :906-1155 全量过目：`on`/`sendMessage`/`onTerminalInput` 等，无 listExtensions/跨扩展 registry/定向 emit——bridge-rewrite-pi-0.84.md §2.1 断点②同口径核实）。

现状断裂流 vs 目标流（P = pi 进程内）：

```
现状（断裂）：
goal factory ──挂──▶ pi 对象 A（goal 的）        plan factory ──探测──▶ pi 对象 B（plan 的）
                     └ __goalInit = fn                                └ typeof __goalInit → undefined ✗
                     （A 与 B 是不同实例，字段挂载是对象级副作用，不可见）

目标（slot）：
goal factory ──Reflect.set──▶ globalThis[Symbol.for("@zhushanwen/pi-goal.goalInit")] = goalInitFn
plan 使用时（buildExecOptions / tryGoalInit）──读──▶ 同一 slot（进程级唯一，跨扩展可见）✓
```

进程拓扑（双形态同一机制）：xyz-agent 桌面每个会话 spawn 一个 pi 进程，扩展经 `--mode rpc --no-extensions --extension <path>` 显式注入（rpc-client.ts:216-230）——**两包的注入来源不同但汇入同一注入清单、同进程加载**：goal 是 builtin（mandatory-extensions.json 18 项含 `@zhushanwen/pi-goal`，bundle 后 staged），plan 不在 builtin 清单（18 项无 pi-plan ✅核实），经用户安装通道进入注入集合（extension-resolver 六源发现）——同进程内 `globalThis` 天然共享，与来源形态无关；独立 pi 用户进程边界同理。多 pi 进程各自的 `globalThis` 互不可见——无跨进程串扰面。

> **slot** = 挂在 `globalThis` 上、以 `Symbol.for(key)` 全局注册表 symbol 为键的进程级共享槽位。`Symbol.for` 对同一 key 字符串跨所有模块实例返回同一 symbol，`globalThis` 进程级唯一——无论 pi 的 jiti 加载器把同一模块加载成几份实例，读写的是同一 slot（development-guide.md §7.5「为什么有效」，C-ext-06 权威表述）。

---

## 3. 解决方案

**本章结论**：通道迁移到 `globalThis[Symbol.for]` slot（方案 A，六个决策 D1-D6 支撑）——goal 直挂函数、plan 使用时以 typeof 守卫读取，D2 五值失败出口原样承接 slot 世界的全部异常形态，不为边缘场景新增机制。

### 3.1 终态（使用者视角先行）

**场景 A：成功路径**（回溯 G1/G2）。独立 pi 用户安装 goal+plan，AI 起草含 `## Implementation Steps` 编号步骤的 plan 文件后调 `plan(action=complete, isolation=compact)`。对话框出现 5 选项（goal 档「Goal-driven execution (/goal)」排在第 2 位，tool.ts EXEC_MODE_OPTIONS 定义序）：`["Subagent-driven execution", "Goal-driven execution (/goal)", "Single-agent (current session)", "Modify the plan first", "Save for later"]`。用户选 goal 档 → compaction 完成 → AI 收到 goal steer（`Execute via /goal: Execute plan: <path>`）并开始执行 → `/goal status` 显示 active goal（objective/slug/预算/成功判据来自 plan 文件派生）→ goal widget 投影出现 → goal 状态 entry 在压缩后世界存活（`session_before_compact` 的 onComplete 时序，06 已定）。

**场景 B：失败路径**（回溯 G3/G4）。五值出口全部带恢复指引（GOAL_FAILURE_RECOVERY，compact.ts:156-162，本设计零变更），每个失败经降级 steer（AI 可见）+ warning notify（用户可见）报告：

| reason | 触发 | 恢复指引（既有） |
|---|---|---|
| goal-unavailable | goal 未装（slot 不存在或值非函数） | The goal extension is not loaded — choose another execution method. |
| plan-unreadable | plan 文件读取失败 | 检查文件存在性后重试 complete |
| no-steps | 提取到 0 条编号步骤 | 补 `## Implementation Steps` 编号步骤后重试 |
| init-refused | 已有 active goal / ctx 缺失 | `/goal clear` 或沿用现有 goal |
| internal-error | goalInit 抛出意外异常（**含 slot 残留 fn 调用失效，本设计归入**） | 降级 steer 已含分步执行指引，异常详情进 notify 与日志 |

goal 档缺失从此只剩一种合法语义：用户未装 goal（slot 不存在/值非函数，goal-unavailable 降级）；独立安装形态下跨包版本漂移导致的签名错配不产生新失败类，按两种形态分别收敛（r2 主审 S1 断言校准）：**失败形态**落既有出口（旧 fn 返回 false → init-refused、抛错 → internal-error，恢复动作同为降级 steer + warning notify，与 goal-unavailable 的用户感知差仅一行文案）；**成功形态**（尾部加参、位重排等仍能跑完的错配——如位重排后 goal 侧创建路径只碰 pi 不碰调用方 ctx，可静默畸形成功不落任何出口）不在桥层兜底，由源头机制拦截：同仓 type SSOT 编译期拦截（改签名 plan `tsc --noEmit` 即红）+ npm semver major 发布约定（§3.3-D2 被否谱系第三层）。

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|-------------|------|------|
| **A. `globalThis[Symbol.for]` slot 直挂函数（推荐）** | 好：C-ext-06 既有规范形态（进程级共享强制 globalThis slot）；仓内单向/单例 slot 十余处现役同款裸挂（ask-user / permission / subagent-workflow / subagent-core 多处）；双形态天然覆盖（同进程即共享，§2.3 拓扑）；不依赖 pi 内部结构——pi 升级免疫 | 低：goal 侧挂载 ~5 行；plan 侧 `getGoalInit` 内部换读取 ~5 行；两侧测试 mock 形态同步改 | 4/10：slot 残留 fn 调用 → internal-error 出口兜底（§3.3-D5）；独立安装跨包版本漂移错配 → 失败形态落 init-refused/internal-error 既有出口、成功形态由 type SSOT + semver 源头拦（§3.3-D2） | ✅ |
| B. 等/推动 pi 官方跨扩展机制 | 长期最正，但 0.84.4 实装无此能力（types.d.ts 全量核实）；受「不提 PR 不 fork」红线约束，节奏不可控 → 桥无限期不可用 | 零成本，零交付 | G1 场景无限期 blocked | ❌（保留为 A 的迁移观察项，§3.3-D6） |
| C. xyz-agent runtime 侧接线 | 差：只救桌面形态，独立 pi 仍断；plan/goal 均为 universal 组（自足性是分组契约）；引入宿主特有通路 | 中：runtime 侧新增装配点 | 独立 pi 用户（G1）永远看不到 goal 档 | ❌ |
| D. plan 运行时 import goal 包 | 差：静态 import 拿到的是另一份模块实例的导出，**拿不到 goal factory 闭包里的 `session`**（goalInit 依赖它，index.ts:38/:142）；optional peer 倒退为 required（06 刚做的 optional 化倒退）；跨扩展 import 触发 jiti 双路径加载分裂（C-ext-06 触发场景①，ask-user M4 劫持事故同类） | 低 | session 分裂 = goal 状态错乱，正确性风险 | ❌ |

**推荐 A**。被否若用：B 则 §3.1 场景 A 无限期待验收、G4 兑现无期；C 则独立 pi 用户的对话框永远 4 选项——G1 不成立；D 则 goal/plan 任一单独装卸时 plan 加载失败（required 依赖），且 M4 类「双实例 session 劫持」事故形态回归。

### 3.3 关键决策与权衡

**D1：通道载体 = `globalThis[Symbol.for]` slot（选定）**

- **采用**：见 §3.2 方案 A——goal 挂、plan 读，进程级共享，双形态同机制。
- **被否**：B/C/D 三方案（§3.2 展开各自被击穿的理由）。
- **证据**：C-ext-06（constraints.json，权威 development-guide.md §7.5——只强制载体 `globalThis[Symbol.for(包名.角色)]`，不强制 version/形状）；仓内现役 `Symbol.for` slot 十余处（grep 实证：ask-user CHANNEL_HANDSHAKE_KEY / permission FOOTER_HANDSHAKE_KEY + REQUEST_RENDER_KEY / subagent-workflow DIALOG_QUEUE_KEY / subagent-core registry·dialog-queue·notify-ledger 等多处）——其中带 version 的仅 registry 模式家族两例（ask-user channelHandshake、permission footerHandshake，双向共享可变 slot + pending 时序队列），**单向/单例 slot 全部裸挂**。
- **效果**：G1/G2 成立——这是仓内唯一同时在「独立 pi 双扩展」与「xyz-agent 桌面（builtin goal + 用户安装 plan 混载）」两种形态下都成立的通道形态。

**D2：slot 协议 = 裸函数直挂（选定）**

- **采用**：`globalThis[Symbol.for("@zhushanwen/pi-goal.goalInit")]` 直挂 `GoalInitFn`（key 命名遵循 C-ext-06「包名.角色」全限定规范，development-guide.md:822）；plan 读取守卫回退与现状 `getGoalInit` 同构的 `typeof fn === "function"`（仅换读取源为 slot）。
- **被否**：带 version 的握手对象 `{ version: 1, goalInit }` + version 校验——三重击穿：①其引用的 ask-user 先例前提不匹配：先例带 version 防的是「双向共享可变 slot（两侧都写）+ pending 时序队列 + 跨体系无类型共享」三条件下的形状错配写坏（M4 劫持事故形态），goal 桥是 goal 单写 / plan 只读 / D3 自证无时序窗口 / 同仓 type SSOT 存在，一条不占；②仓内形态学：单向与单例 slot 十余处全部裸挂，C-ext-06 权威原文只强制载体不强制 version；③裸函数的真实风险（签名错配）已有三层既有机制承接——同仓编译期 type SSOT（`import type { GoalInitFn }`，compact.ts:6，改签名 plan `tsc --noEmit` 即红）/ 五值出口运行时兜底（错配**失败形态**落 init-refused 或 internal-error；成功形态由前层拦，见 §3.1 尾段断言校准）/ npm semver major——version 是第四层重复表达，且其兑付依赖「签名变更时记得 bump」的人工纪律（r1 简洁审 F1）。
- **证据**：channel-registry-register.ts:5-16/:41-42/:87-114（先例的三前提实读）；仓内裸挂清单（D1 证据）；GOAL_FAILURE_RECOVERY 恢复动作等价性（compact.ts:156-162——goal-unavailable 与 init-refused/internal-error 的用户动作差仅一行文案）。
- **效果**：概念净减（省 version 常量、slot 形状 interface ×2 份、version-不兼容语义分支），两侧人工同步物从 2 个（key + version）减到 1 个（key 字符串）；goal-unavailable 回归单义「未装」；G3 不受损（「不误调」由 typeof 守卫保证，与 version 无关）。

**D3：探测时机 = 使用时读（不在加载时缓存）**

- **采用**：plan 在 `buildExecOptions`（complete 对话框构造）与 `tryGoalInit`（实际调用）两个使用点现场读 slot，与现状 `detectGoalCapability` 使用时探测的时机保持一致。
- **被否**：factory/加载时探测一次缓存 boolean——引入对 `--extension` 参数顺序的依赖（plan 先于 goal 加载时探测必 miss），且 goal 加载失败重载后缓存过期无失效机制。
- **证据**：pi loader 串行加载全部扩展后才进入会话生命周期（loadExtensionsInternal :506 循环 await）——complete 发生时 goal 的 factory 必已执行（若已加载），使用时读无时序窗口。
- **效果**：桥可达性对扩展加载顺序免疫；无缓存失效面。

**D4：挂载时机 = goal factory 内一次（与现状等价）**

- **采用**：goal factory 挂载 `Reflect.set(globalThis, KEY, goalInitFn)`，fn 闭包捕获 factory 级 `session`——与现状 `api.__goalInit = fn` 同点同语义，仅换可见域。
- **被否**：session_start 时挂载——`session` 本就是 factory 闭包级进程单例（index.ts:37-38，goal 的会话状态在 session 对象内部、session_start 时重建内容而非对象），换挂载点无语义收益反增延迟窗口。
- **效果**：goal 侧行为变更最小（挂载语句搬家，闭包结构不动）。

**D5：slot 残留与失效的处理 = 不做清理协议，调用异常走既有出口**

- **采用**：plan 对 slot 的异常形态全部折叠进 D2 既有出口——slot 不存在/值非函数 → `goal-unavailable`；fn 存在但调用抛错（goal 扩展加载失败后 api 失效、fn 内 `pi.sendMessage` throw 等）→ `internal-error`（tryGoalInit catch 出口，compact.ts:187-190 既有）。
- **被否**：goal 侧在加载失败/session_shutdown 时清 slot——pi 扩展无卸载生命周期保证（session_shutdown 后进程通常即退出，清理无消费者）；双向清理协议是为 <0.1% 边缘形态引入的第二套状态，违反「能用一个自洽机制解决的不接受两个字段两套检查」（AGENTS.md 架构偏好）。
- **证据**：`tryGoalInit` 的 catch 出口本就覆盖「goalInit 抛出意外异常」（06 设计 D2 明确 internal-error 含义）；`createExtensionAPI` 的 `assertActive` 在扩展失败后 throw（loader.js:214-218）——残留 fn 的调用会 throw 而非静默错行，正好落入 catch。
- **效果**：五值出口对 slot 世界的全部异常形态闭环，无新增机制。
- **已接受代价四要素**（slot 残留 fn 可被调用）：量级 = 仅「goal factory 已执行但扩展随后加载失败/失效」的窗口内可触发（正常装配不发生，量级 <0.1%）；恢复路径 = internal-error 出口（降级 steer 分步执行指引 + notify + 日志），进程退出 slot 随之消亡，无跨进程累积；重审条件 = 若日志中 internal-error 因 slot 残留高频出现（正常路径兜底被高频触发 = 正常路径 broken 的信号，AGENTS.md 规则 20），重开清理协议设计；显式判定 = 可接受（错误形态有出口、有指引、可观测，代价窗口极窄）。

**D6：pi 官方机制与同型通道 = 观察项登记，非本设计依赖**

- **采用**：两项登记。①pi 未来版本若提供官方跨扩展 API（升级 PR 必查项，受 C-proc-08 版本门禁流程覆盖），plan 侧读取可局部替换为官方通道——slot→官方的迁移是单点替换（一个函数体），不为此预留抽象层。②**同型通道死刑登记（r1 影响面审 S1，R2 修正加注对象）**：本设计的根因证据同样宣判 `pi.__workflowRun` 通道死刑——subagent-workflow 仍按同型模式挂载（`extensions/universal/subagent-workflow/src/index.ts:556` 实际挂载点，:6/:16/:80-84 为其类型与注释，挂 pi API 对象），运行时同样恒不可达；其消费方 coding-workflow 1.x 已退役、`runSingleAgent` 全仓零引用，故当前无用户可见影响——给真背书者 `docs/extensions/adr/pi-ext-020-coding-workflow-depends-on-workflow.md` 加注「通道恒不可达（pi 0.84.4 per-extension API 隔离，见 goal-bridge-cross-extension.md），禁止未来消费者按 Accepted 状态信任该模式；其『与 `pi.__goalInit` 同模式』表述随 goal 桥迁移 slot 而过时」，防重蹈（注意：仓内另有 `docs/adr/0020-core-user-flows.md` 为同名编号的不同 ADR，与本登记无关）。
- **被否**：为「未来官方机制」预写适配器接口（BridgeProvider 抽象之类）——为想象未来预付复杂度（over-engineering 反模式）；本次顺手修复 `__workflowRun`——无消费方（零引用），修复无收益方，超出本设计 scope（若 subagent-workflow 后续立项消费，按本设计同款 slot 形态另做）。
- **证据**：0.84.4 types.d.ts 无跨扩展面（§2.3）；C-proc-08 门禁流程已含「升级必查」机制；workflowRun 引用面 grep 实证（subagent-workflow 自身 + pi-ext-020，无外部消费方）。
- **效果**：方案 B 的长期价值以观察项形式保留不付当下成本；同型死通道显式登记，未来消费者不会再按文档信任恒不可达的模式。

**与 C-ext-19 的关系声明（审查预答）**：C-ext-19 管「结果语义通知必须确认式送达、禁依赖 pi 内存队列的 at-most-once 通道」。goal 桥是**进程内同步函数调用**（探测 + 调用，同 tick 完成），无送达语义、无跨进程/跨 turn 丢失面——不在 C-ext-19 约束域内。桥产出的 steer/notify 投递仍走 06 设计 D2 已定的通道（其本身已按确认式送达体系设计）。

### 3.4 实现机制（把终态落到代码层）

**goal 侧**（index.ts 内联改造，无新文件——slot 协议与 `GoalInitFn` 签名同轴演化，紧邻 `GoalInitFn` 类型导出单点归位，r1 简洁审 F2）：

```ts
// index.ts（GoalInitFn 导出紧邻处）：
const GOAL_INIT_SLOT_KEY = Symbol.for("@zhushanwen/pi-goal.goalInit");
// factory 内：挂载语句换可见域，fn 本体与闭包结构零变更
Reflect.set(globalThis, GOAL_INIT_SLOT_KEY, goalInitFn);
```

**plan 侧**（compact.ts 单点改造，tool.ts 调用点签名跟随）：

```ts
// getGoalInit 内部实现替换（签名去 pi 参数）；key 常量 plan 侧本地声明，
// 字符串字面量与 goal 侧一致——两侧不共享运行时模块（optional peer 格局），
// 注释互指对方文件，改名必须两侧同步（ask-user 先例同款约定，channel-registry-register.ts:26-28）
const GOAL_INIT_SLOT_KEY = Symbol.for("@zhushanwen/pi-goal.goalInit");
function getGoalInit(): GoalInitFn | undefined {
  const fn = Reflect.get(globalThis, GOAL_INIT_SLOT_KEY);
  return typeof fn === "function" ? (fn as GoalInitFn) : undefined;  // 守卫与现状同构，仅换读取源
}
export function detectGoalCapability(): boolean { return getGoalInit() !== undefined; }
function tryGoalInit(planFilePath: string, ctx: ExtensionContext): GoalBridgeOutcome { /* 同体，去 pi 参数 */ }
```

`GoalInitFn` 类型继续 `import type` from `@zhushanwen/pi-goal`（type-only，既有格局，无运行时依赖倒退）；两侧各自本地声明 key 常量（结构兼容即契约——slot 载体是字符串注册的 `Symbol.for`，无形状 interface 需要 DRY）。

**测试改造**（mock 世界对齐真实通道，两侧通用）：既有测试里 `(pi as ...).__goalInit = fn` 全部改为一行 `Reflect.set(globalThis, GOAL_INIT_SLOT_KEY, fn)`（本地直挂，不经对方包导出——避免 plan 测试对 goal 运行时的 devDep 耦合，r1 简洁审 F3）；goal 侧新增单测与既有 `index.test.ts` 桥用例同样写 slot——**teardown 清 slot 对两侧测试统一要求**（防跨用例 globalThis 泄漏，r1 影响面审 S2）。mock 与真实链路从此同构，这是本缺陷的元教训（§2.2）成文。

---

## 4. 验收（真实场景，非单测非 mock）

### 4.1 改动规模

大改动判定中的中等偏小一档：接口调整（桥通道替换）+ 行为变更（goal 档从恒缺失到可达），但影响面收敛在两包的桥接触点，D2 五值出口/恢复指引/goal 本体零变更。按大改动配多场景验收。

### 4.2 验收场景

环境基准：本地 pi CLI 实测（AGENTS.md MANDATORY：`pi --mode rpc -ne --session-dir <tmp> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <本地 plan> --extension <本地 goal>` + stdin JSONL，`-ne` 禁全局扩展防工具名冲突——probe-06 实测踩坑）；GUI 场景 `XYZ_DEV_BACKGROUND=1 pnpm dev` + browser-automation 连 CDP。

| 场景 | 回溯目标 | 真实流程 | 通过标准 |
|------|---------|---------|---------|
| **V1 goal 档出现 + 全链路兑现** | G1/G4 | probe-06 driver 同款流程：AI 写含 `## Implementation Steps` 3 条编号步骤的 plan 文件 → `plan(action=complete, isolation=compact)` → 自动应答 goal 档 → 压缩 → `/goal status` | 对话框 options 含 `Goal-driven execution (/goal)`（逐字留档）；compaction 完成后 AI 收到 goal steer 且开始执行；`/goal status` 显示 active goal（objective=`Execute plan: <路径>`、slug=plan 文件名派生、successCriteria 含总述+preview）；goal 状态 entry 在压缩后世界存活 |
| **V2 goal-unavailable 语义回归** | G3 | 仅加载 plan（不加载 goal）跑 complete，选非 goal 档正常执行 | 对话框恰 4 选项（Subagent/Single-agent/Modify/Save，逐字留档）、无任何报错/警告——goal 档缺失回归单义「未装」；对照 V1（同环境加载 goal 后 5 选项）确认差异仅来自 goal 档 |
| **V3 init-refused 真实触发** | G4 | 先 `/goal <objective>` 建 active goal → plan complete 选 goal 档 | 降级 steer 文案含 `init-refused` 与恢复指引（`/goal clear`）；warning notify 出现；既有 goal 不被破坏 |
| **V4 xyz-agent 桌面 GUI（混载形态）** | G2 | 前置：dev 环境为桌面装上 plan——dev-link **xyz 模式**（`bash .agents/skills/dev-link/link-local.sh plan` 写入 `.env.dev-extensions`，**dev 启动前需 `set -a && source .env.dev-extensions && set +a` 才注入**，r3 主审 S1；本地源码经 `XYZ_EXTENSION_PATHS` 注入 dev runtime → pi 子进程，新建 session 生效；注意 pi 模式的扩展目录不在桌面六源默认扫描面，r2 主审 F1）；goal 侧 dev 形态走 resolver 源码分流（`extensions/` 源码目录，dev 不产 bundle，extension-resolver 源码分流逻辑——**实施期不可用「扩展安装通道」**：它只能装 npm 已发布旧版 plan，不含 slot 改造）；然后 dev 真机对话流内 AI 走 plan complete → select 对话框（GUI 通道） | goal 档出现；选中后 goal widget 出现且状态正确——混载形态（resolver 源码分流的 goal + dev-link 注入的 plan 同进程）下 slot 共享的验证（P-5 dev 门）；**packaged bundle 形态**（goal esbuild bundle + npm dist plan）的 slot 共享为推理登记（esbuild 无 VM 沙箱、Symbol.for 是 JS 引擎级注册表跨模块系统共享），发布后随下一版本 prerelease 冒烟补验 goal 档出现 |
| **V5 npm 安装形态** | G1（独立安装） | `npm pack` 两包 → 干净目录独立 pi 安装两 tarball → 跑 V1 同款流程 | 与 V1 同标准（排除「本地源码 --extension 才可用」的形态偏差） |
| **V6 回归三连 + 符号清扫** | G3（零回归） | `pnpm extensions:typecheck && extensions:lint && extensions:test`；plan+goal 既有用例全量；符号清扫（r1 影响面审 MF）：`grep -rn "__goalInit"` 限定 `extensions/{universal/{plan,goal}}/` 的 src + `__tests__` + `docs/{design,extensions}/` + `extension-dependencies.json` + `docs/adr/`——存活引用应全部属于：新通道表述、历史登记（ext-simplify-06 设计的变更历史/审查记录类条目、pi-ext-020 加注后的死通道登记）或明确标注保留的注释；豁免面（不要求清零）：CHANGELOG*、`.xyz-harness/`、`.tmp/`、staged 产物 | 全绿；豁免面外无「旧通道当现状」的存活表述——`check-doc-symbol-drift.mjs` 的候选集模式（蛇形大写 + get 前缀驼峰）对 `__goalInit` 不可见（r1 影响面审 MF 核实），机器守卫靠不住，本条 grep 是清扫的验收门 |

**负面行为验收边界**：no-steps / plan-unreadable 出口已有 06 设计 §7 V2 构造法与单测覆盖，本设计不改变其逻辑（读取与提取代码零变更），不重复开真机场景；internal-error 出口以单测（mock slot 挂抛错 fn）覆盖，不为「goal 加载失败后残留 fn」单独构造真机场景（需人为制造扩展加载失败，成本大于收益——catch 出口逻辑既有且 06 已验）；「独立安装跨包版本漂移签名错配」不单开场景（构造需人为混装不配套版本，错配失败形态分落 init-refused（不经 catch）与 internal-error（经 catch）两既有出口、单测覆盖等价，成功形态由编译期/semver 源头机制管理而非桥层——见 §3.1 尾段断言校准）。

### 4.3 探针清单（设计期已核实 / 实施期门）

| ID | 验证的行为 | 探针 | 状态 | 失败时降级路径 |
|----|-----------|------|------|---------------|
| P-1 | pi 0.84.4 per-extension API 对象隔离（挂载字段跨扩展不可见） | 双扩展最小实验（扩展 A 挂 `pi.xx_probe_field=42`，扩展 B 读 typeof → `"undefined"`）：probe-06 首测 + 本设计起草期独立重跑双确认 | ✅ 已测（2026-09-14 两次） | —（断裂事实成立，设计前提不可动摇） |
| P-2 | loader 为每扩展独立 createExtensionAPI + factory 各拿各的 api | 读 loader.js:459-472（initializeExtension：createExtension + createExtensionAPI + factory(load.api)）与 :499-509（循环逐扩展） | ✅ 设计期 | — |
| P-3 | pi 0.84.4 ExtensionAPI 无官方跨扩展通道 | types.d.ts 动作面 :906-1155 全量（无 listExtensions/registry/定向 emit）；bridge-rewrite-pi-0.84.md §2.1 断点②同口径交叉核实 | ✅ 设计期 | — |
| P-4 | `Symbol.for` + globalThis 跨模块实例共享（slot 机制有效性） | 仓内生产先例已验证：ask-user↔subagent-core 握手在跑（M4 修复后）；development-guide §7.5 机制论述 | ✅ 先例 | — |
| P-5 | slot 在 xyz-agent 桌面 dev 混载形态下共享（resolver 源码分流的 goal 与 dev-link xyz 模式注入的 plan 同进程读同一 globalThis symbol——dev 实际形态，r2 主审 F1） | V4 GUI 真机 | ⛔ 实施期门（V4） | 失败 → 排查注入链（XYZ_EXTENSION_PATHS 是否进 pi 子进程 env、session 是否新建）而非方案——同进程 globalThis 共享是 JS 语义，dev 形态无 bundle 变量；若确认形态学隔离，回到 §3.2 对比（候选 C 升级），风险分重评。**packaged bundle 形态**（esbuild bundle goal + npm dist plan）不在 dev 可构造（dev 恒源码分流、packaged 无 plan），共享性登记为推理结论：esbuild 不做 VM 沙箱 + Symbol.for 是 JS 引擎级注册表跨模块系统共享 + 仓内 subagent-core↔extensions 的 slot 先例已在 bundle 形态生产运行——发布后 prerelease 冒烟补验（V4 尾注） |
| P-6 | plan/goal 加载顺序无关性（plan 先加载时使用点读 slot 仍正确） | V1 环境对调两 `--extension` 参数顺序重跑 | ⛔ 实施期门（随 V1） | 失败 → 说明存在隐藏的加载时缓存（实现违反 D3），修实现而非方案 |

---

## 5. 下一层拆分（impl-plan 输入）

**本章结论**：拆 4 个单元（u1 goal 暴露 / u2 plan 探测 / u3 文档回写 / u4 真机验收），u1+u2 同批合入无顺序依赖，全部异常路径已由既有 D2 出口承接故无迁移阶段；两个实施期门（P-5/P-6）各带降级路径。

| 单元 | 内容 | justification | 验收 |
|------|------|--------------|------|
| u1 goal 侧 slot 挂载 | index.ts 内联改造：key 常量（紧邻 `GoalInitFn` 导出）+ factory 挂载语句换 `Reflect.set(globalThis, KEY, fn)` + docstring 消费示例更新（`pi.__goalInit` → slot 读取）+ goal 侧单测（slot 挂载后可读、teardown 清理） | 暴露方先行；纯增量不破坏现状（旧 `api.__goalInit` 挂载语句同批删除，无并存窗口） | goal 包单测绿 + typecheck |
| u2 plan 侧探测改造 | `getGoalInit`/`detectGoalCapability`/`tryGoalInit` 去 pi 参数换 slot 读取（typeof 守卫同构）+ tool.ts 调用点 + compact.ts goal-unavailable 注释语义更新（「正常交互下不可达」反转为真实防御分支）+ 既有测试 mock 形态全部对齐 slot（本地 `Reflect.set` + teardown 清理，两侧同规） | 消费方单点改造；与 u1 同批合入（中间态桥仍断但无行为恶化，两侧无顺序依赖） | plan 包单测绿（含 slot mock 世界）+ 三连 |
| u3 文档与符号清扫（r1 影响面审 MF 全清单） | 06 设计桥表述（`pi.__goalInit` 挂载/鸭子探测/getGoalInit 断言点共 5 处）与 03 设计（:18「跨扩展 API」/:226「签名不变」）回写为 slot 通道；goal 侧清扫：`src/service.ts:9/:124` 注释、`README.md:48`、`index.ts` docstring、`index.ts:119` 注释（coding-workflow 历史消费方表述）；仓根 `extension-dependencies.json:90` reason 字段（`__goalInit` → goal 桥 slot 表述）；`docs/extensions/adr/pi-ext-020-coding-workflow-depends-on-workflow.md` 加注（D6-②：`pi.__workflowRun` 通道恒不可达 + 其 Decision 节「与 `pi.__goalInit` 同模式」表述过时回写）；ext-simplify-index.md 登记；changeset（两包 patch）。**守卫盲区登记**：`check-doc-symbol-drift.mjs` 候选集（蛇形大写 + get 前缀驼峰）不覆盖 `__goalInit` 模式——本次清扫以 V6 的显式 grep 为验收门，不改守卫脚本（单一符号的一次性清扫，不值得扩守卫面；若未来再出现 `__xx` 型跨扩展符号批量迁移，再议守卫扩展） | C-proc-10 同批纪律：符号语义变更与文档同步；桥断裂登记债务本设计清账 | `node scripts/check-doc-symbol-drift.mjs` 过 + V6 grep 门 |
| u4 真机验收 | §4.2 V1-V6 逐项（含 P-5/P-6 两个实施期门） | 行为修复必须真机闭环（本缺陷的直接教训就是 mock 验不出） | 全 pass + 证据留档 `.tmp/dev-flow/` |

文件改动地图：`extensions/universal/goal/src/index.ts`（slot 挂载 + key 常量 + docstring/注释）、`extensions/universal/goal/src/service.ts`（:9/:124 注释）、`extensions/universal/goal/README.md`（:48）、`extensions/universal/goal/src/__tests__/`（slot 单测 + 既有桥用例 mock 形态）、`extensions/universal/plan/src/compact.ts`（getGoalInit/detectGoalCapability/tryGoalInit + key 常量本地声明 + 注释）、`extensions/universal/plan/src/tool.ts`（调用点签名）、`extensions/universal/plan/src/__tests__/`（mock 形态对齐）、`extension-dependencies.json`（:90 reason 字段）、`docs/design/ext-simplify-06-plan.md`、`docs/design/ext-simplify-03-goal.md`、`docs/design/ext-simplify-index.md`、`docs/extensions/adr/pi-ext-020-coding-workflow-depends-on-workflow.md`（workflowRun 死刑加注 + 同模式表述回写，D6-②）、changeset ×2。

**待验证检查点**：P-5（dev 混载形态 slot 共享；packaged bundle 形态为推理登记 + 发布后 prerelease 冒烟）、P-6（加载顺序免疫）——均已配降级路径（§4.3）。

---

## 变更历史

- v1（2026-09-14）：初稿。Step 0 根因三重实证（loader 源码 P-2 / 运行时重跑 P-1 / pi types 全量 P-3）；方案对比四候选（A slot / B 等上游 / C runtime 接线 / D 运行时 import），推荐 A——C-ext-06 惯例形态 + 仓内现役 slot 形态学使新颖度归零；D1-D6 决策落盘；验收 V1-V6 继承 handoff §6 并按双形态 + 负载顺序门补全。
- v2.3（2026-09-14）：**R3 收尾**（三审均 0 must-fix，设计就绪；R3 轮 5 小项全修）。主审 S1：V4 前置补 `set -a && source .env.dev-extensions && set +a` 注入环节（link-local.sh 只写文件不加载，脚本自述用法核实）；主审 S2/影响面 SG2（同一处）：D2 被否③「错配调用落既有出口」补「失败形态」限定（v2.2 收敛四处漏掉的第五处）；主审 S3：§5 待验证检查点 P-5 旧标签改「dev 混载形态 + bundle 推理登记」对齐 §4.3；影响面 SG1：V6 门「历史登记」括号纳入 pi-ext-020 死通道登记；影响面 INFO：D6-② workflowRun 挂载行号精确到 index.ts:556 实际挂载点。
- v2.2（2026-09-14）：**主审 R2 修复**（1 MF + 1 SG 全修）。①V4/P-5 验收前提链纠偏（主审 R2-F1）：dev 下 builtin goal 走 resolver 源码分流非 esbuild bundle（extension-resolver dev 分支核实）；「pi 模式扩展目录」不在桌面六源扫描面，V4 前置收敛为 dev-link **xyz 模式**（`link-local.sh plan` → `XYZ_EXTENSION_PATHS` → 新建 session 生效）；「扩展安装通道」实施期不可用（只能装无 slot 改造的 npm 旧版）；P-5 验证点改 dev 实际形态，packaged bundle 形态降级为推理登记（esbuild 无 VM 沙箱 + Symbol.for 引擎级注册表 + bundle 内联 subagent-core↔ask-user 握手现役生产先例，bundle-external 边界核实 subagent-core 非 external 即被内联）+ 发布后 prerelease 冒烟补验。②错配断言收敛（主审 R2-S1）：「错配落 init-refused 或 internal-error」全称断言被证伪（尾部加参错配良性成功、位重排错配静默畸形成功不落出口、「同一 catch 链」结构描述错误）——§3.1 尾段/§3.2 A 行/场景 B 表/负面边界段四处统一收敛为「失败形态落既有出口（init-refused 不经 catch / internal-error 经 catch），成功形态由 type SSOT + semver major 源头拦，不在桥层兜底」。
- v2.1（2026-09-14）：**R2 复审修复**（主审 0/0 进行中 · 影响面审 2 MF 全修 · 简洁审 PASS 0/0+1 INFO）。①加注对象纠错（影响面审 R2-MF1）：死刑加注从 `docs/adr/0020-core-user-flows.md`（同名编号无关 ADR，全文零 workflowRun ✅核实）改到真背书者 `docs/extensions/adr/pi-ext-020-coding-workflow-depends-on-workflow.md`（Decision 节「与 `pi.__goalInit` 同模式」表述同步回写，D6-②/u3/文件地图/证据行四处联动）；②§3 章结论残留修正（影响面审 R2-MF2）：「挂带版本的握手对象」v1 表述漏改 → 「直挂函数 + typeof 守卫」；③V4/P-5「npm dist」措辞与 dev-link 前置对齐（简洁审 R2 INFO）：改「非 builtin 来源（dev-link 源码或安装通道产物）」，npm dist 纯净形态归 V5。
- v2（2026-09-14）：**R1 三审修复**（主审 1MF+2SG / 影响面审 1MF+2SG / 简洁审 1MF+2SG，全修 + 3 INFO）。**方案性**：①D2 推翻——version 握手对象记入被否谱系（简洁审 F1：ask-user 先例三前提不匹配 + 仓内单向/单例 slot 十余处裸挂 + 三层既有机制承接签名错配 + v1 的 G3「版本协议不匹配」系发明 version 后的循环论证），slot 回归裸函数直挂，G3 改单义「未装」；联动删 bridge.ts（内联 index.ts，简洁审 F2）、删「goal 侧测试辅助导出」备选（F3）、V2 version:99 子场景、u1 version 用例、主审 S2（version 分支 debug 日志）随之消失。**事实纠错**：②桌面形态口径（主审 MF）：plan 不在 mandatory-extensions.json（18 项仅含 goal ✅核实），builtin 双包表述全部改为「goal builtin + plan 用户安装混载同进程」，V4 补安装前置（dev-link / 扩展安装通道），P-5 形态描述同步。**规格完整性**：③符号清扫清单补全（影响面审 MF）：service.ts/README/extension-dependencies.json:90/06 设计 5 处/ADR-020，V6 改显式 grep 门（含豁免面），登记 check-doc-symbol-drift 候选集对 `__goalInit` 不可见的守卫盲区；④D6 扩为双登记（影响面审 S1）：`pi.__workflowRun` 同型死通道给 ADR-020 加注；⑤teardown 清 slot 两侧通用（影响面审 S2）。**INFO**：goal 档排序第 2 非第 5（tool.ts EXEC_MODE_OPTIONS 核实）；「4 个现役 slot」改十余处；C-ext-06 表述从「进程级单例」精确为「进程级共享」。
