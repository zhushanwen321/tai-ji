# 02 · 面板与侧栏测试手册（文件树 / SideDrawer / 搜索浮层 / GUI 组件 / Subagent 面板 / 后台命令）

> 合并自 04-file-tree.md + 05-side-drawer.md + 06-search-modal.md + 07-gui-components.md + 09-subagent-workflow-panel.md + 14-background-task-sidebar.md（2026-09 手册并册，原文 git 历史可查）。
>
> 公共前置（双轨制 / Playwright harness / activateSession / E2E 常见坑）见 [00-overview.md](./00-overview.md)。

---


> 覆盖：全项目文件树懒加载、过滤、git 角标、showIgnored 开关、展开态恢复
>
> 这是**测试覆盖最完整**的功能：11 个 E2E 用例已落地（`e2e/file-tree.spec.ts`）。
>
> 先读 [00-overview.md](./00-overview.md) 理解双轨制和公共前置。

## 1. 功能概述

侧栏「文件」tab 展示当前 session cwd 的完整项目文件树：

```
切到「文件」tab → 加载顶层 + 一级子目录（D-009 懒加载）
点目录展开 → 加载该目录单层（expand，缓存复用）
输入关键词 → 实时过滤节点
点「忽略项」开关 → 显示/隐藏 ignored 节点（node_modules 等）
点文件 → 打开 SideDrawer detail 预览（见 02-panels-sidebar.md）
切 session 再切回 → 展开态恢复（expandedPaths 持久）
```

## 2. 组件结构概述

`Sidebar.vue` 的 SegmentedTab「文件」页签渲染 `FileView.vue`（`data-testid="file-view-root"`）。头部行（session 标签 + 分支 + `file-show-ignored-toggle` 开关）与 `file-filter-input` 过滤框固定在滚动区外；滚动区内是加载/错误/空态（`file-loading` / `file-error`+`file-retry` / `file-empty`），树体由 virtua Virtualizer 挂载扁平可见行（`projectVisibleRows` 投影），每行是纯行组件 `FileTreeRow.vue`（`file-tree-dir-{path}` / `file-tree-file-{path}`，文件行含 A/M/D/U git 角标）。无活跃 session 时显示 `file-view-no-session` 空态。

[W28/D-7.2] 结构要点：头部与过滤框移出滚动区是 virtua Virtualizer 的硬约束（parentElement 必须是滚动容器且前方无内容）；树形递归渲染改为「扁平可见行投影 + 虚拟滚动」，万级目录展开只挂载视口 ± 缓冲的行（DOM 行数 < 200）；depth/expanded/changeCount/gitStatus/lineStats 全部由投影预计算，交互经 emit 归位 FileView 层。

## 3. data-testid 清单

testid 以组件 template 内 data-testid 属性为准（下表均已核实有效）。

| testid | 所在组件 | 触发/可见条件 |
|--------|---------|--------------|
| `file-view-root` | FileView.vue | 文件 tab 激活 + 有 session 时恒显 |
| `file-filter-input` | FileView.vue | 恒显（过滤输入框，滚动区外固定） |
| `file-show-ignored-toggle` | FileView.vue | 恒显（showIgnored 开关，头部行） |
| `file-loading` | FileView.vue | 加载中 |
| `file-error` | FileView.vue | 加载失败 |
| `file-retry` | FileView.vue | 加载失败时的「重试」按钮 |
| `file-empty` | FileView.vue | 过滤无匹配 / 树空 |
| `file-tree-dir-{path}` | FileTreeRow.vue | 目录节点（path 如 `src`、`src/utils`） |
| `file-tree-loading-{path}` | FileTreeRow.vue | 该目录展开加载中（子节点异步加载态） |
| `file-tree-error-{path}` | FileTreeRow.vue | 该目录展开加载失败（点击 = 折叠父目录，旧递归语义） |
| `file-tree-empty-{path}` | FileTreeRow.vue | 该目录已加载空（含全部子项被 showIgnored 过滤） |
| `file-tree-file-{path}` | FileTreeRow.vue | 文件节点（path 如 `README.md`、`src/index.ts`） |
| `chevron-slot` | FileTreeRow.vue | 展开/折叠箭头（每个节点都有，无 path 后缀，E2E 查询时需限定父节点） |
| `file-view-no-session` | Sidebar.vue | 无活跃 session 时 |

**testid 命名规则**：
- 节点：`file-tree-{dir|file}-{相对路径}`，路径用 `/` 分隔（如 `src/index.ts`）
- 节点态：`file-tree-{loading|error|empty}-{path}`（展开该目录时的异步态/空态）
- `chevron-slot` 是公共箭头标识，无 path 后缀，E2E 查询时用 `page.getByTestId('file-tree-dir-src').locator('.chevron-slot')` 限定到具体节点

**E2E 查询示例**（限定 chevron 到具体节点）：
```typescript
// 展开特定目录（点击其 chevron 而非整行，避免误触子节点）
await page.getByTestId('file-tree-dir-src').click()  // 整行可点
// 或精确点 chevron
await page.getByTestId('file-tree-dir-src').getByTestId('chevron-slot').click()
```

## 4. 数据流（useFileTree + fileTreeStore）

### 4.1 加载链路

```
FileView.onMounted → useFileTree.setupInvalidation(sessionId)
  ├─ watch [sessionIdRef, chatStore.messages]（deep）→ 遍历 messages 提取 fileChanges
  │    → 命中变更路径 → store.invalidate（仅标记 loaded→invalidated，下次 expand 重发，不清空 tree）
  └─ store.load(sessionId)  ← 首次加载
       └─ fileApi.tree(sessionId) → mock file.tree（返回 MOCK_TREE）
            → store.setTree(sessionId, nodes)
            → store.setGitStatus(sessionId, ...)（mock git.status 并行）
```

> 注：chatStore 无顶层 `fileChanges` 属性，fileChanges 是 per-message 字段（`message.fileChanges`）。setupInvalidation 通过 deep watch 整个 `messages` Map 后过滤出 fileChanges 路径来触发失效。

### 4.2 展开链路（D-009 懒加载）

```
点目录行 file-tree-dir-{path}
  └─ useFileTree.expandNode(path)
       ├─ 检查 store.getTree 节点是否已有子目录 → 已加载则复用缓存（防空 expand 覆盖）
       └─ 否则 fileApi.expand(sessionId, path) → mock 返回单层
            → store.setNodeState（合并子目录）
```

### 4.3 过滤链路

```
file-filter-input input → store.setFilter(query)（useFileTree 200ms 防抖提交）
  └─ [W28/D-7.2] FileView 投影 computed（projectVisibleRows）：顶层节点 nodeMatchesFilter
       命中判定（仅祖先链保留）+ 展开目录 DFS 展开 → 命中节点显示，不命中隐藏
       → 全无匹配 → 投影空 → file-empty 显示
```

## 5. mock 数据

[`transport/mock/file.ts`](../../packages/core/src/transport/mock/file.ts) + [`transport/mock/git.ts`](../../packages/core/src/transport/mock/git.ts)：

| 数据 | 内容 |
|------|------|
| `MOCK_TREE` | 顶层：src / README.md / package.json / untracked.log / node_modules(ignored) |
| MOCK_TREE src 子项 | index.ts / new-feature.ts / existing.ts / utils/ |
| `MOCK_IGNORED` | node_modules / dist / .env（始终返回并标 ignored=true，前端 showIgnored 开关控制显隐） |
| `fixtureGitStatus` | src/new-feature.ts=added(A) / README.md=modified(M) / 其他 |
| `file.read` mock | 按扩展名返回内容（.ts 含 'export function'；含 `<script>` 路径用于 XSS 测试） |
| `git.getDiff` mock | 按路径返回 patch（含 'diff --git'；含 `<script>` 用于 XSS） |

**E2E session**：`e2eTestSession`（id=`e2e-files`，label=`E2E 文件树测试`，cwd=sample-project 真实路径，构建期 Vite define 注入）。

## 6. MOCK 模式测试

### 6.1 集成测试（vitest）

文件树相关单测在 [`__tests__/stores/`](../../packages/renderer/src/__tests__/stores/)（fileTreeStore 分区/过滤/展开）。运行：

```bash
cd packages/renderer && npx vitest run src/__tests__/stores/
```

### 6.2 MOCK dev 手工测试

```bash
pnpm --filter @xyz-agent/electron run dev:mock
```

启动后切到「文件」tab，激活 e2e-files session，可手工测试过滤/展开/角标。

## 7. 非 MOCK 模式测试

```bash
pnpm dev
```

**手工冒烟清单**：

| 步骤 | 操作 | 期望 |
|------|------|------|
| 1 | 激活真实 session，切「文件」tab | 顶层文件树加载（真实 cwd） |
| 2 | 展开真实目录 | 子目录加载（runtime `file.tree` RPC） |
| 3 | 观察 git 角标 | 与 `git status` 真实对账（A/M/D/U） |
| 4 | 输入过滤 | 真实文件名匹配 |
| 5 | 点文件 | SideDrawer 打开真实文件内容（runtime `file.read`） |

**关键验证点**（MOCK 测不出）：
- runtime `file.tree` / `file.expand` / `file.read` 真实 RPC（字段是否与 protocol 契约一致）
- 真实 git status 解析（pi 的 git 输出格式）
- 大型项目性能（懒加载是否真的只加载一级）
- 路径守卫（BC-3 白名单：file.read 允许 3 全局目录 + session.cwd 子树）

## 8. Playwright E2E 测试（已落地）

### 8.1 现有 spec

[`e2e/file-tree.spec.ts`](../../e2e/file-tree.spec.ts) — **11 个用例已落地且通过**。

### 8.2 公共前置：gotoFileTree helper

```typescript
// 激活 e2e-files session 并切到文件 tab（file-tree.spec.ts 内联定义）
async function gotoFileTree(page: import('@playwright/test').Page): Promise<void> {
  // 1. 切到 sessions tab（按钮 name 含计数如「会话 6」，正则前缀匹配）
  await page.getByRole('button', { name: /^会话/ }).click()
  // 2. 等 session list 渲染（mock session.list 40ms 延迟）
  await expect(page.getByText('E2E 文件树测试')).toBeVisible({ timeout: 10_000 })
  // 3. 点 e2e-files session 激活
  await page.getByText('E2E 文件树测试').click()
  // 4. 切到「文件」tab
  await page.getByRole('button', { name: /^文件/ }).click()
  // 5. 等 FileView 加载（mock file.tree 40ms + git.status 40ms）
  await expect(page.getByTestId('file-view-root')).toBeVisible({ timeout: 10_000 })
}
```

### 8.3 测试场景与用例对照

| 用例 ID | 场景 | testid 锚点 | 期望 |
|---------|------|------------|------|
| smoke | harness 冒烟 | `page.title` | 匹配 /xyz-agent\|xyz/i |
| E2E-1 (T1.8) | 切文件 tab → 顶层节点 | `file-tree-dir-src` / `file-tree-file-README.md` / `file-tree-file-package.json` | 三个顶层节点 DOM 可见 |
| E2E-2 (UC-1+2) | 点目录展开 + 角标 | `file-tree-file-src/index.ts` / `file-tree-file-src/new-feature.ts` | 子节点可见；new-feature.ts 含 'A' 角标 |
| E2E-3a (T6.2) | 点文件 → drawer 内容 | `detail-pane` / `detail-content` | drawer 打开，内容含 'export function' |
| E2E-3b (T6.10) | 改动文件 → diff + XSS 安全 | `detail-content` | 含 'diff --git'；`detail-content script` count=0 |
| E2E-3c (T6.12) | drawer 已开点新文件 → 切换 | `detail-pane` count | 切换前后 count 不变（仍 1） |
| E2E-4 (AC-3.5) | 切 session 再切回 → 展开态恢复 | `file-tree-file-src/index.ts` | 切回后子节点仍可见（expandedPaths 持久） |
| T4.1 | 过滤命中 | `file-tree-file-README.md` 可见 / `file-tree-file-package.json` count=0 | 输入 'readme' 后只 README 命中 |
| T4.2 | 无匹配 → 空态 | `file-empty` | 输入 'zzz_no_match_zzz' 显示空态 |
| T4.5 | 清空 → 恢复完整树 | `file-tree-file-package.json` | 清空过滤后恢复 |
| D-020 | showIgnored 开关 | `file-tree-dir-node_modules` | 默认隐藏（前端 computed 过滤）；开关开后瞬时可见，无重拉闪烁 |

### 8.4 完整 E2E 代码（现有，可作其他功能 E2E 的参考模板）

```typescript
import { test, expect } from './fixtures/launch-app'

async function gotoFileTree(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /^会话/ }).click()
  await expect(page.getByText('E2E 文件树测试')).toBeVisible({ timeout: 10_000 })
  await page.getByText('E2E 文件树测试').click()
  await page.getByRole('button', { name: /^文件/ }).click()
  await expect(page.getByTestId('file-view-root')).toBeVisible({ timeout: 10_000 })
}

test.describe('文件树 E2E', () => {
  test('harness smoke：Electron app 加载首窗口', async ({ page }) => {
    await expect(page).toHaveTitle(/xyz-agent|xyz/i)
  })

  test('E2E-1 (T1.8): 切「文件」tab → 顶层节点 DOM 可见', async ({ page }) => {
    await gotoFileTree(page)
    await expect(page.getByTestId('file-tree-dir-src')).toBeVisible()
    await expect(page.getByTestId('file-tree-file-README.md')).toBeVisible()
    await expect(page.getByTestId('file-tree-file-package.json')).toBeVisible()
  })

  test('E2E-2 (UC-1+2): 点目录展开 → 子节点 DOM 出现 + 角标渲染', async ({ page }) => {
    await gotoFileTree(page)
    await page.getByTestId('file-tree-dir-src').click()
    await expect(page.getByTestId('file-tree-file-src/index.ts')).toBeVisible()
    await expect(page.getByTestId('file-tree-file-src/new-feature.ts')).toBeVisible()
    const newFeatureRow = page.getByTestId('file-tree-file-src/new-feature.ts')
    await expect(newFeatureRow).toContainText('A')  // added 角标
  })

  test('E2E-3a (T6.2): 点文件 → SideDrawer detail 打开 + 显示内容', async ({ page }) => {
    await gotoFileTree(page)
    await page.getByTestId('file-tree-dir-src').click()
    await page.getByTestId('file-tree-file-src/index.ts').click()
    await expect(page.getByTestId('detail-pane')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('detail-content')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('detail-content')).toContainText('export function')
  })

  test('E2E-3b (T6.1/T6.10): 改动文件 → diff 显示 + 禁 v-html（XSS 安全）', async ({ page }) => {
    await gotoFileTree(page)
    await page.getByTestId('file-tree-dir-src').click()
    await page.getByTestId('file-tree-file-src/new-feature.ts').click()
    await expect(page.getByTestId('detail-pane')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('detail-content')).toContainText('diff --git')
    // XSS 安全：禁 v-html，<script> 不执行
    const scriptCount = await page.locator('detail-content script').count()
    expect(scriptCount).toBe(0)
  })

  test('T4.1: 输入关键词 → 节点过滤', async ({ page }) => {
    await gotoFileTree(page)
    await page.getByTestId('file-filter-input').fill('readme')
    await expect(page.getByTestId('file-tree-file-README.md')).toBeVisible()
    await expect(page.getByTestId('file-tree-file-package.json')).toHaveCount(0)
  })

  test('T4.2: 无匹配 → 空态', async ({ page }) => {
    await gotoFileTree(page)
    await page.getByTestId('file-filter-input').fill('zzz_no_match_zzz')
    await expect(page.getByTestId('file-empty')).toBeVisible()
  })

  test('D-020 showIgnored: 开关切换 → ignored 节点瞬时显示/隐藏（前端 computed 过滤，无重拉闪烁）', async ({ page }) => {
    await gotoFileTree(page)
    // 默认被前端 computed 过滤（store 含 ignored 节点但不渲染）
    await expect(page.getByTestId('file-tree-dir-node_modules')).toHaveCount(0)
    await page.getByTestId('file-show-ignored-toggle').click()
    // 纯前端切换，瞬时可见
    await expect(page.getByTestId('file-tree-dir-node_modules')).toBeVisible({ timeout: 5_000 })
  })

  // ... 完整 11 用例见 e2e/file-tree.spec.ts
})
```

### 8.5 每步期望输入输出（E2E-2 展开+角标）

| 步骤 | 输入 | 输出 |
|------|------|------|
| 1. gotoFileTree | （helper） | sessions tab → 点 e2e-files → files tab → file-view-root 可见 |
| 2. 点 src | `getByTestId('file-tree-dir-src').click()` | `useFileTree.expandNode('src')` |
| 3. 缓存检查 | （内部） | store.getTree src 节点已有子目录（首加载含一级子）→ 复用缓存，不发 expand |
| 4. 展开渲染 | （DOM） | `file-tree-file-src/index.ts` 等（投影产出可见行，virtua 挂载）→ 可见 |
| 5. 角标渲染 | （DOM） | `file-tree-file-src/new-feature.ts` 含 'A'（fixtureGitStatus added） |
| 6. 断言 | （验证） | 子节点 visible + 角标文本 contains 'A' |

## 9. 约束与盲区

| 约束 | 说明 |
|------|------|
| ✅ testid 完整 | FileView/FileTreeRow 有完整 testid，E2E 稳定 |
| ✅ 大数据量渲染 | [W28] FileView-virtua.test.ts 用真实 virtua 覆盖万级目录（10000 文件 → DOM 行数 < 200） |
| ⚠️ 真实大项目性能 | mock 树小（约 10 节点），真实项目可能数千节点。懒加载/滚动体验只能非 MOCK 测 |
| ❌ 真实 git status | mock fixtureGitStatus 是静态的，真实 git 输出格式（rename/copy 等）只能非 MOCK 测 |
| ❌ 路径守卫 | BC-3 白名单（file.read 允许 3 全局目录 + cwd 子树）只能非 MOCK 测（mock 不校验） |

## 10. 相关文档

- 组件源码：[`components/sidebar/FileView.vue`](../../packages/renderer/src/components/sidebar/FileView.vue) / [`FileTreeRow.vue`](../../packages/renderer/src/components/sidebar/FileTreeRow.vue)
- composable：[`composables/features/file-tree/useFileTree.ts`](../../packages/renderer/src/composables/features/file-tree/useFileTree.ts)
- E2E spec：[`e2e/file-tree.spec.ts`](../../e2e/file-tree.spec.ts)（11 用例）
- ADR：[ADR-0025 文件视图完整项目树](../adr/0025-file-view-full-project-tree.md) / [ADR-0026 懒加载](../adr/0026-file-tree-lazy-loading.md) / [ADR-0027 FileService 三层](../adr/0027-fileservice-three-layer.md)
- SideDrawer detail：[02-panels-sidebar.md](./02-panels-sidebar.md)（点文件 → drawer 预览）

---


> 覆盖：SideDrawer 抽屉（5 tab：terminal/browser/git/doc/detail）、文件预览（detail tab，diff/preview 切换）、git 面板
>
> 先读 [00-overview.md](./00-overview.md) 理解双轨制和公共前置。

## 1. 功能概述

SideDrawer 是 workspace-body 级的右侧抽屉，承载 5 个 tab：

| tab | 内容 | 数据来源 |
|-----|------|---------|
| `terminal` | 终端 widget（extension:widget, widgetKey='terminal'） | extension.onWidget 订阅 |
| `browser` | 浏览器 widget（widgetKey='browser'） | extension.onWidget 订阅 |
| `git` | 全量 git 状态 + 暂存/提交（GitPanel） | provide/inject GIT_STATUS_KEY |
| `doc` | 命令/skill 详细文档（CommandDocPanel） | commandStore + skills |
| `detail` | 文件预览（DetailPane，diff/preview 切换，禁 v-html） | useDetailPane watch selectedPath |

**detail tab** 是文件树点文件的落点（见 [02-panels-sidebar.md](./02-panels-sidebar.md) E2E-3）：点文件 → `fileTreeStore.selectFile` → SideDrawer `open('detail')` → DetailPane 挂载 → useDetailPane 加载内容。

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

> GitPanel 仅有 `git-inject-file` 一个 testid，git 状态内容查询仍靠内部元素文本；CommandDocPanel 无 testid。bashTask tab（后台命令详情）的完整 testid 清单见 [02-panels-sidebar.md](./02-panels-sidebar.md)。

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

**XSS 安全**（约束登记 C-state-13，见 [docs/constraints.json](../constraints.json)）：DetailPane **禁用 v-html**，内容用 `<pre>{{ state.content }}</pre>` 文本插值。mock file.read / git.getDiff 含 `<script>` 路径用于验证 XSS 防护。

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

detail tab 的 E2E 已在 [`e2e/file-tree.spec.ts`](../../e2e/file-tree.spec.ts) 落地（E2E-3a/3b/3c，见 [02-panels-sidebar.md §8.3](./02-panels-sidebar.md)）。复用 gotoFileTree helper。

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
- 文件树入口：[02-panels-sidebar.md](./02-panels-sidebar.md)（点文件 → drawer detail）
- XSS 安全约束：C-state-13（[docs/constraints.json](../constraints.json)）

---


> 覆盖：⌘K 全局搜索浮层（SearchModal）—— 唤起 / 空查询 recents / 四类分组查询 / 键盘导航 / Tab 切类 / 选中跳转 / loading·error 态 / WS 超时容错
>
> 先读 [00-overview.md](./00-overview.md) 理解双轨制和公共前置。
>
> **迁移说明（2026-09-11）**：本功能实现已迁至 `packages/core/src/domain/new-task-search/`，浮层组件为 `packages/ui/src/overlays/SearchModal.vue`。renderer 侧同名 composable（`useSearch` / `useSearchJump` / `useRecents` / `useCommandRegistry`）是迁移后的历史死代码，已于 2026-09-11 随 renderer 过度设计清理删除。本文档中的实现路径与测试路径均按迁移后的 core/ui 位置书写；行为场景（唤起 / 空查询 recents / 四类分组 / 键盘导航 / Tab 切类 / 选中跳转 / loading·error / WS 超时）与设计约束不变。

## 1. 功能概述

SearchModal 是 ⌘K 唤起的跨项目全局搜索浮层，四类分组（命令/文件/符号/会话）：

```
⌘K 唤起 → 空查询显 recents（localStorage）+ 建议命令
输入查询（debounce 120ms）→ useSearch 编排 4 源（命令内存/file WS/session WS/recents）
  → matchFilter 子串过滤 → 四类分组渲染（符号占位 D-001）
↑↓ 键盘导航 / Tab 切类（P2）/ Enter 选中 → useSearchJump 跳转（命令执行/文件预览/会话切换）
跳转成功关浮层 + 写 recents；失败 toast + 浮层保持打开（AC-6.7）
Esc / 再按⌘K / 点遮罩关闭
```

**架构分层**（D-026：编排归 composable，非 domain；2026-09-11 起实现在 core `new-task-search` 域）：
- `packages/core/src/domain/new-task-search/match-engine.ts`（纯函数：matchFilter 过滤 + segments 高亮）
- `packages/core/src/domain/new-task-search/search.ts`（`useSearch`：编排 4 源 + loadSeq 守卫 + WS 超时 race #17）
- `packages/core/src/domain/new-task-search/search-jump.ts`（`useSearchJump`：跳转 type switch 分发）
- `packages/core/src/domain/new-task-search/recents.ts`（`useRecents`：localStorage + FIFO）
- `packages/core/src/domain/new-task-search/command-registry.ts` + `command-store.ts`（`useCommandRegistry` 应用命令 + slash 聚合 / pendingSlash 通道）
- `packages/ui/src/overlays/SearchModal.vue`（UI 交互 + 键盘导航 + 渲染；SearchDeps 端口注入，壳组装在 `packages/renderer/src/composables/features/search/useSearchModalDeps.ts`）

## 2. 组件结构概述

`SearchModal.vue`（`packages/ui/src/overlays/`，容器 `data-testid="search-modal-root"`，reka-ui Dialog portal 到 body）分输入区与结果区。输入区为 `search-input`（v-model=query + keydown 导航）；结果区按状态切换：loading 态（`search-loading`，查询 >200ms 才显示，AC-8.1 防闪烁）、分组渲染（`search-section-{label}` 内 `search-item-{idx}`，item 带 role=option + aria-selected，含类型图标、title + `<mark>` 高亮（segments 命中段）、sub 副文本、Clock 图标仅空查询 recents 项）、空态（`search-empty`，分「recents 库空」与「查询无结果」两种文案）。

## 3. data-testid 清单

testid 以组件 template 内 data-testid 属性为准（均在 `packages/ui/src/overlays/SearchModal.vue`，已核实有效）。

| testid | 触发/可见条件 |
|--------|--------------|
| `search-modal-root` | 恒显（open=true 时，Dialog portal 到 body） |
| `search-modal-overlay` | 恒显（遮罩层） |
| `search-input` | open=true 时（Dialog 默认聚焦） |
| `search-loading` | 查询耗时 >200ms 时（AC-8.1 防闪烁） |
| `search-section-{label}` | 分组渲染时（label=命令/文件/符号/会话/最近/建议命令） |
| `search-item-{idx}` | 分组项渲染时（idx=跨组扁平序号） |
| `search-empty` | total=0 时（recents 库空 或 查询无结果） |

> **Portal 注意**：reka-ui Dialog 通过 `DialogPortal` teleport 到 `<body>`，脱离 Sidebar 的 stacking context。E2E/集成测试查询不要限定在 Sidebar 容器内，用 `document.body.querySelector` 或 `new DOMWrapper(document.body)`（参考 [00 §6.4](./00-overview.md)）。

## 4. 调用链

### 唤起 + 空查询（功能1）
```
Sidebar keydown ⌘K → searchOpen toggle（AC-7.1）
  → SearchModal watch(open=true) → loadResults('') → useSearch.query('', ctx)
    → useRecents.read()（localStorage 'xyz-agent:search-recents'）
    → useCommandRegistry.list()（应用命令 + slash）
    → 返回 [最近, 建议命令] 分组
  → 渲染 segments(title, '')（空查询不高亮，Clock 图标标 recents）
```

### 查询四类分组（功能2，核心编排）
```
Input 输入 → watch(query) debounce 120ms（AC-7.15）→ loadResults(q)
  → useSearch.query(q, ctx)
    → seq = ++loadSeq（BC-9 守卫）
    → Promise.allSettled([
        queryCommandSource(),          // 内存：useCommandRegistry.list()
        queryFileSource(sid),          // WS：缓存优先，未命中 composer.getFileCandidates + #17 超时 race
        querySessionSource(),          // WS：session.list + #17 超时 race
      ])
    → seq !== loadSeq → 丢弃旧响应（BC-9）
    → matchFilter(合并候选, q) → groupByType（符号占位 D-001）
  → 渲染 segments(title, q)（命中段 <mark> 高亮）
```

### 选中跳转（功能3）
```
Enter / click → confirmSel → useSearchJump.confirm(item, ctx)
  → type switch:
      command → AppCommand.action() 或 injectSlash（slash 注入 composer）
      file → fileApi.read（AC-6.9 直调不经吞错层）→ 成功后 fileTreeStore.selectFile 触发 useDetailPane watch
      session → sessionApi.list 反查 id → useSidebar.selectSession
      symbol → 占位不跳转（D-001）
  → 成功：{ok:true} → 关浮层 + useRecents.write
  → 失败：{ok:false} → toast + 浮层保持打开（AC-6.7）
```

### 生命周期 + 并发守卫（功能4）
```
watch(open=false) → 清 query/selIdx/errorMsg + clearTimeout(debounce/loading)（AC-7.14, MR-7.1 孤儿查询守卫）
close 触发 query='' → watch(query) debounce → loadResults，但 open flag 已 false → 实际不发 WS（useSearch 内 loadSeq 守卫 + SearchModal 已卸载）
组件卸载 → onUnmounted clearTimeout（AC-8.4）
```

## 5. MOCK 模式测试（vitest 集成）

**运行命令**（分包运行，cwd 敏感）：
```bash
cd packages/ui && npx vitest run src/overlays/__tests__/search-modal.test.ts   # 浮层集成（mount SearchModal，mock SearchDeps）
cd packages/core && npx vitest run src/domain/new-task-search/__tests__        # 搜索域单测（search/search-jump/recents/command-registry/command-store/file-match/match-engine）
cd packages/renderer && npx vitest run src/__tests__/lib/match-engine.test.ts  # renderer 侧仍保留：core 纯函数导出契约（import from @xyz-agent/core）
```

### 测试矩阵（47 条，对应 execution-plan 验收清单）

**单元测试（composable/lib/store，mock 依赖）**：

| 用例 | 文件 | 测试执行层 | 覆盖点 |
|------|------|----------|--------|
| T1.8/T1.9/T1.16/T1.17/T1.18 | `packages/core/src/domain/new-task-search/__tests__/recents.test.ts`（8 测）| unit | recents 空库/持久化/脏数据降级/配额满/FIFO |
| T2.4/T2.5 | `packages/core/src/domain/new-task-search/__tests__/command-registry.test.ts`（4 测）+ `command-store.test.ts`（8 测）| unit | 命令注册表聚合/物理隔离/同名不撞/无 session |
| AC-1.1~1.4 | `packages/core/src/domain/new-task-search/__tests__/match-engine.test.ts`（10 测）| unit | matchFilter/segments 纯函数 + 边界 |
| T1.10/T1.12/T2.1/T3.1~3.5/T3.9/T4.1/T4.2/T4.4~4.9/T5.1/T5.2 | `packages/core/src/domain/new-task-search/__tests__/search.test.ts`（16 测）| unit | 编排/loadSeq/缓存/WS 超时 race/DTO 映射 |
| T2.2/T2.3/T2.6/T2.7/T3.4/T3.6/T4.3/T4.6/T4.7/T5.3 | `packages/core/src/domain/new-task-search/__tests__/search-jump.test.ts`（13 测）| unit | 跳转分发/异常恢复/AC-6.9 直调 |

**集成测试（mount SearchModal，mock composable，查 document.body）**：

| 用例 | 文件 | 覆盖点 |
|------|------|--------|
| T1.15 | `packages/ui/src/overlays/__tests__/search-modal.test.ts`（25 测）| 首屏冒烟（渲染 gate DoD）|
| T1.1/T1.2/T1.3/T1.4 | | 唤起/空查询/↑↓导航/选中态 |
| T1.6/T1.7/T1.11 | | 关闭/mark 高亮/未找到 |
| T1.13/T1.14/T3.7/T3.8/T5.4 | | open/close 竞态/孤儿守卫/loading 防闪烁/容错 |
| T1.5 | | Tab 切类（AC-9.1~9.4，P2）|

**live 等价覆盖合计 84 测**（8 + 12 + 10 + 16 + 13 + 25）；原 execution-plan 基线 86 测为迁移前 renderer 口径，已随实现迁移失效。**口径注**：84 仅合计上表矩阵映射的文件；搜索域另有 `file-match.test.ts`（12 测，TC-9 系列，见 TEST-STRATEGY 基线行）与 renderer 侧 `__tests__/lib/match-engine.test.ts`（15 测，core 纯函数导出契约测试，见上方运行命令）不在本合计内。

> 测数为 2026-09-11 各 live 文件实测 `it()` 计数（`packages/core/test-results/vitest-junit.xml` / `packages/ui` vitest 输出）。用例 ID（T#/AC-#）沿用 2026-06-30 execution-plan 编号作为验收追溯锚点；迁移后 core 侧按 `TC-#` 组织，ID 与 TC 编号的逐条映射未重建。

### 关键测试桩（高风险用例）

- **T4.8 WS 断连超时 race**：mock `composer.getFileCandidates` 返回 `new Promise(()=>{})`（永不 settle，模拟 WS 断连 pending），`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(10001)` 推进 10s → withWsTimeout 触发 reject → allSettled settle → 不永久挂死。**禁止用立即 reject mock**（掩盖永不 settle 路径）
- **T1.12 loadSeq 守卫**：第一次 query 慢（永不 resolve），第二次快速 query → 第一次旧结果不覆盖
- **T3.9 stale cache**：断言 useSearch 初始化时 `useFileSearch().setupInvalidation` 被调用（AC-4.10 自绑失效）
- **T3.7/T3.8 loading 防闪烁**：fake timers 控制查询延迟 >200ms / <200ms

### 三视角覆盖核验

| 视角 | 覆盖 | 用例 |
|------|------|------|
| 构建者（白盒）| composable 单测验 API 契约/状态机 | useSearch/useSearchJump/useRecents 全部 |
| 使用者（黑盒）| mount SearchModal 验用户旅程 DOM | search-modal 集成测（T1.1~T1.15）|
| 观察者（形态）| 首屏冒烟 + 渲染断言 | T1.15（search-modal-root/input 存在）|

## 6. 非 MOCK 模式测试（手工冒烟）

> **铁律**：MOCK 轨测试全绿 ≠ 功能可用。search 改了 SearchModal + 新增 5 个 composable/lib/store，必须手工 `pnpm run dev` 确认模块加载健康（[00 §1.3](./00-overview.md) dev 冒烟闸门）。

```bash
pnpm dev    # 非 MOCK 轨，起 runtime + pi
```

手工冒烟清单（dev 启动后）：
1. ⌘K 唤起浮层 → 输入框聚焦，显 recents（首次为空显引导文案）
2. 输入查询（如 'session'）→ 显四类分组，命中段高亮
3. ↑↓ 键盘导航 → 选中态转移
4. Enter 选中文件 → DetailPane 打开预览（验证 fileApi.read + selectFile 接线）
5. Enter 选中会话 → active session 切换（验证 sessionApi.list 反查 + selectSession）
6. Esc 关闭 → 浮层消失
7. 再按 ⌘K → toggle 关闭（AC-7.1 变更项）
8. **模块加载健康**：dev console 无 `node:path.relative` 类错误（test-strategy §1.1 MOCK 盲区）

## 7. Playwright E2E

**当前状态**：已落地 [`e2e/search-modal.spec.ts`](../../e2e/search-modal.spec.ts)（覆盖 ⌘K 唤起 / 空查询 recents / 四类分组 / 键盘导航 / slash 注入等，以 spec 实际内容为准）。

**E2E 价值**（test-strategy 双轨制要求）：验证「⌘K 唤起 → 输入 → 选中 → 跳转」全链路用户旅程，覆盖 composable 间接线完整性（useSearch→useSearchJump→useSidebar/selectFile）。

实现要点：search 是浮层（portal 到 body），查询不限定 Sidebar 容器；跳转验证依赖 DetailPane/DrawerPanel 的 testid（见 [02-panels-sidebar.md](./02-panels-sidebar.md)）。

## 8. 已知缺口（非阻断）

| 缺口 | 影响 | 缓解 | 优先级 |
|------|------|------|--------|
| `registerApp` 无调用方 | 应用命令区运行时为空，搜索「命令」分组只显 slash 命令 | 测试用 mock 覆盖；功能不崩溃；slash 命令源工作 | P3（需产品决策命令清单）|
| AC-10.1 未完全通用化 | Sidebar keydown 用本地 keymap 数组（未走 useCommandRegistry）| 硬编码 if/else 字面消除；⌘K toggle 已落地 | P3（需独立 keymap 注册表 + shortcut DSL）|
| dev 冒烟闸门待建 | MOCK 全绿≠可用（模块加载盲区）| 手工 `pnpm run dev` 冒烟（见 §6）| 待 scripts/dev-smoke.mjs |
| useSearch 单测 onScopeDispose warn | 测试输出不干净（harness 缺陷）| 生产无 warn（SearchModal setup 提供 scope）；测试全绿 | 低（测试 harness 优化）|

## 9. 设计文档溯源

- 完整设计：`.xyz-harness/2026-06-30-search-modal/`（6 阶段：requirements→architecture→issues→nfr→code-arch→execution）
- 执行计划：`.xyz-harness/2026-06-30-search-modal/execution-plan.md`（5 Wave + 47 条验收清单）
- 决策账本：`.xyz-harness/2026-06-30-search-modal/decisions.md`（D-001~D-027）

---


> extension 通过 GUI 渲染协议推送结构化内容块（`GuiComponent`），前端 `GuiComponentRenderer` 按 `type` 路由到对应 Vue 组件渲染。本手册覆盖 7 种 block type 的单测 + 两条渲染路径的 E2E 验证。
>
> 协议定义见 `packages/extension-protocol/src/core/types.ts`，helper 见 `helpers.ts`。

## 1. 组件与 testid 清单

所有 GUI 组件位于 `packages/ui/src/rendering-protocol/`：路由器 `GuiComponentRenderer.vue` + `primitives/` 下按 type 路由的纯展示组件。testid 以组件 template 内 data-testid 属性为准（下表均已核实有效）。

| testid | 组件 | 所在文件 |
|---|---|---|
| `gui-component-renderer` | GuiComponentRenderer（路由器外壳） | `rendering-protocol/GuiComponentRenderer.vue` |
| `ansi-text` | AnsiText | `rendering-protocol/primitives/AnsiText.vue` |
| `gui-progress-bar` | ProgressBar | `rendering-protocol/primitives/ProgressBar.vue` |
| `gui-stats-line` | StatsLine | `rendering-protocol/primitives/StatsLine.vue` |
| `gui-tab-bar` | TabBar | `rendering-protocol/primitives/TabBar.vue` |
| `gui-card` | Card | `rendering-protocol/primitives/Card.vue` |
| `gui-columns` | Columns | `rendering-protocol/primitives/Columns.vue` |
| `gui-list-tree` | ListTree | `rendering-protocol/primitives/ListTree.vue` |
| `tool-block-header` | Block tool 块 header（点击展开） | `features/chat/Block.vue` |
| `drawer-tab-{key}` | DrawerPanel tab 按钮（key=terminal/browser/git/doc/detail） | `features/drawer/DrawerPanel.vue` |

## 2. 渲染路径概述

两条渲染路径都收敛到 `GuiComponentRenderer` 按 `BUILTIN_MAP[type]` 路由到具体 primitive 组件：

- **路径 B（消息流）**：extension tool 返回 `details.__gui__` → runtime event-adapter 随 `message.tool_call_end` 下发 → 前端把 details 存入 toolCall → `Block.vue` 的 guiComponent computed 提取组件 → GuiComponentRenderer 渲染。
- **路径 A（SideDrawer widget）**：extension 调 `ctx.ui.setWidget(key, [NUL_MARKER + JSON])` → runtime event-adapter 检测 marker、JSON.parse 并 isGuiComponent 校验 → 以 `extension:widgetGui` 帧下发 → 前端 dispatchSession 后由抽屉容器消费，按 widgetKey 挂到对应 tab → GuiComponentRenderer 渲染。

Mock 模式跳过 runtime event-adapter：`run-send-stream.ts` 直接 `pushSession` 推已解码的 `extension:widgetGui`。

## 3. MOCK 测试（vitest 单测）

单测统一在 `packages/ui/src/rendering-protocol/__tests__/`（GuiComponentRenderer + 各 primitive + PrimitiveRouter），覆盖 7 种 type 的组件级渲染 + 边界条件（递归/嵌套/depth/status 映射/降级）。以目录内实际测试文件为准。

运行：`cd packages/ui && npx vitest run src/rendering-protocol/__tests__/`

## 4. Playwright E2E 测试

**Spec 文件**：`e2e/gui-components.spec.ts`（已落地）

### 4.1 公共前置

- Mock 轨：`VITE_MOCK=true` + `XYZ_MOCK=1`（launch-app fixture 自动设置）
- 使用 `e2e-files` session（有文件树 + 可发消息）
- mock `run-send-stream` 推送序列含 `tool_call_end(details.__gui__)` + `extension:widgetGui × 2`

### 4.2 用例

| ID | 场景 | 关键断言 |
|---|---|---|
| E2E-GUI-1 | harness smoke | app 加载首窗口 + sidebar 会话按钮可见 |
| E2E-GUI-2 | 路径 B: tool result `__gui__` → card 嵌套渲染 | `gui-card` + `gui-progress-bar` + `gui-stats-line` 可见，含 'CI Pipeline'/'build'/'7'/'8'/'turns'/'15' |
| E2E-GUI-3 | 路径 A: widgetGui stats-line → terminal tab | `gui-stats-line` 在 SideDrawer 内可见，含 'turns'/'tokens'/'duration' |
| E2E-GUI-4 | 路径 A: widgetGui list-tree → browser tab | `gui-list-tree` 在 SideDrawer 内可见，含 'Deploy'/'VPC'/'RDS'/'Redis' |

### 4.3 每步期望输入输出

#### E2E-GUI-2: 路径 B（tool result __gui__）

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 激活 s3 session（'API 性能优化'） | `composer-box` 可见 |
| 2 | 输入 'GUI 测试' + Enter | stop-btn 出现 → 消失（流式完成） |
| 3 | 点击 `.turn-meta` | 展开 turn trace（完成后默认收起） |
| 4 | 点击 `tool-block-header` | tool 块展开 |
| 5 | 断言 `gui-card` | 可见，含 'CI Pipeline' |
| 6 | 断言 `gui-progress-bar` | 可见，含 'build' '7' '8' |
| 7 | 断言 `gui-stats-line` | 可见，含 'turns' '15' |

#### E2E-GUI-3: 路径 A（widgetGui stats-line）

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1-2 | 同 E2E-GUI-2 | 流式完成 |
| 3 | 点 `drawer-toggle` | SideDrawer 打开（默认 terminal tab） |
| 4 | 断言 SideDrawer 内 `gui-stats-line` | 可见，含 'turns' 'tokens' 'duration' |

#### E2E-GUI-4: 路径 A（widgetGui list-tree）

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1-2 | 同 E2E-GUI-2 | 流式完成 |
| 3 | 点 `drawer-toggle` | SideDrawer 打开 |
| 4 | 点 `drawer-tab-browser` | 切到 browser tab |
| 5 | 断言 SideDrawer 内 `gui-list-tree` | 可见，含 'Deploy' 'VPC' 'RDS' 'Redis' |

### 4.4 运行命令

```bash
pnpm run build:e2e                              # 构建 E2E 产物
npx playwright test e2e/gui-components.spec.ts # 只跑 GUI 组件 E2E
npx playwright test                            # 跑全部 E2E
```

## 5. 已知约束

- **SideDrawer 打开方式**：通过 PanelHeader 的 `drawer-toggle` 按钮打开（always-visible，不依赖 git 仓库）。默认显示 terminal tab。
- **widgetGui 是瞬态的**：不持久化到 message store，session 切换 / 组件卸载后清除。只有 tool result `__gui__` 在历史重放后仍存在。
- **Card/Columns 递归**：通过 `<GuiComponentRenderer v-for :component>` 中转递归，不自己处理 type 路由。
- **ListTree 自递归**：`<ListTree :items="children" :depth="depth+1">` Vue 组件自递归渲染子节点，depth 自动 +1 传递缩进。

---


> 覆盖范围：侧边栏 SegmentedTab 的 Agents/Flows 两个新 tab；subagent 列表加载、卡片渲染、点击进入对话流、返回主 session；workflow 空态占位。
>
> 先读 [00 总览](00-overview.md) 了解双轨制和三视角模型。执行计划原见 test-plan-subagent-workflow.md（已退役，git 历史 `eb884da68` 前版本可查）。

## §1 功能概述

### 主流程概述

Agents tab 激活时前端经 `session.getSubagents` WS RPC 请求 runtime；runtime 读取主 session JSONL，提取 subagent 工具调用/结果/bg-notify 组装 `SubagentRecord[]` 返回，前端渲染卡片列表。点击 subagent 卡片后，前端保存原 session id，经 `session.getSubagentHistory` 拉取 subagent JSONL 转为 `Message[]`，hydrate 到 `subagent:<id>` 虚拟 session 并切换 Panel 渲染对话流；点击返回则恢复原 session。

Workflow tab 当前仅为空态占位（无后端逻辑）。

### 架构分层

| 层 | 文件 | 职责 |
|---|---|---|
| 展示组件 | `SubagentList.vue` | 渲染 SubagentRecord[] 卡片，点击 emit select |
| 展示组件 | `SegmentedTab.vue` | 4 tab 等宽均分 + badge 点 |
| Store | `stores/subagent.ts` | subagent 视图状态（原 useSubagentView composable 已并入 store 层） |
| Store | `stores/sidebar.ts` | `activeTab` 状态（sessions/files/subagents/workflows） |
| Mock domain | `packages/core/src/transport/mock/index.ts` | 返回空数组（mock 无真实 subagent 数据） |
| Runtime extractor | `services/session/subagent-extractor.ts` | 解析主 session JSONL → SubagentRecord[] |
| Runtime service | `packages/runtime/src/services/session/` | getSubagents/getSubagentHistory |

## §2 组件结构概述

`Sidebar.vue` 的 SegmentedTab 含 4 个等宽 tab（会话/文件/Agents/Flows，Agents tab 带 subagentCount badge 点）。Agents tab 激活时渲染 `SubagentList.vue`（容器 `data-testid="subagent-list"`）：有记录时渲染卡片列表（`subagent-card`，含 running 态 spinner `subagent-card-spinner`、状态点、agent 名、id 前缀、turns/tokens/elapsed summary、task 描述）；无记录时渲染 `subagent-list-empty` 空态（Bot 图标 +「暂无后台任务」引导文案），另有加载失败/加载中态（`subagent-list-error` / `subagent-list-loading`）。Flows tab 激活时渲染 `workflow-list-empty` 空态占位。

Panel 层：进入 subagent 视图时 PanelHeader 显示返回入口 + subagent label（`${record.agent} · ${subagentId 前缀}`），MessageStream 以 `subagent:<id>` 虚拟 sessionId 透明复用，无需特殊处理。

## §3 data-testid 清单

testid 以组件 template 内 data-testid 属性为准（下表均已核实有效）。

| testid | 所在组件 | 触发/可见条件 |
|--------|---------|--------------|
| `subagent-list` | SubagentList.vue | Agents tab 激活时（恒定，容器） |
| `subagent-card` | SubagentList.vue | `subagents.length > 0`，每条记录一个 |
| `subagent-card-spinner` | SubagentList.vue | `record.status === 'running'` |
| `subagent-list-empty` | SubagentList.vue | `subagents.length === 0` |
| `subagent-list-loading` / `subagent-list-error` / `subagent-list-retry` | SubagentList.vue | 加载中 / 加载失败 / 重试按钮 |
| `workflow-list-empty` | Sidebar.vue | workflows tab 激活时（恒定） |
| `file-view-no-session` | Sidebar.vue | files tab + 无 active session |

> 注：PanelHeader 现无 `subagent-back-btn` / `panel-session-spinner` testid（v6 重构后已移除），返回入口与加载态需用文本/角色锚点。

**状态点 CSS 类**（非 testid，但测试可检查）：
- `bg-success` — done 状态（绿色圆点）
- `bg-danger` — failed 状态（红色圆点）
- `bg-accent` — running 或未知（accent 色）
- `bg-subtle opacity-50` — cancelled（灰色）

## §4 关键链路概述

- **加载列表**：Sidebar watch activeTab + activeId，tab 为 subagents 时经 `session.getSubagents` RPC → runtime 定位 session 文件 → extractor 解析 JSONL（提取 toolCalls / toolResults / bgNotifies / listItems）组装 `SubagentRecord[]` 回包 → 前端更新列表与 badge。
- **选中 subagent**：卡片 emit select → 记录原 session id → 经 `session.getSubagentHistory` 拉取 subagent JSONL 转 `Message[]` → `chatStore.hydrate('subagent:<id>', messages)` → Panel 切到虚拟 session 渲染。
- **返回主 session**：恢复原 sessionId，Panel header 与消息流还原。

### sessionFile 后备查找（background 模式）

background 模式 subagent 的 sessionFile 可能为 null（bg-notify 不带 sessionFile，listResponse 可能缺失）。extractor 的后备优先级：

1. `listItem.sessionFile`（listResponse.items 中匹配的）
2. `toolResult.sessionFile`（bgResponse 返回的，通常 null）
3. `findSubagentSessionFile(mainCwd, startedAt)`：扫描 getSubagentSessionDir 下的 sessions/*.jsonl，从文件名解析时间戳，匹配 startedAt ±60s 窗口内最近的文件

## §5 MOCK 模式测试（vitest 集成）

mock 层 `getSubagents` 返回空数组，故 mock 轨只能测空态。已有 vitest 单测覆盖组件交互逻辑。

**运行命令**（cwd 敏感）：

```bash
cd packages/renderer && npx vitest run src/__tests__/sidebar/SegmentedTab.spec.ts
cd packages/renderer && npx vitest run src/__tests__/sidebar/SubagentList.spec.ts
cd packages/runtime && npx vitest run test/subagent-extractor.test.ts
cd packages/runtime && npx vitest run test/subagent-service.test.ts
```

**测试矩阵**：

| 用例 | 文件 | 层 | 覆盖点 |
|------|------|---|--------|
| SegmentedTab 4 tab 渲染 | `SegmentedTab.spec.ts` | 集成 | 4 个 Button 存在 + label/title |
| 计数显示 | `SegmentedTab.spec.ts` | 集成 | count > 0 显示数字 |
| badge 显示/隐藏 | `SegmentedTab.spec.ts` | 集成 | subagentCount > 0 → 蓝点 |
| 点击 tab 触发 | `SegmentedTab.spec.ts` | 集成 | emit update:modelValue |
| encodeCwd 各平台 | `subagent-extractor.test.ts` | 单元 | mac/win/linux 路径编码 |
| 同步提取 | `subagent-extractor.test.ts` | 单元 | syncResponse → status/turns/tokens |
| 后台提取 + bg-notify | `subagent-extractor.test.ts` | 单元 | bgResponse + bg-notify 合并 |
| sessionFile 后备查找 | `subagent-extractor.test.ts` | 单元 | null → 扫描目录匹配时间戳 |
| 空文件/不存在 | `subagent-extractor.test.ts` | 单元 | 返回 [] |
| SubagentList 卡片渲染 | `SubagentList.spec.ts` | 集成 | 卡片 DOM + 文本 |
| 空状态渲染 | `SubagentList.spec.ts` | 集成 | subagent-list-empty |
| 点击卡片 select | `SubagentList.spec.ts` | 集成 | emit select(subagentId) |
| spinner 显示 | `SubagentList.spec.ts` | 集成 | running → Loader2 |

### 三视角覆盖核验

| 视角 | 覆盖用例 |
|------|---------|
| 构建者（白盒） | encodeCwd / extractor 数据组装 / service 路由 |
| 使用者（黑盒 DOM） | 卡片渲染 / 空态渲染 / 点击 select / 返回按钮 |
| 观察者（首屏冒烟） | SegmentedTab 4 tab 存在 / SubagentList 容器存在 |

## §6 非 MOCK 模式测试（real-track 手工 E2E）

**铁律：MOCK 全绿 ≠ 功能可用。** mock 层 subagent 返回空数组，必须连真实 runtime 验证。

### 测试通道

```
pnpm dev → Electron (--remote-debugging-port=9222)
  → browser-automation pw.js connectOverCDP
  → Playwright 操作 renderer
```

### 手工冒烟清单

| 步骤 | 操作 | 期望 |
|------|------|------|
| R-1 | 启动 `pnpm dev`，等 Electron 窗口渲染 | CDP 9222 可连，首窗加载 session 列表 |
| R-2 | 点 sessions tab → 选 chat_project cwd 的 session | session 激活，panel 显示对话流 |
| R-3 | 点 Agents tab | 列表加载，出现 subagent 卡片 |
| R-4 | 检查卡片内容 | agent=general-purpose，status=done（绿点），task 描述可见 |
| R-5 | 点 subagent 卡片 | panel 切换到对话流，header 显示返回按钮 + subagent label |
| R-6 | 点返回按钮 | panel 恢复原 session |
| R-7 | 点 Flows tab | 空态「暂无工作流」 |
| R-8 | 切到无 subagent 的 session → Agents tab | 空态「暂无后台任务」 |
| R-9 | devtools console 无报错 | 无 `Cannot read property` / `WebSocket` 类错误 |

### 详细执行步骤

详细执行计划原见 test-plan-subagent-workflow.md（已退役，git 历史 `eb884da68` 前版本可查，含完整命令和断言）。

## §7 Playwright E2E（real-track CDP）

**当前状态：⚠️ 手工执行（非 spec 脚本自动化）**

mock 轨的 Playwright E2E（`e2e/*.spec.ts`）无法覆盖本功能——mock 层返回空数组。real-track 的 Playwright 自动化需要连真实 runtime，现有 `launch-app-real.ts` fixture 仅用于 workspace 持久化测试，不包含 subagent 场景的 session 数据准备。

**手工 E2E 价值**：验证完整数据链路（runtime JSONL 解析 → WS RPC → 前端渲染 → 用户交互），是 mock 单测不可替代的。

**执行方法**：通过 browser-automation skill 的 `pw.js` 连接 dev app CDP 端口，逐用例操作 + 断言。具体命令见 test-plan 文档。

### 未来 spec 自动化方向

若要做成 `npx playwright test` 自动化 spec，需要：
1. 准备一个含 subagent 工具调用的 fixture session JSONL 文件
2. real-track fixture 启动时把 fixture 拷入临时数据目录
3. spec 中 activateSession → 切 tab → 断言

当前因 dev 数据目录已有真实数据且数据准备复杂度高，优先用手工 CDP 验证。

## §8 已知缺口

| 缺口 | 影响 | 缓解 | 优先级 |
|------|------|------|--------|
| mock getSubagents 返回空数组 | mock E2E 无法测列表渲染 | 手工 real-track CDP 测试 | P2 |
| 无自动化 real-track spec | CI 不跑 subagent E2E | 手工冒烟清单 + vitest 单测保底 | P2 |
| workflow tab 无后端逻辑 | 无法测 workflow 数据渲染 | 当前为空态占位，Phase 3 补充 | P3 |
| subagent badge 只按 count 判断 | running 状态不够精确 | 后续按 status 判断（代码注释已标注） | P3 |
| 实时流式未接入 | 后台 subagent 完成不会实时更新列表 | 需刷新 tab 重拉，Phase 2 补 bg-notify WS 推送 | P2 |

## §9 设计文档溯源

- 类型定义：`packages/shared/src/subagent.ts`
- 协议扩展：`packages/shared/src/protocol.ts`（session.getSubagents/session.getSubagentHistory）
- 路径推导：`packages/runtime/src/infra/pi/pi-paths.ts`（encodeCwd/getSubagentSessionDir）
- 提取逻辑：`packages/runtime/src/services/session/subagent-extractor.ts`
- 历史 DRY：`packages/runtime/src/services/session-history.ts`（getHistoryFromFilePath）

---


> 覆盖：plugin 区「后台命令」L2 视图（BackgroundTaskListView：三桶筛选 + 两行式 item + 行内两段式终止）与 drawer bashTask tab（BackgroundTaskDetailPanel：元信息 / 输出跟随 / 终止）。
>
> 设计：[background-task-sidebar-view.md](../architecture/background-task-sidebar-view.md)（§3.1 终态 / D4-D7 / D10）。先读 [00 总览](00-overview.md)。

## §1 功能概述

AI 把 bash 命令转后台执行后，任务落在 per-session registry.json。本功能提供用户可见可控面：

- **列表**（Sidebar plugins tab →「后台命令」L2 tab）：三桶筛选（运行中/已结束/全部 + 计数，默认运行中）、两行式 item（状态 icon + 命令 + 耗时 / pid · exit）、running 行行内两段式终止（✕ → ✓）、点击行开 drawer；
- **drawer 详情**（bashTask tab，第 8 tab）：命令全文（可复制）、元信息行（taskId · pid · 开始 · 时长 · exit · reason）、输出尾部（running 时 2s 跟随）、两段式终止按钮 + 回执分支 toast。

数据链路：runtime `BackgroundTaskService` 直读 registry（拉取 RPC + 变更广播），renderer `useBackgroundTasks` per-session 分区。测试框架（vitest 用例）见 `packages/renderer/src/__tests__/components/background-task-list-view.test.ts` 与 `background-task-detail-panel.test.ts`。

## §2 组件结构概述

列表侧：`PluginViewContainer.vue`（NATIVE_VIEWS 路由，viewId='background-tasks'）挂 `BackgroundTaskListView.vue`（容器 `background-task-list`）：全量空态 `bg-task-empty`；有任务时渲染三桶筛选槽 `bg-task-filterbar`（`bg-task-filter-active|ended|all`，`data-active` 标当前桶）与 ScrollArea 列表——运行中空桶 `bg-task-bucket-empty`（含「查看全部」`bg-task-view-all`）、已结束空桶 `bg-task-bucket-empty-ended`、任务行 `bg-task-item`（点击开 drawer；行内含「全部」桶分段边界 `bg-task-group-divider`、状态 icon `bg-task-icon`、pid·exit 第二行 `bg-task-meta`、running 行行内两段式终止按钮 `bg-task-kill`→确认态切换为 `bg-task-kill-confirm`）。另有损坏/断连横幅 `bg-task-corrupt-banner` / `bg-task-disconnect-banner`。

Drawer 侧：`DrawerPanel.vue` tab 栏新增 bashTask 值（`drawer-tab-bashTask`，复用既有 `drawer-tab-{key}` 模板），`PanelContainer.vue` v-if 分支挂 `BackgroundTaskDetailPanel.vue`（容器 `bash-task-detail`）：命令全文 `bash-task-command` + 复制按钮 `bash-task-copy`、元信息行 `bash-task-meta`（状态色点 `bash-task-status-dot` + taskid/pid/started/duration/exit/reason 各 span）、输出区三态互斥（`bash-task-output` 有内容且 running 时 2s 跟随 / `bash-task-output-unavailable` 文件已清理 / `bash-task-output-empty` loaded 且空）、running 时的两段式终止按钮 `bash-task-kill`（`data-armed="true"` 为确认态）。

## §3 data-testid 清单

testid 以组件 template 内 data-testid 属性为准（下表均已核实有效）。

### 列表（BackgroundTaskListView.vue）

| testid | 触发/可见条件 |
|--------|--------------|
| `background-task-list` | 视图挂载时恒显（容器） |
| `bg-task-empty` | 全量空态（loaded 且 0 条；此时不渲染筛选条） |
| `bg-task-filterbar` | 有任务时恒显（三桶筛选槽） |
| `bg-task-filter-active` / `bg-task-filter-ended` / `bg-task-filter-all` | 同 filterbar；`data-active` 标当前桶 |
| `bg-task-bucket-empty` | 「运行中」桶空（含 bg-task-view-all） |
| `bg-task-view-all` | 同上，点击跳「全部」桶 |
| `bg-task-bucket-empty-ended` | 「已结束」桶空（仅文案） |
| `bg-task-item` | 每条任务一个；@click 开 drawer bashTask tab |
| `bg-task-group-divider` | 仅「全部」桶 active/ended 段边界处 |
| `bg-task-icon` | 恒显；running 时内部为旋转环，其余为色点 |
| `bg-task-meta` | 恒显（第二行 pid · exit） |
| `bg-task-kill` / `bg-task-kill-confirm` | 仅 running 行 hover 显现；首击变 confirm（常显红底），再击发 kill RPC |
| `bg-task-corrupt-banner` / `bg-task-disconnect-banner` | registry 损坏 / 数据源断连横幅 |

### Drawer 详情（BackgroundTaskDetailPanel.vue）

| testid | 触发/可见条件 |
|--------|--------------|
| `drawer-tab-bashTask` | drawer 打开时 tab 栏内（`drawer-tab-{key}` 模板新值） |
| `bash-task-detail` | 选中任务后（未选中走 DrawerPanel 空态文案） |
| `bash-task-command` | 恒显（命令全文） |
| `bash-task-copy` | 恒显（title 随 copied 态换文案） |
| `bash-task-meta` | 恒显（元信息行容器） |
| `bash-task-status-dot` | 恒显；class 随 bucket SSOT tone |
| `bash-task-meta-taskid` / `-pid` / `-started` / `-duration` | 恒显（duration 文案随 running/终态切换） |
| `bash-task-meta-exit` | 仅 exitCode 非 undefined |
| `bash-task-meta-reason` | 仅终态（orphaned 或 exited+reason） |
| `bash-task-output` | output 拉到且非空（running 时 2s 跟随） |
| `bash-task-output-unavailable` | output 文件丢失/清理（lost） |
| `bash-task-output-empty` | output loaded 但为空 |
| `bash-task-kill` | 仅 running（killing/终态无按钮）；`data-armed="true"` = 确认态 |

### 测试注意

- running 计时用 fake timers（列表 1s tick / drawer 输出跟随 2s interval）；
- 杀进程是 mock RPC，不会真杀——行内终止断言两段式状态机（testid 切换）而非进程消失；
- i18n key 全表见 `packages/renderer/src/i18n/locales/{zh-CN,en-US}/{panel,sidebar}.ts`（`panel.sideDrawer.bashTask*` 21 个 + `sidebar.backgroundTaskList.*` 18 个）；文案断言用 override `t(key)` 注入而非依赖 locale 文件（组件测试既有形态）。

## §4 相关文档

- 设计文档：[background-task-sidebar-view.md](../architecture/background-task-sidebar-view.md)（终态 §3.1 / 筛选 D10 / kill 矩阵 D6 / 输出跟随 D7）
- SideDrawer 宿主：[02-panels-sidebar.md](02-panels-sidebar.md)（bashTask tab 为第 8 tab）
- 侧栏面板范式：[02-panels-sidebar.md](02-panels-sidebar.md)（Agents tab 同构先例）
- 组件测试：`packages/renderer/src/__tests__/components/background-task-list-view.test.ts`（12 用例）/ `background-task-detail-panel.test.ts`（13 用例）
