/**
 * file-match —— composer `#` 文件候选的匹配度分级过滤 + 排序。
 *
 * 来源：packages/renderer/src/lib/file-match.ts（strangler 逐域绞杀下沉，原样迁移）。
 *
 * 背景：此前 file 候选排序继承 runtime sortNodes（dir 在前 + name 字典序降序），
 * 与用户输入的 query 无关。导致 `#agents` 时含 "agents" 子串的目录（subagents）
 * 因字母序排在 AGENTS.md 文件前面——真正的目标被埋没。
 *
 * 本模块按匹配度分级排序（对齐 VSCode Quick Open / fzf 的共识）：
 * 匹配越精确（basename 前缀 > path 子串）+ 文件优先（# 语义是引用文件）+ 路径浅优先。
 *
 * 纯函数，不引入依赖。O(n log n) 排序 + O(n) 过滤，2264 候选实测 <5ms。
 */
import type { FileCandidate } from './file-candidates'

/** 匹配度等级（值越小越优先）。无 query 时统一为 NO_MATCH，走次级排序。 */
const MATCH_EXACT = 0 // basename 完全相等（query === basename）
const MATCH_PREFIX = 1 // basename 前缀匹配（basename 以 query 开头）
const MATCH_BASENAME = 2 // basename 子串匹配（query 在 basename 中间）
const MATCH_PATH = 3 // path 子串匹配（query 在 path 但不在 basename）
const NO_MATCH = 4 // 无 query 或不匹配（无 query 时全部候选用此级，靠次级排序）

/**
 * 计算单个候选对 query 的匹配度等级。
 * @returns 匹配等级（值越小越优），或 null 表示不匹配（应被过滤掉）
 */
function matchLevel(c: FileCandidate, q: string): number | null {
  if (!q) return NO_MATCH // 无 query：不过滤，统一最低级走次级排序
  const base = (c.basename ?? c.name).toLowerCase()
  const path = (c.path ?? '').toLowerCase()
  if (base === q) return MATCH_EXACT
  if (base.startsWith(q)) return MATCH_PREFIX
  if (base.includes(q)) return MATCH_BASENAME
  if (path.includes(q)) return MATCH_PATH
  return null // 不匹配，过滤掉
}

/**
 * 路径深度（path 的段数，浅的优先）。path 未定义视为最深（排最后）。
 * 例：'AGENTS.md' → 1，'src/auth/token.ts' → 3
 */
function pathDepth(c: FileCandidate): number {
  const p = c.path ?? ''
  return p === '' ? Number.MAX_SAFE_INTEGER : p.split('/').filter(Boolean).length
}

/**
 * 过滤 + 排序 file 候选。
 *
 * 排序规则（优先级从高到低）：
 * 1. 匹配度等级（basename 完全相等 > 前缀 > basename 子串 > path 子串）
 * 2. 文件优先于目录（# 语义是引用文件，目录引用少）
 * 3. 路径深度浅优先（离根近 = 更可能用户想要）
 * 4. basename 字母序升序（兜底，保证稳定排序）
 *
 * @param candidates 全量候选（来自 toFileCandidates）
 * @param query 用户输入的过滤词（# 后的内容，已 trim+小写化由调用方或此处处理）
 * @returns 过滤+排序后的候选（新数组，不改原数组）
 */
export function filterAndSortFileCandidates(
  candidates: FileCandidate[],
  query: string,
): FileCandidate[] {
  const q = query.trim().toLowerCase()
  // 过滤 + 标注匹配等级
  const matched = candidates
    .map((c) => ({ c, level: matchLevel(c, q) }))
    .filter((x): x is { c: FileCandidate; level: number } => x.level !== null)

  // 多级排序
  matched.sort((a, b) => {
    // 1. 匹配度等级
    if (a.level !== b.level) return a.level - b.level
    // 2. 文件优先于目录（file=0, dir=1，升序排 file 在前）
    const ta = a.c.type === 'dir' ? 1 : 0
    const tb = b.c.type === 'dir' ? 1 : 0
    if (ta !== tb) return ta - tb
    // 3. 路径深度浅优先
    const da = pathDepth(a.c)
    const db = pathDepth(b.c)
    if (da !== db) return da - db
    // 4. basename 字母序升序
    const na = (a.c.basename ?? a.c.name).toLowerCase()
    const nb = (b.c.basename ?? b.c.name).toLowerCase()
    if (na < nb) return -1
    if (na > nb) return 1
    return 0
  })

  return matched.map((x) => x.c)
}
