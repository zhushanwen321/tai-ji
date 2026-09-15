/**
 * rebuildSegmentsWithEditedText —— 编辑 user message 后重建 segments（w6 从 renderer lib/utils.ts 迁入）。
 *
 * 编辑框（UserBubble 内联编辑）展示的是归位后的全文（`normalizeContent` 产物，命令在最前），
 * 提交时以「段」为单位重建：非 text 段在编辑稿中的文本足迹**从编辑稿中剥离**（段本身保留），
 * 剥离不到则视为用户已删除/改写该段 → 丢弃该段，以文本形态随 prompt 进入。
 *
 * - slash 段：编辑文本里与 slash 段重复的**前缀命令**先剥离（token 边界：`/compact` 后须是
 *   空白或结尾，避免把 `/compactfoo` 误当命令），命令由 slash 段本身承担——否则序列化归位后
 *   prompt 变成 `/compact /compact 总结`（命令翻倍，MF-2）。
 *   编辑文本里已无该命令（用户删除，或改写为另一个命令）时**丢弃**对应 slash 段。
 * - skill / file / mention / session / handoff 段：其序列化文本（skill 为
 *   `<taiji-skill name=".." location=".."/>` 私有标记、file 为 `path[:L<s>-L<e>]`、mention 为
 *   `@name`、session 为 `#sessionId`、handoff 为 `[handoff from label]`）在编辑稿中找到
 *   （尾部须是空白或结尾，避免把 `@alice` 前缀误配 `@alicex`）即**剥离该处文本并保留段**；
 *   找不到则**丢弃段**（用户改写了名字/路径，或删掉了该段——与 slash 语义一致，
 *   不会出现「旧段序列化 + 新文本并列」的翻倍）。
 *   [轮 3 收口] 此前只处理 slash：其余类型整串随编辑文本回灌首个 text 段、段又原位保留，
 *   序列化后同一标记出现两次（skill ⇒ 注入器逐个展开 ⇒ 同一 SKILL.md 注入两遍）。
 * - image 段：序列化单元是 `\n<path>\n` 的裸路径（`SEGMENT_SERIALIZERS.image`）。剥离按
 *   **裸路径 token 的双侧边界匹配**定位：UserBubble.submitEdit 提交前对草稿 `.trim()` 会
 *   吃掉首尾换行，按序列化串精确匹配时图片位于草稿首行/末行必然匹配失败（首尾 `\n` 已被
 *   trim），在真实链路不可靠。命中后把删除范围**向左右各扩一个紧邻换行**（存在则吃、
 *   不存在则不吃），即剥掉整个序列化单元——只剥裸 token 会把 path 前后的换行留在 text
 *   段内，重建时 image 段再补一遍 `\n<path>\n`，未编辑草稿重发每轮净增换行（无界累积）。
 *   命中 ⇒ 段保留；未命中 ⇒ 用户删掉/改写了该路径，丢弃段（否则重发时旧路径随段
 *   「复活」，prompt 里重新长出用户已删的图片引用）。
 *   前边界必须判（这是与 findDelimitedOccurrence 只判后边界的根本差异）：草稿里
 *   `x/data/a/1.png`（正文里的相对路径片段）、`/data/a/1.png2`（正文数字紧贴路径）与图片
 *   路径前缀同形，只判后边界会把用户正文当图片路径剥掉，造成正文损坏。
 *   `findBarePathOccurrence` 是为此新增的 helper，不改动 findDelimitedOccurrence 的既有
 *   尾边界语义（其余段类型的序列化串自带格式锚点，如 `@alice` 靠自身形态区分 `@alicex`）。
 *   幂等边界：image 居首 / 居末两例由测试不变量 CASES 锁定（未编辑草稿重发 prompt 逐字
 *   等于草稿）；image 居中（`[text('A'), image, text('B')]`）受「首个 text 段承接全部正文、
 *   chip 位置不动」的既有位置近似影响 round0 ≠ 草稿（D6 已登记为接受项），单列用例断言
 *   round1 === round2（收敛、不累积），不入 CASES。
 * - subagent 段：序列化为空串（路由标记不进 prompt），无文本足迹 ⇒ 恒原位保留。
 * - 未知新类型：序列化为空串 ⇒ 恒原位保留（失败方向安全）。
 * - text 段：首个 text 段替换为剥离后的编辑文本，其余 text 段丢弃（其内容已并入编辑稿）；
 *   无 text 段时在段首补一个。
 *
 * 支持的段类型：text / slash / skill / file / mention / session / subagent / image / handoff。
 *
 * 残余面（轮 3-4 登记）：剥离按段序单调游标定位（见函数体），依赖「编辑前草稿 =
 * segmentsToText(source)」。正文段被用户整段改写（原文在编辑稿中找不到）时游标不推进，
 * 此时若用户在改写后的正文里新插入与某 chip 序列化同形的字符串、且位于该 chip 之前，
 * 仍可能剥到正文那一处——该场景无文本级判据可区分（段序推断已失效），接受为残余。
 *
 * 残余面（轮 5 登记）：image 剥离会把紧邻路径的换行一并纳入删除范围（抵消序列化自带的
 * `\n<path>\n` padding）。若用户在路径紧邻处**有意**敲了空行，该空行会随之内移/外移——
 * 换行总数不变、位置近似（实测 `\n\n/data/a/1.png\n\nA` → `\n/data/a/1.png\n\n\nA`），
 * 与 D6 登记的「编辑重发位置近似」同类，接受。
 *
 * 纯函数，仅依赖 @taiji/shared（`Segment` 类型、`normalizeSegmentOrder` 归位、
 * `segmentsToText` 序列化——序列化 SSOT 复用，不在此复制第二份段→文本实现）。
 */
import type { Segment } from '@taiji/shared'
import { normalizeSegmentOrder, segmentsToText } from '@taiji/shared'

/**
 * 在 text 中查找 serialized 的首个「尾部边界合法」出现位置，返回下标；无合法出现返回 -1。
 * 边界合法 = 串尾 / 后继字符是空白 / serialized 自身以空白结尾（换行定界的序列化自成边界）。
 * 非合法出现继续向后找（`@alice` 不应命中 `@alicex` 的前缀）。
 */
function findDelimitedOccurrence(text: string, serialized: string, from: number): number {
  const selfDelimited = /\s$/.test(serialized)
  for (let at = from; at <= text.length; ) {
    const idx = text.indexOf(serialized, at)
    if (idx === -1) return -1
    const next = text[idx + serialized.length]
    if (selfDelimited || next === undefined || /\s/.test(next)) return idx
    at = idx + 1
  }
  return -1
}

/**
 * 在 text 中查找裸路径 token 的首个「双侧边界合法」出现位置，返回下标；无合法出现返回 -1。
 * 合法 = 前边界是串首/空白 且 后边界是串尾/空白。
 *
 * 与 findDelimitedOccurrence（只判后边界）的差异及其必要性：后者匹配的是带格式锚点的
 * 序列化串——`@alice` / `#sid` / `src/a.ts` 自身形态就让前边界无歧义（`@alicex` 靠后空白
 * 排除），故只判后边界足够。image 段的序列化是 `\n<path>\n` 的裸路径，token 本身就是普通
 * 文本片段，前后都可能与正文粘连，必须双侧判定：只判后边界会把 `x/data/a/1.png`
 * （前边界是 `x`）也当图片路径剥掉，用户正文里的相对路径片段被误删。
 * 独立成新 helper 而非给老 helper 加参数，避免影响其余段类型的既有剥离行为。
 */
function findBarePathOccurrence(text: string, path: string, from: number): number {
  for (let at = from; at <= text.length; ) {
    const idx = text.indexOf(path, at)
    if (idx === -1) return -1
    const prev = idx > 0 ? text[idx - 1] : undefined
    const next = text[idx + path.length]
    const frontOk = prev === undefined || /\s/.test(prev)
    const backOk = next === undefined || /\s/.test(next)
    if (frontOk && backOk) return idx
    at = idx + 1
  }
  return -1
}

export function rebuildSegmentsWithEditedText(
  originalSegments: Segment[] | string,
  editedText: string,
): Segment[] {
  const source = Array.isArray(originalSegments) ? originalSegments : []
  let text = editedText
  const retained = new Set<Segment>()
  // 单调游标：text 中已消费到的下标，按段序（归位序 = 草稿文本序）推进。剥离必须按段序
  // 定位，不能恒从 0 找首个合法出现——否则「用户正文里的同形字符串」会被当成 chip 的
  // 序列化文本删掉（RC-A-2，实测 `看看 src/a.ts 吧` + file 段 ⇒ 正文的 src/a.ts 被删、
  // 路径仍出现两次）。依据：编辑前草稿文本就是 segmentsToText(source)，各段序列化形态的
  // 出现顺序与段序一致，故游标单调推进是严格改进。
  let cursor = 0
  // slash 段在归位序下连续居首；首个不匹配即其后 slash 段一并丢弃（文本已自携用户改写的
  // 命令）——等价于逐段 break 的旧语义。
  let slashChainOpen = true

  for (const seg of normalizeSegmentOrder(source)) {
    // 1) 正文段：游标推进到该段原文之后，使其区间内的同形字符串不再被后续 chip 命中。
    //    用户已改写该段（原文在编辑稿中找不到）时不推进——正文与 chip 的相对位置无法再靠
    //    段序推断，退回「找首个合法出现」（与游标引入前同行为，残余面见文件头登记）。
    if (seg.type === 'text') {
      if (seg.text) {
        const at = text.indexOf(seg.text, cursor)
        if (at !== -1) cursor = at + seg.text.length
      }
      continue
    }
    // 2) slash 段：剥离与段重复的前缀命令。命令名匹配要求 token 边界（`/compact` 后是
    //    空白或结尾），避免把 `/compactfoo` 误当命令。
    if (seg.type === 'slash') {
      if (!slashChainOpen) continue
      const prefix = `/${seg.name}`
      const rest = text.slice(cursor + prefix.length)
      if (!text.startsWith(prefix, cursor) || !(rest === '' || /^\s/.test(rest))) {
        slashChainOpen = false
        continue
      }
      text = text.slice(0, cursor) + rest.replace(/^\s+/, '')
      retained.add(seg)
      continue
    }
    // image 段：剥离与其余非 text 段同款语义，但按裸路径 token 匹配（序列化 `\n<path>\n`
    // 的首尾换行会被 submitEdit 的 .trim() 吃掉，精确匹配不可靠，见文件头说明）。
    // 命中 ⇒ 剥掉整个序列化单元（token + 紧邻换行）、段保留；未命中 ⇒ 路径已被用户
    // 删掉/改写，丢弃段。删除范围必须含 token 两侧的换行，否则 draft 里 path 前后的
    // 换行留在 text 段内、重建时 image 段再补一遍 `\n<path>\n` ⇒ 每轮重发净增换行。
    if (seg.type === 'image') {
      const at = findBarePathOccurrence(text, seg.path, cursor)
      if (at === -1) continue
      const start = at > 0 && text[at - 1] === '\n' ? at - 1 : at
      const after = at + seg.path.length
      const end = text[after] === '\n' ? after + 1 : after
      text = text.slice(0, start) + text.slice(end)
      // 游标指向删除起点：其左侧内容未变且已消费，右侧是本次删除后才相邻的未消费文本。
      // start ≥ at-1 ≥ cursor-1，不会退回「恒从 0 找」（RC-A-2）。
      cursor = start
      retained.add(seg)
      continue
    }
    // 3) 其余非 text 段：序列化文本仍在编辑稿中 → 剥离该处文本并保留段（防翻倍）；
    //    已不在（用户改写/删除）→ 丢弃段。序列化经 segmentsToText 单元素调用取得（SSOT）。
    const serialized = segmentsToText([seg])
    // 空串序列化（subagent 路由标记 / 未知新类型）无文本足迹，恒保留
    if (serialized === '') {
      retained.add(seg)
      continue
    }
    const at = findDelimitedOccurrence(text, serialized, cursor)
    if (at === -1) continue
    text = text.slice(0, at) + text.slice(at + serialized.length)
    cursor = at
    retained.add(seg)
  }

  // 剥离后只剩空白（典型：两段 chip 之间的分隔空格）→ 收敛为空，否则会在重建时被物化成
  // text 段并 unshift 到段首，使 prompt 以空格开头（RC-A-6，实测 `a.ts b.ts` → ` a.ts b.ts`）。
  if (!text.trim()) text = ''

  // 4) 按原段序重建：保留集内的非 text 段原位保留；首个 text 段替换为剥离后的编辑文本。
  const segments: Segment[] = []
  let textPlaced = false
  for (const seg of source) {
    if (seg.type === 'text') {
      if (text && !textPlaced) {
        segments.push({ type: 'text', text })
        textPlaced = true
      }
    } else if (retained.has(seg)) {
      segments.push(seg)
    }
  }
  if (!textPlaced && text) {
    segments.unshift({ type: 'text', text })
  }
  return segments
}
