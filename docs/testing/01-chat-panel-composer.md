# 01 · 对话主链测试手册（新建任务 / Composer / 对话流）

> 合并自 01-new-task.md + 02-composer.md + 03-chat-flow.md（2026-09 手册并册，原文 git 历史可查）。
>
> 公共前置（双轨制 / Playwright harness / activateSession / E2E 常见坑）见 [00-overview.md](./00-overview.md)。

---


> 覆盖：⌘N 新建 → Landing 态（选目录 chip / 选分支 chip）→ 首发提交（延迟 create session + 发消息）
>
> 先读 [00-overview.md](./00-overview.md) 理解双轨制和公共前置。

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
- composer 子组件测试：[01-chat-panel-composer.md](./01-chat-panel-composer.md)

---


> 覆盖：消息输入框（contenteditable）、slash 命令浮层（@ 引用 / # 文件 / / 命令）、发送三态（send/streaming-stop/sending-spinner）、steer/followUp
>
> 先读 [00-overview.md](./00-overview.md) 理解双轨制和公共前置。

## 1. 功能概述

Composer 是消息输入核心组件，有两种 variant：
- `variant="landing"`：Landing 态内嵌（720px 居中卡片，顶部 chip 行）
- `variant="panel"`：对话流下方常态 composer

核心交互：
```
用户输入文本 → draft 更新 → 发送按钮 enable
用户输入 / → 触发 slash 浮层（CommandPopover）→ 实时过滤命令 → 选中插入 slash chip
用户输入 @ / # → 触发 mention/file 浮层 → 选中插入 mention chip
用户按 ⏎ → 发送（landing 走 submitFirstMessage，panel 走 chat.send）
流式中（isStreaming）→ composer 蓝呼吸 ring + ⏎ 变 steer + 发送位变 stop 按钮
```

## 2. 组件结构概述

`Composer.vue`（`data-testid="composer-box"`，variant=landing|panel）是容器，内部组合：RetryIndicator / QueueBubble（排队与重试指示）、`CommandPopover`（slash/mention/file 浮层，portal 到 body）、ContextChipsBar（已附上下文 chip 行）、`ComposerInput`（contenteditable 输入区，位于 `packages/ui/src/features/composer/`，内含插入的 slash chip 与 mention chip）、工具条（AddMenuPopover / ContextCapacityPopover / ModelSelectPopover / ThinkingLevelPopover）。landing 态还有 meta-row chip 行（见 [01-chat-panel-composer.md](./01-chat-panel-composer.md)）。

发送位三态：流式中（isStreaming）显示 stop 按钮（title="停止"）；压缩中/发送中显示 spinner；否则显示 send 按钮（title="发送 · ⏎" / "输入内容后发送"）。

## 3. data-testid 清单

testid 以组件 template 内 data-testid 属性为准。

| testid | 触发/可见条件 |
|--------|--------------|
| `composer-box` | 恒显（composer 容器） |

**CommandPopover / ComposerInput 目前没有 data-testid**。E2E 查询靠：
- 命令项：`page.getByRole('button', { name: '/commit' })`（命令名作 button text）
- 输入区：`page.getByRole('textbox')`（contenteditable div 的 ARIA role）
- 发送按钮：`page.getByTitle('发送 · ⏎')` / `page.getByTitle('停止')`

> **改进建议**（非本次范围）：给 CommandPopover 列表项加 `data-testid="cmd-item-{name}"`，给 ComposerInput 加 `data-testid="composer-input"`，提升 E2E 稳定性。

## 4. slash 命令浮层（CommandPopover）数据流

### 4.1 三种命令源（type prop）

| type | 数据源 | 触发方式 |
|------|--------|---------|
| `slash` | session 态：`commandStore.getCommands(sessionId)`（runtime `session.commands` 推送）；landing 态：`settingsStore.skills`（全局 skill 扫描） | 输入 `/` 或 +菜单选「命令」 |
| `mention` | `composer.getMentionCandidates()`（mock: `MENTION_CANDIDATES`） | 输入 `@` 或 +菜单选「引用」 |
| `file` | `composer.getFileCandidates()`（mock: `FILE_CANDIDATES`） | 输入 `#` 或 +菜单选「文件」 |

### 4.2 slash 命令获取时机（双源切换）

```typescript
// CommandPopover.vue（slash 命令双源切换）
const slashCommands = computed(() => {
  if (props.sessionId) return commandStore.getCommands(props.sessionId)  // session 态：runtime 推送
  return settingsStore.skills.map(s => ({                                 // landing 态：全局 skill
    id: s.name, name: `/${s.name}`, kind: 'skill', icon: 'star', description: s.description,
  }))
})

// 订阅 session.commands（session 态才订，landing 不订）
onMounted(() => subscribeCommands(props.sessionId))
watch(() => props.sessionId, (sid) => subscribeCommands(sid))  // 切 session 重订
```

**关键时序约束**（[HISTORICAL]，见 AGENTS.md「Runtime broadcast 时序竞争」）：
- runtime `session.commands` broadcast 可能早于 renderer 订阅 → 消息丢失
- **对策**：切换/创建 session 后，`useSidebar.selectSession` / `useNewTaskFlow.precreateSessionAndLoadCommands` 主动调 `session.getCommands` RPC + `events.dispatchSession` 本地投递，不依赖 broadcast

### 4.3 slash 触发逻辑（ComposerInput）

`ComposerInput` 监听 input 事件，判断是否触发 slash 浮层：
- 输入 `/` 且在最左 + 无已有 slash chip → emit `slash-trigger { query: '' }`
- 继续输入 `/commit` → emit `slash-trigger { query: 'commit' }`（实时过滤）
- 已有 slash chip / 非 `/` 开头（如 `foo/`）→ emit `slash-trigger null`（关闭浮层）

Composer 收到后：
```typescript
// Composer.vue onSlashTrigger
if (payload) {
  slashTriggerActive = true
  slashQuery = payload.query
  cmdType = 'slash'
  cmdOpen = true              // 打开 CommandPopover
} else if (slashTriggerActive) {
  cmdOpen = false             // 仅输入区触发路径关闭；+菜单路径不关
}
```

### 4.4 选中命令 → 插入 chip

```typescript
// CommandPopover onSelect → emit select → Composer onCmdSelect
function onCmdSelect(payload: { type, name, icon?, description? }) {
  cmdOpen = false
  slashTriggerActive = false
  inputRef.value?.focus()
  if (payload.type === 'slash') {
    inputRef.value?.clearSlashQueryText()           // 清掉 /query 过滤文本
    inputRef.value?.insertSlashChip(payload.name, payload.icon)  // 插 / 命令 chip
  } else {
    inputRef.value?.insertMentionChip(payload.type === 'mention' ? '@' : '#', payload.name)
  }
}
```

## 5. mock 数据

[`transport/mock/composer-data.ts`](../../packages/core/src/transport/mock/composer-data.ts) + [`transport/mock/index.ts`](../../packages/core/src/transport/mock/index.ts)：

| 数据 | 内容 |
|------|------|
| `MENTION_CANDIDATES` | @ 引用候选（id/name/kind/icon） |
| `FILE_CANDIDATES` | # 文件候选 |
| `MOCK_SLASH_COMMANDS`（composer-data.ts） | / 命令静态数据（/commit /review /fix，**3 个**，kind: 提交/审查/修复） |
| `MOCK_COMMANDS`（mock/index.ts） | session.commands 推送用（/commit /review /fix /compact，**4 个**，含 builtin /compact；与 MOCK_SLASH_COMMANDS **不同源**——多了 /compact 且字段名不同 source vs kind） |

**session 激活后推送**（`pushSessionState`，mock/index.ts）：
```typescript
// switchSession 后 30ms（TIMING.switchCmd）推 session.commands
pushSession(sessionId, {
  type: 'session.commands',
  payload: { sessionId, commands: MOCK_COMMANDS },
})
```

## 6. MOCK 模式测试

### 6.1 集成测试（vitest，已有）

[`__tests__/panel/composer-slash-trigger.test.ts`](../../packages/renderer/src/__tests__/panel/composer-slash-trigger.test.ts) 覆盖：

| 用例组 | 覆盖 |
|--------|------|
| **U1-U5** ComposerInput slash-trigger | U1 输入`/`→emit {query:""} / U2 输入`/commit`→emit {query:"commit"} / U3 已有 chip→emit null / U4 非`/`开头→null / U5 清空→null |
| **U6-U8** CommandPopover 过滤 | U6 query="comm"→仅 /commit / U7 query=""→全部 4 项 / U8 query="zzz"→0 项不渲染 / U8b ArrowDown 幂等 |
| **U9-U10** Composer wiring | U9 ComposerInput emit→CommandPopover 收到 open/type/query / U10 +菜单路径不被 slash-trigger:null 误关 |

**运行**：
```bash
cd packages/renderer && npx vitest run src/__tests__/panel/composer-slash-trigger.test.ts
```

### 6.2 集成测试如何 mock

```typescript
// composer-slash-trigger.test.ts mock 模式
vi.mock('@/api', () => ({
  composer: {
    getMentionCandidates: vi.fn().mockResolvedValue([]),
    getFileCandidates: vi.fn().mockResolvedValue([]),
  },
  // ... 其他用到的
}))
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ send: vi.fn(), steer: vi.fn(), followUp: vi.fn(), abort: vi.fn(), compact: vi.fn() }),
}))
```

**mount 策略**：
- U1-U5：mount `ComposerInput` 单组件，断言 `wrapper.emitted('slash-trigger')`
- U6-U8：mount `CommandPopover`，传 `type='slash'` + `query`，断言命令项渲染
- U9-U10：mount `Composer`（含 ComposerInput + CommandPopover stub），断言 wiring

## 7. 非 MOCK 模式测试

```bash
pnpm dev
```

**手工冒烟清单**：

| 步骤 | 操作 | 期望 |
|------|------|------|
| 1 | 激活一个真实 session，点 composer 输入 `/` | slash 浮层弹出，列出 pi 真实命令（builtin + extension + skill） |
| 2 | 继续输入 `com` | 浮层过滤到 `/commit`（若存在） |
| 3 | 按 ⏎ 选中 | chip 插入，浮层关闭，输入区焦点恢复 |
| 4 | 输入 `@` | mention 浮层弹出（真实 agent/mention 候选） |
| 5 | 输入 `#` | file 浮层弹出（真实文件候选） |
| 6 | 输入文本，按 ⏎ | 消息发送，进入流式（composer 蓝呼吸 ring） |
| 7 | 流式中输入追加文本，按 ⏎ | steer 追加（不打断当前回合） |
| 8 | 流式中点 stop 按钮 | abort（pi 中断，DEFERRED） |

**关键验证点**（MOCK 测不出）：
- pi 真实 `get_commands` 返回的命令列表（builtin 7 个 + extension + skill）
- `session.commands` broadcast 时序（是否丢消息）
- steer 真实追加到 pi 当前回合
- abort 真实中断 pi

## 8. Playwright E2E 测试

### 8.1 前置：激活 session

slash 命令浮层在 session 态用 `commandStore`（runtime 推送），landing 态用 `settingsStore.skills`。**测 slash 命令浮层需先激活 session**（让 commandStore 有数据）：

```typescript
import { test, expect } from './fixtures/launch-app'

// 激活 session 并等待 commands 推送完成
async function activateSessionForComposer(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /^会话/ }).click()
  await expect(page.getByText('重构 auth 模块')).toBeVisible({ timeout: 10_000 })
  await page.getByText('重构 auth 模块').click()
  // 等 session.commands 推送（mock TIMING.switchCmd = 30ms）+ commandStore 写入
  // 激活后 composer 在对话流下方（panel variant）
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
}
```

### 8.2 测试场景

| 场景 | 锚点 | 期望 |
|------|------|------|
| E2E-C-1：composer 渲染 | `composer-box` / `role=textbox` | 输入区可见可聚焦 |
| E2E-C-2：输入 `/` 弹 slash 浮层 | 命令 button（如 `/commit`） | 浮层可见，含 mock 命令 |
| E2E-C-3：过滤 `com` | 仅 `/commit` 可见 | 其他命令隐藏 |
| E2E-C-4：选中插入 chip | 输入区含 chip 文本 | `/commit` chip 出现在输入区 |
| E2E-C-5：发送消息 | 对话流出现 user 气泡 | 文本可见 |
| E2E-C-6：流式中 stop 按钮 | `title="停止"` | 流式时发送位变 stop |

### 8.3 完整 E2E 示例代码

> 注意：以下代码是**范例模板**（`e2e/composer.spec.ts` 已落地，以该 spec 实际内容为准）。落地时按此模板实现。

```typescript
import { test, expect } from './fixtures/launch-app'

test.describe('Composer E2E', () => {
  test('E2E-C-1: composer 渲染（输入区可见可聚焦）', async ({ page }) => {
    // 激活 session（panel variant composer 出现）
    await page.getByRole('button', { name: /^会话/ }).click()
    await expect(page.getByText('重构 auth 模块')).toBeVisible({ timeout: 10_000 })
    await page.getByText('重构 auth 模块').click()
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
    // 输入区可聚焦（contenteditable，role=textbox）
    await page.getByRole('textbox').click()
    await expect(page.getByRole('textbox')).toBeFocused()
  })

  test('E2E-C-2: 输入 / → 弹 slash 命令浮层', async ({ page }) => {
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('重构 auth 模块').click()
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
    // 输入 /（pressSequentially 触发 input 事件，fill 可能不触发）
    await page.getByRole('textbox').click()
    await page.getByRole('textbox').pressSequentially('/')
    // slash 浮层弹出（portal 到 body，全局查命令 button）
    // mock 推送 MOCK_COMMANDS: /commit /review /fix /compact
    await expect(page.getByRole('button', { name: /\/commit/ })).toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole('button', { name: /\/review/ })).toBeVisible()
  })

  test('E2E-C-3: 输入 /com → 过滤到 /commit', async ({ page }) => {
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('重构 auth 模块').click()
    await page.getByRole('textbox').click()
    await page.getByRole('textbox').pressSequentially('/com')
    // 仅 /commit 可见
    await expect(page.getByRole('button', { name: /\/commit/ })).toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole('button', { name: /\/review/ })).toHaveCount(0)
  })

  test('E2E-C-4: 选中 /commit → 插入 chip', async ({ page }) => {
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('重构 auth 模块').click()
    await page.getByRole('textbox').click()
    await page.getByRole('textbox').pressSequentially('/com')
    // 点 /commit 命令项
    await page.getByRole('button', { name: /\/commit/ }).click()
    // 浮层关闭
    await expect(page.getByRole('button', { name: /\/commit/ })).toHaveCount(0)
    // 输入区含 /commit chip（chip 是 span，文本含 /commit）
    await expect(page.getByRole('textbox')).toContainText('/commit')
  })

  test('E2E-C-5: 输入消息 + ⏎ → 发送', async ({ page }) => {
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('API 性能优化').click()  // s3 空消息 session
    await page.getByRole('textbox').click()
    await page.getByRole('textbox').pressSequentially('测试消息 e2e')
    // 按 ⏎ 发送（或点发送按钮）
    await page.getByRole('textbox').press('Enter')
    // 发送成功的可靠信号：mock 流式完成后的收尾 summary（约 3-4 秒）。
    // 注意：不直接用 getByText('测试消息 e2e') 断言 user 气泡 ——
    // mock 回复回显 user 输入（run-send-stream 的 '已处理："${text}"...' 形态），
    // 该文本同时出现在 user 气泡 + assistant 回复，getByText 严格模式会因多匹配报错。
    // 收尾 summary 是 mock 固定 CANNED_REPLY，单匹配稳定。
    await expect(page.getByText(/好的，我来处理这个请求/)).toBeVisible({ timeout: 15_000 })
  })
})
```

### 8.4 每步期望输入输出（E2E-C-2 slash 浮层）

| 步骤 | 输入 | 输出 |
|------|------|------|
| 1. 激活 session | 点 session 文本 | `switchSession(sid)` → mock 推 `session.commands`（30ms 后） |
| 2. 等 commands | （等待） | `commandStore.applyCommands(sid, MOCK_COMMANDS)` |
| 3. 聚焦输入区 | 点 `role=textbox` | contenteditable 获焦 |
| 4. 输入 `/` | `pressSequentially('/')` | `ComposerInput` 检测 `/` 在最左 + 无 chip → emit `slash-trigger {query:''}` |
| 5. Composer 收到 | （内部） | `cmdType='slash'` + `cmdOpen=true` |
| 6. CommandPopover 渲染 | （DOM） | Popover portal 到 body，渲染命令 button × 4（/commit /review /fix /compact） |
| 7. 断言 | （验证） | `getByRole('button', { name: /\/commit/ })` 可见 |

## 9. 覆盖缺口（漏测 backlog）

当前 E2E（E2E-C-1~5）覆盖 slash 浮层 + 发送主路径。以下场景待补：

| 缺口 | 场景 | 测试方式 | 优先级 |
|------|------|---------|--------|
| steer/followUp | 流式中输入 + ⏎ 追加 steer / Alt+⏎ 追加 followUp | E2E（需先发消息等 isStreaming，再输入追加） | 高 |
| stop 按钮 | 流式中点 stop → abort | E2E（title="停止"），但 mock abort 不真实中断 pi | 中 |
| mention(@) 浮层 | 输入 @ → mention 浮层 + 选中插 chip | E2E（`MENTION_CANDIDATES` mock 有数据） | 中 |
| file(#) 浮层 | 输入 # → file 浮层 + 选中插 chip | E2E（`FILE_CANDIDATES` mock 有数据） | 中 |
| +菜单触发路径 | 点 AddMenu → 选命令/引用/文件 → 浮层打开 | E2E（与 slash-trigger 路径互斥验证） | 中 |
| /compact 操作型前缀 | draft === '/compact' → 走 compact RPC 非 send | 集成测试为主，E2E 需断言不调 send | 中 |
| landing 态 slash 源 | landing 态 slash 命令来自 settingsStore.skills（不含 builtin） | E2E（对比 landing 与 session 态命令列表差异） | 低 |
| 模型/思考等级切换 | ModelSelectPopover / ThinkingLevelPopover 切换 | E2E（mock model.switch/setThinkingLevel） | 低 |

## 10. 约束与盲区

| 约束 | 说明 |
|------|------|
| ⚠️ contenteditable 输入 | ComposerInput 是 `contenteditable` div，**不是 textarea**。Playwright 必须用 `pressSequentially`（逐字触发 input），`fill` 可能不触发 slash 检测。详见 [00 §6.2](./00-overview.md) |
| ⚠️ 浮层 portal 到 body | CommandPopover 用 reka-ui Popover portal 到 `<body>`，查询不要限定在 composer-box 内。详见 [00 §6.4](./00-overview.md) |
| ⚠️ landing 态 slash 源不同 | landing 态（无 session）slash 命令来自 `settingsStore.skills`（全局 skill 扫描），**不含** builtin/extension 命令（/compact 等）。session 态才含全部。测 builtin 命令必须先激活 session |
| ❌ mock 不模拟 abort 真实中断 | mock `chat.abort` 只标记 cancelled + 推 complete{stopReason:'aborted'}，不真实中断 pi。abort 的 pi 行为只能非 MOCK 测 |
| ❌ mock 不模拟 send 失败 | mock `chat.send` 恒成功。失败路径（hook 拦截/WS 断连）只能集成测试验证 |
| ❌ happy-dom 对 contenteditable 支持有限 | 集成测试（happy-dom）测 contenteditable 用 textContent + dispatch input event，不要依赖真实光标操作（Selection/Range）。见 [TEST-STRATEGY.md §5](../../TEST-STRATEGY.md) |

## 11. 相关文档

- 组件源码：[`components/panel/Composer.vue`](../../packages/renderer/src/components/panel/Composer.vue) / [`CommandPopover.vue`](../../packages/renderer/src/components/panel/CommandPopover.vue) / [`features/composer/ComposerInput.vue`](../../packages/ui/src/features/composer/ComposerInput.vue)
- 集成测试：[`__tests__/panel/composer-slash-trigger.test.ts`](../../packages/renderer/src/__tests__/panel/composer-slash-trigger.test.ts)
- 命令 store：[`core/domain/new-task-search/command-store.ts`](../../packages/core/src/domain/new-task-search/command-store.ts)
- 发送链路：[01-chat-panel-composer.md](./01-chat-panel-composer.md)（Composer.onSend → chat.send 的完整流式链路）

---


> 覆盖：消息发送全链路、流式消息（thinking/tool/text/error/fileChanges）、回合分组、session 隔离、auto_retry/queue、压缩
>
> 先读 [00-overview.md](./00-overview.md) 理解双轨制和公共前置。

## 1. 功能概述

对话流是 xyz-agent 的核心高频路径。用户发送消息 → pi 流式回复（thinking → tool call → text）→ 渲染回合。涉及：

- **发送链路**：`chat.send` → `chatApi.send`（ack）+ `streamSubscribe`（长订阅收 chunk）
- **流式 chunk 处理**：`chatStore.appendAssistantChunk` → `applyChunk` 分发到 messages Map
- **回合分组**：`messageTurns.toRenderItems` 纯函数动态计算（user + assistants 成一组）；三车道含 `toRenderItemsIncremental` 尾部快车道——streaming 每合帧批只处理尾部变化区（O(n)→O(delta)），`toRenderItems` 并存签名零变化
- **session 隔离**：所有状态按 sessionId 分区（messages/retry/queue/changeSetStatuses）

## 2. 组件结构概述

对话流主路径：`Panel.vue`（sessionId 存在且消息非空）渲染 `MessageStream.vue`（容器，无 testid），内部为空态欢迎语、auto-scroll 锚点、「回到底部」浮层，以及按回合划分的 `Turn.vue` 列表。每个 Turn 包含 turn-meta 折叠条（工作中脉冲点 / 已工作 chevron + 思考×N 工具×N badge）、user 气泡、trace 折叠区（内含 `Block.vue` 列表：thinking 块紫斜体默认收起、tool 块青色 mono 默认收起且 running/failed 强制展开）、收尾 summary、`ChangeSetCard.vue`（变更集卡，5 态 badge + A/M/D/U 文件行）、`ForkConfirmModal`。`SystemNotice`（system 提示行）独立穿插在流中。组件位于 `packages/ui/src/features/chat/`，MessageStream 容器在 `packages/renderer/src/components/panel/`。

## 3. data-testid 清单

testid 以组件 template 内 data-testid 属性为准。对话流相关已落地的锚点：

| testid | 所在组件 | 说明 |
|--------|---------|------|
| `composer-box` | Composer.vue | composer 容器 |
| `turn-{index}` | Turn.vue | 回合容器 |
| `turn-meta-{index}` | TurnMeta.vue | 回合折叠条 |
| `block-text` / `tool-block-header` | Block.vue | 文本块 / 工具块 header |
| `change-set-card` / `change-set-header` / `change-set-file` | ChangeSetCard.vue | 变更集卡 |
| `subagent-directive-bubble` | SystemNotice.vue | subagent 指令行 |
| `pending-bubble-list` | MessageStream.vue | 待渲染气泡列表 |
| `load-more-history` | TruncatedHistoryBar.vue | 历史截断加载 |

**当前可用的文本锚点**（无需 testid，按 mock 固定文案断言）：

| 锚点类型 | 文本/特征 | 来源 |
|---------|----------|------|
| user 气泡 | 用户输入的原文 | `turn.user.content` |
| 收尾 summary | mock 固定前缀「已处理：」+「好的，我来处理这个请求。（mock 模拟回复）」 | `mock/run-send-stream.ts` |
| turn-meta 工作态 | 「工作中」+ 脉冲点 + elapsed 计时 | `Turn.vue working 态` |
| turn-meta 完成态 | 「已工作」+ chevron + 「思考 ×1」「工具 ×1」badge | `Turn.vue 完成态` |
| SystemNotice | `$ pnpm run build · exit 0` | mock bashExecution |
| ChangeSetCard | 「变更集」+「待审查」badge + 文件路径（src/mock-feature.ts） | mock fileChanges |

## 4. sendMessage 全链路时序

### 4.1 send 调用链（`useChat.ts`）

```
Composer.onSend(segments)（send 显式接收 sessionId——双 panel 各自绑定，不读全局 session.activeId，防 standby panel 串台）
  ├─ 守卫1: segmentsToPrompt(segments).trim() 空 → return
  ├─ 守卫2: chat.isActive(sid) === true → 自动转 steer(sid, segments)（busy 时追加上下文，不丢弃）
  ├─ chat.appendUser(sid, segments)           ← 立即写 user 消息；返回 clientUuid（segments 数组 + clientUuid↔pi 映射 + inflight 占位挂钩）
  ├─ ensureStreamSubscription(sid, chat)     ← 幂等：首次订阅，二次 no-op
  │    └─ chatApi.streamSubscribe(sid, handler)
  │         handler 对每条 ServerMessage:
  │           chat.appendAssistantChunk(sid, msg)   ← 写 messages Map
  │           + 按类型翻转 isStreaming:
  │             message.message_start → setStreaming(true)
  │             message.complete / error / stream_error → setStreaming(false)
  └─ await chatApi.send(sid, promptText)      ← ack（pi 已接收，非生成完成）
```

### 4.2 关键设计点（[HISTORICAL]）

- **订阅是会话级长订阅**（`streamSubscriptions = new Map<string, () => void>()`，模块级单例），**不是 per-send**
- 原因：`rpc-client.prompt()` 在 pi ack 即 resolve（非生成完成）。若 finally 里 unsub 会丢全部流式 chunk
- 流式状态由事件驱动（`message_start`→true，`complete`/`error`/`stream_error`→false），不依赖 `send()` resolve

### 4.3 每步输入输出

| 步骤 | 输入 | 输出 |
|------|------|------|
| `chat.appendUser(sid, segments)` | `(sid, segments: Segment[])` | messages Map[sid] 追加 `{id:'u-{uuid}', role:'user', status:'complete'}`；返回 clientUuid |
| `chatApi.streamSubscribe(sid, handler)` | `(sid, handler)` | 返回 unsub 函数；handler 接收 ServerMessage |
| `chatApi.send(sid, text)` | `(sid, text)` | `Promise<void>`（ack 即 resolve） |
| mock `chat.send` | `(sid, text)` | sleep(40ms) → resolve；同时 `void runSendStream(...)` fire-and-forget |

## 5. ServerMessage 类型表（流式 chunk）

定义在 [`shared/src/protocol.ts`](../../packages/shared/src/protocol.ts)。`applyChunk`（[`chunk-processor.ts`](../../packages/core/src/domain/chat/chunk-processor.ts) + [`effects/registry.ts`](../../packages/core/src/domain/chat/effects/registry.ts)——原 renderer 21 case 已迁移 core）消费的核心类型：

| type | payload 关键字段 | 前端处理 |
|------|----------------|---------|
| `message.message_start` | `{ sessionId, messageId }` | 新建 streaming assistant（status:'streaming', content=''）；G-023 条件清 queueState（仅快照深度==0 才清 + 同点僵尸清理；快照是腿 2 includes 判据源） |
| `message.text_delta` | `{ sessionId, delta }` | content += delta（追加最后 assistant） |
| `message.thinking_start` | `{ sessionId, thinkingId }` | 追加 ThinkingBlock（content:'', collapsed:true） |
| `message.thinking_delta` | `{ sessionId, delta }` | 追加最后 ThinkingBlock.content |
| `message.thinking_end` | `{ sessionId }` | 设最后 ThinkingBlock.endTime |
| `message.tool_call_start` | `{ sessionId, toolCallId, toolName, input }` | 追加 ToolCall（status:'running'） |
| `message.tool_call_end` | `{ sessionId, toolCallId, output, status, error }` | **按 toolCallId 锚定**更新（非最后 assistant） |
| `message.tool_call_update` | `{ sessionId, toolCallId, detail }` | 按 toolCallId 锚定更新 detail |
| `message.complete` | `{ sessionId, messageId, stopReason, usage }` | status → complete/error；收口残留 running toolCall；回填 usage |
| `message.error` | `{ sessionId, message }` | 最后 streaming assistant → status:'error' + 并入 errorText；否则新建 error 消息 |
| `message.stream_error` | `{ sessionId, content }` | 无前置流则合成 error；有则 content 追加 + status:'error' |
| `message.bashExecution` | `{ sessionId, command, exitCode, ... }` | 新建 system 消息 |
| `message.compactionSummary` | `{ sessionId, summary, ... }` | 新建 system 消息 |
| `message.file_changes` | `{ sessionId, messageId, fileChanges[], changeSetStatus, isFullSet }` | accumulating 增量合并 / ready 全集替换 |
| `message.auto_retry_start` | `{ sessionId, attempt, maxAttempts?, ... }` | 写 retryStates[sid] |
| `message.auto_retry_end` | `{ sessionId, success, attempt, ... }` | 清 retryStates[sid] |
| `message.queue_update` | `{ sessionId, steering?, followUp? }` | 写/清 queueStates[sid] |

**ToolCall.status 枚举**：`'running' | 'completed' | 'error' | 'end_not_received'`
**ChangeSetStatus 5 态**：`'accumulating' | 'ready' | 'partially-reviewed' | 'resolved' | 'superseded'`
**FileChangeStatus**：`'added' | 'modified' | 'deleted' | 'unmerged'`

## 6. chatStore API（session 隔离）

[`stores/chat.ts`](../../packages/renderer/src/stores/chat.ts) 是 renderer 薄壳（31 行：defineStore 注册 + re-export），store 主体在 [`@xyz-agent/core/domain/chat/store.ts`](../../packages/core/src/domain/chat/store.ts) 的 `createChatStore` factory（P3 chat 域绞杀 w4）。核心是 `messages: Map<sessionId, Message[]>` 按 sessionId 分区。

| 方法 | 作用 |
|------|------|
| `getMessages(sid)` | 取分区消息（空返 []） |
| `appendUser(sid, text)` | 追加 user 消息 |
| `appendAssistantChunk(sid, msg)` | 委托 applyChunk 分发流式 chunk |
| `setStreaming(value)` | 设全局 isStreaming |
| `getRetryState(sid)` / `getQueueState(sid)` | per-session 重试/队列态 |
| `getChangeSetStatus(sid, msgId)` | 变更集卡状态（复合 key `${sid}:${msgId}`） |
| `isCompacting(sid)` / `setCompacting(sid, value)` | 压缩态（per-session） |
| `hydrate(sid, history)` | 注入历史（幂等，标记 hydrated） |
| `applyFileChanges(sid, msgId, changes, status, isFullSet)` | 变更集合并 |

**隔离机制**：所有读写带 sessionId；变更走不可变更新（新数组 + Map.set）保证 Vue 响应性。

## 7. mock 流式数据（`run-send-stream.ts`）

[`run-send-stream.ts`](../../packages/core/src/transport/mock/run-send-stream.ts) 模拟完整流式序列。`chat.send` 后 fire-and-forget，全程序检查 `isCancelled(sessionId)`：

```
message.message_start {sessionId, messageId}
  ↓ 60ms
[if /retry/i.test(text)]:
    message.auto_retry_start {attempt:1, maxAttempts:3, ...}
    sleep 800ms
    message.auto_retry_end {success:true, attempt:1}
  ↓
message.thinking_start {sessionId, thinkingId}
  for chunk in '让我分析一下这个请求……'（splitChunks，每 chunk 70ms）:
    message.thinking_delta {delta}
message.thinking_end {sessionId}
  ↓ 90ms
message.tool_call_start {toolCallId, toolName:'read', input:{path:'/mock/file.ts'}}
  sleep 90ms
message.tool_call_update {toolCallId, detail:'读取 42 行'}
  sleep 90ms
message.tool_call_end {toolCallId, output:'…文件内容…', status:'completed'}
  ↓ 90ms
extension:widget {widgetKey:'terminal', lines:['$ pnpm run build', ...]}
extension:status {statusKey:'build', text:'构建完成（mock）'}
  ↓
for chunk in '已处理："..."。\n好的，我来处理这个请求。（mock 模拟回复）'（每 chunk 70ms）:
  message.text_delta {messageId, delta}
  ↓ 120ms
message.file_changes {messageId, fileChanges:[{src/mock-feature.ts modified +10 -2}], changeSetStatus:'accumulating', isFullSet:false}
  sleep 120ms
message.file_changes {messageId, fileChanges:[3 个文件含 unmerged], changeSetStatus:'ready', isFullSet:true}
  ↓ 40ms
message.bashExecution {command:'pnpm run build', exitCode:0}
  ↓
message.complete {messageId, stopReason:'complete', usage:{inputTokens:1280, outputTokens:642, totalTokens:1922}}
```

**总耗时**：约 3-4 秒（thinking 8 chunk + tool 3×90ms + text 30 chunk + fileChanges 2×120ms）。

**TIMING 常量**（mock/index.ts）：`ack:40, startGap:60, chunk:70, done:40, switchCmd:30, thinkingGap:50, toolGap:90, fileChangesGap:120, retryGap:800`

**mock 不模拟的场景**：
- ❌ 失败工具流式（mock tool 恒 completed；失败工具只在历史 fixture s1 回合2 的 bash EBUSY）
- ❌ 错误流（mock 永远成功；错误路径只能单测注入 `message.error`）
- ❌ deleted fileChanges（只 modified/added/unmerged）
- ✅ retry（仅当输入含 'retry' 关键词触发）

## 8. MOCK 模式测试

### 8.1 集成测试（vitest，已有，覆盖最全）

| 测试文件 | 覆盖 |
|---------|------|
| [`__tests__/useChat.test.ts`](../../packages/renderer/src/__tests__/useChat.test.ts) | ensureStreamSubscription 幂等；send 三守卫；事件驱动 setStreaming；compact 状态机 |
| [`__tests__/chat-streaming-reset.test.ts`](../../packages/renderer/src/__tests__/chat-streaming-reset.test.ts) | **规则#3 复位**：error 路径重置 streaming/streamingMessage（否则 UI 卡死） |
| [`__tests__/fg5-message-stream.test.ts`](../../packages/renderer/src/__tests__/fg5-message-stream.test.ts)（18KB 最全） | applyChunk 全分支：thinking/tool/error/retry/queue/fileChanges；session 隔离；system 消息；历史 fixture |
| [`__tests__/panel/block-working.test.ts`](../../packages/renderer/src/__tests__/panel/block-working.test.ts) | Block working 态折叠（thinking/tool/end_not_received） |
| [`__tests__/panel/turn-working.test.ts`](../../packages/renderer/src/__tests__/panel/turn-working.test.ts) | Turn working 态（完成复位/elapsed 计时/非 working 静态） |
| [`__tests__/stores/toolcall-anchor.test.ts`](../../packages/renderer/src/__tests__/stores/toolcall-anchor.test.ts) | toolCallId 锚定（findToolCallOwner 乱序无害化） |
| [`__tests__/effects/use-streaming-pin.test.ts`](../../packages/renderer/src/__tests__/effects/use-streaming-pin.test.ts) + [`__tests__/components/MessageStream-kind.test.ts`](../../packages/renderer/src/__tests__/components/MessageStream-kind.test.ts) | message-stream-editing-pin-identity keepMounted 崩溃回归：streaming pin 恒定 identity（turnStableId 身份钉扎，virtua keepMounted 下序列变更不崩）/ MessageStream kind 查表分发（三态互斥，防死分支复辟） |

**运行**：
```bash
cd packages/renderer && npx vitest run src/__tests__/fg5-message-stream.test.ts src/__tests__/useChat.test.ts src/__tests__/chat-streaming-reset.test.ts
```

### 8.2 历史 fixture（`mock/data.ts` fixtureMessages）

5 个 session 演示 5 态（E2E 可激活验证渲染）：

| id | label | 状态 | 内容 |
|----|-------|------|------|
| `s1` | 重构 auth 模块 | error | 2 回合：回合1 thinking + 2 completed tool（read/edit）；回合2 error tool（bash EBUSY）+ status:'error'。**历史 fixture 无 fileChanges**（fileChanges 只在 run-send-stream 流式出现） |
| `s2` | Lint 排查中 | waiting | 末 assistant 含 running toolCall（bash） |
| `s3` | API 性能优化 | done | `[]` 空数组（验证欢迎语） |
| `s4` | Promise 代码评审 | running | 末 assistant status:'streaming'（纯文本流式中） |
| `s5` | 状态机重构（已废弃） | stopped | 末 assistant isInterrupted:true（abort） |

## 9. 非 MOCK 模式测试

```bash
pnpm dev
```

**手工冒烟清单**：

| 步骤 | 操作 | 期望 |
|------|------|------|
| 1 | 激活真实 session，发消息 | user 气泡立即出现，pi 开始流式回复 |
| 2 | 观察 thinking 块 | 紫色斜体 thinking 出现，逐步追加，结束后可折叠 |
| 3 | 观察 tool call | pi 调真实工具（read/bash/edit），Block 显示工具名 + 输入 + 输出 |
| 4 | 观察文本流 | assistant 文本逐字追加，streaming 光标闪烁 |
| 5 | 观察 fileChanges | 变更集卡出现，列出真实改动文件（git status 对账） |
| 6 | 流式中输入追加消息 + ⏎ | steer 追加（turn-meta 出现 queue 指示） |
| 7 | 点 stop 按钮 | abort，pi 中断（DEFERRED），turn 显示 interrupted |
| 8 | 触发错误（断网/kill pi） | error 消息出现，isStreaming 复位（UI 不卡死） |

**关键验证点**（MOCK 测不出）：
- pi 真实流式 chunk 序列（字段是否与 protocol.ts 契约一致）
- tool_call_end 的 toolCallId 锚定（pi 可能乱序发 tool chunk）
- fileChanges 与真实 git status 对账
- error/stream_error 真实触发（WS 断连、pi 崩溃）
- abort 真实中断 pi

## 10. Playwright E2E 测试

### 10.1 前置：data-testid 已落地

对话流组件已大量补齐 testid（`turn-{index}` / `block-text` / `tool-block-header` / `change-set-card` 等，见 §3 清单），E2E 可直接以 testid 锚定；未覆盖的交互面再随用例补。

### 10.2 测试场景

| 场景 | 锚点 | 期望 |
|------|------|------|
| E2E-CF-1：发消息 → user 气泡 | user 气泡文本 / `turn-0` | user 消息可见 |
| E2E-CF-2：流式 thinking | `block-text`（thinking 块 header） | thinking 块可见 |
| E2E-CF-3：流式 tool call | `tool-block-header` | tool 块可见，含工具名 |
| E2E-CF-4：流式完成 → 收尾 summary | 收尾文本「好的，我来处理」 | summary 可见 |
| E2E-CF-5：fileChanges 变更集卡 | `change-set-card` | 卡片可见，含文件路径 |
| E2E-CF-6：retry（输入 retry） | retry 指示器 | 输入含 'retry' 触发重试指示 |
| E2E-CF-7：session 隔离 | 两个 session 消息独立 | 切 session 消息不串扰 |

### 10.3 完整 E2E 示例代码（补 testid 前的文本锚点版）

> 注意：以下代码用**文本锚点**（mock 固定文案），无需补 testid 但较脆弱。落地为 e2e/chat-flow.spec.ts 前建议先补 testid。

```typescript
import { test, expect } from './fixtures/launch-app'

test.describe('对话流 E2E', () => {
  test('E2E-CF-1: 发消息 → user 气泡 + mock 流式回复', async ({ page }) => {
    // 激活空 session（s3 API 性能优化，messageCount=0）
    await page.getByRole('button', { name: /^会话/ }).click()
    await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
    await page.getByText('API 性能优化').click()
    // 等 composer 出现
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
    // 输入并发送
    await page.getByRole('textbox').click()
    await page.getByRole('textbox').pressSequentially('测试对话流 e2e')
    await page.getByRole('textbox').press('Enter')
    // 发送成功的可靠信号：mock 流式完成后的收尾 summary（约 3-4 秒）。
    // 不直接断言 user 气泡 getByText('测试对话流 e2e') —— mock 回复会回显 user 输入
    //（run-send-stream 的 '已处理："${text}"...' 形态），该文本双匹配（user 气泡 + assistant
    // 回复），getByText 严格模式会报错。收尾 summary 是 mock 固定 CANNED_REPLY，单匹配稳定。
    await expect(page.getByText(/好的，我来处理这个请求/)).toBeVisible({ timeout: 15_000 })
  })

  test('E2E-CF-2: 流式 thinking + tool 可见（文本锚点）', async ({ page }) => {
    // ⚠️ thinking 可见性时序（Block.vue 的 thinkingExpanded computed）：
    //   thinkingExpanded = computed(() => props.working || !thinkingCollapsed.value)
    //   - 流式中（working=true）→ 强制展开，全文可见
    //   - 流式完成（complete 后 working=false）→ 收起，全文 v-if 不在 DOM，只剩 header + preview
    //   mock 流式约 3-4 秒完成，故全文断言存在时序竞争（可能错过 working 窗口）。
    //   稳定策略：断言 thinking header（「思考」恒显）+ 收起态 preview（截断预览，收起后仍在 DOM）。
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('API 性能优化').click()
    await page.getByRole('textbox').click()
    await page.getByRole('textbox').pressSequentially('展示 thinking 和 tool')
    await page.getByRole('textbox').press('Enter')
    // thinking header 恒显（「思考」文案，不受 working/collapsed 影响）
    await expect(page.getByText('思考', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
    // tool 块 header 恒显（两个 span：「工具」+ toolName）。
    // mock toolCall toolName='read'（run-send-stream）。注意 header 是两个独立 span，
    // getByText 跨 span 匹配不可靠；用 .trace-tool（tool 块容器 class）限定后
    // 断言 toolName span 文本，规避跨 span 合并问题 + 「read」宽泛匹配（限定在 trace-tool 内唯一）。
    // 完整「read(/mock/file.ts)」在展开态详情区（v-if=toolExpanded），仅
    // working/running/failed 渲染，流式完成后收起有时序竞争，故不断言展开态详情。
    await expect(page.locator('.trace-tool').first()).toContainText('read', { timeout: 15_000 })
  })

  test('E2E-CF-3: fileChanges 变更集卡可见', async ({ page }) => {
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('API 性能优化').click()
    await page.getByRole('textbox').click()
    await page.getByRole('textbox').pressSequentially('展示变更集')
    await page.getByRole('textbox').press('Enter')
    // mock fileChanges（accumulating → ready，约 120ms × 2 + 文本流式）
    // ChangeSetCard 文件行渲染完整 filePath
    // 用 .first() 防 accumulating/ready 两帧瞬时双匹配
    await expect(page.getByText(/src\/mock-feature\.ts/).first()).toBeVisible({ timeout: 15_000 })
    // 变更集状态 badge：ready → '待审查'；'变更集' 标题恒显
    await expect(page.getByText('待审查').first()).toBeVisible({ timeout: 5_000 })
  })

  test('E2E-CF-4: retry 关键词触发重试指示', async ({ page }) => {
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('API 性能优化').click()
    await page.getByRole('textbox').click()
    // 输入含 'retry' 触发 mock auto_retry
    await page.getByRole('textbox').pressSequentially('请 retry 这个请求')
    await page.getByRole('textbox').press('Enter')
    // RetryIndicator 出现（Composer 上方，#13）
    // mock: auto_retry_start {attempt:1} → 800ms → auto_retry_end {success:true}
    await expect(page.getByText(/重试|retry/i)).toBeVisible({ timeout: 10_000 })
  })

  test('E2E-CF-5: 历史 session 渲染（s1 error 态）', async ({ page }) => {
    // s1 fixture 回合2 含 error tool（bash EBUSY）：output='EBUSY: 文件被外部进程占用，写入失败', status='error'
    //（mock/data.ts）。error tool Block 默认强制展开（isFailed → toolExpanded=true）
    // 用 error tool 的 output 文本作锚点（稳定，不受 class 命名重构影响）
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('重构 auth 模块').click()
    // 等 MessageStream 渲染历史，error tool output 可见
    await expect(page.getByText(/EBUSY|文件被外部进程占用/).first()).toBeVisible({ timeout: 10_000 })
  })

  test('E2E-CF-6: session 隔离（切 session 消息不串扰）', async ({ page }) => {
    // 激活 s1（2 回合）。s1 label「重构 auth 模块」，用 EBUSY error 文本作消息存在锚点
    // （'auth' 太宽泛，会匹配 README/auth 相关无关文本；EBUSY 是 s1 独有的 error tool output）
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('重构 auth 模块').click()
    await expect(page.getByText(/EBUSY/).first()).toBeVisible({ timeout: 10_000 })
    // 切到 s3（空，无 EBUSY）
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('API 性能优化').click()
    // s3 空态：EBUSY 不应可见（隔离验证）
    await expect(page.getByText(/EBUSY/)).toHaveCount(0)
    // 切回 s1，消息仍在（EBUSY 重新可见）
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('重构 auth 模块').click()
    await expect(page.getByText(/EBUSY/).first()).toBeVisible({ timeout: 5_000 })
  })
})
```

### 10.4 每步期望输入输出（E2E-CF-1 完整流式）

| 步骤 | 输入 | 输出 |
|------|------|------|
| 1. 激活 s3 | 点「API 性能优化」 | `switchSession('s3')`；composer 出现 |
| 2. 输入文本 | `pressSequentially('...')` | `draft = '...'`；发送 enable |
| 3. 按 ⏎ | `press('Enter')` | `onSend()` → `chat.send(sid, text)` |
| 4. appendUser | （内部） | `chat.appendUser('s3', text)` → user 消息入 messages Map['s3'] |
| 5. mock send | （内部） | sleep(40ms) → resolve；`runSendStream('s3', text)` fire-and-forget |
| 6. message_start | （mock 推） | `setStreaming(true)`；新建 streaming assistant |
| 7. user 气泡渲染 | （DOM） | user 气泡可见（立即，step 4 后） |
| 8. thinking 流 | （mock 推，60ms 后） | thinking 块出现，逐字追加（70ms/chunk） |
| 9. tool 流 | （mock 推，thinking 后） | tool Block 出现（start→update→end，90ms×3） |
| 10. text 流 | （mock 推） | 收尾 summary 逐字追加（70ms/chunk，约 30 chunk） |
| 11. fileChanges | （mock 推） | ChangeSetCard 出现（accumulating→ready，120ms×2） |
| 12. complete | （mock 推） | `setStreaming(false)`；turn 复位完成态；usage 回填 |
| 13. 终态断言 | （验证） | 收尾 summary「好的，我来处理这个请求」可见 |

## 11. 覆盖缺口（漏测 backlog）

当前 E2E（E2E-CF-1~6）覆盖发送 + 流式 + 历史 + retry + 隔离。以下场景待补：

| 缺口 | 场景 | 测试方式 | 优先级 |
|------|------|---------|--------|
| compact 压缩 | `/compact` 或自动触发 → compacting/compacted 态 | E2E（需补 testid，当前 composer 压缩态靠 title 锚点） | 高 |
| fork 会话 | 点 user 气泡编辑 → ForkConfirmModal → fork 新会话 | E2E（需补 Turn/ForkConfirmModal testid） | 中 |
| editAndResend | 编辑历史 user 消息 → 截断 + 重发 | 集成测试为主（useChat.editAndResend），E2E 需补 testid | 中 |
| 错误路径 | message.error / stream_error → UI 复位不卡死 | **集成测试必做**（chat-streaming-reset.test.ts 已覆盖），mock 不模拟错误 | 高 |
| tool 失败流式 | tool_call_end status='error' → 红框 + 强制展开 | 集成测试（block-working.test.ts U8），E2E 用 s1 历史 fixture（CF-5 已覆盖静态态） | 低 |
| thinking 完整文本 | 收起态点展开 → 完整 thinking 可见 | E2E（点击「思考」header toggle 后断言全文） | 低 |
| ChangeSetCard 审查交互 | 用户 Accept/Reject → partially-reviewed/resolved | E2E（需补 ChangeSetCard testid + 审查按钮锚点） | 中 |
| queue steer/followUp | 流式中 steer → queue_update → QueueBubble 指示 | E2E（需补 QueueBubble testid） | 低 |

## 12. 约束与盲区

| 约束 | 说明 |
|------|------|
| ✅ data-testid 已落地 | turn-*/block-text/tool-block-header/change-set-card/subagent-directive-bubble/pending-bubble-list/load-more-history 等已可用（见 §3 清单）；新增交互面随组件补，未覆盖处才退回文本/class 锚点 |
| ⚠️ mock 流式耗时 | 一轮约 3-4 秒。E2E timeout 给 15s，用 `toBeVisible({timeout})` 等终态，禁止固定 sleep |
| ❌ mock 不模拟失败 | 错误路径（message.error/stream_error）无法 mock E2E 触发，只能单测验证（chat-streaming-reset.test.ts） |
| ❌ mock 不模拟 WS 断连 | WS 生命周期（断连/重连）只能非 MOCK 测 |
| ⚠️ turn-meta 文本锚点 | 「工作中」/「已工作」文本可能随 UI 调整变化，不如 testid 稳定 |
| ⚠️ ChangeSetCard 5 态 | mock 只演示 accumulating→ready，resolved/superseded/partially-reviewed 需手工触发（用户 Accept/Reject） |

## 13. 滚动跟随链路教训（chat-pin-bottom-fix 登记，2026-09）

> 来源：原设计文档 chat-pin-bottom-fix（R1-R5 根因 + 三层护栏，约束 C-state-11；已删除，git 可追溯，INVAR 权威定义见 docs/architecture/conversation-stream-block-rendering.md §7.3.1）。后续为消息流滚动 / 虚拟列表设计测试时先读本节——这些机制断言不成立时，用例会以「绿但测错了东西」的方式骗人。

| 教训 | 机制（实测自 virtua 0.50.0 实装） | 测试设计启示 |
|------|------|------|
| **virtua 坐标语义** | `findItemIndex` 入参按**绝对滚动坐标**解释、内部再减 startMargin（virtua core/index.js）；handle 的 `scrollSize` getter **不含** startMargin（virtua vue/index.js）；`scrollToIndex` 的 `offset` 选项 = 目标 scrollTop 正偏移（virtua core/index.js）。`findItemIndex(scrollSize)` 直接拼用 = 反查偏移差一个 startMargin：load-more 显示（startMargin=44）时高度 <44px 的短末项（SystemNotice/SkillNoticeInline 约 24px）被钉到**倒数第二项**（R3 自我锁死错钉） | 断言滚动目标以「末项索引直取」为准（scrollToIndex 收到 `length-1`，见 use-virtua-follow.test.ts R3 回归用例）；任何 offset→index 反查类用例必须覆盖 startMargin≠0（load-more 显示）场景，startMargin=0 下永远测不出坐标错位 |
| **rAF-RO 时序** | 同一帧内执行顺序为 **rAF 回调 → style/layout → ResizeObserver 通知投递**：rAF 内 scrollToIndex 拿到的是上一帧 virtua 高度缓存，本帧新渲染高度要等 RO 投递才进测量缓存（R1「跟随恒落后一帧」；virtua jump 补偿只管视口顶锚、底部末项增长零补偿） | happy-dom 单测用 fake timers + 手动 RO stub（`_virtua-mock-helper.ts` 的 ManualResizeObserverStub）显式控制投递时机；「滚完即断言落点」的用例必须先 flush rAF（`advanceTimersByTimeAsync(16)`）再派发 RO，勿假设同帧生效 |
| **脱离信号集（INVAR-M4-2′）** | stickToBottom=false 只由用户输入信号驱动：① onWheel deltaY<0（恒即时生效，不受抑制窗约束）；② onScroll 复合判据（offset 递减 ∧ 距底 >40px——滚动条拖拽/键盘 PageUp·Home 不产生 wheel，靠复合判据覆盖）。force 强滚后收敛抑制窗（RO 静默 ≥120ms 关窗 / 1500ms 硬上限）内暂停判据②翻 false；程序性写入回声（offset 递增 / clamp distance≤0）结构性不误判 | 回声/脱离用例三分支覆盖：程序性写入（offset 递增）不脱离 / clamp 回声（distance≤0）走恢复分支翻 true / 用户拖拽（递减 ∧ distance>40）脱离且后续 follow 不滚屏（rAF 重读 guard）；抑制窗用例须含「窗内负补偿不脱离」「wheel 恒即时脱离」与两个关窗条件（120ms 静默 / 1500ms 硬上限，手动派发 RO stub 驱动） |
| **挂载级 mock Virtualizer 的 scrollRef prop 声明坑（U3 实测机制）** | `<Virtualizer :scroll-ref="scrollEl ?? undefined">` 绑定 undefined→el 的变更驱动**父组件重渲染**（与 attrs 无关）；挂载级测试仅给 mock 声明 scrollRef prop 红不消失——需配合「已收敛渲染窗口」断言或 key 断言（U3 对照实验隔离机制后定稿） | 挂载级测试 mock Virtualizer 必须声明 scrollRef prop 且接受 undefined 初始值；「红且补 prop 不消失」时优先排查绑定时序（undefined→el 重渲染窗口）而非 mock 字段缺失 |

## 14. 相关文档

- 组件源码：MessageStream 容器 [`components/panel/MessageStream.vue`](../../packages/renderer/src/components/panel/MessageStream.vue) / [`message-stream/`](../../packages/renderer/src/components/panel/message-stream/)；Turn/Block/ChangeSetCard/SystemNotice 在 [`packages/ui/src/features/chat/`](../../packages/ui/src/features/chat/)
- 流式处理：[`domain/chat/chunk-processor.ts`](../../packages/core/src/domain/chat/chunk-processor.ts)（@xyz-agent/core）
- useChat 真身：[`domain/chat/useChat.ts`](../../packages/core/src/domain/chat/useChat.ts)（@xyz-agent/core；renderer 仅薄壳 [`composables/features/chat/useChat.ts`](../../packages/renderer/src/composables/features/chat/useChat.ts)）
- 集成测试：[`__tests__/fg5-message-stream.test.ts`](../../packages/renderer/src/__tests__/fg5-message-stream.test.ts)
- mock 流式：[`transport/mock/run-send-stream.ts`](../../packages/core/src/transport/mock/run-send-stream.ts)（@xyz-agent/core）
- 发送入口：[01-chat-panel-composer.md](./01-chat-panel-composer.md)（Composer.onSend → chat.send）
- FileChanges 通道：[ADR-0024](../adr/0024-filechanges-channel.md)
