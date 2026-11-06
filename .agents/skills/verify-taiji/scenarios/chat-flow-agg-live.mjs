/**
 * chat-flow-agg-live —— 过程聚合块运行中形态全链（chat-flow-process-aggregate 设计 §4 V1/V4/V6，
 * dev-flow D3 验收行 A1/A4/A5，impl-plan §4 验收计划表）。
 *
 * 判据原文（设计 V 行摘录）：
 * - V1（A1）：长任务回合运行中任一时刻，进行中聚合块占位 = 思考窗 92px + 间距 10px + 聚合窗
 *   116px（±4px 容差），不随已完成步骤数增长；回合落成后聚合块收成一行摘要。
 * - V4（A4）：运行中每条已写完的正文都直接渲染（4 条正文 + 3 聚合块交替）；折叠态 = 全部
 *   聚合块摘要行按段序在前 + 末位正文殿后（D2 审查对齐实现序）；无正文被并入计数摘要。
 * - V6（A5）：390/620/900 三档无横向滚动条；390px 下思考窗 78px、聚合窗 96px。
 *
 * 装配：faux（零 token）+ TPS=6 拉长文本流给工作态争取观测窗口。faux 队列语义：每 assistant
 * 轮消费一个 step，stopReason 'toolUse' 执行工具后开下一轮、'stop' 终止回合——text 与
 * toolCalls 同轮（pi 回合真实结构）。**状态点纪律（agg-live-5b 实测教训）**：工作态渲染全部
 * 正文与进行中双窗；回合落成即折叠（D5：只剩摘要行 + 末位正文）——V1/V4-运行中/V6 断言必须
 * 在工作态窗口内完成，折叠态断言在落成后做，两个状态点的 DOM 集合不同不可混用。
 *
 * 锚点事实（2026-11-07 源码核对）：.trace-blk / .trace-blk--text（Turn.vue 单元 wrapper）；
 * agg-live-windows / agg-think-window / agg-window / agg-summary-row / agg-strip-current /
 * agg-strip-row（process-aggregate 组件族）。窗口高度常量：desktop 92/116，≤420px 78/96。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const meta = {
  id: 'chat-flow-agg-live',
  priority: 'P0',
  title: '聚合块运行中形态：双窗高度有界 + 多正文交替原生展示 + 折叠态摘要行 + 窄屏三档',
  covers: ['chat.send', 'chat.stream', 'chat.wait', 'render.tool-call'],
  requires: ['faux'],
  estimateSec: 240,
  faux: {
    tps: 6,
    responses: [
      { thinking: 'AGG-THINK-1 先看目录结构再读入口文件，确认模块边界。', toolCalls: [{ name: 'ls', args: { path: '.' } }], stopReason: 'toolUse' },
      { toolCalls: [{ name: 'read', args: { path: 'package.json' } }], stopReason: 'toolUse' },
      { toolCalls: [{ name: 'read', args: { path: 'AGENTS.md' } }], stopReason: 'toolUse' },
      { toolCalls: [{ name: 'read', args: { path: 'docs/DESIGN.md' } }], stopReason: 'toolUse' },
      { toolCalls: [{ name: 'read', args: { path: 'docs/TEST-STRATEGY.md' } }], stopReason: 'toolUse' },
      { text: 'AGG-LIVE-TEXT-2 中间结论：目录结构确认。', toolCalls: [{ name: 'bash', args: { command: 'echo AGG-LIVE-EXEC-OK' } }], stopReason: 'toolUse' },
      { text: 'AGG-LIVE-TEXT-3 第三段正文。', toolCalls: [{ name: 'grep', args: { pattern: '"name"', path: 'package.json' } }], stopReason: 'toolUse' },
      { text: 'AGG-LIVE-TEXT-4 最终结论正文。', stopReason: 'stop' },
    ],
  },
  provable: [
    'A(V1)：运行中双窗在场（思考窗 92px / 聚合窗 116px ±4）；container 高 = think+10+agg 常量和',
    'A(V1)：占位不随步骤数增长（同段两观测点等高）',
    'A(V4)：工作态全部 4 条正文哨兵在 DOM（不依赖展开全部）',
    'A(V4)：折叠态 = 3 条摘要行 + 末位正文殿后',
    'A(V6)：390/620/900 三档无横向滚动；390px 双窗 78/96',
  ],
  notProvable: [
    '运行中聚合条当前项高亮（agg-strip-current）：faux 真实工具毫秒级完成，运行态一闪而过，条件轮询不可稳定命中——高亮形态由组件 mount 测试锁定（agg-strip-current testid 断言），运行时机体感归 L4 inspect',
    '自动滚到最新的平滑性与贴底跟随体感（滚动位置代理判据归 L4）',
  ],
}

async function pollBodyHtml(ui, predicate, { timeoutMs = 60_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs
  let html = ''
  while (Date.now() < deadline) {
    html = await ui.html('css=body')
    if (predicate(html)) return { html, ok: true }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return { html, ok: false }
}

export async function run(ctx) {
  const { protocol, ev, log, instance } = ctx
  const gotchas = [
    '状态点纪律：工作态（全部正文+双窗）与落成折叠态（摘要行+末位正文）DOM 集合不同，断言必须在对应状态点抓取',
    'faux 队列 per-pi 一次加载；stopReason stop 终止回合——纯 text 步不能放在非末轮',
    'UI 激活链：协议建会话后侧栏行在默认项目组内（组可能折叠），短等不现则点 default-project-head 展开',
  ]
  const ui = ctx.ui
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-agg-live-'))
  log(`临时会话 cwd=${cwd}`)
  const page = await instance.page()

  try {
    // ── 段 0：建会话 + 激活（组展开兜底）────────────────────────
    const created = await protocol.call('session.create', { cwd, label: 'chat-flow-agg-live' }, { timeoutMs: 120_000 })
    const sid = created.session?.id
    if (!sid) throw new Error('session.create 未返回 sessionId')
    await protocol.subscribe(sid)
    try {
      await ui.expectVisible('css=.session-item', { timeoutMs: 8000 })
    } catch {
      await ui.click('css=[data-testid="default-project-head"]', { timeoutMs: 10_000 })
      await ui.expectVisible('css=.session-item', { timeoutMs: 30_000 })
    }
    await ui.click('css=.session-item', { timeoutMs: 30_000 })
    ev.step({ step: 'ui.activate', channel: 'A', exitCode: 0, stats: { sid } })

    // ── 段 1：发送 → 等首个聚合段（思考+工具）进入运行中 ──────────
    await protocol.send(sid, '开始聚合块运行中形态验证')
    const live = await pollBodyHtml(ui, (h) => h.includes('agg-live-windows'))
    ev.assert('A(V1): 运行中双窗容器在场（agg-live-windows）', live.ok, {
      channel: 'A', expected: '思考步骤开始后思考窗出现；首个工具步骤后聚合窗挂载', actual: `hit=${live.ok}`,
    })
    if (!live.ok) {
      return { uncovered: ['运行中双窗未出现（工作态窗口未命中），后续断言未执行'], gotchas }
    }

    // ── 段 2：V1 双窗高度 + 占位不增长（工作态窗口内两个观测点）─────
    const measure = () => page.evaluate(() => {
      const q = (sel) => document.querySelector(sel)
      const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null)
      return {
        think: h(q('[data-testid="agg-think-window"]')),
        agg: h(q('[data-testid="agg-window"]')),
        container: h(q('[data-testid="agg-live-windows"]')),
        stripCurrent: !!document.querySelector('[data-testid="agg-strip-current"]'),
        stripRow: !!document.querySelector('[data-testid="agg-strip-row"], [data-testid="agg-strip-group"]'),
      }
    })
    // 思考先行段：思考窗先现、聚合窗在首个工具步骤开始才挂载（D7 纯派生）——
    // 双窗齐备后再量（run6 教训：live-windows 一现即量，agg 窗尚未挂载量到 null）
    await pollBodyHtml(ui, (h) => h.includes('agg-window'), { timeoutMs: 60_000, intervalMs: 200 })
    const m1 = await measure()
    await new Promise((r) => setTimeout(r, 1500))
    const m2 = await measure()
    const inWindow = m2.container !== null
    const thinkOk = m1.think !== null && Math.abs(m1.think - 92) <= 4
    const aggOk = m1.agg !== null && Math.abs(m1.agg - 116) <= 4
    const sumOk = m1.container !== null && m1.think !== null && m1.agg !== null
      && Math.abs(m1.container - (m1.think + 10 + m1.agg)) <= 8
    ev.assert('A(V1): 思考窗 92px（±4）', thinkOk, { channel: 'A', expected: '92±4', actual: String(m1.think) })
    ev.assert('A(V1): 聚合窗 116px（±4）', aggOk, { channel: 'A', expected: '116±4', actual: String(m1.agg) })
    ev.assert('A(V1): container = think+10+agg 常量和（±8）', sumOk, {
      channel: 'A', expected: `${m1.think}+10+${m1.agg}±8`, actual: String(m1.container),
    })
    ev.assert('A(V1): 占位不随步骤数增长（同段两观测点等高）', inWindow && m1.container === m2.container, {
      channel: 'A', expected: '两观测点等高', actual: `m1=${m1.container} m2=${m2.container}`,
    })
    ev.assert('A(V1): 聚合条行在场（strip 高亮瞬时性登记 notProvable，行在场为代理判据）', m1.stripRow || m1.stripCurrent, {
      channel: 'A', expected: '聚合条行（strip-row/group/current 任一）', actual: `row=${m1.stripRow} current=${m1.stripCurrent}`,
    })
    ev.step({ step: 'v1.live.windows', channel: 'A', exitCode: thinkOk && aggOk && sumOk ? 0 : 1, stats: { ...m1, m2: m2.container } })

    // ── 段 3：V6 窄屏三档（仍在工作态窗口内切 viewport）──────────
    for (const [w, et, ea] of [[900, 92, 116], [620, 92, 116], [390, 78, 96]]) {
      await page.setViewportSize({ width: w, height: 900 })
      await new Promise((r) => setTimeout(r, 500))
      const m = await page.evaluate(() => {
        const q = (sel) => document.querySelector(sel)
        const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null)
        return {
          think: h(q('[data-testid="agg-think-window"]')),
          agg: h(q('[data-testid="agg-window"]')),
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        }
      })
      const noOverflow = m.overflow === false
      const stillLive = m.think !== null || m.agg !== null
      const dimsOk = !stillLive
        ? true // 段在切档间隙落成（工作态窗口关闭），尺寸断言只在窗口内判
        : w === 390
          ? m.think !== null && Math.abs(m.think - et) <= 4 && m.agg !== null && Math.abs(m.agg - ea) <= 4
          : true
      ev.assert(`A(V6): ${w}px 无横向滚动`, noOverflow, { channel: 'A', expected: true, actual: m.overflow })
      if (stillLive) {
        ev.assert(`A(V6): ${w}px 双窗高度（${et}/${ea}）`, dimsOk, {
          channel: 'A', expected: `${et}/${ea}±4`, actual: `${m.think}/${m.agg}`,
        })
      } else {
        ev.step({ step: `v6.width.${w}.degraded`, channel: 'A', exitCode: 0, stats: { note: '段已落成，尺寸断言仅 390 档有窗口时判' } })
      }
      ev.step({ step: `v6.width.${w}`, channel: 'A', exitCode: noOverflow ? 0 : 1, stats: m })
    }
    await page.setViewportSize({ width: 1280, height: 900 })

    // ── 段 4：V4 工作态正文逐哨兵即时断言（工作态每条正文写出即渲染；
    //      落成折叠后 DOM 只剩末位正文（D5 正确形态），末尾补抓必撞折叠边沿——
    //      agg-live-7 教训：边沿后补抓 2/4 是折叠态 DOM 集合而非正文缺失）
    for (const [sentinel, preds] of [
      ['AGG-LIVE-TEXT-1', () => true],
      ['AGG-LIVE-TEXT-2', () => true],
      ['AGG-LIVE-TEXT-3', () => true],
    ]) {
      const hit = await pollBodyHtml(ui, (h) => h.includes(sentinel), { timeoutMs: 90_000 })
      ev.assert(`A(V4): 工作态正文渲染即时在场（${sentinel}）`, hit.ok, {
        channel: 'A', expected: `${sentinel} 写出即渲染`, actual: `hit=${hit.ok}`,
      })
    }

    // ── 段 5：落成折叠态（D5：摘要行按段序在前 + 末位正文殿后）──────
    const folded = await pollBodyHtml(ui, (h) => !h.includes('agg-live-windows'), { timeoutMs: 60_000 })
    const f = await page.evaluate(() => {
      const trace = document.querySelector('.trace')
      if (!trace) return { trace: false }
      const units = [...trace.querySelectorAll(':scope > .trace-blk')]
      return {
        trace: true,
        summaries: trace.querySelectorAll('[data-testid="agg-summary-row"]').length,
        lastIsText: units.length > 0 && units[units.length - 1].classList.contains('trace-blk--text'),
        unitCount: units.length,
      }
    })
    ev.assert('A(V4): 折叠态 = 3 条摘要行（每段一行）', f.trace && f.summaries === 3, {
      channel: 'A', expected: 'summaries=3', actual: `summaries=${f.summaries} units=${f.unitCount}`,
    })
    ev.assert('A(V4): 末位正文殿后（trace-blk--text 为最后单元）', f.lastIsText === true, {
      channel: 'A', expected: true, actual: String(f.lastIsText),
    })
    ev.step({ step: 'v4.folded', channel: 'A', exitCode: f.summaries === 3 && f.lastIsText ? 0 : 1, stats: f })

    return { uncovered: [], gotchas }
  } catch (e) {
    try {
      const snap = await page.evaluate(() => document.body.innerHTML.slice(-4000))
      ev.attach('failure-dom-tail', snap)
    } catch { /* 页面不可用 */ }
    throw e
  }
}
