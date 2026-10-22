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
    'A：composer 托盘容器（composer-tray）在对话态可见',
    'A：点击 tray-builtin-button 后托盘面板展开（Popover open 态）',
    'A：Esc 关闭托盘面板（键盘栈序的最小可观测形态）',
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
    '托盘 builtin 按钮的 data-kind 枚举随面板集合变化（canvas 件无恒渲染豁免），用 first() 语义取第一个可点件',
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

  // ── A：托盘容器可见 ────────────────────────────────────────
  await ui.expectVisible('testid=composer-tray', { timeoutMs: 30_000 })
  ev.assert('A: composer-tray 容器可见', true, {
    channel: 'A', expected: 'composer-tray', actual: '可见',
  })

  // ── A：builtin 按钮 → 面板展开 → Esc 收起 ──────────────────
  await ui.click('testid=tray-builtin-button', { timeoutMs: 15_000 })
  // 面板展开的稳定信号：tray-aggregate-pulse / 面板 surface 出现——用 Popover 内容侧锚点
  let opened = true
  try {
    await ui.expectVisible('testid=tray-aggregate-pulse', { timeoutMs: 8_000 })
  } catch {
    // 不同按钮展开的面板不同：退回「按钮 aria-expanded / 面板容器」宽松判定
    try {
      await ui.expectVisible('css=[data-testid="tray-builtin-pulse"]', { timeoutMs: 5_000 })
    } catch (e) {
      opened = false
      ev.attach('tray-open-miss', String(e?.message ?? e).slice(0, 400))
    }
  }
  ev.assert('A: 托盘面板展开', opened, {
    channel: 'A',
    expected: '点 builtin 按钮后出现面板态（pulse/面板 surface）',
    actual: opened ? '展开' : '未见展开信号（现场见 tray-open-miss）',
  })
  await ui.press('Escape')
  // Esc 后收起：pulse 态消失是「收起」的可观测回落的宽松形态；部分面板收起后按钮仍在——
  // 断言「不再有打开态面板」用面板容器消失（若锚点不稳，如实记录）
  let closedSeen = false
  try {
    await ui.expectGone('css=[data-testid="tray-aggregate-pulse"], [data-testid="tray-builtin-pulse"]', { timeoutMs: 8_000 })
    closedSeen = true
  } catch (e) {
    ev.attach('tray-close-miss', String(e?.message ?? e).slice(0, 400))
  }
  ev.assert('A: Esc 后托盘面板收起', closedSeen, {
    channel: 'A',
    expected: 'pulse/打开态消失',
    actual: closedSeen ? '已收起' : '未观测到收起（现场见 tray-close-miss；栈序完整验证归空洞 #3）',
  })
  ev.step({ step: 'ui.container.tray', channel: 'A', exitCode: opened && closedSeen ? 0 : 1, stats: {} })

  log(`done sid=${sid}`)
  return { uncovered, gotchas }
}
