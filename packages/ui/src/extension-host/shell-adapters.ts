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
 *   壳层能力（pendingSend 收尾锚点 / 未送达提示）经可选回调注入（纯翻译件不依赖壳 i18n/store）
 *
 * 壳各自保留的装配裁决（不进本模块）：bus 来源选择（桌面 getExtensionBus 惰性单例 /
 *   移动模块级私有 bus）+ provide 时机（桌面 initExtensionHostBridge / 移动 App.vue setup）。
 *
 * 消息流：WS 下行 → route-inbound（events 正规通道）→ createWsPluginMessageSource →
 * MessageBusBridge → bus 'ui-request'（plugin:uiRequest + extension.ui_request 双源归一）
 * → source.onUiRequest（无 sid 跳过 / C4 四键排除）→ convertToDialogRequest →
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

const DIALOG_METHODS: readonly DialogRequest['method'][] = ['confirm', 'select', 'input', 'editor']

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
 * { label, value, description? }[] 透传；非法项跳过（留痕：单条 console.warn 汇总跳过数与
 * 索引，带 requestId——降级不静默，对齐移动壳 MobileFormCard formQuestions dropped 先例）；
 * 无有效项返回 undefined。
 */
function normalizeOptions(options: unknown, requestId: string): DialogRequestOption[] | undefined {
  if (!Array.isArray(options)) return undefined
  const out: DialogRequestOption[] = []
  const skippedIndices: number[] = []
  for (let i = 0; i < options.length; i++) {
    const item = options[i]
    if (typeof item === 'string') {
      out.push({ label: item, value: item })
    } else if (isOptionObject(item)) {
      out.push({
        label: item.label,
        value: item.value,
        ...(item.description !== undefined ? { description: item.description } : {}),
      })
    } else {
      // 非法项（非 string 且非合法对象形状）跳过并记录索引
      skippedIndices.push(i)
    }
  }
  if (skippedIndices.length > 0) {
    console.warn(
      `[shell-adapters] ui-request options 非法项跳过 ${skippedIndices.length}/${options.length}`
        + `（索引 [${skippedIndices.join(', ')}]，要求 string 或 { label, value } 对象，requestId=${requestId}）`,
    )
  }
  return out.length > 0 ? out : undefined
}

/**
 * 转换 bus ui-request 事件为 ui 包 DialogRequest（AC2）：
 * - source：request.pluginId !== '' → 'plugin'（plugin 源），否则 'pi'（extension 源统一 ''）
 * - method：索引签名原始 method（超界如 editor 透传）?? kind 兜底（对齐
 *   toExtensionUIRequest 语义）；form 类请求已被 C4 排除，不会到达本转换
 * - options：双形状归一（normalizeOptions）
 * - receivedAt：转换时刻时间戳（队列倒计时基准）
 */
export function convertToDialogRequest(e: UiRequestEvent): DialogRequest {
  const req = e.request
  const method: DialogRequest['method'] = isDialogMethod(req.method)
    ? req.method
    : req.kind
  // 归一单次执行（曾内联调用两次——非法项留痕 warn 会双发）
  const options = normalizeOptions(req.options, req.requestId)
  return {
    source: req.pluginId !== '' ? 'plugin' : 'pi',
    sessionId: e.sessionId ?? '',
    requestId: req.requestId,
    method,
    ...(req.title !== undefined ? { title: req.title as string } : {}),
    ...(req.message !== undefined ? { message: req.message as string } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(req.default !== undefined ? { default: req.default as string } : {}),
    ...(req.prefill !== undefined ? { prefill: req.prefill as string } : {}),
    ...(req.level !== undefined ? { level: req.level as 'info' | 'warn' | 'error' } : {}),
    receivedAt: Date.now(),
  }
}

/** method 收窄到 ExtensionInteractMethod（form 类请求已被 C4 过滤，不会到达回传通道） */
function toInteractMethod(method: string): ExtensionInteractMethod {
  return method === 'confirm' || method === 'select' || method === 'input' || method === 'editor'
    ? method
    : 'input' // 兜底对齐 core parseUiRequest 的 kind 兜底语义
}

// ── 壳层能力注入点（回调可选，未注入 = 空操作）────────────────────────

/**
 * 双壳共享 factory 的壳层能力注入（桌面 useExtensionHostBridge / 移动 companion-bridge）：
 * - onPiResponseSettled：通路级收尾锚点（plain-dialog-submit-settle D1；ADR-0072 cancel 型
 *   分型先例 → ADR-0073 D4a 壳层锚点与通路级收口）。sendPiResponse 应答终局无条件调用
 *   （cancel / 提交 / WS 断连三型统一，清在 delivered 判定之前——断连期 turn 同样不可达）。
 *   桌面壳注入 chatStore.clearPendingSend（plain dialog 通路默认值 = 无 turn 预期，生产者
 *   穷尽论证见 ADR-0073）；移动壳无 pendingSend 链不注入 = 空操作。
 * - notifyNotDelivered：「回复未送达」壳层提示（M1 环 3）——sendPiResponse / sendPluginResponse
 *   未送达（WS 非 OPEN）时由壳层 toast（队列 headless 无 UI，可见反馈归壳层）。定义归壳层
 *   （依赖 i18n 单例 + toast），ui 包只声明注入点。
 */
export interface CompanionDialogAdaptersOptions {
  /** pi 源 dialog 应答终局的壳层收尾回调（桌面注入 clearPendingSend；未注入 = 空操作） */
  onPiResponseSettled?: (sessionId: string) => void
  /** 回传未送达的壳层提示回调（桌面注入 toast；未注入 = 静默，表项保留语义不变） */
  notifyNotDelivered?: (sessionId?: string) => void
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
 * - C4 四键排除：form ∨ askUser ∨ scheduleCreate ∨ planReview 跳过投递（统一表单 overlay /
 *   planReview 审批条由 useExtensionUI 消费——Panel inline 独占；漏排除 = 空壳 dialog 误触
 *   + 双 UI 并存，违反「零重叠」契约）
 * source.onUiRequestExpired：WS plugin:uiRequestExpired（timeout-plugin-service D2 超时撤窗，
 * 不经 bus——bridge 无此归一项）。按 requestId 反查（onUiRequest 流经时记录 requestId→sessionId
 * 映射，投递时归属 sid，MF-4 反查为主）；Map miss 时 payload 可选 sessionId 兜底（壳重启）。
 * 查不到（弹窗已 respond 关闭 / 从未投递 / 广播迟到于出队）→ noop 幂等（V4b miss 语义：
 * 广播无条件发出，miss 是正常时序）。
 *
 * transport（回传双通道，返回 boolean = WS 送达与否）：
 * - sendPiResponse：复用 sendExtensionUIResponse（extension.ui_response，method 透传，
 *   runtime 按 method 构建 pi 响应格式，AC9）；应答终局无条件调 onPiResponseSettled
 *   （通路级收尾锚点，清在 delivered 判定之前——ADR-0073 D4a）
 * - sendPluginResponse：发 plugin.uiResponse（runtime UiRequestQueue.handleResponse 消费，AC6）
 * - 未送达（false）：表项保留（DialogRequestQueue.respond 见 false 不出队，连接恢复后同
 *   requestId 重发幂等——M1/RD-3#1）+ notifyNotDelivered 壳层提示
 * - [G1] 双通道送达即删反查表项——删除后迟到的撤窗广播按 miss noop 语义跳过，
 *   不误触已达应答 dialog
 */
// ── [G1] requestId→sessionId 反查表（模块级共享；dialog 撤窗/应答路由）────────

// taste:allow-no-data-owner（ADR-0049 全局 sid 协调器/订阅注册基建已登记）：requestId→sessionId
// 反查表，非 GUI 数据。模块级共享（G1 共管不变量）：dialog 消费方不唯一——CompanionBand
// （factory source 投递）与 btw 面板（useBtwTabData 经 createUiResponseTransport 独立回传）
// 各自 respond 都必须删同一张表项，否则 respond 路径的 G1 补删对跨消费方请求失效
// （pi 源 dialog 无撤窗广播，残留即泄漏）。测试隔离经 __testing.resetRequestIdSessionsForTest。
const requestIdSessions = new Map<string, string>()

/**
 * 创建独立回传双通道（不绑定 factory source；btw 面板等自管请求簿记的消费方使用）。
 * 与 createCompanionDialogAdapters 的 transport 同一实现、共管同一张模块级反查表——
 * 语义（C4 之外的回传面完全一致）：见 transport 通道注释（factory JSDoc「transport」节）。
 */
export function createUiResponseTransport(options: CompanionDialogAdaptersOptions = {}): UiResponseTransport {
  return {
    sendPiResponse(sessionId, requestId, method, result) {
      // 通路级收尾锚点：应答终局无条件清（cancel / 提交 / 断连三型统一；恒清不吞 turn 信号
      // ——若某源提交后真有 turn，message_start 照常驱动 isGenerating；clearPendingSend 幂等）。
      // 清在 delivered 判定之前：断连期 turn 同样不可达，不清则该形态仍走 30s 兜底
      // （「意图先于送达」的两通路相位分叉登记见 ADR-0073；已知失真与重审条件见 ADR-0072 收口）。
      options.onPiResponseSettled?.(sessionId)
      const delivered = sendExtensionUIResponse(sessionId, requestId, toInteractMethod(method), result)
      if (!delivered) {
        // 未送达：表项保留（请求仍在队列，撤窗反查仍需可用）+ 壳层提示（队列 headless 无 UI）
        options.notifyNotDelivered?.(sessionId)
        return false
      }
      requestIdSessions.delete(requestId)
      return true
    },
    sendPluginResponse(requestId, result) {
      const delivered = send({ type: 'plugin.uiResponse', payload: { requestId, result } })
      if (!delivered) {
        options.notifyNotDelivered?.()
        return false
      }
      requestIdSessions.delete(requestId)
      return true
    },
  }
}

export function createCompanionDialogAdapters(
  bus: InternalEventBus,
  options: CompanionDialogAdaptersOptions = {},
): CompanionDialogAdapters {
  const source: DialogRequestSource = {
    onUiRequest(handler) {
      return bus.on('ui-request', (e) => {
        if (!e.sessionId) {
          console.warn('[dialog-adapters] ui-request 事件缺少 sessionId，跳过投递:', e.request.requestId)
          return
        }
        // C4：统一表单 overlay 类由 useExtensionUI 消费（Panel inline 挂 FormOverlay），本侧
        // 对称排除（窗口键集合 = form ∨ askUser ∨ scheduleCreate——本侧消费 bus 原始帧，
        // legacy 帧无 form 键，归一只发生在 useExtensionUI handler 内；窗口末 legacy 键删）——
        // 漏排除则同一请求被转成空壳 select dialog 入队（用户误点 = respond null = 误触取消）
        // 并与 overlay 双 UI 并存，违反双消费方「零重叠」契约。
        if (e.request.form === true || e.request.askUser === true || e.request.scheduleCreate === true) return
        // C4（plan 模式重设计 D5；u-plan-bar 起宿主收敛）：planReview 审批请求由 PlanModeBar
        // 行内右区的 PlanReviewBar 消费（useExtensionUI planReviewFilter 实例入 store 枚举 +
        // respond 回传，常驻订阅宿主 = PlanModeBar）——不落 CompanionBand 原始 dialog 渲染
        // marker 控制符 title。
        if (e.request.planReview === true) return
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

  const transport = createUiResponseTransport(options)

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
