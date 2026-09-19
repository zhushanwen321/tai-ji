/**
 * demo-echo —— 临时夹具（plugin-header-action-modal-points 验收场景 5/11/12 用，
 * **验后由主 agent 删除整个目录**；非规范交付物）。
 *
 * 第二个假想消费者，证明点位可复用（G3）：与 scheduler-manager 同形态的 plugin
 * 实体（有 descriptor，Plugins 面板 togglePlugin('demo-echo', false) 可作用，E2
 * 「禁用后按钮与层一起消失」才可执行），handler 维护 count 渲染 action-bar
 * （+1 / -1 / 清零）。
 *
 * 入口形态：顶栏按钮点击链 = CommandRegistry.execute('demo-echo.open') → WS
 * plugin.executeCommand → 本 handler（声明按需临时加进 core builtinContributions，
 * 场景 5 组装时由主 agent 决定；实体不依赖声明表——showModal/views.update 是活的
 * RPC 直连，E9「声明 = 可见性，运行时 API = 能力」）。其余命令供验收 agent 直发
 * WS plugin.executeCommand：
 * - demo-echo.show-input：制造 pending 插件对话框（场景 11b 的 E10 拒开前置）
 * - demo-echo.debug-send：直发 sendMessage({requireCommand:'schedule'})（场景 12②
 *   验证 command-missing 回执不漏模型）
 */
import type { PluginContext } from '../../../packages/runtime/src/services/plugin-service/plugin-types.js'
// 相对路径直指包源码（scheduler-manager 同款：dev tsx 形态下裸包名解析不到，见其头注）
import type { GuiComponent } from '../../../packages/extension-protocol/src/index.ts'

type Api = PluginContext['api']

const MODAL_ID = 'demo-echo.panel'
const MODAL_VIEW_ID = 'modal-demo-echo-demo-echo.panel'
const HEADER_ACTION_ID = 'demo-echo.open'

/** 模块级计数（夹具瞬态，无需持久化/订阅） */
let count = 0
/** 渲染端焦点会话（与 scheduler-manager 同款：didActivate 维护 + list() 兜底） */
let focusSessionId: string | null = null

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function buildTree(): GuiComponent[] {
  return [
    { type: 'stats-line', props: { items: [{ label: 'count', value: String(count) }] } },
    {
      type: 'action-bar',
      props: {
        items: [
          { id: 'inc', label: '+1', commandId: 'demo-echo.inc' },
          { id: 'dec', label: '-1', commandId: 'demo-echo.dec' },
          { id: 'reset', label: '清零', kind: 'danger', commandId: 'demo-echo.reset' },
        ],
      },
    },
  ]
}

async function pushModal(api: Api): Promise<void> {
  const sessionId = focusSessionId
  if (!sessionId) {
    await api.notify.warning('demo-echo：当前没有可打开的会话')
    return
  }
  try {
    await api.ui.showModal(MODAL_ID, { sessionId })
  } catch (e) {
    // 场景 11b：MODAL_BLOCKED_BY_UI_REQUEST 走此路径（界面不出现半态）
    await api.notify.warning(`demo-echo 面板未能打开：${toMessage(e)}`)
    return
  }
  await api.views.update(MODAL_VIEW_ID, buildTree(), { sessionId })
}

async function bump(api: Api, delta: number): Promise<void> {
  count = delta === 0 ? 0 : count + delta
  if (focusSessionId) {
    await api.views.update(MODAL_VIEW_ID, buildTree(), { sessionId: focusSessionId })
  }
}

export async function activate(context: PluginContext): Promise<void> {
  const { api } = context
  const sink = context.subscriptions

  sink.push(
    api.sessions.onDidActivateSession((session) => {
      focusSessionId = session.id
    }),
  )
  try {
    const sessions = await api.sessions.list()
    if (sessions.length > 0) {
      focusSessionId = sessions.reduce((a, b) => (b.lastActiveAt > a.lastActiveAt ? b : a)).id
    }
  } catch (e) {
    console.warn('[demo-echo] cold-start list() failed:', toMessage(e))
  }

  await api.commands.register({ id: HEADER_ACTION_ID, title: 'Demo Echo' }, () => pushModal(api))
  await api.commands.register({ id: 'demo-echo.inc', title: 'demo +1' }, () => bump(api, 1))
  await api.commands.register({ id: 'demo-echo.dec', title: 'demo -1' }, () => bump(api, -1))
  await api.commands.register({ id: 'demo-echo.reset', title: 'demo 清零' }, () => bump(api, 0))
  // 场景 11b：制造 pending 插件对话框（showInput 待决期间 showModal 应被 E10 拒绝）
  await api.commands.register(
    { id: 'demo-echo.show-input', title: 'demo 待决输入框' },
    async (args) => {
      const sessionId =
        (args as { sessionId?: unknown } | null)?.sessionId != null
          ? String((args as { sessionId?: unknown }).sessionId)
          : focusSessionId
      if (!sessionId) return
      // 不传 timeout：agent 验完 abort/回应即可结束待决
      await api.ui.showInput('demo-echo 待决输入（用于浮层互斥验收）', '待回应')
    },
  )
  // 场景 12②：直发 /schedule + requireCommand，断言 command-missing 回执不漏模型
  await api.commands.register(
    { id: 'demo-echo.debug-send', title: 'demo 调试直发' },
    async (args) => {
      const record = (args ?? {}) as { sessionId?: unknown; content?: unknown }
      const sessionId =
        record.sessionId != null ? String(record.sessionId) : focusSessionId
      if (!sessionId || typeof record.content !== 'string') {
        await api.notify.warning('demo-echo.debug-send 需要 args: { sessionId, content }')
        return
      }
      const receipt = await api.sessions.sendMessage({
        sessionId,
        role: 'user',
        content: record.content,
        requireCommand: 'schedule',
      })
      console.log('[demo-echo] debug-send receipt:', JSON.stringify(receipt))
    },
  )

  console.log('[demo-echo] activated (temporary acceptance fixture)')
}
