// companion-bridge —— 移动壳 companion 区（CompanionBand/AskUserForm）的数据源与回传适配
// （remote-use D7「ask-user 提问答复 ✅」行的壳侧拉通）。
//
// 结构与桌面 renderer composables/shell/extension-host-dialog.ts 同构（core MessageBusBridge
// 归一 ui-request 事件 → ui CompanionBand 渲染 → respond 回传），差异面：
// - 不做 askUser C4 分流——桌面分流给 Panel inline 独占，移动壳无 Panel，CompanionBand
//   是 ask-user 的唯一消费面（v1 能力边界：dialog 全 method + askUser）；
// - OverlayLifecycle 不 provide（可选注入，组件侧静默 no-op）。
//
// 回传走 core 既有通路（不新造协议）：pi 源 extension.ui_response（sendExtensionUIResponse）、
// plugin 源 plugin.uiResponse（ws send）。
import { EXTENSION_BRIDGE_TYPES, InternalEventBus, MessageBusBridge } from '@taiji/core/extension-host'
import type { IncomingPluginMessage, InternalEvent, PluginMessageSource } from '@taiji/core/extension-host'
import { onCrossSession, onGlobal } from '@taiji/core/transport/api'
import { send } from '@taiji/core/transport/ws-client'
import { sendExtensionUIResponse } from '@taiji/core/transport/api/domains/extension'
import {
  DIALOG_REQUEST_SOURCE_KEY,
  UI_RESPONSE_TRANSPORT_KEY,
} from '@taiji/ui/extension-host'
import type { DialogRequest, DialogRequestSource, UiResponseTransport } from '@taiji/ui/extension-host'
import type { ServerMessage } from '@taiji/shared'

// ── WS 下行 → PluginMessageSource（对齐桌面 createWsPluginMessageSource 形态）──────

function createWsPluginMessageSource(): PluginMessageSource {
  return {
    subscribe(handler: (msg: IncomingPluginMessage) => void): () => void {
      const adapt = (msg: ServerMessage): void => {
        if (
          typeof msg.type === 'string' &&
          (msg.type.startsWith('plugin:') || EXTENSION_BRIDGE_TYPES.includes(msg.type))
        ) {
          const payload = (msg.payload ?? {}) as { sessionId?: string }
          handler({
            type: msg.type,
            sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
            payload: msg.payload,
          })
        }
      }
      const offGlobal = onGlobal(adapt)
      const offCrossSession = onCrossSession(adapt)
      return () => {
        offGlobal()
        offCrossSession()
      }
    },
  }
}

// ── bus + bridge 单例（模块级；dialog 撤窗反查表同理由两工厂共管，模块级才可达）──────

const bus = new InternalEventBus()
const bridge = new MessageBusBridge({ source: createWsPluginMessageSource(), bus })
void bridge // 构造即 subscribe；持有引用防误判可回收（dispose 在移动壳生命周期内不发生）

/** requestId → sessionId 反查表（dialog 撤窗广播无 sid，投递流记录；respond 即删） */
const requestIdSessions = new Map<string, string>()

// ── core InternalEvent('ui-request') → ui DialogRequest 转换（对齐桌面 convertToDialogRequest）──

const DIALOG_METHODS: readonly DialogRequest['method'][] = ['confirm', 'select', 'input', 'editor', 'askUser']

function isDialogMethod(v: unknown): v is DialogRequest['method'] {
  return typeof v === 'string' && (DIALOG_METHODS as readonly string[]).includes(v)
}

function isOptionObject(v: unknown): v is { label: string; value: string; description?: string } {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.label === 'string' && typeof o.value === 'string'
}

/** options 双形状归一：string[] → {label,value}[]；{label,value,description?}[] 透传；无有效项 undefined */
function normalizeOptions(options: unknown): DialogRequest['options'] {
  if (!Array.isArray(options)) return undefined
  const out: NonNullable<DialogRequest['options']> = []
  for (const item of options) {
    if (typeof item === 'string') {
      out.push({ label: item, value: item })
    } else if (isOptionObject(item)) {
      out.push({
        label: item.label,
        value: item.value,
        ...(item.description !== undefined ? { description: item.description } : {}),
      })
    }
  }
  return out.length > 0 ? out : undefined
}

type UiRequestEvent = Extract<InternalEvent, { kind: 'ui-request' }>

/** 与桌面 extension-host-dialog.convertToDialogRequest 同构（差异：不过滤 askUser） */
function convertToDialogRequest(e: UiRequestEvent): DialogRequest {
  const req = e.request
  const askUser = req.askUser === true
  const method: DialogRequest['method'] = askUser
    ? 'askUser'
    : isDialogMethod(req.method)
      ? req.method
      : (req.kind as DialogRequest['method'])
  return {
    source: req.pluginId !== '' ? 'plugin' : 'pi',
    sessionId: e.sessionId ?? '',
    requestId: req.requestId,
    method,
    ...(req.title !== undefined ? { title: req.title as string } : {}),
    ...(req.message !== undefined ? { message: req.message as string } : {}),
    ...(normalizeOptions(req.options) !== undefined ? { options: normalizeOptions(req.options)! } : {}),
    ...(req.default !== undefined ? { default: req.default as string } : {}),
    ...(req.prefill !== undefined ? { prefill: req.prefill as string } : {}),
    ...(req.level !== undefined ? { level: req.level as 'info' | 'warn' | 'error' } : {}),
    ...(askUser ? { askUserQuestions: req.askUserQuestions as unknown[] } : {}),
    ...(askUser ? { allowCancel: req.allowCancel as boolean } : {}),
    receivedAt: Date.now(),
  }
}

// ── source / transport 适配（App provide 消费）────────────────────────

function createMobileDialogRequestSource(): DialogRequestSource {
  return {
    onUiRequest(handler) {
      return bus.on('ui-request', (e) => {
        if (!e.sessionId) {
          console.warn('[companion-bridge] ui-request 事件缺少 sessionId，跳过投递:', e.request.requestId)
          return
        }
        // 移动壳不分流 askUser（桌面 C4 分流给 Panel inline；移动壳无 Panel，CompanionBand 独占）
        requestIdSessions.set(e.request.requestId, e.sessionId)
        handler(convertToDialogRequest(e))
      })
    },
    onUiRequestExpired(handler) {
      return onGlobal((msg) => {
        if (msg.type !== 'plugin:uiRequestExpired') return
        const payload = msg.payload as { requestId?: unknown; sessionId?: unknown }
        if (typeof payload.requestId !== 'string') return
        const sessionId = requestIdSessions.get(payload.requestId)
          ?? (typeof payload.sessionId === 'string' ? payload.sessionId : undefined)
        if (sessionId === undefined) return
        requestIdSessions.delete(payload.requestId)
        handler({ sessionId, requestId: payload.requestId })
      })
    },
  }
}

function createMobileUiResponseTransport(): UiResponseTransport {
  return {
    sendPiResponse(sessionId, requestId, method, result) {
      requestIdSessions.delete(requestId)
      sendExtensionUIResponse(sessionId, requestId, toInteractMethod(method), result)
    },
    sendPluginResponse(requestId, result) {
      requestIdSessions.delete(requestId)
      send({ type: 'plugin.uiResponse', payload: { requestId, result } })
    },
  }
}

/** method 收窄到 ExtensionInteractMethod（askUser 请求不达回传通道——已在 source 转成 method='askUser'） */
function toInteractMethod(method: string): 'confirm' | 'select' | 'input' | 'editor' {
  return method === 'confirm' || method === 'select' || method === 'input' || method === 'editor'
    ? method
    : 'input'
}

export const mobileDialogRequestSource = createMobileDialogRequestSource()
export const mobileUiResponseTransport = createMobileUiResponseTransport()

export { DIALOG_REQUEST_SOURCE_KEY, UI_RESPONSE_TRANSPORT_KEY }
