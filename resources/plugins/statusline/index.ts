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

interface StatusSetUpdateData {
  sessionId: string
  key: string
  text: string
}

interface BridgeEventData {
  eventName: string
  data: StatusSetUpdateData | null | undefined
  sessionId: string
}

// ── plugin activation ─────────────────────────────────────────────

export async function activate(context: PluginContext): Promise<void> {
  const { api } = context

  const disposable = await api.hooks.onPiEvent(
    'plugin:statusSetUpdate',
    async (_eventName: string, data: unknown) => {
      try {
        const bridgeData = data as BridgeEventData
        const eventData = bridgeData.data ?? {}
        const sessionId = (eventData as Record<string, unknown>).sessionId as string ?? ''
        const key = String((eventData as Record<string, unknown>).key ?? '')
        const text = (eventData as Record<string, unknown>).text == null ? '' : String((eventData as Record<string, unknown>).text)

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
