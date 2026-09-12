# 04 · 文件树（File Tree）测试流程

> 覆盖：全项目文件树懒加载、过滤、git 角标、showIgnored 开关、展开态恢复
>
> 这是**测试覆盖最完整**的功能：11 个 E2E 用例已落地（`e2e/file-tree.spec.ts`）。
>
> 先读 [00-test-strategy-overview.md](./00-test-strategy-overview.md) 理解双轨制和公共前置。

## 1. 功能概述

侧栏「文件」tab 展示当前 session cwd 的完整项目文件树：

```
切到「文件」tab → 加载顶层 + 一级子目录（D-009 懒加载）
点目录展开 → 加载该目录单层（expand，缓存复用）
输入关键词 → 实时过滤节点
点「忽略项」开关 → 显示/隐藏 ignored 节点（node_modules 等）
点文件 → 打开 SideDrawer detail 预览（见 05-side-drawer.md）
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
- SideDrawer detail：[05-side-drawer.md](./05-side-drawer.md)（点文件 → drawer 预览）
