/**
 * composer-injection store —— drawer 选区/文件引用注入 composer 的「一次性消息通道」。
 *
 * ## 背景
 * drawer 内容组件（DetailPane/DiffView/GitPanel）与 Composer 跨组件树，拿不到
 * ComposerInput 的 inputRef。注入必须走 store 一次性消息通道（项目已验证的跨树注入
 * 范式：commandStore.pendingSlash → useCommandPopoverTrigger watch 消费）。
 *
 * 本 store 与 commandStore.pendingSlash 平行：pendingSlash 专管 slash chip（SearchModal），
 * pendingInjection 管 file chip（drawer 选区/文件引用）。职责隔离，不混入 commandStore。
 *
 * ## 设计（一次性消息通道，同 pendingSlash 模式）
 * 写入方（DetailPane/DiffView/GitPanel）→ requestInjection(payload)
 * 消费方（Composer 经 useComposerInjection）→ watch pendingInjection → 按 target/sessionId
 * 过滤 → insertFileChip → clearInjection。null 表示无待消费请求。
 *
 * ## target 路由（FR-2.1）
 * - `current`：注入到 sessionId 匹配的当前 session composer
 * - `new`：先触发 useNewTaskFlow.startFlow 进 landing，再注入到 landing composer。
 *   landing composer 的 sessionId 可能为 null（W3 移除公共 session 后），
 *   故 target=new 的匹配不依赖 sessionId=null，改用 Composer variant=landing 判定
 *   （见 useComposerInjection）。store 只做传输 + routeToLanding 改写。
 *
 * ## payload schema（FR-2/FR-8 + Phase 4 联动 1 + 四符号体系 §3.3.4 sidebar 直引）
 * - path + lineStart/lineEnd：file chip 注入（DetailPane/DiffView 选区/文件引用）
 * - text：纯文本注入（Phase 4 联动 1：TerminalView 选区「发给 AI」）
 * - refSessionId + label：session chip 注入（四符号体系 §3.3.4 sidebar SessionItem「引用到输入区」）
 * path / text / refSessionId 三互斥：有 refSessionId 走 insertSessionChip，有 path 走
 * insertFileChip，有 text 走 insertTextAtCursor（消费端 useComposerInjection 判断）。
 * 互斥在 requestInjection 归一化强制（refSessionId 存在时丢弃 path/text/行范围）。
 * 注：设计文档 §3.3.4 原文扩展字段名为 sessionId，但 InjectionRequest.sessionId 已被
 * 「注入目标路由」语义（current 时具体目标 id / new 时强制 null）占用——sidebar 直引场景
 * 目标 session 与被引用 session 是两个独立 id，不能同名，故被引用方命名 refSessionId。
 *
 * [W3 迁移] 迁自 renderer stores/composer-injection.ts。改为 createComposerInjectionStore()
 * factory 范式（对齐 chat store w4 的 createChatStore factory）：不调 defineStore（store id
 * 绑定是 shell 关切，由壳层 pinia setup 决定），core 只提供状态 + 方法，零 pinia 依赖。
 * 逻辑 byte-level 保持（requestInjection 写入 / clearInjection 清 null / routeToLanding 改写）。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'

/** 注入目标 */
export type InjectionTarget = 'current' | 'new'

/**
 * 一次性注入请求 payload（消费侧读）。
 * path / text / refSessionId 三互斥：有 refSessionId 走 session chip，有 path 走 file chip，
 * 有 text 走纯文本插入。
 */
export interface PendingInjection {
  target: InjectionTarget
  /** file chip 路径（与 text/refSessionId 互斥）。有 path 走 insertFileChip。 */
  path?: string
  lineStart?: number
  lineEnd?: number
  /** 纯文本注入（Phase 4 联动 1：TerminalView 选区「发给 AI」）。与 path/refSessionId 互斥，有 text 走 insertTextAtCursor。 */
  text?: string
  /**
   * 被引用 session id（四符号体系 §3.3.4 sidebar 直引：sidebar SessionItem「引用到输入区」）。
   * 与 path/text 互斥，存在 = session 注入语义，消费端走 insertSessionChip。
   * 命名说明见文件头（设计原文 sessionId，与既有目标路由 sessionId 同名冲突，改 refSessionId）。
   */
  refSessionId?: string
  /** session chip 显示名（人可读 label，与 refSessionId 配对，非 uuid） */
  label?: string
  /** 过滤用 sessionId：current 时具体 id，new 时强制 null（落地 landing composer） */
  sessionId: string | null
  /** 时间戳：同内容重复注入靠 ts 变化触发 watch 引用变化 */
  ts: number
}

/** 写入侧 payload（不含 ts/sessionId 归一化，内部补） */
export interface InjectionRequest {
  target: InjectionTarget
  /** file chip 路径（与 text/refSessionId 互斥） */
  path?: string
  lineStart?: number
  lineEnd?: number
  /** 纯文本注入（与 path/refSessionId 互斥） */
  text?: string
  /** 被引用 session id（与 path/text 互斥；四符号体系 §3.3.4 sidebar 直引） */
  refSessionId?: string
  /** session chip 显示名（与 refSessionId 配对） */
  label?: string
  /** current 时传具体 sessionId；new 时忽略（强制 null） */
  sessionId?: string | null
}

/**
 * 创建 composer injection store 实例（factory 范式）。
 *
 * shell 层（pinia setup）调用并为 store 绑定 id；core 不持 pinia。
 * 每次调用返回独立实例（pendingInjection ref 独立），便于测试隔离。
 */
export function createComposerInjectionStore() {
  /** 一次性注入请求槽位。null 表示无待消费请求。 */
  const pendingInjection = ref<PendingInjection | null>(null)

  /**
   * 写入注入请求（幂等覆盖：连续调用以最后一次为准）。
   * ts 内部补；target=new 时 sessionId 强制 null（新对话落地 landing composer）。
   * refSessionId 与 path/text 互斥在此归一化强制：refSessionId 存在时丢弃 path/text/行范围
   * （写入侧误传也不产生歧义 payload，消费端只需按 refSessionId → text → path 优先级判断）。
   */
  function requestInjection(payload: InjectionRequest): void {
    const sessionId = payload.target === 'new' ? null : (payload.sessionId ?? null)
    const normalized = payload.refSessionId !== undefined
      ? { path: undefined, lineStart: undefined, lineEnd: undefined, text: undefined }
      : {}
    pendingInjection.value = { ...payload, ...normalized, sessionId, ts: Date.now() }
  }

  /** 消费清除（Composer 消费后立即调用，防重复注入 + 防 watch 残留触发） */
  function clearInjection(): void {
    pendingInjection.value = null
  }

  /**
   * target=new 路由落地：把 target 从 new 改 current，重置 ts 触发 watch。
   *
   * 阶段一（session composer 触发 startFlow 后）调用：标记「已路由到 landing」，
   * landing composer（variant=landing）的 useComposerInjection 看到 target=current
   * + sessionId=null（landing 命中）后注入。
   *
   * 重置 ts：让已挂载的 landing composer 的 watch 也能被触发。onMounted 补检查覆盖
   * 「挂载早于 routeToLanding」时序，watch 覆盖「晚于」时序，互补。
   */
  function routeToLanding(): void {
    const current = pendingInjection.value
    if (!current) return
    pendingInjection.value = { ...current, target: 'current', sessionId: null, ts: Date.now() }
  }

  return { pendingInjection, requestInjection, clearInjection, routeToLanding }
}

/** composer injection store 实例类型（由 factory 返回值推导） */
export type ComposerInjectionStore = ReturnType<typeof createComposerInjectionStore>

/** pendingInjection ref 类型（壳层/测试 watch 消费用） */
export type PendingInjectionRef = Ref<PendingInjection | null>
