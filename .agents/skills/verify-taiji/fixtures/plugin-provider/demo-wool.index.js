/**
 * demo-wool —— verify-taiji D3 验收 fixture 插件（provider-plugin-access S1/S5/S6/S7）。
 *
 * 零 import：sandbox 基线封禁大部分内置模块，本 fixture 不需要任何能力（capabilities: []）。
 *
 * 行为契约（与剧本断言一一对应，改这里必须同步改剧本锚点串）：
 *  - 激活即向 provider.authorize / provider.detail-extra 两个全局挂载位推演示树（D2）；
 *  - getStatus 方法恒返回 null（S5/D5：插件明确「未上报」→ 宿主不得猜测凭据状态）；
 *  - 从不调用 events.report（S5：从不上报状态的 demo provider）；
 *  - text-input(demo-pat) 值经 onUiEvent 持有最新值（D8 fire-and-forget，变更不重推）；
 *    action-bar「确认回传」命令（demo-wool.confirm）触发重推新树：
 *    含「已回传: <值>」行 + 输入框 value 回显（S7：值回传 + 插件推新树 + 输入状态保持）。
 */

const AUTHORIZE_MOUNT = 'provider.authorize'
const DETAIL_EXTRA_MOUNT = 'provider.detail-extra'
const PAT_INPUT_ID = 'demo-pat'
const CONFIRM_COMMAND_ID = 'demo-wool.confirm'

/** 详情区哨兵串（A6 DOM 断言锚点：插件内容只出现在 detail-extra 边界内）。 */
const DETAIL_SENTINEL = 'DEMO-EXTRA-SENTINEL-7Q'

/** 插件侧唯一状态：PAT 最新值 + 是否已确认（fork 进程内单例，数据目录一次性）。 */
const state = { pat: '', confirmed: false }

function detailTree() {
  const children = [
    { type: 'ansi-text', props: { lines: [`${DETAIL_SENTINEL} · demo-wool 插件内容区`] } },
    { type: 'list-tree', props: { items: [{ label: 'demo-model-1（演示模型）', depth: 0 }] } },
    {
      type: 'text-input',
      props: {
        id: PAT_INPUT_ID,
        label: 'Demo PAT（演示输入）',
        placeholder: '粘贴任意文本后点确认',
        value: state.pat,
      },
    },
    {
      type: 'action-bar',
      props: {
        items: [{ id: 'demo-confirm', label: '确认回传', commandId: CONFIRM_COMMAND_ID }],
      },
    },
  ]
  if (state.confirmed) {
    children.push({ type: 'ansi-text', props: { lines: [`已回传: ${state.pat}`] } })
  }
  return children
}

async function pushDetail(api) {
  await api.views.update(DETAIL_EXTRA_MOUNT, detailTree(), { mountId: DETAIL_EXTRA_MOUNT })
}

export async function activate(context) {
  const { api } = context

  // S5/D5：getStatus 恒返回 null（显式「未上报」，与「从不 report」同向——宿主两个拉取/推送
  // 入口都拿不到任何凭据状态）。
  await api.commands.register({ id: 'getStatus' }, () => null)

  // S7：确认动作 → 重推新树（插件侧持有最新值，重推携带回显）。
  await api.commands.register({ id: CONFIRM_COMMAND_ID }, () => {
    state.confirmed = true
    return pushDetail(api)
  })

  // D8：值变更即回传（fire-and-forget，插件持有最新值；不重推——重推只由确认命令触发）。
  context.subscriptions.push(
    api.views.onUiEvent((event) => {
      if (event.viewId === DETAIL_EXTRA_MOUNT && event.componentId === PAT_INPUT_ID && event.event === 'change') {
        state.pat = String(event.value ?? '')
      }
    }),
  )

  await pushDetail(api)
  await api.views.update(
    AUTHORIZE_MOUNT,
    [
      {
        type: 'ansi-text',
        props: {
          lines: [
            'DEMO-AUTHORIZE · demo-wool 授权流程（演示树）',
            '① 准备授权（演示占位）',
            '② 完成后凭据由宿主统一落盘',
          ],
        },
      },
    ],
    { mountId: AUTHORIZE_MOUNT },
  )

  console.log('[demo-wool] activated (authorize + detail-extra trees pushed, getStatus=null)')
}
