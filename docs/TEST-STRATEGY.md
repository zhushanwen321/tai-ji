# 测试策略（TEST-STRATEGY）

> 测试体系 SSOT。AGENTS.md「测试规范」章节是规则载体，本文件补充分层策略 + 回归基线 + mock 策略 + 运行手册。两者互补不冲突。
>
> **回归排序按功能分级**：P0 每版全量、P1 每版核心用例、P2 抽样/变更触发、P3 变更触发——分级表见 [docs/FEATURE-PRIORITIES.md](docs/FEATURE-PRIORITIES.md)（P0-P3 SSOT）。
>
> **各功能具体测试步骤**（MOCK/非MOCK/Playwright 调用链 + 每步期望输入输出）见 [docs/testing/](docs/testing/) 测试手册（2026-09 并册为 4 册）：
> - [00-overview.md](docs/testing/00-overview.md) — 总览（双轨制 + Playwright harness + 公共前置 + E2E 常见坑，入口篇必读）+ 手册索引 + real 轨手工手册（RT-01~08）+ real 轨自动化 spec（真 Electron + runtime + pi + LLM，零 mock）
> - [01-chat-panel-composer.md](docs/testing/01-chat-panel-composer.md) — 对话主链：新建任务（Landing + 选目录 + 首发提交）/ Composer（输入框 + slash 命令浮层 + 三态）/ 对话流（流式消息 + 工具调用 + 变更集）
> - [02-panels-sidebar.md](docs/testing/02-panels-sidebar.md) — 面板与侧栏：文件树（懒加载 + 过滤 + git 角标，11 E2E 用例已落地）/ SideDrawer（文件预览 / diff / git tab）/ 搜索浮层（⌘K 四类搜索 + recents + 跳转，7 E2E 用例已落地）/ GUI 组件渲染 / Subagent-Workflow 面板 / 后台命令侧边栏
> - [03-runtime-extensions.md](docs/testing/03-runtime-extensions.md) — runtime 服务与 extension：系统提示词配置 / extension 层运行时测试体系（worker harness L1 → real LLM L3，价值层级 + 决策树）/ 插件系统非 mock E2E / 自动升级验证

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

> **[HISTORICAL] E2E 从手动升级为 Playwright**：原「E2E 手动，无 playwright/cypress」（2026-06-28 sidebar-project-file-tree W0 引入 Playwright 覆盖）。mock 轨验证渲染/交互，但**验证不了模块加载期副作用**——`node:path` 类错误在 vite build 期被 externalize 成惰性代理，mock 模式不触发 getter，E2E 全绿却 dev 崩溃（2026-06-30 事故）。**必须配套 dev 冒烟闸门**。详见 `.taiji-harness/2026-06-30-e2e-retrospect/`。`[from: 2026-06-28-sidebar-project-file-tree §2/W8]`
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
pnpm --filter @taiji/frontend run typecheck
cd packages/runtime && npx tsc --noEmit

# pi-scheduler 真实环境端到端实测（spawn 真实 pi + LLM，设计契约见脚本头部）
node scripts/verify-scheduler-e2e.cjs
```

### 测试数据隔离防线（test-guard，仓库级强制）

> 规则 SSOT = AGENTS.md「测试」节「测试禁止触碰真实数据目录」。双层防线原为 runtime 包私有（2026-09-02 会话丢失事故后固化在 runtime vitest），2026-09-16 升级为仓库级强制——从非包 cwd 误跑 workspace 全仓 vitest 时 runtime 配置不加载、防线整段失效，测试删光 prod 数据目录（2026-09-16 同族事故）。

- **双层防线**：① global-setup 将 `TAIJI_AGENT_DATA_DIR` 钉死 tmp + 对「注入真实 `~/.taiji` / 非白名单目录」的注入值**自动脱钩**（2026-09-17 前为 fail-fast 拒跑；脱钩 = 删 env 后落 tmp，安全等价且免去人人 `env -u` 的摩擦，判定与 `isInjectedEnvAllowed` 共用）；② fs-guard（setupFiles 切面）拦截全部破坏性 fs 操作（写/删/移动），白名单 = `os.tmpdir()` + `$TAIJI_AGENT_DATA_DIR`（≠ 真实目录）+ `~/.taiji-dev`（homedir 动态推导），其余目录一律抛错
- **唯一防线入口 = `taijiTestConfig` 工厂**（`test-guard/factory.ts`）：全仓所有 vitest.config.ts 一律经工厂包装，无条件注入 globalSetup + fs-guard（绝对路径注入，不受各包 root 差异影响；防线排最前，用户 setupFiles/globalSetup 追加保留，其余字段只增不改）；根级兜底 vitest.config.ts 同样经工厂包装——从仓库根 cwd 跑 vitest 防线同样生效
- **漏挂机器守卫**：`scripts/check-vitest-guard.mjs` 静态扫描全部含测试的包根 + test-guard/ + 仓库根兜底 config，校验 config 经工厂包装（特征 = 引用 `test-guard/factory`），漏挂/缺失 exit 1（pre-commit 按路径触发 + CI invariants）；防线元测试收敛在 `test-guard/fs-guard.test.ts`
- **写删目标约束**：新测试的写删目标必须 `mkdtempSync(join(tmpdir(), ...))` 自建自删，禁止删除 `getSessionsDir()` 等共享推导路径；禁止绕过 guard（restore 原始 fs / 子进程删真实目录）
- **运行边界 [HISTORICAL]**（2026-09-16 事故）：禁止从包目录外触发 vitest 扫描式跑测——根目录是唯一合法全仓入口（防线齐备）；单包测试固定 `cd <包目录> && npx vitest run`（见上「运行命令（cwd 敏感）」）

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

- **机制**：`scripts/visual-capture.mjs` 截目标页面 PNG → 主 agent 用 `subagent` 工具派发 `minimax-token-plan-router/minimax-m3` VLM，对照 `docs/DESIGN.md` 文字描述逐区域检查 → 返回结构化 JSON（regions/verdict/meta）
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
| **real E2E fixture（real runtime + pi spawn，create session 无 LLM 依赖）** | real 模式 E2E 不设 TAIJI_MOCK（启动 runtime）+ real renderer bundle（VITE_MOCK=false build）。create session（session-lifecycle.create）的 record 是 create 同步收尾，**不调用 LLM**（LLM 调用在 sendPrompt）。real E2E 需预设 pi provider 配置（$dataDir/pi/agent/models.json + settings.json），dialog 走 WS 直连触发等效业务动作。mock/real E2E 分批 build（VITE_MOCK 构建期 define，bundle 输出冲突） | `2026-07-03-recent-workspaces`（T4.6 跨进程持久化 real E2E）`[from: 2026-07-03-recent-workspaces §execution T4.6]` | `e2e/workspace-real.spec.ts` + `e2e/fixtures/launch-app-real.ts` |
| **v6 token 落地断言（A 层）** | design-tokens 原子值在组件层正确消费（class→`var()`），双轨验证：vitest 契约（注入等价 CSS 断言消费）+ chromium 真实（加载 JIT CSS 验 computed style）。破坏=token 未落地致颜色/间距/圆角错乱 | `v6-ui-refactor-test-infra S2-W1`（happy-dom `var()` 能力探测推翻预设）`[from: S2-W1]` | `packages/renderer/src/__tests__/v6-visual/tokens.test.ts` + `scripts/token-consume-check.mjs` |
| **v6 像素 diff baseline（C 层）** | `e2e/visual-baselines/` baseline 快照对照（**git tracked**），visual-chromium project + `maxDiffPixelRatio:0.01` + `caret:'hide'`。破坏=可见像素级回归（布局错位/元素消失） | `v6-ui-refactor-test-infra S2-W3`（snapshotDir 是 project 直接属性非 use）`[from: S2-W3]` | `e2e/visual/*.spec.ts` + `e2e/visual-baselines/` |
| **v6 选中态二分 D8（B 层 VLM）** | sidebar 选中项 bg-surface + 蓝字（D8 二分规则：列表项型），minimax-m3 VLM 对照 v6-master-spec 语义验证。破坏=选中态视觉不符 spec（选中项无背景/颜色错） | `v6-ui-refactor-test-infra S2-W2`（VLM 三段式 task 派发+schema 内嵌）`[from: S2-W2]` | `docs/testing/visual/vlm-prompt-template.md` + `.taiji-harness/visual/` |
| **插件系统非 mock 端到端** | 隔离 runtime（tsx 源码形态）+ 真实插件文件 + 真实 WS：sandbox 激活 / toggle 往返 / built-in statusline 发现 / onBeforeSendMessage hook 真实执行。破坏=插件真实加载路径回归（mock 层不可见的 F1-F4 类 bug） | `2026-08 插件系统 F1-F4`（测试金字塔底部全 mock、真实加载路径零覆盖） | `scripts/verify-plugin-e2e.sh`（挂 `validate-runtime-bundle.sh` 第 7 步，pre-commit 于 runtime src 变更触发）+ `packages/runtime/test/plugin-registry.test.ts` TC-1-09/10/11（built-in 扫描两形态）；手册 [docs/testing/03-runtime-extensions.md](docs/testing/03-runtime-extensions.md) §3（插件系统非 mock E2E） |
| **流式 block 双轴尾部追踪 + 折叠头截短** | thinking 折叠预览/tool 折叠头在 streaming/running 中渲染尾部行窗口且 scrollLeft 钉右（`scrollLeft >= scrollWidth - clientWidth - 1`）、完成态回落静态摘要；折叠头路径 `…/末两段` 截短但展开态/copy 全量；preview 行高恒定（virtua 高度断言依赖）。破坏=流式预览死在开头/折叠头丢命令可见性/虚拟列表行高抖动 | `cw-2026-08-25-chat-visual-font-optimize`（实测发现：pi bash 部分输出无流式增量广播，tool 接入点按预案降级静态 argPath，thinking 链路钉尾 3/3）`[from: chat-visual-font-optimize (cw-2026-08-25) §D4]` | `packages/ui/src/features/chat/composables/__tests__/useTailScroll.test.ts`（9 用例：钉右/translateY/降级/未挂载）+ `packages/ui/src/features/chat/__tests__/Block.test.ts`（双态 DOM 断言）+ `format-utils.test.ts`（shortenForHeader/tailLines 规则） |
| **等价性测试双轨** | live ≡ reload / broadcast ≡ get_state / 混沌注入收敛等不变量断言。CI 与 PR/merge 门禁只跑凭证无关子集（mock RPC / fixture 重放，`TAIJI_SKIP_REAL_PI=1` 双侧显式声明），真实 LLM turn 用例在开发阶段按改动面跑（详见下方「等价性测试双轨」小节） | `2026-08-19 data-source-governance P1-P4` goal-audit 问题 1（CI 无 pi 凭证，push 后 test-runtime 预期红） | `packages/runtime/src/__tests__/equivalence/` 13 文件（skip 机制 SSOT = `pi-fixture.ts` `REAL_PI_READY`） |
| **pi 语义守卫探针族** | 静态直读 pi dist 断言私有语义契约（pattern 引擎匹配规则 / reasoning 两级门控 / RPC 响应面 / steer drain 窗 / settled 复位序 / entry→context 映射），pi 升级语义漂移即红；配套 `check-pi-semantics.mjs` 版本门禁（四包一致 + verifiedWith 比对）与 `diff-probe-thinking.mjs` 档位对账。破坏=pi bump 后语义假设批量过期无人知（登记≠防御：8-20 登记观察项 8-27 照样出事的实证） | `2026-08-27 事故对`（subagent 派发 429/gc + 思考等级自动变关）`[from: pi-boundary-reliability U7]` | `packages/runtime/src/infra/pi/__tests__/pi-semantics-*.test.ts`（6 文件，凭证无关 CI 可跑）+ `scripts/check-pi-semantics.mjs`（pre-commit + CI）+ `scripts/diff-probe-thinking.mjs` |
| **sync-collect 探针（已退役，R3 归档）** | sync 批机制已随 collect 退役整体删除（2026-09-16）——探针的被测写点（flushBatch 时序、appendBatchFinalizedEntry、finalizeOrphanRecord merge、E1 判定）已不存在，v2/v3 不再可跑，e2e-map 登记已摘除。`scripts/probes/subagent-sync-collect/` 目录（18 文件，含 RESULTS.md 与 v1/v2/v3）已删除（2026-09-16 随 collect 退役清理，git 可追溯）；此处记录退役原因（禁止只删不记）。 | `collect 退役`（u8 文档同步）`[from: subagents-batch-tool-fanout P2.4]` | 探针目录已删除（git 可追溯） |

### 等价性测试双轨（真实 LLM turn 基线：开发阶段按改动面跑）[from: 2026-08-19 data-source-governance]

等价性测试族（`packages/runtime/src/__tests__/equivalence/`，G3 长期回归基线）按「是否发起真实 LLM 调用」分两轨：

- **凭证无关子集（CI 覆盖）**：mock RPC 层 describe（`scalar-state-invalidation` / `usage-queue-commands-invalidation` 各自的「mock RPC 层」describe、`w10-usage-switchmodel-race` / `w12-owner-snapshot-publish` / `w18-record-entry-chaos` / `session-manager-e2e-fixture-unit`（探针基建纯单元：config 注册断言 + 行协议）整文件）——不 spawn pi、不发 LLM 请求，无条件执行。
- **完整基线（开发机跑）**：真实 pi 子进程 + 真实 LLM turn 用例（`live-reload` / `broadcast-getstate` / `chaos` / `pi-protocol-contract` / `session-manager-full-e2e`（agent-managed session 真 pi 全链路，REAL_PI_TESTS 分池）/ `thinking-level-effective-e2e`（pi 边界回执保险丝：reasoning:false 模型 set high → 断言回执=get_state=off，正常模型回执=请求值——「config ≡ pi effective」端到端守卫，REAL_PI_TESTS 分池）整文件，及 `scalar-state-invalidation` / `usage-queue-commands-invalidation` 的「真实 pi 子进程」describe）——依赖本机 pi 凭证（默认模型 `xiaomi-token-plan-cn/mimo-v2.5-pro`）。**凭证属用户基础设施，不由 CI secrets 虚构注入**。

**何时跑（2026-09-15 e2e 执行准则修订，SSOT = AGENTS.md「测试」节）**：改动涉及 pi 协议链路（`event-adapter` / `message-converter` / `pi-protocol`）、entry reducer（core `apply-entry`）、replicated-states 失效收敛、或 equivalence 目录本身时，在**开发阶段**于开发机跑受影响子集（空载串行；清单由 tech-design 设计文档的 e2e 影响面评估圈定、dev-flow 验收计划表承接）。**PR / merge 门禁不跑 real-pi**：pr-cr-fix 阶段 3a（pr-pre-merge.sh `test:runtime` 步骤）显式设 `TAIJI_SKIP_REAL_PI=1` 只跑 unit 轨，与 CI 完全同口径——「real-pi 不由 CI/PR/merge 承接、只在开发阶段按改动面执行」是显式分工策略而非环境巧合（2026-09-15 前：3a 不设 skip 全量承接，因全仓并发扫下真实 LLM 轮次越过事件预算的 send-queue-e2e 超时事故而修订）。real-pi 失败先读 junit failure 详情归因（seen types 区分「LLM 在推进但慢」与「真死锁」），禁止不归因直接重试；自动化回归长期方向 = e2e 逐步单测化。

> **faux 轨豁免说明**：红线「PR / merge / CI 门禁一律不跑真实 LLM e2e」（SSOT = AGENTS.md「测试」节）不含 faux 轨（L2.5，真 pi 进程 + faux LLM 演员）——faux 轨凭证无关、零 token、可确定性复跑，断言口径与单测同级，CI 常规池已在跑（test-runtime job `TAIJI_SKIP_REAL_PI=1` 跑的等价性 unit 轨即凭证无关子集）。红线拦的是烧 token、依赖用户凭证、时长不可控的真实 LLM 轮次，faux 轨不属此列。

**skip 机制（SSOT = `pi-fixture.ts`）**：模块顶层 `REAL_PI_READY`（binary `which pi` + 凭证三源探测：env `XIAOMI_TOKEN_PLAN_CN_API_KEY` / `<agentDir>/auth.json` stored 条目 / `models.json` providers apiKey，探测链对齐 pi AuthStorage 静态 source）。真实 LLM 用例一律 `describe.skipIf(!REAL_PI_READY)` 包裹；skip 理由注入 describe 名 + 模块加载时 console.warn（双通道显式可见，不静默消失）。

- CI（ci.yml test-runtime job）显式设 `TAIJI_SKIP_REAL_PI=1`：把「CI 只跑凭证无关子集」从隐式事实（CI 恰好无 `~/.pi`）变为显式声明，skip 理由直接指向本节。
- 本机模拟无凭证验证 skip 语义：`TAIJI_SKIP_REAL_PI=1 pnpm test:equivalence`（真实 LLM 用例 skip 且理由可见、mock 子集照跑）；去掉 env 即恢复全量。

## 5. mock 策略

- **唯一合法入口：`packages/core/src/transport/mock/` 层**（模拟 runtime WS 协议返回，经 `api/index.ts` 门面按 `VITE_MOCK` 切换接入——true 时直接 import `@taiji/core/transport/mock`，不走 transport）。验证：`docs/STANDARDS.md §8.1`
- **禁止**：组件内联硬编码 mock（`const MOCK=[...]`）、panel/composables/lib 静态 fixture、组件直接 import `@taiji/core/transport/mock`
- **测试 mock**：`vi.mock` api domain；复用 core mock 层的 events/fixtures（如 `run-send-stream.ts` 模拟流式 ServerMessage 序列、`mock-ws.ts` 模拟 WS 生命周期）
- **例外**：UI 固定枚举常量（如 thinking-levels 6 级）、`__tests__/` 测试 mock 不算违规
- **外部系统对接验证脚本**：独立 `verify-<system>.cjs`（放项目根或临时位置），先验证字段名/格式再编码,完成后移除

### vi.mock 注意事项

- **factory 不能引用外部变量**（hoisted）：用 `vi.hoisted()` 或在 factory 内 inline + `import { session as sessionMock } from '@/api'`
- **mock 整个 api 模块时记得 mock 所有被测路径用到的方法**（漏 mock 会 undefined 崩溃）
- **happy-dom 对 contenteditable/Selection/Range 支持有限**：测 contenteditable 组件用 textContent + querySelector + dispatch input event，不要依赖真实光标操作
- **DOMPurify 与 happy-dom 不兼容（nodeName 在元素子类而非 Node.prototype）**：DOMPurify 在 happy-dom 下全标签误拒（净化整体失真，且失真环境下既有断言可能假阴性通过）——markdown 渲染管线测试族（`markdown-sanitize.test.ts` 等触及 renderMarkdown/DOMPurify 的文件）已钉 `// @vitest-environment jsdom`（2026-09-19 markdown-html-sanitize-render U1 探针实证）；新增触及 DOMPurify 的测试文件照此办理

### mock 保真度登记（类型锚定 + override 生效面，2026-09-17 G4）

门面三元（renderer `api/index.ts` 的 `isMock ? mockApi.x : realX`）两侧同构的保证方式：mock 域对象显式标注 real 域导出类型（`XDomain = typeof real 域模块`，定义与断言基建在 `packages/core/src/transport/mock/index.ts` 头部「[G4 类型锚定]」注释块），配 `AssertExact<DomainParamsExact<XDomain, typeof xImpl>>` 逐方法比较 `Parameters` 元组全等——real 域加参/删参/改参型时 mock 侧少参/多参/错型直接 tsc 编译失败（注解的可赋值性抓不到「少可选参」，元组 identity 断言补齐这一层）。

- **已类型锚定（10 域）**：session / chat / config / model / plugin / composer / workspace / quota / project / preset。锚定顺带修复并补齐的漂移：session.create 补 presetId/projectId/modelOverride/thinkingOverride、session.fork 补 modelOverride/thinkingOverride、session.handoff 补 options、session 补缺失成员 getSubagentEngineConfig / setSubagentDefaultEngine / getAgentCallFilePath；config 补 retry 配置三成员（getRetryConfig / setRetryConfig / onRetryConfig）、scanSkills/scanAgents 补返回类型、discoverModels req 补 mode 字段、onAuth 系列 payload 改引 real 域类型别名；chat.compact 补 customInstructions 形参；plugin 补 approvePermissions/revokePermissions；composer.getMentionCandidates 对齐 real 已废弃语义（恒 `[]`）、getFileCandidates 补 sessionId 形参、补 getFileCandidatesByCwd stub。
- **override 生效面（mock 可断言的最小投影，不追求全仿真）**：session.create/fork 的 presetId → `SessionSummary.launchPresetId`、projectId → `projectId`、modelOverride → `modelId`、thinkingOverride → `thinkingLevel`，落返回值与 `session.list()` 快照；fork 另落血缘键 `parentSession`（恒源 sessionId，FR-20 fallback 键形态）+ `forkEntryId`，projectId 继承父归属（与 real fork 同语义）。行为契约测试：`packages/core/src/transport/mock/__tests__/mock-domains.test.ts`（create/fork override 生效面用例）。
- **mock 不支持项（显式登记，非静默丢弃）**：session.handoff 的 options（modelOverride/thinkingOverride）——无 runtime HandoffService / handoff turn 可跑，stub resolve；chat.compact 的 customInstructions——无 pi 会话可挂指令；config retry 配置——get 恒 `configured:false`、不持久化、不广播；session.getSubagentEngineConfig 恒空清单（无 engines.json 基建）。
- **未锚定域及理由**：settings（mock 是 7 成员子集转发器，real 是 40+ 方法全域，补齐属独立工作）／extension（onExtensions 宽类型为登记过的有意偏差，W08 收口时一并锚定）／search（real 侧无单源 domain，编排归 useSearchModalDeps）／git、file（独立 mock 文件，待后续同法锚定）。

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
- **CI 收集**：`.github/workflows/coverage.yml`（nightly + workflow_dispatch）跑 `--coverage` 并 upload `coverage-report` artifact（`if:always()` 失败也上传便于排查 gate 红，path `packages/renderer/coverage/`）。[HISTORICAL] 原设计把 `--coverage` 挂在 ci.yml renderer test 步骤，但 pnpm@10 `--` 透传使该 flag 自落地起从未生效（gate 实际从未执行过，阈值形同虚设）；2026-09-14 修复 flag 透传时迁至独立 nightly workflow——PR CI 不跑插桩（~2x 会把 renderer 推到 ~5min 关键路径），阈值防侵蚀由每日快照兑底
- **产物**：`packages/renderer/coverage/`（index.html + lcov.info + lcov-report/），已被 `.gitignore` 覆盖
- 通用原则：增量核心逻辑应 100%；全文件覆盖率含大量 pre-existing 代码偏低，**以增量覆盖率为准**
- 运行：`cd packages/renderer && npx vitest run --coverage`

## E2E CI（mock 轨进 CI）

> S3-W2 交付 visual 轨 job；2026-09-15 补行为轨 P0 smoke job（e2e-behavior，L1 层接线）。`[from: v6-ui-refactor-test-infra S2-W2 e2e-ci]`

**ci.yml e2e-visual job**：CI 内跑 mock 轨 visual-chromium project（`npx playwright test e2e/visual`），复用 lint job 成熟模式（checkout → pnpm/action-setup → setup-node → pnpm install，`fetch-depth:1`/node24/cache pnpm/`ELECTRON_SKIP_BINARY_DOWNLOAD:1` 全一致）。

**ci.yml e2e-behavior job**（2026-09-15）：CI 内跑 mock 轨 electron-smoke project（`npx playwright test --project=electron-smoke`，9 条 `@p0-smoke` 用例，零 token / 零凭证 / 不 spawn pi；本地实测 30s、含 globalSetup 自动 build 38s）。与 e2e-visual 的关键差异：① install **不设** `ELECTRON_SKIP_BINARY_DOWNLOAD`（`_electron.launch` 需要 node_modules/electron 真实二进制）；② **不设** `E2E_VISUAL_ONLY`（globalSetup 检出产物缺失时自动跑 build:e2e，VITE_E2E/VITE_MOCK env 由 globalSetup 内部注入）；③ 无需 `npx playwright install chromium`（Electron 自带 Chromium）。圈定 SSOT = `playwright.config.ts` electron-smoke project 的 grep 标签（`@p0-smoke`，子集关系非互斥分轨）；用例名单见下方「e2e 资产归宿纪律」。

- **build gate 联动**：两个 E2E job（e2e-visual + e2e-behavior）都加入 reusable workflow（`build.yml`）的 needs 数组，任一质量 gate job 失败则 build 不触发（阻塞 release）
- **artifact 隔离**：upload-artifact name 用 `test-results-visual` / `test-results-behavior`（与 test job 的 `test-results` 区分，GitHub Actions artifact name 必须唯一）
- **方法论 [from S3-W2]**：(1) **CI job 复用成熟模式优于创新**（一致性>品味，reviewer 一眼读懂 job 结构降低配置错误率）；(2) testMatch 隔离是双 project 共存关键（路径参数 + project testMatch 双重过滤自动只跑像素轨）；(3) CI 改动本地能验证 YAML 语法合法 + 配置字段正确 + 本地跑通复验，CI 环境特有行为（chromium 下载时长/字体渲染差异/并发额度/globalSetup build 超时）记录为 followup 待 push 后观察，不阻塞 wave 闭环

## e2e 资产归宿纪律（三态 R1/R2/R3，2026-09-15）

> 配套 e2e 测试四层定位框架：L1 CI 固定环节（每 PR，零 token）→ L2 开发阶段按改动面（dev-flow，真实 LLM）→ L2.5 真 pi 进程 + faux LLM 凭证无关全链路（调研中）→ L3 触发式真实 LLM 回归（发布前 / pi bump）。三态纪律回答「每条 e2e 资产归哪一层、退役去哪」，与上文「E2E CI」章节（L1 落地形态）、§4「等价性测试双轨」（real-pi 分工）衔接；执行准则 SSOT 仍 = AGENTS.md「测试」节。

**每条 e2e 资产（spec / 用例 / 探针脚本）必居下列三态之一，禁止第四态「既不在任何固定环节跑、也不归档登记」**（挂空资产 = 悄悄烂掉，盘点时才发现）：

| 态 | 定义 | 归宿 | 登记义务 |
|----|------|------|---------|
| **R1 毕业进 CI 固定环节** | mock/fixture 化后零 token 零凭证可复跑，每 PR 跑 | CI job（如 e2e-behavior / e2e-visual / test-runtime unit 轨） | 用例打 `@p0-smoke` 标签（行为轨）或进 vitest 套件；名单随本章节登记 |
| **R2 保留为按改动面触发的 e2e 子集** | 依赖真实进程 / 真实 LLM / 特定环境，CI 跑不了或不该跑 | dev-flow 验收计划（L2）/ 触发式回归（L3）/ L2.5 调研线 | **触发条件必填**（见下），登记进 `docs/testing/e2e-map.json`（机器登记 SSOT；结构校验 = `scripts/validate-e2e-map.mjs`，防漏门禁 = `scripts/select-affected-e2e.mjs --check`；本章节表格保留宿主叙述） |
| **R3 归档为文档** | 退役（守护对象已消亡 / 断言面被更强资产覆盖 / 环境前提永久不可复现） | docs/testing/ 手册对应章节，注明退役原因 | spec 文件删除 + 手册记录「退役原因 + git 可追溯」；禁止只删不记 |

**触发条件必填原则**：R2 资产必须写明「什么改动触发重跑」——可判定的条件（改动路径 glob / 事件如 pi bump / release，条件可判定、路径可 grep）。tech-design 设计文档的「e2e 影响面评估」据此圈定子集，dev-flow 验收计划表承接。写法参考：`docs/testing/e2e-map.json` 的 E2E-BATCH-01（现行 R2：scope = 路径 glob 集合 + trigger = on-diff）；trigger 的事件形态参考 E2E-BATCH-02（R3 人工验收，trigger = on-pi-bump 表达重验时机信号）。

> **术语桥接（与逐用例处置标签的编号区分）**：本节三态 R1/R2/R3 是**资产生命周期归宿**；R2（按改动面触发）资产进一步标注执行层——L2 真实 LLM（dev-flow）/ L2.5 faux 轨（真 pi + 假 LLM，凭证无关）/ L3 触发式（发布前、pi bump）。并行调研使用的 R1-R5 是**逐用例处置标签**（R1 毕业单测 / R2 翻 faux 轨 / R3 保留真实 LLM / R4 触发式 / R5 归档），编号撞名但语义不同，阅读时按上下文区分。逐用例的处置判定与触发条件机器登记已落地（2026-09-16）：**SSOT = `docs/testing/e2e-map.json`**（全部 e2e 资产的触发面/层级/运行命令/触发器登记），消费与守卫脚本 = `scripts/select-affected-e2e.mjs`（--base 按 diff 选受影响 rules / --release 选发布与 pi-bump 面 / --layer 过滤 / --check 防漏登记门禁）与 `scripts/validate-e2e-map.mjs`（结构 + asset 磁盘存在校验）；文档此处只定纪律，下方表格为 2026-09-15 行为轨初判登记（逐例权威以 e2e-map.json 为准）。

### 行为轨 mock spec 归宿标注（2026-09-15 初判）

9 个 mock spec / 45 用例（2026-09-15 腐烂清理后：44 可跑绿 / 1 fixme 待修；同批 8 条腐烂中 7 条已退役删除——R3，1 条 SM-E2E-6 查证为真回归 fixme 保留，处置见各行登记）。smoke 子集成员（9 条 `@p0-smoke`，目标 P0 面：布局 / session 切换与隔离 / 首条消息流 / composer slash / 侧栏文件树 / 失败路径入口 / 升级残留清理）标 R1；其余 R2 初判如下（触发条件 = 改动这些路径时在 dev-flow 验收阶段跑对应 spec）：

| spec | 归宿 | 触发条件（R2 必填）/ 说明 |
|------|------|--------------------------|
| `v6-shell-baseline.spec.ts` | R1（3 条：TC-SHELL-LAYOUT / TC-SESSION-SWITCH / TC-MSGSTREAM-TURN）+ R2（TC-SIDEBAR-COLLAPSE） | R2 触发：改 `AppShell` / 侧栏折叠 chrome（AppNavControls / PanelHeader 折叠按钮）时跑 |
| `state-tearing.spec.ts` | R1（2 条：ST-1 / ST-5）+ R2（harness smoke / ST-2 / ST-3 / ST-6） | R2 触发：改 `useChat` / `derive-status`（isActive 状态机）/ steer 队列 / mock `run-send-stream.ts` 时跑 |
| `composer.spec.ts` | R2（harness smoke / CF-1 / CF-4 / CF-5） | 触发：改 `Composer.vue` / `useCommandPopoverTrigger` / CommandPopover 时跑。CF-2 / CF-3 / CF-6 已退役 R3（2026-09-15 清理）：composer 符号体系已改为 **# session / $ file**（`ComposerInput.vue` onFileTrigger→session-trigger / onDollarFileTrigger→file-trigger），敲 `#auth` 期望文件候选的断言永挂；git 可追溯 |
| `search-modal.spec.ts` | R1（1 条：SM-E2E-7）+ R2（harness smoke / SM-E2E-1~5 / SM-E2E-8~10）+ **R2 fixme 待修**（SM-E2E-6） | R2 触发：改 SearchModal / `useSearch` / `commandStore`（pendingSlash 一次性通道）时跑。SM-E2E-6（2026-09-15 查证定性：**真回归**，fixme 保留）：confirm 文件项后浮层未关闭（`search-modal-root` 仍可见）——UI 意图明确是关闭（AC-6.7），根因 = `useSearchModalDeps.ts:62` fileRead 直连 core real file 域绕过 `@/api` 门面 isMock 切换，mock 轨下 `file.read` RPC 挂 65s backstop；修复方向 = fileRead 改走 `@/api` 门面 |
| `file-tree.spec.ts` | R1（1 条：E2E-1）+ R2（其余 9 条） | R2 触发：改 `FileView` / `FileTreeRow` / `useFileTree` / fileTreeStore / mock `file.tree` 时跑。E2E-3b 已退役 R3（2026-09-15 清理）：diff 视图已从 raw diff 文本（`diff --git` 头）改为结构化 hunk 渲染（`@@ … @@`），断言过期；git 可追溯 |
| `failure-paths.spec.ts` | R1（1 条：A12）+ **R3 初判**（A13：pi 崩溃→重建） | A13 退役理由初判：TAIJI_MOCK=1 不起 runtime，崩溃重建链路在 mock 轨不可达，现断言面（title + 基础 UI 可见）与 harness smoke 重复、无守护价值；真实崩溃重建由 L2.5（真 pi 进程线）承接。**待 L2.5 调研线终判后再动文件** |
| `workflow-sidebar-sync.spec.ts` | R2（3 条） | 触发：改 workflow 侧栏 tab / subagent 列表 / overlay 路由（workflow detail vs agent overlay）时跑。E3 已退役 R3（2026-09-15 清理）：agent call overlay 改版，`subagent-back-btn` testid 不存在；git 可追溯 |
| `workspace.spec.ts` | R2（3 条） | 触发：改 `workspaceStore` / DirSelectPopover / mockApi.workspace 门面时跑（含 §4「store 必须走 @/api 门面」基线） |
| `gui-components.spec.ts` | R2（2 条） | 触发：改 `Block.vue`（`__gui__` tool result 渲染）/ SideDrawer terminal/browser tab 时跑。路径 A ×2 已退役 R3（2026-09-15 清理）：SideDrawer 内 `gui-stats-line` / `gui-list-tree` testid 不存在（widgetGui 渲染链路改版）；git 可追溯 |

**行为轨 real spec（`*-real.spec.ts`，6 个）**：需真实 runtime（不设 TAIJI_MOCK）+ real renderer bundle，其中 ask-user-real / tasks-drawer-real / workflow-thinkinglevel-real 含真实 LLM 调用——**不在此终判**，移交 L2.5（真 pi + faux LLM 调研线）/ L3（触发式回归设计线）终判；倾向初判：models-json-sanitize-real / update-cleanup-real / workspace-real 为凭证无关 real 进程资产（create session 不调 LLM），适合 L2.5 承接。

### 2026-09-15 盘点发现并已修复的存量问题 [HISTORICAL]

本次行为轨全量实跑（52 用例）暴露 4 个存量问题，随本批修复（正是「无固定环节的 e2e 悄悄烂掉」的实证——接入 CI 前无一被发现）：

1. **mock 产物被 real bundle 覆盖**：行为轨与 real 轨共用 `apps/electron/renderer/dist` 输出（VITE_MOCK 构建期 define），跑过 real 轨/普通 build 后 mock 轨全量挂（页面停在「连接中…」），globalSetup 只查产物存在不查构建形态。修复 = 重建 mock 产物；根治方向（产物形态标记/分离输出目录）登记为待办，跑 real 轨后需 `VITE_E2E=true VITE_MOCK=true pnpm run build:e2e` 重建（见 docs/testing/00-overview.md §5）。**2026-09-16 反向变体实证**（system-notice-rendering-upgrade 阶段 5）：dist 为 stale **mock** 形态时 real spec 的 UI 断言必挂且信号高度误导——renderer 走 mock transport 渲染 mock 种子数据（sidebar/workspace popover 出现假 session/工作区、mock 相对时间戳恒等于当下），而 spec 自带的 WS 直连断言照常全过，症状酷似「环境数据串扰/连错实例」。归因抓手 = 失败现场 DOM 里的条目与 `core/src/transport/mock/` 种子数据逐字比对。修复同款 = 按轨重建产物（`VITE_E2E=true pnpm run build:e2e` 不带 VITE_MOCK）后空载串行复跑
2. **`build:e2e` script 断链**：root 别名指向 apps/electron 不存在的 script（pnpm --filter 无匹配时静默 exit 0），本地因产物恒存在从未暴露、CI fresh checkout 上 globalSetup 必报「产物仍缺失」。已补 `apps/electron/package.json` 的 `build:e2e`（build:main + build:preload + build:vite 组合；VITE_E2E/VITE_MOCK env 注入职责留在 globalSetup，script 不硬编码跨平台 env）
3. **title 断言过期**：App.vue 运行时把 title 设为 i18n `app.title`（zh=太极），全部 `toHaveTitle(/TaiJi/)` 在 zh locale 必挂——mock 轨 6 处已改 `/太极|TaiJi/` 双兼容（real 轨 6 处同病，随 real 轨调研线处置）
4. **「会话」segmented tab 定位脆弱**：SegmentedTab icon-only 模式下 tab 的 accessible name 被 count 徽标文本（如「6」）抢占（内容优先于 title 属性），`getByRole('button', { name: /^会话/ })` 只在冷启动 sessionCount=0 的极短窗口命中——中途点击（如 ST-5 的 switchBackToS3）必挂。修复 = activateSession 改「直接等 session 文本」（v6-shell-baseline 模式，composer / state-tearing / search-modal / gui-components）+ tab 切换改 `button[title="会话"]` 属性选择器（file-tree，workflow-sidebar-sync 既有模式）
5. **「已处理」等待断言窗口不足**：gui-components / ST-6 的 `getByText(/已处理/)` 用 5s timeout 且无 `.first()`——mock 流式在负载下偶超 5s、turn-rail 摘要同名文本造成多匹配。修复 = 对齐 v6-shell-baseline 模式（`.first()` + 20s）

### 新资产进入/流转规则

1. 新写 e2e 用例时先答「归哪态」：mock 化可行 → R1 候选（打 `@p0-smoke` 需同时满足 P0 面覆盖：新建任务首条消息流 / session 切换隔离 / composer slash / 侧栏核心交互 / 错误态收口）；CI 跑不了 → R2 且**当场写触发条件**（写在 spec 文件头注释或本表），不写触发条件的 R2 资产 PR review 应拦。
2. R1 smoke 名单是**容量有界的闸门**（目标 5-10 条，单条 Electron 启动 ~5-8s）：新进一条 P0 面用例时应评估是否挤掉（降级回 R2）低价值成员，防止 smoke 膨胀拖慢每 PR 关键路径。
3. R2 → R1 毕业是「e2e 逐步单测化」长期方向的落地通道（AGENTS.md e2e 执行准则）：能用 mock/fixture 重放等价覆盖的，随改动沉淀；毕业时在本表移动行并在 CI 命令可复跑处登记。
4. R3 归档必须同步 docs/testing/ 手册（退役原因 + 替代防线），spec 删除走 git 可追溯；本表同步删行。
5. **盘点节律**：每次大版本收口（merge skill 阶段）或 e2e 四层框架接线落地时，对照 `e2e/` 目录实际 spec 清单复核本表，防止新资产漏登记滑入第四态。

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

> 沉淀来源：structured-output 重设计实施后的四轮对抗式审计（R3-R6，commits `f69766b44`→`9438940c0`→`1dfd93b1a`→`3f934637c`）。R4 与 R5 各发现一次「上轮修复自身引入回归」且均非单测可抓——回归只在资源面暴露，结果面（error 文案）完全正确。语义总览见原设计文档 structured-output-redesign.md §6.3/§7 补记（已删除，git 历史可追溯）。

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

**规范 2（F4 固定 sleep 硬等）：等待真实外部事件必须轮询 + deadline**。等待真实外部事件（子进程退出/reap、文件落盘、WS 消息、watcher 建立基线）禁止「固定 sleep N 后单次断言」——必须轮询 + deadline（25-50ms 间隔，deadline 按最慢合理路径给足 5-10s），达到期望状态即通过。负向断言（断言某事不发生）放在对应正向条件确认之后再断言。**与 §1「timer 测试用 fake timers、禁止真实等待」的分界**：纯内存 mock 的微任务排空走 fake timers，不受本规范约束；本规范只管真实外部事件（fake 不了，只能轮询等）。E2E mock 轨同族规则（禁 `page.waitForTimeout` 固定值）见 [docs/testing/00-overview.md §6.1](docs/testing/00-overview.md)。
`[HISTORICAL]` 生产侧同族案例：manifest fire-and-forget 写盘时序屏障 → commit `6dc9d20e9`（写盘完成设为 pre-ledger barrier，时序依赖显式化）。

**规范 3：teardown 删除 recursive 目录必须带 maxRetries**。`rmSync(dir, { recursive: true })` 与在途异步写竞争 → 间歇 ENOTEMPTY；删除必须带 `maxRetries`（如 `maxRetries: 5, retryDelay: 20`），等待机制与探测一并只读化（规范 1）。pre-commit 护栏 `check_test_flake_hygiene.py` 落地中。
`[HISTORICAL]` 案例锚：teardown ENOTEMPTY flake → commit `d9ad39cb8`（`packages/subagent-core/src/execution/__tests__/sync-collect-recovery.test.ts:252` rmSync 加 maxRetries）。

`[HISTORICAL]` 案例锚（pgrep 全机扫描跨包互踩）：base-tool-enhance 包原 kill-tree.test.ts 曾用 `pgrep -f "sleep 30"` 全机扫描验证子进程无残留——扫描范围覆盖全机进程，与并行运行的其他测试/无关进程互踩；载体文件已随 ext-simplify-13（进程原语下沉 extension-protocol）删除，现行承接方是 extension-protocol 包的 background-task-process.test.ts（限定 pid 的探针）。规则不变：验证「自己 spawn 的进程已死」应限定 pid/进程组（`pgrep -P <pid>`）或读自有句柄，禁止全机模式扫描做断言。

## 测试耗时基线与压缩裁决（2026-09-15 全仓 sweep 收尾）

> 沉淀来源：注入缝修复（commit `8a9a0b4a3`，消除 ~87s 纯 sleep）后的三项跟进实测。先立判据再谈优化，防止按求和值误判「慢」、按错误机理选错方案。

**判据：评价耗时看墙钟（Duration 行），不看 tests 求和值**。vitest forks 池的 `Tests Xs` 是全部测试文件在各自 worker 的执行时间加总；subagent-core 求和 32.4s 对应墙钟仅 9.5s（10 worker 并行）。求和值只用于用例间相对排序与慢文件定位（junit 按文件聚合）。

**裁决一：慢池拆分（真实 IO 用例隔离到 maxWorkers=1 组）——不做，两包均为深度负收益**。实测：subagent-core 真实 IO 文件串行总和 S=13.1s > 当前满并行墙钟 9.45s（拆后慢 39%）；zcode S=29.4s ≈ 包总时长 98.5%（拆后慢 273%）。且 vitest 4.x projects 分组调度契约是**严格串行**（`groupSpecs` 逐组 await，主组完整结束慢组才开跑），实际墙钟 = 主池 + S，比 max 公式更差。runtime 包 REAL_PI_TESTS 双池先例的动机是**防饿死**（真实 LLM 轮次的长等待窗口在 CPU 饱和下被拖 19 倍），不是墙钟优化——本地毫秒级 fake 子进程（zcode fake-appserver / subagent-core fake-engine）不满足该前提，满并行已是墙钟最优。分池门槛：只有「真实外部长等待（网络/LLM）在 CPU 饱和下被饿死」才建慢池。

**裁决二：subagent-workflow 剩余耗时——架构固有，不动**（墙钟 14.3s / 944 用例）。求和大头的构成：review-fix-loop-e2e 13.1s（真实 worker 子进程）、relay-agent 4s（真实 relay.mjs + 环回 socket）属真实 IO 语义成本；~8-10s 是 7 个「装配真实入口」测试文件的首用例动态 import 整棵组合根——forks 池无磁盘 transform 缓存、每 fork 重复付，属架构固有。三个压缩方案全部否决：入口懒加载会动组合根装配时序（u7a 验收钉死「extension 加载完成时触发」）；deps.optimizer 内联 `@zhushanwen/subagent-core` 会破坏 vi.mock 深路径与 barrel 的物理模块等价性（mock 静默失效风险）；改测试 import 形态违背 D3 裁决（2026-09-03，测试深路径统一经 alias 正则不改写）。

**裁决三：根 `pnpm test` 包级并发预算——默认已最优，不调**。10 核机 4 重包对照实测（2026-09-15）：默认并发 31.6s < concurrency=2 的 32.9s < 串行 35.3s——并发膨胀（zcode 求和 +15%）被包间进程启动/IO 重叠收益抵消还有余。CI 不经此路径（走 `--filter <pkg> exec vitest run --shard=` 按包分 job）。

`[HISTORICAL]` 案例锚（扫描根锚错层）：zcode capabilities 零消费方守卫的 `srcRoot` 上跳 5 级落到 **workspace 父目录**，实际扫所有兄弟 worktree 全部 .ts（3.1s 且耗时随兄弟 worktree 文件量漂移）；修正为本包 src 后 4ms。对照：renderer i18n 两个守卫在 `__tests__/i18n` 子目录（深 2 层），5 级跳恰好落仓库根（正确）。规则：目录内 walk 扫描的根推导层数必须按「测试文件实际深度」核对，禁止从别包抄跳层数；改完用负向探针（植入消费点确认变红）验证守卫仍有效。
