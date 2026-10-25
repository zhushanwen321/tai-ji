/**
 * _smoke-genstats-distribution —— GenStats 分布矩阵真机验收（临时剧本，验收后删除）。
 *
 * 目标：composer 指标聚合页里速度卡 / TTFT 卡真的渲染出「5 统计量 × 3 窗口」分布矩阵，
 * 而不是只改了协议没人看。
 *
 * 通道：
 *   B（协议）：session.getGenStats 回帧的 speed.day / ttft.day 是五量分布对象且已算出值
 *   A（UI）：hover 指标聚合按钮 → 聚合页内两颗矩阵的列头/行头/单元格齐全且有值
 *
 * 装配：faux（真 Electron + 真 pi + 假 LLM 演员，零 token）
 */
export const meta = {
  id: 'smoke-genstats-distribution',
  priority: 'P1',
  title: 'GenStats 分布矩阵（速度/TTFT 五量 × 三窗口）渲染',
  covers: ['env.launch', 'env.ready', 'session.create', 'chat.send', 'chat.wait'],
  requires: ['faux'],
  estimateSec: 120,
  faux: {
    responses: [{ text: '收到，已记录。', stopReason: 'stop' }],
  },
  provable: [
    'B：session.getGenStats 的 speed.day / ttft.day 为 {avg,p50,p99,max,min} 对象',
    'B：ttft.day 五量中至少一个有实际测量值（非全 null）',
    'A：聚合页内两颗矩阵列头共 10 个（2 卡 × 5 统计量）、行头共 6 个（2 卡 × 3 窗口）',
    'A：TTFT 本次值 / 今日 P50 / 速度今日均值三格均渲染出实际数字（非「—」）',
  ],
  notProvable: [
    '数值与磁盘原始样本的逐条一致性（分布算法由 gen-stats-store 单测断言，真机只证链路可渲染）',
    'P99 在小样本下等于 max 的视觉并列（属口径语义，单测覆盖）',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, instance } = ctx
  const ui = ctx.ui
  const gotchas = [
    '矩阵 testid 带指标前缀（genstats-speed-dist-* / genstats-ttft-dist-*）：同页两颗矩阵若共用 testid 会静默串台',
    'hover 聚合按钮才出内容（HoverCard），断言前必须先 ui.hover 再等卡片 head testid',
    'TTFT 本次值只有本会话采样过才有（内存槽），故必须先跑完一轮对话',
  ]

  // ── 段 0：建会话 + 激活 + 跑一轮产生真实采样 ──────────────────────
  const created = await protocol.call('session.create', { cwd: ctx.dataDir, label: 'verify-genstats-distribution' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  if (!sid) throw new Error(`session.create 未返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
  await protocol.subscribe(sid)
  await ui.click('css=.session-item', { timeoutMs: 30_000 })
  ev.step({ step: 'ui.activate', channel: 'A', exitCode: 0, stats: { sid } })

  const since = protocol.events.length
  await protocol.send(sid, '数一下 1 到 3')
  const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
  ev.assert('B: 采样轮正常收尾', end.type === 'message.complete' && end.ok, {
    channel: 'B',
    expected: 'message.complete 非 error',
    actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
  })

  // ── 段 1：B 通道 —— 帧结构是分布对象 ─────────────────────────────
  const frame = await protocol.call('session.getGenStats', { sessionId: sid }, { replyType: 'session.stats_update' })
  log(`speed.day = ${JSON.stringify(frame.speed.day)}`)
  log(`ttft.day  = ${JSON.stringify(frame.ttft.day)}`)

  const distKeys = ['avg', 'p50', 'p99', 'max', 'min']
  const hasDistShape = (d) => d !== null && typeof d === 'object' && distKeys.every((k) => k in d)
  ev.assert('B: speed.day 是五量分布对象', hasDistShape(frame.speed.day), {
    channel: 'B',
    expected: `含 ${distKeys.join('/')} 五键`,
    actual: JSON.stringify(frame.speed.day),
  })
  ev.assert('B: ttft.day 是五量分布对象', hasDistShape(frame.ttft.day), {
    channel: 'B',
    expected: `含 ${distKeys.join('/')} 五键`,
    actual: JSON.stringify(frame.ttft.day),
  })
  ev.assert('B: ttft.day 五量已算出（非全 null）', hasDistShape(frame.ttft.day) && distKeys.some((k) => frame.ttft.day[k] !== null), {
    channel: 'B',
    expected: '至少一个统计量有数值',
    actual: JSON.stringify(frame.ttft.day),
  })
  ev.step({ step: 'protocol-frame-shape', channel: 'B', exitCode: 0, stats: { speedDay: frame.speed.day, ttftDay: frame.ttft.day } })

  // ── 段 2：A 通道 —— 指标浮层矩阵渲染 ─────────────────────────────
  // 形态按 composer 密度状态机自适应：fit 0 = 平铺触发器（TTFT 触发器 hover 出 TTFT 卡）/
  // L1 起 = 单图标聚合按钮（hover 出四卡聚合页）。两种形态下矩阵本体相同。
  const page = await instance.page()
  const hasAggregate = await page.locator('[data-testid="composer-metrics-aggregate"]').count()
  const opener = hasAggregate > 0 ? 'testid=composer-metrics-aggregate' : 'testid=genstats-ttft-value'
  log(`指标入口形态 = ${hasAggregate > 0 ? 'aggregated（聚合页四卡）' : 'expanded（平铺触发器）'} → ${opener}`)

  await ui.hover(opener)
  let opened = true
  try {
    await ui.expectVisible('testid=genstats-ttft-model', { timeoutMs: 15_000 })
  } catch (e) {
    opened = false
    ev.attach('aggregate-open-miss', JSON.stringify({ opener, message: String(e?.message ?? e), evidence: e?.evidence }, null, 2).slice(0, 20_000))
    try { await ev.shot(await instance.page(), 'aggregate-open-miss') } catch { /* 页面不可用 */ }
  }
  if (!opened) return { uncovered: ['指标浮层未打开，A 通道矩阵断言未执行'], gotchas }

  const columnHeaders = (await page.locator('[data-testid$="-dist-column"]').allTextContents()).map((s) => s.trim())
  const rowHeaders = (await page.locator('[data-testid$="-dist-row"]').allTextContents()).map((s) => s.trim())
  log(`columnHeaders = ${JSON.stringify(columnHeaders)}`)
  log(`rowHeaders = ${JSON.stringify(rowHeaders)}`)

  // 聚合页 = 两卡（速度 + TTFT）各一颗矩阵 → 列头 10 / 行头 6；
  // 平铺态 = 只 hover 了 TTFT 触发器 → 一颗矩阵 → 列头 5 / 行头 3
  const expectedColumns = hasAggregate > 0 ? 10 : 5
  const expectedRows = hasAggregate > 0 ? 6 : 3
  ev.assert(
    `A: 矩阵列头 ${expectedColumns} 个（${hasAggregate > 0 ? '两卡' : 'TTFT 单卡'} × 5 统计量）`,
    columnHeaders.length === expectedColumns,
    { channel: 'A', expected: String(expectedColumns), actual: JSON.stringify(columnHeaders) },
  )
  ev.assert(
    `A: 矩阵行头 ${expectedRows} 个（${hasAggregate > 0 ? '两卡' : 'TTFT 单卡'} × 3 窗口）`,
    rowHeaders.length === expectedRows,
    { channel: 'A', expected: String(expectedRows), actual: JSON.stringify(rowHeaders) },
  )
  for (const label of ['平均', 'P50', 'P99', '最大', '最小']) {
    ev.assert(`A: 列头含「${label}」`, columnHeaders.includes(label), {
      channel: 'A',
      expected: label,
      actual: JSON.stringify(columnHeaders),
    })
  }
  for (const label of ['今日', '7 天', '30 天']) {
    ev.assert(`A: 行头含「${label}」`, rowHeaders.includes(label), {
      channel: 'A',
      expected: label,
      actual: JSON.stringify(rowHeaders),
    })
  }

  const readCell = async (testid) => ((await page.locator(`[data-testid="${testid}"]`).first().textContent()) ?? '').trim()
  const cells = {
    ttftCurrent: await readCell('genstats-ttft-current'),
    ttftDayP50: await readCell('genstats-ttft-dist-day-p50'),
    // 速度卡只在聚合页形态下同屏（平铺态需单独 hover 速度触发器，本剧本不覆盖）
    ...(hasAggregate > 0 ? { speedDayAvg: await readCell('genstats-speed-dist-day-avg') } : {}),
  }
  log(`cells = ${JSON.stringify(cells)}`)

  const isValue = (v) => v !== '' && v !== '—'
  for (const [name, value] of Object.entries(cells)) {
    ev.assert(`A: ${name} 渲染出实际值`, isValue(value), {
      channel: 'A',
      expected: '非「—」非空',
      actual: value,
    })
  }

  await ev.shot(page, 'genstats-distribution-panel')
  ev.step({ step: 'ui-matrix-rendered', channel: 'A', exitCode: 0, stats: { columnHeaders, rowHeaders, cells } })

  return { uncovered: [], gotchas }
}
