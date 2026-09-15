/**
 * Segment 归一化函数单测（ADR-0043）。
 *
 * 覆盖 segmentsToText / segmentsToPrompt / textToSegments / normalizeContent。
 * 重点：segmentsToText 与 segmentsToPrompt（pi 边界序列化）均不 trim——原文保真
 * （[HISTORICAL] segmentsToPrompt 曾 trim 首尾空白，2026-08 去除，见 segments.ts）。
 */
import { describe, it, expect } from 'vitest'
import {
  segmentsToText,
  segmentsToPrompt,
  textToSegments,
  normalizeContent,
  normalizeSegmentOrder,
  type Segment,
} from '../segments'
import { parseSkillMarkers } from '../skill-marker'

describe('segmentsToText', () => {
  it('空数组返回空字符串', () => {
    expect(segmentsToText([])).toBe('')
  })

  it('纯 text segment 原样返回', () => {
    expect(segmentsToText([{ type: 'text', text: 'hello' }])).toBe('hello')
  })

  it('skill segment 序列化为 <taiji-skill/> 私有标记（D3，精确标记串）', () => {
    expect(segmentsToText([{ type: 'skill', name: 'cw-cli' }])).toBe('<taiji-skill name="cw-cli"/>')
  })

  it('skill + text 之间补空格', () => {
    const segs: Segment[] = [
      { type: 'skill', name: 'cw-cli' },
      { type: 'text', text: '想要都修复' },
    ]
    expect(segmentsToText(segs)).toBe('<taiji-skill name="cw-cli"/> 想要都修复')
  })

  it('skill + text（text 已含前导空格）不重复补空格', () => {
    const segs: Segment[] = [
      { type: 'skill', name: 'cw-cli' },
      { type: 'text', text: ' 想要都修复' },
    ]
    expect(segmentsToText(segs)).toBe('<taiji-skill name="cw-cli"/> 想要都修复')
  })

  it('不 trim 末尾换行（保留 <br> 产生的 \\n）', () => {
    expect(segmentsToText([{ type: 'text', text: 'line\n' }])).toBe('line\n')
  })

  it('skill 带 location 序列化进标记（降级模式与反解析的自描述数据）', () => {
    const segs: Segment[] = [{ type: 'skill', name: 'cw-cli', location: '/path/SKILL.md' }]
    expect(segmentsToText(segs)).toBe('<taiji-skill name="cw-cli" location="/path/SKILL.md"/>')
  })

  it('mention segment 序列化为 @name', () => {
    expect(segmentsToText([{ type: 'mention', name: 'alice' }])).toBe('@alice')
  })

  it('mention + text 之间补空格（chip→text 边界）', () => {
    const segs: Segment[] = [
      { type: 'mention', name: 'alice' },
      { type: 'text', text: '你好' },
    ]
    expect(segmentsToText(segs)).toBe('@alice 你好')
  })

  it('text 为空串且前导是 chip 时不补空格（空 text 不产出悬空空格）', () => {
    const segs: Segment[] = [
      { type: 'skill', name: 'cw-cli' },
      { type: 'text', text: '' },
      { type: 'skill', name: 'review' },
    ]
    expect(segmentsToText(segs)).toBe('<taiji-skill name="cw-cli"/><taiji-skill name="review"/>')
  })

  it('file 无行范围序列化为 path', () => {
    expect(segmentsToText([{ type: 'file', path: 'src/foo.ts' }])).toBe('src/foo.ts')
  })

  it('file 单行范围序列化为 path:L<n>（D2）', () => {
    expect(segmentsToText([{ type: 'file', path: 'src/foo.ts', lineRange: [10, 10] }])).toBe(
      'src/foo.ts:L10',
    )
  })

  it('file 多行范围序列化为 path:L<s>-L<e>（D2，review M1 回归）', () => {
    expect(segmentsToText([{ type: 'file', path: 'src/foo.ts', lineRange: [10, 20] }])).toBe(
      'src/foo.ts:L10-L20',
    )
  })

  it('file lineRange 归一化：负数起点钳到 1', () => {
    expect(segmentsToText([{ type: 'file', path: 'src/foo.ts', lineRange: [-3, 5] }])).toBe(
      'src/foo.ts:L1-L5',
    )
  })

  it('file lineRange 归一化：s>e 时 e 抬到 s（退化为单行）', () => {
    expect(segmentsToText([{ type: 'file', path: 'src/foo.ts', lineRange: [20, 10] }])).toBe(
      'src/foo.ts:L20',
    )
  })

  it('image segment 序列化为裸路径独占一行（对齐 pi TUI）', () => {
    const segs: Segment[] = [
      {
        type: 'image',
        id: 'img-1',
        path: '/var/folders/xx/T/dbfdb3c8-image.png',
        fileName: 'dbfdb3c8-image.png',
        displayName: 'screenshot-20260724-1530.png',
      },
    ]
    const result = segmentsToText(segs)
    expect(result).toBe('\n/var/folders/xx/T/dbfdb3c8-image.png\n')
    // 不含 base64 标记（图片走路径模式，不走 base64）
    expect(result).not.toMatch(/data:image/)
    // 不含 [图片 N] 匿名占位
    expect(result).not.toContain('[图片')
  })

  it('image + text 混合时，image 裸路径独占一行 + text 紧随（不补空格，image 的 \\n 已分隔）', () => {
    const segs: Segment[] = [
      { type: 'image', id: 'img-a', path: '/tmp/a.png', fileName: 'a.png', displayName: 'a.png' },
      { type: 'text', text: '这张图怎么修' },
    ]
    // image 前后补 \n，text 紧接 image 的尾 \n（image 段自带 \n 分隔，紧跟的 text 不补空格，
    // 否则产出 `\n/tmp/a.png\n 这张图怎么修` 行首空格污染 pi prompt）
    expect(segmentsToText(segs)).toBe('\n/tmp/a.png\n这张图怎么修')
  })

  it('skill 后紧跟 text 仍补空格（与 image 区分，skill 无 \\n 分隔）', () => {
    const segs: Segment[] = [
      { type: 'skill', name: 'review' },
      { type: 'text', text: '这段代码' },
    ]
    // skill 无 \n 自分隔，text 紧跟 skill 时仍需补空格，否则产出 `/>这段代码` 标记正文粘连
    expect(segmentsToText(segs)).toBe('<taiji-skill name="review"/> 这段代码')
  })

  it('连续多个 image segment：每个路径独占一行（无编号递增）', () => {
    const segs: Segment[] = [
      { type: 'image', id: 'img-1', path: '/tmp/1.png', fileName: '1.png', displayName: '1.png' },
      { type: 'image', id: 'img-2', path: '/tmp/2.png', fileName: '2.png', displayName: '2.png' },
    ]
    expect(segmentsToText(segs)).toBe('\n/tmp/1.png\n\n/tmp/2.png\n')
  })

  it('image segment 不破坏既有 text/skill 序列化（回归）', () => {
    // 混合 image 与既有类型，确认 image 的加入不影响 text/skill 的序列化。
    // 补空格逻辑只在「当前段是 text && prev 段不是 text」时触发。
    // 这里 text 在前（首段，prev=null 不补空格）；image 独占一行（\n 包裹）；
    // skill 紧跟 image（非 text 段，不触发补空格）。
    const segs: Segment[] = [
      { type: 'text', text: '看这张' },
      { type: 'image', id: 'img-x', path: '/tmp/x.png', fileName: 'x.png', displayName: 'x.png' },
      { type: 'skill', name: 'review' },
    ]
    expect(segmentsToText(segs)).toBe('看这张\n/tmp/x.png\n<taiji-skill name="review"/>')
  })
})

describe('segmentsToPrompt', () => {
  it('原文保真：首尾空白不剥除（[HISTORICAL] 曾 trim，Gate B 观测①修复后保真）', () => {
    const segs: Segment[] = [
      { type: 'skill', name: 'cw-cli' },
      { type: 'text', text: '想要都修复\n' },
    ]
    // skill chip 与 text 间补一个空格；text 尾换行保留——pi 不 trim（P2 探针），落盘同文
    expect(segmentsToPrompt(segs)).toBe('<taiji-skill name="cw-cli"/> 想要都修复\n')
  })

  it('空数组返回空字符串', () => {
    expect(segmentsToPrompt([])).toBe('')
  })
})

describe('textToSegments', () => {
  it('纯文本产出单个 text segment', () => {
    expect(textToSegments('hello')).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('空字符串返回空数组', () => {
    expect(textToSegments('')).toEqual([])
  })
})

describe('normalizeContent', () => {
  it('string 直传', () => {
    expect(normalizeContent('plain string')).toBe('plain string')
  })

  it('Segment[] 走 segmentsToText', () => {
    const segs: Segment[] = [
      { type: 'skill', name: 'cw-cli' },
      { type: 'text', text: '想要都修复' },
    ]
    expect(normalizeContent(segs)).toBe('<taiji-skill name="cw-cli"/> 想要都修复')
  })

  it('空 Segment[] 返回空字符串', () => {
    expect(normalizeContent([])).toBe('')
  })

  it('含 handoff segment 的 Segment[] 归一化正确', () => {
    const segs: Segment[] = [
      { type: 'handoff', sourceLabel: 'old-session' },
      { type: 'text', text: '请继续完成任务' },
    ]
    expect(normalizeContent(segs)).toBe('[handoff from old-session] 请继续完成任务')
  })

  it('纯 handoff segment（无 text）归一化正确', () => {
    const segs: Segment[] = [{ type: 'handoff', sourceLabel: 'src-abc' }]
    expect(normalizeContent(segs)).toBe('[handoff from src-abc]')
  })
})

describe('handoff segment', () => {
  it('handoff segment 序列化为 [handoff from sourceLabel]', () => {
    const segs: Segment[] = [{ type: 'handoff', sourceLabel: 'my-session' }]
    expect(segmentsToText(segs)).toBe('[handoff from my-session]')
  })

  it('handoff + text 混合时，handoff 标记后紧跟 text 补空格', () => {
    const segs: Segment[] = [
      { type: 'handoff', sourceLabel: 'src-session' },
      { type: 'text', text: '请继续完成以下任务' },
    ]
    expect(segmentsToText(segs)).toBe('[handoff from src-session] 请继续完成以下任务')
  })

  it('handoff segment 空 sourceLabel 不抛错', () => {
    const segs: Segment[] = [{ type: 'handoff', sourceLabel: '' }]
    expect(segmentsToText(segs)).toBe('[handoff from ]')
  })

  it('handoff + skill 混合不补空格（两者都是 chip 类但 handoff 已有 ] 分隔）', () => {
    const segs: Segment[] = [
      { type: 'handoff', sourceLabel: 'old-session' },
      { type: 'skill', name: 'review' },
    ]
    // handoff 结尾是 ]，skill 产出 < 开头的标记，非 text→非 text 边界补空格
    expect(segmentsToText(segs)).toBe('[handoff from old-session] <taiji-skill name="review"/>')
  })
})

describe('session / subagent segment（composer 四符号 U1）', () => {
  const SESSION_ID = '019e6c96-1111-4222-8333-444455556666'

  it('session segment 序列化为 #<sessionId>（TUI session_read 协议），label 不进文本', () => {
    const segs: Segment[] = [{ type: 'session', sessionId: SESSION_ID, label: 'fix-com 设计讨论' }]
    expect(segmentsToText(segs)).toBe(`#${SESSION_ID}`)
  })

  it('subagent segment 序列化为空串（路由标记不进 prompt 文本）', () => {
    const segs: Segment[] = [{ type: 'subagent', subagentId: 'sub-1', slug: 'build-api' }]
    expect(segmentsToText(segs)).toBe('')
  })

  it('subagent + text：text 紧随 subagent（chip→text 边界补一个空格，subagent 本体不产出文本）', () => {
    const segs: Segment[] = [
      { type: 'subagent', subagentId: 'sub-1', slug: 'build-api' },
      { type: 'text', text: '汇报当前进度' },
    ]
    // subagent 是 chip 类（DOM 中占位可见），text 分支按 chip→text 规则补空格——
    // @slug 不残留（「不经主 agent LLM」的结构性保证）。前导空格随原文保真发出
    // （segmentsToPrompt 已不 trim），空白拦截归 useChat sendSubagentDirective 空挡。
    expect(segmentsToText(segs)).toBe(' 汇报当前进度')
    expect(segmentsToPrompt(segs)).toBe(' 汇报当前进度')
  })

  it('session 与 file chip 边界补空格（chip→chip 规则不变）', () => {
    const segs: Segment[] = [
      { type: 'session', sessionId: SESSION_ID, label: '会话 A' },
      { type: 'file', path: 'src/a.ts' },
    ]
    expect(segmentsToText(segs)).toBe(`#${SESSION_ID} src/a.ts`)
  })

  it('text + session + text：边界规则与 file 一致（text→chip 不补，chip→text 补）', () => {
    const segs: Segment[] = [
      { type: 'text', text: '看看' },
      { type: 'session', sessionId: SESSION_ID, label: '会话 A' },
      { type: 'text', text: '的讨论' },
    ]
    // text→chip 方向不补空格（与 file/skill 一致——用户文本以空格结尾时自行分隔）
    expect(segmentsToText(segs)).toBe(`看看#${SESSION_ID} 的讨论`)
  })
})

describe('skill 标记序列化（D3，composer 多 skill 注入 u3）', () => {
  // ① 序列化产物 = 精确标记串：segmentsToText 复用 buildSkillMarker，转义/属性顺序与
  //    解析端（parseSkillMarkers）同源——此处锁定传导正确性与端到端形态。
  it('name/location 含引号反斜杠时按 skill-marker SSOT 转义，产物可被 parseSkillMarkers 无损还原', () => {
    const segs: Segment[] = [{ type: 'skill', name: 'a"b\\c', location: '/x/y "z"/SKILL.md' }]
    const text = segmentsToText(segs)
    expect(text).toBe('<taiji-skill name="a\\"b\\\\c" location="/x/y \\"z\\"/SKILL.md"/>')
    // 往返还原：name/location 与原 segment 一致（转义对称性——runtime 解析与 core 反解析共用此保证）
    const [parsed] = parseSkillMarkers(text)
    expect(parsed).toMatchObject({ name: 'a"b\\c', location: '/x/y "z"/SKILL.md' })
  })

  it('location 缺省与空串产出一致（均无 location 属性，往返归一为缺省）', () => {
    expect(segmentsToText([{ type: 'skill', name: 'a' }])).toBe('<taiji-skill name="a"/>')
    expect(segmentsToText([{ type: 'skill', name: 'a', location: '' }])).toBe('<taiji-skill name="a"/>')
  })

  it('混排往返：text + skill + text 序列化产物经 parseSkillMarkers 位置切片可还原全部标记与正文区间', () => {
    const segs: Segment[] = [
      { type: 'text', text: '帮我 review' },
      { type: 'skill', name: 'code-review-graph', location: '/abs/SKILL.md' },
      { type: 'text', text: ' 这段代码' },
    ]
    const text = segmentsToText(segs)
    const markers = parseSkillMarkers(text)
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({ name: 'code-review-graph', location: '/abs/SKILL.md' })
    // 标记区间外的正文完整保留（反解析正文不断言语义在 core，此处锁序列化不吞正文）
    expect(text.slice(0, markers[0]!.index)).toBe('帮我 review')
    expect(text.slice(markers[0]!.index + markers[0]!.length)).toBe(' 这段代码')
  })

  // ④ 空正文纯标记消息：纯 skill 无 text 产出单个精确标记（runtime 注入/反解析的最小形态）
  it('空正文纯标记消息：单个 skill segment 序列化为单个标记，无多余分隔', () => {
    expect(segmentsToText([{ type: 'skill', name: 'solo' }])).toBe('<taiji-skill name="solo"/>')
    expect(segmentsToPrompt([{ type: 'skill', name: 'solo', location: '/s/SKILL.md' }])).toBe(
      '<taiji-skill name="solo" location="/s/SKILL.md"/>',
    )
  })
})

describe('normalizeSegmentOrder（D4-c 归位单一实现，segmentsToText 与 UserBubble 共用）', () => {
  it('slash 段提为首段，其余段保持原序', () => {
    const segs: Segment[] = [
      { type: 'text', text: '总结' },
      { type: 'slash', name: 'compact' },
    ]
    expect(normalizeSegmentOrder(segs)).toEqual([
      { type: 'slash', name: 'compact' },
      { type: 'text', text: '总结' },
    ])
    // 序列化前缀产物的归位序与展示侧同源（live ≡ reload 的前提）
    expect(segmentsToText(segs)).toBe('/compact 总结')
  })

  it('无 slash 段时零重排（原序内容不变）', () => {
    const segs: Segment[] = [
      { type: 'text', text: '看看' },
      { type: 'session', sessionId: 'sid-1', label: '会话 A' },
    ]
    expect(normalizeSegmentOrder(segs)).toEqual(segs)
  })

  it('多个 slash 段全前置并按原序（正常态至多一个）', () => {
    const segs: Segment[] = [
      { type: 'text', text: 'a' },
      { type: 'slash', name: 'compact' },
      { type: 'text', text: 'b' },
      { type: 'slash', name: 'fork' },
      { type: 'text', text: 'c' },
    ]
    expect(normalizeSegmentOrder(segs).map((s) => s.type)).toEqual([
      'slash',
      'slash',
      'text',
      'text',
      'text',
    ])
    expect(normalizeSegmentOrder(segs).slice(0, 2)).toEqual([
      { type: 'slash', name: 'compact' },
      { type: 'slash', name: 'fork' },
    ])
  })

  it('空数组返回空数组', () => {
    expect(normalizeSegmentOrder([])).toEqual([])
  })
})

describe('slash segment（D4-b 命令段 + D4-c 归位）', () => {
  it('slash segment 序列化为 /name（name 不含前缀，serializer 补 /）', () => {
    expect(segmentsToText([{ type: 'slash', name: 'compact' }])).toBe('/compact')
  })

  it('slash 段在首时零重排：单 slash 段归位产物以 /cmd 开头', () => {
    const segs: Segment[] = [
      { type: 'slash', name: 'compact' },
      { type: 'text', text: '清理一下' },
    ]
    // slash→text 边界：chip→text 规则补空格
    expect(segmentsToText(segs)).toBe('/compact 清理一下')
  })

  it('slash 段在中部时提最前，其余段保持原序（归位产物与现状强制最前除边界空格外逐字相同）', () => {
    const segs: Segment[] = [
      { type: 'text', text: '任务描述' },
      { type: 'slash', name: 'compact' },
      { type: 'text', text: '清理一下' },
    ]
    // 归位后 slash 提首（prev=null 不补空格）；slash→text 边界补一个空格；
    // 两个 text 段间不补。本用例锁的是**新行为**：产物与现状（chip 强制最前）除边界空格外
    // 逐字相同（D4-e）——该空格是修正而非等价：现状产物 `/compact任务描述清理一下` 首 token
    // 粘连正文（非法命令名），pi 侧命令静默失效、按字面文本处理
    expect(segmentsToText(segs)).toBe('/compact 任务描述清理一下')
  })

  it('slash + 其他 chip 混合序：slash 提首，chip→chip 边界补空格', () => {
    const segs: Segment[] = [
      { type: 'skill', name: 'review' },
      { type: 'slash', name: 'compact' },
      { type: 'file', path: 'src/a.ts' },
    ]
    // 归位序：slash, skill, file。slash→skill chip→chip 补空格；skill→file 同理
    expect(segmentsToText(segs)).toBe('/compact <taiji-skill name="review"/> src/a.ts')
  })

  it('无 slash 段零变化（回归：归位 filter 不影响既有类型序列）', () => {
    const segs: Segment[] = [
      { type: 'text', text: '看看' },
      { type: 'session', sessionId: 'sid-1', label: '会话 A' },
      { type: 'text', text: '的讨论' },
    ]
    expect(segmentsToText(segs)).toBe('看看#sid-1 的讨论')
  })

  it('多个 slash 段防御性全前置按原序（正常态至多一个）', () => {
    const segs: Segment[] = [
      { type: 'text', text: 'a' },
      { type: 'slash', name: 'compact' },
      { type: 'text', text: 'b' },
      { type: 'slash', name: 'fork' },
      { type: 'text', text: 'c' },
    ]
    // slash→slash chip→chip 补空格；slash→text 补空格（text 无前导空格）；text→text 不补
    expect(segmentsToText(segs)).toBe('/compact /fork abc')
  })

  it('needsBoundarySpace：text 前导空格开头时 slash→text 不重复补空格', () => {
    const segs: Segment[] = [
      { type: 'slash', name: 'compact' },
      { type: 'text', text: ' 清理' },
    ]
    expect(segmentsToText(segs)).toBe('/compact 清理')
  })

  it('text→slash 方向不补空格（与 file/skill chip 边界规则一致）——归位后不存在该边界，锁 needsBoundarySpace 单段语义', () => {
    // 归位恒把 slash 提首，段序上不再出现 text→slash 边界；此处通过 slash+text 前置
    // 空格用例（上一条）已覆盖 chip→text 分支，本条锁 slash 视同 chip 类段的行为：
    // slash 紧跟 slash（同 chip 类）补空格，见「多 slash 前置」用例
    expect(segmentsToPrompt([{ type: 'slash', name: 'compact' }])).toBe('/compact')
  })
})
