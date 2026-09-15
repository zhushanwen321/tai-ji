/**
 * rebuildSegmentsWithEditedText 单测。
 *
 * - MF-2：编辑重发 slash 段不翻倍。
 * - [轮 3 收口] 其余非 text 段（skill/file/mention/session/handoff）序列化文本同样不翻倍。
 * - [轮 3-4] RC-A-2 剥离按段序推进游标（正文里的同形字符串不被误删）；RC-A-6 剥离后
 *   只剩空白不物化 text 段（prompt 不以空格开头）。
 * - image 段：改为与其余非 text 段同款的剥离语义，但用裸路径 token 双侧边界匹配
 *   （序列化 `\n<path>\n` 的首尾换行会被 submitEdit 的 .trim() 吃掉，精确匹配不可靠），
 *   且剥离范围含 token 两侧紧邻换行（整个序列化单元）——只剥裸 token 会让未编辑草稿
 *   重发每轮净增换行。[轮 3-5] 幂等用例：image 居首 / 居末连发多轮 prompt === 草稿
 *   （并已纳入下方 CASES 幂等不变量）；居中（[text, image, text]）受既有位置近似影响
 *   round0 ≠ 草稿，单列断言 round1 === round2（收敛不累积）。
 *
 * 背景：编辑框展示的是归位全文（命令在最前，normalizeContent 产物）。若把该文本整串
 * 回灌进首个 text 段、段本身又照留，序列化后同一形态出现两次——slash 变成
 * `/compact /compact 总结`；skill 变成两个 `<taiji-skill/>` 标记（runtime 注入器逐个展开
 * ⇒ 同一 SKILL.md 注入两遍）。
 * 本文件锁的语义：编辑稿中仍能找到某段序列化文本 → 剥离该处文本、段保留；找不到
 *（用户改写名字/路径，或删除）→ 丢弃该段，以文本形态随 prompt 进入（与 slash 一致）。
 *
 * 运行：cd packages/ui && npx vitest run src/lib/__tests__/segment-rebuild.test.ts
 */
import { describe, it, expect } from 'vitest'
import { buildSkillMarker, normalizeContent, segmentsToPrompt, segmentsToText, type Segment } from '@taiji/shared'
import { rebuildSegmentsWithEditedText } from '../segment-rebuild'

/** live content = DOM 序（命令 chip 就地插在草稿中部，D4-a），非归位序 */
const LIVE: Segment[] = [
  { type: 'text', text: '总结' },
  { type: 'slash', name: 'compact' },
]

const count = (text: string, needle: string) => text.split(needle).length - 1

/** image 段：序列化单元是 `\n<path>\n`（裸路径独占一行） */
const IMG: Segment = {
  type: 'image',
  id: 'img-a',
  path: '/data/a/1.png',
  fileName: '1.png',
  displayName: '截图.png',
}
/** 复刻真实提交链路：编辑框回填 normalizeContent(live)，submitEdit 提交前对草稿 .trim() */
const submittedDraft = (live: Segment[]) => normalizeContent(live).trim()

describe('rebuildSegmentsWithEditedText：slash 段不参与 text 替换（MF-2）', () => {
  it('草稿原样提交 → slash 段保留、前缀命令剥离，prompt 命令仅一次', () => {
    const segments = rebuildSegmentsWithEditedText(LIVE, '/compact 总结')
    // 段序沿用原段序（归位由 segmentsToText/展示侧统一做，本函数不重排）
    expect(segments).toEqual([
      { type: 'text', text: '总结' },
      { type: 'slash', name: 'compact' },
    ])
    const prompt = segmentsToPrompt(segments)
    expect(prompt).toBe('/compact 总结')
    expect(count(prompt, '/compact')).toBe(1)
  })

  it('用户只改正文 → 命令仍只出现一次且正文更新', () => {
    const prompt = segmentsToPrompt(rebuildSegmentsWithEditedText(LIVE, '/compact 总结一下'))
    expect(prompt).toBe('/compact 总结一下')
    expect(count(prompt, '/compact')).toBe(1)
  })

  it('命令-only 消息（landing `/tasks`）原样提交 → prompt `/tasks`（不翻倍、不失命令）', () => {
    const only: Segment[] = [{ type: 'slash', name: 'tasks' }]
    expect(rebuildSegmentsWithEditedText(only, '/tasks')).toEqual([{ type: 'slash', name: 'tasks' }])
    expect(segmentsToPrompt(rebuildSegmentsWithEditedText(only, '/tasks'))).toBe('/tasks')
  })

  it('用户改命令名（/compact → /goal）→ 丢弃 slash 段，prompt 只含新命令', () => {
    const segments = rebuildSegmentsWithEditedText(LIVE, '/goal 总结')
    expect(segments).toEqual([{ type: 'text', text: '/goal 总结' }])
    expect(segmentsToPrompt(segments)).toBe('/goal 总结')
    expect(count(segmentsToPrompt(segments), '/compact')).toBe(0)
  })

  it('用户删掉命令只留正文 → 丢弃 slash 段，命令不再执行', () => {
    const segments = rebuildSegmentsWithEditedText(LIVE, '总结')
    expect(segments).toEqual([{ type: 'text', text: '总结' }])
    expect(segmentsToPrompt(segments)).toBe('总结')
  })

  it('token 边界：`/compactfoo` 不被当作 `/compact` 命令（不剥离、不误判）', () => {
    const segments = rebuildSegmentsWithEditedText(LIVE, '/compactfoo 总结')
    expect(segments).toEqual([{ type: 'text', text: '/compactfoo 总结' }])
    expect(segmentsToPrompt(segments)).toBe('/compactfoo 总结')
  })

  it('多个 slash 段：逐个剥离前缀命令后全部保留（prompt 各出现一次）', () => {
    const many: Segment[] = [
      { type: 'text', text: 'a' },
      { type: 'slash', name: 'compact' },
      { type: 'text', text: 'b' },
      { type: 'slash', name: 'fork' },
      { type: 'text', text: 'c' },
    ]
    const prompt = segmentsToPrompt(rebuildSegmentsWithEditedText(many, '/compact /fork abc'))
    expect(prompt).toBe('/compact /fork abc')
    expect(count(prompt, '/compact')).toBe(1)
    expect(count(prompt, '/fork')).toBe(1)
  })

  it('无 slash 段（纯文本消息）回归：首个 text 段替换、序列化仍在编辑稿中的段原位保留', () => {
    expect(rebuildSegmentsWithEditedText([{ type: 'text', text: '原文' }], '新文')).toEqual([
      { type: 'text', text: '新文' },
    ])
    const withFile: Segment[] = [
      { type: 'file', path: 'src/a.ts' },
      { type: 'text', text: '看看' },
    ]
    // 编辑稿保留 file 的序列化文本（正常「只改正文」路径）→ 段原位保留、文本剥离
    expect(rebuildSegmentsWithEditedText(withFile, 'src/a.ts 看看这个')).toEqual([
      { type: 'file', path: 'src/a.ts' },
      { type: 'text', text: ' 看看这个' },
    ])
    // 编辑稿已无该 file 序列化文本（用户删掉引用）→ 段丢弃，不「复活」回 prompt
    expect(rebuildSegmentsWithEditedText(withFile, '看看这个')).toEqual([
      { type: 'text', text: '看看这个' },
    ])
  })

  it('纯字符串输入（旧接口兼容）：产出单个 text 段', () => {
    expect(rebuildSegmentsWithEditedText('历史纯文本', '新文')).toEqual([{ type: 'text', text: '新文' }])
  })

  it('三视角补充：重建产物经 segmentsToText（展示序列化）与 segmentsToPrompt 同文本', () => {
    const segments = rebuildSegmentsWithEditedText(LIVE, '/compact 总结')
    expect(segmentsToText(segments)).toBe('/compact 总结')
    expect(segmentsToText(segments)).toBe(segmentsToPrompt(segments))
  })
})

// ── [轮 3 收口] 非 text 段序列化不翻倍（skill 为主用例）──
// 链路：live content → normalizeContent（编辑草稿）→ 用户只改正文 → rebuild → segmentsToPrompt。
// 修复前：草稿整串回灌首个 text 段 + 段原位保留 ⇒ 序列化后同一形态出现两次（skill 标记两遍
// ⇒ runtime 注入器展开两遍，同一 SKILL.md 注入两次）。修复后：标记只出现一次。
describe('[轮 3] 编辑重发 skill 段标记不翻倍', () => {
  const SKILL_SEG = { type: 'skill', name: 'review', location: '/skills/review/SKILL.md' } as const
  const MARKER = buildSkillMarker(SKILL_SEG.name, SKILL_SEG.location)

  it('skill 在段首（正文在后）：只改正文 → 标记仅一次且段保留', () => {
    const live: Segment[] = [SKILL_SEG, { type: 'text', text: '正文' }]
    const draft = normalizeContent(live)
    expect(draft).toBe(`${MARKER} 正文`)
    const segments = rebuildSegmentsWithEditedText(live, `${MARKER} 新正文`)
    expect(segments).toEqual([SKILL_SEG, { type: 'text', text: ' 新正文' }])
    const prompt = segmentsToPrompt(segments)
    expect(count(prompt, '<taiji-skill')).toBe(1)
    expect(prompt).toBe(`${MARKER} 新正文`)
  })

  it('skill 在正文之后（非段首，D4-a 光标处插入的主用例）：只改正文 → 标记仅一次', () => {
    const live: Segment[] = [{ type: 'text', text: '正文' }, SKILL_SEG]
    const draft = normalizeContent(live)
    expect(draft).toBe(`正文${MARKER}`)
    const prompt = segmentsToPrompt(rebuildSegmentsWithEditedText(live, `新正文${MARKER}`))
    expect(count(prompt, '<taiji-skill')).toBe(1)
    expect(prompt).toBe(`新正文${MARKER}`)
  })

  it('两个 skill 段混排：只改正文 → 每个标记各出现一次（不翻倍）', () => {
    const second = { type: 'skill', name: 'simplify', location: '/skills/simplify/SKILL.md' } as const
    const live: Segment[] = [{ type: 'text', text: '正文' }, SKILL_SEG, second]
    const draft = normalizeContent(live)
    const prompt = segmentsToPrompt(rebuildSegmentsWithEditedText(live, draft.replace('正文', '新正文')))
    expect(count(prompt, '<taiji-skill')).toBe(2)
    expect(count(prompt, 'name="review"')).toBe(1)
    expect(count(prompt, 'name="simplify"')).toBe(1)
  })

  it('用户改写 skill 名 → 丢弃旧段，prompt 只含改写后的标记（旧名不残留）', () => {
    const live: Segment[] = [SKILL_SEG, { type: 'text', text: '正文' }]
    const edited = `${buildSkillMarker('goal', SKILL_SEG.location)} 正文`
    const prompt = segmentsToPrompt(rebuildSegmentsWithEditedText(live, edited))
    expect(count(prompt, 'name="review"')).toBe(0)
    expect(count(prompt, 'name="goal"')).toBe(1)
  })

  it('用户删除标记只留正文 → 丢弃 skill 段，prompt 不再注入该 skill', () => {
    const live: Segment[] = [SKILL_SEG, { type: 'text', text: '正文' }]
    const segments = rebuildSegmentsWithEditedText(live, '正文')
    expect(segments).toEqual([{ type: 'text', text: '正文' }])
    expect(count(segmentsToPrompt(segments), '<taiji-skill')).toBe(0)
  })
})

describe('[轮 3] 编辑重发 file/mention/session/handoff 序列化不翻倍', () => {
  const CHIPS: Array<{ label: string; seg: Segment; needle: string }> = [
    { label: 'file', seg: { type: 'file', path: 'src/a.ts', lineRange: [3, 5] }, needle: 'src/a.ts:L3-L5' },
    { label: 'mention', seg: { type: 'mention', name: 'alice' }, needle: '@alice' },
    { label: 'session', seg: { type: 'session', sessionId: 'abc-123', label: '会话A' }, needle: '#abc-123' },
    { label: 'handoff', seg: { type: 'handoff', sourceLabel: 'src-session' }, needle: '[handoff from src-session]' },
  ]

  for (const { label, seg, needle } of CHIPS) {
    it(`${label}：只改正文 → 序列化文本仅一次且段保留`, () => {
      const live: Segment[] = [seg, { type: 'text', text: '正文' }]
      const draft = normalizeContent(live)
      expect(count(draft, needle)).toBe(1)
      const segments = rebuildSegmentsWithEditedText(live, draft.replace('正文', '新正文'))
      expect(segments).toContainEqual(seg)
      expect(count(segmentsToPrompt(segments), needle)).toBe(1)
    })

    it(`${label}：删除该段序列化文本 → 段丢弃（以文本形态进入，不复活）`, () => {
      const live: Segment[] = [seg, { type: 'text', text: '正文' }]
      const segments = rebuildSegmentsWithEditedText(live, '正文')
      expect(segments).toEqual([{ type: 'text', text: '正文' }])
      expect(count(segmentsToPrompt(segments), needle)).toBe(0)
    })
  }

  it('token 边界（mention）：`@alice` 不误配 `@alicex` 前缀 → 段丢弃、文本保留', () => {
    const live: Segment[] = [{ type: 'mention', name: 'alice' }, { type: 'text', text: '正文' }]
    const segments = rebuildSegmentsWithEditedText(live, '@alicex 正文')
    expect(segments).toEqual([{ type: 'text', text: '@alicex 正文' }])
  })

  it('subagent 段（序列化为空串）恒保留，无文本足迹 ⇒ 不翻倍', () => {
    const live: Segment[] = [
      { type: 'subagent', subagentId: 's1', slug: 'oracle' },
      { type: 'text', text: '正文' },
    ]
    const draft = normalizeContent(live)
    expect(draft).toBe(' 正文')
    const segments = rebuildSegmentsWithEditedText(live, draft)
    expect(segments).toContainEqual({ type: 'subagent', subagentId: 's1', slug: 'oracle' })
    expect(count(segmentsToPrompt(segments), 'oracle')).toBe(0)
  })
})

// ── image 段：裸路径 token 双侧边界剥离（编辑重发不翻倍 / 删路径不复活）──
// 背景：image 段序列化为 `\n<path>\n`，但 UserBubble.submitEdit 提交前对草稿 `.trim()`
// （UserBubble.vue:258）会吃掉首尾换行，按序列化串精确匹配在真实链路不可靠。
// 修复前 image 段恒保留、不参与剥离，两个已登记缺陷：
//   ① 编辑稿里路径随序列化再出现一次 ⇒ 同一路径在 prompt 中出现两次；
//   ② 用户把编辑稿里的路径删掉后重发，旧路径仍随段「复活」。
// 修复后：命中（前边界 = 串首/空白 且 后边界 = 串尾/空白）⇒ 剥离路径、段保留（消 ①）；
// 未命中 ⇒ 用户删掉/改写了路径，丢弃段（消 ②）。前边界必须判，否则 `x/data/a/1.png`
// 这类正文里的相对路径片段会被当图片路径剥掉。
// 剥离范围含 token 两侧紧邻换行（即整个 `\n<path>\n` 序列化单元），换行累积的幂等用例
// 见下方 `[轮 3-5]` describe。
describe('[image] 裸路径 token 剥离：编辑重发不翻倍 / 删路径不复活', () => {
  it('① 路径保留（只改正文）→ 编辑重发产物中该路径只出现一次（修复前为两次）', () => {
    const live: Segment[] = [IMG, { type: 'text', text: '正文' }]
    const edited = submittedDraft(live).replace('正文', '新正文')
    const segments = rebuildSegmentsWithEditedText(live, edited)
    expect(segments).toContainEqual(IMG)
    expect(count(segmentsToPrompt(segments), IMG.path)).toBe(1)
  })

  it('② 路径被删（只留正文）→ 段丢弃，产物中不再出现该路径（修复前仍出现）', () => {
    const live: Segment[] = [IMG, { type: 'text', text: '正文' }]
    const segments = rebuildSegmentsWithEditedText(live, '正文')
    expect(segments.some((s) => s.type === 'image')).toBe(false)
    expect(count(segmentsToPrompt(segments), IMG.path)).toBe(0)
  })

  it('③ 路径被改写（/data/a/1.png → /data/b/2.png）→ 新路径以文本形态保留，旧 image 段丢弃', () => {
    const live: Segment[] = [IMG, { type: 'text', text: '正文' }]
    const segments = rebuildSegmentsWithEditedText(live, '/data/b/2.png\n正文')
    expect(segments.some((s) => s.type === 'image')).toBe(false)
    const prompt = segmentsToPrompt(segments)
    expect(count(prompt, '/data/b/2.png')).toBe(1)
    expect(count(prompt, IMG.path)).toBe(0)
  })

  it('④a 后边界守卫：正文 `/data/a/1.png2` 不误剥（路径后紧贴数字，属正文）', () => {
    const live: Segment[] = [IMG, { type: 'text', text: '正文' }]
    const edited = '/data/a/1.png2\n正文'
    const segments = rebuildSegmentsWithEditedText(live, edited)
    // 未命中 ⇒ 段丢弃；正文逐字保留（路径片段未被当图片路径剥掉）
    expect(segments.some((s) => s.type === 'image')).toBe(false)
    expect(segmentsToPrompt(segments)).toBe(edited)
  })

  it('④b 前边界守卫：正文 `x/data/a/1.png` 不误剥（路径前有字符，属相对路径片段）', () => {
    const live: Segment[] = [IMG, { type: 'text', text: '正文' }]
    const edited = 'x/data/a/1.png\n正文'
    const segments = rebuildSegmentsWithEditedText(live, edited)
    expect(segments.some((s) => s.type === 'image')).toBe(false)
    expect(segmentsToPrompt(segments)).toBe(edited)
  })

  it('正文含同形路径（游标保护）：正文那份不被删，chip 那份剥离且段保留', () => {
    const live: Segment[] = [{ type: 'text', text: `看看 ${IMG.path} 吧` }, IMG]
    const segments = rebuildSegmentsWithEditedText(live, submittedDraft(live))
    const body = segments[0] as { type: 'text'; text: string }
    expect(body.text.startsWith(`看看 ${IMG.path} 吧`)).toBe(true)
    expect(count(body.text, IMG.path)).toBe(1)
    expect(segments).toContainEqual(IMG)
  })
})

// ── [轮 3-5] image 段剥离整个序列化单元（`\n<path>\n`）：未编辑草稿重发恒幂等 ──
// 根因（上一轮残余）：image 分支只剥裸路径 token（`text.slice(0, at) + text.slice(at + path.length)`），
// 而 image 的序列化单元是 `\n<path>\n`——草稿里 path 前后的换行留在 text 段内，重建后 image 段
// 又补一遍 padding ⇒ 每轮编辑重发净增换行、无界累积（实测 5 轮：草稿 2 个换行 → 每轮 +2）。
// 修复：命中裸路径后把删除范围向左右各扩一个紧邻换行（存在则吃、不存在则不吃），恰好抵消
// 序列化自带的 padding。生产链路（submitEdit 的 .trim() 吃掉首尾换行）同样幂等：被 trim 的
// 那个换行不得在重建时被累积回来。
describe('[轮 3-5] image 段剥离整个序列化单元（`\\n<path>\\n`）', () => {
  it('image 居首 + 正文：未编辑草稿连发 5 轮，每轮 prompt 与草稿逐字相同（修复前每轮净增换行）', () => {
    const live: Segment[] = [IMG, { type: 'text', text: '正文' }]
    const draft = normalizeContent(live)
    expect(draft).toBe('\n/data/a/1.png\n正文')
    let segments = live
    for (let round = 0; round < 5; round++) {
      segments = rebuildSegmentsWithEditedText(segments, normalizeContent(segments))
      expect(segmentsToPrompt(segments)).toBe(draft)
    }
  })

  it('正文 + image 居末：未编辑草稿连发 3 轮，每轮 prompt 与草稿逐字相同（修复前每轮净增换行）', () => {
    const live: Segment[] = [{ type: 'text', text: '正文' }, IMG]
    const draft = normalizeContent(live)
    expect(draft).toBe('正文\n/data/a/1.png\n')
    let segments = live
    for (let round = 0; round < 3; round++) {
      segments = rebuildSegmentsWithEditedText(segments, normalizeContent(segments))
      expect(segmentsToPrompt(segments)).toBe(draft)
    }
  })

  it('生产链路形态（submitEdit 的 .trim() 吃掉首尾换行）→ prompt === 未 trim 的草稿、路径仅一次', () => {
    const live: Segment[] = [IMG, { type: 'text', text: '正文' }]
    const draft = normalizeContent(live) // '\n/data/a/1.png\n正文'
    const edited = submittedDraft(live) // '/data/a/1.png\n正文'
    expect(edited).toBe('/data/a/1.png\n正文')
    const prompt = segmentsToPrompt(rebuildSegmentsWithEditedText(live, edited))
    expect(prompt).toBe(draft)
    expect(count(prompt, IMG.path)).toBe(1)
    expect(prompt.endsWith('\n\n正文')).toBe(false)
  })

  it('image 居中（[text A, image, text B]）：round0 位置近似（D6 已接受），round1 === round2 不累积', () => {
    // 「round0 ≠ 草稿」是既有「首个 text 段承接全部正文、chip 位置不动」模型的位置近似，
    // 与本轮换行修复无关（D6 已登记为接受项），故不并入上方幂等不变量 CASES。
    // 本用例只锁「不再累积」：round1 起收敛，round1 === round2。
    const live: Segment[] = [{ type: 'text', text: 'A' }, IMG, { type: 'text', text: 'B' }]
    const round1 = rebuildSegmentsWithEditedText(live, normalizeContent(live))
    const round2 = rebuildSegmentsWithEditedText(round1, normalizeContent(round1))
    expect(segmentsToPrompt(round2)).toBe(segmentsToPrompt(round1))
    expect(count(segmentsToPrompt(round1), IMG.path)).toBe(1)
    expect(segmentsToPrompt(round1)).toBe(`AB\n${IMG.path}\n`)
  })
})

// ── [轮 3 第 4 轮 · RC-A-2] 剥离按段序推进游标：正文里的同形字符串不得被当 chip 序列化文本 ──
// 回归形态：`findDelimitedOccurrence(text, serialized, 0)` 恒从 0 找首个合法出现，无法区分
// 「用户正文里的同形字符串」与「chip 序列化文本」。正文的同形串出现在 chip 之前时，
// 被删的是正文那份、chip 那份留在原位 ⇒ 正文损坏且 token 仍出现两次。
// 修复依据：编辑前草稿文本就是 segmentsToText(source)，各段序列化形态的出现顺序与段序一致。
describe('[轮 3-4 · RC-A-2] 正文含 chip 同形文本：正文不被删、段仍保留', () => {
  it('file：正文在前含同形路径 → 正文逐字保留，路径在正文中计数为 1', () => {
    const live: Segment[] = [{ type: 'text', text: '看看 src/a.ts 吧' }, { type: 'file', path: 'src/a.ts' }]
    const draft = normalizeContent(live)
    expect(draft).toBe('看看 src/a.ts 吧src/a.ts')
    const segments = rebuildSegmentsWithEditedText(live, draft)
    // 正文段原样（修复前被删成 `看看  吧src/a.ts`）
    expect(segments[0]).toEqual({ type: 'text', text: '看看 src/a.ts 吧' })
    expect(segments).toContainEqual({ type: 'file', path: 'src/a.ts' })
    // 正文里的同形 token 计数为 1（未被删、也未多出）
    expect(count((segments[0] as { type: 'text'; text: string }).text, 'src/a.ts')).toBe(1)
    // 未编辑草稿重发 ⇒ prompt 与草稿逐字相同
    expect(segmentsToPrompt(segments)).toBe(draft)
  })

  it('mention：正文在前含同形 @name → 正文逐字保留，@name 在正文中计数为 1', () => {
    const live: Segment[] = [{ type: 'text', text: '@alice 你好' }, { type: 'mention', name: 'alice' }]
    const draft = normalizeContent(live)
    expect(draft).toBe('@alice 你好@alice')
    const segments = rebuildSegmentsWithEditedText(live, draft)
    // 修复前正文被删成 ` 你好@alice`（用户的 @alice 消失）
    expect(segments[0]).toEqual({ type: 'text', text: '@alice 你好' })
    expect(segments).toContainEqual({ type: 'mention', name: 'alice' })
    expect(count((segments[0] as { type: 'text'; text: string }).text, '@alice')).toBe(1)
    expect(segmentsToPrompt(segments)).toBe(draft)
  })

  it('同形串在正文中出现两次（正文 2 + chip 1）→ 两处都保留，stripped 只命中 chip 那次', () => {
    const live: Segment[] = [
      { type: 'text', text: 'a.ts 与 a.ts 都看看' },
      { type: 'file', path: 'a.ts' },
    ]
    const draft = normalizeContent(live)
    const segments = rebuildSegmentsWithEditedText(live, draft)
    expect(segments[0]).toEqual({ type: 'text', text: 'a.ts 与 a.ts 都看看' })
    expect(count((segments[0] as { type: 'text'; text: string }).text, 'a.ts')).toBe(2)
    expect(segmentsToPrompt(segments)).toBe(draft)
  })

  it('正文已被改写（原文找不到）时不推进游标：chip 仍按合法出现剥离，不误删新正文', () => {
    const live: Segment[] = [{ type: 'text', text: '原文' }, { type: 'file', path: 'src/a.ts' }]
    const segments = rebuildSegmentsWithEditedText(live, '新正文src/a.ts')
    expect(segments).toEqual([{ type: 'text', text: '新正文' }, { type: 'file', path: 'src/a.ts' }])
  })
})

// ── [轮 3 第 4 轮 · RC-A-6] 剥离后残留的纯空白文本不得物化成段 ──
// `if (text && !textPlaced)` 只判真值、空白串为真值：剥离后若剩余文本只剩空白（典型：
// 两段 chip 之间的分隔空格），会被物化为 text 段并 unshift 到段首，prompt 以空格开头。
describe('[轮 3-4 · RC-A-6] 剥离后只剩空白 → 不物化 text 段（prompt 不以空格开头）', () => {
  it('两个 chip 相邻（中间只有边界空格）→ 无 text 段、prompt 与草稿逐字相同', () => {
    const live: Segment[] = [{ type: 'file', path: 'a.ts' }, { type: 'file', path: 'b.ts' }]
    const draft = normalizeContent(live)
    expect(draft).toBe('a.ts b.ts')
    const segments = rebuildSegmentsWithEditedText(live, draft)
    // 修复前产出 [{text:' '}, file, file] ⇒ prompt ` a.ts b.ts`（首字符空格）
    expect(segments.some((s) => s.type === 'text')).toBe(false)
    expect(segments).toEqual(live)
    expect(segmentsToPrompt(segments)).toBe(draft)
  })

  it('三个 chip 相邻 → 同样不残留空白段', () => {
    const live: Segment[] = [
      { type: 'mention', name: 'alice' },
      { type: 'session', sessionId: 'abc-123', label: '会话A' },
      { type: 'handoff', sourceLabel: 'src-session' },
    ]
    const draft = normalizeContent(live)
    const segments = rebuildSegmentsWithEditedText(live, draft)
    expect(segments.some((s) => s.type === 'text')).toBe(false)
    expect(segmentsToPrompt(segments)).toBe(draft)
  })

  it('正文全为空白（用户清空正文只留 chip）→ 不留空白段', () => {
    const live: Segment[] = [{ type: 'file', path: 'a.ts' }, { type: 'text', text: '正文' }]
    const segments = rebuildSegmentsWithEditedText(live, 'a.ts   ')
    expect(segments).toEqual([{ type: 'file', path: 'a.ts' }])
    expect(segmentsToPrompt(segments)).toBe('a.ts')
  })
})

// ── [轮 3-4] 未编辑草稿的不变量：rebuild(source, segmentsToText(source)) 序列化后逐字不变 ──
// 这条不变量同时覆盖 RC-A-2（同形串被误删会改变正文）与 RC-A-6（残留空白段会加出前导空格）。
// 边界：chip 夹在两段 text 之间时刻意不收（如 `[text('看看'), session, text('的讨论')]`、
// `[text('A'), image, text('B')]`）——「首个 text 段替换 + 其余 text 段丢弃」模型会把尾段
// 正文并入首段、chip 位置不动，序列化后尾段正文移到 chip 之前（`看看 的讨论#sid-1`）。
// 这是既有位置近似（D6 已登记），与本轮修复无关；image 居中那例的「不再累积」收敛断言
// 单列在 `[轮 3-5]` describe（round1 === round2）。
// image 居首 / 居末两种排布已纳入 CASES——此前 CASES 全部 8 例恰好都不含 image，
// 使「未编辑草稿重发 ⇒ prompt 与草稿逐字相同」这条不变量对 image 静默失效
// （换行累积缺陷因此逃过不变量，只在手工探针里暴露）。
describe('[轮 3-4] 未编辑草稿重发 ⇒ prompt 与草稿逐字相同（幂等不变量）', () => {
  const CASES: Array<{ label: string; live: Segment[] }> = [
    { label: 'text + slash（命令归位）', live: [{ type: 'text', text: '总结' }, { type: 'slash', name: 'compact' }] },
    { label: 'slash + text（命令在首）', live: [{ type: 'slash', name: 'compact' }, { type: 'text', text: '清理一下' }] },
    { label: '正文含同形路径 + file', live: [{ type: 'text', text: '看看 src/a.ts 吧' }, { type: 'file', path: 'src/a.ts' }] },
    { label: 'file + file（仅边界空格）', live: [{ type: 'file', path: 'a.ts' }, { type: 'file', path: 'b.ts' }] },
    { label: 'skill + 正文', live: [{ type: 'skill', name: 'review', location: '/skills/review/SKILL.md' }, { type: 'text', text: '正文' }] },
    { label: '正文 + session（chip 收尾）', live: [{ type: 'text', text: '看看' }, { type: 'session', sessionId: 'sid-1', label: '会话 A' }] },
    { label: 'mention + 正文 + handoff', live: [{ type: 'mention', name: 'alice' }, { type: 'text', text: '正文' }, { type: 'handoff', sourceLabel: 'src-session' }] },
    { label: 'subagent（空串序列化）+ 正文', live: [{ type: 'subagent', subagentId: 's1', slug: 'oracle' }, { type: 'text', text: '正文' }] },
    { label: 'image + 正文（图片居首）', live: [IMG, { type: 'text', text: '正文' }] },
    { label: '正文 + image（图片居末）', live: [{ type: 'text', text: '正文' }, IMG] },
  ]

  for (const { label, live } of CASES) {
    it(`${label}：prompt === 草稿`, () => {
      const draft = normalizeContent(live)
      expect(segmentsToPrompt(rebuildSegmentsWithEditedText(live, draft))).toBe(draft)
    })
  }
})
