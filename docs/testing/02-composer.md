# 02 · Composer 测试流程

> 覆盖：消息输入框（contenteditable）、slash 命令浮层（@ 引用 / # 文件 / / 命令）、发送三态（send/streaming-stop/sending-spinner）、steer/followUp
>
> 先读 [00-test-strategy-overview.md](./00-test-strategy-overview.md) 理解双轨制和公共前置。

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

`Composer.vue`（`data-testid="composer-box"`，variant=landing|panel）是容器，内部组合：RetryIndicator / QueueBubble（排队与重试指示）、`CommandPopover`（slash/mention/file 浮层，portal 到 body）、ContextChipsBar（已附上下文 chip 行）、`ComposerInput`（contenteditable 输入区，位于 `packages/ui/src/features/composer/`，内含插入的 slash chip 与 mention chip）、工具条（AddMenuPopover / ContextCapacityPopover / ModelSelectPopover / ThinkingLevelPopover）。landing 态还有 meta-row chip 行（见 [01-new-task.md](./01-new-task.md)）。

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
| ⚠️ contenteditable 输入 | ComposerInput 是 `contenteditable` div，**不是 textarea**。Playwright 必须用 `pressSequentially`（逐字触发 input），`fill` 可能不触发 slash 检测。详见 [00 §6.2](./00-test-strategy-overview.md) |
| ⚠️ 浮层 portal 到 body | CommandPopover 用 reka-ui Popover portal 到 `<body>`，查询不要限定在 composer-box 内。详见 [00 §6.4](./00-test-strategy-overview.md) |
| ⚠️ landing 态 slash 源不同 | landing 态（无 session）slash 命令来自 `settingsStore.skills`（全局 skill 扫描），**不含** builtin/extension 命令（/compact 等）。session 态才含全部。测 builtin 命令必须先激活 session |
| ❌ mock 不模拟 abort 真实中断 | mock `chat.abort` 只标记 cancelled + 推 complete{stopReason:'aborted'}，不真实中断 pi。abort 的 pi 行为只能非 MOCK 测 |
| ❌ mock 不模拟 send 失败 | mock `chat.send` 恒成功。失败路径（hook 拦截/WS 断连）只能集成测试验证 |
| ❌ happy-dom 对 contenteditable 支持有限 | 集成测试（happy-dom）测 contenteditable 用 textContent + dispatch input event，不要依赖真实光标操作（Selection/Range）。见 [TEST-STRATEGY.md §5](../../TEST-STRATEGY.md) |

## 11. 相关文档

- 组件源码：[`components/panel/Composer.vue`](../../packages/renderer/src/components/panel/Composer.vue) / [`CommandPopover.vue`](../../packages/renderer/src/components/panel/CommandPopover.vue) / [`features/composer/ComposerInput.vue`](../../packages/ui/src/features/composer/ComposerInput.vue)
- 集成测试：[`__tests__/panel/composer-slash-trigger.test.ts`](../../packages/renderer/src/__tests__/panel/composer-slash-trigger.test.ts)
- 命令 store：[`core/domain/new-task-search/command-store.ts`](../../packages/core/src/domain/new-task-search/command-store.ts)
- 发送链路：[03-chat-flow.md](./03-chat-flow.md)（Composer.onSend → chat.send 的完整流式链路）
