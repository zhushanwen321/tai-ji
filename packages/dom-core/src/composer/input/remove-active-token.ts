/**
 * 活跃触发域 token 文本定位删除助手（search-modal-popover-mutual-exclusion 设计 D2b）。
 *
 * 定位：SM（SearchModal）confirm 注入 chip 前的残留清理——五符号触发域（$/#/@//skill）
 * 的活跃 token（「符号 + query」明文）经**带域约束正则的全文定位**删除。与 clear 家族
 * （contenteditable.ts，光标锚定——只匹配 anchorNode 光标前文本尾部）刻意不同构：
 * 本助手不依赖光标（SM 夺焦场景选区不在 composer，光标锚定式会静默 no-op，设计 D2b
 * 四轮收敛的教训），禁止 import / 复用 clear 家族的选区前置。
 *
 * 两条硬规则（设计 D2b 终态机制 2）：
 * - 域约束拼正则：slash `(?:^|\n)\/` 行首 vs skill `[^\S\n]\/` 行中空白后——同符号异
 *   约束，禁止无域约束的「符号+文本」拼接搜索（跨域串扰）。域约束源与 input-dom.ts
 *   detect 家族（detectSlashTriggerFromEl / detectSkillTriggerFromEl / 三符号 detect）
 *   同源对齐，两侧修改须同步。
 * - 非唯一命中（含 0 命中）no-op 跳过：无法消歧位置时不动 DOM（误删失活历史 token
 *   = 复发垃圾参数 + 改写用户草稿，双输；跳过使低频形态退归残留代价面）。
 *
 * 实现契约（设计 D2b 影响面审补强）：
 * - 删除后必须调 onChanged 通知（clear* 家族先例——DOM 删除不通知会使 draft ref 与
 *   DOM 脱钩）；
 * - 匹配域 = 单一 text node 内文本：token 被 chip 分裂（`/co<chip>mmand`）时跨 node
 *   不拼合，自然 0 命中跳过（安全方向）；chip 子树（slash-chip/mention-chip）内文本
 *   不在匹配域（chip label 的 `/xx` 文本是结构化 segment，非明文 token）。
 * - 空 query（纯触发符 `/`）：转义后为空串，正则退化为纯域约束形（行首 `/`），唯一
 *   命中即删——token 就是触发符本身，注入 chip 替代它。
 *
 * 零依赖：纯浏览器 DOM API（TreeWalker/Range/Selection），零 import。
 */

/** 活跃触发域类型（五符号域；字符串值与 renderer CommandPopoverType 对齐，本包不依赖 renderer 类型） */
export type ActiveTokenDomainType = 'slash' | 'file' | 'session' | 'subagent' | 'skill'

/**
 * 五域约束正则源（前缀形态，尾部不含 query）。
 *
 * 与 input-dom.ts detect 家族同源（slash=`(?:^|\n)\/`、skill=`[^\S\n]\/`，其余三符号
 * `(?:^|\s)` 前缀族）——行首 vs 行中空白后两 `/` 域互斥语义由前缀承载。约束：
 * 必须为非捕获形态（不得自带捕获组——本助手外包捕获组后 m[1] 用于定位符号起点）；
 * 尾部符号恒单字符（$/#/@// 均是），符号起点 = m.index + m[1].length - 1 依赖此约束。
 */
export const ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES: Readonly<Record<ActiveTokenDomainType, string>> = {
  /** 行首 /（命令域）：光标所在 node 首或 \n 后——对齐 detectSlashTriggerFromEl */
  slash: '(?:^|\\n)\\/',
  /** 行首或空白后 $（文件域）——对齐 detectFileDollarTriggerFromEl */
  file: '(?:^|\\s)\\$',
  /** 行首或空白后 #（session 域）——对齐 detectHashTriggerFromEl */
  session: '(?:^|\\s)#',
  /** 行首或空白后 @（subagent 域）——对齐 detectSubagentTriggerFromEl */
  subagent: '(?:^|\\s)@',
  /** 行中非换行空白后 /（skill 域，与行首命令域正则互斥）——对齐 detectSkillTriggerFromEl */
  skill: '[^\\S\\n]\\/',
}

/** 正则元字符转义惯用法（query 是用户输入文本，动态拼入正则前必须转义，防语义漂移误匹配） */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface RemoveActiveTokenTextOptions {
  /** contenteditable 根元素；null 直接 no-op */
  el: HTMLElement | null
  /** 域约束正则源（ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES 成员；非捕获形态） */
  domainPatternSource: string
  /** 活跃域 query 当前值（文本内容锚，非位置锚）；空串 = 纯触发符形态 */
  query: string
  /** 删除成功后的同步通知（emitInput/onInput 语义——DOM 删除必须通知 draft ref） */
  onChanged: () => void
}

/**
 * 全文定位删除活跃域 token（非光标锚定）。
 *
 * 行为：query 转义后与域约束拼正则（外包捕获组 + 右边界 `(?!\S)`——query 后须跟
 * 空白或串尾，与 detect 家族 `(\S*)$` 的「query 取到空白前」语义对齐），在 el 的全部
 * text node（chip 子树除外）内逐 node 匹配；全 el 恰一处完整命中 → 删除「符号+query」
 * 段（域前缀的边界空白保留，对齐 clear 家族 boundaryLen 语义）→ 光标落删除点 → 调
 * onChanged → 返回 true。0 命中或非唯一命中 → 不动 DOM、不调 onChanged，返回 false。
 */
export function removeActiveTokenText(opts: RemoveActiveTokenTextOptions): boolean {
  const { el, domainPatternSource, query, onChanged } = opts
  if (!el) return false
  const pattern = new RegExp(`(${domainPatternSource})${escapeRegExp(query)}(?!\\S)`, 'g')
  // chip 子树文本（chip-label 的 /xx 等）不在匹配域：slash-chip/mention-chip 覆盖全部
  // chip 类型（file/session/subagent 走 mention-chip、image 走 mention-file、× 按钮在 chip 内）
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node as Text).parentElement?.closest('.slash-chip, .mention-chip')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  })
  const hits: { node: Text; start: number; end: number }[] = []
  let current = walker.nextNode()
  while (current) {
    const text = current.textContent ?? ''
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(text)) !== null) {
      // 符号起点 = 命中前缀内边界之后（m[1] 尾部 1 字符 = 符号，其余 = 边界空白，保留）
      hits.push({
        node: current as Text,
        start: m.index + m[1].length - 1,
        end: m.index + m[0].length,
      })
    }
    current = walker.nextNode()
  }
  // 唯一性判定域 = 全 el 的 text node 累计命中数（两行同文可能跨两个 node，须全局计数）
  if (hits.length !== 1) return false
  const hit = hits[0]
  const range = document.createRange()
  range.setStart(hit.node, hit.start)
  range.setEnd(hit.node, hit.end)
  range.deleteContents()
  // 光标落删除点（对齐 clear 家族删除后的选区产出；定位本身不依赖进入时的光标——
  // 非光标锚定），后续插入链的活选区优先进而 chip 落 token 原位
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  onChanged()
  return true
}
