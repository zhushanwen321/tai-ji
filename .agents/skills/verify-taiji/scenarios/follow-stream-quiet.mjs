/**
 * follow-stream-quiet —— 流式长回合贴底跟随的控制台安静度（stream-follow-reshape 验收项 A1 + A8）。
 *
 * 设计依据：stream-follow-reshape.md §4 场景 S1（告警归零）+ S7（debounce 重置可观测）；
 * 验收项 A1 = 流式全程「ResizeObserver loop completed with undelivered notifications」计数 = 0；
 * 验收项 A8 = dev 构建 console 出现触发编排层（useMessageStreamFollowTriggers）的
 * debounce 重置窗尾汇总行（含重置次数）。剧本内用宽松正则（/重置/ + 数字）匹配，
 * 避免过绑实现文案；debounce 逻辑属 D2 实施物——基线（实施前）两条断言预期 fail，
 * fail 即检测力证明，不是剧本缺陷。
 *
 * 装配：faux（真 Electron + 真 pi 子进程 + 假 LLM 演员，零 token）+ TAIJI_FAUX_TPS=30
 * 拉长流式窗口。长文本 ≈8800 字符（faux estimateTokens = ceil(chars/4) ≈ 2200 token，
 * 满足「≥2000 token」），流式窗口 ≈73s——足以复现基线逐帧告警刷屏（设计 §1：单段连发
 * 234/131/90 条）。会话 cwd 用 mkdtemp 自建临时目录（本剧本零工具调用，不落任何文件）。
 *
 * 路径：
 *   A（console/pageerror 采集）：流式全程监听，统计 RO loop 告警条数（A1）+
 *   全量 console 文本落证据（A8 宽松匹配 /重置/ + 数字的汇总行）；
 *   B（协议）：message.complete 的 usage.outputTokens ≥ 2000（「长回合」量化判据）；
 *   C（磁盘）：<dataDir>/logs/renderer-error-<date>.log 的告警条目增量（error-reporter
 *   逐条转发的落盘面，A1 第二通道；D5 落地后该通道变聚合计数——断言仍按「含告警串的行数
 *   不增长」记，语义不变）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** RO loop 告警匹配（Chromium 固定文案，design §1 / D5 判据常量同源）。 */
const RO_LOOP_RE = /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/i

/** 长响应文本：8800 字符 ≈ 2200 token（estimateTokens = ceil(len/4)）。 */
function buildLongText() {
  const para = '流式跟随验收段落：这段文本持续追加只为拉高流式窗口与页面高度，内容本身无语义。'
  let text = ''
  while (text.length < 8800) text += para
  return text
}

export const meta = {
  id: 'follow-stream-quiet',
  priority: 'P0',
  title: '流式长回合控制台安静度：RO loop 告警归零（A1）+ debounce 重置窗尾汇总行（A8）',
  covers: ['chat.send', 'chat.stream', 'chat.wait'],
  requires: ['faux'],
  estimateSec: 240,
  faux: {
    responses: [{ text: buildLongText(), stopReason: 'stop' }],
    tps: 30,
  },
  provable: [
    'B：回合以 message.complete 正常收尾且产出 ≥2000 token（complete.content ≥8000 字符，estimateTokens 同源估算）',
    'A1：流式全程（send 前 → complete 后）页面 console + pageerror 中 RO loop 告警计数 = 0',
    'A1-C：renderer-error 日志中含该告警串的行数零增长',
    'A8：console 出现触发编排层 debounce 重置窗尾汇总行（宽松匹配：含「重置」且含数字）',
  ],
  notProvable: [
    'A8 汇总行的具体文案与重置次数语义（D2 未实施前断言必然 fail——基线预期 fail 即检测力证明，实施后在 D1 复跑换绿）',
    '告警是否曾出现过又消失（计数是全量累计，无时序剖面）——时序剖面归 S2/Performance 面板人工观测',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, instance, dataDir } = ctx
  const uncovered = []
  const gotchas = [
    'faux estimateTokens = ceil(chars/4)：≥2000 token 要求文本 ≥8000 字符（pi-ai dist/providers/faux.js estimateTokens 源码核对）',
    'RO loop 告警在 Chromium 走 window.onerror 面（无堆栈）+ console error 双出现：计数取 console + pageerror 并集按文案去重',
    'renderer-error-<date>.log 是 error-reporter 逐条转发面（D5 实施后变聚合计数）——断言按「含告警串的行数零增长」',
    'TAIJI_FAUX_TPS=30：2200 token ÷ 30 ≈ 73s 流式窗口；调大 TPS 会压缩告警复现窗口',
  ]

  // ── console / pageerror 采集器（必须在 send 前挂上）──────────────────────────
  const page = await instance.page()
  const consoleLog = [] // 全量 console 文本（A8 证据面）
  let roLoopConsole = 0
  let roLoopPageError = 0
  const onConsole = (msg) => {
    const text = msg.text?.() ?? ''
    consoleLog.push(`${new Date().toISOString()} [console.${msg.type()}] ${text.slice(0, 400)}`)
    if (RO_LOOP_RE.test(text)) roLoopConsole += 1
  }
  const onPageError = (err) => {
    const text = String(err?.message ?? err)
    consoleLog.push(`${new Date().toISOString()} [pageerror] ${text.slice(0, 400)}`)
    if (RO_LOOP_RE.test(text)) roLoopPageError += 1
  }
  page.on('console', onConsole)
  page.on('pageerror', onPageError)

  // C 通道基线：renderer-error 日志当前告警行数（实例刚起，理论为 0；取增量防历史污染）
  const rendererErrorCount = () => {
    const logDir = path.join(dataDir, 'logs')
    let hits = 0
    try {
      for (const f of fs.readdirSync(logDir)) {
        if (!f.startsWith('renderer-error-')) continue
        const text = fs.readFileSync(path.join(logDir, f), 'utf8')
        hits += text.split('\n').filter((line) => RO_LOOP_RE.test(line)).length
      }
    } catch {
      /* 目录未建 = 零条 */
    }
    return hits
  }
  const cBaseline = rendererErrorCount()

  const ui = ctx.ui
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-follow-quiet-'))
  log(`临时会话 cwd=${cwd}`)

  try {
    // ── 建会话 + UI 激活链 ────────────────────────────────────────────────
    const created = await protocol.call('session.create', { cwd, label: 'follow-stream-quiet' }, { timeoutMs: 120_000 })
    const sid = created.session?.id
    if (!sid) throw new Error(`session.create 未返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
    await protocol.subscribe(sid)
    await ui.click('css=.session-item', { timeoutMs: 30_000 })
    ev.step({ step: 'ui.activate', channel: 'A', exitCode: 0, stats: { sid } })

    // ── 发起长流式回合（贴底态全程，不触碰输入设备）─────────────────────────
    const since = protocol.events.length
    await protocol.send(sid, '请输出一段很长的流式文本')
    ev.step({ step: 'chat.send', channel: 'B', exitCode: 0, stats: { sid, consoleBaseline: { roLoopConsole, roLoopPageError } } })

    // 流式窗口确认：停止位出现 = isGenerating（A 通道），随后才开始有意义
    await ui.expectVisible('css=.stop-btn', { timeoutMs: 30_000 })
    const midStream = { roLoopConsole, roLoopPageError }
    ev.step({ step: 'stream.window.confirm', channel: 'A', exitCode: 0, stats: { midStreamRoLoop: midStream } })

    // 等回合收尾（faux 2200 token @ TPS=30 ≈ 73s；给 180s）
    const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert('B: 长流式回合正常收尾', end.type === 'message.complete' && end.ok, {
      channel: 'B',
      expected: 'message.complete 非 error',
      actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
    })

    // B 通道：长回合量化判据 ≥2000 token。wire 的 message.complete payload 不带 usage
    // （usage 只进 turn-end 元数据），带 content = 最终全文——token 按同源估算
    // （estimateTokens = ceil(chars/4)，faux 与 pi 共用）判定：chars ≥ 8000 ⇔ ≥2000 token。
    const finalContent = typeof end.payload?.content === 'string' ? end.payload.content : ''
    const outputTokens = Math.ceil(finalContent.length / 4)
    ev.assert('B: 产出 ≥2000 token（complete.content 字符数同源估算）', outputTokens >= 2000, {
      channel: 'B',
      expected: 'content ≥8000 字符（estimateTokens=ceil(chars/4) ⇔ ≥2000 token）',
      actual: `content=${finalContent.length} 字符 ≈${outputTokens} token`,
    })
    ev.step({ step: 'chat.wait', channel: 'B', exitCode: end.ok ? 0 : 1, stats: { stopReason: end.payload?.stopReason ?? null, outputTokens } })

    // ── A1：RO loop 告警归零（console + pageerror 并集）────────────────────
    const roLoopTotal = roLoopConsole + roLoopPageError
    ev.assert('A1: 全程 RO loop 告警计数 = 0（console+pageerror）', roLoopTotal === 0, {
      channel: 'A',
      expected: 'ResizeObserver loop 告警 0 条',
      actual: `console=${roLoopConsole} pageerror=${roLoopPageError} total=${roLoopTotal}（基线预期 >0：D1 未实施，fail 即检测力证明）`,
    })

    // A1 第二通道（C）：renderer-error 日志增量
    const cAfter = rendererErrorCount()
    const cDelta = cAfter - cBaseline
    ev.assert('C: renderer-error 日志告警行数零增长', cDelta === 0, {
      channel: 'C',
      expected: `增量 0（基线 ${cBaseline}）`,
      actual: `增量 ${cDelta}（现值 ${cAfter}）`,
    })
    ev.step({ step: 'a1.roloop.count', channel: 'A', exitCode: roLoopTotal === 0 ? 0 : 1, stats: { roLoopTotal, roLoopConsole, roLoopPageError, rendererErrorDelta: cDelta } })

    // ── A8：debounce 重置窗尾汇总行（宽松正则：含「重置」+ 数字）────────────────
    const resetLine = consoleLog.find((line) => /重置/.test(line) && /\d/.test(line))
    ev.assert('A8: console 出现 debounce 重置窗尾汇总行（含「重置」+ 数字）', Boolean(resetLine), {
      channel: 'A',
      expected: '触发编排层 dev 分支窗尾汇总（宽松匹配，避免过绑实现文案）',
      actual: resetLine ? resetLine.slice(0, 300) : '未出现（基线预期缺失：D2 未实施，fail 即检测力证明）',
    })
    ev.step({ step: 'a8.debounce.resetline', channel: 'A', exitCode: resetLine ? 0 : 1, stats: { found: Boolean(resetLine) } })

    // 全量 console 落证据（A8 人工复核面；截断防日志风暴）
    ev.attach('console-during-round.txt', consoleLog.slice(-400).join('\n') || '（空）')

    await ev.shot(await instance.page(), 'stream-round-done')
    log(`done sid=${sid} roLoop=${roLoopTotal} resetLine=${Boolean(resetLine)}`)
  } finally {
    page.off('console', onConsole)
    page.off('pageerror', onPageError)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
  return { uncovered, gotchas }
}
