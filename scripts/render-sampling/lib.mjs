// 真机渲染采样管道（共享函数库）——基线采集 / 真机验收共用的六环节流水线：
// 连接 CDP → 定位选择器 → 注入样本 → 等待渲染信号 → DOM/截图采样 → 落盘。
// 场景差异只在「注入什么样本」与「采样后断言什么」；本库覆盖与场景无关的部分，
// 场景专属断言由验收脚本自行 import 本库后编写。
//
// 资产纪律见 docs/testing/render-sampling.md（资产清单表 SSOT + closeout 回写/删减规则）。
// 选择器与等待信号均来自真机实测（2026-09 markdown HTML 支持验收沉淀），
// DOM 结构变化导致失效时按 closeout 纪律更新，禁止各场景现场重写管道。

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

/** 默认 composer 输入框选择器：contenteditable 而非 textarea/input——
 *  原生表单元素禁令（前端编码规范）下 fill/click 行为与表单元素不同（须先 click 聚焦）。 */
export const COMPOSER_SELECTOR = '.composer-input[contenteditable="true"]'

/** 新建任务按钮文案（Landing 页入口；文案变化时此处是第一处需更新的落点）。 */
export const NEW_SESSION_BUTTON_TEXT = '新建任务'

/**
 * 连接 dev 实例并定位主页面。CDP 端口来源：
 * `node apps/electron/scripts/dev-instance.mjs --print` 的 banner（实例隔离用
 * --data-dir 时各实例端口互不相同，禁硬编码）。
 *
 * @returns {Promise<{browser, context, page}>} page 为首个匹配 urlPattern 的标签页
 */
export async function connectPage({ cdpPort, urlPattern = 'localhost:1' }) {
  const browser = await chromium.connectOverCDP(`http://localhost:${cdpPort}`)
  const context = browser.contexts()[0]
  if (!context) throw new Error(`CDP ${cdpPort} 无可用 browser context——确认 dev 实例已启动`)
  const page = context.pages().find((p) => p.url().includes(urlPattern))
  if (!page) {
    const urls = context.pages().map((p) => p.url())
    throw new Error(`未找到匹配 ${urlPattern} 的页面；现有页面: ${urls.join(' | ')}`)
  }
  return { browser, context, page }
}

/** 挂 console/pageerror 抓取（须在触发渲染的操作之前挂，否则丢启动期告警）。 */
export function captureConsole(page) {
  const lines = []
  page.on('console', (msg) => lines.push(`[console.${msg.type()}] ${msg.text()}`))
  page.on('pageerror', (err) => lines.push(`[pageerror] ${err.message}`))
  return {
    lines,
    /** flush 落盘内容（尾部统一调用；返回后监听继续，可多次快照）。 */
    flush: () => [...lines],
  }
}

/** 点击「新建任务」进入对话页（已在新会话页时由调用方跳过）。 */
export async function newSession(page) {
  await page.locator('button', { hasText: NEW_SESSION_BUTTON_TEXT }).first().click()
  await page.waitForTimeout(800)
}

/** 把样本全文注入 composer（不发送）。fill 前 click 聚焦是 contenteditable 必需。 */
export async function injectToComposer(page, text) {
  const composer = page.locator(COMPOSER_SELECTOR).first()
  await composer.waitFor({ state: 'visible', timeout: 10000 })
  await composer.click()
  await composer.fill(text)
}

/**
 * 发送消息：优先 composer 容器内的发送按钮（DOM 探测 aria-label/title/testid 命中
 * send|发送|submit 的未禁用 button），fallback Enter 提交。返回实际使用的通道，
 * 供产物日志归因（按钮形态变化时先看此返回值定位失效点）。
 */
export async function clickSendOrSubmit(page) {
  const viaButton = await page.evaluate(() => {
    const composer = document.querySelector('.composer-input')
    if (!composer) return null
    const scope = composer.closest('div') ?? document
    for (const el of scope.querySelectorAll('button')) {
      if (el.disabled) continue
      const sig = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''} ${el.getAttribute('data-testid') ?? ''}`
      if (/send|发送|submit/i.test(sig)) {
        el.click()
        return sig.trim()
      }
    }
    return null
  })
  if (viaButton) return { channel: 'button', hit: viaButton }
  await page.locator(COMPOSER_SELECTOR).first().press('Enter')
  return { channel: 'enter', hit: null }
}

/**
 * 等待渲染稳定：图片全部完成加载（naturalWidth > 0）或无图 + 布局静默。
 * img.naturalWidth 是图片加载完成的唯一可靠信号——complete 属性在加载失败时
 * 也为 true（2026-09 验收 403 缺陷即以此区分 0x0 失败与真实加载）。
 */
export async function waitForRenderSettled(page, { timeout = 15000, settleMs = 600 } = {}) {
  const deadline = Date.now() + timeout
  let lastHeight = -1
  for (;;) {
    const state = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')]
      return {
        pending: imgs.filter((i) => i.naturalWidth === 0 && !i.complete).length,
        broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
        loaded: imgs.filter((i) => i.naturalWidth > 0).length,
        height: document.documentElement.scrollHeight,
      }
    })
    if (state.height === lastHeight && state.pending === 0) return state
    lastHeight = state.height
    if (Date.now() > deadline) return state // 超时返回末态：由断言判定 pending/broken 是否可接受
    await page.waitForTimeout(settleMs)
  }
}

/**
 * DOM 形态采样：rootSelector 作用域内的元素序列（tag / class / 尺寸 / 文本摘要），
 * 输出与基线同构的 JSON——基线与终态直接结构化 diff，替代人工截图判读。
 * 计算样式抽查面（display/overflow 等）按 selectorIncludes 追加，供表格 CSS 化类改动核对。
 */
export async function sampleDomShape(page, { rootSelector = 'body', textLimit = 60, styleProbeSelectors = [] } = {}) {
  return page.evaluate(({ rootSelector, textLimit, styleProbeSelectors }) => {
    const root = document.querySelector(rootSelector)
    if (!root) return null
    const nodes = [...root.querySelectorAll('*')].map((el) => {
      const rect = el.getBoundingClientRect()
      const item = {
        tag: el.tagName.toLowerCase(),
        cls: el.getAttribute('class') || '',
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        text: (el.textContent || '').trim().slice(0, textLimit),
      }
      if (el instanceof HTMLImageElement) {
        item.img = { natural: `${el.naturalWidth}x${el.naturalHeight}`, src: el.getAttribute('src')?.slice(0, 120) }
      }
      return item
    })
    const styleProbes = styleProbeSelectors.map((sel) => {
      const el = document.querySelector(sel)
      if (!el) return { sel, found: false }
      const cs = getComputedStyle(el)
      return { sel, found: true, display: cs.display, overflowX: cs.overflowX, maxWidth: cs.maxWidth, width: cs.width }
    })
    return { rootSelector, count: nodes.length, nodes, styleProbes }
  }, { rootSelector, textLimit, styleProbeSelectors })
}

/** 统一落盘：JSON 与截图同目录同前缀（与验收产物命名约定一致，供结构化 diff）。 */
export async function saveArtifacts(outDir, name, { page, domShape, consoleLines }) {
  mkdirSync(outDir, { recursive: true })
  if (domShape) writeFileSync(join(outDir, `${name}-dom.json`), JSON.stringify(domShape, null, 2))
  if (consoleLines) writeFileSync(join(outDir, `${name}-console.log`), consoleLines.join('\n') + '\n')
  if (page) await page.screenshot({ path: join(outDir, `${name}-fullpage.png`), fullPage: true })
}
