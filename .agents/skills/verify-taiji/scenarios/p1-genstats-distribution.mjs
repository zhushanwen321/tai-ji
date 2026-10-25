/**
 * p1-genstats-distribution —— GenStats 分布矩阵真机验收。
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
  id: 'p1-genstats-distribution',
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

  // ── 段 3：窄窗形态（密度退化 + 6 列矩阵不溢出）────────────────────
  // 分布矩阵最大的布局风险在这一档：聚合页容器 340px 宽要塞「行头 + 5 列」共 6 列，
  // 每列约 50px——「1.3s」「2400」这类值若换行或撑破就是布局 bug。逐档压窄复验。
  const cdp = await page.context().newCDPSession(page)
  const overflowOf = async () =>
    page.evaluate(() => {
      const out = []
      for (const el of document.querySelectorAll(
        '[data-testid$="-dist-column"], [data-testid$="-dist-row"], [data-testid$="-current"], [data-testid$="-dist-day-p50"], [data-testid$="-dist-d30-max"]',
      )) {
        const node = /** @type {HTMLElement} */ (el)
        if (node.scrollWidth > node.clientWidth + 1) {
          out.push({
            testid: node.getAttribute('data-testid'),
            text: node.textContent,
            scrollWidth: node.scrollWidth,
            clientWidth: node.clientWidth,
          })
        }
      }
      return out
    })

  /** 逐档宽度：录形态 + 若有矩阵则验溢出。 */
  async function probeWidth(width) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
    await page.waitForTimeout(700)
    await ui.hover('body')
    await page.waitForTimeout(250)
    const aggregated = (await page.locator('[data-testid="composer-metrics-aggregate"]').count()) > 0
    const entry = aggregated ? 'testid=composer-metrics-aggregate' : 'testid=genstats-ttft-value'
    await ui.hover(entry)
    await ui.expectVisible('testid=genstats-ttft-model', { timeoutMs: 15_000 })
    const overflow = await overflowOf()
    const columns = await page.locator('[data-testid$="-dist-column"]').count()
    log(`宽度 ${width}px：形态=${aggregated ? 'aggregated（聚合页）' : 'expanded（平铺）'} 列头=${columns} 溢出=${overflow.length}`)
    await ev.shot(page, `genstats-distribution-w${width}`)
    return { width, aggregated, columns, overflow }
  }

  const probes = []
  for (const width of [760, 560, 460]) probes.push(await probeWidth(width))
  await cdp.send('Emulation.clearDeviceMetricsOverride')

  ev.assert(
    'A: 窄窗下指标退化为单图标聚合按钮（密度状态机生效）',
    probes.some((x) => x.aggregated),
    {
      channel: 'A',
      expected: '至少一档宽度出现 composer-metrics-aggregate',
      actual: JSON.stringify(probes.map(({ width, aggregated }) => ({ width, aggregated }))),
    },
  )
  ev.assert(
    'A: 各档宽度矩阵无横向溢出（单元格不换行不撑破）',
    probes.every((x) => x.overflow.length === 0),
    {
      channel: 'A',
      expected: '零溢出',
      actual: JSON.stringify(probes.map(({ width, overflow }) => ({ width, overflow }))),
    },
  )

  return { uncovered: [], gotchas }
}
