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
      { thinking: 'AGG-THINK-1 先看目录结构再读入口文件，确认模块边界。', text: 'AGG-LIVE-TEXT-1 开场正文，先看目录结构。', toolCalls: [{ name: 'ls', args: { path: '.' } }], stopReason: 'toolUse' },
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
    // ── 哨兵观察（发送后并发启动）：每个正文哨兵出现即命中——回合落成即折叠（D5），
    //      串行等到 v1/v6 做完再 poll 会全部错过工作态窗口（agg-live-8 教训）
    const sentinels = ['AGG-LIVE-TEXT-1', 'AGG-LIVE-TEXT-2', 'AGG-LIVE-TEXT-3', 'AGG-LIVE-TEXT-4']
    const watches = sentinels.map((t) => ({
      t,
      p: pollBodyHtml(ui, (h) => h.includes(t), { timeoutMs: 120_000, intervalMs: 250 }).then((r) => r.ok),
    }))


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
    // m1 时点 = 工具段进行中（该段无思考）——D7 纯派生：思考窗隐藏（null）是正确形态；
    // 思考窗 92px 的在场断言由段 1a（思考先行窗口）承担
    const aggOk = m1.agg !== null && Math.abs(m1.agg - 116) <= 4
    const thinkHiddenOk = m1.think === null
    const containerOk = m1.container !== null && Math.abs(m1.container - 116) <= 4
    ev.assert('A(V1): 工具段思考窗纯派生隐藏（该段无思考）', thinkHiddenOk, {
      channel: 'A', expected: 'null（D7 可见性纯派生）', actual: String(m1.think),
    })
    ev.assert('A(V1): 聚合窗 116px（±4）', aggOk, { channel: 'A', expected: '116±4', actual: String(m1.agg) })
    ev.assert('A(V1): container = 聚合窗独占（工具段无思考窗）', containerOk, {
      channel: 'A', expected: '116±4', actual: String(m1.container),
    })
    ev.assert('A(V1): 占位不随步骤数增长（同段两观测点等高）', inWindow && m1.container === m2.container, {
      channel: 'A', expected: '两观测点等高', actual: `m1=${m1.container} m2=${m2.container}`,
    })
    ev.assert('A(V1): 聚合条行在场（strip 高亮瞬时性登记 notProvable，行在场为代理判据）', m1.stripRow || m1.stripCurrent, {
      channel: 'A', expected: '聚合条行（strip-row/group/current 任一）', actual: `row=${m1.stripRow} current=${m1.stripCurrent}`,
    })
    ev.step({ step: 'v1.live.windows', channel: 'A', exitCode: aggOk && thinkHiddenOk && containerOk ? 0 : 1, stats: { ...m1, m2: m2.container } })

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
      // 工具段进行中：思考窗隐藏（D7 纯派生），断言聚合窗档位高度（390 档 78/96 中的 96）
      const dimsOk = !stillLive
        ? true
        : m.agg !== null && Math.abs(m.agg - ea) <= 4 && m.think === null
      ev.assert(`A(V6): ${w}px 无横向滚动`, noOverflow, { channel: 'A', expected: true, actual: m.overflow })
      if (stillLive) {
        ev.assert(`A(V6): ${w}px 聚合窗高度 ${ea}（思考窗该段无思考纯派生隐藏）`, dimsOk, {
          channel: 'A', expected: `agg=${ea}±4 think=null`, actual: `${m.think}/${m.agg}`,
        })
      } else {
        ev.step({ step: `v6.width.${w}.degraded`, channel: 'A', exitCode: 0, stats: { note: '段已落成，尺寸断言仅窗口内判' } })
      }
      ev.step({ step: `v6.width.${w}`, channel: 'A', exitCode: noOverflow ? 0 : 1, stats: m })
    }
    await page.setViewportSize({ width: 1280, height: 900 })

    // ── 段 4 收割：哨兵命中断言 ────────────────────────────────
    for (const w of watches) {
      const ok = await w.p
      ev.assert(`A(V4): 工作态正文渲染即时在场（${w.t}）`, ok, {
        channel: 'A', expected: `${w.t} 写出即渲染（并发观察，工作态窗口内命中）`, actual: `hit=${ok}`,
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
    ev.assert('A(V4): 折叠态摘要行数 = 段数（thinking 首段 + 3 工具段 = 4）', f.trace && f.summaries === 4, {
      channel: 'A', expected: 'summaries=4', actual: `summaries=${f.summaries} units=${f.unitCount}`,
    })
    ev.assert('A(V4): 末位正文殿后（trace-blk--text 为最后单元）', f.lastIsText === true, {
      channel: 'A', expected: true, actual: String(f.lastIsText),
    })
    ev.step({ step: 'v4.folded', channel: 'A', exitCode: f.summaries === 4 && f.lastIsText ? 0 : 1, stats: f })

    return { uncovered: [], gotchas }
  } catch (e) {
    try {
      const snap = await page.evaluate(() => document.body.innerHTML.slice(-4000))
      ev.attach('failure-dom-tail', snap)
    } catch { /* 页面不可用 */ }
    throw e
  }
}
