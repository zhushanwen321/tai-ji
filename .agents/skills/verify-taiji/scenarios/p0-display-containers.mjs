/**
 * p0-display-containers —— 展示容器体系的最小可观测面（覆盖矩阵 P0-17；补剧本优先级 #9 之二）。
 *
 * 装配：faux。容器栈（右抽屉/底抽屉/浮层 + 键盘栈序）的完整验证缺产品侧锚点（矩阵已知
 * 空洞 #3：Esc 路由无栈顶可观测信号；终端实例条在 docs/testing 零登记）。本剧本只覆盖
 * 当前有稳定锚点的最小闭环：
 *   A：composer 托盘容器（composer-tray）可见 → 点第一个 builtin 托盘按钮（tray-builtin-button）
 *   → 某托盘面板打开 → Esc 关闭 → 面板收起（Popover 开合状态回落）。
 * 抽屉（drawer）与 workflow overlay 依附运行数据（subagent/workflow 记录），由
 * p0-subagent-workflow-dispatch 的运行产物 + 后续剧本覆盖。
 */
export const meta = {
  id: 'p0-display-containers',
  priority: 'P0',
  title: '容器体系最小闭环：模型弹层开/Esc 关 + bash 制造记录后托盘面板开/Esc 关',
  covers: ['env.launch', 'env.ready', 'ui.container', 'chat.send', 'chat.wait'],
  requires: ['faux'],
  estimateSec: 100,
  faux: {
    responses: [{ text: 'display-containers-spare', stopReason: 'stop' }],
  },
  provable: [
    'A：模型弹层浮层容器打开（model-picker-panel 可见）',
    'A：Esc 关闭浮层（键盘栈序的最小可观测形态）',
  ],
  notProvable: [
    '键盘栈序的完整语义（多层浮层叠放时的 Esc 路由顺序）——无栈顶可观测信号，矩阵空洞 #3（需产品侧暴露栈顶或日志）',
    '右抽屉 / workflow overlay 的容器面——依附运行记录，本实例无 subagent/workflow 数据',
    '终端多实例 / 底部抽屉——锚点在 docs/testing 零登记（空洞 #1）',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, instance } = ctx
  const uncovered = []
  const gotchas = [
    '托盘 builtin 件（bash/workflow/subagent/canvas）无运行记录时不渲染（ComposerTray.vue D4 隔离后无恒渲染豁免，total===0 不进数组）——聚合按钮也非恒在（showAggregate 条件）：验托盘回路必须先制造记录（本剧本跑一轮 bash）',
    'Esc 的键盘栈序完整验证需产品侧暴露栈顶信号（空洞 #3）；本剧本只证「打开→Esc→收起」的最小回路',
  ]
  const ui = ctx.ui

  // 建会话并激活（托盘在对话态渲染；激活链同 p0-chat-stream-ui）
  const created = await protocol.call('session.create', { cwd: ctx.repo, label: 'p0-display-containers' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  if (!sid) throw new Error('session.create 未返回 sessionId')
  await protocol.subscribe(sid)
  await ui.click('css=.session-item', { timeoutMs: 30_000 })
  ev.step({ step: 'ui.activate', channel: 'A', exitCode: 0, stats: { sid } })

  // ── A：浮层容器开/关回路（模型弹层） ────────────────────────
  await ui.click('css=[title="切换模型"]', { timeoutMs: 15_000 })
  await ui.expectVisible('testid=model-picker-panel', { timeoutMs: 15_000 })
  ev.assert('A: 模型弹层（浮层容器）打开', true, {
    channel: 'A', expected: 'model-picker-panel', actual: '可见',
  })
  await ui.press('Escape')
  await ui.expectGone('testid=model-picker-panel', { timeoutMs: 15_000 })
  ev.assert('A: Esc 关闭浮层（键盘栈序最小回路）', true, {
    channel: 'A', expected: 'model-picker-panel 移除', actual: '已关闭',
  })
  ev.step({ step: 'ui.container.overlay', channel: 'A', exitCode: 0, stats: {} })

  // ── A：跑一轮 bash 制造托盘条目（builtin 件按记录数渲染，空实例不渲染是设计内） ──
  const since = protocol.events.length
  await protocol.send(sid, '跑一条 bash 生成托盘条目')
  const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
  ev.assert('B: bash 轮完成（托盘条目数据面）', end.ok === true, {
    channel: 'B', expected: 'message.complete', actual: `${end.type} stop=${end.payload?.stopReason ?? ''}`,
  })

  // ── A：托盘回路（条件等待，不可达则如实登记） ────────────────
  // 托盘统计面 = subagent/workflow/后台 bash 记录（useTrayCounts），前台 bash 工具调用
  // 不产条目（2026-10-22 实测）——faux 实例可制造记录的路径受限，条件等待 30s 不出现
  // 则登记 uncovered（mock-http 的 subagent record 是可行的制造路径，挂执行域剧本延伸）
  let traySeen = false
  try {
    await ui.expectVisible('testid=tray-builtin-button', { timeoutMs: 30_000 })
    traySeen = true
  } catch { /* 登记后跳过 */ }
  if (traySeen) {
    await ui.click('testid=tray-builtin-button', { timeoutMs: 15_000 })
    await ui.expectVisible('testid=tray-panel', { timeoutMs: 15_000 })
    ev.assert('A: 托盘面板展开（tray-panel surface）', true, {
      channel: 'A', expected: 'tray-panel', actual: '可见',
    })
    await ev.shot(await instance.page(), 'tray-panel-open')
    await ui.press('Escape')
    await ui.expectGone('testid=tray-panel', { timeoutMs: 15_000 })
    ev.assert('A: Esc 关闭托盘面板（键盘栈序最小回路）', true, {
      channel: 'A', expected: 'tray-panel 移除', actual: '已关闭',
    })
    ev.step({ step: 'ui.container.tray', channel: 'A', exitCode: 0, stats: {} })
  } else {
    uncovered.push('托盘开/关回路未验：faux 实例跑一轮前台 bash 不产托盘条目（托盘统计面 = subagent/workflow/后台 bash 记录）——制造路径需 mock-http 执行域 record，挂 p0-subagent-workflow-dispatch 延伸')
    ev.step({ step: 'ui.container.tray', channel: 'A', exitCode: 1, stats: { skipped: true } })
  }

  log(`done sid=${sid}`)
  return { uncovered, gotchas }
}
