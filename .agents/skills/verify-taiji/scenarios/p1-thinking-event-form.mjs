/**
 * p1-thinking-event-form —— GLM 思考形态与空条目轮（chat-flow-consistency D3 · 验收项 8（A8））。
 *
 * 背景：GLM 事件形态 = 思考全文在 message_end 的 end.content、后续轮空思考条目；live 渲染曾出现
 * 一个进行中回合显示两段逐字相同思考块（D3 定稿权威重建已根治：finalized-rebuild 按 payload
 * 整条重建 + thinking 同 id 幂等）。本剧本验该缺陷不复现 + live ≡ reload 不变量在思考形态下成立。
 *
 * 装配：faux（主会话默认零 token 通道）。faux 造形态的最近似边界（faux-llm-ext.ts:124：
 * `step.thinking !== undefined` 才推 thinking 块）：
 *   - 「带 thinking 的轮」= step { thinking, text }（思考块 + 正文块）；
 *   - 「空思考条目轮」= step 不带 thinking 字段（该轮无思考条目）——faux 无法造「message_end
 *     含空 thinking part」的字节级形态，如实登记 notProvable。
 *
 * 路径：
 *   段 1 live——3 轮混合序列（轮 1 thinking+正文 / 轮 2 仅正文 / 轮 3 不同 thinking+正文）→
 *     A 折叠态：turn-meta「思考 ×N」chip 计数 = 1/0/1（完成轮默认折叠，Turn.vue trace 容器
 *     折叠态只渲染末位正文，chip 是思考块存在的产品口径信号）；
 *     A 展开态：点击各回合 .turn-meta 展开后回合容器内 thinking 行计数 = 1/0/1 + 两段思考
 *     预览互异（两段逐字相同思考块的旧缺陷在展开态直接可检）；
 *   段 2 B 通道——history 接口含两段 thinking 全文（哨兵全文子串匹配）；
 *   段 3 reload——page.reload 重建 renderer（chat store 清空 → 走盘重载 hydrate 全量基线接管）→
 *     重新激活会话 → 同流程展开 → 块序与内容 ≡ live。
 *
 * 现行锚点事实（2026-10-24 实跑两轮校准）：
 *   - turn 根 = `turn-${turn.index}`（Turn.vue:25；正则 /^turn-\d+$/ 过滤，排除回合内子元素）；
 *   - 完成轮 trace 默认折叠（Turn.vue:135-136「折叠态仅末位 text 正文」）——thinking 行
 *     不进 DOM，须先点击回合 .turn-meta（TurnMeta.vue:33-45 Button，@click toggle(turnKey)；
 *     disabled = isWorkingTurn || !hasFoldable，仅正文的轮 2 无可折叠内容不可点、也无需点）；
 *   - thinking 行根类 = `.trace-think`（ThinkingRow.vue:13，每块必渲染）——`block-thinking-<id>`
 *     testid 依赖原生 thinkingId（Block.vue:145-148），faux part 无 id 时不输出该属性；
 *   - 折叠态预览 = 头 60 字符（useThinkingCollapse.ts PREVIEW_LIMIT=60），哨兵置于句首可辨；
 *   - 「思考 ×N」chip = TurnMeta thinkCount（TurnMeta.vue:126，i18n key panel.message.thinkCount）。
 *   走盘重载换 thinking 块 id 空间（live u-id 与盘上 entry 派生 id 不相交，turn-expansion.ts
 *   头注释）——live ≡ reload 对比按「每回合 thinking 计数 + 预览内容序列」，不按块 id。
 */
export const meta = {
  id: 'p1-thinking-event-form',
  priority: 'P1',
  title: 'GLM 思考形态与空条目轮：每回合思考块单段渲染 + reload 重建块序 ≡ live + history 思考全文在案',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'chat.send', 'chat.wait', 'chat.stream',
    'session.history', 'chat.reload-equiv',
  ],
  requires: ['faux'],
  estimateSec: 240,
  faux: {
    // force：doctor 体检会从模板幂等创建实例目录，重跑时目录已存在，seed-faux 需授权覆盖
    force: true,
    responses: [
      {
        thinking:
          'THINK1-FORM-A8 first turn reasoning: verify the finalized rebuild keeps exactly one thinking block per turn and no duplicated thinking segment appears.',
        text: 'TEXT1-FORM-A8 first turn body answer.',
        stopReason: 'stop',
      },
      {
        text: 'TEXT2-FORM-A8 second turn body only, no thinking field in this faux step (nearest form of the empty-thinking-entry turn).',
        stopReason: 'stop',
      },
      {
        thinking:
          'THINK3-FORM-A8 third turn reasoning content is deliberately different from turn one so duplicated-segment defects cannot pass content-equality.',
        text: 'TEXT3-FORM-A8 third turn body answer.',
        stopReason: 'stop',
      },
    ],
  },
  provable: [
    'A 折叠态：turn-meta「思考 ×N」chip 计数 = 轮1:1 / 轮2:0 / 轮3:1（完成轮默认折叠，chip 是产品口径的每回合思考块计数）',
    'A 展开态：轮 1 回合容器内 thinking 行恰好 1 段（两段逐字相同思考块的旧缺陷不复现）',
    'A 展开态：轮 2 回合（空思考条目最近似形态）thinking 行 0 段',
    'A 展开态：轮 3 回合 thinking 行恰好 1 段，且预览内容与轮 1 互异',
    'B：history 接口含轮 1 / 轮 3 两段 thinking 全文（哨兵全文子串）与轮 2 正文',
    'reload：page.reload 后重新激活会话，同流程展开后每回合 thinking 行计数与预览内容序列 ≡ live',
  ],
  notProvable: [
    'GLM 空思考条目的字节级形态（message_end 的 end.content 含空 thinking part）——faux 只能造「不带 thinking 字段的轮」（faux-llm-ext.ts:124 thinking!==undefined 才推块）；空字符串 thinking step 的 UI 合法形态无规格锚，未纳入断言',
    'app 级重启（runtime 从磁盘重读 entry 流）形态——由 p0-session-persistence 承载（history 等价已验）；本剧本 reload 段 = renderer 走盘重载链路（chat store 清空 → hydrate）',
    'thinking 展开区全文的视觉形态（折叠态 60 字符预览 + B 通道 history 全文已覆盖内容面；展开交互归手工）',
    'live 流式中途态（thinking 流式展开中、turn 工作态窗口切片）——TPS 窗口与渲染时机在 faux 下不稳定（p0-chat-stream-ui 已登记同族 notProvable）',
  ],
}

/** 从页面抓「回合根 → {thinking 行预览序列, chip 计数, 回合文本摘要}」快照（纯数据，可 JSON 对比）。 */
async function captureTurnBlocks(page) {
  return page.$$eval('[data-testid]', (nodes) => {
    const turnRoots = nodes.filter((el) => /^turn-\d+$/.test(el.getAttribute('data-testid') ?? ''))
    return turnRoots.map((el) => {
      const thinking = [...el.querySelectorAll('.trace-think')].map((b) => ({
        // textContent 含「思考」label + 分隔点 + 头 60 字符预览；哨兵置于思考句首，includes 可辨
        preview: (b.textContent ?? '').trim().slice(0, 120),
      }))
      const text = (el.textContent ?? '').slice(0, 600)
      const chipCount = [...text.matchAll(/思考 ×(\d+)/g)].reduce((acc, m) => acc + Number(m[1]), 0)
      return { turn: el.getAttribute('data-testid'), thinking, chipCount, text }
    })
  })
}

/** 条件轮询 body innerHTML 直到哨兵出现（complete 事件先于 renderer 渲染完成）。 */
async function pollBodyHtml(ui, needle, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  let html = ''
  while (Date.now() < deadline) {
    html = await ui.html('css=body')
    if (html.includes(needle)) return html
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return html
}

/** 快照 → 含哨兵回合的 {turn, thinkingCount, previews} 列表。 */
function shapeOf(snapshot, sentinel) {
  return snapshot
    .filter((t) => t.text.includes(sentinel))
    .map((t) => ({ turn: t.turn, thinkingCount: t.thinking.length, previews: t.thinking.map((b) => b.preview) }))
}

/** 点击含哨兵回合的 .turn-meta 展开该回合，并轮询该回合内出现含 thinking 哨兵的 .trace-think 行。 */
async function expandTurnAndWait(page, snapshot, textSentinel, thinkSentinel) {
  const turn = snapshot.find((t) => t.text.includes(textSentinel))?.turn
  if (!turn) return { ok: false, reason: `未找到含 ${textSentinel} 的回合`, previews: [] }
  await page.click(`[data-testid="${turn}"] .turn-meta`)
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const previews = await page.$$eval(`[data-testid="${turn}"] .trace-think`, (els) =>
      els.map((el) => (el.textContent ?? '').trim()),
    )
    if (previews.some((p) => p.includes(thinkSentinel))) return { ok: true, turn, previews }
    await new Promise((r) => setTimeout(r, 400))
  }
  // 失败路径诊断：容器在不在 DOM、meta 按钮形态、trace 块现状（定位「没展开」vs「展开了没思考行」）
  const diag = await page
    .$$eval(`[data-testid="${turn}"]`, (els) => {
      if (els.length === 0) return { containerInDom: false }
      const el = els[0]
      const meta = el.querySelector('.turn-meta')
      return {
        containerInDom: true,
        metaDisabled: meta ? meta.hasAttribute('disabled') : null,
        metaAria: meta ? meta.getAttribute('aria-expanded') : null,
        traceThinkCount: el.querySelectorAll('.trace-think').length,
        traceBlkCount: el.querySelectorAll('.trace-blk').length,
        textHead: (el.textContent ?? '').slice(0, 200),
      }
    })
    .catch((e) => ({ evalError: String(e) }))
  return { ok: false, reason: `展开后未等到含 ${thinkSentinel} 的 thinking 行`, turn, previews: [], diag }
}

export async function run(ctx) {
  const { protocol, ev, log, repo, instance } = ctx
  const ui = ctx.ui
  const uncovered = []
  const gotchas = [
    'faux 空思考条目边界：step 不带 thinking 字段 = 该轮无思考条目（faux-llm-ext.ts:124）；「空 thinking part」字节级形态 faux 不可造，登记 notProvable',
    '完成轮 trace 默认折叠（Turn.vue:135-136 折叠态仅末位正文）：thinking 行计数必须先点击回合 .turn-meta 展开；仅正文的轮 hasFoldable=false 按钮不可点（其 thinking 恒 0，无需展开）',
    'block-thinking-<id> testid 依赖原生 thinkingId（Block.vue:145-148），faux part 无 id 不输出该属性——thinking 行锚点用 .trace-think 根类（2026-10-24 实跑校准）',
    '走盘重载换 thinking 块 id 空间（turn-expansion.ts 头注释）——live ≡ reload 对比按每回合计数+预览序列，不按块 id',
    'reload 段用 page.reload 重建 renderer：chat store 清空后走 hydrate 全量基线接管（useSidebar.reconcileHistory 适配层），与 app 级重启（p0-session-persistence）互补',
    '同实例内 LRU 驻留切回是增量 reconcile 非走盘重载——必须整页 reload 才触发 hydrate 全量重建',
    '虚拟列表会卸载滚出视口的回合（p0-chat-stream 已登记同族形态）：逐回合「展开→即时抓本回合 thinking 行」，禁全部展开后全局 capture（多次实跑校准）',
    // 2026-10-24 两轮实跑（run5/run6）+ 三次 CDP 探针的定性结论：live 段最后一轮展开后思考行
    // 不渲染是产品疑点（productSuspicion 上报主 agent），已排除面与疑点域登记如下——
    '[产品疑点定性] 多轮 session 最后一轮 live 展开失败已排除：数据层（chat store contentBlocks=[thinking,text] + thinking 数组带实时时间戳 + textFinalized=true，complete 后 400ms 内即就位）、faux 载荷（JSONL 三轮 parts 同构 [thinking,text]）、窗口切片（trace-window.ts:188-192 池显式含 thinking、W=4）、lastTurn disabled（单轮 lastTurn live 点击展开正常）、交互方法（同一 page.click 路径单轮成功）。疑点域 = 展开态清除机制（run3 证据：轮 1 展开成功后其思考行也在 20s 后消失，指向全局性重置——候选 turn-expansion.ts clearSession 的走盘重载触发条件 + useSidebar refreshHistory 编排）或最后一轮 visibleBlocks 派生走折叠分支。reload（page.reload）后同操作恢复正常。',
    '[设计内差异] live 侧思考行预览含「持续了 Nms」时长段（实时链路 thinking_start/end 时间戳填充），reload 侧无（持久化 thinking part 无时间戳，ThinkingRow.vue:49-53 已声明的降级分支）——两侧预览全等比对会假失败，对比口径按计数+哨兵',
  ]
  const THINK1 = meta.faux.responses[0].thinking
  const THINK3 = meta.faux.responses[2].thinking
  const page = await instance.page()

  // ── 段 0：建会话 + UI 激活链 ─────────────────────────────────
  const created = await protocol.call('session.create', { cwd: repo, label: 'p1-thinking-event-form' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  if (!sid) throw new Error(`session.create 未返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
  await protocol.subscribe(sid)
  await ui.click('css=.session-item', { timeoutMs: 30_000 })
  ev.step({ step: 'ui.activate', channel: 'A', exitCode: 0, stats: { sid } })

  // ── 段 1：3 轮混合序列（live） ───────────────────────────────
  const prompts = ['思考形态第一轮', '仅正文第二轮', '不同思考第三轮']
  for (let i = 0; i < prompts.length; i++) {
    const since = protocol.events.length
    await protocol.send(sid, prompts[i])
    const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert(`B: 轮 ${i + 1} 正常收尾`, end.ok === true, {
      channel: 'B',
      expected: 'message.complete',
      actual: `${end.type} stop=${end.payload?.stopReason ?? ''}`,
    })
    // complete ≠ 渲染完成：等该轮正文哨兵进 DOM 再进下一轮
    const needle = `TEXT${i + 1}-FORM-A8`
    const html = await pollBodyHtml(ui, needle, { timeoutMs: 30_000 })
    ev.assert(`A: 轮 ${i + 1} 正文哨兵渲染（${needle}）`, html.includes(needle), {
      channel: 'A',
      expected: needle,
      actual: `hit=${html.includes(needle)}`,
    })
  }
  await ev.shot(page, 'live-three-turns-folded')

  // 折叠态 chip 计数（完成轮默认折叠，chip = 产品口径每回合思考块计数）
  const foldedLive = await captureTurnBlocks(page)
  const chipOf = (snapshot, sentinel) =>
    snapshot.filter((t) => t.text.includes(sentinel)).map((t) => ({ turn: t.turn, chip: t.chipCount }))
  const c1 = chipOf(foldedLive, 'TEXT1-FORM-A8')
  const c2 = chipOf(foldedLive, 'TEXT2-FORM-A8')
  const c3 = chipOf(foldedLive, 'TEXT3-FORM-A8')
  ev.assert(
    'A 折叠态: turn-meta 思考 chip 计数 = 1/0/1',
    c1.length === 1 && c1[0].chip === 1 && c2.length === 1 && c2[0].chip === 0 && c3.length === 1 && c3[0].chip === 1,
    {
      channel: 'A',
      expected: '轮1=1 轮2=0 轮3=1',
      actual: `c1=${JSON.stringify(c1)} c2=${JSON.stringify(c2)} c3=${JSON.stringify(c3)}`,
    },
  )
  ev.attach('live-folded-snapshot', JSON.stringify(foldedLive, null, 2))
  ev.step({ step: 'live.folded.capture', channel: 'A', exitCode: 0, stats: { turns: foldedLive.length } })

  // ── 段 1b：展开态 thinking 行计数与内容 ──────────────────────
  // 虚拟列表会卸载滚出视口的回合（p0-chat-stream 已登记同族形态）：逐回合「展开 → 即时抓本回合
  // thinking 行」，不做全局 capture（前一版实跑教训：展开轮 1 后再点轮 3，轮 1 被虚拟化卸载）。
  const ex1 = await expandTurnAndWait(page, foldedLive, 'TEXT1-FORM-A8', 'THINK1-FORM-A8')
  await ev.shot(page, 'live-expanded-turn1')
  // 轮 2 紧随轮 1（视口内仍在 DOM）：此刻抓一次，取轮 2 的 thinking 行计数（应为 0）
  const afterEx1 = await captureTurnBlocks(page)
  const live2 = shapeOf(afterEx1, 'TEXT2-FORM-A8')
  const ex3 = await expandTurnAndWait(page, foldedLive, 'TEXT3-FORM-A8', 'THINK3-FORM-A8')
  await ev.shot(page, 'live-expanded-turn3')
  ev.attach('live-expanded-previews', JSON.stringify({ turn1: ex1, turn2: live2, turn3: ex3 }, null, 2))

  const preview1 = ex1.ok ? (ex1.previews[0] ?? '') : ''
  const preview3 = ex3.ok ? (ex3.previews[0] ?? '') : ''
  ev.assert(
    'A: 轮 1 回合展开后恰 1 段 thinking 行（旧缺陷：两段逐字相同思考块不复现）',
    ex1.ok && ex1.previews.length === 1 && preview1.includes('THINK1-FORM-A8'),
    {
      channel: 'A',
      expected: '展开成功且本回合 thinking 行=1、含 THINK1 哨兵',
      actual: `expandOk=${ex1.ok}(${ex1.reason ?? 'ok'}) lines=${ex1.previews.length} preview=${preview1.slice(0, 60)}`,
    },
  )
  ev.assert(
    'A: 轮 2 回合 0 段 thinking 行（空思考条目最近似形态）',
    live2.length === 1 && live2[0].thinkingCount === 0,
    {
      channel: 'A',
      expected: '含 TEXT2 的回合数=1 且 thinking 行=0',
      actual: `matches=${live2.length} counts=${live2.map((s) => s.thinkingCount).join(',')}`,
    },
  )
  ev.assert(
    'A: 轮 3 回合展开后恰 1 段 thinking 行',
    ex3.ok && ex3.previews.length === 1 && preview3.includes('THINK3-FORM-A8'),
    {
      channel: 'A',
      expected: '展开成功且本回合 thinking 行=1、含 THINK3 哨兵',
      actual: `expandOk=${ex3.ok}(${ex3.reason ?? 'ok'}) lines=${ex3.previews.length} preview=${preview3.slice(0, 60)}`,
    },
  )
  ev.assert(
    'A: 轮 1/轮 3 两段思考内容互异且各含自身哨兵',
    preview1.includes('THINK1-FORM-A8') && preview3.includes('THINK3-FORM-A8') && preview1 !== preview3,
    {
      channel: 'A',
      expected: 'preview1 含 THINK1、preview3 含 THINK3、两者不同',
      actual: `p1=${preview1.slice(0, 60)}… p3=${preview3.slice(0, 60)}…`,
    },
  )
  ev.assert(
    'A: 两思考回合 thinking 行总数 = 2（无跨回合重复渲染）',
    ex1.previews.length + ex3.previews.length === 2,
    {
      channel: 'A',
      expected: '2',
      actual: String(ex1.previews.length + ex3.previews.length),
    },
  )
  ev.step({
    step: 'live.expanded.capture',
    channel: 'A',
    exitCode: ex1.ok && ex3.ok && ex1.previews.length + ex3.previews.length === 2 ? 0 : 1,
    stats: { turn1Lines: ex1.previews.length, turn3Lines: ex3.previews.length },
  })

  // ── 段 2：B 通道 history 思考全文在案 ────────────────────────
  const hist = await protocol.history(sid, { limitTurns: 10 })
  const histJson = JSON.stringify(hist.messages ?? hist)
  ev.assert('B: history 含轮 1 thinking 全文', histJson.includes(THINK1), {
    channel: 'B', expected: 'THINK1 全文子串', actual: `hit=${histJson.includes(THINK1)}`,
  })
  ev.assert('B: history 含轮 3 thinking 全文', histJson.includes(THINK3), {
    channel: 'B', expected: 'THINK3 全文子串', actual: `hit=${histJson.includes(THINK3)}`,
  })
  ev.assert('B: history 含轮 2 正文（空思考轮）', histJson.includes('TEXT2-FORM-A8'), {
    channel: 'B', expected: 'TEXT2 子串', actual: `hit=${histJson.includes('TEXT2-FORM-A8')}`,
  })
  ev.step({ step: 'session.history.thinking', channel: 'B', exitCode: 0, stats: { messages: (hist.messages ?? []).length } })

  // ── 段 3：reload 重建 ≡ live ─────────────────────────────────
  await page.reload({ waitUntil: 'domcontentloaded' })
  // 侧栏在 renderer 启动链路自动拉取 config.sessions；等行出现再点击激活（走盘重载 hydrate）
  await ui.expectVisible('css=.session-item', { timeoutMs: 30_000 })
  await ui.click('css=.session-item', { timeoutMs: 30_000 })
  const reloadedHtml = await pollBodyHtml(ui, 'TEXT3-FORM-A8', { timeoutMs: 60_000 })
  ev.assert('A: reload 后会话流重建（末轮哨兵再渲染）', reloadedHtml.includes('TEXT3-FORM-A8'), {
    channel: 'A',
    expected: 'TEXT3-FORM-A8',
    actual: `hit=${reloadedHtml.includes('TEXT3-FORM-A8')}`,
  })

  // 同流程：折叠 chip → 逐回合展开即时抓 → 对比 live
  const foldedReload = await captureTurnBlocks(page)
  const r1 = chipOf(foldedReload, 'TEXT1-FORM-A8')
  const r2 = chipOf(foldedReload, 'TEXT2-FORM-A8')
  const r3 = chipOf(foldedReload, 'TEXT3-FORM-A8')
  ev.assert(
    'A: reload 折叠态思考 chip 计数 = 1/0/1（持久链路重建后计数一致）',
    r1.length === 1 && r1[0].chip === 1 && r2.length === 1 && r2[0].chip === 0 && r3.length === 1 && r3[0].chip === 1,
    {
      channel: 'A',
      expected: '轮1=1 轮2=0 轮3=1',
      actual: `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)} r3=${JSON.stringify(r3)}`,
    },
  )
  const rex1 = await expandTurnAndWait(page, foldedReload, 'TEXT1-FORM-A8', 'THINK1-FORM-A8')
  await ev.shot(page, 'reload-expanded-turn1')
  const afterRex1 = await captureTurnBlocks(page)
  const reload2 = shapeOf(afterRex1, 'TEXT2-FORM-A8')
  const rex3 = await expandTurnAndWait(page, foldedReload, 'TEXT3-FORM-A8', 'THINK3-FORM-A8')
  await ev.shot(page, 'reload-expanded-turn3')
  ev.attach('reload-expanded-previews', JSON.stringify({ turn1: rex1, turn2: reload2, turn3: rex3 }, null, 2))

  // 对比口径：每回合 thinking 行计数 + 哨兵命中（预览全文不作全等比对——live 侧含
  // 「持续了 Nms」时长段、reload 侧无，是 ThinkingRow.vue:49-53 已声明的设计内降级差异）
  const perTurn = (ex, sentinel) => ({
    count: ex.ok ? ex.previews.length : -1,
    sentinelHit: ex.ok ? ex.previews.some((p) => p.includes(sentinel)) : false,
  })
  const liveShape = {
    turn1: perTurn(ex1, 'THINK1-FORM-A8'),
    turn2Count: live2.length === 1 ? live2[0].thinkingCount : -1,
    turn3: perTurn(ex3, 'THINK3-FORM-A8'),
  }
  const reloadShape = {
    turn1: perTurn(rex1, 'THINK1-FORM-A8'),
    turn2Count: reload2.length === 1 ? reload2[0].thinkingCount : -1,
    turn3: perTurn(rex3, 'THINK3-FORM-A8'),
  }
  const equivOk = JSON.stringify(liveShape) === JSON.stringify(reloadShape) && rex1.ok && rex3.ok
  ev.assert(
    'A: reload 后每回合 thinking 行计数与预览内容 ≡ live（live ≡ reload 不变量）',
    equivOk,
    {
      channel: 'A',
      expected: JSON.stringify(liveShape),
      actual: JSON.stringify(reloadShape),
    },
  )
  ev.step({
    step: 'chat.reload-equiv',
    channel: 'A',
    exitCode: equivOk ? 0 : 1,
    stats: { expandOk: [ex1.ok, ex3.ok], reloadExpandOk: [rex1.ok, rex3.ok] },
  })

  log(`done sid=${sid} expandOk=[${ex1.ok},${ex3.ok}] reloadExpandOk=[${rex1.ok},${rex3.ok}] equiv=${equivOk}`)
  return { uncovered, gotchas }
}
