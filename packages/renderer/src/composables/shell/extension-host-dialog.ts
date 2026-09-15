/**
 * extension-host-dialog.ts —— CompanionBand 适配层（FR2/FR7，AC2/AC6/AC9）。
 *
 * 把 core MessageBusBridge 归一后的 bus ui-request 事件 + runtime WS 通道
 * 适配成 ui 包契约（DialogRequestSource / UiResponseTransport，companion-band-source.ts），
 * 由 initExtensionHostBridge provide 注入，CompanionBand 消费。
 *
 * 数据流：bus 'ui-request'（plugin:uiRequest + extension.ui_request 双源归一）
 * → createDialogRequestSource.onUiRequest（无 sid 跳过 / askUser 过滤 C4 分流）
 * → convertToDialogRequest → DialogRequestQueue → CompanionBand 渲染
 * → 用户操作 → queue.respond → transport 回传（pi → extension.ui_response / plugin → plugin.uiResponse）。
 *
 * 超时撤窗：WS plugin:uiRequestExpired（plugin 源 dialog 到期取消，D2）经
 * onUiRequestExpired → requestId 反查 sessionId → queue 按 requestId 出队（不发回传）。
 *
 * [G1 / 2026-09-14 内存审计 §3.4] requestIdSessions respond 路径补删：反查表此前唯一删除点
 * 是 plugin:uiRequestExpired 撤窗广播（plugin 源独有）——pi 源 dialog 的有效清理路径只有
 * respond，而 extension.ui_timeout 是死链（registerTimeout 已不排定时器，§2.1），条目按弹窗数
 * 只增不减。表提升为模块级共享（source 投递写入 / transport respond 删除两工厂共管），
 * respond（sendPiResponse + sendPluginResponse 双通道）即删。
 *
 * 分流契约（feature clarify C2/C4）：askUser 请求由 useExtensionUI 消费（Panel inline 独占），
 * 本适配层只投递非 askUser（CompanionBand 独占 dialog）；两者在数据源层分流，零重叠。
 */
import type { InternalEvent, InternalEventBus } from '@xyz-agent/core'
import type {
  DialogRequest,
  DialogRequestOption,
  DialogRequestSource,
  UiResponseTransport,
} from '@xyz-agent/ui/extension-host'
import type { ExtensionInteractMethod } from '@xyz-agent/shared'
import { onCrossSession, onGlobal } from '@xyz-agent/core/transport/api'
import { send } from '@xyz-agent/core/transport/ws-client'
import { sendExtensionUIResponse } from '@xyz-agent/core/transport/api/domains/extension'

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

// ── requestId → sessionId 反查表（撤窗广播无 sid，靠投递流补齐；条目量级=弹窗数）──
// [G1] 模块级共享：createDialogRequestSource（投递写入）与 createUiResponseTransport
// （respond 删除）是两个独立工厂、壳层（useExtensionHostBridge）各自 provide——表在模块级
// 才能让 respond 路径删条目。生产每进程单 source + 单 transport（initExtensionHostBridge
// 一次性 provide）；测试经 __resetDialogRequestIdSessionsForTest 隔离。
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：requestId→sessionId 反查表（dialog 撤窗/应答路由），非 GUI 数据
const requestIdSessions = new Map<string, string>()

/**
 * 创建 DialogRequestSource（bus 'ui-request' + WS extension.ui_timeout / plugin:uiRequestExpired 适配）：
 * - onUiRequest：无 sessionId 跳过 + console.warn（C2，防 '' 分区脏数据）；
 *   askUser === true 跳过投递（C4 分流，CompanionBand 独占 dialog）
 * - onUiTimeout：WS extension.ui_timeout（C3 保留 WS 路径，不经 bus），事件自带 sessionId
 * - onUiRequestExpired：WS plugin:uiRequestExpired（timeout-plugin-service D2 超时撤窗，
 *   不经 bus——bridge 无此归一项）。按 requestId 反查（onUiRequest 流经时记录 requestId→sessionId
 *   映射，投递时归属 sid，MF-4 反查为主）；Map miss 时 payload 可选 sessionId 兜底（renderer 重启）。
 *   查不到（弹窗已 respond 关闭 /
 *   从未投递 / 广播迟到于出队）→ noop 幂等（V4b miss 语义：广播无条件发出，miss 是正常时序）。
 */
export function createDialogRequestSource(bus: InternalEventBus): DialogRequestSource {
  return {
    onUiRequest(handler) {
      return bus.on('ui-request', (e) => {
        if (!e.sessionId) {
          console.warn('[dialog-adapters] ui-request 事件缺少 sessionId，跳过投递:', e.request.requestId)
          return
        }
        if (e.request.askUser === true) return // C4：askUser 由 useExtensionUI 消费（Panel inline）
        // D2 撤窗反查表：同一 requestId 重复投递（实时帧 + 快照双源）幂等覆盖
        requestIdSessions.set(e.request.requestId, e.sessionId)
        handler(convertToDialogRequest(e))
      })
    },
    onUiTimeout(handler) {
      // MF-6：extension.ui_timeout 广播 payload 带 sessionId，route-inbound 落 session 通道 +
      // crossSession 声明条目（crossSession 通道），onGlobal 收不到带 sid 消息——必须订阅
      // crossSession 通道（onUiTimeout 自身按 payload.sessionId 校验，双保险）。
      return onCrossSession((msg) => {
        if (msg.type !== 'extension.ui_timeout') return
        const payload = msg.payload as { sessionId?: unknown; requestId?: unknown }
        if (typeof payload.sessionId !== 'string' || typeof payload.requestId !== 'string') return
        handler({ sessionId: payload.sessionId, requestId: payload.requestId })
      })
    },
    onUiRequestExpired(handler) {
      return onGlobal((msg) => {
        if (msg.type !== 'plugin:uiRequestExpired') return
        const payload = msg.payload as { requestId?: unknown; sessionId?: unknown }
        if (typeof payload.requestId !== 'string') return
        // MF-4：requestId 反查（onUiRequest 投递时记录的权威归属 sid）为主——payload.sessionId
        // 是撤窗时点的活跃 sid（S1 修复引入），投递后切换 session 会路由错分区；payload sid
        // 降为 Map miss 兜底（renderer 重启 / 旧版 runtime 未记录条目）
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
}

/** method 收窄到 ExtensionInteractMethod（askUser 请求已被 C4 过滤，不会到达回传通道） */
function toInteractMethod(method: string): ExtensionInteractMethod {
  return method === 'confirm' || method === 'select' || method === 'input' || method === 'editor'
    ? method
    : 'input' // 兜底对齐 core parseUiRequest 的 kind 兜底语义
}

/**
 * 创建 UiResponseTransport（回传双通道）：
 * - sendPiResponse：复用 sendExtensionUIResponse（extension.ui_response，method 透传，
 *   runtime 按 method 构建 pi 响应格式，AC9）
 * - sendPluginResponse：发 plugin.uiResponse（runtime UiRequestQueue.handleResponse 消费，AC6）
 * - [G1] 双通道 respond 即删 requestIdSessions 表项（本函数与 createDialogRequestSource
 *   共管模块级反查表）——删除后迟到的撤窗广播按 miss noop 语义跳过，不误触已达应答 dialog。
 */
export function createUiResponseTransport(): UiResponseTransport {
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

// ── 实施期内存探针（memory-leak-remediation 验收门；A 系列验收后降级/移除，非业务 API）──
// G1 respond 删除路径的机器可断言信号源：单测经 before/after delta 断言表项归零。

/** requestIdSessions 表项数（G1 respond 删除路径探针） */
export function _probeDialogRequestIdSessionsSize(): number {
  return requestIdSessions.size
}

/** 测试隔离：清空模块级反查表（beforeEach 调，防跨用例泄漏） */
export function __resetDialogRequestIdSessionsForTest(): void {
  requestIdSessions.clear()
}
