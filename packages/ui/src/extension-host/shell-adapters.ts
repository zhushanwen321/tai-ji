/**
 * shell-adapters.ts —— 双壳（桌面 renderer / 移动 mobile-renderer）共享的 extension-host
 * 壳侧适配层（remote-use 架构审查裁决：companion 对话桥翻译层去重下沉）。
 *
 * 两类纯翻译件（零壳特有裁决，双壳逐字节共享）：
 * - createWsPluginMessageSource：WS 下行（events 通道 plugin:/extension: 消息）→
 *   PluginMessageSource（MessageBusBridge 的输入；core/extension-host/plugin-message-source.ts
 *   注释明确「壳把 transport 层适配成 source 注入」）
 * - createCompanionDialogAdapters：bus 'ui-request' + WS plugin:uiRequestExpired →
 *   DialogRequestSource / UiResponseTransport（companion-band-source.ts 契约的壳侧实现），
 *   唯一策略差异经 routeAskUser 参数注入（askUser 路由是壳裁决，不属翻译件）
 *
 * 壳各自保留的装配裁决（不进本模块）：bus 来源选择（桌面 getExtensionBus 惰性单例 /
 *   移动模块级私有 bus）+ provide 时机（桌面 initExtensionHostBridge / 移动 App.vue setup）。
 *
 * 消息流：WS 下行 → route-inbound（events 正规通道）→ createWsPluginMessageSource →
 * MessageBusBridge → bus 'ui-request'（plugin:uiRequest + extension.ui_request 双源归一）
 * → source.onUiRequest（无 sid 跳过 / routeAskUser 分流）→ convertToDialogRequest →
 * DialogRequestQueue → CompanionBand 渲染 → 用户操作 → queue.respond → transport 回传
 * （pi 源 → extension.ui_response / plugin 源 → plugin.uiResponse）。
 *
 * 超时撤窗：WS plugin:uiRequestExpired（plugin 源 dialog 到期取消，D2）经
 * onUiRequestExpired → requestId 反查 sessionId → queue 按 requestId 出队（不发回传）。
 */
import type {
  IncomingPluginMessage,
  InternalEvent,
  InternalEventBus,
  PluginMessageSource,
} from '@taiji/core'
import { EXTENSION_BRIDGE_TYPES } from '@taiji/core'
import type {
  DialogRequest,
  DialogRequestOption,
  DialogRequestSource,
  UiResponseTransport,
} from './companion-band-source'
import type { ExtensionInteractMethod, ServerMessage } from '@taiji/shared'
import { onCrossSession, onGlobal } from '@taiji/core/transport/api'
import { send } from '@taiji/core/transport/ws-client'
import { sendExtensionUIResponse } from '@taiji/core/transport/api/domains/extension'

// ── WS 下行 → PluginMessageSource（bridge 输入侧纯翻译件）─────────────────

/**
 * 把壳的 WS 消息流（events 通道的 plugin:/extension: 下行）适配成 PluginMessageSource。
 *
 * 过滤条件：plugin:* 前缀 OR EXTENSION_BRIDGE_TYPES 精确白名单——白名单是 core 导出
 * SSOT（D10②，派生自 message-bus-bridge.ts EXTENSION_HANDLERS 的 keys）。plugin:* 前缀
 * 全放行，extension:* 只放行白名单内 type——其余（如 extension.error）由 source filter
 * 静默丢弃，不进 bridge（source 职责边界）。
 *
 * ADR-0060：数据源从 raw-message-tap 旁路改为 events 正规双订阅（route-inbound 单一真相源）：
 * - onGlobal：收无 sid 的 plugin:*（statusBarUpdate/notification/uiRequest 等走 global 通道）
 * - onCrossSession：收带 sid 的 extension:*（widget/widgetGui/status/notify/ui_request
 *   + plugin:uiRequest/plugin:viewUpdate，route-inbound 声明式条目 crossSession 字段分发，
 *   全局单例消费者 ExtensionHost 接收）
 * 经 source filter 后消息集合与旧 raw-tap 全量订阅等价（plugin:* 无 sid + extension.* 带 sid）。
 */
export function createWsPluginMessageSource(): PluginMessageSource {
  return {
    subscribe(handler: (msg: IncomingPluginMessage) => void): () => void {
      // 适配 raw ServerMessage → IncomingPluginMessage（source filter：plugin:* 前缀 OR 白名单 type）
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

// ── core InternalEvent('ui-request') → ui DialogRequest 转换（纯函数）────────

type UiRequestEvent = Extract<InternalEvent, { kind: 'ui-request' }>

// ── 类型守卫（索引签名字段收窄，禁止 any 断言） ──────────────────────

const DIALOG_METHODS: readonly DialogRequest['method'][] = ['confirm', 'select', 'input', 'editor', 'askUser']

function isDialogMethod(v: unknown): v is DialogRequest['method'] {
  return typeof v === 'string' && (DIALOG_METHODS as readonly string[]).includes(v)
}

/** options 对象形状守卫：{ label: string, value: string, description?: string } */
function isOptionObject(v: unknown): v is { label: string; value: string; description?: string } {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.label === 'string' && typeof o.value === 'string'
}

/**
 * options 双形状归一（AC2）：string[] → { label, value }[]；
 * { label, value, description? }[] 透传；非法项跳过；无有效项返回 undefined。
 */
function normalizeOptions(options: unknown): DialogRequestOption[] | undefined {
  if (!Array.isArray(options)) return undefined
  const out: DialogRequestOption[] = []
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
    // 非法项（非 string 且非合法对象形状）跳过
  }
  return out.length > 0 ? out : undefined
}

/**
 * 转换 bus ui-request 事件为 ui 包 DialogRequest（AC2）：
 * - source：request.pluginId !== '' → 'plugin'（plugin 源），否则 'pi'（extension 源统一 ''）
 * - method：askUser === true → 'askUser'（C2 改写，askUserQuestions/allowCancel 透传）；
 *   否则索引签名原始 method（超界如 editor 透传）?? kind 兜底（对齐 toExtensionUIRequest 语义）
 * - options：双形状归一（normalizeOptions）
 * - receivedAt：转换时刻时间戳（队列倒计时基准）
 */
export function convertToDialogRequest(e: UiRequestEvent): DialogRequest {
  const req = e.request
  const askUser = req.askUser === true
  const method: DialogRequest['method'] = askUser
    ? 'askUser'
    : isDialogMethod(req.method)
      ? req.method
      : req.kind
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

/** method 收窄到 ExtensionInteractMethod（askUser 请求不达回传通道——panel 路由已在投递层
 *  过滤；companion 路由下 askUser 的应答由 AskUserForm 经 sendPiResponse 以 method='askUser'
 *  外的收窄形态回传，非法值统一兜底 input） */
function toInteractMethod(method: string): ExtensionInteractMethod {
  return method === 'confirm' || method === 'select' || method === 'input' || method === 'editor'
    ? method
    : 'input' // 兜底对齐 core parseUiRequest 的 kind 兜底语义
}

// ── askUser 路由策略（壳裁决注入点，唯一策略差异）────────────────────────

/**
 * askUser 请求的路由裁决（分流契约 feature clarify C2/C4）：
 * - 'panel'：桌面壳——askUser 请求由 useExtensionUI 消费（Panel inline 独占），本层投递时
 *   跳过 askUser 事件（CompanionBand 独占非 askUser dialog），两者在数据源层分流零重叠
 * - 'companion'：移动壳——无 Panel，CompanionBand（AskUserForm）是 askUser 唯一消费面，
 *   dialog 全 method + askUser 全投递（v1 能力边界）
 */
export type AskUserRouting = 'companion' | 'panel'

export interface CompanionDialogAdaptersOptions {
  /** askUser 请求路由策略（双壳唯一行为差异，见 AskUserRouting） */
  routeAskUser: AskUserRouting
}

/** 测试后门命名空间（生产代码禁止消费，对齐壳层 __testing 先例）：G1 反查表探针 */
export interface CompanionDialogAdaptersTesting {
  /** requestIdSessions 表项数（G1 respond 删除路径探针） */
  probeRequestIdSessionsSize(): number
  /** 测试隔离：清空反查表（防跨用例泄漏；新 factory 实例天然隔离，共用实例场景用） */
  resetRequestIdSessionsForTest(): void
}

export interface CompanionDialogAdapters {
  /** CompanionBand 数据源（bus 'ui-request' + WS plugin:uiRequestExpired 适配） */
  source: DialogRequestSource
  /** 回传双通道（pi 源 extension.ui_response / plugin 源 plugin.uiResponse） */
  transport: UiResponseTransport
  /** 测试后门（G1 内存审计探针，生产代码禁止消费） */
  __testing: CompanionDialogAdaptersTesting
}

/**
 * 创建 CompanionBand 的 source + transport 适配对（FR2/FR7，AC2/AC6/AC9）。
 *
 * source 与 transport 必须成对出自同一次调用：requestId → sessionId 反查表（撤窗广播无
 * sid，投递流记录归属）由本 factory 单点持有、两适配器共管——source.onUiRequest 写入 /
 * transport respond（sendPiResponse + sendPluginResponse 双通道）即删。
 *
 * [G1 / 2026-09-14 内存审计 §3.4，双壳共同持有] requestIdSessions 表条目的有效清理路径
 * 只有 respond（pi 源 dialog 无撤窗广播——extension UI 请求已无超时机制）。respond 即删；
 * plugin 源另有撤窗广播删除点。生产每壳单 factory 调用（单 source + 单 transport）；
 * 每次调用新表，测试跨用例天然隔离（共用实例场景经 __testing.resetRequestIdSessionsForTest）。
 *
 * source.onUiRequest：
 * - 无 sessionId 跳过 + console.warn（C2，防 '' 分区脏数据）
 * - routeAskUser === 'panel' 时 askUser === true 跳过投递（C4 分流）
 * source.onUiRequestExpired：WS plugin:uiRequestExpired（timeout-plugin-service D2 超时撤窗，
 * 不经 bus——bridge 无此归一项）。按 requestId 反查（onUiRequest 流经时记录 requestId→sessionId
 * 映射，投递时归属 sid，MF-4 反查为主）；Map miss 时 payload 可选 sessionId 兜底（壳重启）。
 * 查不到（弹窗已 respond 关闭 / 从未投递 / 广播迟到于出队）→ noop 幂等（V4b miss 语义：
 * 广播无条件发出，miss 是正常时序）。
 *
 * transport（回传双通道）：
 * - sendPiResponse：复用 sendExtensionUIResponse（extension.ui_response，method 透传，
 *   runtime 按 method 构建 pi 响应格式，AC9）
 * - sendPluginResponse：发 plugin.uiResponse（runtime UiRequestQueue.handleResponse 消费，AC6）
 * - [G1] 双通道 respond 即删反查表项——删除后迟到的撤窗广播按 miss noop 语义跳过，
 *   不误触已达应答 dialog
 */
export function createCompanionDialogAdapters(
  bus: InternalEventBus,
  options: CompanionDialogAdaptersOptions,
): CompanionDialogAdapters {
  // taste:allow-no-data-owner（ADR-0049 全局 sid 协调器/订阅注册基建已登记）：requestId→sessionId
  // 反查表（dialog 撤窗/应答路由），非 GUI 数据；factory 单点持有（见函数头 [G1] 注释）
  const requestIdSessions = new Map<string, string>()

  const source: DialogRequestSource = {
    onUiRequest(handler) {
      return bus.on('ui-request', (e) => {
        if (!e.sessionId) {
          console.warn('[dialog-adapters] ui-request 事件缺少 sessionId，跳过投递:', e.request.requestId)
          return
        }
        if (options.routeAskUser === 'panel' && e.request.askUser === true) {
          return // C4：askUser 由 useExtensionUI 消费（Panel inline，桌面壳路由）
        }
        // D2 撤窗反查表：同一 requestId 重复投递（实时帧 + 快照双源）幂等覆盖
        requestIdSessions.set(e.request.requestId, e.sessionId)
        handler(convertToDialogRequest(e))
      })
    },
    onUiRequestExpired(handler) {
      return onGlobal((msg) => {
        if (msg.type !== 'plugin:uiRequestExpired') return
        const payload = msg.payload as { requestId?: unknown; sessionId?: unknown }
        if (typeof payload.requestId !== 'string') return
        // MF-4：requestId 反查（onUiRequest 投递时记录的权威归属 sid）为主——payload.sessionId
        // 是撤窗时点的活跃 sid（S1 修复引入），投递后切换 session 会路由错分区；payload sid
        // 降为 Map miss 兜底（壳重启 / 旧版 runtime 未记录条目）
        const sessionId = requestIdSessions.get(payload.requestId)
          ?? (typeof payload.sessionId === 'string' ? payload.sessionId : undefined)
        // miss noop 幂等（V4b）：已 respond 关闭 / 排队中从未展示 / 未知请求的撤窗广播
        // 直接忽略；命中则先删表项（生命周期至撤窗/respond 为止，G1）再出队。
        if (sessionId === undefined) return
        requestIdSessions.delete(payload.requestId)
        handler({ sessionId, requestId: payload.requestId })
      })
    },
  }

  const transport: UiResponseTransport = {
    sendPiResponse(sessionId, requestId, method, result) {
      requestIdSessions.delete(requestId)
      sendExtensionUIResponse(sessionId, requestId, toInteractMethod(method), result)
    },
    sendPluginResponse(requestId, result) {
      requestIdSessions.delete(requestId)
      send({ type: 'plugin.uiResponse', payload: { requestId, result } })
    },
  }

  const __testing: CompanionDialogAdaptersTesting = {
    probeRequestIdSessionsSize(): number {
      return requestIdSessions.size
    },
    resetRequestIdSessionsForTest(): void {
      requestIdSessions.clear()
    },
  }

  return { source, transport, __testing }
}
