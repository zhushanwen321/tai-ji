/**
 * plan 审阅回传值域契约（plan 模式状态机显式化 D3①⑤ / D9③）——纯函数守卫，零依赖。
 *
 * 为什么守卫是契约级承重：TS 判别联合的穷尽性（switch/never 断言）管不到运行时值域——
 * respond 通道透传的是任意字符串 parse 出的 unknown（P-2），值域守卫漏改即「搁置应答被判
 * 垃圾 → bad-response 引导重挂」再入循环（F1 复活路径）。canonical 守卫与判别联合同住
 * 契约包，消费面（extensions/universal/plan tool.ts）接线见同目录 consumers.md。
 *
 * 降级双分源（D3①）——parse 失败必须区分两类，文案语义相反：
 * - `unknown-decision`（对象合法但 decision 不在值域）：宿主/扩展版本不匹配类指引，
 *   **不再引导重挂**（防再入循环，兼覆盖 R2 反方向错配——新 renderer × 旧扩展）。
 * - `malformed`（非对象 / 缺 decision / 形状不合法）：垃圾数据（E5 判据），报错提示重挂。
 *
 * selfReview 有界字段（D9③ / R3）：有界性由**写侧单点截断**保证（截断点 = 扩展 payload
 * 构造处），4KB 上限与 UTF-8 字节界安全截断的唯一权威在本模块；透传层（runtime）不截、
 * 入站守卫不二次截（上限已在写侧达成）。
 */
import type { PlanDocMeta, PlanReviewRequest, PlanReviewResponse } from '../../core/types'

// ── selfReview 有界字段（D9③：写侧 4KB 截断，R3 已接受超限即截）──

/** selfReview 上限：4KB（UTF-8 字节）。超限即截（全文可要求 agent 贴对话流，R3）。 */
export const PLAN_SELF_REVIEW_MAX_BYTES = 4096

function utf8ByteLengthOfCodePoint(cp: number): number {
  if (cp <= 0x7f) return 1
  if (cp <= 0x7ff) return 2
  if (cp <= 0xffff) return 3
  return 4
}

/**
 * selfReview 写侧单点截断：按 UTF-8 字节预算截到**完整码点边界**（多字节字符不截半，
 * 无替换字符噪音）。预算内原样返回；不追加省略号（消费方渲染时自行提示截断）。
 */
export function truncateSelfReview(text: string): string {
  let bytes = 0
  let i = 0
  while (i < text.length) {
    const cp = text.codePointAt(i)
    if (cp === undefined) break
    const size = utf8ByteLengthOfCodePoint(cp)
    if (bytes + size > PLAN_SELF_REVIEW_MAX_BYTES) break
    bytes += size
    i += cp > 0xffff ? 2 : 1
  }
  return text.slice(0, i)
}

// ── 入站 request 帧守卫（PLAN_REVIEW_MARKER select options[0] = PlanReviewRequest JSON）──

function isPlanDocMeta(value: unknown): value is PlanDocMeta {
  if (typeof value !== 'object' || value === null) return false
  const doc = value as Record<string, unknown>
  return (
    typeof doc.fileName === 'string' &&
    typeof doc.absPath === 'string' &&
    typeof doc.sourceSkill === 'string' &&
    typeof doc.version === 'number'
  )
}

/**
 * `PlanReviewRequest` 形状守卫（E5 垃圾数据判据）：
 * docs 必为 `PlanDocMeta[]`（逐项形状）；selfReview 缺省或 string——**optional 是兼容契约**
 * （旧扩展不携带 → 自审行不渲染的降级形态，D9③），值域上限不在此拒绝（写侧截断已界）。
 * 空载荷（undefined/null/非对象/缺 docs）与非法形态（docs 非数组 / 元素形状不合法 /
 * selfReview 非 string）一律 false，不 throw。
 */
export function isPlanReviewRequest(value: unknown): value is PlanReviewRequest {
  if (typeof value !== 'object' || value === null) return false
  const req = value as Record<string, unknown>
  if (!Array.isArray(req.docs) || !req.docs.every(isPlanDocMeta)) return false
  if (req.selfReview !== undefined && typeof req.selfReview !== 'string') return false
  return true
}

// ── 回传值域解析 + error envelope（D3①⑤）──

/**
 * respond 回传解析结果（error envelope 单源）：
 * - ok：归一化后的合法 `PlanReviewResponse`（多余键已剥——approve/dismiss 不携带评论是
 *   结构保证，不信任宿主回传的附加形态）。
 * - `unknown-decision`：decision 是 string 但不在值域 → 版本不匹配类指引（不引导重挂）。
 * - `malformed`：空载荷 / 非对象 / 形状不合法 → E5 判据，报错提示重挂。
 */
export type PlanReviewResponseEnvelope =
  | { ok: true; response: PlanReviewResponse }
  | { ok: false; code: 'unknown-decision'; decision: string }
  | { ok: false; code: 'malformed' }

function normalizeComments(value: unknown): PlanReviewResponse | null {
  if (!Array.isArray(value)) return null
  const comments: Array<{ quote: string; comment: string }> = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null
    const c = item as Record<string, unknown>
    if (typeof c.quote !== 'string' || typeof c.comment !== 'string') return null
    comments.push({ quote: c.quote, comment: c.comment })
  }
  return { decision: 'revise', comments }
}

/**
 * respond 回传解析（值域守卫的判别版）：dismiss 样本必通（D3 主干），未知 decision 值域
 * 落降级枚举而非垃圾（两者文案语义相反，见文件头「降级双分源」）。
 */
export function parsePlanReviewResponse(value: unknown): PlanReviewResponseEnvelope {
  if (typeof value !== 'object' || value === null) return { ok: false, code: 'malformed' }
  const raw = value as Record<string, unknown>
  const decision = raw.decision
  if (typeof decision !== 'string') return { ok: false, code: 'malformed' }
  switch (decision) {
    case 'approve':
      return { ok: true, response: { decision: 'approve' } }
    case 'dismiss':
      return { ok: true, response: { decision: 'dismiss' } }
    case 'revise': {
      const response = normalizeComments(raw.comments)
      return response === null ? { ok: false, code: 'malformed' } : { ok: true, response }
    }
    default:
      // 已知形状、未知值域 = 版本错配信号（R2），不是垃圾——降级文案不引导重挂
      return { ok: false, code: 'unknown-decision', decision }
  }
}

/**
 * `PlanReviewResponse` 值域守卫（含 dismiss 员，D3①）——`parsePlanReviewResponse` 的谓词形。
 * 消费方需要区分 unknown-decision / malformed 两类降级时用 parse 版。
 */
export function isPlanReviewResponse(value: unknown): value is PlanReviewResponse {
  return parsePlanReviewResponse(value).ok
}
