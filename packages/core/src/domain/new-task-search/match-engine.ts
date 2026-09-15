/**
 * 匹配引擎（#1）—— 纯函数模块，无副作用、无外部依赖。
 *
 * 来源：packages/renderer/src/lib/match-engine.ts（strangler 逐域绞杀下沉，原样迁移）。
 *
 * 两个消费者驱动 DRY（非假设性复用）：
 *  1. SearchModal 模板渲染（segments 产生 <mark> 高亮段）
 *  2. useSearch 编排（matchFilter 前端过滤候选）
 *
 * 接线层级：叶子（纯计算，方法体为算法实现，非 throw）。
 * 可测性：accept 无依赖，return results，surface 小（2 导出）。
 *
 * #1 AC-1.2 grep 验收：本文件不得 import ref/reactive/api/transport（纯函数铁律）。
 */

/** 高亮渲染段（驱动 <mark>，Vue 自动转义无 XSS） */
export interface MatchSegment {
  text: string
  hit: boolean
}

/**
 * 子串命中过滤（useSearch 调用，前端过滤候选）。
 * @param items 全量候选（命令/文件/会话合并后）
 * @param q 查询词（已 trim）
 * @returns 命中项（title 或 sub 子串匹配）；q='' 返回全部（空查询不过滤）
 */
export function matchFilter<T extends { title: string; sub: string }>(
  items: T[],
  q: string,
): T[] {
  if (!q) return items
  const ql = q.toLowerCase()
  return items.filter(
    (it) =>
      it.title.toLowerCase().includes(ql) || it.sub.toLowerCase().includes(ql),
  )
}

/**
 * 文本按查询拆成命中/未命中段（SearchModal 模板调用，驱动 <mark> 高亮）。
 * @param text 待拆分文本
 * @param q 查询词（已 trim）
 * @returns 段数组；q='' 返回单元素 [{text, hit:false}]（空查询不高亮）
 * 边界（#1 AC-1.3）：text='' 返回 [{text:'', hit:false}]。
 */
export function segments(text: string, q: string): MatchSegment[] {
  if (!q) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const ql = q.toLowerCase()
  const out: MatchSegment[] = []
  let i = 0
  while (i < text.length) {
    const at = lower.indexOf(ql, i)
    if (at < 0) {
      out.push({ text: text.slice(i), hit: false })
      break
    }
    if (at > i) out.push({ text: text.slice(i, at), hit: false })
    out.push({ text: text.slice(at, at + ql.length), hit: true })
    i = at + ql.length
  }
  // 边界（#1 AC-1.3）：text=''（循环未执行）→ 单元素 [{text:'', hit:false}]。
  if (out.length === 0) return [{ text: '', hit: false }]
  return out
}
