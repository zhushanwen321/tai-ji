import type { PluginContext } from '../../../packages/runtime/src/services/plugin-service/plugin-types.js'

// ── key → metadata mapping ────────────────────────────────────────

interface StatusKeyMetadata {
  priority: number
  tooltip?: string
  scope: 'per-session' | 'global'
}

const KEY_METADATA_MAP: Record<string, StatusKeyMetadata> = {
  goal:     { priority: 10, tooltip: 'Goal task progress', scope: 'per-session' },
  todo:     { priority: 20, tooltip: 'Todo list progress', scope: 'per-session' },
  workflow: { priority: 15, tooltip: 'Workflow status',    scope: 'per-session' },
  preset:   { priority: 30, tooltip: 'Active preset',      scope: 'global' },
  ssh:      { priority: 40, tooltip: 'SSH connection',     scope: 'global' },
  model:    { priority: 50, tooltip: 'Current model',      scope: 'global' },
}

const DEFAULT_METADATA: StatusKeyMetadata = {
  priority: 100,
  tooltip: undefined,
  scope: 'global',
}

// ── event payload types ───────────────────────────────────────────

/**
 * statusSetUpdate 载荷（平铺形状，pi1-disposition-chat-flow D7②）：新投递点
 * （pluginService.notifyPiEvent）按泛型 'onPiEvent' 键派发，hook-api 适配层走
 * 「event-interpreter 平铺」分支——handler 第二参 = 剥离 event 元字段后的业务载荷本身，
 * 键值直出（sessionId/key/text/textRaw）。
 * [HISTORICAL] 原按 bridge 包装形状 BridgeEventData{eventName,data,sessionId} 解包
 * bridgeData.data ?? {}——该形状随 bridge 退役消失；且旧分发键错位（注册键 'onPiEvent'
 * vs 分发键原始事件名）使本插件从未实际收到过事件（断链已随挂点迁移修复）。
 */
interface StatusSetUpdateData {
  sessionId?: string
  key?: string
  text?: string
}

// ── plugin activation ─────────────────────────────────────────────

export async function activate(context: PluginContext): Promise<void> {
  const { api } = context

  const disposable = await api.hooks.onPiEvent(
    'plugin:statusSetUpdate',
    async (_eventName: string, data: unknown) => {
      try {
        const eventData = (data ?? {}) as StatusSetUpdateData
        const sessionId = typeof eventData.sessionId === 'string' ? eventData.sessionId : ''
        const key = String(eventData.key ?? '')
        const text = eventData.text == null ? '' : String(eventData.text)

        // Empty text means clear — let updateStatusBarItem handle removal (plugin-service deletes from Map)

        const meta = KEY_METADATA_MAP[key] ?? DEFAULT_METADATA

        await api.ui.updateStatusBarItem(
          `pi-${key}`,
          text,
          {
            tooltip: meta.tooltip,
            priority: meta.priority,
            scope: meta.scope,
            sessionId: meta.scope === 'per-session' ? sessionId : undefined,
          },
        )

      } catch (err) {
        console.error('[statusline] Error handling statusSetUpdate:', err)
        // Intentionally silent — statusline is passive, should not crash the Worker
      }
    },
  )

  context.subscriptions.push(disposable)
}
