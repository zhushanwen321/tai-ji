# 00 · 测试流程总览 + real 轨（总入口册）

> 本册是测试手册的**总入口**：测试流程总览（双轨制 / Playwright harness / 公共前置 / E2E 常见坑）+ 文档索引 + real 轨全部内容（手工手册 RT-01~08 + 自动化 spec 范式）。
>
> 策略依据见根 [TEST-STRATEGY.md](../TEST-STRATEGY.md)（测试分层 SSOT）。本册是操作落地。

## 手册索引（2026-09 并册后 4 册）

| 册 | 覆盖功能 | 合并自（旧路径，git 历史可查） |
|----|---------|------|
| [00-overview.md](./00-overview.md)（本册） | 总览（双轨制 / harness / 公共前置 / E2E 常见坑）+ 文档索引 + real 轨手工手册（RT-01~08）+ real 轨自动化 spec | 00-test-strategy-overview.md + README.md + 08-real-track-manual.md + 11-real-e2e-specs.md |
| [01-chat-panel-composer.md](./01-chat-panel-composer.md) | 新建任务（Landing）/ Composer（slash 浮层 + 三态）/ 对话流（流式 + 工具 + 变更集） | 01-new-task.md + 02-composer.md + 03-chat-flow.md |
| [02-panels-sidebar.md](./02-panels-sidebar.md) | 文件树 / SideDrawer / 搜索浮层（⌘K）/ GUI 组件渲染 / Subagent-Workflow 面板 / 后台命令侧边栏 | 04-file-tree.md + 05-side-drawer.md + 06-search-modal.md + 07-gui-components.md + 09-subagent-workflow-panel.md + 14-background-task-sidebar.md |
| [03-runtime-extensions.md](./03-runtime-extensions.md) | 系统提示词配置 / extension 层运行时测试体系 / 插件系统非 mock E2E / 自动升级验证 | 10-settings-system-prompt.md + 12-extension-runtime-testing.md + 13-plugin-e2e.md + update-e2e.md |
| [visual/vlm-prompt-template.md](./visual/vlm-prompt-template.md) | VLM 视觉验证派发模板（TEST-STRATEGY 引用的 SSOT，独立不并入） | — |
| [render-sampling.md](./render-sampling.md) | 渲染采样管道（基线采集/真机验收共用：CDP 连接/选择器/注入/等待信号/DOM 采样脚本资产 + 清单表；采样前必读，禁现场重写管道） | 2026-09-19 markdown HTML 支持验收脚本提炼 |

图例：✅ = 可测且稳定 / ⚠️ = 有约束或待补 / ❌ = 不可测（需手工）；**已落地** = spec 文件存在于 `e2e/` 且能跑通。

**我要测某个功能，从哪开始？**
1. 读本册 §1-§8 理解双轨制（MOCK 轨 / 非 MOCK 轨 / dev 冒烟）和公共前置
2. 找到对应功能所在册，按「MOCK 模式」或「Playwright E2E」章节操作
3. 每个功能章都有：组件结构概述 / data-testid 清单 / 每步期望输入输出 / 可复制的测试代码；testid 以组件 template 内 data-testid 属性为准

**我要新增一个功能的测试？**
1. 复制最接近的现有功能章作为模板（功能性质相近的）
2. 按统一模板填充：组件清单 → testid 清单 → MOCK 测试 → E2E 测试 → 期望表
3. 更新本册上方索引表

**测试跑挂了？**
- 看 [TEST-STRATEGY.md §2 运行命令](../TEST-STRATEGY.md) 确认 cwd（renderer 测试必须从 `packages/renderer` 跑）
- 看 [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) 排查 runtime/WS/路径问题
- E2E 看本册 §6 常见坑
- 单测满载下间歇 flake（等待/删除/跨进程时序）→ [TEST-STRATEGY.md「测试自身引入的 flake 防规范」](../TEST-STRATEGY.md)

---

# 00 · 测试流程总览

> 本文档是测试手册的**入口篇**。理解本文的双轨制 + 公共前置后，再读各功能文档（01-05）就能直接上手。
>
> 策略依据见根 [TEST-STRATEGY.md](../TEST-STRATEGY.md)（测试分层 SSOT）。本文档是操作落地。

## 1. 测试双轨制（核心概念）

taiji 有**两条独立的测试轨道**，覆盖不同维度的 bug。缺任何一条都会漏 bug。

### 1.1 MOCK 轨（renderer-only）

```
VITE_MOCK=true → renderer 走 core mock 门面（packages/core/src/transport/mock/，镜像 api 签名）
                 不起 runtime 子进程，不连 pi，不发真实 WS
```

**能测什么：**
- renderer 组件渲染（DOM 结构、文案、可见性）
- renderer 交互逻辑（点击、输入、状态流转）
- store 状态机（chatStore/sessionStore/commandStore 分区隔离）
- 流式消息处理（mock `run-send-stream.ts` 模拟 chunk 序列）
- mock fixture 数据驱动的 E2E 用户旅程

**测不了什么（盲区，历史事故根因）：**
- ❌ **模块加载期副作用错误**：vite build 把 `node:` 内置模块 externalize 成惰性代理，mock 模式不触发 getter → `node:path.relative` 类错误在 mock 全绿却 dev 崩溃（[2026-06-30 事故](../../.taiji-harness/2026-06-30-e2e-retrospect/00-retrospect.md)）
- ❌ runtime/pi 真实协议（mock 是简化版，字段可能漂移）
- ❌ WS 连接生命周期（断连、重连、超时）
- ❌ 文件系统真实读写（mock 返回固定内容）

### 1.2 非 MOCK 轨（full stack）

```
pnpm run dev → 起 runtime 子进程 → 连 pi → 真实 session 文件读写
```

**能测什么：**
- ✅ 模块加载健康（堵住 MOCK 轨的盲区）
- ✅ runtime ↔ pi RPC 协议真实字段
- ✅ WS 生命周期
- ✅ 文件系统真实读写
- ✅ pi 工具调用真实执行（bash/edit/read）

**约束：**
- 依赖完整 runtime + pi 环境（pi 必须用 fork 版 `taiji-pi`，见 [AGENTS.md](../../AGENTS.md)「外部项目源码」）
- CI 不稳定（pi 子进程、端口、文件系统）
- 适合**手工冒烟** + **关键链路验证脚本**（独立 `verify-<system>.cjs`,放项目根或临时位置）

### 1.3 dev 冒烟闸门（堵 MOCK 盲区的第三轨）

```
node scripts/dev-smoke.mjs（待建）→ chromium 加载 vite dev server → 0 错误即 pass
```

**设计意图**：MOCK 轨 E2E 跑构建产物（`dist/main` + `dist/preload` + `renderer/dist`），不走 vite dev server，所以测不出「dev 启动时模块加载崩溃」。dev 冒烟专门补这个缺口——起 vite dev server，用 chromium headless 加载，断言 console 0 error。

**现状**：`scripts/dev-smoke.mjs` 待建。在它落地前，**每次改完代码必须手工 `pnpm run dev` 确认能启动**（非 MOCK 轨），不能只信 E2E 全绿。

### 1.4 三轨对照表

| 轨道 | 启动方式 | 覆盖维度 | 盲区 | 适用场景 |
|------|---------|---------|------|---------|
| MOCK 轨 | `pnpm run dev:mock` / `VITE_MOCK=true` E2E | renderer 渲染 + 交互 + 状态机 + mock 流式 | 模块加载副作用 / 真实协议 / WS 生命周期 | 日常开发、E2E 回归 |
| 非 MOCK 轨 | `pnpm run dev` | 全链路（含 runtime/pi/文件系统） | 慢、环境敏感 | 手工冒烟、关键链路验证 |
| dev 冒烟 | `node scripts/dev-smoke.mjs`（待建） | 模块加载健康 | 不测交互 | CI gate、PR 检查 |

> **铁律**：MOCK 轨 E2E 全绿 ≠ 功能可用。必须配套非 MOCK 手工冒烟（或 dev 冒烟闸门）。这是 2026-06-30 事故的血泪教训。

## 2. MOCK 模式如何启动

### 2.1 手工 dev（交互调试用）

```bash
pnpm --filter @taiji/electron run dev:mock
# 等价于：
# TAIJI_MOCK=1（main 跳过 runtime spawn）
# VITE_MOCK=true（renderer 走 mock API）
# concurrently 起 vite + electron
```

启动后 Electron 窗口加载 renderer，所有 `api/domains/*` 调用被 core mock transport（`packages/core/src/transport/mock/`）拦截。fixture 数据在 `packages/core/src/transport/mock/data.ts`。

### 2.2 E2E（Playwright，自动化回归用）

E2E **不走 dev server**，走**构建产物**（见 §3）。但同样注入 MOCK 环境变量。

## 3. Playwright E2E harness 详解

### 3.1 配置文件

[`playwright.config.ts`](../../playwright.config.ts) 关键配置：

| 配置 | 值 | 原因 |
|------|-----|------|
| `testDir` | `./e2e` | spec 文件目录 |
| `testMatch` | `**/*.spec.ts` | 命名约定 |
| `fullyParallel` | `false` | Electron 多实例争抢 userData LOCK + 端口 |
| `workers` | `1` | 同上，强制串行 |
| `timeout` | `60_000` | Electron 启动 + renderer mock 初始化慢 |
| `expect.timeout` | `10_000` | mock 异步延迟（40ms+）留余量 |
| `globalSetup` | `e2e/fixtures/global-setup.ts` | 确保构建产物存在 |
| `trace` | `retain-on-failure` | 失败时保留 trace 调试 |
| `reporter` | CI=`html` / 本地=`list` | |

### 3.2 globalSetup（构建产物保障）

[`e2e/fixtures/global-setup.ts`](../../e2e/fixtures/global-setup.ts) 在所有测试前运行：

```
检查 3 个产物是否存在：
  apps/electron/dist/main/main.cjs       ← main 入口
  apps/electron/dist/preload/preload.cjs ← preload
  packages/renderer/dist/index.html ← renderer（带 VITE_E2E=true 构建）
任一缺失 → 跑 pnpm run build:e2e（180s 超时）→ 再检查
仍缺失 → throw（测试中止）
```

**含义**：首次跑 E2E 会自动构建（约 30-60s），后续增量跑直接用缓存产物。改了 renderer 代码后要重建：`pnpm run build:e2e`。

### 3.3 launch-app fixture（核心 harness）

[`e2e/fixtures/launch-app.ts`](../../e2e/fixtures/launch-app.ts) 封装 `_electron.launch`：

```typescript
import { test, expect } from './fixtures/launch-app'

test('用例名', async ({ page, electronApp }) => {
  // page 是 Electron 首窗口；每个用例独立 app 实例 + 独立临时数据目录
})
```

**注入的环境变量**（决定 mock 行为）：

| 变量 | 值 | 作用层 | 含义 |
|------|-----|--------|------|
| `VITE_MOCK` | `true` | renderer | 走 mock API（不发真实 WS） |
| `VITE_E2E` | `true` | renderer 构建期 | 注入 `e2eTestSession`（id=`e2e-files`，cwd=sample-project）到 session list |
| `TAIJI_MOCK` | `1` | main | 跳过 runtime spawn（不起 pi 子进程） |
| `TAIJI_E2E` | `1` | main | 跳过 Vite 轮询，直接 `loadFile` 构建产物 |
| `TAIJI_AGENT_DATA_DIR` | 临时目录 | 全局 | 隔离数据目录，防 Chromium LevelDB LOCK 竞争 + 不污染 dev/prod |

**关键设计点：**
- **electron 二进制解析**：装在 `apps/electron/node_modules`（workspace 隔离），用 `createRequire` 在 apps/electron 上下文解析，而非 root
- **cwd 指向 apps/electron**：让 `app.getAppPath()` 解析到含 `package.json` 的 `main` 字段的目录
- **per-test 重启**：每用例独立 app 实例（localStorage/sessionStorage 状态隔离更可靠）；启动慢但安全

### 3.4 sample-project fixture

[`e2e/fixtures/sample-project/`](../../e2e/fixtures/sample-project/) 是一个真实的小型项目（含 `src/index.ts`、`package.json`、`README.md` 等），构建期由 Vite `define` 注入绝对路径到 `e2eTestSession.cwd`。

文件树 E2E 用它作为真实文件系统样本（mock `file.tree` 返回它的结构）。其他功能 E2E 不一定用它，但 session 激活需要它存在（`e2eTestSession` 是激活 session 的固定入口）。

### 3.5 mock 数据流（E2E 看到的数据从哪来）

```
api/index.ts
  ├─ VITE_MOCK=true → 走 mock/index.ts（聚合所有 domain mock）
  │    ├─ session domain → mock/data.ts fixtureSessions（5 个固定 session：s1-s5）+ e2eTestSession（VITE_E2E 构建期注入，非 data.ts 原生）
  │    ├─ chat domain → mock/run-send-stream.ts（流式 chunk 序列）
  │    ├─ file domain → mock/file.ts（MOCK_TREE）
  │    ├─ git domain → mock/git.ts（fixtureGitStatus）
  │    └─ composer domain → mock/composer-data.ts（MENTION/FILE/SLASH 候选）
  └─ VITE_MOCK=false → 走 domains/*.ts（真实 WS → runtime）
```

**修改 fixture 数据**：直接改 `packages/core/src/transport/mock/*.ts`，重建后 E2E 生效。

## 4. 公共前置：激活 session（多数 E2E 用例的入口）

E2E 启动后 app 初始状态不确定（可能在 Landing 态 / files tab / sessions tab）。多数功能测试需要先激活一个 session。下面是**参考实现**——各功能文档（01-05）按需内联变体（如 04/05 的 `gotoFileTree` 额外切到「文件」tab），不强制引用本 helper：

```typescript
/**
 * 激活指定 session（按 label 文本匹配）并切到指定 tab。
 * @param page Playwright page
 * @param sessionLabel session 的 label 文本（如 'E2E 文件树测试'、'重构 auth 模块'）
 * @param tab '会话' | '文件'  ← SegmentedTab 文本
 */
async function activateSession(
  page: import('@playwright/test').Page,
  sessionLabel: string,
  tab: '会话' | '文件' = '会话',
): Promise<void> {
  // 1. 切到 sessions tab（按钮 name 含计数如「会话 6」，用正则前缀匹配）
  await page.getByRole('button', { name: /^会话/ }).click()
  // 2. 等 session list 渲染（mock session.list 延迟 TIMING.ack ≈ 40ms）
  await expect(page.getByText(sessionLabel)).toBeVisible({ timeout: 10_000 })
  // 3. 点 session 激活（退出 Landing 态 + 设 activeId）
  await page.getByText(sessionLabel).click()
  // 4. 切到目标 tab（如需）
  if (tab !== '会话') {
    await page.getByRole('button', { name: new RegExp(tab) }).click()
  }
}
```

**可用的 fixture session label**（s1-s5 来自 `mock/data.ts`；`e2e-files` 由 VITE_E2E 构建期注入）：

| id | label | 用途 |
|----|-------|------|
| `e2e-files` | `E2E 文件树测试` | 文件树 E2E（cwd=sample-project，构建期 Vite define 注入） |
| `s1` | `重构 auth 模块` | 含最丰富块类型（2 回合：回合1 thinking + 2 completed tool；回合2 error tool bash EBUSY + status:error）。注：fileChanges 只在流式（run-send-stream）出现，历史 fixture 无 fileChanges |
| `s2` | `Lint 排查中` | 末 assistant 含 running toolCall |
| `s3` | `API 性能优化` | 空消息（验证欢迎语） |
| `s4` | `Promise 代码评审` | 末 assistant streaming 态 |
| `s5` | `状态机重构（已废弃）` | 末 assistant interrupted 态 |

## 5. 运行命令速查

> ⚠️ cwd 敏感：bash 工具 cwd 不跨调用持久，每条命令必须带 `cd <dir> &&`。

```bash
# ── MOCK 轨：dev 交互 ──
pnpm --filter @taiji/electron run dev:mock

# ── 非 MOCK 轨：dev 交互（手工冒烟）──
pnpm dev

# ── MOCK 轨：E2E 自动化 ──
npx playwright test --project=electron           # 行为轨全量（visual/real 排除在外；裸跑不带 --project 会连 visual-chromium + electron-smoke 一起跑，smoke 用例随两个 project 各跑一遍）
npx playwright test --project=electron-smoke     # P0 smoke 子集（9 条 @p0-smoke，CI e2e-behavior job 同款命令；圈定 SSOT = playwright.config.ts grep 标签，归宿纪律见根 TEST-STRATEGY.md「e2e 资产归宿纪律」）
npx playwright test e2e/file-tree.spec.ts        # 单文件
npx playwright test --grep "E2E-1"               # 按用例名
npx playwright test --headed                     # 有头模式（看窗口）
npx playwright test --debug                      # 调试模式（step-by-step）

# ── 构建产物（E2E 前置，globalSetup 自动跑并注入 VITE_E2E/VITE_MOCK，也可手动）──
# 手动跑必须带 env 前缀：不带则 renderer define 不注入 sample-project cwd，产出非 E2E bundle 覆盖产物
VITE_E2E=true VITE_MOCK=true pnpm run build:e2e

# ── renderer 单元/集成测试（vitest）──
cd packages/renderer && npx vitest run                              # 全量
cd packages/renderer && npx vitest run src/__tests__/panel/xxx.test.ts  # 单文件

# ── runtime 单元测试（vitest）──
cd packages/runtime && npx vitest run

# ── 插件系统非 mock 端到端验收（隔离 runtime + 真实插件，~8s）──
bash scripts/verify-plugin-e2e.sh        # 也挂在 validate-runtime-bundle.sh 第 7 步
                                        # 详见 03-runtime-extensions.md

# ── typecheck ──
pnpm --filter @taiji/frontend run typecheck
cd packages/runtime && npx tsc --noEmit
```

## 6. 常见坑（E2E 专项）

### 6.1 mock 延迟导致的 flake

mock 用 `sleep(TIMING.xxx)` 模拟异步。常见延迟（`mock/index.ts` TIMING 常量）：

| 常量 | 值 | 场景 |
|------|-----|------|
| `ack` | 40ms | 通用 RPC 响应 |
| `startGap` | 60ms | message_start 前 |
| `chunk` | 70ms | 每个 text/thinking delta |
| `toolGap` | 90ms | tool_call 各阶段 |
| `fileChangesGap` | 120ms | file_changes 帧 |
| `switchCmd` | 30ms | session 激活后推 commands |

**对策**：永远用 `expect(...).toBeVisible({ timeout: N })` 等待终态，**禁止 `page.waitForTimeout(固定值)`**。一轮 mock 流式约 3-4 秒，timeout 给 10s 余量。涉及真实子进程/文件系统/跨进程等待的更完整规则（等待机制只读化 / 轮询 + deadline / teardown maxRetries）见 [TEST-STRATEGY.md「测试自身引入的 flake 防规范」](../TEST-STRATEGY.md)。

### 6.2 contenteditable 输入

Composer 是 `contenteditable` div（`role="textbox"`），**不是 textarea**。Playwright 操作：

```typescript
// ✅ 正确：用 role + textbox
await page.getByRole('textbox').click()
await page.getByRole('textbox').fill('hello')    // fill 可能不触发 input 事件
await page.getByRole('textbox').pressSequentially('hello')  // 逐字输入，触发 input

// ❌ 错误：用 selector 找 textarea
await page.fill('textarea', 'hello')  // 找不到
```

### 6.3 SegmentedTab 按钮文本带计数

侧栏 tab 按钮文本是 `会话 6`（含 session 计数）、`文件 4`（含文件计数）。用**正则前缀**匹配，不要精确匹配：

```typescript
// ✅ 正确
await page.getByRole('button', { name: /^会话/ }).click()
// ❌ 错误（计数会变）
await page.getByRole('button', { name: '会话' }).click()
```

### 6.4 命令浮层 portal 到 body

CommandPopover 用 reka-ui Popover，**portal 到 `<body>`**（脱离 composer-box 的 stacking context）。Playwright 查询不要限定在 composer 容器内：

```typescript
// ✅ 正确：浮层在 body 下，全局查
await expect(page.getByRole('button', { name: '/commit' })).toBeVisible()
// ❌ 错误：限定在 composer-box 内查不到
await page.locator('[data-testid="composer-box"]').getByRole('button', { name: '/commit' })
```

### 6.5 构建产物过期

改了 renderer 代码后，E2E 仍跑旧产物 → 测试挂或测不出新代码。重建：

```bash
pnpm run build:e2e   # 或删除 dist/ 强制 globalSetup 重建
```

### 6.6 Electron 多实例 LOCK

手动开了 dev app（`pnpm run dev`）又跑 E2E → Chromium userData LOCK 冲突。**跑 E2E 前关掉所有 taiji 窗口**。E2E fixture 用独立临时 `TAIJI_AGENT_DATA_DIR` 规避，但 dev app 用的是 `~/.taiji-dev`，两者不冲突；冲突来自同一数据目录的多个实例。

### 6.7 窗口可见性：不抢焦点但不完全隐藏

**Playwright Electron 不支持 headless**（macOS 无 xvfb）。E2E 启动的窗口**必须可见**——Playwright 需要窗口在渲染管线中才能截图/操作 DOM。

当前行为（`apps/electron/main/window/window-factory.ts`）：

| 模式 | 窗口显示方式 | 效果 |
|---|---|---|
| E2E（`TAIJI_E2E=1`） | `win.showInactive()` | 窗口渲染但**不抢焦点**——不打断用户当前工作，窗口出现在 dock 但不激活 |
| dev / prod | `win.show()` | 正常显示并抢焦点 |

**不抢焦点 ≠ 不可见**。窗口仍然出现在屏幕上（可能覆盖在用户工作区上方）。如果跑 E2E 时不希望窗口挡住屏幕：

- **macOS**：用 `showInactive` 已是不抢焦点的最佳方案。可以把窗口拖到另一个 Space / 显示器。无法完全隐藏（无 xvfb）。
- **Linux**：可用 `xvfb-run npx playwright test` 在虚拟帧缓冲中跑，窗口完全不可见。
- **CI 环境**：CI 通常无桌面，Playwright Electron 在 CI 上需要 `xvfb`（Linux）或 headless 显示（macOS CI 用 `screen` 命令推到后台 Space）。

**不修改 `skipTaskbar` / `setBounds`**：这些选项可能导致 Playwright 无法截图或操作窗口，得不偿失。`showInactive` 是当前最优解。

## 7. E2E 覆盖现状

覆盖现状以 `e2e/*.spec.ts` 为准（mock 轨 spec 全量在 `e2e/` 目录；real 轨半自动 spec 的运行方式与 bring-up 经验见 [00-overview.md](./00-overview.md)；real 轨手工测试入口见 [00-overview.md](./00-overview.md)）。

## 8. 下一步

读完本文，按功能选文档：
- 新建任务流程 → [01-chat-panel-composer.md](./01-chat-panel-composer.md)
- Composer / slash 命令 → [01-chat-panel-composer.md](./01-chat-panel-composer.md)
- 对话流 / 流式消息 → [01-chat-panel-composer.md](./01-chat-panel-composer.md)
- 文件树 → [02-panels-sidebar.md](./02-panels-sidebar.md)
- SideDrawer → [02-panels-sidebar.md](./02-panels-sidebar.md)
- 搜索浮层 → [02-panels-sidebar.md](./02-panels-sidebar.md)
- GUI 组件渲染 → [02-panels-sidebar.md](./02-panels-sidebar.md)
- real 轨手工测试 → [00-overview.md](./00-overview.md)
- real 轨 E2E 自动化 spec → [00-overview.md](./00-overview.md)
- 插件系统非 mock 端到端验收 → [03-runtime-extensions.md](./03-runtime-extensions.md)

---

# Part R-1 · real 轨手工测试（原 08-real-track-manual）


> 本文不是自动化脚本，而是**结构化测试流程文档**。每个用例包含：前置条件 → 操作步骤 → 每步期望结果 → 验证点。
> ai-agent（或人）照着步骤执行，每步对照期望结果判断 pass/fail。
>
> 为什么不用自动化脚本？real 轨依赖真实 runtime + pi + provider 配置 + 可能调 LLM，环境敏感、CI 不稳定。
> 手工执行更灵活——可以观察中间状态、调试问题、跳过环境不可用的步骤。

## 0. real 轨测试策略

### 0.1 自动化 vs 手工的分工

| 层 | 保留方式 | 理由 |
|---|---|---|
| `e2e/fixtures/launch-app-real.ts` + `waitForRuntime` | **保留代码不删** | 基础设施，未来扩展 real 用例时复用 |
| `e2e/workspace-real.spec.ts` T4.6 | **保留，标注"需前置 runtime"** | 跨进程持久化——不依赖 LLM 但依赖真实 runtime/文件系统，且手工难以模拟（需两个 app 实例 + WS 直连 + 文件落盘对比） |
| `e2e/ask-user-real.spec.ts` + `e2e/workflow-thinkinglevel-real.spec.ts` | **自动化 spec（flaky skip 容忍）** | 协议透传 + pi 产物文件断言——见 [00-overview.md](./00-overview.md)。虽然依赖 LLM 触发（flaky 时 skip），但断言表面是确定性的（协议字段 / pi 写的文件），非输出风格 |
| 其他 real 场景（RT-01~RT-08） | **走本文档手工执行** | 依赖 LLM/pi 真实执行，结果不可预测，自动化断言无法稳定 |
| real spec 扩展 | **有明确需求时再加**（参照 11 的 checklist） | 每加一个 real 用例都要维护环境依赖 + LLM 触发 flaky，需评估 ROI |

### 0.2 判断标准：什么场景值得 real 自动化？

一个 real 场景值得写自动化脚本，需同时满足：

1. **断言表面确定性**——可预测、可精确比对。**注意**：触发可以依赖 LLM（flaky 时 skip 容忍），但断言不能依赖 LLM 输出风格（如 thinkingLevel 对输出长度的影响不可断言）；断言 pi 自己写的产物文件（session JSONL entry / workflow state JSONL）是最佳表面（见 11 §6）
2. **依赖真实 runtime/文件系统/pi**——mock 轨覆盖不了
3. **手工难以模拟**——如跨进程持久化需要两个 app 实例、真实协议透传需要真 pi 调 tool

三条都满足才写自动化。否则走本文档手工执行。

### 0.3 T4.6 运行方式

```bash
# 1. 先启动真实 runtime（pnpm dev 会自动启动 runtime 子进程）
pnpm run dev &
# 等 ~/.taiji-dev/runtime.port 文件出现

# 2. 分批构建 real renderer bundle（与 mock bundle 输出冲突，不能同时构建）
#    real bundle 不传 VITE_MOCK
pnpm --filter @taiji/frontend run build  # 不带 VITE_MOCK
pnpm --filter @taiji/electron run build:main
pnpm --filter @taiji/electron run build:preload

# 3. 跑 real E2E
npx playwright test e2e/workspace-real.spec.ts

# 4. 跑完后重建 mock bundle（恢复日常 E2E 环境）
VITE_E2E=true VITE_MOCK=true pnpm --filter @taiji/frontend run build
```

> **注意**：real E2E 和 mock E2E 不能同时跑——两者的 renderer bundle 输出到同一目录（`renderer/dist`），构建期 define 冲突。必须分批构建。

## 1. 前置条件

### 1.1 环境准备

```bash
# 1. 确认 pi 二进制存在
ls apps/electron/resources/pi/pi-darwin-arm64  # macOS arm64

# 2. 确认 dev 数据目录有 provider 配置
ls ~/.taiji-dev/agent/models.json
ls ~/.taiji-dev/agent/settings.json

# 3. 确认 1420 端口没被占用（Vite dev server）
lsof -i :1420 -P | grep node  # 应无输出

# 4. 安装本地 extension（可选，测 GUI 组件渲染需要）
TAIJI_EXTENSION_PATHS="\
<path-to>/pi-ask-user:\
<path-to>/pi-goal:\
<path-to>/pi-subagent-workflow:\
<path-to>/pi-todo" \
pnpm run dev
```

### 1.2 启动 dev app

```bash
pnpm run dev
# 等待 Electron 窗口出现 + sidebar 渲染完成
# 确认 runtime 日志无错误：tail -f ~/.taiji-dev/logs/runtime-*.log
```

### 1.3 验证 app 健康

| 检查项 | 期望 | 不通过时的排查 |
|---|---|---|
| 窗口出现 | Electron 窗口显示，sidebar 可见 | runtime 启动失败 → 查日志 |
| 会话列表 | 侧栏显示已有 session（或空态） | WS 连接失败 → 查 runtime 端口 |
| 新建任务 | 点「新建任务」→ Landing 态渲染 | renderer 加载失败 → 查 console |
| composer 可输入 | 输入框可聚焦、可输入 | — |

## 2. 核心用例

### RT-01: 新建 session → 发消息 → 收到真实流式回复

**验证目标**：runtime → pi → LLM 全链路打通

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 点「新建任务」→ 选一个目录（或用已有目录） | Landing 态 → composer 可见 |
| 2 | 输入「你好，简单回复一句话」+ Enter | 消息发出，侧栏 session 显示蓝色转菊花 |
| 3 | 等待 3-30 秒 | assistant 回复开始流式出现（逐字） |
| 4 | 流式完成 | 转菊花变绿色圆点，回复内容完整 |
| 5 | 回复内容 | 是对「你好」的合理回复（非错误信息） |

**失败排查**：
- 转菊花一直蓝色不回复 → pi 没连上 LLM provider → 查 `~/.taiji-dev/agent/models.json` 配置
- 回复报错 → 查 runtime 日志 `tail -f ~/.taiji-dev/logs/runtime-*.log`
- session 卡死 → pi 子进程异常 → 查 `~/.taiji-dev/logs/pi-*.jsonl`

### RT-02: tool call 真实执行（read/bash）

**验证目标**：pi 工具调用 → runtime 事件翻译 → 前端 Block.vue 渲染

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 在 session 中输入「读一下 package.json 的内容」+ Enter | 消息发出，转菊花 |
| 2 | 等待 | 消息流出现 tool 块（read 工具，收起态） |
| 3 | 点击 tool 块 header 展开 | 显示 toolName(read) + 参数 + 输出 |
| 4 | 输出内容 | 含 `package.json` 的真实文件内容（非 mock 的「…文件内容…」） |
| 5 | assistant 回复 | 基于 package.json 内容的合理回复 |

**验证点**：tool 块的输出是**真实文件内容**（mock 轨是「…文件内容（mock）…」，real 轨是实际文件内容）。

### RT-03: extension GUI 组件渲染（需安装 extension）

**验证目标**：extension 推送 `__gui__` → 前端 GuiComponentRenderer 渲染真实组件

**前置**：用 `TAIJI_EXTENSION_PATHS` 启动 dev，安装了 pi-todo / pi-goal / pi-subagent-workflow

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 让 AI 使用 todo 工具（如「用 todo 记录 3 个任务」） | tool 块出现 |
| 2 | 展开 tool 块 | 渲染 `list-tree`（非 JSON 文本） |
| 3 | list-tree 内容 | 含 3 个 todo 项，状态图标正确（pending=dot / in_progress=circle / completed=check） |
| 4 | 让 AI 使用 goal 工具（如「设定一个目标」） | tool 块出现 |
| 5 | 展开 goal tool 块 | 渲染 `card` 嵌套 `stats-line`（非 JSON 文本） |

**验证点**：tool 块展开后是**结构化 UI 组件**（卡片/进度条/树），不是 `{"variant":"elevated","body":[...]}` 这样的 JSON 文本。如果是 JSON 文本说明 GuiComponentRenderer 路由失败或 extension 没推 `__gui__`。

### RT-04: SideDrawer widget 渲染（需安装 extension）

**验证目标**：extension 推送 `extension:widgetGui` → SideDrawer 渲染

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 让 AI 执行一个会推 widget 的操作（如 subagent workflow） | — |
| 2 | 点 PanelHeader 右侧的 drawer-toggle 按钮（PanelRight 图标） | SideDrawer 打开 |
| 3 | terminal tab | 如果 extension 推了 terminal widget，显示结构化组件或纯文本 |
| 4 | 切到 browser tab | 如果 extension 推了 browser widget，显示结构化组件 |
| 5 | 切到 git tab | 显示 git 状态（如果是 git 仓库） |

**验证点**：SideDrawer 的 widget 是**实时推送**的（extension 执行时出现），不是持久化的（session 重开后清空）。

### RT-05: session 隔离（多 session 并行）

**验证目标**：两个 session 独立运行，互不干扰

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 创建 session A，发送一条长消息（如「写一个 100 行的 Python 脚本」） | A 开始流式 |
| 2 | A 流式中，点「新建任务」创建 session B | B 的 Landing 态正常渲染（不被 A 的流式误伤） |
| 3 | B 中输入消息 + Enter | B 也开始流式 |
| 4 | 切回 A | A 的流式仍在进行（未被 B 打断） |
| 5 | 等两个都完成 | 各自的回复内容独立、正确 |

### RT-06: abort 真实中断 pi

**验证目标**：点停止按钮 → pi 子进程真实中断

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 发送一条需要长时间执行的消息（如「分析整个项目的架构」） | 流式开始 |
| 2 | 流式中点停止按钮 | 按钮消失，session 状态变回 idle |
| 3 | pi 子进程 | 不再占 CPU（`top -pid <pi_pid>` 确认） |
| 4 | 再发一条消息 | 正常回复（session 没卡死） |

### RT-07: 错误处理（provider 不可用）

**验证目标**：LLM 报错时 UI 正确处理

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 临时改 `~/.taiji-dev/agent/models.json` 为无效 API key | — |
| 2 | 发消息 | 消息流出现错误提示（不是 UI 卡死） |
| 3 | session 状态 | 转菊花消失，回到 idle 态 |
| 4 | 恢复 API key 后再发消息 | 正常回复 |
| 5 | 检查 runtime 日志 | 有错误日志记录（不是静默失败） |

### RT-08: session 重开后历史完整

**验证目标**：关掉 session 重开，对话历史完整呈现

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 在 session A 中完成一轮对话（含 thinking + tool + text） | 消息流完整 |
| 2 | 切到 session B，再切回 A | A 的历史完整（不丢失） |
| 3 | 重启 app | — |
| 4 | 打开 session A | 历史完整加载（thinking + tool + text + fileChanges） |
| 5 | tool 块展开 | tool 输出内容仍在（持久化在 session JSONL 里） |

## 3. 已知盲区（mock 轨测不到的）

以下场景**只能通过 real 轨验证**，mock 轨的盲区：

| 盲区 | 对应用例 | 说明 |
|---|---|---|
| runtime ↔ pi RPC 协议真实字段 | RT-01/02 | mock 是简化版，字段可能漂移 |
| pi 工具调用真实执行 | RT-02 | mock 的 tool output 是固定文本 |
| extension `__gui__` 真实推送 | RT-03/04 | mock 的 `__gui__` 是构造的固定数据 |
| WS 连接生命周期 | RT-05/06 | mock 不走 WS |
| 错误处理真实触发 | RT-07 | mock 不模拟 provider 报错 |
| session JSONL 持久化 | RT-08 | mock 不写文件 |
| pi 子进程 CPU/内存行为 | RT-06 | mock 不起 pi 进程 |

## 4. 执行记录模板

每次执行 real 轨测试时，复制以下模板记录结果：

```markdown
## real 轨测试执行记录

- 日期：YYYY-MM-DD
- 执行者：ai-agent / 人工
- 环境：dev / prod，pi 版本 x.x.x

| 用例 | 结果 | 备注 |
|---|---|---|
| RT-01 | ✅/❌ | |
| RT-02 | ✅/❌ | |
| RT-03 | ✅/❌ | 跳过原因：未安装 extension |
| RT-04 | ✅/❌ | |
| RT-05 | ✅/❌ | |
| RT-06 | ✅/❌ | |
| RT-07 | ✅/❌ | |
| RT-08 | ✅/❌ | |

失败用例详情：
（记录失败步骤、错误信息、截图路径）
```

---

# Part R-2 · real 轨 E2E 自动化 spec（原 11-real-e2e-specs）


> real 轨手工测试清单见 [00-overview.md](./00-overview.md)（给 ai-agent 照着执行）。
> 本文档是 real 轨的 **Playwright 自动化 spec**：真起 Electron app + 真实 runtime 子进程 + 真实 pi + 真实 LLM provider，断言真实表面（WS 广播、pi 自己写的 session JSONL、真实 DOM）。**零 mock**。

## 1. 定位（与 mock 轨的区别）

| 维度 | MOCK 轨（见 [00 总览](./00-overview.md)） | real 轨自动化（本文） |
|---|---|---|
| renderer bundle | `VITE_MOCK=true` 构建 | `VITE_MOCK` 不传（real bundle） |
| runtime / pi | 不起（`TAIJI_MOCK=1`） | 真起（main spawn runtime → runtime spawn pi） |
| LLM | mock 流式数据 | 真实 provider 调用（慢、flaky） |
| 断言表面 | mock fixture / 组件 DOM | 真实 WS 广播 / pi 产物文件 / 真实 DOM |
| 失败处理 | 确定性 | flaky skip + diag 落盘 |

**适用场景**：验证 mock 轨覆盖不到的盲区——真实协议透传（如 ask-user 的 `extension.ui_request`）、pi 子进程对 CLI 参数的真实消费（如 `--model x:thinkingLevel` 落盘 `thinking_level_change` entry）、真实 UI 交互闭环。

## 2. 现有 spec 清单

| spec | 用例 | 验证目标 | 状态 |
|---|---|---|---|
| `e2e/ask-user-real.spec.ts` | A1/A2/A3 | ask-user 协议透传（问题对象无 allowComment）+ form-overlay 真实渲染（Other 保留）+ UI 交互闭环（overlay 关闭 + pi 恢复 turn）。wire 键断言双读 `formQuestions ?? askUserQuestions`（统一表单 form 帧 / legacy 帧双形态，ui-presentation-protocol） | ✅ 3/3（需 LLM；统一表单迁移后按双读断言复跑） |
| `e2e/workflow-thinkinglevel-real.spec.ts` | TC1/TC2/TC3 | workflow agent() thinkingLevel 端到端：state 请求值 / pi 子进程 thinking_level_change / 完整跑通 | ✅ 3/3（需 LLM） |
| `e2e/workspace-real.spec.ts` | 1 | 跨进程持久化 | ✅ 1/1 |
| `e2e/skill-reload-survival.spec.ts` | S1 | 编辑项目 skill 时在飞 workflow run 存活：面板 2s 即时（G1）/ 托盘计数不变 + 无 `connection lost`/`code=143` + 引擎 CLI pid 不变（D2b）/ `[skill-reload]` 三段归因行计数吻合（D8）/ 主 session JSONL 终态 workflow-record（W17）/ session.delete 真杀无孤儿 | ✅ B5b 真机全绿（归因出 D8-a this 脱绑 runtime 崩溃，修复 44beb27cf 后复跑过） |
| `e2e/skill-reload-askuser.spec.ts` | S1b | 双 session 并发 reload 存活：全局 skill 目录变动 → dir=global 归因行列双 sid / preserved 行每 session 一条 / reload 后触发的 ask_user 反向请求送达 form-overlay 且可应答（D3 槽现读，无静默取消）；run 完成（主 session JSONL 终态 done 落盘）后 ≤30s `session.workflowUpdate` done 帧到达 spec WS（G1 必达窗口，A1 断言升级 2026-09-19）；dialog 阶段断言顺序解耦——select 后先 answerOverlay 再断言 composer（FormOverlay 与 composer 互斥，u0 复跑运行 2 的 30s 扑空假失败形态修复） | ✅ 2026-09-19 全绿：双 session 存活 / dir=global 双 sid / dialog 双送达可应答 / 终态 entry；run 完成 → ≤30s done 帧必达实测 0ms（失效链健康场景帧即时到达；水位门 + 两腿对账为丢帧形态兜底）——残留风险 #8 撤账（修复 = u1 送达水位对账 2aa709f79 + u2 finalizeRun 直落 a4fe8ad16，验证 spec = E2E-SKILLRELOAD-02/03/04） |
| `e2e/skill-reload-spawn-race.spec.ts` | S2 | 派发 run 后 <1s 编辑 skill 撞 spawn 窗口竞态：run 确定收口（workflowUpdate 广播）+ 主 session JSONL 末条 workflow-record 可读回（无状态分裂）+ 引擎执行树 ps 归零（无孤儿）；run 完成后 ≤30s `session.workflowUpdate` done 帧到达 spec WS（G1 必达窗口，A1 断言升级 2026-09-19） | ✅ 2026-09-19 全绿：reload 命中 spawn 窗口 / run 确定收口 / JSONL 终态可读回 / 无孤儿；run 完成 → ≤30s done 帧必达实测 0ms（失效链健康场景帧即时到达；水位门 + 两腿对账为丢帧形态兜底）——残留风险 #8 撤账同 S1b 行（修复 2aa709f79 + a4fe8ad16） |
| `e2e/workflow-disconnect-recovery.spec.ts` | A2 | WS 断开期间 run 完成 → 重连后收敛（传输兜底面回归，水位结构性不触发场景）：恢复来源双断言 = `session.subscribe` reply 的 stateSnapshot 携带该 run 的 done workflowUpdate last-value 回放帧 + `session.getWorkflows` 冷拉 RPC 返回终态记录；GUI 收敛（托盘 workflow 条目 data-state 回 idle ≤30s）；重连稳态无重复 done live 帧（断连空投下 publish 已完成、重连后 diff 恒空） | ✅ 2026-09-19 首跑全绿（reload-closeout-reliability u3b 执行，依赖 u1 送达水位对账已落地）：断连期间 run 完成 → 重连后 stateSnapshot 回放 done 帧 + `session.getWorkflows` 冷拉终态 + GUI 托盘 data-state=idle ≤30s 收敛 + 稳态无重复 done live 帧 |

> skill-reload 族四 spec（登记 E2E-SKILLRELOAD-01/02/03/04，见 [e2e-map.json](./e2e-map.json)）为 faux LLM 轨（L2.5）：被测对象是 reload 非破坏化机制链而非模型智能，LLM 轮次 faux 脚本化 + `TAIJI_FAUX_TPS` 长流式保持 run 在飞，零 token 确定性；共享装配与断言工具在 `e2e/fixtures/skill-reload-real-helpers.ts`（含每条断言的样本来源锚点）。preserved 归因行需 `TAIJI_AGENT_DEBUG=1`（spec 内自设）。

## 3. 运行

```bash
# 前置：real renderer bundle（与 mock bundle 输出冲突，分批 build + 跑）
# 用 global-setup 检测到 real bundle 缺失时会 build mock bundle——real spec 前必须手动确认

# 单个用例（real case 慢，建议单独跑）
npx playwright test e2e/ask-user-real.spec.ts --grep A1
npx playwright test e2e/workflow-thinkinglevel-real.spec.ts --grep TC2

# 全量（每个用例独立 launch，约 1.5-3 分钟/用例）
npx playwright test e2e/ask-user-real.spec.ts
```

**flaky 处理**：LLM 未按引导调用 tool（ask_user / workflow）→ `test.skip` + `/tmp/<tc>-diag.json` 落盘（事件流、日志尾部）。跑失败的用例重跑一次即可，属预期行为。

## 4. 通用范式（两个 spec 共用）

```
① makePresetDataDir()：临时 dataDir + pi 配置（models/settings）+ npm extension 目录 + 分支源码 symlink
② launchRealApp({dataDir}) + waitForRuntime(dataDir)  ← e2e/fixtures/launch-app-real.ts
③ WS session.create（绕过 OS dialog，cwd=sample-project）
④ 开第二 WS 监听广播（先 listen 再发 prompt，避免 broadcast 时序竞争）
⑤ WS message.send 强引导 prompt（"必须调用 xxx tool"）
⑥ 轮询目标事件（120s deadline）→ 不出现则 skip + diag
⑦ 断言真实表面（协议字段 / pi 产物文件 / DOM）
```

## 5. bring-up 关键发现（写新 spec 前必读）

以下 5 条是本仓库实测踩坑结论（2026-08-03），直接决定新 real spec 能否跑通：

### 5.1 registry 的 extension 包可能滞后于分支源码

`npm:@zhushanwen/pi-ask-user` 3.0.0 是删 comment **之前**发布的旧版（仍带 `allowComment`/`__comment`）——与分支源码同版本号但内容不同（分支未 bump）。**断言"新功能已生效"的 spec 必须让预设目录优先 symlink 分支源码**，否则验证的是旧包。

```typescript
// makePresetDataDir 内：分支源码优先（已存在跳过）
fs.symlinkSync(BRANCH_ASKUSER, path.join(zsDest, 'pi-ask-user'), 'dir')
```

> 含义：功能分支合入并发布 npm 前，real spec 测的是分支代码；发布后 registry 版更新，symlink 优先级逻辑不变（分支仍优先，行为一致）。

### 5.2 routeWebSocket 无法拦截 Electron renderer 的 WS（Playwright 限制）

实测：`page.routeWebSocket('**/*')` 全匹配 + 连接稳定后 `routedConnections === 0`——Electron renderer 的 WS 走其 net 层，不经过 Playwright 的 route。**无法捕获 renderer → runtime 的出站帧**（如 `extension.ui_response`）。

对策：需要断言"前端发出帧"时，降级为断言**可观测的副作用**：
- overlay 关闭（前端 onSubmit 成功的 UI 信号）
- pi 恢复 turn（`message.message_start` / `message.complete` 广播）
- 帧内容本身由组件层测试（`FormOverlay.test.ts` / `ScheduleForm.test.ts`）覆盖

### 5.3 mandatory npm install 与 pi spawn 存在启动竞态

runtime boot 时 `ensureMandatoryExtensions()` 对 9 个 mandatory 包执行 npm install（实测约 16s），而 `session.create` 触发的 pi spawn 可能更早。**若 session 过早创建，pi spawn 注入的 `--extension` 列表为空/不完整 → 模型说"没有 xxx tool"**。

对策：`session.create` 前必须等 extension 就绪：

```typescript
// 信号：runtime 日志最后一次 "resolved N extensions from M sources" 的 N ≥ 8
async function waitForExtensionsReady(dataDir: string, timeoutMs = 90_000, minCount = 8): Promise<number>
```

### 5.4 workflow script 的可靠发现路径是 user 级

`resource-discovery.ts` 的 project 级扫描路径是 `<workspaceRoot>/.pi/workflows/`，而 `findWorkspaceRoot(sample-project)` 因祖先目录有 `.bare`（bare+worktree workspace）会**跳转到 workspace 根**——project 级 `sample-project/.pi/workflows/` 不会被发现。

**唯一可靠路径**：user-pi 源 `<agentDir>/workflows/` = `<dataDir>/agent/workflows/`（`PI_CODING_AGENT_DIR` 指向）。makePresetDataDir 把 fixture script 复制到此。

### 5.5 `state.calls[0].sessionId`（sa- 前缀）不是 pi session id

`sa-<uuid>` 是 subagent-workflow 扩展的 ExecutionRecord id（`subagent-service.ts`），**不是** pi 的 session id（uuidv7，JSONL 首行 `session.id`）。用 sessionId 定位子进程 session 文件必然失败。

对策：定位走 `state.calls[0].sessionFile`（execution-record serialize 持久化的**绝对路径**）；缺失时 fallback 全量扫描 `dataDir` 下 `sessions/*.jsonl`（排除主 session 文件 + cwd 匹配 sample-project + mtime 最新）。

## 6. 断言真实表面的价值层级（thinkingLevel 案例）

以"验证 thinkingLevel 生效"为例，从弱到强的真实表面：

| 层级 | 断言 | 表面 | 价值 |
|---|---|---|---|
| L0 | `buildSpawnArgs` 纯函数输出 `:level` 后缀 | 单元测试 | 只证明"拼对了字符串" |
| L1 | 真实 spawn 的 args | 需日志钩子（生产改动） | 证明"args 到了 pi 进程启动点" |
| **L2** | 子进程 session JSONL 的 `thinking_level_change` entry | **pi 自己写的产物文件（零 taiji 介入）** | **证明"pi 真实收到并落盘"** |
| L3 | 真实 provider 跑完的产出 | WS done + assistant 消息 | 证明"完整链路可跑通" |

**要点**：L2 是最佳性价比——断言对象是 pi 的产物（`setThinkingLevel` → `appendThinkingLevelChange` 落盘链路），不需要任何 taiji 日志钩子。且 `:high` 后缀**只在 spawn args 存在**（session-runner 拼 args 处），pi 解析后拆成独立字段落盘——**断言必须查独立字段 `thinkingLevel:"high"`，禁止 grep `:high` 后缀**。

## 7. 编写新 real spec 的 checklist

- [ ] 前置：确认被测功能在分支源码（非 registry 旧版），makePresetDataDir symlink 分支源码
- [ ] 触发：WS 强引导 prompt + 第二 WS 监听（先 listen 再 send）+ 120s deadline + flaky skip + diag
- [ ] `session.create` 前调用 `waitForExtensionsReady`（防 mandatory install 竞态）
- [ ] UI 操作前等"连接中"横幅消失（renderer 首次连接 fallback 端口失败 + 指数退避重连，最长 ~30s）
- [ ] 需要捕获前端出站帧时：先确认 routeWebSocket 可行（Electron 下不可行，见 5.2），否则降级为可观测副作用
- [ ] 断言 pi 产物文件时：查独立字段（5.5/§6），文件定位优先绝对路径字段
- [ ] 独立 launch（每用例独立 dataDir），`finally` 里 cleanup + 清理临时目录
- [ ] 跑通后更新本文件 §2 清单
