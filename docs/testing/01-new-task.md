# 01 · 新建任务（New Task）测试流程

> 覆盖：⌘N 新建 → Landing 态（选目录 chip / 选分支 chip）→ 首发提交（延迟 create session + 发消息）
>
> 先读 [00-test-strategy-overview.md](./00-test-strategy-overview.md) 理解双轨制和公共前置。

## 1. 功能概述

「新建任务」是用户开启一个 AI coding session 的入口。核心交互：

```
用户按 ⌘N（或点新建按钮）
  → 进入 Landing 态（空 composer 卡片，顶部 directory/branch chip 行）
  → 用户选目录（点 directory chip → 弹 DirSelectPopover → 选工作区）
  → [可选] 选分支（点 branch chip → 弹 BranchSelectPopover → 切分支）
  → 输入消息 + 发送
  → 延迟 create session（首发提交时才建）+ 载入 panel + 发消息
  → 进入对话流（Landing 消失，MessageStream 出现）
```

**关键设计：统一延迟 create**。点「新建任务」**不立即 create session**，只进 Landing 空 chip 态。选目录只记 `pendingCwd`（不建 session）。首发提交（`submitFirstMessage`）才真正 create session。原因：避免用户点新建又退出留下僵尸空 session。

## 2. 组件结构概述

Landing 态由 `Panel.vue`（sessionId=null 且非 generating 时）渲染 `Landing.vue`（`data-testid="new-task-landing"`），内嵌一个 landing 变体的 `Composer.vue`。composer 的 meta-row chip 行包含 directory chip（点开 `DirSelectPopover`：工作区项 + 打开其他目录）与 branch chip（仅 git 目录显示，点开 `BranchSelectPopover`：分支项 + 新建分支，含 `CreateBranchModal`）。历史加载失败时 Landing 另有 `retry-history` 按钮。Landing 态 composer 内嵌于 Landing，Panel 自身的 composer 不重复渲染。

组件源码：`packages/renderer/src/components/new-task/Landing.vue`、`packages/ui/src/features/new-task/`（DirSelectPopover / BranchSelectPopover / CreateBranchModal）、`packages/renderer/src/components/panel/Composer.vue`。

## 3. data-testid 清单

testid 以组件 template 内 `data-testid` / `test-id` 属性为准（下表为已核实有效的锚点）。

| testid | 所在组件 | 触发/可见条件 |
|--------|---------|--------------|
| `new-task-landing` | Landing.vue | Landing 态恒显 |
| `chip-directory` | Landing.vue | Landing 态恒显（directory chip 行） |
| `chip-branch` | Landing.vue | 仅 git 目录（`gitInfo != null`）显示 |
| `retry-history` | Landing.vue | 仅 `historyError=true`（getHistory 失败）时显示 |
| `dir-select-popover` | DirSelectPopover.vue | 点 directory chip 后弹出 |
| `workspace-item` | DirSelectPopover.vue | popover 内每个工作区项 |
| `action-open-dir` | DirSelectPopover.vue | 「打开其他目录」（触发 OS dialog） |
| `branch-select-popover` | BranchSelectPopover.vue | 点 branch chip 后弹出 |
| `branch-item` | BranchSelectPopover.vue | popover 内每个分支项 |
| `action-create-branch` | BranchSelectPopover.vue | 「新建分支」 |
| `branch-name-error` | CreateBranchModal.vue | 新建分支名校验错误 |
| `submit-btn` | CreateBranchModal.vue | 新建分支提交按钮 |
| `composer-box` | Composer.vue | composer 容器（Landing + Panel 态都有） |

## 4. 状态机（useNewTaskFlow）

`composables/features/new-task/useNewTaskFlow.ts`，状态枚举：

```
'idle' | 'landing' | 'dir-popover' | 'branch-popover' | 'dir-dialog' | 'branch-modal' | 'completed' | 'cancelled'
```

状态转换图（transitions）：

```
idle ──startFlow──→ landing ──openDirPopover──→ dir-popover ──openDirDialog──→ dir-dialog
                       │                              │                           │
                       │                              ├──selectWorkspace──→ landing（记 pendingCwd）
                       │                              ├──cancel──→ landing
                       │                              └──openDirDialog cancel──→ dir-popover→landing
                       │
                       ├──openBranchPopover──→ branch-popover ──openBranchModal──→ branch-modal
                       │                              │                           │
                       │                              ├──selectBranch──→ landing
                       │                              └──confirmDirtySwitch──→ landing
                       │
                       ├──submitFirstMessage──→ completed（终态：create session + 发消息）
                       └──cancel──→ cancelled ──reenterFlow──→ landing

completed ──startFlow──→ idle ──→ landing（AC-3.12：终态再触发先销毁重建）
```

**关键状态字段**：
- `state: Ref<NewTaskFlowState>` — 当前状态（初始 `idle`）
- `currentSession: Ref<SessionSummary | null>` — 当前 flow 绑定的 session（landing 态恒 null，首发提交才绑定）
- `pendingCwd: Ref<string | null>` — landing 选定但未 create 的 cwd（选目录只记值不建 session）
- `createInFlight: Ref<boolean>` — create 进行中（防双击并发）

## 5. MOCK 模式测试

### 5.1 启动 MOCK dev

```bash
pnpm --filter @xyz-agent/electron run dev:mock
```

启动后 app 默认进入 Landing 态（无活跃 session）。可手工测试完整流程。

### 5.2 集成测试（vitest，已有）

现有测试覆盖（renderer 集成层，mount 组件 + 断言 store）：

| 测试文件 | 覆盖用例 |
|---------|---------|
| [`__tests__/new-task/flow-integration.test.ts`](../../packages/renderer/src/__tests__/new-task/flow-integration.test.ts) | T1.1 startFlow 不 create / T3.1-T3.5 选目录链路 / submitFirstMessage 全链路 / sessionStore 同步 |
| [`__tests__/new-task/landing-precreate-session.test.ts`](../../packages/renderer/src/__tests__/new-task/landing-precreate-session.test.ts) | U4/U4b/U4c 选目录延迟 create / U5 首发提交才 create |

**运行**：
```bash
cd packages/renderer && npx vitest run src/__tests__/new-task/
```

**这些测试验证了什么**（构建者视角，白盒）：
- `startFlow()` 后 `state.value === 'landing'`，`currentSessionId.value === null`（延迟 create）
- `selectWorkspace(cwd)` 只更新 `pendingCwd`，不调 `sessionApi.create`
- `submitFirstMessage(text)` 调用链：`sessionApi.create(cwd)` → `session.appendSession` → `session.activeId =` → `panel.loadSession` → `chat.send` → `transition('completed')`
- 双击并发守卫：`createInFlight` 防止 create 调两次

### 5.3 集成测试如何 mock

```typescript
// 典型 mock 模式（flow-integration.test.ts）
vi.mock('@/api', () => ({
  session: {
    create: vi.fn().mockResolvedValue({ id: 'sess-1', cwd: '/foo', label: '...' }),
    list: vi.fn().mockResolvedValue([]),
    getCommands: vi.fn().mockResolvedValue({ sessionId: 'sess-1', commands: [] }),
    // ... 其他用到的
  },
  chat: { send: vi.fn().mockResolvedValue(undefined), streamSubscribe: vi.fn() },
  // composer 也要 mock（CommandPopover onMounted 调 getMentionCandidates）
  composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
}))
```

> **坑**：`vi.mock('@/api')` 必须 mock 所有被 mount 组件树用到的方法。漏 mock 会导致 `CommandPopover.onMounted` 调 `composer.getMentionCandidates()` → undefined → 未捕获 rejection。

## 6. 非 MOCK 模式测试

```bash
pnpm dev
```

**手工冒烟清单**（每项必做，MOCK 测不出真实 create）：

| 步骤 | 操作 | 期望 |
|------|------|------|
| 1 | 启动 app，按 ⌘N | 进入 Landing 态，显示 directory chip「选择目录」+ composer 输入区 |
| 2 | 点 directory chip | 弹出 DirSelectPopover，列出工作区 |
| 3 | 选一个真实 git 工作区 | popover 关闭，chip 显示目录名，branch chip 出现（git 目录） |
| 4 | 点 branch chip | 弹出 BranchSelectPopover，列出本地分支 |
| 5 | 输入消息，按 ⏎ | session 创建（runtime 日志可见），进入对话流，消息发出 |
| 6 | 检查 `~/.xyz-agent-dev/sessions/` | 新 session 文件出现（pi 延迟写入：首个 assistant 到达后才 flush，见 AGENTS.md 规则#6） |

**关键验证点**（MOCK 测不出）：
- `sessionApi.create(cwd)` 真实调 runtime → pi 创建 session 子进程
- pi session 文件延迟写入（首 assistant 前文件可能不存在）
- 非 git 目录时 branch chip 隐藏（`gitInfo == null`）

## 7. Playwright E2E 测试

### 7.1 测试场景

| 场景 | testid 锚点 | 期望 |
|------|------------|------|
| E2E-NT-1：首屏 Landing 渲染 | `new-task-landing` / `composer-box` / `chip-directory` | 三个元素 DOM 存在 |
| E2E-NT-2：点 directory chip 弹出选目录浮层 | `dir-select-popover` / `workspace-item` | popover 可见，含工作区项 |
| E2E-NT-3：选目录后 chip 回灌 | `chip-directory` 含目录名文本 | 文本从「选择目录」变为目录名 |
| E2E-NT-4：首发提交进入对话流 | `new-task-landing` 消失，MessageStream 出现 | Landing 不再可见，对话流可见 |

### 7.2 完整 E2E 示例代码

> 注意：以下代码是**范例模板**，尚未落地为 e2e/new-task.spec.ts（当前已有 composer/file-tree/search-modal 等 spec）。落地时按此模板实现。

```typescript
import { test, expect } from './fixtures/launch-app'

test.describe('新建任务 E2E', () => {
  test('E2E-NT-1: 首屏 Landing 态渲染（composer 输入区 + chip 行）', async ({ page }) => {
    // app 启动后默认 Landing 态（无活跃 session）。
    // 注意：initApp 会用最近活跃 session 的 cwd 预填 chip（useSidebar「initApp 用最近
    // session 目录预填」）。E2E 下 e2eTestSession.lastActiveAt=Date.now()（data.ts，是
    // 最新），其 cwd 是 sample-project → chip 预填「sample-project」，
    // **不是**空态「选择目录」。空态只在真正首次启动（无任何历史 session）时出现。
    await expect(page.getByTestId('new-task-landing')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('composer-box')).toBeVisible()
    await expect(page.getByTestId('chip-directory')).toBeVisible()
    // chip 预填了最近 session 的 cwd（sample-project 末段目录名）
    await expect(page.getByTestId('chip-directory')).toContainText('sample-project')
  })

  test('E2E-NT-2: 点 directory chip → 弹出选目录浮层', async ({ page }) => {
    await expect(page.getByTestId('chip-directory')).toBeVisible({ timeout: 10_000 })
    // 点 directory chip 打开 DirSelectPopover
    await page.getByTestId('chip-directory').click()
    // popover 可见（reka-ui Popover portal 到 body，全局查）
    await expect(page.getByTestId('dir-select-popover')).toBeVisible({ timeout: 5_000 })
    // 至少有一个工作区项（mock data.ts fixtureSessions 提供）
    await expect(page.getByTestId('workspace-item').first()).toBeVisible()
  })

  test('E2E-NT-3: 选目录 → chip 回灌目录名', async ({ page }) => {
    // 注意：app 启动时 chip 已被 initApp 预填（e2eTestSession 的 cwd=sample-project，
    // 见 NT-1）。recentWorkspaces 首项也是 sample-project（lastActiveAt=Date.now 最新）。
    // 若点 .first()（sample-project），与预填 cwd 相同 → selectWorkspace 走 noop 分支
    //（useNewTaskFlow：cwd===currentCwd 仅关 popover 不改 chip）→ 测不出回灌。
    // 故点 .nth(1)（第 2 个，fixtureSessions 去 cwd 重后 = xyz-agent，s1/s2/s5 的 cwd
    // /Users/zhushanwen/Code/xyz-agent 末段）。
    await page.getByTestId('chip-directory').click()
    await expect(page.getByTestId('dir-select-popover')).toBeVisible({ timeout: 5_000 })
    // 点第 2 个工作区（非预填的 sample-project）
    await page.getByTestId('workspace-item').nth(1).click()
    // popover 关闭
    await expect(page.getByTestId('dir-select-popover')).toHaveCount(0)
    // chip 回灌所选工作区末段目录名（xyz-agent），正向断言（非永真的反向断言）
    await expect(page.getByTestId('chip-directory')).toContainText('xyz-agent')
  })

  test('E2E-NT-4: 首发提交 → 离开 Landing 进入对话流', async ({ page }) => {
    // 前置：先选目录（让 create 用真实 cwd）
    await page.getByTestId('chip-directory').click()
    await page.getByTestId('workspace-item').first().click()
    // 输入消息（contenteditable，用 pressSequentially 触发 input）
    await page.getByRole('textbox').click()
    await page.getByRole('textbox').pressSequentially('帮我写个 hello world')
    // 点发送按钮（title="发送 · ⏎"）
    await page.getByTitle('发送 · ⏎').click()
    // Landing 消失（state → completed）—— 首发成功的可靠信号
    await expect(page.getByTestId('new-task-landing')).toHaveCount(0, { timeout: 10_000 })
    // composer 仍在（Panel 态 variant，证明已进入对话流，非 Landing 内嵌）
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
    // 注意：不直接用 getByText('帮我写个 hello world') 断言 user 气泡 ——
    // mock 回复会回显 user 输入（run-send-stream 的 reply 形如「已处理："${text}"...」），
    // 导致该文本同时出现在 user 气泡 + assistant 回复，getByText 严格模式会因多匹配报错。
    // 改用 panel composer 可见 + Landing 消失作为「进入对话流」的复合信号。
  })
})
```

### 7.3 每步期望输入输出（E2E-NT-4 首发）

| 步骤 | 输入（用户操作） | 输出（DOM 变化 / mock 调用） |
|------|----------------|---------------------------|
| 1. 选目录 | 点 `workspace-item` | `selectWorkspace(cwd)` → `pendingCwd = cwd`；chip 文本变目录名 |
| 2. 输入消息 | `pressSequentially('...')` | `ComposerInput` input 事件 → `draft = '...'`；发送按钮 enable |
| 3. 点发送 | 点 `title="发送 · ⏎"` | `onSend()` → `submitFirstMessage(draft)` |
| 4. create session | （内部） | mock `session.create(cwd)` → sleep(40ms) → resolve SessionSummary |
| 5. 载入 panel | （内部） | `session.activeId = id`；`panel.loadSession`；`navigation.push` |
| 6. 发消息 | （内部） | `chat.send(text)` → mock `runSendStream` fire-and-forget |
| 7. 状态流转 | （内部） | `transition('completed')` → Landing `v-if` false → 消失 |
| 8. 对话流渲染 | （DOM） | MessageStream 出现，user 气泡可见，mock 流式开始（thinking→tool→text） |

## 8. 覆盖缺口（漏测 backlog）

当前 E2E（E2E-NT-1~4）覆盖主路径。以下场景待补：

| 缺口 | 场景 | 测试方式 | 优先级 |
|------|------|---------|--------|
| 选目录后取消 | 点 directory chip → ESC 关 popover → cwd 不变 | E2E（popover 关闭断言） | 中 |
| OS dialog 路径 | `action-open-dir` → Electron `dialog.showOpenDialog` | `[需手工]`（OS 原生 dialog 无法自动化） | 中 |
| 并发守卫 | 双击发送按钮 → `createInFlight` 防 create 调两次 | 集成测试（flow-integration.test.ts 已覆盖），E2E 难模拟快速双击 | 低 |
| 非 git 目录 branch chip 隐藏 | 选非 git 目录 → `chip-branch` 不渲染 | E2E（需 fixture 非 git 工作区） | 中 |
| create 失败恢复 | `session.create` reject → 草稿恢复 + state 留 landing | 集成测试（flow-integration.test.ts E2/E3 已覆盖），mock 不模拟失败 | 低 |
| 重试历史 | `historyError=true` → `retry-history` 按钮可见 + 点击重试 | E2E（需触发 getHistory 失败，mock 难造） | 低 |

## 9. 约束与盲区

| 约束 | 说明 |
|------|------|
| ⚠️ OS 原生 dialog 无法自动化 | 「打开其他目录」（`action-open-dir`）触发 Electron `dialog.showOpenDialog`，Playwright 无法交互系统对话框。E2E 测「选已有工作区」路径，`action-open-dir` 路径标 `[需手工]` |
| ⚠️ mock 不模拟 create 失败 | mock `session.create` 恒成功。失败路径（E2/E3 create reject）只能集成测试验证（flow-integration.test.ts 有覆盖） |
| ⚠️ branch chip 仅 git 目录 | 非 git 目录 `gitInfo == null` → branch chip 隐藏。mock fixture session 的 cwd 需是 git 仓库才能测 branch chip |
| ❌ dev 冒烟盲区 | Landing 态渲染依赖 `useNewTaskFlow` + `useChat` + 多个 store，模块加载错误（node:path 类）mock 测不出。必须 `pnpm run dev` 手工冒烟 |

## 10. 相关文档

- 组件 spec：[docs/page-design/archive/v3/flow-2-code-review/](../page-design/archive/v3/flow-2-code-review/)（如有）
- 状态机源码：[`composables/features/new-task/useNewTaskFlow.ts`](../../packages/renderer/src/composables/features/new-task/useNewTaskFlow.ts)
- 集成测试：[`__tests__/new-task/`](../../packages/renderer/src/__tests__/new-task/)
- composer 子组件测试：[02-composer.md](./02-composer.md)
