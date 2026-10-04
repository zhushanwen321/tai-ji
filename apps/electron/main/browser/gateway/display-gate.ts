/**
 * view 层级共存守卫——显示收口谓词 + 双阈值空间滞回（display-containers §7.4 / §5.1 规则 6）。
 *
 * 背景：WebContentsView 恒渲染在宿主全部 DOM 之上（z-index 不可穿越），错误占位 / 模态 /
 * 横幅等 DOM 表面会被原生 view 盖住不可见。本模块是「view 何时可见」的**单一权威**：
 * show 当且仅当谓词为真（§7.4 show 统一谓词，R3 收口），禁止各触发点独立 show——
 * 否则 shieldsView 相交隐藏期间重开浮层会「show 竞态盖住模态」，守卫要防的形态在恢复通道复现。
 *
 * 谓词（computeShouldShow）= 浮层开 ∧ 内容 browser ∧ 该 session 是浮层发起会话
 *   ∧ 无错误态 ∧ 无相交 shieldsView 面。
 *
 * 双阈值空间滞回（§6.7 R5/R6，施密特触发结构）：
 *   - 进入隐藏 = 存在遮蔽面矩形与 view **原始**矩形相交（真重叠才隐藏）
 *   - 退出隐藏 = 全部遮蔽面矩形与 view **外扩**矩形（外扩 SHIELD_HYSTERESIS_PADDING_PX）
 *     仍完全不相交（含缓冲的明确分离才恢复）
 *   - 缓冲带（外扩相交 ∧ 原始不相交）内两切换条件皆假 → 双向状态保持（不翻转）。
 * 显式不采用 debounce / 时间滞回（AGENTS 时间平抑红线：双阈值空间解已可达成同一目的）。
 *
 * 谓词重算触发面（§7.4 R4 补全）：错误态变化（create 失败 / render-process-gone / did-fail-load
 * / 重试成功导航）+ shieldsView 成员开合或 rect 变化（横幅文案随 level 改宽）+ 浮层开合与内容切换
 * + view rect 推送链事件（resize）。全部由 BrowserViewManager 在对应事件点调 applyDisplay 收敛。
 *
 * 依赖方向：纯函数模块（无 electron 运行时依赖，可独立单测）；由 browser-view-manager 组装。
 */

/** 显示矩形（DIP = CSS px，与 setBounds 同坐标系；不乘 devicePixelRatio） */
export interface DisplayRect { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面
  x: number
  y: number
  width: number
  height: number
}

/**
 * shieldsView 遮蔽面（模态表面聚合 §6.7 的 view 遮蔽族成员，renderer 聚合侧上报）。
 * - fullscreen=true：全屏阻塞面（遮罩盖满视口）→ 无条件隐藏 view
 * - fullscreen=false：非全屏面（Toast / CrashRecoveredBar / memory bar / RollingRestartBanner /
 *   弹出层族）→ 与 view 矩形几何相交才隐藏；rect 缺失按相交保守处理（宁可隐藏 view 也不让
 *   阻塞交互被盖住——上报考勤违约时的 fail-safe 方向）。
 */
export interface ShieldFace { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面
  id: string
  fullscreen: boolean
  rect?: DisplayRect
}

/** 浮层内容种类（core overlay 域同词表） */
export type OverlayContentKind = 'browser' | 'workflow'

/** 浮层开合态（renderer 经 IPC 上报；view 显示收口的事实源之一） */
export interface OverlayDisplayState { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面
  open: boolean
  content: OverlayContentKind | null
  sessionId: string | null
}

/** 关闭态（浮层关闭 / 内容换出 browser 后的归一形态） */
export const CLOSED_OVERLAY: OverlayDisplayState = { open: false, content: null, sessionId: null }

/** 双阈值滞回的外扩像素（§6.7「外扩 N px，实施期定值」——真机校准点 §11-7） */
export const SHIELD_HYSTERESIS_PADDING_PX = 24

/** 矩形相交（边重叠不算相交——严格不等号） */
export function rectsIntersect(a: DisplayRect, b: DisplayRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** 矩形外扩 px（四边各扩 px；宽高 = 原值 + 左右/上下两侧扩展） */
export function expandRect(rect: DisplayRect, px: number): DisplayRect {
  return { x: rect.x - px, y: rect.y - px, width: rect.width + px + px, height: rect.height + px + px }
}

function faceHits(face: ShieldFace, rect: DisplayRect): boolean {
  // fullscreen = 无条件；rect 缺失（上报违约）保守按相交处理
  return face.fullscreen || !face.rect || rectsIntersect(face.rect, rect)
}

/**
 * 双阈值空间滞回的单步转移（施密特触发）。
 *
 * @param prev 上一步的「因 shieldsView 隐藏」状态
 * @param faces 当前打开的遮蔽面集合（空 = 无遮蔽）
 * @param viewRect view 当前显示矩形（原始矩形）
 * @returns 下一步状态：false→true 仅当某面与原始矩形相交；true→false 仅当全部面与外扩矩形仍不相交
 */
export function nextShieldHidden(prev: boolean, faces: readonly ShieldFace[], viewRect: DisplayRect): boolean {
  if (faces.length === 0) return false
  const expanded = expandRect(viewRect, SHIELD_HYSTERESIS_PADDING_PX)
  if (!prev) {
    // 进入隐藏：真重叠才隐藏（原始矩形相交）
    return faces.some((face) => faceHits(face, viewRect))
  }
  // 退出隐藏：含缓冲的明确分离才恢复（外扩矩形仍不相交）。缓冲带内条件皆假 → 保持隐藏。
  return faces.some((face) => faceHits(face, expanded))
}

/** 浮层随行豁免谓词（§5.1 规则 5 / §7.4）：浮层开 ∧ 内容 browser 时 focus 换显动作整体豁免 */
export function isOverlayBrowserActive(overlay: OverlayDisplayState): boolean {
  return overlay.open && overlay.content === 'browser'
}

/**
 * show 统一谓词（§7.4 R3 收口）：view 显示的唯一触发。
 * 三触发恢复动作（重试成功 / shieldsView 全关 / 重开浮层）一律经此求值，禁止各触发独立 show。
 */
export function computeShouldShow(args: {
  overlay: OverlayDisplayState
  sessionId: string
  hasError: boolean
  shieldHidden: boolean
}): boolean {
  return (
    isOverlayBrowserActive(args.overlay) &&
    args.overlay.sessionId === args.sessionId &&
    !args.hasError &&
    !args.shieldHidden
  )
}

// ── IPC payload 解析/校验（error envelope：非法 payload 抛 Error → invoke reject）────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDisplayRect(value: unknown): value is DisplayRect {
  if (!isRecord(value)) return false
  const nums = [value.x, value.y, value.width, value.height]
  return (
    nums.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    (value.width as number) >= 0 &&
    (value.height as number) >= 0
  )
}

/** 解析 'browser:overlay-state' payload。非法 → throw（invoke reject，error envelope 带原因） */
export function parseOverlayDisplayState(payload: unknown): OverlayDisplayState {
  if (!isRecord(payload)) {
    throw new Error('[browser:overlay-state] payload must be an object')
  }
  if (typeof payload.open !== 'boolean') {
    throw new Error('[browser:overlay-state] open must be a boolean')
  }
  if (!payload.open) {
    return { ...CLOSED_OVERLAY }
  }
  if (payload.content !== 'browser' && payload.content !== 'workflow') {
    throw new Error(`[browser:overlay-state] content must be "browser" | "workflow" when open, got ${String(payload.content)}`)
  }
  if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
    throw new Error('[browser:overlay-state] sessionId must be a non-empty string when open')
  }
  return { open: true, content: payload.content, sessionId: payload.sessionId }
}

/** 解析 'browser:shields' payload（{ faces: ShieldFace[] }）。非法 → throw */
export function parseShieldFacesPayload(payload: unknown): ShieldFace[] {
  const raw = isRecord(payload) ? payload.faces : undefined
  if (!Array.isArray(raw)) {
    throw new Error('[browser:shields] payload.faces must be an array')
  }
  return raw.map((face, index) => {
    if (!isRecord(face)) {
      throw new Error(`[browser:shields] faces[${index}] must be an object`)
    }
    if (typeof face.id !== 'string' || face.id.length === 0) {
      throw new Error(`[browser:shields] faces[${index}].id must be a non-empty string`)
    }
    if (typeof face.fullscreen !== 'boolean') {
      throw new Error(`[browser:shields] faces[${index}].fullscreen must be a boolean`)
    }
    if (face.rect !== undefined && !isDisplayRect(face.rect)) {
      throw new Error(`[browser:shields] faces[${index}].rect must be { x, y, width, height } with finite numbers`)
    }
    const parsed: ShieldFace = { id: face.id, fullscreen: face.fullscreen }
    if (face.rect !== undefined) parsed.rect = face.rect as DisplayRect
    return parsed
  })
}
