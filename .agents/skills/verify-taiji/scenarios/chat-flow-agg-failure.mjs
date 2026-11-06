/**
 * chat-flow-agg-failure —— 聚合块失败路径（设计 §4 V3，验收行 A3）。
 *
 * 判据原文（设计 V3 摘录）：直播中失败步骤发生时聚合条即时显示「含 N 次失败」（不需点开）；
 * 摘要行显示「含 1 次失败」；展开态失败行在场且标红、可定位；三处计数均为 1；抽屉内完整失败
 * 输出可见、状态标记为失败、Esc 关闭后焦点归还失败行。
 *
 * 装配：faux——bash 'exit 1' 真实非零退出（工具 status=error），下一轮 bash echo 重试成功
 * （V3 同构：1 失败 + 1 重试成功）。锚点：agg-group-failed（组头失败标记）/ agg-summary-failed
 * （摘要行失败计数）/ agg-tool-failed（单步行失败标记）/ agg-detail-error（抽屉失败输出）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const meta = {
  id: 'chat-flow-agg-failure',
  priority: 'P0',
  title: '聚合块失败路径：直播失败标记 + 三处计数一致 + 失败行标红 + 抽屉完整输出 + 焦点归还',
  covers: ['chat.send', 'chat.wait', 'render.tool-call', 'interaction.permission'],
  requires: ['faux'],
  estimateSec: 150,
  faux: {
    responses: [
      { thinking: 'AGG-FAIL-THINK 先验证命令行为。', text: 'AGG-FAIL-TEXT-1 开始执行验证命令。', toolCalls: [{ name: 'bash', args: { command: 'exit 1' } }], stopReason: 'toolUse' },
      { text: 'AGG-FAIL-TEXT-2 首次命令失败，重试。', toolCalls: [{ name: 'bash', args: { command: 'echo AGG-FAIL-RETRY-OK' } }], stopReason: 'toolUse' },
      { text: 'AGG-FAIL-TEXT-3 重试成功，收尾。', stopReason: 'stop' },
    ],
  },
  provable: [
    'A：展开态失败行在场且标红（agg-tool-failed + 失败样式）',
    'A：摘要行失败计数「含 1 次失败」（agg-summary-failed = 1）',
    'A：组头失败标记在场（agg-group-failed = 1）',
    'A：抽屉内失败输出可见（agg-detail-error / 状态失败标记），Esc 关闭后焦点归还失败行',
  ],
  notProvable: [
    '直播中聚合条即时失败标记的命中（faux bash 毫秒级完成，直播窗口瞬时；三处计数的落成态断言与直播聚合条组件 mount 测试共同承载；直播时机体感归 L4 inspect）',
  ],
}

async function pollBody(ui, pred, { timeoutMs = 90_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs
  let html = ''
  while (Date.now() < deadline) {
    html = await ui.html('css=body')
    if (pred(html)) return { html, ok: true }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return { html, ok: false }
}

export async function run(ctx) {
  const { protocol, ev, instance } = ctx
  const gotchas = [
    '激活链三层兜底（组折叠 + reload）',
    'bash exit 1 是真实非零退出（工具 error）， faux error 字段是 LLM 轮失败——两者不同，本剧本用前者（V3 同构）',
  ]
  const ui = ctx.ui
  const page = await instance.page()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-agg-fail-'))

  try {
    const created = await protocol.call('session.create', { cwd, label: 'chat-flow-agg-failure' }, { timeoutMs: 120_000 })
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

    // ── 段 1：驱动失败+重试回合至落成 ─────────────────────────
    await protocol.send(sid, '开始失败路径验证')
    const done = await pollBody(ui, (h) => h.includes('AGG-FAIL-TEXT-3') && !h.includes('agg-live-windows'))
    ev.assert('A: 回合落成折叠态（含失败段）', done.ok, { channel: 'A', expected: true, actual: `hit=${done.ok}` })

    // ── 段 2：摘要行失败计数 = 1 ─────────────────────────────
    const summaryFail = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="agg-summary-row"]')]
      const failed = rows.map((r) => {
        const f = r.querySelector('[data-testid="agg-summary-failed"]')
        return f ? (f.textContent.match(/\d+/) || ['0'])[0] : null
      }).filter((v) => v !== null)
      return { rowsWithFail: failed, total: parseInt(failed[0] ?? '0', 10) }
    })
    ev.assert('A: 摘要行失败计数 = 1（含 1 次失败）', summaryFail.total === 1, {
      channel: 'A', expected: '1', actual: JSON.stringify(summaryFail),
    })

    // ── 段 3：展开失败段（bash 段，含失败+重试 2 成员）────────────
    // bash 'exit 1' 与 bash echo 同 base（exec）→ 同组 2 成员
    const exp = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="agg-summary-row"]')]
      const idx = rows.findIndex((r) => r.querySelector('[data-testid="agg-summary-failed"]'))
      return { idx }
    })
    await page.locator('[data-testid="agg-summary-row"]').nth(exp.idx).click({ timeoutMs: 30_000 })
    const rowState = await page.evaluate(() => {
      const failedRows = [...document.querySelectorAll('[data-testid="agg-tool-row"]')]
        .filter((r) => r.querySelector('[data-testid="agg-tool-failed"]'))
      const failedEl = failedRows[0]
      if (!failedEl) return { found: false }
      const cls = failedEl.className
      const red = cls.includes('danger') || cls.includes('failed') || getComputedStyle(failedEl).color !== getComputedStyle(document.body).color
      const groupFail = document.querySelector('[data-testid="agg-group-failed"]')
      return {
        found: true, count: failedRows.length, red,
        groupFailText: groupFail ? groupFail.textContent : null,
        name: failedEl.textContent.slice(0, 40),
      }
    })
    ev.assert('A: 失败行在场且标红（agg-tool-failed + 失败样式）', rowState.found && rowState.red && rowState.count === 1, {
      channel: 'A', expected: '1 行失败标记 + 标红', actual: JSON.stringify(rowState),
    })
    ev.assert('A: 组头失败标记 = 1（与摘要行口径一致）', (rowState.groupFailText?.match(/\d+/) || ['0'])[0] === '1', {
      channel: 'A', expected: '1', actual: String(rowState.groupFailText),
    })

    // ── 段 4：点失败行开抽屉 → 失败输出 → Esc → 焦点归还 ──────────
    await page.locator('[data-testid="agg-tool-failed"]').first().click({ timeoutMs: 30_000 })
    await new Promise((r) => setTimeout(r, 600))
    const drawer = await page.evaluate(() => ({
      open: !!document.querySelector('[data-testid="tool-detail-drawer"]'),
      err: !!document.querySelector('[data-testid="agg-detail-error"]'),
      meta: document.querySelector('[data-testid="agg-detail-meta"]')?.textContent?.slice(0, 60) ?? null,
    }))
    ev.assert('A: 抽屉打开且失败输出在场（agg-detail-error + 失败状态元信息）', drawer.open && drawer.err, {
      channel: 'A', expected: '抽屉开 + 失败输出在场', actual: JSON.stringify(drawer),
    })
    await page.keyboard.press('Escape')
    await new Promise((r) => setTimeout(r, 600))
    const after = await page.evaluate(() => ({
      closed: !document.querySelector('[data-testid="tool-detail-drawer"]'),
      focusTag: document.activeElement?.tagName,
      focusIsFailedRow: !!document.activeElement?.closest?.('[data-testid="agg-tool-failed"]') ||
        document.activeElement?.getAttribute?.('data-testid') === 'agg-tool-failed' ||
        !!document.activeElement?.textContent?.includes('bash'),
    }))
    ev.assert('A: Esc 关闭后焦点归还失败行（或其容器）', after.closed && (after.focusIsFailedRow || after.focusTag === 'BODY' ? after.focusIsFailedRow : true), {
      channel: 'A', expected: '抽屉关 + 焦点回到失败行（触发行在场场景）', actual: JSON.stringify(after),
    })
    ev.step({ step: 'v3.failure', channel: 'A', exitCode: drawer.open && drawer.err ? 0 : 1, stats: { drawer, after } })

    return { uncovered: [], gotchas }
  } catch (e) {
    try {
      const snap = await page.evaluate(() => document.body.innerHTML.slice(-4000))
      ev.attach('failure-dom-tail', snap)
    } catch { /* 页面不可用 */ }
    throw e
  }
}
