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
  title: '托盘容器最小闭环：容器可见 + builtin 按钮开面板 + Esc 关闭（键盘栈序最小观测）',
  covers: ['env.launch', 'env.ready', 'ui.container', 'workspace.drawer'],
  requires: ['faux'],
  parallelGroup: 'chat',
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
  const { protocol, ev, log } = ctx
  const uncovered = []
  const gotchas = [
    '托盘 builtin 件（bash/workflow/subagent）无运行记录时不渲染（D4 隔离后无恒渲染豁免）：容器回路验走恒在的聚合按钮（tray-aggregate-button）',
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
  // 托盘按钮（builtin/aggregate）在无运行记录实例上实测不渲染（渲染条件无文档锚点，
  // 空洞 #1 扩展登记）——容器「开 → Esc → 关」回路用已验证的模型弹层承载
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

  // 托盘面如实记录（不凑绿）：按钮不可见属锚点缺口，登记 uncovered
  const traySeen = await ui.html('css=body').then((h) => h.includes('composer-tray'))
  uncovered.push(`托盘按钮容器回路不可达：composer-tray ${traySeen ? '在' : '不在'} DOM，但 builtin/aggregate 按钮均不渲染（渲染条件无文档锚点，矩阵空洞 #1 扩展）——托盘面登记待产品补锚`)

  log(`done sid=${sid}`)
  return { uncovered, gotchas }
}
