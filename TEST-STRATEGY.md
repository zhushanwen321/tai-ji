# 测试策略（TEST-STRATEGY）

> 测试体系 SSOT。AGENTS.md「测试规范」章节是规则载体，本文件补充分层策略 + 回归基线 + mock 策略 + 运行手册。两者互补不冲突。
>
> **回归排序按功能分级**：P0 每版全量、P1 每版核心用例、P2 抽样/变更触发、P3 变更触发——分级表见 [docs/feature-priorities.md](docs/feature-priorities.md)（P0-P3 SSOT）。
>
> **各功能具体测试步骤**（MOCK/非MOCK/Playwright 调用链 + 每步期望输入输出）见 [docs/testing/](docs/testing/) 测试手册：
> - [00-test-strategy-overview.md](docs/testing/00-test-strategy-overview.md) — 双轨制 + Playwright harness + 公共前置（入口篇，必读）
> - [01-new-task.md](docs/testing/01-new-task.md) — 新建任务（Landing + 选目录 + 首发提交）
> - [02-composer.md](docs/testing/02-composer.md) — Composer（输入框 + slash 命令浮层 + 三态）
> - [03-chat-flow.md](docs/testing/03-chat-flow.md) — 对话流（流式消息 + 工具调用 + 变更集）
> - [04-file-tree.md](docs/testing/04-file-tree.md) — 文件树（懒加载 + 过滤 + git 角标，11 E2E 用例已落地）
> - [05-side-drawer.md](docs/testing/05-side-drawer.md) — SideDrawer（文件预览 / diff / git tab）
> - [06-search-modal.md](docs/testing/06-search-modal.md) — 搜索浮层（⌘K 四类搜索 + recents + 跳转，7 E2E 用例已落地）
> - [11-real-e2e-specs.md](docs/testing/11-real-e2e-specs.md) — real 轨 E2E 自动化 spec（真 Electron + runtime + pi + LLM，零 mock）
> - [12-extension-runtime-testing.md](docs/testing/12-extension-runtime-testing.md) — extension 层运行时测试体系（worker harness L1 → real LLM L3，价值层级 + 决策树）

## 1. 测试框架 [HISTORICAL]

- **vitest，禁止 `node:test`**：runtime/renderer 子项目用 vitest。所有测试从 `vitest` 导入 describe/it/expect/vi/beforeEach，禁止从 `node:test` 导入。vitest 不识别 node:test 格式，会导致 "No test suite found"
- **不要用 `tsx --test`**：它能跑但不支持 vi mock（`vi.fn()`/`vi.useFakeTimers()`）和 vitest.config.ts。项目 CI/dev 流程都用 vitest
- **测试超时**：单测默认 5s。涉及 setTimeout/timer 的测试用 `vi.useFakeTimers()` + `vi.advanceTimersByTime()`，禁止真实等待
- **subagent task prompt 必须写明测试框架**：「测试框架使用 vitest（从 vitest 导入 describe/it/expect/vi），运行命令 npx vitest run，禁止 node:test 和 tsx --test」

## 2. 测试分层

| 层 | 环境 | 目的 | 运行命令 |
|----|------|------|---------|
| 单元测试 | renderer（happy-dom）/ core（node）/ runtime | 纯逻辑、纯函数、单模块、状态机 | 见下 |
| 集成测试 | renderer（mount 组件树，`@vue/test-utils`）/ ui（happy-dom，features/chat 等组件 mount 测试） | 组件协作、store 联动、WS 事件流 | 见下 |
| E2E（mock 轨）| Playwright `_electron` + VITE_MOCK | 全链路用户旅程（renderer 渲染 + 交互逻辑），OS 原生 dialog 标 `[需手工]` | `npx playwright test` |
| **dev 冒烟**（闸门）| chromium + vite dev server | 模块加载健康（拦 node:path externalize / CSS 变量引用错 / Tailwind 类名错 / Vue template compile 错，mock 轨盲区）| `node scripts/dev-smoke.mjs`（或 `pnpm dev:smoke`）|

> **[HISTORICAL] E2E 从手动升级为 Playwright**：原「E2E 手动，无 playwright/cypress」（2026-06-28 sidebar-project-file-tree W0 引入 Playwright 覆盖）。mock 轨验证渲染/交互，但**验证不了模块加载期副作用**——`node:path` 类错误在 vite build 期被 externalize 成惰性代理，mock 模式不触发 getter，E2E 全绿却 dev 崩溃（2026-06-30 事故）。**必须配套 dev 冒烟闸门**。详见 `.xyz-harness/2026-06-30-e2e-retrospect/`。`[from: 2026-06-28-sidebar-project-file-tree §2/W8]`
>
> **dev 冒烟闸门（已实现，S1-W1 交付）**：`scripts/dev-smoke.mjs` 自管理完整生命周期（VITE_MOCK=true spawn vite → 轮询 ready → chromium 连接 → 双通道抓错误 → 断言挂载点 → cleanup），不依赖外部已启动的 dev server。双通道错误捕获：(A) vite 子进程输出正则匹配编译期错误（Module not found / Pre-transform error / Failed to resolve import 等）；(B) `page.on('console')` error + `page.on('pageerror')` 未捕获异常。**exit code 语义**：`0`=ok（零 error + 挂载点全存在）/ `1`=有 error（console/pageerror/编译 pattern 非空 或 挂载点缺失）/ `2`=dev server 启动超时 / `3`=chromium launch 失败。完整用法与错误注入指南见 `scripts/dev-smoke.mjs` 文件头注释。`[from: v6-ui-refactor-test-infra S1-W1 dev-smoke-gate]`

### 运行命令（cwd 敏感）

> ⚠️ `@` alias 只在 `renderer/vitest.config.ts` 配置，**必须从 renderer 目录运行**。bash 工具 cwd 不跨调用持久，每条命令固定以 `cd packages/renderer &&` 开头。

```bash
# renderer 全量
cd packages/renderer && npx vitest run

# renderer 单文件
cd packages/renderer && npx vitest run src/__tests__/panel/composer-slash-trigger.test.ts

# runtime（有独立 vitest.config.ts）
cd packages/runtime && npx vitest run

# core（chat/composer/session 等 domain 纯逻辑单测，独立 vitest，node 环境，120 测试文件 2026-09-12 实测）
cd packages/core && npx vitest run

# ui（features/chat 等跨端组件 mount 测试，独立 vitest，happy-dom，58 测试文件 2026-09-12 实测）
cd packages/ui && npx vitest run

# typecheck（vue-tsc 在 apps/electron/node_modules）
pnpm --filter @xyz-agent/frontend run typecheck
cd packages/runtime && npx tsc --noEmit

# pi-scheduler 真实环境端到端实测（spawn 真实 pi + LLM，设计契约见脚本头部）
node scripts/verify-scheduler-e2e.cjs
```

## 3. 三视角模型 + 渲染 gate DoD [HISTORICAL — 2026-06-27「新建任务」事故]

> **事故**：「新建任务」77 单测 + 24 集成全绿、tsc EXIT 0、verdict pass，用户手动打开却发现 Landing 态根本没有 composer 输入区——阻塞级 bug。根因：测试只做了构建者（白盒）视角，缺使用者/观察者两个视角。

| 视角 | 内涵 | 防护 |
|------|------|------|
| 构建者（白盒） | 状态机/API 契约/内部状态断言 | 已有 |
| **使用者（黑盒）** | 用户能否完成目标（DOM 可见断言） | **[MANDATORY] 补齐** |
| **观察者（形态）** | 渲染长什么样（首屏冒烟） | **[MANDATORY] 补齐** |

**四条 MANDATORY 规则**（详见 CLAUDE.md 测试规范#5-#8）：

1. 每条集成/E2E 用例至少一个用户可见断言（`wrapper.find().exists()`/`.text()`/`.html()`）。纯内部断言（`state.value`、`toHaveBeenCalled`）不计 DoD
2. 集成/E2E 必须mount test-strategy 指定的组件树入口（如 `Panel`），禁止悄悄换更小被测对象。入口无法 mount 时显式说明并降级入口
3. E2E 用户旅程步骤不可降级，每步必须有 DOM 断言。无法自动化的步标 `[需手工]` + 占位断言，**不得删除步骤**
4. **渲染 gate DoD**：mount 功能顶层容器，断言 spec 结构章节列出的每个「结构元素」对应 DOM 节点存在。**spec 结构条目 = 渲染断言清单**

**首屏冒烟模板**（每功能必含 1 条）——观察者视角的操作化定义：mount 功能顶层容器，断言该页面 spec 结构章节列出的「关键交互元素」对应 `[data-testid]` 节点存在于 DOM：

```typescript
// 通用模板：把 <KEY_TESTIDS> 换成该页面的关键交互元素 testid 清单
it('首屏渲染：<页面> DOM 含关键交互元素', () => {
  const wrapper = mount(<顶层容器>, { props: { /* 必要 props */ } })
  for (const testid of <KEY_TESTIDS>) {
    expect(wrapper.find(`[data-testid="${testid}"]`).exists()).toBe(true)
  }
})
```

**核心页面首屏冒烟 testid 清单**（新功能按所属页面补齐对应 testid 断言）：

| 页面/区域 | 顶层容器 | 关键交互 testid（至少断言这些存在）|
|-----------|---------|----------------------------------|
| Landing 态（无 session）| `Panel`（`sessionId:null`）| `composer-box` / `chip-directory` |
| 激活 session 后 | `Panel`（激活态）| `composer-box` / `turn-*` |
| 侧边栏 | `Sidebar` / `SessionItem` | `session-list` / `session-item` / `session-agent-badge`（agent-spawned AI 标记）/ `session-view-parent-item`（查看父 session 菜单项） |
| 文件树 | `FileTree` | `file-tree` / `tree-node` |
| 搜索浮层 | `SearchModal` | `search-modal` / `search-input` |
| Composer slash 浮层 | `Composer` | `composer-box` |
| Settings · 用量 | `UsagePage` | `usage-ledger` / `usage-metric-toggle` / `usage-range-toggle` / `usage-empty-state` / `usage-error-state` |

> 注：`composer-input` 是 CSS class（`ComposerInput.vue`）非 testid，composer 断言用 `composer-box`；`message-list` testid 不存在（对话流容器锚点用 `turn-*`）。
>
> spec 结构条目 = 渲染断言清单（规则#4）。每功能集成/E2E 必含 1 条首屏冒烟，覆盖该页面的关键 testid，防止「测试全绿但功能不可用」。
>
> 三视角缺一不可。任一缺失即重蹈「测试全绿但功能不可用」。

## 视觉回归测试（v6 重构期三层互补方案）

> v6 UI 重构的核心质量保障。三层覆盖不同失效模式，互补非替代。S2（visual-regression-baseline slice）交付。`[from: v6-ui-refactor-test-infra S2-W1/W2/W3]`

### A 层：token 落地断言（契约级，CI 内）

- **双轨互补**：(1) **vitest 契约轨** `packages/renderer/src/__tests__/v6-visual/tokens.test.ts`（happy-dom 注入等价 CSS，断言 class→`var()` 消费）；(2) **chromium 真实轨** `scripts/token-consume-check.mjs`（spawn vite 加载真实 JIT CSS，端到端验证 computed style）
- vitest 轻量快（CI 内跑），chromium 保真（本地/定期跑）。tailwind.config 改映射时 vitest 契约轨不跟随（注入等价 CSS），chromium 轨跟随——两者覆盖不同失效模式
- **方法论 [from S2-W1]**：涉及 CSS 断言时**先探测 happy-dom 实际能力再选轨**。happy-dom 的 CSS 能力比业界传言强（能解析注入 `<style>` 的 class→`var()` 消费），不盲信「happy-dom 不支持」——探测驱动决策（探测用例推翻预设）避免浪费可行路径

### B 层：minimax-m3 VLM 语义对齐（半自动，非 CI gate）

- **机制**：`scripts/visual-capture.mjs` 截目标页面 PNG → 主 agent 用 `subagent` 工具派发 `minimax-token-plan-router/minimax-m3` VLM，对照 `docs/page-design/v6-master-spec.md` 文字描述逐区域检查 → 返回结构化 JSON（regions/verdict/meta）
- **派发模板 SSOT**：[docs/testing/visual/vlm-prompt-template.md](docs/testing/visual/vlm-prompt-template.md) ——minimax-m3 VLM 视觉验证标准化派发模板（三段式 task：背景/目标/验收标准 + 内嵌 JSON schema + 自检检查点。VLM 一次返回合规 JSON 无需人工修正）
- **定位**：半自动形态，重构期 agent/人触发的验收工具链。失败不阻塞，降级人工肉眼对照。**非 CI gate**（成本 + 非确定性）。建的是机制+模板+首例，非可执行断言

### C 层：Playwright 像素 diff（CI 内，形态级）

- **机制**：`playwright.config.ts` 的 `visual-chromium` project（testMatch `visual/**`）+ `e2e/visual/` spec + `e2e/visual-baselines/` baseline 快照（**git tracked**，CI/他人 clone 后无 baseline 则 diff 无意义）
- **双 project 隔离**：electron 行为轨（testIgnore `visual/**`）/ visual-chromium 像素轨（testMatch `visual/**`）互斥，`npx playwright test e2e/visual` 自动只跑像素轨
- **阈值**：`maxDiffPixelRatio: 0.01`（容忍字体抗锯齿/caret 闪烁 flaky，抓真回归）+ `caret:'hide'`
- **方法论 [from S2-W3]**：(1) `snapshotDir`/`snapshotPathTemplate` 是 TestProject **直接属性**（与 name/testMatch 同级），不是 `use` 属性——放 project.use 里静默不生效；(2) `toHaveScreenshot(name)` 的 name 必须带 `.png` 扩展名；(3) baseline 必须 git tracked

> **三层选用**：CI 内跑 A（vitest 契约）+ C（像素 diff）；B（VLM）重构期手动触发做语义对齐验收。A 抓 token 未落地（颜色/间距错乱），B 抓语义不符（如选中态二分规则 D8），C 抓可见像素级回归。基线条目见下方回归基线表。

## 4. 回归基线用例（破坏即事故）

| 基线 | 描述 | 来源事故 | 守护测试 |
|------|------|---------|---------|
| **slash 命令契约** | 输入 `/` → 浮层弹出 → 选中 → chip 插入；session.commands 时序竞争修复 | `2026-06-28-lite-slash-command-fix`（broadcast 早于订阅丢失） | `src/__tests__/useSidebar-get-commands.test.ts`（U1-U3）+ `landing-precreate-session.test.ts`（U4/U5）+ `composer-slash-trigger.test.ts`（U1-U10） |
| **Session 隔离** | 三层隔离（store 分区/useChat 路由/PaneSessionView 过滤）+ 无 sessionId 消息丢弃 + sendError 带 sessionId | CLAUDE.md 规则#7 | 各 domain/store 单测 |
| **渲染 gate** | mount 顶层容器断言结构元素 DOM 存在（防「测试全绿功能不可用」） | 2026-06-27 事故 | 每功能首屏冒烟用例 |
| **错误状态重置** | 错误路径必须收口生成状态（否则 UI 卡死）：现行单一入口 = finalizeSession + clearPendingSend / markSessionError（`streamingMessage` 实体已消亡；UI 活跃态 SSOT = isActive = pendingSend ∨ isGenerating，derive-status.ts W1） | CLAUDE.md 规则#3 | useChat 错误路径测试 |
| **emit 单 payload** | emit 不传多参数 | CLAUDE.md 规则#1 | - |
| **runtime broadcast 时序** | session 级 broadcast 早于 renderer 订阅会丢消息；切换/创建 session 后需立即消费的状态必须主动拉取（`session.getCommands` RPC） | `2026-06-28-lite-slash-command-fix` | U1-U3 + U4/U5（见上） |
| **搜索查询乱序守卫** | useSearch.query 内 loadSeq 自增序列号，await 后 `seq !== loadSeq` 丢弃旧响应；快速连续查询时旧响应晚到不得覆盖新结果（数据错乱=事故） | NFR S-8 `[from: 2026-06-30-search-modal §execution T1.12]` | `packages/core/src/domain/new-task-search/__tests__/search.test.ts`（TC-2 loadSeq 乱序守卫，原 T1.12）+ `packages/core/src/domain/new-task-search/__tests__/file-match.test.ts`（TC-9c~9k file 匹配分级，原 T3.10）|
| **搜索 slash 命令注入链路** | SearchModal 点击 slash 命令 → commandStore.pendingSlash 一次性通道 → Composer watch 消费 → insertSlashChip 注入 chip。watch 非 immediate（防残留误注入）+ sessionId 过滤（split 不串台）+ 先注入后清除（防读到 null）。commandKind 区分 slash/app（pi 命令名无 / 前缀，不可靠 title 猜测） | `2026-07-01-search-slash-injection`（injectSlash 回调断链 + commandKind 误判） `[from: 2026-07-01-search-slash-injection §plan]` | `src/__tests__/panel/composer-slash-injection.test.ts`（U12-U16,U18，仍在 renderer）+ `packages/core/src/domain/new-task-search/__tests__/search-jump.test.ts`（TC-8 commandKind 分发 / pendingSlash 注入，原 U7-U11）+ `packages/core/src/domain/new-task-search/__tests__/command-store.test.ts`（TC-5 pendingSlash 一次性通道，原 U1-U4）|
| **切模型后思考等级自动重置** | A 模型(high-max, level=xhigh) 切到 B 模型(on-off: off/high)，xhigh 不在 on-off 可用档 → 自动重置为 high。landing 态(localThinkingLevel=undefined) 切模型 → immediate watch 设最高可用档。on-off 模式 popover 显示「关」「开」而非「关」「高」。破坏=用户看到错误的思考等级/不可用档位被选中 | NFR S-9/S-10/S-11；`[from: 2026-07-02-thinking-level-and-model-select §execution]` | `src/__tests__/panel/thinking-levels.test.ts`（19 用例：resolveAvailableLevels key-based）（原 src/__tests__/composables/use-thinking-level-sync.test.ts 已随 sync 逻辑迁 core（`packages/core/src/domain/composer/thinking-level-sync.ts`）删除，等价基线待 core 侧重建）|
| **store 必须走 @/api 门面（mock 数据流不断裂）** | 所有 renderer store 访问外部域必须 `import { xxx } from '@/api'`（门面），禁止直接 `import from '@/api/domains/xxx'`。绕门面→ mock 模式下走 real domain transport，而 mock-ws 只处理 ping→pong 不回业务 reply → Promise 永挂 → records 恒空。破坏=E2E mock 轨数据全空，UI 测试假绿（空态本就期望空）。对比：useSidebar 走门面所以 mock 生效 | `2026-07-03-recent-workspaces`（workspaceStore 绕门面致 mockApi.workspace 死代码）`[from: 2026-07-03-recent-workspaces §execution]` | `e2e/workspace.spec.ts` T4.1（records 非 0 断言）+ `workspace-store.test.ts` vi.mock('@/api') |
| **real E2E fixture（real runtime + pi spawn，create session 无 LLM 依赖）** | real 模式 E2E 不设 XYZ_MOCK（启动 runtime）+ real renderer bundle（VITE_MOCK=false build）。create session（session-lifecycle.create）的 record 是 create 同步收尾，**不调用 LLM**（LLM 调用在 sendPrompt）。real E2E 需预设 pi provider 配置（$dataDir/pi/agent/models.json + settings.json），dialog 走 WS 直连触发等效业务动作。mock/real E2E 分批 build（VITE_MOCK 构建期 define，bundle 输出冲突） | `2026-07-03-recent-workspaces`（T4.6 跨进程持久化 real E2E）`[from: 2026-07-03-recent-workspaces §execution T4.6]` | `e2e/workspace-real.spec.ts` + `e2e/fixtures/launch-app-real.ts` |
| **v6 token 落地断言（A 层）** | design-tokens 原子值在组件层正确消费（class→`var()`），双轨验证：vitest 契约（注入等价 CSS 断言消费）+ chromium 真实（加载 JIT CSS 验 computed style）。破坏=token 未落地致颜色/间距/圆角错乱 | `v6-ui-refactor-test-infra S2-W1`（happy-dom `var()` 能力探测推翻预设）`[from: S2-W1]` | `packages/renderer/src/__tests__/v6-visual/tokens.test.ts` + `scripts/token-consume-check.mjs` |
| **v6 像素 diff baseline（C 层）** | `e2e/visual-baselines/` baseline 快照对照（**git tracked**），visual-chromium project + `maxDiffPixelRatio:0.01` + `caret:'hide'`。破坏=可见像素级回归（布局错位/元素消失） | `v6-ui-refactor-test-infra S2-W3`（snapshotDir 是 project 直接属性非 use）`[from: S2-W3]` | `e2e/visual/*.spec.ts` + `e2e/visual-baselines/` |
| **v6 选中态二分 D8（B 层 VLM）** | sidebar 选中项 bg-surface + 蓝字（D8 二分规则：列表项型），minimax-m3 VLM 对照 v6-master-spec 语义验证。破坏=选中态视觉不符 spec（选中项无背景/颜色错） | `v6-ui-refactor-test-infra S2-W2`（VLM 三段式 task 派发+schema 内嵌）`[from: S2-W2]` | `docs/testing/visual/vlm-prompt-template.md` + `.xyz-harness/visual/` |
| **插件系统非 mock 端到端** | 隔离 runtime（tsx 源码形态）+ 真实插件文件 + 真实 WS：sandbox 激活 / toggle 往返 / built-in statusline 发现 / onBeforeSendMessage hook 真实执行。破坏=插件真实加载路径回归（mock 层不可见的 F1-F4 类 bug） | `2026-08 插件系统 F1-F4`（测试金字塔底部全 mock、真实加载路径零覆盖） | `scripts/verify-plugin-e2e.sh`（挂 `validate-runtime-bundle.sh` 第 7 步，pre-commit 于 runtime src 变更触发）+ `packages/runtime/test/plugin-registry.test.ts` TC-1-09/10/11（built-in 扫描两形态）；手册 [docs/testing/13-plugin-e2e.md](docs/testing/13-plugin-e2e.md) |
| **流式 block 双轴尾部追踪 + 折叠头截短** | thinking 折叠预览/tool 折叠头在 streaming/running 中渲染尾部行窗口且 scrollLeft 钉右（`scrollLeft >= scrollWidth - clientWidth - 1`）、完成态回落静态摘要；折叠头路径 `…/末两段` 截短但展开态/copy 全量；preview 行高恒定（virtua 高度断言依赖）。破坏=流式预览死在开头/折叠头丢命令可见性/虚拟列表行高抖动 | `cw-2026-08-25-chat-visual-font-optimize`（实测发现：pi bash 部分输出无流式增量广播，tool 接入点按预案降级静态 argPath，thinking 链路钉尾 3/3）`[from: chat-visual-font-optimize (cw-2026-08-25) §D4]` | `packages/ui/src/features/chat/composables/__tests__/useTailScroll.test.ts`（9 用例：钉右/translateY/降级/未挂载）+ `packages/ui/src/features/chat/__tests__/Block.test.ts`（双态 DOM 断言）+ `format-utils.test.ts`（shortenForHeader/tailLines 规则） |
| **等价性测试双轨** | live ≡ reload / broadcast ≡ get_state / 混沌注入收敛等不变量断言。CI 只跑凭证无关子集（mock RPC / fixture 重放），真实 LLM turn 用例由凭证探测 skip；完整基线跑在开发机（详见下方「等价性测试双轨」小节） | `2026-08-19 data-source-governance P1-P4` goal-audit 问题 1（CI 无 pi 凭证，push 后 test-runtime 预期红） | `packages/runtime/src/__tests__/equivalence/` 13 文件（skip 机制 SSOT = `pi-fixture.ts` `REAL_PI_READY`） |
| **pi 语义守卫探针族** | 静态直读 pi dist 断言私有语义契约（pattern 引擎匹配规则 / reasoning 两级门控 / RPC 响应面 / steer drain 窗 / settled 复位序 / entry→context 映射），pi 升级语义漂移即红；配套 `check-pi-semantics.mjs` 版本门禁（四包一致 + verifiedWith 比对）与 `diff-probe-thinking.mjs` 档位对账。破坏=pi bump 后语义假设批量过期无人知（登记≠防御：8-20 登记观察项 8-27 照样出事的实证） | `2026-08-27 事故对`（subagent 派发 429/gc + 思考等级自动变关）`[from: pi-boundary-reliability U7]` | `packages/runtime/src/infra/pi/__tests__/pi-semantics-*.test.ts`（6 文件，凭证无关 CI 可跑）+ `scripts/check-pi-semantics.mjs`（pre-commit + CI）+ `scripts/diff-probe-thinking.mjs` |
| **sync-collect 探针手工复跑 SOP** | subagent sync 批崩溃恢复的真实 fs 时序回归探针（V2 含成功成员崩溃批 / V3 kill -9 全灭，需真实模型凭证，结构性不可进 CI）。**触发条件：升级 pi 或改动 manifest 写点/屏障逻辑（flushBatch 时序、appendBatchFinalizedEntry、finalizeOrphanRecord merge、E1 判定口径、settled 重扫）后必跑 v2/v3**，实跑记录回写 RESULTS.md。CI 回归防线 = subagent-core 真实文件通路集成测试；探针是时序面唯一防线 | `dev-0.9.15 对抗式审查 B4 裁决`（探针不在 CI）`[from: adversarial-review-fixes §3.3 B4]` | `scripts/probes/subagent-sync-collect/`（V2/V3 + RESULTS.md） |

### 等价性测试双轨（真实 LLM turn 基线跑在开发机）[from: 2026-08-19 data-source-governance]

等价性测试族（`packages/runtime/src/__tests__/equivalence/`，G3 长期回归基线）按「是否发起真实 LLM 调用」分两轨：

- **凭证无关子集（CI 覆盖）**：mock RPC 层 describe（`scalar-state-invalidation` / `usage-queue-commands-invalidation` 各自的「mock RPC 层」describe、`w10-usage-switchmodel-race` / `w12-owner-snapshot-publish` / `w18-record-entry-chaos` / `session-manager-e2e-fixture-unit`（探针基建纯单元：config 注册断言 + 行协议）整文件）——不 spawn pi、不发 LLM 请求，无条件执行。
- **完整基线（开发机跑）**：真实 pi 子进程 + 真实 LLM turn 用例（`live-reload` / `broadcast-getstate` / `chaos` / `pi-protocol-contract` / `session-manager-full-e2e`（agent-managed session 真 pi 全链路，REAL_PI_TESTS 分池）/ `thinking-level-effective-e2e`（pi 边界回执保险丝：reasoning:false 模型 set high → 断言回执=get_state=off，正常模型回执=请求值——「config ≡ pi effective」端到端守卫，REAL_PI_TESTS 分池）整文件，及 `scalar-state-invalidation` / `usage-queue-commands-invalidation` 的「真实 pi 子进程」describe）——依赖本机 pi 凭证（默认模型 `xiaomi-token-plan-cn/mimo-v2.5-pro`）。**凭证属用户基础设施，不由 CI secrets 虚构注入**。

**何时跑完整基线**：改动涉及 pi 协议链路（`event-adapter` / `message-converter` / `pi-protocol`）、entry reducer（core `apply-entry`）、replicated-states 失效收敛、或 equivalence 目录本身时，merge 前在开发机跑 `cd packages/runtime && pnpm test:equivalence` 全量。**pr-cr-fix 阶段 3a（pr-pre-merge.sh `test:runtime` 步骤）不设 `XYZ_SKIP_REAL_PI`，默认承担该义务**——「CI 不跑 real-pi、开发验收必跑」是显式分工策略而非环境巧合；凭证缺失导致的 skip 出现即验收不完整（见 pr-cr-fix SKILL.md 3a）。

**skip 机制（SSOT = `pi-fixture.ts`）**：模块顶层 `REAL_PI_READY`（binary `which pi` + 凭证三源探测：env `XIAOMI_TOKEN_PLAN_CN_API_KEY` / `<agentDir>/auth.json` stored 条目 / `models.json` providers apiKey，探测链对齐 pi AuthStorage 静态 source）。真实 LLM 用例一律 `describe.skipIf(!REAL_PI_READY)` 包裹；skip 理由注入 describe 名 + 模块加载时 console.warn（双通道显式可见，不静默消失）。

- CI（ci.yml test-runtime job）显式设 `XYZ_SKIP_REAL_PI=1`：把「CI 只跑凭证无关子集」从隐式事实（CI 恰好无 `~/.pi`）变为显式声明，skip 理由直接指向本节。
- 本机模拟无凭证验证 skip 语义：`XYZ_SKIP_REAL_PI=1 pnpm test:equivalence`（真实 LLM 用例 skip 且理由可见、mock 子集照跑）；去掉 env 即恢复全量。

## 5. mock 策略

- **唯一合法入口：`packages/core/src/transport/mock/` 层**（模拟 runtime WS 协议返回，经 `api/index.ts` 门面按 `VITE_MOCK` 切换接入——true 时直接 import `@xyz-agent/core/transport/mock`，不走 transport）。验证：`docs/standards.md §8.1`
- **禁止**：组件内联硬编码 mock（`const MOCK=[...]`）、panel/composables/lib 静态 fixture、组件直接 import `@xyz-agent/core/transport/mock`
- **测试 mock**：`vi.mock` api domain；复用 core mock 层的 events/fixtures（如 `run-send-stream.ts` 模拟流式 ServerMessage 序列、`mock-ws.ts` 模拟 WS 生命周期）
- **例外**：UI 固定枚举常量（如 thinking-levels 6 级）、`__tests__/` 测试 mock 不算违规
- **外部系统对接验证脚本**：独立 `verify-<system>.cjs`（放项目根或临时位置），先验证字段名/格式再编码,完成后移除

### vi.mock 注意事项

- **factory 不能引用外部变量**（hoisted）：用 `vi.hoisted()` 或在 factory 内 inline + `import { session as sessionMock } from '@/api'`
- **mock 整个 api 模块时记得 mock 所有被测路径用到的方法**（漏 mock 会 undefined 崩溃）
- **happy-dom 对 contenteditable/Selection/Range 支持有限**：测 contenteditable 组件用 textContent + querySelector + dispatch input event，不要依赖真实光标操作

## 6. pre-commit hook

提交前自动跑（`.githooks/`）：
1. **前端 ESLint 检查**（含 taste 规则：no-magic-spacing / no-silent-catch 等）
2. **vue-tsc 类型检查**
3. **代码规范检查**

taste/no-silent-catch 处理：纯 console.warn 仍报（要求传播/重抛）。项目惯例用 `// eslint-disable-next-line taste/no-silent-catch -- <理由>`（参考 runtime `fetchAndBroadcastCommands`、useSidebar/useNewTaskFlow 的 getCommands catch）。**改 catch 前先 `grep -rn "no-silent-catch"` 看现有写法**。

## 7. 覆盖率与 coverage gate

> S3-W1 交付 renderer coverage thresholds + CI 收集。`[from: v6-ui-refactor-test-infra S3-W1 coverage-thresholds]`
> **2026-08-20 重校准 [from: PR #185]**：该 PR 大量重构扩大全量分母，旧基线失效（全量实测跌破旧阈值，CI 必红），按同一方法论用新实测重新设阈。

**coverage gate（renderer，CI 内）**：`packages/renderer/vitest.config.ts` 的 `test.coverage` 块配 v8 provider + thresholds（任一指标 < 阈值则 vitest exit 非0，阻塞 CI）：

| 指标 | threshold | 基线实测（2026-08-20） | 余量（最紧标★）|
|------|-----------|---------|--------------|
| Lines | 68 | 70.57 | 2.57% |
| Statements | 66 | 68.38 | 2.38% ★ |
| Branches | 56 | 58.95 | 2.95% |
| Functions | 60 | 63.37 | 3.37% |

（旧基线 2026-06 S3-W1：thresholds 72/70/59/67，基线实测 Lines74.05/Stmts~74/Branch60.87/Funcs68.42——PR #185 重构扩大分母后作废）

- **方法论 [from S3-W1]**：**先测量后设阈**——thresholds 取基线 -2~3%（非卡死基线值），留 flake 缓冲同时保整体不退化底线。卡死基线 CI 偶发红，-2~3% 是平衡点。未来若 Statements/Lines 余量持续收窄（当前最紧），补测试提升覆盖率或评估调整 thresholds（保持基线-2~3% 原则并记录原因）
- **CI 收集**：`.github/workflows/ci.yml` test job 的 'Test - renderer' 步骤加 `--coverage` flag（与 `--reporter=junit --outputFile=test-results.xml` 共存，vitest 4.x 多 flag 无冲突），新增 'Upload coverage report' 步骤（upload-artifact `coverage-report`，`if:always()` 失败也上传便于排查 gate 红，path `packages/renderer/coverage/`）
- **产物**：`packages/renderer/coverage/`（index.html + lcov.info + lcov-report/），已被 `.gitignore` 覆盖
- 通用原则：增量核心逻辑应 100%；全文件覆盖率含大量 pre-existing 代码偏低，**以增量覆盖率为准**
- 运行：`cd packages/renderer && npx vitest run --coverage`

## E2E CI（mock 轨进 CI）

> S3-W2 交付。ci.yml e2e-visual job 跑 mock 轨 visual-chromium project。`[from: v6-ui-refactor-test-infra S2-W2 e2e-ci]`

**ci.yml e2e-visual job**：CI 内跑 mock 轨 visual-chromium project（`npx playwright test e2e/visual`），复用 lint job 成熟模式（checkout → pnpm/action-setup → setup-node → pnpm install，`fetch-depth:1`/node24/cache pnpm/`ELECTRON_SKIP_BINARY_DOWNLOAD:1` 全一致）。

- **build gate 联动**：e2e-visual job 加入 reusable workflow（`build.yml`）的 needs 数组，任一质量 gate job 失败则 build 不触发（阻塞 release）
- **artifact 隔离**：upload-artifact name 用 `test-results-visual`（与 test job 的 `test-results` 区分，GitHub Actions artifact name 必须唯一）
- **方法论 [from S3-W2]**：(1) **CI job 复用成熟模式优于创新**（一致性>品味，reviewer 一眼读懂 job 结构降低配置错误率）；(2) testMatch 隔离是双 project 共存关键（路径参数 + project testMatch 双重过滤自动只跑像素轨）；(3) CI 改动本地能验证 YAML 语法合法 + 配置字段正确 + 本地跑通复验，CI 环境特有行为（chromium 下载时长/字体渲染差异/并发额度）记录为 followup 待 push 后观察，不阻塞 wave 闭环

## 8. Extension Upgrade 回归基线 [from: extension-upgrade]

> 沉淀来源：extension-upgrade topic（2026-07-09 closeout）

### 关键时序约束

- **autoUpgradeOnStartup 必须在 `ensurePublicSession()` 之前执行**（`packages/runtime/src/index.ts`）：确保公共 session 及后续所有 session 加载到已升级的扩展版本。失败不阻塞启动（整体 try-catch + 每扩展独立 try-catch）。

### 错误码语义（不可混用）

| 场景 | code | 说明 |
|------|------|------|
| built-in 扩展调 upgrade | `not_user_installed` | 操作不被允许（非 user-installed） |
| 包不存在（不在 packages[]） | `not_installed` | settings.json 未注册 |
| npm install 后非有效 pi extension | `not_extension` | 安装成功但包结构无效，会触发 uninstallNpm 回滚 |
| npm install 网络失败 | `network` | extract/integrity 归类为 network |

### 回归基线用例

- `upgradeExtension` built-in → 拒绝（code=not_user_installed）
- `upgradeExtension` 不存在 → 拒绝（code=not_installed）
- `upgradeExtension` installNpm 后无效 → 回滚 + not_extension
- `uninstallExtension` → 必须调用 removeAutoUpgrade（与 removeDisabled 对称）
- `checkAndAutoUpgrade` → version='' 时 semver.valid=null 守卫，不调 semver.lt


## session-active-state-completion [from: session-active-state-completion]

E1-E4 三视角集成测试基线（`session-active-state.test.ts`）：
- 构建者：store.addPendingSend/setCompacting → isActive/isCompacting → deriveStatus 断言
- 使用者：mount SessionItem/Panel 断言 DOM（composer/landing testid）
- 观察者：dot class 含 animate-pulse-accent

## pi-boundary-reliability [from: pi-boundary-reliability]

pi 边界可靠性设计的测试面落地（2026-08-27 事故对 → 四支柱）：
- 回归基线新增「pi 语义守卫探针族」（§4 表末行）：`packages/runtime/src/infra/pi/__tests__/pi-semantics-*.test.ts` 仿 `pi-paths-config-dir-contract.test.ts` 范式——静态直读 pi dist 做行为契约断言，dist 不可达 skip 不 fail，凭证无关 CI 可跑；机器登记源 = `docs/pi-semantics.json`（PS-xx，probe/observe 分型）
- G5 real-pi 对账用例 `thinking-level-effective-e2e.test.ts` 归 REAL_PI_TESTS 分池（vitest.config.ts 已登记；漏加会落回 main 满并行组复发饿死超时）——回执保真的端到端保险丝，验证时改 pi 协议链路 / replicated_states 失效收敛时必跑
- 防橡皮图章分层：verifiedWith 是提醒机制，探针族（与取值无关地红）才是机器防线；P-S3 演练口径——篡改 verifiedWith 或反转探针断言 → check-pi-semantics / 探针测试必红，报错自带恢复动作

## 修复后验证纪律 [from: structured-output-redesign R3-R6 审计]

> 沉淀来源：structured-output 重设计实施后的四轮对抗式审计（R3-R6，commits `f69766b44`→`9438940c0`→`1dfd93b1a`→`3f934637c`）。R4 与 R5 各发现一次「上轮修复自身引入回归」且均非单测可抓——回归只在资源面暴露，结果面（error 文案）完全正确。语义总览见 [docs/design/structured-output-redesign.md](docs/design/structured-output-redesign.md) §6.3/§7 补记。

修复 ≠ 局部补丁。任何声称「修复完成」的变更必须同时交出两件验证产物，缺一即验收不完整：

**规则 1：修复必须附交互矩阵（修复点 × 既有 retry / rebuild / budget / 计数机制）**。修复改变的是行为的某个分支，但被改分支的**输出**（error 文本、事件、退出码）往往是其他机制（重试分诊、预算消耗、闸门计数、状态重建）的**输入**——修复前必须列出这些消费者并逐个回答「新输出会被它如何处置」。不做这一步，修复点本身就是新回归的引入点（案例 B：三态归因产出的新 error 文本恰好落入 retryable 分支）。

**规则 2：修复后必须重跑修复前的对照场景并比较资源面（时长 / 子进程数 / attempt 次数 / token），只看结果面（error 文案对不对）不够**。修复往往让「错误更可见/更正确」，结果面验证会假绿——错误确实可见了，但可见的错误可能触发新的放大循环。资源面对照是唯一暴露手段：同场景修复前后各跑一次，对比墙钟时长、spawn 的子进程数、重试 attempt 数、token 消耗。

**两个案例锚（均实测复现，非推理）**：

| 案例 | 回归形态 | 为什么结果面看不到 | 资源面暴露形态 |
|---|---|---|---|
| **AP 并集恒定（R4 发现）** | R3 修复（echo keys 并入签名）便 required 渐进修复场景「缺失列表∪keys」恒定——模型每轮修好 1 个字段的真实进展被判为同签名无进展，3 次 terminal 误杀 | 闸门行为完全符合自身契约（同签名 3 次 → 终止），error 文案正确 | 探针：6 required 字段每轮修 1 个，三轮签名恒 `fields(6)`——签名序列断言（进展必须产生新签名）才暴露 |
| **F-1 retry 放大 3×（R5 发现）** | R3 失败表面化修复让 gate 终止的 run 从「静默 completed+{}」变为「failed+error」——新 error 恰好落入 `executeAgentCall` 的 retryable 分支，不可满足 schema 重试 3 轮（每轮含 ~25s gate teardown 窗口） | error 文案完全正确（归因清晰、可读、可恢复）；run 最终也确实失败 | 实测 attempts=3、4 个子进程 journal、235s vs 修复前同场景 67s（3× 放大）——时长/子进程数对照片刻暴露 |

**落地形态**：修复 PR/commit 的验证记录应含 ①交互矩阵（哪怕三行：修复点 × 消费机制 × 处置结论）②修复前后同场景资源面对照表。单测锁不住这两面（R4/R5 的回归均在单测全绿下存活）——交互矩阵是设计期检查，资源面对照是实跑检查。

## 测试自身引入的 flake 防规范 [from: subagent-sync-collect 满载 flake 模式族排查]

> 沉淀来源：subagent-sync-collect 一轮「满载 flake」模式族排查。共同根因：**等待机制自身触碰被等待方持有的共享资源，或用固定 sleep 硬等真实外部事件**——开发机低载下全绿，CPU 满载/高并行下成批 flake。三条规范防复发，适用所有涉及真实子进程/文件系统/跨进程协作的测试与代码。

**规范 1（F2 观察者效应）：等待机制禁止触碰被等待方的共享资源**。测试/代码中等待另一个进程或异步操作就绪时，等待机制自身不得获取/写入被等待方持有的共享资源（锁、文件等）。典型反例：用「试探性获取同一把锁」去等子进程持锁——探测本身制造竞争，满载下持锁窗口被 CPU 抢占拉长 20-250 倍，等待目标反而被探测拖死。就绪信号必须走只读/独立通道：stdout 行握手、进程内事件、挂牌文件（只读自己创建的文件）、消息式 RPC。
`[HISTORICAL]` 案例锚：D1a 跨进程锁观察者效应（`packages/runtime/test/pi-settings-store.test.ts` 探测自制造竞争）→ commit `44464689a` 改 stdout 握手 + pi-faithful 重试。

**规范 2（F4 固定 sleep 硬等）：等待真实外部事件必须轮询 + deadline**。等待真实外部事件（子进程退出/reap、文件落盘、WS 消息、watcher 建立基线）禁止「固定 sleep N 后单次断言」——必须轮询 + deadline（25-50ms 间隔，deadline 按最慢合理路径给足 5-10s），达到期望状态即通过。负向断言（断言某事不发生）放在对应正向条件确认之后再断言。**与 §1「timer 测试用 fake timers、禁止真实等待」的分界**：纯内存 mock 的微任务排空走 fake timers，不受本规范约束；本规范只管真实外部事件（fake 不了，只能轮询等）。E2E mock 轨同族规则（禁 `page.waitForTimeout` 固定值）见 [docs/testing/00-test-strategy-overview.md §6.1](docs/testing/00-test-strategy-overview.md)。
`[HISTORICAL]` 生产侧同族案例：manifest fire-and-forget 写盘时序屏障 → commit `6dc9d20e9`（写盘完成设为 pre-ledger barrier，时序依赖显式化）。

**规范 3：teardown 删除 recursive 目录必须带 maxRetries**。`rmSync(dir, { recursive: true })` 与在途异步写竞争 → 间歇 ENOTEMPTY；删除必须带 `maxRetries`（如 `maxRetries: 5, retryDelay: 20`），等待机制与探测一并只读化（规范 1）。pre-commit 护栏 `check_test_flake_hygiene.py` 落地中。
`[HISTORICAL]` 案例锚：teardown ENOTEMPTY flake → commit `d9ad39cb8`（`packages/subagent-core/src/execution/__tests__/sync-collect-recovery.test.ts:252` rmSync 加 maxRetries）。

**仍在修复中的活案例（pgrep 全机扫描跨包互踩）**：`extensions/universal/base-tool-enhance/src/__tests__/kill-tree.test.ts:66` 用 `pgrep -f "sleep 30"` 全机扫描验证子进程无残留——扫描范围覆盖全机进程，与并行运行的其他测试/无关进程互踩。验证「自己 spawn 的进程已死」应限定 pid/进程组（`pgrep -P <pid>`）或读自有句柄，禁止全机模式扫描做断言。
