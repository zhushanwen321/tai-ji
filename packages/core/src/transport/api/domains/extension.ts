/**
 * Extension 域 —— 订阅（onExtensions）+ 动作（toggle）+ 安装多步流 + UI 交互。
 *
 * widget/status 订阅不在本域——SideDrawer 直接经 useSessionEvents.onMessage 消费
 * extension:widget / extension:widgetGui / extension:status（features 层 session 通道）。
 *
 * 安装多步流（D-4 内联候选选择）：
 * - npm：install(source) → runtime 直接装，config.extensions 推回 → onExtensions 刷新（单步）
 * - dir/git：installDir/installGit → runtime 发现候选回 extension.discovered → UI 内联展开
 *   → finishInstall(selected) → config.extensions 推回 → onExtensions 刷新（多步）
 * - cancelInstall(tempDir) → 清理临时目录（放弃安装）
 *
 * 依赖方向：events（订阅）+ command（类型化请求/动作原语）+ ws-client.send（extension.ui_response
 * fire-and-forget；tc u2 迁移时自壳 ../transport 改锚——transport.send 是 ws-client.send 纯透传，
 * domains 子目录深一层故为 ../../ws-client）。
 */
import type {
  ExtensionInfo,
  ExtensionDiscoveredPayload,
  ExtensionInteractMethod,
  RecommendedExtension,
} from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'
import { send } from '../../ws-client'
import * as events from '../events'

export function onExtensions(handler: (extensions: ExtensionInfo[]) => void): () => void {
  return events.onGlobalType('config.extensions', (msg) => {
    handler(msg.payload.extensions)
  })
}

/**
 * 切换扩展启用/禁用。runtime reply 携带 scanExtensions() 的最新列表（{ extensions }）——
 * 前端用它刷新 store（RPC reply 命中 pending 被 routeInbound 吞掉、不触发 onExtensions
 * 全局订阅，故需显式消费 reply 而非依赖广播）。
 */
export function toggle(name: string, enabled: boolean): Promise<{ extensions: ExtensionInfo[] }> {
  return command('extension.toggle', { name, enabled }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** npm 包名直装（单步：runtime 装完推 config.extensions，onExtensions 刷新） */
export function install(source: string): Promise<void> {
  return command('extension.install', { source }, RPC_BACKSTOP_TIMEOUT_MS)
}

export function uninstall(name: string): Promise<void> {
  return command('extension.uninstall', { name }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 本地目录安装（多步第一步）：runtime 复制到 tempDir + 发现候选，回 extension.discovered */
export function installDir(path: string): Promise<ExtensionDiscoveredPayload> {
  return command('extension.installDir', { path }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** Git URL 安装（多步第一步）：runtime clone 到 tempDir + 发现候选，回 extension.discovered */
export function installGitRepository(url: string): Promise<ExtensionDiscoveredPayload> {
  return command('extension.installGit', { url }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 完成安装（多步第二步）：把选中候选从 tempDir 复制到 extensions/，runtime 推 config.extensions */
export function finishInstall(tempDir: string, selected: string[]): Promise<void> {
  return command('extension.finishInstall', { tempDir, selected }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 放弃安装：清理 tempDir（回 extension.installCancelled） */
export function cancelInstall(tempDir: string): Promise<void> {
  return command('extension.cancelInstall', { tempDir }, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 拉取推荐扩展列表（含已安装状态）。
 * 数据源：runtime getRecommendedExtensions()（SSOT = recommended-extensions.json）。
 * 前端 Settings · ExtensionPage 的「推荐扩展」快捷按钮区据此渲染。
 *
 * runtime reply payload 形如 { recommended: Array<...> }（protocol ServerMessageMapBase
 * 定义，与 config.extensions 同形的包裹模式）。pending.resolve 回灌整个 payload，
 * 故需在此解包 .recommended 字段返回数组。
 */
export async function fetchRecommended(): Promise<Array<RecommendedExtension & { installed: boolean }>> {
  const reply = await command('extension.recommended', {}, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.recommended
}

/**
 * 主动重拉扩展列表（重连补发，设计文档 A4 §3.4）。
 *
 * runtime extension.list → scanExtensions() → 回 config.extensions（带 id）。
 * reply 因 msg.id 命中 pending 被 resolve（routeInbound），同时 dispatchGlobal
 * 触发 onExtensions 订阅回调刷新 store。
 *
 * 场景：WS 重连后 sendInitialState 的 extensions 异步段可能早于订阅建立/断连完成
 * 而丢失（broker.ts async fire-and-forget），此处主动补拉确保扩展列表新鲜。
 */
export async function scan(): Promise<void> {
  await command('extension.list', {}, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 升级指定扩展：从 npm 拉取最新版本并重装。
 * 仅对 user-installed（npm 来源）扩展有效。
 * runtime 执行 npm install <pkg>@latest → 替换旧版 → 推 config.extensions 刷新。
 */
export function upgrade(name: string): Promise<void> {
  return command('extension.upgrade', { name }, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 设置扩展的自动升级开关。
 * runtime 将 autoUpgrade 状态持久化到 extension-settings，启动时批量检查并升级。
 */
export function setAutoUpgrade(name: string, enabled: boolean): Promise<void> {
  return command('extension.setAutoUpgrade', { name, autoUpgrade: enabled }, RPC_BACKSTOP_TIMEOUT_MS)
}

// ── Extension UI 交互（confirm/select/input/notify/editor）──────────

/** extension.ui_request 的 payload 结构（event-adapter 翻译 pi extension_ui_request） */
export interface ExtensionUIRequest {
  sessionId: string
  requestId: string
  method: ExtensionInteractMethod
  title?: string
  message?: string
  options?: string[]
  default?: string
  level?: 'info' | 'warn' | 'error'
  prefill?: string
  // ask-user 富交互扩展（仅 method='select' + askUser=true 时存在）
  askUser?: boolean
  askUserQuestions?: unknown[]  // AskUserQuestion[]，前端用类型守卫收窄
  allowCancel?: boolean
  // schedule 创建确认富交互扩展（仅 method='select' + scheduleCreate=true 时存在，
  // runtime event-adapter 第 4 marker 分支翻译 SCHEDULE_CREATE_MARKER select）
  scheduleCreate?: boolean
  scheduleDraft?: unknown  // ScheduleDraft（@zhushanwen/extension-protocol），前端守卫收窄
  // 统一提问表单扩展（仅 method='select' + form=true 时存在；ui-presentation-protocol D1：
  // runtime event-adapter 翻译 UI_FORM_MARKER select，前端 FormOverlay 渲染类型化问题集）
  form?: true
  formQuestions?: unknown[]  // FormQuestion[]（@zhushanwen/extension-protocol），前端守卫收窄
  /** 请求入队时刻（ms，由 useExtensionUI 在 push 时打戳）。用于倒计时基准 */
  receivedAt?: number
}

/**
 * 订阅指定 session 的 extension.ui_request 推送，返回取消函数。
 * pi extension 调 ctx.ui.select/confirm/input 时，runtime 推 extension.ui_request。
 */
export function onUIRequest(sessionId: string, handler: (req: ExtensionUIRequest) => void): () => void {
  return events.on(sessionId, (msg) => {
    if (msg.type !== 'extension.ui_request') return
    const payload = msg.payload as ExtensionUIRequest
    if (payload.sessionId !== sessionId) return
    handler(payload)
  })
}

/**
 * 订阅指定 session 的 extension.notify 推送，返回取消函数。
 *
 * pi notify 是 fire-and-forget（不等回复），runtime 翻译为 extension.notify WS 帧。
 * 前端渲染为 toast 通知（非阻塞），不走 dialog 模态对话框。
 */
export function onNotify(sessionId: string, handler: (payload: { message: string; level: 'info' | 'warn' | 'error' }) => void): () => void {
  return events.on(sessionId, (msg) => {
    if (msg.type !== 'extension:notify') return
    const payload = msg.payload as { sessionId: string; message: string; level: 'info' | 'warn' | 'error' }
    if (payload.sessionId !== sessionId) return
    handler({ message: payload.message, level: payload.level })
  })
}

/**
 * 发送用户对 extension.ui_request 的回复。
 * runtime extension-message-handler 收到此消息 → 按 method 转换为 pi 协议格式
 * （confirm→{confirmed}, select/input/editor→{value}, 取消→{cancelled:true}）
 * → 注入回 pi stdin → pi 的 select/confirm/input Promise resolve。
 *
 * method 必须透传：runtime 按 method 构建正确的 pi response 格式（pi 鸭子类型字段检测，
 * 发错字段静默返回默认值）。
 */
export function sendExtensionUIResponse(sessionId: string, requestId: string, method: ExtensionInteractMethod, result: boolean | string | null): void {
  send({
    type: 'extension.ui_response',
    payload: { sessionId, requestId, method, result },
  })
}

/**
 * 拉取指定 session 的 pending UI 请求（切换 session 后重新订阅时调用）。
 * runtime 返回 session 级只读快照（非破坏，多次拉取幂等，与 session.commands 快照语义同构）；
 * respond 后 runtime 侧 removePendingRequest 收缩快照。前端按 requestId 去重，
 * 因实时 extension.ui_request 帧可能已入队同一请求（详见 useExtensionUI push 处 dedup）。
 */
export async function getPendingRequests(sessionId: string): Promise<ExtensionUIRequest[]> {
  const reply = await command('extension.getPendingRequests', { sessionId }, RPC_BACKSTOP_TIMEOUT_MS)
  // reply.requests 是 unknown[]（runtime PendingUIRequest 未下沉 shared），用类型守卫收窄为 ExtensionUIRequest
  return reply.requests.filter((r): r is ExtensionUIRequest =>
    r != null && typeof r === 'object' &&
    typeof (r as Record<string, unknown>).requestId === 'string' &&
    typeof (r as Record<string, unknown>).method === 'string')
}
