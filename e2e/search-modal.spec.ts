/**
 * 搜索浮层 E2E —— ⌘K 全局搜索 modal 的 Playwright 用户旅程测试。
 *
 * 数据流（复用 W0 harness）：VITE_MOCK=true → SearchModal.useSearch 走 mockApi.search.query，
 * fixture 数据 SEARCH_MOCK（5 命令 / 5 文件 / 4 符号 / 4 会话）+ SEARCH_RECENTS（3 项）。
 * 延迟 TIMING.ack ≈ 40ms。Dialog reka-ui Portal 到 body（test-strategy §6.4），全局查询不限定容器。
 *
 * 覆盖用例（execution-plan §5 测试验收清单 + 三视角）：
 * - SM-E2E-1（首屏渲染 gate / 观察者视角）：⌘K 唤起 → modal DOM 含 input + 初始分组
 * - SM-E2E-2（查询渲染 / 使用者视角）：输入 → 命中分组 + 项 DOM 出现
 * - SM-E2E-3（空结果态）：输入无匹配词 → empty 态 DOM
 * - SM-E2E-4（键盘导航）：↑↓ 选中态切换 + Enter confirm（命令类，mock 不执行真实 action）
 * - SM-E2E-5（Esc 关闭）：Esc → modal DOM 消失
 * - SM-E2E-6（recents 持久化）：confirm 一项 → 重新唤起 → 最近分组含该项
 * - SM-E2E-7（slash 命令注入活跃 composer）：搜 commit → confirm → panel composer 含 commit chip（核心 bug 回归）
 * - SM-E2E-8（slash chip 图标）：搜 review → composer 含 review chip + 星标 svg 图标（icon 透传）
 * - SM-E2E-9（landing 态 slash 注入）：未激活 session → 搜 slash 命令 → landing composer 注入 chip
 * - SM-E2E-10（回归：应用命令 confirm 不注入 chip）：搜新建 → confirm → composer 不出现 slash-chip
 *
 * 三视角覆盖：
 * - 构建者（白盒）：useSearch 编排/matchEngine/useRecents 由 core vitest（`packages/core/src/domain/new-task-search/__tests__/`）覆盖；浮层交互由 `packages/ui/src/overlays/__tests__/search-modal.test.ts` 覆盖（原「vitest 86 用例」为迁移前 renderer 口径，已失效）
 * - 使用者（黑盒）：本 spec 验「用户能否完成搜索→选中→跳转」目标
 * - 观察者（形态）：SM-E2E-1 首屏渲染 gate
 *
 * 运行：npx playwright test e2e/search-modal.spec.ts
 * 重建产物（改 renderer 代码后）：npm run build:e2e
 */
import { test, expect } from './fixtures/launch-app'

/**
 * 激活 session（panel composer 出现）。
 * 侧栏默认 activeTab=sessions，直接等目标 session 可见后点选——不点「会话」segmented tab
 * （icon-only 模式下其 accessible name 被计数徽标文本抢占，定位时序脆弱，详见
 * v6-shell-baseline.spec.ts activateSession 注释）。
 */
async function activateSession(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
  await page.getByText('API 性能优化').click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
}

/**
 * 唤起搜索浮层。
 *
 * 优先点击 sidebar「搜索」按钮（DOM 确定存在，见 error-context 快照）。
 * ⌘K 键盘快捷键在 Playwright/Electron 下合成事件不稳定（Meta+k 偶发不触发 Sidebar keydown listener），
 * 快捷键 listener 的单元覆盖在 vitest 集成测试（search-modal.test.ts SM-7.x）；E2E 用点击确保可靠唤起。
 * Dialog Portal 到 body，等 search-modal-root 可见即浮层已挂载。
 */
async function openSearch(page: import('@playwright/test').Page): Promise<void> {
  // sidebar「搜索 ⌘K」按钮（button name 含「搜索」，正则前缀匹配避开计数后缀）
  await page.getByRole('button', { name: /^搜索/ }).click()
  // Dialog Portal 到 body，等 root 可见（mock 初始查询 TIMING.ack ≈ 40ms）
  await expect(page.getByTestId('search-modal-root')).toBeVisible({ timeout: 5_000 })
  // 等初始结果（recents + 建议命令）渲染——section DOM 出现
  await expect(page.getByTestId('search-input')).toBeVisible({ timeout: 5_000 })
}

test.describe('搜索浮层 E2E', () => {
  test('harness smoke：Electron app 加载首窗口', async ({ page }) => {
    await expect(page).toHaveTitle(/太极|TaiJi/)
  })

  test('SM-E2E-1（首屏渲染 gate）：⌘K 唤起 → modal DOM 含 input + 初始分组', async ({ page }) => {
    await openSearch(page)
    // 输入框存在（使用者视角：能看到输入区）
    await expect(page.getByTestId('search-input')).toBeVisible()
    // 初始分组（空查询 → recents + 建议命令）。mock SEARCH_RECENTS 3 项 + SEARCH_MOCK.command 前 3 建议
    // 注意：首次启动 localStorage 无 recents，recents 分组可能空被过滤；建议命令分组应存在
    // 用 section label 匹配（label 是中文「建议命令」）
    const suggestedSection = page.getByTestId('search-section-建议命令')
    await expect(suggestedSection).toBeVisible({ timeout: 5_000 })
  })

  test('SM-E2E-2（查询渲染）：输入 auth → 命中文件/符号分组', async ({ page }) => {
    await openSearch(page)
    // 输入 auth（mock SEARCH_MOCK.file 含 'auth/session.ts' / symbol 含 'authenticate()'）
    await page.getByTestId('search-input').pressSequentially('auth')
    // 等 mock 查询返回（debounce 120ms + TIMING.ack 40ms）
    // 文件分组出现（label='文件'）
    await expect(page.getByTestId('search-section-文件')).toBeVisible({ timeout: 5_000 })
    // 文件项含 auth/session.ts（mock fixture 数据）
    const fileSection = page.getByTestId('search-section-文件')
    await expect(fileSection).toContainText('auth/session.ts')
  })

  test('SM-E2E-3（空结果态）：输入无匹配词 → empty 态', async ({ page }) => {
    await openSearch(page)
    // 输入一个 mock fixture 中不存在的词
    await page.getByTestId('search-input').pressSequentially('zzzznomatch')
    // 等 debounce + mock 查询返回空
    await expect(page.getByTestId('search-empty')).toBeVisible({ timeout: 5_000 })
    // empty 态文案含查询词（AC-7.13：未找到「xxx」的相关结果）
    await expect(page.getByTestId('search-empty')).toContainText('zzzznomatch')
  })

  test('SM-E2E-4（键盘导航）：↑↓ 选中态切换', async ({ page }) => {
    await openSearch(page)
    // 初始空查询有建议命令（≥3 项），用 ↓ 移动选中
    const input = page.getByTestId('search-input')
    // 等初始结果渲染
    await expect(page.getByTestId('search-section-建议命令')).toBeVisible({ timeout: 5_000 })
    // 初始 selIdx=0（第一项选中，aria-selected=true）
    const firstItem = page.getByTestId('search-item-0')
    await expect(firstItem).toHaveAttribute('aria-selected', 'true')
    // ↓ 移到第二项
    await input.press('ArrowDown')
    await expect(page.getByTestId('search-item-0')).toHaveAttribute('aria-selected', 'false')
    await expect(page.getByTestId('search-item-1')).toHaveAttribute('aria-selected', 'true')
    // ↑ 移回第一项
    await input.press('ArrowUp')
    await expect(page.getByTestId('search-item-0')).toHaveAttribute('aria-selected', 'true')
  })

  test('SM-E2E-5（Esc 关闭）：Esc → modal DOM 消失', async ({ page }) => {
    await openSearch(page)
    await expect(page.getByTestId('search-modal-root')).toBeVisible()
    // Esc 关闭（Dialog 内置 Esc 行为）
    await page.keyboard.press('Escape')
    // modal DOM 消失（Dialog unmount + Portal 清理）
    await expect(page.getByTestId('search-modal-root')).not.toBeVisible({ timeout: 5_000 })
  })

  test('SM-E2E-6（recents 持久化）：confirm 文件项 → 重唤起 → 最近分组含该文件', async ({ page }) => {
    await openSearch(page)
    // 输入 auth 查到文件，Enter confirm（useSearchJump.confirmFile → mock file.read）
    await page.getByTestId('search-input').pressSequentially('auth')
    await expect(page.getByTestId('search-section-文件')).toBeVisible({ timeout: 5_000 })
    // Enter confirm 第一项（selIdx=0，auth/session.ts 排第一）
    await page.getByTestId('search-input').press('Enter')
    // confirm 成功 → modal 关闭（AC-6.7 ok:true 才关）
    await expect(page.getByTestId('search-modal-root')).not.toBeVisible({ timeout: 5_000 })

    // 重新唤起
    await openSearch(page)
    // 最近分组应含刚 confirm 的文件（recents localStorage 持久化 + 当前会话内存态）
    // 空查询初始态 → recents 分组（label='最近'）
    const recentsSection = page.getByTestId('search-section-最近')
    await expect(recentsSection).toBeVisible({ timeout: 5_000 })
    await expect(recentsSection).toContainText('auth/session.ts')
  })

  test('SM-E2E-7（slash 命令注入活跃 composer）：搜 commit → confirm → composer 含 commit chip @p0-smoke', async ({ page }) => {
    // [DIAG-TEMPORARY] CI 定位插桩：4 检查点截图 + main 标题探针（诊断后整体回退）
    const diag = async (n: string): Promise<void> => {
      await page.screenshot({ path: `test-results/sm7-${n}.png` }).catch(() => {})
      console.log(`[sm7-diag:${n}] main-h1=`, await page.locator('main h1').allTextContents(),
        '| composer-count=', await page.getByTestId('composer-box').count(),
        '| chip-count=', await page.getByTestId('composer-box').locator('.slash-chip').count())
    }
    // 前置：激活 session（panel composer 可见）
    await activateSession(page)
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
    await diag('1-activated')

    // 唤起搜索
    await openSearch(page)
    await diag('2-modal')
    // 输入 commit（mock SEARCH_MOCK.command 含 'commit'，commandKind:'slash'，对齐 pi 格式无 / 前缀）
    await page.getByTestId('search-input').pressSequentially('commit')
    // 等命令分组出现 + 含 commit 项
    await expect(page.getByTestId('search-section-命令')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('search-section-命令')).toContainText('commit')
    await diag('3-typed')

    // Enter confirm 第一项（commit 应排前）
    await page.getByTestId('search-input').press('Enter')
    // 搜索浮层关闭（confirm ok:true）
    await expect(page.getByTestId('search-modal-root')).not.toBeVisible({ timeout: 5_000 })
    await diag('4-closed')

    // composer 输入区含 commit chip（slash-chip 内 chip-label 文本）
    const composer = page.getByTestId('composer-box')
    await expect(composer.locator('.slash-chip')).toBeVisible({ timeout: 3_000 })
    await expect(composer.locator('.slash-chip .chip-label')).toContainText('commit')
  })

  test('SM-E2E-8（slash chip 图标）：搜 review → composer 出现 review chip 含星标 svg 图标', async ({ page }) => {
    await activateSession(page)
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })

    await openSearch(page)
    // 输入 review（mock 含 'review'，icon:star，commandKind:'slash'）
    await page.getByTestId('search-input').pressSequentially('review')
    await expect(page.getByTestId('search-section-命令')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('search-section-命令')).toContainText('review')

    await page.getByTestId('search-input').press('Enter')
    await expect(page.getByTestId('search-modal-root')).not.toBeVisible({ timeout: 5_000 })

    // composer 含 review chip + chip 内含 svg 图标（star icon 渲染为 svg 元素）
    const composer = page.getByTestId('composer-box')
    const chip = composer.locator('.slash-chip')
    await expect(chip).toBeVisible({ timeout: 3_000 })
    await expect(chip.locator('.chip-label')).toContainText('review')
    // chip-icon 内含 svg（star 图标渲染为 svg 元素）
    await expect(chip.locator('.chip-icon svg')).toBeVisible()
  })

  test('SM-E2E-9（landing 态 slash 注入）：未激活 session → 搜 slash 命令 → landing composer 注入 chip', async ({ page }) => {
    // 前置：landing 态（默认启动未激活 session，landing composer 可见）
    // landing composer 也有 composer-box testid（Composer.vue 同组件，variant=landing）
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 10_000 })

    await openSearch(page)
    // 输入 commit 搜 slash 命令
    await page.getByTestId('search-input').pressSequentially('commit')
    await expect(page.getByTestId('search-section-命令')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('search-section-命令')).toContainText('commit')

    await page.getByTestId('search-input').press('Enter')
    await expect(page.getByTestId('search-modal-root')).not.toBeVisible({ timeout: 5_000 })

    // landing composer（role=textbox）出现 commit chip
    const composer = page.getByTestId('composer-box')
    await expect(composer.locator('.slash-chip')).toBeVisible({ timeout: 3_000 })
    await expect(composer.locator('.slash-chip .chip-label')).toContainText('commit')
  })

  test('SM-E2E-10（回归：应用命令 confirm 不注入 chip）：搜新建 → confirm → composer 不出现 chip', async ({ page }) => {
    await activateSession(page)
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })

    await openSearch(page)
    // 输入「新建」（应用命令，非 slash）
    await page.getByTestId('search-input').pressSequentially('新建')
    await expect(page.getByTestId('search-section-命令')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('search-section-命令')).toContainText('新建任务')

    await page.getByTestId('search-input').press('Enter')
    // 应用命令走 action（不注入 chip）。confirm 结果可能 ok 或失败（mock action 实现），
    // 关键断言：composer 不出现 slash-chip
    const composer = page.getByTestId('composer-box')
    await expect(composer.locator('.slash-chip')).toHaveCount(0)
  })
})
