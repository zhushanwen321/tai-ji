/**
 * 插件 Provider 流程 UI 驱动助手（安装生命周期组剧本共享）。
 *
 * 用户路径锚点（源码核对）：
 *   sidebar-settings（侧栏齿轮）→ settings-nav-provider（设置导航）
 *   → provider-template-picker（「+ 添加供应商 ▾」菜单）→ add-menu-plugin（「插件 Provider」项）
 *   → plugin-provider-flow（流程对话框，reka-ui portal 到 body）
 *   → plugin-family-grid / plugin-family-card（家族卡）
 *   → plugin-direct-spec + plugin-direct-install-btn（包名直装）
 *   → plugin-install-confirm（确认卡）+ plugin-confirm-capabilities / plugin-confirm-read-paths
 *   → plugin-install-confirm-btn（确认安装）| plugin-install-cancel（取消）
 *   → plugin-install-error（confirm 段失败文案）
 * 出处：ProviderPageHeader.vue / ProviderTemplatePicker.vue（ui 包）/ PluginProviderFlow.vue。
 */

/**
 * 打开 Provider 页并进入插件接入流程（家族卡段）。
 * settings 模态若未打开，先点 sidebar-settings。
 */
export async function openPluginFlow(ui, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000
  // 设置页可能已停留在 provider 页（重复进入场景）——按可见性判定，不盲点
  const providerVisible = await ui
    .page
    .locator('[data-testid="settings-nav-provider"]')
    .first()
    .isVisible()
    .catch(() => false)
  if (!providerVisible) {
    await ui.click('testid=sidebar-settings', { timeoutMs })
  }
  await ui.click('testid=settings-nav-provider', { timeoutMs })
  await ui.expectVisible('testid=provider-list-header', { timeoutMs })
  await ui.click('testid=provider-template-picker', { timeoutMs })
  await ui.click('testid=add-menu-plugin', { timeoutMs })
  await ui.expectVisible('testid=plugin-provider-flow', { timeoutMs })
}

/**
 * 包名直装到确认停点（S27 第二路径）：填 spec → 点安装 → 等确认卡。
 * 输入框是真 <input>（ui 包 Input），用 fill。
 */
export async function directInstallToConfirm(ui, packageSpec, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000
  await ui.expectVisible('testid=plugin-family-grid', { timeoutMs })
  await ui.fill('testid=plugin-direct-spec', packageSpec, { timeoutMs })
  await ui.click('testid=plugin-direct-install-btn', { timeoutMs })
  await ui.expectVisible('testid=plugin-install-confirm', { timeoutMs })
}

/**
 * 断言确认卡知情面字段（逐项文本含断言；items 顺序按渲染序）。
 * 返回各字段的实际文本（供证据 attach）。
 */
export async function assertConfirmFields(ui, { capabilities = [], readPaths = [], permissions = [] }) {
  const actual = {}
  const fieldAsserts = [
    ['plugin-confirm-capabilities', 'capabilities', capabilities],
    ['plugin-confirm-read-paths', 'readPaths', readPaths],
    ['plugin-confirm-permissions', 'permissions', permissions],
  ]
  for (const [testid, label, expectedItems] of fieldAsserts) {
    const loc = ui.page.locator(`[data-testid="${testid}"]`)
    const count = await loc.count()
    if (expectedItems.length === 0 && count === 0) {
      actual[label] = '(未声明，字段不渲染)'
      continue
    }
    await ui.expectVisible(`testid=${testid}`)
    const text = await ui.text(`testid=${testid}`)
    actual[label] = text
    for (const item of expectedItems) {
      if (!text.includes(item)) {
        throw new Error(`确认卡 ${label} 缺少预期项 "${item}"，实际文本："${text.slice(0, 300)}"`)
      }
    }
  }
  return actual
}

/** 关闭流程对话框（Esc → onDialogToggle(false) → resetFlow：确认停点残留走 cancelPluginInstall）。 */
export async function closePluginFlow(ui) {
  await ui.press('Escape')
  await ui.expectGone('testid=plugin-provider-flow', { timeoutMs: 10_000 }).catch(async () => {
    // Esc 未生效时点遮罩关闭按钮兜底：reka-ui DialogContent 自带 X 按钮（无 testid），
    // 再兜不住就直接抛错由断言呈现
    await ui.press('Escape')
    await ui.expectGone('testid=plugin-provider-flow', { timeoutMs: 10_000 })
  })
}

/**
 * 条件轮询 B 通道断言辅助：fn 反复求值直到 predicate 为真或超时（返回最后值）。
 * 禁固定 sleep 后断言的合规形态（间隔 500ms）。
 */
export async function pollUntil(fn, predicate, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (predicate(value)) return value
    if (Date.now() >= deadline) return value
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
