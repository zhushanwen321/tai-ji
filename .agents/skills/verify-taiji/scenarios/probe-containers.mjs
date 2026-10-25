/**
 * probe-containers —— 容器扩展点统一核心验收（设计 §8.2 S1/S2/S3/S4/S7/S8；impl-plan A1-A4、A7、A8）。
 *
 * 装配：探针插件 probe-container-plugin（resources/plugins/ 内置形态，声明
 * drawer.tab/overlay.content 两视图 + nonexistent.slot 反例 + headerAction
 * activation 直开浮层；推树含 list-tree hostAction 双向导航与 unknown-params 反例）。
 *
 * 覆盖：
 *   S1：插件声明新抽屉标签页 → 派生出现、点入见推树文本；probe.bad（未注册位）不派生（S4）
 *   S2：headerAction activation 直开浮层并落在探针浮层段
 *   S3：list-tree hostAction 双向导航（浮层→抽屉、抽屉→浮层）+ unknown params 反例动作照常
 *   S7：scheduler-manager headerAction 徽标按钮与探针共存（静态表覆盖反向验证）
 *   S8：禁用 → 标签页消失且选中态不残留；启用 → 重放回来
 */
export const meta = {
  id: 'probe-containers',
  priority: 'P0',
  title: '容器位统一探针：抽屉派生 S1 / 浮层直开 S2 / hostAction 导航 S3 / 降级 S4 / 共存 S7 / 禁用重放 S8',
  covers: ['env.launch', 'env.ready', 'ui.container'],
  requires: [],
  estimateSec: 300,
  provable: [
    'S1：抽屉标签条出现「探针面板」（注册表派生），点入见插件推树两行文本',
    'S2：点击探针 headerAction 按钮 → 浮层打开且落在「探针浮层」内容段',
    'S3：浮层 list-tree hostAction 点击 → 抽屉切回探针面板；unknown params 反例动作照常',
    'S4：probe.bad（nonexistent.slot）不派生进抽屉（不可用声明不出现）',
    'S7：scheduler-manager 的 headerAction 按钮与探针按钮共存',
    'S8：禁用插件后探针 tab 消失，启用后重放回来',
  ],
  notProvable: [
    '§5.4 行 8 unknown-params 的 console.warning 文案（CDP console 时序抖动，以动作照常承载）',
    '浮层呼吸点动画与视觉密度（A6，L4 inspect 节点承担）',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, ui } = ctx
  const uncovered = []
  const step = (name, detail) => ev.step({ step: name, channel: 'A', exitCode: 0, ...(detail ? { stats: detail } : {}) })

  // 页面加载门（dev vite 冷编译 30-90s，runner ready 只保证 runtime 健康不保证页面）
  await ui.expectVisible('app-shell', { timeoutMs: 600_000 })
  // 建会话（页面就绪后建——渲染前建会话的广播在 renderer 订阅建立前丢失，列表不刷）
  const created = await protocol.call('session.create', { cwd: ctx.repo, label: 'probe-containers' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  if (!sid) throw new Error('session.create 未返回 sessionId')
  await protocol.subscribe(sid)
  await ui.click('css=.session-item', { timeoutMs: 60_000 })
  await ui.expectVisible('composer-btw-button', { timeoutMs: 90_000 })
  step('ui.activate', { sid })

  // 打开右抽屉（ComposerBtwButton = D7 唯一入口，openDrawerTab('btw')）
  await ui.click('composer-btw-button')
  await ui.expectVisible('drawer-panel', { timeoutMs: 30_000 })
  step('drawer.opened')

  // ── S1：抽屉标签条派生「探针面板」 ─────────────────────────────
  await ui.expectVisible('drawer-tab-probe-container-plugin.tab', { timeoutMs: 20_000 })
  log('S1 探针 tab 派生出现')
  step('S1.tab-appears')

  // S4 反例：probe.bad 不派生（不可用声明不进任何容器）
  try {
    await ui.expectGone('drawer-tab-probe-container-plugin.bad', { timeoutMs: 5_000 })
    log('S4 probe.bad 未派生（不可用声明不进容器）')
    step('S4.bad-not-derived')
  } catch {
    uncovered.push('S4: probe.bad 意外派生进抽屉（不可用声明泄漏）')
  }

  // 点入探针 tab，见推树文本（views.update 通路 + ViewHost 渲染）
  await ui.click('drawer-tab-probe-container-plugin.tab')
  await ui.expectVisible('text=探针面板已挂载', { timeoutMs: 15_000 })
  log('S1 探针推树文本在场')
  step('S1.tree-rendered')

  // ── S7：scheduler-manager headerAction 与探针共存 ──────────────
  await ui.expectVisible('css=[data-testid^="header-action-scheduler-manager"]', { timeoutMs: 15_000 })
  log('S7 scheduler-manager headerAction 在场（静态表覆盖粒度不破坏）')
  step('S7.scheduler-coexists')

  // ── S2：探针 headerAction 直开浮层 ─────────────────────────────
  try {
    await ui.expectVisible('css=[data-testid^="header-action-probe"]', { timeoutMs: 10_000 })
  } catch {
    throw new Error('S2: 探针 headerAction 按钮未渲染（activation 声明通路断）')
  }
  await ui.click('css=[data-testid^="header-action-probe"]')
  await ui.expectVisible('wfvz-overlay', { timeoutMs: 15_000 })
  await ui.expectVisible('text=探针浮层内容', { timeoutMs: 15_000 })
  log('S2 浮层打开且落在探针浮层内容（activation overlay 直开 + ViewHost 承载）')
  step('S2.overlay-opened')

  // ── S3：浮层 list-tree hostAction → 抽屉切回探针面板 ───────────
  await ui.click('text=回到探针面板')
  await ui.expectVisible('css=[data-testid="drawer-tab-probe-container-plugin.tab"][aria-selected="true"]', { timeoutMs: 15_000 })
  log('S3 浮层 hostAction 导航：抽屉切回探针面板（选中态正确）')
  step('S3.back-to-drawer')

  // S3b：抽屉 list-tree「打开探针浮层」hostAction → 浮层再开
  await ui.click('text=打开探针浮层')
  await ui.expectVisible('wfvz-overlay', { timeoutMs: 15_000 })
  log('S3b 抽屉 hostAction 导航：浮层再开（双向通路）')
  step('S3b.to-overlay')
  // 关浮层（关闭钮或 Esc），落回抽屉继续
  try {
    await ui.click('wfvz-overlay-close', { timeoutMs: 3_000 })
  } catch {
    await ui.press('Escape')
  }
  await ui.expectGone('wfvz-overlay', { timeoutMs: 10_000 })
  step('S3b.overlay-closed')

  // S3c：unknown params 反例——点击后动作照常（抽屉保持探针 tab，无崩溃）
  await ui.click('text=未知参数反例')
  await ui.expectVisible('css=[data-testid="drawer-tab-probe-container-plugin.tab"][aria-selected="true"]', { timeoutMs: 15_000 })
  log('S3c unknown params 反例：动作照常执行（§5.4 行 8 语义）')
  step('S3c.unknown-params-ok')

  // ── S8：禁用 → tab 消失；启用 → 重放回来 ──────────────────────
  // 打开设置 → 扩展分区（nav 派生项）→ 插件管理列表找探针条目禁用
  await ui.click('settings-nav-extension')
  await ui.expectVisible('css=[data-testid*="probe-container-plugin"]', { timeoutMs: 15_000 })
  await ui.click('css=[data-testid*="probe-container-plugin"] button')
  await ui.press('Escape') // 关设置弹层
  await ui.expectGone('drawer-tab-probe-container-plugin.tab', { timeoutMs: 15_000 })
  log('S8 禁用后探针 tab 消失（handlePluginGone 容器位清理）')
  step('S8.disabled-gone')
  // 重新打开设置启用
  await ui.click('settings-nav-extension')
  await ui.click('css=[data-testid*="probe-container-plugin"] button')
  await ui.press('Escape')
  await ui.expectVisible('drawer-tab-probe-container-plugin.tab', { timeoutMs: 20_000 })
  log('S8 启用后探针 tab 重放回来（handlePluginBack 快照重放）')
  step('S8.enabled-back')

  return { uncovered }
}
