#!/usr/bin/env node
/**
 * P2 半 E2E 验证脚本（自动升级 UI 流程）。
 *
 * 前置：先启动 dev app（带 mock 环境变量）：
 *   TAIJI_DEV_MOCK_UPDATE=1 pnpm dev
 * 等 Electron 窗口起来后（9222 端口可用），另开终端跑此脚本。
 *
 * 流程：
 *   1. 连接 9222 端口的 dev Electron renderer（connectOverCDP，对策 1 不抢焦点）
 *   2. 选 URL 以 http://localhost:1420/ 开头的 page（vite dev server，AGENTS.md §9）
 *   3. 等 sidebar 加载完成
 *   4. 等 35s 让 Sidebar 的 initAutoCheck（AUTO_CHECK_DELAY_MS = 30_000）自动跑一次。
 *   5. 断言 [data-testid="update-button"] 出现（available 态）
 *   6. hover [data-testid="update-available"] → 等 release note 浮层渲染
 *   7. 截图保存到 /tmp/dev-update-e2e-*.png（全页面 + 浮层区域）
 *   8. 断言 release note 浮层含 markdown 渲染的 HTML（<h2>/<code> 标签）
 *
 * 用法：node scripts/dev-mock-update-e2e.mjs
 *
 * 退出码：0=全部通过，非 0=失败（任一断言不过或连接异常）。
 */
import { chromium } from 'playwright'

const CDP_ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://localhost:9222'
const SCREENSHOT_DIR = '/tmp'
// AGENTS.md §9：renderer 经 vite dev server 加载，固定 http://localhost:1420/。
// 用 startsWith 而非 includes 做严格匹配——避免误连到 URL 里「碰巧含 localhost:1420 子串」
// 的非 dev 实例（如别的应用挂了带该子串的 page），降低脚本误操作风险。
const VITE_URL_PREFIX = 'http://localhost:1420/'
// 渲染等待超时：DOM 挂载 / markdown 渲染（shiki WASM 首次约 1-2s）的上限
const RENDER_TIMEOUT_MS = 15_000
// 自动触发等待：initAutoCheck 30s + 渲染 buffer 5s
const AUTO_CHECK_WAIT_MS = 35_000

/** 简单 pass/fail 日志，累计断言结果用于最终汇总。 */
const results = []
function pass(msg) {
  results.push({ ok: true, msg })
  console.log(`  [PASS] ${msg}`)
}
function fail(msg, err) {
  results.push({ ok: false, msg, err })
  console.error(`  [FAIL] ${msg}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ''}`)
}
function step(n, msg) {
  console.log(`\n[步骤 ${n}] ${msg}`)
}

/** 退出码：任一 fail 则非 0 */
function exitCode() {
  return results.some((r) => !r.ok) ? 1 : 0
}

/**
 * 找到 vite dev server 的 page（renderer）。
 * Electron 主进程自身也有 page，但 URL 不以 http://localhost:1420/ 开头——必须严格按 URL 前缀过滤。
 * 连接后再次断言 URL，防止 CDP 在选 page 与首次操作之间 page 已跳转走（如被关掉或导航到 about:blank）。
 */
async function findRendererPage(browser) {
  const pages = browser.contexts().flatMap((c) => c.pages())
  const renderer = pages.find((p) => p.url().startsWith(VITE_URL_PREFIX))
  if (!renderer) {
    throw new Error(
      `未找到 URL 以 "${VITE_URL_PREFIX}" 开头的 page。` +
        `现有 page URL：${pages.map((p) => p.url()).join(', ') || '(空)'}。` +
        `确认 dev app 已起来且 vite dev server 正常监听 1420。`,
    )
  }
  return renderer
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  自动升级 P2 半 E2E 验证（dev mock releaseChecker）')
  console.log('═══════════════════════════════════════════════════════════')
  console.log(`CDP 端点：${CDP_ENDPOINT}`)

  step(1, `连接 dev Electron renderer（${CDP_ENDPOINT}）`)
  let browser
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT)
  } catch (err) {
    fail(`连接 CDP 端点失败（确认 dev app 已起来：TAIJI_DEV_MOCK_UPDATE=1 pnpm dev）`, err)
    process.exit(exitCode())
  }
  pass(`已连接 CDP（contexts=${browser.contexts().length}）`)

  try {
    step(2, '定位 vite dev server page')
    const page = await findRendererPage(browser)
    pass(`renderer page URL：${page.url()}`)

    step(3, '等待 sidebar 挂载（UpdateButton 容器）')
    // sidebar 是左固定栏，应用挂载后立即可见。等 #app 出现即可。
    try {
      await page.waitForSelector('#app', { timeout: RENDER_TIMEOUT_MS })
      pass('#app 已挂载')
    } catch (err) {
      fail('等待 #app 挂载超时（dev app 可能未正常加载）', err)
      process.exit(exitCode())
    }

    // 连接后断言 page URL 仍是 vite dev server——防止 CDP 在选 page 与首次操作之间
    // page 已被导航走或关闭（如 dev 热重载期间短暂 about:blank）。
    if (!page.url().startsWith(VITE_URL_PREFIX)) {
      throw new Error(`page URL 已偏离 vite dev server，当前：${page.url()}（期望前缀 ${VITE_URL_PREFIX}）`)
    }

    step(4, `等 ${AUTO_CHECK_WAIT_MS / 1000}s 让 initAutoCheck 自动触发`)
    // useAppUpdate 是 module-level 单例，外部脚本无法直接访问 checkForUpdate；
    // 原先的 window.__testTriggerUpdate 钩子从未在源码挂载（永远走不到），故移除该路径，
    // 直接等 Sidebar.initAutoCheck（AUTO_CHECK_DELAY_MS = 30_000）自动跑一次 + 渲染 buffer 5s。
    await page.waitForTimeout(AUTO_CHECK_WAIT_MS)
    pass('自动触发等待完成（initAutoCheck 30s + buffer）')

    step(5, '断言 update-button 可见（state=available）')
    try {
      // available 态会渲染 data-testid="update-available"（hover trigger 按钮）
      await page.waitForSelector('[data-testid="update-available"]', {
        timeout: RENDER_TIMEOUT_MS,
      })
      pass('update-button visible (state=available)')
    } catch (err) {
      fail('update-button 未进入 available 态（检查 mock 是否注入：TAIJI_DEV_MOCK_UPDATE=1 + isDev）', err)
      // 仍继续，截图记录当前状态
    }

    step(6, 'hover update-available → 等 release note 浮层渲染')
    const hoverTarget = await page.$('[data-testid="update-available"]')
    if (hoverTarget) {
      await hoverTarget.hover()
      // HoverCardContent 由 radix-like 机制异步挂载，等带 testid 的容器
      try {
        await page.waitForSelector('[data-testid="update-release-notes"]', {
          timeout: RENDER_TIMEOUT_MS,
        })
        pass('release note 浮层已渲染')
      } catch (err) {
        fail('release note 浮层未渲染（hover 失败或 markdown 渲染挂掉）', err)
      }
    } else {
      fail('找不到 hover target（update-available），跳过浮层验证')
    }

    step(7, '截图保存到 /tmp')
    const fullShot = `${SCREENSHOT_DIR}/dev-update-e2e-full.png`
    await page.screenshot({ path: fullShot, fullPage: true })
    pass(`全页面截图：${fullShot}`)

    const notesEl = await page.$('[data-testid="update-release-notes"]')
    if (notesEl) {
      const popoverShot = `${SCREENSHOT_DIR}/dev-update-e2e-popover.png`
      await notesEl.screenshot({ path: popoverShot })
      pass(`浮层区域截图：${popoverShot}`)
    } else {
      fail('浮层元素不存在，跳过区域截图')
    }

    step(8, '断言 release note markdown 渲染（HTML 含 <h2> + <code>）')
    if (notesEl) {
      const innerHTML = await notesEl.innerHTML()
      const hasH2 = /<h2[\s>]/i.test(innerHTML)
      // 行内 <code> 或代码块 <pre><code> 都算
      const hasCode = /<code[\s>]/i.test(innerHTML)
      if (hasH2) {
        pass('release notes 含 <h2>（markdown 标题已渲染）')
      } else {
        fail(`release notes 缺 <h2>（HTML 片段：${innerHTML.slice(0, 200)}...）`)
      }
      if (hasCode) {
        pass('release notes 含 <code>（markdown 代码块已渲染）')
      } else {
        fail(`release notes 缺 <code>（HTML 片段：${innerHTML.slice(0, 200)}...）`)
      }
    } else {
      fail('浮层元素不存在，跳过 markdown 渲染断言')
    }
  } finally {
    // connectOverCDP 只断开我们的连接，不会关闭 dev app 窗口（对策 1 不抢焦点也不杀进程）
    browser.close().catch(() => {})
  }

  // ── 汇总 ──────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════')
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  console.log(`  汇总：${passed} pass / ${failed} fail`)
  console.log('═══════════════════════════════════════════════════════════')
  process.exit(exitCode())
}

main().catch((err) => {
  console.error('\n[FATAL] 脚本异常退出：', err)
  process.exit(2)
})
