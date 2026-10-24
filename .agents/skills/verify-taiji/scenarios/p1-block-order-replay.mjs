/**
 * p1-block-order-replay —— 块序与展开回看（chat-flow-consistency 验收计划表 A3 / L3 行）。
 *
 * 装配：faux（kitchen-sink 形态：thinking + 工具调用（成功 + 失败各一）+ 收尾文本，
 * 两 step 同一 turn——step1 stopReason=toolUse 触发工具续轮，step2 收尾文本）。
 * 路径：
 *   段 1 块序（live）——发送 → 轮完成 → 完成态 trace 默认折叠（use-turn-trace：
 *   showTrace = isWorkingTurn || isExpanded，折叠态只渲染末位 text 块）→
 *   点 turn-meta 展开钮 → DOM 断言块序 thinking → tool（含失败块）→ text，
 *   且三块归属同一 turn（用户哨兵与三块同容器）。
 *   段 2 B 通道对账——session.history 的 assistant 消息序与 toolCalls/thinking/正文一致。
 *   段 3 reload ≡ live——page.reload() 后重激活会话、再展开 trace，
 *   抽取同一结构（块类序列 + 哨兵命中）与 live 逐项比对（定稿权威重建
 *   packages/core/src/domain/chat/effects/finalized-rebuild.ts：message_end 按载荷
 *   整条重建，live ≡ reload 构造性成立）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const meta = {
  id: 'p1-block-order-replay',
  priority: 'P1',
  title: '块序与展开回看：thinking→工具（含失败）→文本块序 + 完成态折叠/展开 + reload ≡ live',
  covers: ['session.create', 'chat.send', 'chat.wait', 'chat.stream', 'session.history', 'chat.reload-equiv', 'render.tool-call'],
  requires: ['faux'],
  estimateSec: 150,
  faux: {
    responses: [
      {
        thinking: 'BLOCK-ORDER 思考段：先分析请求，再调用两个工具（一个成功、一个失败），最后给结论。',
        toolCalls: [
          { name: 'bash', args: { command: 'echo BLOCK-ORDER-TOOL-OK' } },
          { name: 'bash', args: { command: 'echo BLOCK-ORDER-TOOL-FAIL-STDERR >&2; exit 7' } },
        ],
        stopReason: 'toolUse',
      },
      { text: '工具执行完毕（一成一败），给出正文结论 BLOCK-ORDER-TEXT-END。', stopReason: 'stop' },
    ],
  },
  provable: [
    'A：完成态 trace 默认折叠（工具块/思考块不进 DOM，仅末位 text 正文）',
    'A：点 turn-meta 展开钮后工具块锚点（block-tool-* 或 run-group）与思考块锚点进 DOM',
    'A：块序 = thinking → 工具（含失败块，失败输出可见）→ text，且三块与用户消息哨兵同 turn（归属正确）',
    'B：session.history 的 assistant 消息序（thinking+toolCalls 在前、text 收尾）与 UI 块序一致',
    'A：page.reload() 重激活再展开后，块类序列与哨兵命中与 live 逐项一致（定稿重建 live ≡ reload）',
  ],
  notProvable: [
    '流式中途的块逐步出现过程（瞬态展示；本剧本验终态块序与 reload 等价，中途态归 p0-chat-stream-ui 域）',
    '失败工具块的 danger 视觉样式（像素级归 e2e-visual；本剧本断言失败输出文本可见）',
  ],
}

/** body innerHTML 条件轮询（虚拟列表回收视口外内容时 innerHTML 仍为全量 DOM，同 p0-chat-stream-ui）。 */
async function pollBodyHtml(ui, needle, { timeoutMs = 30_000, intervalMs = 400, wantPresent = true } = {}) {
  const deadline = Date.now() + timeoutMs
  let html = ''
  while (Date.now() < deadline) {
    html = await ui.html('css=body')
    if (html.includes(needle) === wantPresent) return html
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return html
}

/** 抽取按 turn 分组的块结构（page.evaluate；块 id 归一为类前缀，消除运行时 id 差异）。 */
async function extractTurnBlocks(page, userSentinel) {
  return page.evaluate(
    ({ userSentinel }) => {
      const kindOf = (id) => {
        if (id.startsWith('block-thinking-')) return 'thinking'
        if (id.startsWith('block-tool-')) return 'tool'
        if (id === 'block-text') return 'text'
        if (id === 'block-text-error') return 'text-error'
        if (id === 'run-group') return 'run-group'
        return id
      }
      const turns = [...document.querySelectorAll('[data-testid^="turn-"]')]
      return turns.map((turnEl) => {
        const blocks = [...turnEl.querySelectorAll('[data-testid^="block-"], [data-testid="run-group"]')].map((el) =>
          kindOf(el.getAttribute('data-testid') ?? ''),
        )
        const text = turnEl.textContent ?? ''
        return {
          turnId: turnEl.getAttribute('data-testid') ?? '',
          hasUserSentinel: text.includes(userSentinel),
          hasThinkingContent: text.includes('思考'),
          hasToolOk: text.includes('BLOCK-ORDER-TOOL-OK'),
          hasToolFail: text.includes('BLOCK-ORDER-TOOL-FAIL-STDERR'),
          hasTextEnd: text.includes('BLOCK-ORDER-TEXT-END'),
          blockKinds: blocks,
        }
      })
    },
    { userSentinel },
  )
}

/** 块序断言：目标 turn 内 first(thinking) < first(tool|run-group) < first(text)。 */
function blockOrderOf(turn) {
  const kinds = turn?.blockKinds ?? []
  const idx = (pred) => kinds.findIndex(pred)
  const t = idx((k) => k === 'thinking')
  const tool = idx((k) => k === 'tool' || k === 'run-group')
  const text = idx((k) => k === 'text')
  return { t, tool, text, kinds }
}

export async function run(ctx) {
  const { protocol, ev, log } = ctx
  const ui = ctx.ui
  const page = await ctx.instance.page()
  const uncovered = []
  const gotchas = [
    '完成态 trace 折叠是设计内行为（use-turn-trace showTrace = isWorkingTurn || isExpanded）：工具块断言前必须点 turn-meta 展开钮（Button.turn-meta，disabled = isWorkingTurn || !hasFoldable）',
    '两个连续 bash 工具会走 run-group 分组（groupToolRuns）：块序断言对 tool 与 run-group 前缀均兼容',
    '块 id 归一后比对（block-thinking-<id> 的实时 id 与载荷派生 id 不同源，finalized-rebuild 注释在案）；等价断言比块类序列 + 哨兵命中，不比运行时 id',
  ]
  const USER_SENTINEL = 'BLOCK-ORDER-USER-Q1'
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-block-order-'))
  log(`临时会话 cwd=${cwd}`)

  try {
    // ── 段 0：建会话 + UI 激活 ────────────────────────────────
    const created = await protocol.call('session.create', { cwd, label: 'p1-block-order-replay' }, { timeoutMs: 120_000 })
    const sid = created.session?.id
    if (!sid) throw new Error(`session.create 未返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
    await protocol.subscribe(sid)
    await ui.click('css=.session-item', { timeoutMs: 30_000 })
    ev.step({ step: 'ui.activate', channel: 'A', exitCode: 0, stats: { sid } })

    // ── 段 1：发送 + 轮完成 ──────────────────────────────────
    const since = protocol.events.length
    await protocol.send(sid, `请按 kitchen-sink 顺序演示：先思考、再跑两个工具（一成一败）、最后总结。${USER_SENTINEL}`)
    const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert('B: 混合轮（thinking+工具+文本）正常完成', end.ok === true, {
      channel: 'B', expected: 'message.complete 非 error', actual: `${end.type} stop=${end.payload?.stopReason ?? ''}`,
    })
    ev.step({ step: 'chat.turn', channel: 'B', exitCode: end.ok ? 0 : 1, stats: { stopReason: end.payload?.stopReason ?? null } })

    // 等 UI 收尾（complete ≠ 渲染完成；停止位消失 = renderer 侧回合收尾）
    let settledHtml = ''
    {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        settledHtml = await ui.html('css=body')
        if (settledHtml.includes('BLOCK-ORDER-TEXT-END') && !settledHtml.includes('stop-btn')) break
        await new Promise((r) => setTimeout(r, 400))
      }
    }
    const settledOk = settledHtml.includes('BLOCK-ORDER-TEXT-END') && !settledHtml.includes('stop-btn')
    ev.assert('A: 回合完成（正文哨兵可见 + 停止位消失）', settledOk, {
      channel: 'A',
      expected: 'body 含 BLOCK-ORDER-TEXT-END 且无 stop-btn',
      actual: `text=${settledHtml.includes('BLOCK-ORDER-TEXT-END')} stopGone=${!settledHtml.includes('stop-btn')}`,
    })
    if (!settledOk) {
      return { uncovered: ['回合未在 UI 收尾（哨兵/停止位状态不符），后续断言全部依赖它，未执行'], gotchas }
    }

    // ── 段 2：完成态默认折叠 ─────────────────────────────────
    const collapsedHtml = settledHtml
    const collapsedOk =
      !collapsedHtml.includes('block-tool-') && !collapsedHtml.includes('run-group') && !collapsedHtml.includes('block-thinking-')
    ev.assert('A: 完成态 trace 默认折叠（工具/思考块不进 DOM）', collapsedOk, {
      channel: 'A',
      expected: '折叠态仅末位 text 正文，无 block-tool- / run-group / block-thinking-',
      actual: `tool=${collapsedHtml.includes('block-tool-')} group=${collapsedHtml.includes('run-group')} thinking=${collapsedHtml.includes('block-thinking-')}`,
    })
    await ev.shot(page, 'collapsed-default')

    // ── 段 3：展开 + 块序 ────────────────────────────────────
    let expandClicked = false
    try {
      await ui.click('css=[data-testid^="turn-meta-"] button.turn-meta', { timeoutMs: 10_000 })
      expandClicked = true
    } catch (e) {
      ev.attach('expand-click-miss', String(e?.message ?? e).slice(0, 400))
    }
    ev.step({ step: 'ui.expand', channel: 'A', exitCode: expandClicked ? 0 : 1, stats: { expandClicked } })

    const expandedHtml = await pollBodyHtml(ui, 'block-tool-', { timeoutMs: 15_000 })
    const expandedOk = expandedHtml.includes('block-tool-') || expandedHtml.includes('run-group')
    ev.assert('A: 展开后工具块锚点进 DOM（block-tool-* / run-group）', expandedOk, {
      channel: 'A',
      expected: 'block-tool- 或 run-group 出现',
      actual: `tool=${expandedHtml.includes('block-tool-')} group=${expandedHtml.includes('run-group')}`,
    })
    if (!expandedOk) {
      uncovered.push('展开交互后工具块锚点未现（turn-meta 展开钮命中但块未渲染，现场见展开后截图与 probe）')
      try {
        const ids = await page.evaluate(() =>
          [...document.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid')).slice(0, 80),
        )
        ev.attach('testid-probe-after-expand', JSON.stringify(ids))
      } catch { /* ignore */ }
      await ev.shot(page, 'expand-miss')
      return { uncovered, gotchas }
    }

    const liveStructure = await extractTurnBlocks(page, USER_SENTINEL)
    ev.attach('live-turn-structure', JSON.stringify(liveStructure, null, 2))
    const liveTurn = liveStructure.find((t) => t.hasUserSentinel && t.blockKinds.length > 0)
    ev.assert('A: 块与用户哨兵同 turn（归属正确）', Boolean(liveTurn), {
      channel: 'A',
      expected: `turn-${liveStructure.length - 1} 同时含用户哨兵与块`,
      actual: liveStructure.map((t) => `${t.turnId}:${t.blockKinds.join('>')}`).join(' | ').slice(0, 300),
    })
    if (!liveTurn) {
      return { uncovered: [...uncovered, '归属断言失败：找不到同时含用户哨兵与内容块的 turn'], gotchas }
    }
    const order = blockOrderOf(liveTurn)
    ev.assert(
      'A: 块序 = thinking → 工具 → 文本',
      order.t >= 0 && order.tool >= 0 && order.text >= 0 && order.t < order.tool && order.tool < order.text,
      {
        channel: 'A',
        expected: 'first(thinking) < first(tool|run-group) < first(text)',
        actual: `idx thinking=${order.t} tool=${order.tool} text=${order.text} kinds=[${order.kinds.join(',')}]`,
      },
    )
    const toolCount = order.kinds.filter((k) => k === 'tool').length
    ev.assert('A: 工具块数量 = 2（成功 + 失败）', toolCount === 2, {
      channel: 'A', expected: '2 个 block-tool-*', actual: `count=${toolCount} kinds=[${order.kinds.join(',')}]`,
    })
    // 失败块可见：失败工具默认展开（ToolRow failed 终态默认展开，错误输出立即可见）
    const failVisible = liveTurn.hasToolFail || expandedHtml.includes('run-group-failed')
    ev.assert('A: 失败块可见（失败工具输出 / run-group 失败徽标）', failVisible, {
      channel: 'A',
      expected: 'body 含 BLOCK-ORDER-TOOL-FAIL-STDERR 或 run-group-failed',
      actual: `failOut=${liveTurn.hasToolFail} badge=${expandedHtml.includes('run-group-failed')}`,
    })
    await ev.shot(page, 'expanded-block-order')

    // ── 段 4：B 通道对账（history 消息序） ────────────────────
    const hist = await protocol.history(sid, { limitTurns: 10 })
    const histText = JSON.stringify(hist.messages ?? [])
    const assistants = (hist.messages ?? []).filter((m) => m.role === 'assistant')
    const firstAssistantHasTools = JSON.stringify(assistants[0] ?? {}).includes('bash')
    const lastAssistantHasText = JSON.stringify(assistants[assistants.length - 1] ?? {}).includes('BLOCK-ORDER-TEXT-END')
    ev.assert(
      'B: history assistant 序 = thinking+toolCalls 在前、text 收尾',
      firstAssistantHasTools && lastAssistantHasText && histText.includes('BLOCK-ORDER-TOOL-OK'),
      {
        channel: 'B',
        expected: '首条 assistant 含 bash toolCalls（含成功输出），末条 assistant 含正文哨兵',
        actual: `assistants=${assistants.length} tools=${firstAssistantHasTools} text=${lastAssistantHasText} okOut=${histText.includes('BLOCK-ORDER-TOOL-OK')}`,
      },
    )
    ev.step({ step: 'session.history', channel: 'B', exitCode: 0, stats: { assistants: assistants.length } })

    // ── 段 5：reload ≡ live ──────────────────────────────────
    await page.reload()
    await ui.expectVisible('css=.session-item', { timeoutMs: 60_000 })
    await ui.click('css=.session-item', { timeoutMs: 30_000 })
    const reloadedHtml = await pollBodyHtml(ui, 'BLOCK-ORDER-TEXT-END', { timeoutMs: 30_000 })
    ev.assert('A: reload 后会话内容在场（正文哨兵）', reloadedHtml.includes('BLOCK-ORDER-TEXT-END'), {
      channel: 'A', expected: 'BLOCK-ORDER-TEXT-END', actual: `hit=${reloadedHtml.includes('BLOCK-ORDER-TEXT-END')}`,
    })
    // reload 后 trace 又回折叠态：先断言折叠，再展开，取同构快照
    const reloadedCollapsed =
      !reloadedHtml.includes('block-tool-') && !reloadedHtml.includes('run-group') && !reloadedHtml.includes('block-thinking-')
    ev.assert('A: reload 后完成态默认折叠（与 live 同语义）', reloadedCollapsed, {
      channel: 'A',
      expected: '折叠态无块锚点',
      actual: `tool=${reloadedHtml.includes('block-tool-')} group=${reloadedHtml.includes('run-group')} thinking=${reloadedHtml.includes('block-thinking-')}`,
    })
    let reloadExpandOk = false
    try {
      await ui.click('css=[data-testid^="turn-meta-"] button.turn-meta', { timeoutMs: 10_000 })
      const h = await pollBodyHtml(ui, 'block-tool-', { timeoutMs: 15_000 })
      reloadExpandOk = h.includes('block-tool-') || h.includes('run-group')
    } catch (e) {
      ev.attach('reload-expand-miss', String(e?.message ?? e).slice(0, 300))
    }
    ev.assert('A: reload 后展开交互可用', reloadExpandOk, { channel: 'A', expected: '展开后块锚点进 DOM', actual: `ok=${reloadExpandOk}` })

    const reloadStructure = await extractTurnBlocks(page, USER_SENTINEL)
    ev.attach('reload-turn-structure', JSON.stringify(reloadStructure, null, 2))
    const norm = (struct) =>
      JSON.stringify(
        struct.map((t) => ({
          hasUserSentinel: t.hasUserSentinel,
          hasThinkingContent: t.hasThinkingContent,
          hasToolOk: t.hasToolOk,
          hasToolFail: t.hasToolFail,
          hasTextEnd: t.hasTextEnd,
          blockKinds: t.blockKinds,
        })),
      )
    const equivOk = norm(liveStructure) === norm(reloadStructure)
    ev.assert('A: reload 后块类序列与哨兵命中 ≡ live（定稿重建等价）', equivOk, {
      channel: 'A',
      expected: '归一结构逐项一致',
      actual: equivOk ? '一致' : `live=${norm(liveStructure).slice(0, 200)} reload=${norm(reloadStructure).slice(0, 200)}`,
    })
    await ev.shot(page, 'reloaded-equivalence')

    // ── 段 6：C 通道留档（pi session JSONL entry 序） ─────────
    const sessionFile = findSessionFile(ctx.dataDir, sid)
    if (sessionFile) {
      const lines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean)
      const types = lines.map((l) => {
        try {
          return JSON.parse(l).type ?? '?'
        } catch {
          return 'unparseable'
        }
      })
      ev.attach('pi-entry-type-sequence', JSON.stringify(types))
      ev.step({ step: 'evidence.jsonl.types', channel: 'C', exitCode: 0, stats: { entries: types.length } })
    } else {
      ev.step({ step: 'evidence.jsonl.types', channel: 'C', exitCode: 0, stats: { sessionFile: null } })
    }

    log(`done sid=${sid}`)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
  return { uncovered, gotchas }
}

/** 扫 <dataDir>/agent/sessions 树找文件名含 sid 的 pi 会话 JSONL（同 p1-chat-revoke）。 */
function findSessionFile(dataDir, sid) {
  const root = path.join(dataDir, 'agent', 'sessions')
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name.includes(sid)) return full
    }
  }
  return null
}
