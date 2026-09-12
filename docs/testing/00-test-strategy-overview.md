# 00 · 测试流程总览

> 本文档是测试手册的**入口篇**。理解本文的双轨制 + 公共前置后，再读各功能文档（01-05）就能直接上手。
>
> 策略依据见根 [TEST-STRATEGY.md](../../TEST-STRATEGY.md)（测试分层 SSOT）。本文档是操作落地。

## 1. 测试双轨制（核心概念）

xyz-agent 有**两条独立的测试轨道**，覆盖不同维度的 bug。缺任何一条都会漏 bug。

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
- ❌ **模块加载期副作用错误**：vite build 把 `node:` 内置模块 externalize 成惰性代理，mock 模式不触发 getter → `node:path.relative` 类错误在 mock 全绿却 dev 崩溃（[2026-06-30 事故](../../.xyz-harness/2026-06-30-e2e-retrospect/00-retrospect.md)）
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
- 依赖完整 runtime + pi 环境（pi 必须用 fork 版 `xyz-pi`，见 [AGENTS.md](../../AGENTS.md)「外部项目源码」）
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
pnpm --filter @xyz-agent/electron run dev:mock
# 等价于：
# XYZ_MOCK=1（main 跳过 runtime spawn）
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
| `XYZ_MOCK` | `1` | main | 跳过 runtime spawn（不起 pi 子进程） |
| `XYZ_E2E` | `1` | main | 跳过 Vite 轮询，直接 `loadFile` 构建产物 |
| `XYZ_AGENT_DATA_DIR` | 临时目录 | 全局 | 隔离数据目录，防 Chromium LevelDB LOCK 竞争 + 不污染 dev/prod |

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
pnpm --filter @xyz-agent/electron run dev:mock

# ── 非 MOCK 轨：dev 交互（手工冒烟）──
pnpm dev

# ── MOCK 轨：E2E 自动化 ──
npx playwright test                              # 全量
npx playwright test e2e/file-tree.spec.ts        # 单文件
npx playwright test --grep "E2E-1"               # 按用例名
npx playwright test --headed                     # 有头模式（看窗口）
npx playwright test --debug                      # 调试模式（step-by-step）

# ── 构建产物（E2E 前置，globalSetup 自动跑，也可手动）──
pnpm run build:e2e

# ── renderer 单元/集成测试（vitest）──
cd packages/renderer && npx vitest run                              # 全量
cd packages/renderer && npx vitest run src/__tests__/panel/xxx.test.ts  # 单文件

# ── runtime 单元测试（vitest）──
cd packages/runtime && npx vitest run

# ── 插件系统非 mock 端到端验收（隔离 runtime + 真实插件，~8s）──
bash scripts/verify-plugin-e2e.sh        # 也挂在 validate-runtime-bundle.sh 第 7 步
                                        # 详见 13-plugin-e2e.md

# ── typecheck ──
pnpm --filter @xyz-agent/frontend run typecheck
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

**对策**：永远用 `expect(...).toBeVisible({ timeout: N })` 等待终态，**禁止 `page.waitForTimeout(固定值)`**。一轮 mock 流式约 3-4 秒，timeout 给 10s 余量。涉及真实子进程/文件系统/跨进程等待的更完整规则（等待机制只读化 / 轮询 + deadline / teardown maxRetries）见 [TEST-STRATEGY.md「测试自身引入的 flake 防规范」](../../TEST-STRATEGY.md)。

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

手动开了 dev app（`pnpm run dev`）又跑 E2E → Chromium userData LOCK 冲突。**跑 E2E 前关掉所有 xyz-agent 窗口**。E2E fixture 用独立临时 `XYZ_AGENT_DATA_DIR` 规避，但 dev app 用的是 `~/.xyz-agent-dev`，两者不冲突；冲突来自同一数据目录的多个实例。

### 6.7 窗口可见性：不抢焦点但不完全隐藏

**Playwright Electron 不支持 headless**（macOS 无 xvfb）。E2E 启动的窗口**必须可见**——Playwright 需要窗口在渲染管线中才能截图/操作 DOM。

当前行为（`apps/electron/main/window/window-factory.ts`）：

| 模式 | 窗口显示方式 | 效果 |
|---|---|---|
| E2E（`XYZ_E2E=1`） | `win.showInactive()` | 窗口渲染但**不抢焦点**——不打断用户当前工作，窗口出现在 dock 但不激活 |
| dev / prod | `win.show()` | 正常显示并抢焦点 |

**不抢焦点 ≠ 不可见**。窗口仍然出现在屏幕上（可能覆盖在用户工作区上方）。如果跑 E2E 时不希望窗口挡住屏幕：

- **macOS**：用 `showInactive` 已是不抢焦点的最佳方案。可以把窗口拖到另一个 Space / 显示器。无法完全隐藏（无 xvfb）。
- **Linux**：可用 `xvfb-run npx playwright test` 在虚拟帧缓冲中跑，窗口完全不可见。
- **CI 环境**：CI 通常无桌面，Playwright Electron 在 CI 上需要 `xvfb`（Linux）或 headless 显示（macOS CI 用 `screen` 命令推到后台 Space）。

**不修改 `skipTaskbar` / `setBounds`**：这些选项可能导致 Playwright 无法截图或操作窗口，得不偿失。`showInactive` 是当前最优解。

## 7. E2E 覆盖现状

覆盖现状以 `e2e/*.spec.ts` 为准（mock 轨 spec 全量在 `e2e/` 目录；real 轨半自动 spec 的运行方式与 bring-up 经验见 [11-real-e2e-specs.md](./11-real-e2e-specs.md)；real 轨手工测试入口见 [08-real-track-manual.md](./08-real-track-manual.md)）。

## 8. 下一步

读完本文，按功能选文档：
- 新建任务流程 → [01-new-task.md](./01-new-task.md)
- Composer / slash 命令 → [02-composer.md](./02-composer.md)
- 对话流 / 流式消息 → [03-chat-flow.md](./03-chat-flow.md)
- 文件树 → [04-file-tree.md](./04-file-tree.md)
- SideDrawer → [05-side-drawer.md](./05-side-drawer.md)
- 搜索浮层 → [06-search-modal.md](./06-search-modal.md)
- GUI 组件渲染 → [07-gui-components.md](./07-gui-components.md)
- real 轨手工测试 → [08-real-track-manual.md](./08-real-track-manual.md)
- real 轨 E2E 自动化 spec → [11-real-e2e-specs.md](./11-real-e2e-specs.md)
- 插件系统非 mock 端到端验收 → [13-plugin-e2e.md](./13-plugin-e2e.md)
