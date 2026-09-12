# 05 · SideDrawer 测试流程

> 覆盖：SideDrawer 抽屉（5 tab：terminal/browser/git/doc/detail）、文件预览（detail tab，diff/preview 切换）、git 面板
>
> 先读 [00-test-strategy-overview.md](./00-test-strategy-overview.md) 理解双轨制和公共前置。

## 1. 功能概述

SideDrawer 是 workspace-body 级的右侧抽屉，承载 5 个 tab：

| tab | 内容 | 数据来源 |
|-----|------|---------|
| `terminal` | 终端 widget（extension:widget, widgetKey='terminal'） | extension.onWidget 订阅 |
| `browser` | 浏览器 widget（widgetKey='browser'） | extension.onWidget 订阅 |
| `git` | 全量 git 状态 + 暂存/提交（GitPanel） | provide/inject GIT_STATUS_KEY |
| `doc` | 命令/skill 详细文档（CommandDocPanel） | commandStore + skills |
| `detail` | 文件预览（DetailPane，diff/preview 切换，禁 v-html） | useDetailPane watch selectedPath |

**detail tab** 是文件树点文件的落点（见 [04-file-tree.md](./04-file-tree.md) E2E-3）：点文件 → `fileTreeStore.selectFile` → SideDrawer `open('detail')` → DetailPane 挂载 → useDetailPane 加载内容。

## 2. 组件结构概述

`PanelContainer.vue` 挂载抽屉容器（现为 `packages/ui/src/features/drawer/DrawerPanel.vue`，props: open/activeTab/sessionId）。header 含 tab 栏（terminal/browser/git/doc/detail，`drawer-tab-{key}` testid）、钉住按钮（`drawer-pin`）、关闭按钮（`drawer-close`）。content 按 activeTab 切换：terminal/browser tab 显示 widget 内容（extension.onWidget）或空态；git tab 挂 `GitPanel.vue`（git 全量状态）；doc tab 挂 `CommandDocPanel.vue`；detail tab 挂 `DetailPane.vue`（文件预览，容器 testid=`detail-pane`，含 diff/preview 切换 `detail-view-toggle`、加载/错误/空/二进制/截断态与 `detail-content` 内容区）。

## 3. data-testid 清单

testid 以组件 template 内 data-testid 属性为准（下表均已核实有效）。

| testid | 所在组件 | 触发/可见条件 |
|--------|---------|--------------|
| `detail-pane` | DetailPane.vue | detail tab 激活时恒显 |
| `detail-view-toggle` | DetailPane.vue | **仅有 git 改动时**显示（diff/preview 切换） |
| `detail-loading` | DetailPane.vue | 加载中 |
| `detail-error` | DetailPane.vue | 加载失败 |
| `detail-empty` | DetailPane.vue | 空内容 |
| `detail-binary` | DetailPane.vue | 二进制文件 |
| `detail-content` | DetailPane.vue | 内容区（恒显，加载完成后） |
| `detail-truncated` | DetailPane.vue | 文件 >1MB 截断 |
| `drawer-tab-{key}` | DrawerPanel.vue | tab 栏按钮（terminal/browser/git/doc/detail 等） |
| `drawer-panel` / `drawer-pin` / `drawer-close` | DrawerPanel.vue | 抽屉容器 / 钉住 / 关闭 |

> GitPanel 仅有 `git-inject-file` 一个 testid，git 状态内容查询仍靠内部元素文本；CommandDocPanel 无 testid。bashTask tab（后台命令详情）的完整 testid 清单见 [14-background-task-sidebar.md](./14-background-task-sidebar.md)。

## 4. detail tab 数据流（useDetailPane）

[`composables/features/file-tree/useDetailPane.ts`](../../packages/renderer/src/composables/features/file-tree/useDetailPane.ts)：

```
fileTreeStore.selectedPath 变化（点文件触发）
  └─ useDetailPane watch (selectedPath + sessionId)
       └─ openPreview(sid, path)
            ├─ store.getGitStatus(sid, path)?.status  ← 查 gitOverlay
            ├─ hasGitChange = !!gitStatus
            ├─ 默认 viewMode：有改动 → 'diff'；无 → 'preview'
            ├─ if viewMode === 'diff':
            │    gitApi.getDiff(sid, path) → mock 返回 patch
            └─ else:
                 fileApi.read(path, sid) → mock 返回内容（cwd 守门，sessionId 路径）
            → state.content = 结果；state.status = 'ready'
```

**viewMode 切换**（detail-view-toggle）：`detail-view-toggle` 仅在 `hasGitChange=true` 时渲染。点击切换 viewMode 并**重新拉数据**（diff→preview 调 `fileApi.read`，preview→diff 调 `gitApi.getDiff`，设 `status:'loading'`）。守卫仅检查 `viewMode !== mode`，不额外校验「可读/可 diff」——无 git 改动的文件切 diff 会调 getDiff，若返回空则显空内容（不崩）。

**XSS 安全**（[NFR.md](../../NFR.md) no-v-html 约束）：DetailPane **禁用 v-html**，内容用 `<pre>{{ state.content }}</pre>` 文本插值。mock file.read / git.getDiff 含 `<script>` 路径用于验证 XSS 防护。

## 5. mock 数据

| 数据 | 内容 |
|------|------|
| `file.read(path, sid)` mock | 按扩展名返回内容（.ts 含 'export function'；含 `<script>` 路径用于 XSS 测试） |
| `git.getDiff(sid, path)` mock | 按路径返回 patch（含 'diff --git'；含 `<script>` 用于 XSS；二进制返回空 patch） |

## 6. MOCK 模式测试

### 6.1 MOCK dev 手工测试

```bash
pnpm --filter @xyz-agent/electron run dev:mock
```

| 步骤 | 操作 | 期望 |
|------|------|------|
| 1 | 激活 e2e-files session，切文件 tab | 文件树加载 |
| 2 | 点 src/index.ts（未改动） | drawer 打开 detail tab，显示 file.read 内容（含 'export function'） |
| 3 | 点 src/new-feature.ts（git added） | drawer 切到该文件，显示 git.getDiff patch（含 'diff --git'），detail-view-toggle 可见 |
| 4 | 点 detail-view-toggle | diff ↔ preview 切换 |
| 5 | 切到 git tab | GitPanel 显示（mock git 状态） |
| 6 | 切到 terminal tab | widget 内容或空态 |

### 6.2 集成测试

DetailPane / useDetailPane 的单测在 [`__tests__/`](../../packages/renderer/src/__tests__)（搜索 detail/useDetailPane）。

## 7. 非 MOCK 模式测试

```bash
pnpm dev
```

**手工冒烟清单**：

| 步骤 | 操作 | 期望 |
|------|------|------|
| 1 | 激活真实 session，点文件 | drawer 打开，runtime `file.read` 真实内容 |
| 2 | 点 git 改动文件 | runtime `git.getDiff` 真实 patch |
| 3 | 切 git tab | GitPanel 显示真实 `git status` + 暂存/提交 |
| 4 | 大文件（>1MB） | detail-truncated 显示 |
| 5 | 二进制文件（图片） | detail-binary 显示 |

**关键验证点**（MOCK 测不出）：
- runtime `file.read` / `git.getDiff` 真实 RPC（含 BC-3 路径守卫：read 允许 3 全局目录 + cwd 子树）
- 真实 git diff 格式（binary/rename/copy）
- 大文件截断逻辑（>1MB）
- GitPanel 真实 git status + 暂存/提交流程

## 8. Playwright E2E 测试（detail tab 已落地）

### 8.1 现有覆盖

detail tab 的 E2E 已在 [`e2e/file-tree.spec.ts`](../../e2e/file-tree.spec.ts) 落地（E2E-3a/3b/3c，见 [04-file-tree.md §8.3](./04-file-tree.md)）。复用 gotoFileTree helper。

### 8.2 测试场景

| 场景 | testid 锚点 | 期望 |
|------|------------|------|
| E2E-SD-1：点未改动文件 → 内容预览 | `detail-pane` / `detail-content` | 内容含 'export function' |
| E2E-SD-2：点改动文件 → diff + XSS 安全 | `detail-content` | 含 'diff --git'；`detail-content script` count=0 |
| E2E-SD-3：drawer 已开点新文件 → 切换 | `detail-pane` count | 切换前后 count 不变 |
| E2E-SD-4：detail-view-toggle 切换 | `detail-view-toggle` | 有 git 改动时可见，点击切换 diff/preview |
| E2E-SD-5：切其他 tab 再回 detail | tab 文本按钮 | detail 内容恢复 |

### 8.3 完整 E2E 示例代码（含 tab 切换）

> 注意：tab 切换部分（git/doc/terminal）是**范例模板**，detail 部分已落地在 file-tree.spec.ts。

```typescript
import { test, expect } from './fixtures/launch-app'

async function gotoFileTree(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /^会话/ }).click()
  await expect(page.getByText('E2E 文件树测试')).toBeVisible({ timeout: 10_000 })
  await page.getByText('E2E 文件树测试').click()
  await page.getByRole('button', { name: /^文件/ }).click()
  await expect(page.getByTestId('file-view-root')).toBeVisible({ timeout: 10_000 })
}

test.describe('SideDrawer E2E', () => {
  test('E2E-SD-1: 点未改动文件 → 内容预览', async ({ page }) => {
    await gotoFileTree(page)
    await page.getByTestId('file-tree-dir-src').click()
    await page.getByTestId('file-tree-file-src/index.ts').click()
    await expect(page.getByTestId('detail-pane')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('detail-content')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('detail-content')).toContainText('export function')
    // 未改动文件 → 无 detail-view-toggle
    await expect(page.getByTestId('detail-view-toggle')).toHaveCount(0)
  })

  test('E2E-SD-2: 点改动文件 → diff + XSS 安全', async ({ page }) => {
    await gotoFileTree(page)
    await page.getByTestId('file-tree-dir-src').click()
    await page.getByTestId('file-tree-file-src/new-feature.ts').click()
    await expect(page.getByTestId('detail-pane')).toBeVisible({ timeout: 5_000 })
    // 改动文件 → 默认 diff，有 detail-view-toggle
    await expect(page.getByTestId('detail-view-toggle')).toBeVisible()
    await expect(page.getByTestId('detail-content')).toContainText('diff --git')
    // XSS 安全：<script> 不执行（禁 v-html）
    const scriptCount = await page.locator('detail-content script').count()
    expect(scriptCount).toBe(0)
  })

  test('E2E-SD-3: drawer 已开点新文件 → 切换非新开', async ({ page }) => {
    await gotoFileTree(page)
    await page.getByTestId('file-tree-dir-src').click()
    await page.getByTestId('file-tree-file-src/index.ts').click()
    await expect(page.getByTestId('detail-pane')).toBeVisible({ timeout: 5_000 })
    const countBefore = await page.getByTestId('detail-pane').count()
    // 点第二个文件（切换）
    await page.getByTestId('file-tree-file-src/existing.ts').click()
    await expect(page.getByTestId('detail-pane')).toBeVisible({ timeout: 5_000 })
    const countAfter = await page.getByTestId('detail-pane').count()
    expect(countAfter).toBe(countBefore)  // 仍 1 个（切换非新开）
  })

  test('E2E-SD-4: detail-view-toggle 切换 diff/preview', async ({ page }) => {
    await gotoFileTree(page)
    await page.getByTestId('file-tree-dir-src').click()
    await page.getByTestId('file-tree-file-src/new-feature.ts').click()
    await expect(page.getByTestId('detail-pane')).toBeVisible({ timeout: 5_000 })
    // 默认 diff
    await expect(page.getByTestId('detail-content')).toContainText('diff --git')
    // 点 toggle 切到 preview
    await page.getByTestId('detail-view-toggle').click()
    await expect(page.getByTestId('detail-content')).toBeVisible({ timeout: 5_000 })
    // 切回 diff
    await page.getByTestId('detail-view-toggle').click()
    // toggleView 切换时先设 status='loading'（useDetailPane），detail-content（v-else
    // 非_loading）短暂从 DOM 消失显 detail-loading。需先等 toBeVisible 再断文本，避免 flaky。
    await expect(page.getByTestId('detail-content')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('detail-content')).toContainText('diff --git')
  })

  test('E2E-SD-5: 切 git tab → GitPanel 渲染全量状态', async ({ page }) => {
    // 入口选择：SideDrawer 的 git tab 按钮与 PanelHeader 的 git 按钮都含 "Git" 文本，
    // getByRole(button, name:/git/i) 会双匹配。改用 PanelHeader git 按钮（title 更具体
    // 「Git 状态 · 打开侧栏」），点击触发 openGit → openDrawer('git')
    // → drawer 切到 git tab → GitPanel 挂载。
    await gotoFileTree(page)
    await page.getByTestId('file-tree-dir-src').click()
    await page.getByTestId('file-tree-file-src/index.ts').click()
    await expect(page.getByTestId('detail-pane')).toBeVisible({ timeout: 5_000 })
    // 点 PanelHeader git 按钮（唯一匹配，title 含「Git 状态」）
    await page.getByTitle('Git 状态 · 打开侧栏').click()
    // GitPanel 渲染（数据来自 inject GIT_STATUS_KEY → useGitStatus →
    // gitApi.status → mock fixtureGitStatus）。内容区无 testid，用稳定文本断言：
    //   - 分支名 main（mock git branch:'main'）
    await expect(page.getByText('main').first()).toBeVisible({ timeout: 5_000 })
    //   - stats +42 −7（mock git stats:{add:42,del:7}）
    await expect(page.getByText('+42').first()).toBeVisible()
    await expect(page.getByText('−7').first()).toBeVisible()
    //   - 文件列表含 mock fixture 路径
    await expect(page.getByText('src/new-feature.ts').first()).toBeVisible()
  })
})
```

### 8.4 每步期望输入输出（E2E-SD-1 内容预览）

| 步骤 | 输入 | 输出 |
|------|------|------|
| 1. gotoFileTree | （helper） | 文件树可见 |
| 2. 展开 src | 点 `file-tree-dir-src` | 子节点可见 |
| 3. 点 index.ts | 点 `file-tree-file-src/index.ts` | `fileTreeStore.selectFile('src/index.ts')` → SideDrawer `open('detail')` |
| 4. DetailPane 挂载 | （DOM） | `detail-pane` 可见 |
| 5. useDetailPane watch | （内部） | `openPreview('e2e-files', 'src/index.ts')` |
| 6. 查 gitStatus | （内部） | `store.getGitStatus` 无记录 → hasGitChange=false → viewMode='preview' |
| 7. file.read | （mock） | `fileApi.read('src/index.ts', 'e2e-files')` → 返回 .ts 内容（含 'export function'） |
| 8. 渲染 | （DOM） | `detail-content` 含 'export function'；无 `detail-view-toggle` |
| 9. 断言 | （验证） | detail-content 文本匹配 + view-toggle count=0 |

## 9. 覆盖缺口（漏测 backlog）

当前 E2E（E2E-SD-1~5）覆盖 detail tab 主路径 + git tab 全量状态渲染。以下场景待补：

| 缺口 | 场景 | 测试方式 | 优先级 |
|------|------|---------|--------|
| 钉住（dock） | 点钉住按钮 → drawer 持续打开（切 session 不关） | E2E（需补 dock 按钮 testid） | 中 |
| terminal tab widget | extension:widget widgetKey='terminal' 推送 → 渲染 | E2E（mock 推 widget，需补 tab testid） | 中 |
| browser tab widget | widgetKey='browser' 推送 → 渲染 | E2E（同上） | 低 |
| doc tab | slash 命令 chip 点击 → doc tab 展示 CommandDocPanel | E2E（需补 CommandDocPanel testid） | 中 |
| git tab 暂存/提交交互 | stage/unstage/commit 操作（E2E-SD-5 已覆盖只读渲染） | E2E（需补操作按钮 testid） | 中 |
| 大文件截断 | file.read >1MB → detail-truncated 显示 | 非 MOCK（mock file.read 恒小文本） | 低 |
| 二进制文件 | 图片等 → detail-binary 显示 | 非 MOCK（mock 不返回二进制标记） | 低 |
| diff/preview 切换 | 点 detail-view-toggle 在 diff/preview 间切换（每次切换重新拉数据） | E2E（E2E-SD-4 已覆盖单次切换） | — |

> ⚠️ **viewMode 不持久（已知限制，非 backlog）**：`useDetailPane.state` 是组件级 `ref`，`DetailPane` 在抽屉容器内是条件挂载——切走（切到 git/doc tab）即 unmount，state 销毁；切回重新 `useDetailPane()` → `initialState()` → viewMode 复位为 `'preview'`。**无 store/localStorage 持久化**。如需「切走再切回记忆 viewMode」是功能增强需求，需改造成 store 或 module 级缓存，当前不作为测试 backlog（测了也是验证缺陷）。

## 10. 约束与盲区

| 约束 | 说明 |
|------|------|
| ⚠️ GitPanel/CommandDocPanel testid 覆盖薄 | GitPanel 仅有 `git-inject-file`；CommandDocPanel 无 testid。git/doc tab 内容查询靠内部元素文本（脆弱） |
| ✅ DetailPane testid 完整 | detail tab 有完整 testid（detail-pane/content/loading/error/empty/binary/truncated/toggle），E2E 稳定 |
| ✅ DrawerPanel testid 已落地 | tab 栏 `drawer-tab-{key}` + 容器/钉住/关闭均有 testid |
| ❌ mock 不模拟大文件/二进制 | detail-truncated（>1MB）/ detail-binary 只能非 MOCK 测（mock file.read 恒小文本） |
| ❌ 真实 git diff 格式 | mock getDiff 返回固定 patch，真实 git（binary/rename）只能非 MOCK 测 |
| ❌ widget 订阅 | terminal/browser tab 走 extension.onWidget，mock 推送有限，真实 widget 内容只能非 MOCK 测 |

## 11. 相关文档

- 组件源码：抽屉容器 [`features/drawer/DrawerPanel.vue`](../../packages/ui/src/features/drawer/DrawerPanel.vue)（原 SideDrawer，已迁 ui 包）/ [`DetailPane.vue`](../../packages/renderer/src/components/panel/DetailPane.vue)
- composable：[`composables/features/file-tree/useDetailPane.ts`](../../packages/renderer/src/composables/features/file-tree/useDetailPane.ts) / [`composables/features/drawer/useSideDrawer.ts`](../../packages/renderer/src/composables/features/drawer/useSideDrawer.ts)
- E2E（detail tab）：[`e2e/file-tree.spec.ts`](../../e2e/file-tree.spec.ts) E2E-3a/3b/3c
- 文件树入口：[04-file-tree.md](./04-file-tree.md)（点文件 → drawer detail）
- NFR no-v-html：[NFR.md](../../NFR.md)（XSS 安全约束）
