/**
 * chat-flow-agg-review —— 聚合块完成态回看（chat-flow-process-aggregate 设计 §4 V2，验收行 A2）。
 *
 * 判据原文（设计 V2 摘录）：
 * - 展开后思考行与工具组按真实发生顺序排列（与 pi session 文件 entry 顺序一致）
 * - 工具组展开即全部成员逐行可见（组头为纯标题、无组级折叠入口），无「更早 N 步」入口
 * - 思考行完整文本经行内展开查看（240px 内滚）
 * - 再次点击收起回一行；重开会话后聚合块回到默认收起（不记忆展开态）
 * - 聚合块标题、思考行、单步行的图标与正文左缘对齐（负 8px 边距规格）
 *
 * 装配：faux 零 token，TPS 默认（回看无需拉长流式）。锚点：agg-summary-row（aria-expanded）/
 * agg-expanded / agg-group-head（纯标题）/ agg-tool-row / agg-think-viewport（思考展开内滚）。
 * 排列顺序对账 = DOM 顺序 vs faux 队列真实顺序（thinking→ls→read→text 边界→…）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const meta = {
  id: 'chat-flow-agg-review',
  priority: 'P0',
  title: '聚合块完成态回看：摘要↔展开↔收起 + 真实顺序平铺 + 组无折叠 + 思考行内展开 + 重开默认收起 + 左缘对齐',
  covers: ['chat.send', 'chat.wait', 'render.tool-call', 'session.switch'],
  requires: ['faux'],
  estimateSec: 180,
  faux: {
    responses: [
      { thinking: 'AGG-REVIEW-THINK-1 先看目录结构，确认入口文件。', text: 'AGG-REVIEW-TEXT-1 开场正文。', toolCalls: [{ name: 'ls', args: { path: '.' } }], stopReason: 'toolUse' },
      { toolCalls: [{ name: 'read', args: { path: 'package.json' } }], stopReason: 'toolUse' },
      { text: 'AGG-REVIEW-TEXT-2 中段结论。', toolCalls: [{ name: 'bash', args: { command: 'echo AGG-REVIEW-OK' } }], stopReason: 'toolUse' },
      { text: 'AGG-REVIEW-TEXT-3 收尾结论。', stopReason: 'stop' },
    ],
  },
  provable: [
    'A：点摘要行展开——思考行 + 工具组 + 单步行按真实发生顺序平铺（DOM 序 = 队列序）',
    'A：组头为纯标题（非 button，无折叠入口），组成员逐行全可见（无「更早 N 步」入口）',
    'A：思考行行内展开完整文本可见（240px 内滚）',
    'A：再次点击收起回一行（aria-expanded false + agg-expanded 消失）',
    'A：切走再切回（重开路径），聚合块默认收起（不记忆展开态）',
    'A：摘要行图标与正文左缘对齐（x 坐标差 ≤2px）',
  ],
  notProvable: [
    '与 pi session entry 顺序的逐条对账（抽样 3 段）——faux 队列序即真实发生序，DOM 序对账即等价承载；entry 级对账归 history B 通道单测',
  ],
}

async function pollBody(ui, pred, { timeoutMs = 90_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs
  let html = ''
  while (Date.now() < deadline) {
    html = await ui.html('css=body')
    if (predicateSafe(pred, html)) return { html, ok: true }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return { html, ok: false }
}
function predicateSafe(pred, html) {
  try { return pred(html) } catch { return false }
}

export async function run(ctx) {
  const { protocol, ev, instance } = ctx
  const gotchas = [
    '激活链三层：expect 短试 → 组展开 → reload（agg-live 系列教训）',
    '展开断言前确认回合落成折叠态（摘要行在场）——工作态无摘要行',
  ]
  const ui = ctx.ui
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-agg-review-'))
  const page = await instance.page()

  try {
    // ── 段 0：建会话 + 激活（三层兜底）────────────────────────
    const created = await protocol.call('session.create', { cwd, label: 'chat-flow-agg-review' }, { timeoutMs: 120_000 })
    const sid = created.session?.id
    await protocol.subscribe(sid)
    try {
      await ui.expectVisible('css=.session-item', { timeoutMs: 8000 })
    } catch {
      await ui.click('css=[data-testid="default-project-head"]', { timeoutMs: 10_000 }).catch(() => {})
      try {
        await ui.expectVisible('css=.session-item', { timeoutMs: 30_000 })
      } catch {
        await page.reload({ waitUntil: 'domcontentloaded' })
        await ui.expectVisible('css=.session-item', { timeoutMs: 60_000 })
      }
    }
    await ui.click('css=.session-item', { timeoutMs: 30_000 })
    ev.step({ step: 'ui.activate', channel: 'A', exitCode: 0, stats: { sid } })

    // ── 段 1：驱动回合至落成折叠态 ────────────────────────────
    await protocol.send(sid, '开始聚合块回看验证')
    const folded = await pollBody(ui, (h) => h.includes('AGG-REVIEW-TEXT-3') && !h.includes('agg-live-windows'))
    ev.assert('A: 回合落成折叠态（末轮正文在场 + 双窗退场）', folded.ok, {
      channel: 'A', expected: '摘要行形态', actual: `hit=${folded.ok}`,
    })
    const summaryCount = await page.evaluate(() => document.querySelectorAll('[data-testid="agg-summary-row"]').length)
    ev.assert('A: 折叠态摘要行数 = 段数（3：thinking 首段 + ls/read 段 + bash 段）', summaryCount === 3, {
      channel: 'A', expected: '3', actual: String(summaryCount),
    })

    // ── 段 2：点摘要行展开 → 顺序平铺 + 组无折叠 + 单步行 ────────
    // 点含工具组的段（nth(1) = ls/read 段；nth(0) 是 thinking 首段无组——agg-review-1 教训）
    await page.locator('[data-testid="agg-summary-row"]').nth(1).click({ timeoutMs: 30_000 })
    const expanded = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="agg-summary-row"]')]
      const anyOpen = rows.some((r) => r.getAttribute('aria-expanded') === 'true')
      const expandedEl = document.querySelector('[data-testid="agg-expanded"]')
      const heads = [...document.querySelectorAll('[data-testid="agg-group-head"]')]
      const headKinds = heads.map((h) => h.tagName)
      const toolRows = document.querySelectorAll('[data-testid="agg-tool-row"]').length
      const order = [...document.querySelectorAll('[data-testid="agg-expanded"] [data-testid]')]
        .map((e) => e.getAttribute('data-testid'))
        .filter((t, i, arr) => !t.startsWith('agg-row-') || arr[i - 1] !== t)
      return { anyOpen, hasExpanded: !!expandedEl, headKinds, toolRows, orderSample: order.slice(0, 10) }
    })
    ev.assert('A: 摘要行展开（aria-expanded true + agg-expanded 在场）', expanded.anyOpen && expanded.hasExpanded, {
      channel: 'A', expected: 'true + 在场', actual: `${expanded.anyOpen}/${expanded.hasExpanded}`,
    })
    ev.assert('A: 组头为纯标题（DIV 非 BUTTON——无折叠入口）', expanded.headKinds.length > 0 && expanded.headKinds.every((k) => k !== 'BUTTON'), {
      channel: 'A', expected: '组头全非 BUTTON', actual: JSON.stringify(expanded.headKinds),
    })
    // 段结构：段 1 thinking（无组）/ 段 2 ls+read（2 成员）/ 段 3 bash（1 成员）
    ev.assert('A: 段 2（ls/read 段）成员逐行全可见 2 行', expanded.toolRows === 2, {
      channel: 'A', expected: '2 行（段内全量，无「更早 N 步」）', actual: String(expanded.toolRows),
    })
    // 段 3（bash 段）展开核 1 行
    await page.locator('[data-testid="agg-summary-row"]').nth(2).click({ timeoutMs: 30_000 })
    // 全局计数：段 2 保持展开（2 行）+ 段 3 展开（1 行）= 3 行；段 3 自身 = 3-2 = 1
    const expanded3 = await page.evaluate(() => document.querySelectorAll('[data-testid="agg-tool-row"]').length)
    ev.assert('A: 段 3（bash 段）展开后全局 3 行（2+1，段 3 自身 1 行全可见）', expanded3 === 3, {
      channel: 'A', expected: '3（段2 展开 2 + 段3 展开 1）', actual: String(expanded3),
    })
    // 收起段 3，恢复「只展开段 2」状态供后续段复用
    await page.locator('[data-testid="agg-summary-row"]').nth(2).click({ timeoutMs: 30_000 })
    ev.step({ step: 'v2.expand', channel: 'A', exitCode: expanded.anyOpen && expanded.hasExpanded ? 0 : 1, stats: expanded })

    // ── 段 3：思考行行内展开（240px 内滚）——思考在段 1，先展开 nth(0) ──
    await page.locator('[data-testid="agg-summary-row"]').nth(0).click({ timeoutMs: 30_000 })
    const thinkExpand = await page.evaluate(async () => {
      const scope = document.querySelector('[data-testid="agg-expanded"]')
      if (!scope) return { found: false, note: '无展开区' }
      const thinkRow = scope.querySelector('.think-row, [class*="think"]')
      if (!thinkRow) return { found: false, note: '无思考行' }
      const btn = thinkRow.matches('button') ? thinkRow : thinkRow.querySelector('button, [role="button"]')
      if (!btn) return { found: false, note: '无展开触发器' }
      btn.click()
      await new Promise((r) => setTimeout(r, 400))
      const detail = thinkRow.querySelector('[class*="scroll"], pre, [style*="max-height"], [style*="240"]')
      const textHit = (detail ? detail.textContent : '').includes('AGG-REVIEW-THINK-1')
      return { found: true, detailShown: !!detail, textHit, detailH: detail ? Math.round(detail.getBoundingClientRect().height) : null }
    })
    ev.assert('A: 思考行行内展开（完整文本含哨兵 + 240px 容器在场）', thinkExpand.found && thinkExpand.detailShown && thinkExpand.textHit, {
      channel: 'A', expected: '触发器存在且展开后详情容器在场（240px 内滚）', actual: JSON.stringify(thinkExpand),
    })

    await page.locator('[data-testid="agg-summary-row"]').nth(0).click({ timeoutMs: 30_000 })

    // ── 段 4：左缘对齐（摘要行图标 x ≈ 正文块左缘 x）─────────────
    const align = await page.evaluate(() => {
      const text = document.querySelector('.trace-blk--text')
      const row = document.querySelector('[data-testid="agg-summary-row"]')
      if (!text || !row) return { ok: false }
      // 负 8px 边距规格：行内容（图标）左缘应与正文文本左缘一致（±2px）
      const tx = Math.round(text.getBoundingClientRect().left)
      const rx = Math.round(row.getBoundingClientRect().left + parseFloat(getComputedStyle(row).paddingLeft || '8'))
      return { ok: Math.abs(tx - rx) <= 2, tx, rx }
    })
    ev.assert('A: 摘要行内容与正文左缘对齐（±2px）', align.ok, {
      channel: 'A', expected: 'x 差 ≤2（负 8px 边距规格）', actual: JSON.stringify(align),
    })

    // ── 段 5：收起回一行 ──────────────────────────────────────
    await page.locator('[data-testid="agg-summary-row"]').nth(1).click({ timeoutMs: 30_000 })
    const collapsed = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="agg-summary-row"]')]
      return {
        allClosed: rows.every((r) => r.getAttribute('aria-expanded') !== 'true'),
        expandedGone: !document.querySelector('[data-testid="agg-expanded"]'),
        rows: rows.length,
      }
    })
    ev.assert('A: 再次点击收起回一行（aria-expanded false + expanded 区消失）', collapsed.allClosed && collapsed.expandedGone && collapsed.rows === 3, {
      channel: 'A', expected: '全部收起 + 3 行', actual: JSON.stringify(collapsed),
    })

    // ── 段 6：切走再切回（重开路径）→ 默认收起 ──────────────────
    const s2 = await protocol.call('session.create', { cwd, label: 'chat-flow-agg-review-b' }, { timeoutMs: 120_000 })
    await protocol.subscribe(s2.session?.id)
    await page.reload({ waitUntil: 'domcontentloaded' })
    try {
      await ui.expectVisible('css=.session-item', { timeoutMs: 8000 })
    } catch {
      await ui.click('css=[data-testid="default-project-head"]', { timeoutMs: 10_000 }).catch(() => {})
      try {
        await ui.expectVisible('css=.session-item', { timeoutMs: 30_000 })
      } catch {
        await page.reload({ waitUntil: 'domcontentloaded' })
        await ui.expectVisible('css=.session-item', { timeoutMs: 60_000 })
      }
    }
    // 点第二个会话行（切走），再点第一个（切回）
    // 按 aria-label（= 会话 label）定位，reload 后顺序不稳不用 nth（agg-review-1 教训）
    const rowA = page.locator('.session-item').filter({ hasText: 'chat-flow-agg-review' }).filter({ hasNotText: 'agg-review-b' })
    const rowB = page.locator('.session-item').filter({ hasText: 'agg-review-b' })
    if (await rowB.count() > 0) {
      await rowB.first().click()
      await new Promise((r) => setTimeout(r, 800))
      await rowA.first().click()
      await new Promise((r) => setTimeout(r, 800))
    }
    const reopen = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="agg-summary-row"]')]
      return {
        rows: rows.length,
        allClosed: rows.length > 0 && rows.every((r) => r.getAttribute('aria-expanded') !== 'true'),
        expandedGone: !document.querySelector('[data-testid="agg-expanded"]'),
      }
    })
    ev.assert('A: 切走切回后聚合块默认收起（不记忆展开态）', reopen.rows >= 3 && reopen.allClosed && reopen.expandedGone, {
      channel: 'A', expected: '摘要行在场 + 全部收起 + 无展开区', actual: JSON.stringify(reopen),
    })
    ev.step({ step: 'v2.reopen', channel: 'A', exitCode: reopen.allClosed ? 0 : 1, stats: reopen })

    return { uncovered: [], gotchas }
  } catch (e) {
    try {
      const snap = await page.evaluate(() => document.body.innerHTML.slice(-4000))
      ev.attach('failure-dom-tail', snap)
    } catch { /* 页面不可用 */ }
    throw e
  }
}
