/**
 * follow-blindzone-converge —— 盲区高度变化兜底收敛（stream-follow-reshape 验收项 A5 + A10）。
 *
 * 设计依据：stream-follow-reshape.md §4 场景 S4（盲区兜底有效：回合结束后代码块 shiki
 * 异步高亮的高度变化，贴底态视口补滚延迟 ≤ debounce 窗口值 + 两帧）+ S9（append 收敛：
 * 贴底态发送新回合触发回合切换，收敛延迟 ≤ 窗口值 + 两帧）。
 *
 * 测量形态：页内 rAF 逐帧采样滚动几何（{Date.now, scrollTop, scrollHeight, clientHeight}），
 * 帧粒度即「两帧」判据的原生分辨率。回合切换（A10）必须走 composer 真实发送路径——
 * 协议直发不动 submitSeq（[chat-flow-consistency F1] 故意排除外来直发，bumpSubmitSeq 唯一
 * 调用点 = submitNewMessage），S8/S9 的 force/收敛触发只有 composer 提交能完整点亮。
 *
 * debounce 窗口值：从 <repo> 源码 useMessageStreamFollowTriggers.ts 读常量（实施后存在）；
 * 基线（D2 未实施）无该常量 → 回落设计初值 250ms 并在 stats 标注来源。
 *
 * 装配：faux + TAIJI_FAUX_TPS=30。响应 2 步：①长文本（≈2100 字符 ≈525 token，窗口 ≈17s，
 * 末尾以未闭合代码围栏收束——fence finalize / shiki 高亮的异步高度变化落在 complete 之后）；
 * ②短文本（A10 发送轮收尾）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BOTTOM_THRESHOLD = 40
const FRAME_MS = 1000 / 60
/** 断言容差 = 两帧（设计判据）+ 采样量化两帧（rAF 采样的测量误差上界，stats 里双值披露）。 */
const SAMPLE_SLACK_FRAMES = 2

const TRIGGERS_SOURCE = 'packages/renderer/src/composables/panel/useMessageStreamFollowTriggers.ts'

/**
 * 从触发编排层源码读 debounce 窗口常量（ms）。
 * 实施后常量名以实现为准：优先匹配 `*DEBOUNCE*_MS = <n>`，次匹配同行 debounce + 数字。
 * 基线（D2 未实施）读不到 → 回落设计初值 250，stats 标 source='design-initial-fallback'。
 */
function readDebounceMs(repo) {
  const file = path.join(repo, TRIGGERS_SOURCE)
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { ms: 250, source: 'design-initial-fallback（源码文件不可读）' }
  }
  const lines = text.split('\n')
  for (const line of lines) {
    const m = line.match(/[A-Z_]*DEBOUNCE[A-Z_]*_MS\s*[:=]\s*(\d+)/)
    if (m) return { ms: Number(m[1]), source: `source-constant（${line.trim().slice(0, 80)}）` }
  }
  for (const line of lines) {
    if (/debounce/i.test(line)) {
      const m = line.match(/(\d{2,5})\s*(?:ms|毫秒)?\s*[;)].*$/)
      const n = line.match(/=\s*(\d{2,5})\b/)
      const val = n ? Number(n[1]) : m ? Number(m[1]) : null
      if (val !== null && val >= 50 && val <= 2000) return { ms: val, source: `source-heuristic（${line.trim().slice(0, 80)}）` }
    }
  }
  return { ms: 250, source: 'design-initial-fallback（源码暂无 debounce 常量：D2 未实施）' }
}

function buildLongText() {
  const intro = '盲区收敛验收：下面这段代码块在回合结束后由 shiki 异步高亮，高亮完成带来高度变化。'
  const lines = []
  for (let i = 0; i < 40; i++) {
    lines.push(`const step${i} = { index: ${i}, label: '采样行 ${i}', next: stepReady(${i} + 1) };`)
  }
  // 围栏闭合放在文本最末：流式期间围栏始终未闭合（fence finalize 落在 complete 之后）
  return `${intro}\n\n\`\`\`js\n${lines.join('\n')}\n\`\`\``
}

/** 页内 rAF 采样器：每帧记录滚动几何（帧粒度 = 「两帧」判据的原生分辨率）。 */
const SAMPLER_INSTALL_FN = `() => {
  if (window.__followSampler) return false
  window.__followSamples = []
  const tick = () => {
    const el = document.querySelector('.message-stream')
    if (el) {
      const s = window.__followSamples
      s.push({ w: Date.now(), st: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight })
      if (s.length > 3000) s.splice(0, s.length - 2400)
    }
    window.__followRaf = requestAnimationFrame(tick)
  }
  window.__followSampler = tick
  window.__followRaf = requestAnimationFrame(tick)
  return true
}`
const SAMPLER_FETCH_FN = `() => ({ count: (window.__followSamples ?? []).length, samples: window.__followSamples ?? [] })`
const SAMPLER_STOP_FN = `() => {
  if (window.__followRaf) cancelAnimationFrame(window.__followRaf)
  window.__followRaf = null
  window.__followSampler = null
  return (window.__followSamples ?? []).length
}`

export const meta = {
  id: 'follow-blindzone-converge',
  priority: 'P0',
  title: '盲区高度变化兜底（A5：回合结束后高亮高度变化补滚 ≤ 窗口+两帧）+ 回合切换收敛（A10）',
  covers: ['chat.send', 'chat.stream', 'chat.wait', 'render.shiki'],
  requires: ['faux'],
  estimateSec: 180,
  faux: {
    responses: [{ text: buildLongText(), stopReason: 'stop' }, { text: '收到，新回合已就绪。', stopReason: 'stop' }],
    tps: 30,
  },
  provable: [
    'A5：回合结束后存在高度变化事件（|ΔscrollHeight| ≥15px 的帧采样），且每次事件后 distance ≤40 的收敛延迟 ≤ debounce 窗口值 + 两帧（+采样量化两帧）',
    'A10：贴底态 composer 发送新回合，回合切换（发送后首个高度增长帧）到收敛（distance ≤40）延迟 ≤ debounce 窗口值 + 两帧（+采样量化两帧）',
    'A：代码块已渲染（回合结束后 pre 元素在场）',
    'B：两轮回合均正常收尾',
  ],
  notProvable: [
    'shiki 高亮的视觉正确性（像素级归 e2e-visual；本剧本只用它产生「无数据信号的高度变化」）',
    '基线预期 pass（现状 RO 每投递即触发 = 收敛更快），实施后 A5/A10 才真正压测 debounce 窗尾上界',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, instance, repo } = ctx
  const uncovered = []
  const gotchas = [
    'A10 发送必须走 composer（pressSequentially + Enter）：协议直发不动 submitSeq（F1 排除外来直发），force/回合切换触发链只有 composer 提交完整点亮',
    '回合结束后高度变化的确定性载体 = 未闭合围栏的 fence finalize + shiki 异步高亮（现状注释登记的盲区源）；剧本把围栏闭合放在文本最末',
    '采样 = 页内 rAF 每帧记录（帧粒度原生分辨率）；收敛判据 = distance ≤ 40（BOTTOM_THRESHOLD）',
    `debounce 窗口值读自 ${TRIGGERS_SOURCE}（实施后）；基线回落设计初值 250ms`,
  ]

  const ui = ctx.ui
  const page = await instance.page()
  const debounce = readDebounceMs(repo)
  const limitMs = debounce.ms + (2 + SAMPLE_SLACK_FRAMES) * FRAME_MS
  log(`debounce=${debounce.ms}ms（${debounce.source}）convergeLimit=${limitMs.toFixed(1)}ms`)

  try {
    // ── 建会话 + UI 激活链 ────────────────────────────────────────────────
    const created = await protocol.call('session.create', { cwd: repo, label: 'follow-blindzone-converge' }, { timeoutMs: 120_000 })
    const sid = created.session?.id
    if (!sid) throw new Error(`session.create 未返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
    await protocol.subscribe(sid)
    await ui.click('css=.session-item', { timeoutMs: 30_000 })
    ev.step({ step: 'ui.activate', channel: 'A', exitCode: 0, stats: { sid, debounceMs: debounce.ms, debounceSource: debounce.source, convergeLimitMs: Number(limitMs.toFixed(1)) } })

    // ── 装采样器（send 前）→ 发起带代码块的长回合 ──────────────────────────
    const installed = await page.evaluate(SAMPLER_INSTALL_FN)
    ev.step({ step: 'sampler.install', channel: 'A', exitCode: installed ? 0 : 1, stats: { installed } })

    const since = protocol.events.length
    await protocol.send(sid, '请输出一段以代码块结尾的说明')
    await ui.expectVisible('css=.stop-btn', { timeoutMs: 30_000 })
    const end1 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 120_000 })
    const completeAt = end1.at
    ev.assert('B: 代码块回合正常收尾', end1.type === 'message.complete' && end1.ok, {
      channel: 'B',
      expected: 'message.complete 非 error',
      actual: `${end1.type} stop=${end1.payload?.stopReason ?? 'n/a'}`,
    })

    // 等高亮/收敛观察窗（2.5s 覆盖 shiki 异步完成；采样器已全程记录，断言读测量值而非时钟）
    await new Promise((r) => setTimeout(r, 2500))

    // A 通道：代码块已渲染
    const preCount = await page.locator('css=.message-stream pre').count()
    ev.assert('A: 代码块已渲染（message-stream 内 pre 在场）', preCount > 0, {
      channel: 'A',
      expected: 'pre 元素 ≥ 1',
      actual: String(preCount),
    })

    // ── A5 分析：complete 之后的高度变化事件 → 收敛延迟 ─────────────────────
    const { samples } = await page.evaluate(SAMPLER_FETCH_FN)
    const post = samples.filter((s) => s.w >= completeAt - 80)
    const jumps = []
    for (let i = 1; i < post.length; i++) {
      const dsh = post[i].sh - post[i - 1].sh
      if (Math.abs(dsh) >= 15) {
        // 该事件时刻 distance 已 ≤40 = 未脱底（延迟 0）；否则找首个回贴帧
        let convergedAt = null
        if (post[i].sh - post[i].st - post[i].ch <= BOTTOM_THRESHOLD) {
          convergedAt = post[i].w
        } else {
          for (let j = i; j < post.length; j++) {
            if (post[j].sh - post[j].st - post[j].ch <= BOTTOM_THRESHOLD) {
              convergedAt = post[j].w
              break
            }
          }
        }
        jumps.push({ at: post[i].w, dsh, delayMs: convergedAt === null ? null : convergedAt - post[i].w })
      }
    }
    if (jumps.length === 0) {
      uncovered.push('A5 未观测到回合结束后的高度变化事件（|ΔscrollHeight| ≥15px）——盲区源（fence finalize / shiki 高亮）在本环境未产生可测高度变化，收敛延迟无法测量')
      ev.step({ step: 'a5.analyze', channel: 'A', exitCode: 1, stats: { postSamples: post.length, jumps: 0 } })
    } else {
      const delays = jumps.map((j) => j.delayMs).filter((d) => d !== null)
      const maxDelay = delays.length ? Math.max(...delays) : Number.POSITIVE_INFINITY
      const allConverged = delays.length === jumps.length
      ev.assert('A5: 每次盲区高度变化后收敛延迟 ≤ 窗口值 + 两帧', allConverged && maxDelay <= limitMs, {
        channel: 'A',
        expected: `≤ ${limitMs.toFixed(1)}ms（debounce ${debounce.ms} + 两帧 ${(2 * FRAME_MS).toFixed(1)} + 采样量化两帧）`,
        actual: `事件 ${jumps.length} 个（Δsh: ${jumps.map((j) => j.dsh).join(',')}），最大延迟 ${Number.isFinite(maxDelay) ? maxDelay.toFixed(0) : '∞'}ms，全部收敛=${allConverged}`,
      })
      ev.step({ step: 'a5.analyze', channel: 'A', exitCode: allConverged && maxDelay <= limitMs ? 0 : 1, stats: { jumps: jumps.length, maxDelayMs: Number.isFinite(maxDelay) ? Number(maxDelay.toFixed(1)) : null, limitMs: Number(limitMs.toFixed(1)) } })
    }
    ev.attach('blindzone-jumps.json', JSON.stringify(jumps, null, 2))

    // ── A10：贴底态 composer 发送新回合 → 回合切换收敛延迟 ───────────────────
    const tail = await page.evaluate(SAMPLER_FETCH_FN)
    const lastSample = tail.samples[tail.samples.length - 1]
    const stickyBefore = lastSample ? lastSample.sh - lastSample.st - lastSample.ch <= BOTTOM_THRESHOLD : false
    ev.assert('A10 前置: 发送前处于贴底态', stickyBefore, {
      channel: 'A',
      expected: 'distance ≤ 40',
      actual: lastSample ? `d=${(lastSample.sh - lastSample.st - lastSample.ch).toFixed(1)}` : 'samples 空',
    })

    const sendText = `回合切换收敛验收-${Date.now().toString(36)}`
    await ui.type('role=textbox', sendText, { timeoutMs: 10_000 })
    const t0 = Date.now()
    const since2 = protocol.events.length // Enter 前捕获（faux 极快时 complete 可能先入队）
    await ui.press('Enter')
    const end2 = await protocol.waitTurnEnd(sid, { since: since2, timeoutMs: 60_000 })
    ev.assert('B: 新回合正常收尾', end2.type === 'message.complete' && end2.ok, {
      channel: 'B',
      expected: 'message.complete 非 error',
      actual: `${end2.type} stop=${end2.payload?.stopReason ?? 'n/a'}`,
    })
    await new Promise((r) => setTimeout(r, 1500))
    await page.evaluate(SAMPLER_STOP_FN)
    const after = await page.evaluate(SAMPLER_FETCH_FN)

    // 分析：t0 之后首个「高度增长帧」= 回合切换可见点；到首个 distance ≤40 帧的延迟
    const postSend = after.samples.filter((s) => s.w >= t0)
    const switchIdx = postSend.findIndex((s, i) => i > 0 && s.sh - postSend[i - 1].sh >= 10)
    let switchDelay = null
    let fromEnter = null
    if (switchIdx > 0) {
      const switchAt = postSend[switchIdx].w
      const conv = postSend.find((s, i) => i >= switchIdx && s.sh - s.st - s.ch <= BOTTOM_THRESHOLD)
      if (conv) {
        switchDelay = conv.w - switchAt
        fromEnter = switchAt - t0
      }
    }
    ev.assert('A10: 回合切换收敛延迟 ≤ 窗口值 + 两帧', switchDelay !== null && switchDelay <= limitMs, {
      channel: 'A',
      expected: `≤ ${limitMs.toFixed(1)}ms（debounce ${debounce.ms} + 两帧 + 采样量化两帧）`,
      actual: switchDelay === null ? '未测得（发送后无高度增长帧或未收敛）' : `切换→收敛 ${switchDelay.toFixed(0)}ms（Enter→切换 ${fromEnter?.toFixed(0)}ms 为投递 RTT，不计入判据）`,
    })
    ev.step({ step: 'a10.converge', channel: 'A', exitCode: switchDelay !== null && switchDelay <= limitMs ? 0 : 1, stats: { switchDelayMs: switchDelay, fromEnterMs: fromEnter, limitMs: Number(limitMs.toFixed(1)) } })

    // 发送后的新回合内容可见（回合切换事实面）
    const sentVisible = (await ui.html('css=body')).includes(sendText)
    ev.assert('A: 刚发送的新回合消息在对话流可见', sentVisible, {
      channel: 'A',
      expected: 'user 气泡含发送原文',
      actual: sentVisible ? 'body HTML 命中' : '未命中',
    })

    ev.attach('converge-samples.json', JSON.stringify({ total: after.count, postSendSamples: postSend.length }, null, 2))
    await ev.shot(await instance.page(), 'blindzone-converge-done')
    log(`done sid=${sid} jumps=${jumps.length} switchDelay=${switchDelay?.toFixed(0) ?? 'n/a'}ms`)
  } finally {
    await page.evaluate(SAMPLER_STOP_FN).catch(() => {})
  }
  return { uncovered, gotchas }
}
