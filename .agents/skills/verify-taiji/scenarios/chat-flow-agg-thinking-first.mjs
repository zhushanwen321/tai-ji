/**
 * chat-flow-agg-thinking-first —— 思考先行与聚合窗延迟挂载（设计 §4 V8，验收行 A6，fx 版增量）。
 *
 * 判据原文（设计 V8 摘录）：思考先行阶段聚合窗不渲染（不占高度、无「等待工具调用」空态），
 * 思考窗实时打字跟底；首个工具步骤开始时聚合窗立即挂载并带 300ms 上浮淡入；工具开场回合无
 * 前导思考窗；纯思考段聚合窗全程不出现、完成摘要只含思考计数（D7 可见性纯派生）。
 *
 * 装配：faux 三回合三形态（faux 队列 per-pi 顺序消费，回合间轮次衔接）：
 * 回合 1 思考先行（thinking+text+ls → read → text 收尾）；回合 2 工具开场（纯工具轮起步）；
 * 回合 3 纯思考段（仅 thinking 收尾，无任何工具）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const meta = {
  id: 'chat-flow-agg-thinking-first',
  priority: 'P0',
  title: '思考先行三形态：思考先行段聚合窗延迟挂载 + 工具开场无前导思考窗 + 纯思考段聚合窗全程不现',
  covers: ['chat.send', 'chat.stream', 'chat.wait'],
  requires: ['faux'],
  estimateSec: 200,
  faux: {
    tps: 6,
    responses: [
      // 回合 1：思考先行（P1 同构）——thinking 与 ls 同轮（同段！text 会把 thinking 切出
      // 段外，D7「思考结束停住保留至下一段思考」是段内语义，跨段无思考的工具段隐藏才是
      // 纯派生正确形态——agg-tf-1 实测教训）
      { thinking: 'AGG-TF-THINK-1 先确认目录结构，这一步要仔细看清楚再动手，避免遗漏关键入口。', toolCalls: [{ name: 'ls', args: { path: '.' } }], stopReason: 'toolUse' },
      { text: 'AGG-TF-TEXT-2 回合 1 收尾。', stopReason: 'stop' },
      // 回合 2：工具开场（P2 同构）——首轮纯工具
      { toolCalls: [{ name: 'bash', args: { command: 'echo AGG-TF-P2-OK' } }], stopReason: 'toolUse' },
      { text: 'AGG-TF-TEXT-3 回合 2 收尾。', stopReason: 'stop' },
      // 回合 3：纯思考段（无任何工具）
      { thinking: 'AGG-TF-THINK-3 纯思考段：只推演不动手，把结论直接写出来给用户看。', stopReason: 'stop' },
    ],
  },
  provable: [
    'A(V8)：思考先行阶段（聚合窗挂载前）思考窗在场 + 聚合窗不在场（无空态占位）',
    'A(V8)：首个工具步骤开始后聚合窗挂载（think+agg 双窗齐备）',
    'A(V8)：工具开场回合聚合窗在场 + 思考窗不渲染（无前导思考窗）',
    'A(V8)：纯思考段聚合窗全程不出现；落成摘要只含思考计数（无分类步数）',
  ],
  notProvable: [
    '300ms 上浮淡入的动画观感（动画类在场由组件测试承载，运行观感归 L4 inspect V9）',
  ],
}

async function pollBody(ui, pred, { timeoutMs = 90_000, intervalMs = 250 } = {}) {
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
    '激活链三层兜底',
    '回合 1 思考先行窗口 = thinking TPS 写出期间（text 未完成时聚合窗不该在）——TPS=6 给足窗口',
    '纯思考回合无后继正文 → 回合不落成（faux 队列耗尽无回复）——摘要断言改在回合 3 落成边沿（waitTurnEnd 后）',
  ]
  const ui = ctx.ui
  const page = await instance.page()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-agg-tf-'))

  try {
    const created = await protocol.call('session.create', { cwd, label: 'chat-flow-agg-tf' }, { timeoutMs: 120_000 })
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

    // ── 回合 1：思考先行 ──────────────────────────────────────
    await protocol.send(sid, 'AGG-TF 回合 1：先思考再动手')
    // 思考先行窗口：思考窗在场 + 聚合窗不在场（poll 到 think-window 出现即查）
    const thinkFirst = await pollBody(ui, (h) => h.includes('agg-think-window'))
    const phase1 = await page.evaluate(() => ({
      think: !!document.querySelector('[data-testid="agg-think-window"]'),
      agg: !!document.querySelector('[data-testid="agg-window"]'),
      emptyState: document.body.innerHTML.includes('等待工具调用'),
    }))
    ev.assert('A(V8): 思考先行阶段思考窗在场', phase1.think, {
      channel: 'A', expected: true, actual: String(phase1.think),
    })
    ev.assert('A(V8): 聚合窗在首个工具步骤前不渲染（延迟挂载）', phase1.agg === false, {
      channel: 'A', expected: false, actual: String(phase1.agg),
    })
    ev.assert('A(V8): 无「等待工具调用」空态占位', phase1.emptyState === false, {
      channel: 'A', expected: false, actual: String(phase1.emptyState),
    })
    ev.step({ step: 'v8.think-first', channel: 'A', exitCode: phase1.think && !phase1.agg ? 0 : 1, stats: phase1 })

    // 首个工具开始 → 聚合窗挂载
    const aggMounted = await pollBody(ui, (h) => h.includes('data-testid="agg-window"'), { timeoutMs: 90_000 })
    const phase2 = await page.evaluate(() => ({
      think: !!document.querySelector('[data-testid="agg-think-window"]'),
      agg: !!document.querySelector('[data-testid="agg-window"]'),
    }))
    ev.assert('A(V8): 首个工具步骤开始后聚合窗挂载 + 段内思考窗停住保留（D7 双窗齐备）', aggMounted.ok && phase2.agg && phase2.think, {
      channel: 'A', expected: '双窗齐备（think 停住保留，同段语义）', actual: JSON.stringify(phase2),
    })
    await protocol.waitTurnEnd(sid, { since: protocol.events.length - 30, timeoutMs: 180_000 }).catch(() => {})
    await pollBody(ui, (h) => h.includes('AGG-TF-TEXT-2'), { timeoutMs: 60_000 })

    // ── 回合 2：工具开场（P2）─────────────────────────────────
    await protocol.send(sid, 'AGG-TF 回合 2：直接动手')
    const p2 = await pollBody(ui, (h) => h.includes('AGG-TF-P2-OK') || h.includes('agg-window'), { timeoutMs: 60_000 })
    await new Promise((r) => setTimeout(r, 400))
    const phase3 = await page.evaluate(() => ({
      agg: !!document.querySelector('[data-testid="agg-window"]'),
      think: !!document.querySelector('[data-testid="agg-think-window"]'),
    }))
    ev.assert('A(V8): 工具开场回合聚合窗在场（无前导思考窗）', phase3.agg && phase3.think === false, {
      channel: 'A', expected: 'agg=true think=false', actual: JSON.stringify(phase3),
    })
    ev.step({ step: 'v8.tool-first', channel: 'A', exitCode: phase3.agg && !phase3.think ? 0 : 1, stats: phase3 })
    await pollBody(ui, (h) => h.includes('AGG-TF-TEXT-3'), { timeoutMs: 60_000 })

    // ── 回合 3：纯思考段 ──────────────────────────────────────
    await protocol.send(sid, 'AGG-TF 回合 3：纯思考')
    await new Promise((r) => setTimeout(r, 1200))
    const phase4 = await page.evaluate(() => ({
      agg: !!document.querySelector('[data-testid="agg-window"]'),
      think: !!document.querySelector('[data-testid="agg-think-window"]'),
    }))
    ev.assert('A(V8): 纯思考段聚合窗不出现（纯派生）', phase4.agg === false && phase4.think, {
      channel: 'A', expected: 'agg=false think=true', actual: JSON.stringify(phase4),
    })
    // 落成（faux 队列耗尽 = 无回复收尾）→ 摘要只含思考计数
    await pollBody(ui, (h) => !h.includes('agg-think-window'), { timeoutMs: 90_000 })
    const summary = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="agg-summary-row"]')]
      const last = rows[rows.length - 1]
      if (!last) return { rows: rows.length }
      return {
        rows: rows.length,
        think: !!last.querySelector('[data-testid="agg-summary-thinking"]'),
        cat: last.querySelectorAll('[data-testid^="agg-summary-cat-"]').length,
        text: last.textContent.slice(0, 60),
      }
    })
    ev.assert('A(V8): 纯思考段摘要只含思考计数（无分类步数）', summary.think === true && summary.cat === 0, {
      channel: 'A', expected: 'think 计数在场 + cat 计数 0 个', actual: JSON.stringify(summary),
    })
    ev.step({ step: 'v8.pure-think', channel: 'A', exitCode: summary.think && summary.cat === 0 ? 0 : 1, stats: summary })

    return { uncovered: [], gotchas }
  } catch (e) {
    try {
      const snap = await page.evaluate(() => document.body.innerHTML.slice(-4000))
      ev.attach('failure-dom-tail', snap)
    } catch { /* 页面不可用 */ }
    throw e
  }
}
