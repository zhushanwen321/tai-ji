/**
 * probe-container-plugin —— 容器位统一验收探针插件（设计 §8.2 S1-S4 / impl-plan A1-A5、A7、A8）。
 *
 * 落位：D3 验收时从 dev-flow staging 复制进仓库 resources/plugins/probe-container-plugin/
 * 并经 esbuild 产出 index.js（同 resources/plugins 构建链）。
 *
 * 验收素材（声明面 = package.json taijiPlugin.contributes，按 D1 落地契约）：
 * - S1/A1：probe.tab（drawer.tab）声明 → 抽屉标签条派生出现 + 本文件按焦点会话推树；
 * - S2/A2：probe.panel（overlay.content）声明 + headerAction activation
 *   {kind:'overlay', tabId:'probe.panel'} → 浮层标签条派生「探针浮层」段，
 *   头部按钮点击经容器导航执行器开浮层并渲染本插件推树；
 * - S3/A3：list-tree item.hostAction 双向导航（抽屉树 → 开浮层；浮层树 → 开抽屉）
 *   + params 标量透传（unknownKey 反例 → §5.4 行 8 未知键 warning、动作照常）；
 * - S4/A4：probe.bad（placement=nonexistent.slot）→ 不可用声明（不派生进任何容器，
 *   插件管理页标记 + §5.4 行 2 warning）；
 * - A8/S8：无禁用/卸载分支由 verify 剧本经宿主操作驱动（本插件被动配合重放）。
 *
 * 形态依据（D1 落地代码核对 2026-10-25）：
 * - HostContainerAction = { kind:'overlay'|'drawer', tabId, params? }（extension-protocol
 *   core/types.ts:229；字段名 tabId 与设计 §5.2 终态「contentId」的名词分歧 = ledger
 *   D2 核对项，D2 裁决改名则本文件与 manifest 同步换名）；
 * - PluginContributesView = { id, title, placement, icon?, order?, emptyState?, scope? }；
 * - 推树出口 api.views.update(viewId, tree, { sessionId })（scheduler-manager 同款）；
 * - 导入形态：PluginContext 相对路径直指 runtime 源码（P4：tsx 形态下裸包名解析不到）。
 */
import type { PluginContext } from '../../../packages/runtime/src/services/plugin-service/plugin-types.js'
import type { GuiComponent } from '../../../packages/extension-protocol/src/index.ts'

type Api = PluginContext['api']

const VIEW_ID = 'probe-container-plugin.tab'
const OVERLAY_VIEW_ID = 'probe-container-plugin.panel'

/** 组装抽屉面板树：文本行 + 统计行 + list-tree（hostAction 正向开浮层 / unknown params 反例）。 */
function buildDrawerTree(sessionId: string): GuiComponent[] {
  return [
    {
      type: 'ansi-text',
      props: { lines: [`探针面板已挂载（会话 ${sessionId.slice(0, 8)}）`] },
    },
    {
      type: 'stats-line',
      props: { items: [{ label: '推树次数', value: '1' }] },
    },
    {
      type: 'list-tree',
      props: {
        items: [
          {
            id: 'probe-row-open-overlay',
            label: '打开探针浮层（hostAction → overlay.content）',
            hostAction: { kind: 'overlay', tabId: OVERLAY_VIEW_ID },
          },
          {
            id: 'probe-row-unknown-params',
            label: '未知参数反例（§5.4 行 8：warning + 动作照常）',
            hostAction: { kind: 'drawer', tabId: VIEW_ID, params: { unknownKey: 1 } },
          },
        ],
      },
    },
  ]
}

/** 组装浮层内容树：文本行 + list-tree（hostAction 反向开抽屉，S3 双向覆盖）。 */
function buildOverlayTree(): GuiComponent[] {
  return [
    {
      type: 'ansi-text',
      props: { lines: ['探针浮层内容（headerAction activation 直开或树内 hostAction 导入）'] },
    },
    {
      type: 'list-tree',
      props: {
        items: [
          {
            id: 'probe-row-open-drawer',
            label: '回到探针面板（hostAction → drawer.tab）',
            hostAction: { kind: 'drawer', tabId: VIEW_ID },
          },
        ],
      },
    },
  ]
}

export async function activate(context: PluginContext): Promise<void> {
  const { api } = context
  const sink = context.subscriptions
  let pushed = false

  const pushAll = async (sessionId: string): Promise<void> => {
    try {
      await api.views.update(VIEW_ID, buildDrawerTree(sessionId), { sessionId })
      await api.views.update(OVERLAY_VIEW_ID, buildOverlayTree(), { sessionId })
      pushed = true
    } catch (e) {
      console.warn('[probe-container-plugin] views.update failed:', e)
    }
  }

  // 焦点会话追踪 + 冷启动兜底（scheduler-manager 同款：didActivate + list() 取
  // lastActiveAt 最大者；探针不需要 per-session 镜像，无 didCreate 挂点）
  let focusSessionId: string | null = null
  sink.push(
    api.sessions.onDidActivateSession((session) => {
      focusSessionId = session.id
      void pushAll(session.id)
    }),
  )
  const sessions = await api.sessions.list()
  if (!pushed && sessions.length > 0) {
    const last = [...sessions].sort(
      (a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0),
    )[0]
    focusSessionId = last.id
    await pushAll(last.id)
  }
  void focusSessionId
}
