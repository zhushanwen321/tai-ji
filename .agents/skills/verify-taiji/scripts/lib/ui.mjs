/**
 * UI 驱动原语（lib 层）：选择器解析 + 自动等待 + 断言 + 截图。
 *
 * 选择器语法（与 pw.js 一致）：
 *   testid=<id>            → [data-testid="<id>"]
 *   role=<role>[name="n"]  → getByRole(role, { name })
 *   text=<文本>            → getByText(<文本>)
 *   css=<sel> / 裸选择器     → locator(<sel>)
 *
 * 纪律：全部走自动等待 + 超时断言，禁止「sleep 后断言」；失败信息带「当前可见 testid 摘要」。
 * Playwright 由创建方注入（见 instance.page），本模块不解析依赖。
 */
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_TIMEOUT_MS = 15_000

export class UIError extends Error {
  constructor(message, { hint, evidence } = {}) {
    super(message)
    this.name = 'UIError'
    this.hint = hint
    this.evidence = evidence
  }
}

/** 解析选择器语法 → Playwright Locator。 */
export function resolveSelector(page, sel) {
  const raw = String(sel).trim()
  if (raw.startsWith('testid=')) {
    const id = raw.slice('testid='.length)
    return page.locator(`[data-testid="${id}"]`)
  }
  if (raw.startsWith('role=')) {
    const body = raw.slice('role='.length)
    const m = body.match(/^([a-zA-Z]+)\s*\[name=(?:"([^"]*)"|'([^']*)')\]\s*$/)
    if (m) return page.getByRole(m[1], { name: m[2] ?? m[3] })
    return page.getByRole(body)
  }
  if (raw.startsWith('text=')) return page.getByText(raw.slice('text='.length))
  if (raw.startsWith('css=')) return page.locator(raw.slice('css='.length))
  return page.locator(raw)
}

/** 当前页面上可见的 testid 摘要（失败诊断用）。 */
async function visibleTestIds(page, limit = 30) {
  try {
    return await page.$$eval('[data-testid]', (nodes, max) => {
      const out = []
      for (const n of nodes) {
        const el = /** @type {HTMLElement} */ (n)
        const style = window.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue
        out.push(el.getAttribute('data-testid'))
        if (out.length >= max) break
      }
      return out
    }, limit)
  } catch (e) {
    return [`<无法读取 testid: ${e instanceof Error ? e.message : String(e)}>`]
  }
}

/**
 * @param {{page: import('playwright').Page, evidence?: any, repo?: string}} opts
 */
export function createUI({ page, evidence, repo } = {}) {
  if (!page) throw new UIError('createUI 需要 page（先 instance.page()）', { hint: 'await instance.page() 后再 createUI' })

  async function locator(sel) {
    return resolveSelector(page, sel)
  }

  async function failWithContext(sel, message, extra = {}) {
    const visible = await visibleTestIds(page)
    throw new UIError(`${message}（选择器 ${sel}）`, {
      hint: '用 testid 优先；Popover/Modal 经 portal 挂 body（全局查询）；校对 docs/testing/ 的 testid 清单',
      evidence: { selector: sel, url: page.url(), visibleTestIds: visible, ...extra },
    })
  }

  const ui = {
    page,

    async click(sel, opts = {}) {
      const loc = await locator(sel)
      const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      try {
        await loc.first().waitFor({ state: 'visible', timeout })
        await loc.first().click({ button: opts.button ?? 'left', timeout })
      } catch (e) {
        await failWithContext(sel, `click 失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    },

    /** contenteditable 必须逐字输入（fill 不触发 input 逻辑）。 */
    async type(sel, text, opts = {}) {
      const loc = await locator(sel)
      const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      try {
        await loc.first().waitFor({ state: 'visible', timeout })
        await loc.first().click({ timeout })
        await loc.first().pressSequentially(text, { timeout })
      } catch (e) {
        await failWithContext(sel, `type(pressSequentially) 失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    },

    /** 仅用于真 <input>（原生表单区）；contenteditable 用 type。 */
    async fill(sel, text, opts = {}) {
      const loc = await locator(sel)
      const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      try {
        await loc.first().waitFor({ state: 'visible', timeout })
        const tag = await loc.first().evaluate((el) => el.tagName.toLowerCase())
        if (tag !== 'input' && tag !== 'textarea') {
          throw new Error(`fill 只允许 input/textarea，实际 <${tag}>（contenteditable 请用 type）`)
        }
        await loc.first().fill(text, { timeout })
      } catch (e) {
        await failWithContext(sel, `fill 失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    },

    async press(key, opts = {}) {
      try {
        await page.keyboard.press(key)
      } catch (e) {
        await failWithContext(`<keyboard:${key}>`, `press 失败: ${e instanceof Error ? e.message : String(e)}`, opts)
      }
    },

    async hover(sel, opts = {}) {
      const loc = await locator(sel)
      const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      try {
        await loc.first().waitFor({ state: 'visible', timeout })
        await loc.first().hover({ timeout })
      } catch (e) {
        await failWithContext(sel, `hover 失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    },

    async expectVisible(sel, opts = {}) {
      const loc = await locator(sel)
      const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      try {
        await loc.first().waitFor({ state: 'visible', timeout })
        return true
      } catch (e) {
        await failWithContext(sel, `expectVisible 超时(${timeout}ms): ${e instanceof Error ? e.message : String(e)}`)
      }
    },

    async expectGone(sel, opts = {}) {
      const loc = await locator(sel)
      const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      try {
        await loc.first().waitFor({ state: 'detached', timeout })
        return true
      } catch (e) {
        await failWithContext(sel, `expectGone 超时(${timeout}ms): ${e instanceof Error ? e.message : String(e)}`)
      }
    },

    async expectText(sel, expected, opts = {}) {
      const loc = await locator(sel)
      const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const deadline = Date.now() + timeout
      let actual = ''
      for (;;) {
        try {
          actual = (await loc.first().innerText({ timeout: 2_000 })) ?? ''
        } catch {
          actual = ''
        }
        const ok =
          expected instanceof RegExp ? expected.test(actual) : opts.exact ? actual === expected : actual.includes(expected)
        if (ok) return actual
        if (Date.now() >= deadline) {
          await failWithContext(sel, `expectText 不匹配，期望 ${String(expected)}，实际 "${actual.slice(0, 300)}"`)
        }
        await new Promise((r) => setTimeout(r, 100))
      }
    },

    async expectCount(sel, n, opts = {}) {
      const loc = await locator(sel)
      const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const deadline = Date.now() + timeout
      let count = -1
      for (;;) {
        count = await loc.count()
        if (count === n) return count
        if (Date.now() >= deadline) {
          await failWithContext(sel, `expectCount 期望 ${n}，实际 ${count}`)
        }
        await new Promise((r) => setTimeout(r, 100))
      }
    },

    async text(sel) {
      const loc = await locator(sel)
      const t = await loc.first().innerText({ timeout: DEFAULT_TIMEOUT_MS })
      return t ?? ''
    },

    async attr(sel, name) {
      const loc = await locator(sel)
      return loc.first().getAttribute(name, { timeout: DEFAULT_TIMEOUT_MS })
    },

    async html(sel) {
      const loc = await locator(sel)
      return loc.first().innerHTML({ timeout: DEFAULT_TIMEOUT_MS })
    },

    /** 截图（有 evidence 时委托它落 <runDir>/<name>.png）。 */
    async screenshot(name, opts = {}) {
      if (evidence) return evidence.shot(page, name, opts)
      const dir = path.join(process.cwd(), 'verify-screenshots')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${name}.png`)
      if (opts.selector) {
        const loc = await locator(opts.selector)
        await loc.first().screenshot({ path: file })
      } else {
        await page.screenshot({ path: file })
      }
      return file
    },

    /** 当前可见 testid 摘要（供 scenario 记录证据）。 */
    async visibleTestIds(limit = 30) {
      return visibleTestIds(page, limit)
    },
  }

  return ui
}
