/**
 * trace-window 纯函数单测（streaming-trace-window::core wave）。
 *
 * 覆盖 TC1-TC7 共 7 类场景 + design-review G1（非末位 text 不收集）+ G2（streaming assistant
 * 末尾多非 text 块的去重）。每条断言 visible 的 flatIndex 序列 + compactedCount + failedCount 精确值。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/trace-window.test.ts
 */
import { describe, it, expect } from 'vitest'
import { flattenTurnBlocks, computeTraceWindow, W } from '../trace-window'
import type { FlatBlock } from '../trace-window'
import type { Message, ToolCall, ThinkingBlock } from '@taiji/shared'

// ── fixture 构造 helper ───────────────────────────────────────────────

let toolSeq = 0
let thinkSeq = 0

function makeThinking(over: Partial<ThinkingBlock> = {}): ThinkingBlock {
  thinkSeq += 1
  return { id: over.id ?? `t${thinkSeq}`, content: over.content ?? 'think', collapsed: false }
}

function makeTool(over: Partial<ToolCall> = {}): ToolCall {
  toolSeq += 1
  return {
    id: over.id ?? `tc${toolSeq}`,
    toolName: over.toolName ?? 'bash',
    input: over.input ?? {},
    status: over.status ?? 'completed',
    startTime: over.startTime ?? 0,
  }
}

/** 构造 assistant Message：按 contentBlocks 顺序解出，自动建对应的 thinking/toolCalls。 */
function makeAssistant(
  over: Partial<Message> & {
    thinkingBlocks?: ThinkingBlock[]
    tools?: ToolCall[]
    blocks?: Array<{ type: 'thinking' | 'toolCall' | 'text'; refId: string }>
  },
): Message {
  const id = over.id ?? 'a1'
  const thinkingBlocks = over.thinkingBlocks ?? []
  const tools = over.tools ?? []
  return {
    id,
    role: 'assistant',
    content: over.content ?? '',
    status: over.status ?? 'complete',
    timestamp: 0,
    thinking: thinkingBlocks.length ? thinkingBlocks : undefined,
    toolCalls: tools.length ? tools : undefined,
    contentBlocks: over.blocks,
  }
}

/** flatIndex 序列提取 helper（断言用）。 */
function flatIndices(visible: FlatBlock[]): number[] {
  return visible.map((fb) => fb.flatIndex)
}

// ── TC1：空块拍平与窗口返回空 ────────────────────────────────────────

describe('TC1 空块拍平与窗口返回空', () => {
  it('flattenTurnBlocks([]) 返回 []', () => {
    expect(flattenTurnBlocks([])).toEqual([])
  })

  it('computeTraceWindow([], takeover=false) 返回空结果', () => {
    expect(computeTraceWindow([], { windowSize: W, takeover: false })).toEqual({
      visible: [],
      compactedCount: 0,
      failedCount: 0,
    })
  })

  it('computeTraceWindow([], takeover=true) 返回空结果', () => {
    expect(computeTraceWindow([], { windowSize: W, takeover: true })).toEqual({
      visible: [],
      compactedCount: 0,
      failedCount: 0,
    })
  })
})

// ── TC2：单 assistant 单块基础拍平与窗口 ─────────────────────────────

describe('TC2 单 assistant 单 thinking 块', () => {
  const th = makeThinking({ id: 't1', content: 'hello-think' })
  const a1 = makeAssistant({
    id: 'a1',
    status: 'complete',
    thinkingBlocks: [th],
    blocks: [{ type: 'thinking', refId: 't1' }],
  })

  it('flatten 返回 1 个 FlatBlock，透传 assistantId/Status，flatIndex=0', () => {
    const flat = flattenTurnBlocks([a1])
    expect(flat).toHaveLength(1)
    expect(flat[0].assistantId).toBe('a1')
    expect(flat[0].assistantStatus).toBe('complete')
    expect(flat[0].flatIndex).toBe(0)
    expect(flat[0].block.kind).toBe('thinking')
    expect((flat[0].block.ref as ThinkingBlock).id).toBe('t1')
  })

  it('窗口 visible 含该块，计数为 0', () => {
    const flat = flattenTurnBlocks([a1])
    const res = computeTraceWindow(flat, { windowSize: W, takeover: false })
    expect(flatIndices(res.visible)).toEqual([0])
    expect(res.compactedCount).toBe(0)
    expect(res.failedCount).toBe(0)
  })
})

// ── TC3：全 failed retry-loop 的 failedCount ──────────────────────────

describe('TC3 全 failed retry-loop', () => {
  // 5 个 tool 块全部 status='error'（典型 retry-loop 失败重试场景）
  const tools: ToolCall[] = []
  const blocks: Array<{ type: 'toolCall'; refId: string }> = []
  for (let i = 0; i < 5; i++) {
    const id = `tc${i}`
    tools.push(makeTool({ id, status: 'error' }))
    blocks.push({ type: 'toolCall', refId: id })
  }
  const a1 = makeAssistant({ id: 'a1', status: 'complete', tools, blocks })
  const flat = flattenTurnBlocks([a1])

  it('flatten 返回 5 个 tool 块，flatIndex 0-4', () => {
    expect(flat).toHaveLength(5)
    expect(flat.every((fb) => fb.block.kind === 'tool')).toBe(true)
    expect(flatIndices(flat)).toEqual([0, 1, 2, 3, 4])
  })

  it('takeover=false: visible=[], compactedCount=0, failedCount=5（error 不计已完成过程块）', () => {
    const res = computeTraceWindow(flat, { windowSize: W, takeover: false })
    expect(res.visible).toEqual([])
    expect(res.compactedCount).toBe(0)
    expect(res.failedCount).toBe(5)
  })

  it('takeover=true: visible 全量 5，计数归零', () => {
    const res = computeTraceWindow(flat, { windowSize: W, takeover: true })
    expect(flatIndices(res.visible)).toEqual([0, 1, 2, 3, 4])
    expect(res.compactedCount).toBe(0)
    expect(res.failedCount).toBe(0)
  })
})

// ── TC4：多 assistant 混合时序与进行中块（硬编码 fixture + 确定期望值） ──

describe('TC4 多 assistant 混合（2 assistant: complete + streaming）', () => {
  // 硬编码 fixture：
  //  a1 status='complete': contentBlocks=[thinking(t1), toolCall(tc1 completed), text]
  //    → expand = [thinking, tool, text] → flatIndex 0,1,2
  //  a2 status='streaming': contentBlocks=[toolCall(tc2 completed), thinking(t2)]
  //    → expand = [tool, thinking] → flatIndex 3,4
  const a1 = makeAssistant({
    id: 'a1',
    status: 'complete',
    content: 'hello-text',
    thinkingBlocks: [makeThinking({ id: 't1' })],
    tools: [makeTool({ id: 'tc1', status: 'completed' })],
    blocks: [
      { type: 'thinking', refId: 't1' },
      { type: 'toolCall', refId: 'tc1' },
      { type: 'text', refId: 'text' },
    ],
  })
  const a2 = makeAssistant({
    id: 'a2',
    status: 'streaming',
    thinkingBlocks: [makeThinking({ id: 't2' })],
    tools: [makeTool({ id: 'tc2', status: 'completed' })],
    blocks: [
      { type: 'toolCall', refId: 'tc2' },
      { type: 'thinking', refId: 't2' },
    ],
  })
  const flat = flattenTurnBlocks([a1, a2])

  it('flatten flatIndex 跨 a1/a2 连续 0..4，kind 与 assistantId 正确', () => {
    expect(flat).toHaveLength(5)
    expect(flatIndices(flat)).toEqual([0, 1, 2, 3, 4])
    // a1: fb0=thinking, fb1=tool(tc1), fb2=text
    expect(flat[0]).toMatchObject({ assistantId: 'a1', assistantStatus: 'complete' })
    expect(flat[0].block.kind).toBe('thinking')
    expect(flat[1].block.kind).toBe('tool')
    expect(flat[2].block.kind).toBe('text')
    // a2: fb3=tool(tc2), fb4=thinking
    expect(flat[3]).toMatchObject({ assistantId: 'a2', assistantStatus: 'streaming' })
    expect(flat[3].block.kind).toBe('tool')
    expect(flat[4].block.kind).toBe('thinking')
  })

  it('takeover=false, W=6: visible=[0,1,2,3,4]，进行中块(fb4)+末位text(fb2)+全部已完成过程块(fb0,fb1,fb3)', () => {
    const res = computeTraceWindow(flat, { windowSize: W, takeover: false })
    // ①末位text=fb2(2) ②进行中=a2末尾非text=fb4(4) ③已完成过程块池=[fb0,fb1,fb3](3，W=6全收)
    expect(flatIndices(res.visible)).toEqual([0, 1, 2, 3, 4])
    expect(res.compactedCount).toBe(0) // ③池3 − visible内③=3
    expect(res.failedCount).toBe(0)
  })

  it('G2 子用例：streaming assistant 末尾含 [thinking, toolCall] 时②取 toolCall', () => {
    // 单 streaming assistant：contentBlocks=[thinking, toolCall]（toolCall 在最末）
    //   expand = [thinking, tool] → flatIndex 0,1
    //   ②进行中 = 末尾非text = fb1(tool, flatIndex1)；fb0(thinking) 归③
    const sa = makeAssistant({
      id: 'sa',
      status: 'streaming',
      thinkingBlocks: [makeThinking({ id: 'st1' })],
      tools: [makeTool({ id: 'stc1', status: 'completed' })],
      blocks: [
        { type: 'thinking', refId: 'st1' },
        { type: 'toolCall', refId: 'stc1' },
      ],
    })
    const f = flattenTurnBlocks([sa])
    expect(flatIndices(f)).toEqual([0, 1])
    const res = computeTraceWindow(f, { windowSize: W, takeover: false })
    // ②取 toolCall(flatIndex1)，thinking(flatIndex0)归③，两者去重后都在 visible
    expect(flatIndices(res.visible)).toEqual([0, 1])
    expect(res.compactedCount).toBe(0) // ③池1(thinking) − visible内③=1
    expect(res.failedCount).toBe(0)
    // 明确：visible 里 flatIndex1 的块是 tool（被②收入），flatIndex0 是 thinking（③收入）
    const byIdx = new Map(res.visible.map((fb) => [fb.flatIndex, fb]))
    expect(byIdx.get(1)!.block.kind).toBe('tool')
    expect(byIdx.get(0)!.block.kind).toBe('thinking')
  })
})

// ── TC5：窗口边界 W=8（7 / 8 / 9 个 completed tool） ──────────────────

describe('TC5 窗口边界 W=6', () => {
  function makeNCompletedTools(n: number): Message {
    const tools: ToolCall[] = []
    const blocks: Array<{ type: 'toolCall'; refId: string }> = []
    for (let i = 0; i < n; i++) {
      const id = `tc${i}`
      tools.push(makeTool({ id, status: 'completed' }))
      blocks.push({ type: 'toolCall', refId: id })
    }
    return makeAssistant({ id: 'a1', status: 'complete', tools, blocks })
  }

  it('5 个 completed tool: visible=[0..4], compactedCount=0', () => {
    const flat = flattenTurnBlocks([makeNCompletedTools(5)])
    const res = computeTraceWindow(flat, { windowSize: W, takeover: false })
    expect(flatIndices(res.visible)).toEqual([0, 1, 2, 3, 4])
    expect(res.compactedCount).toBe(0)
    expect(res.failedCount).toBe(0)
  })

  it('6 个 completed tool: visible=[0..5], compactedCount=0', () => {
    const flat = flattenTurnBlocks([makeNCompletedTools(6)])
    const res = computeTraceWindow(flat, { windowSize: W, takeover: false })
    expect(flatIndices(res.visible)).toEqual([0, 1, 2, 3, 4, 5])
    expect(res.compactedCount).toBe(0)
    expect(res.failedCount).toBe(0)
  })

  it('7 个 completed tool: visible=[1..6]（最近6个=flatIndex最大者）, compactedCount=1（收编flatIndex0）', () => {
    const flat = flattenTurnBlocks([makeNCompletedTools(7)])
    const res = computeTraceWindow(flat, { windowSize: W, takeover: false })
    expect(flatIndices(res.visible)).toEqual([1, 2, 3, 4, 5, 6])
    expect(res.compactedCount).toBe(1)
    expect(res.failedCount).toBe(0)
  })
})

// ── TC6：takeover=true 全展 ───────────────────────────────────────────

describe('TC6 takeover=true 全展', () => {
  it('混合 blocks（含 error tool + completed tool + thinking + text）全量可见计数归零', () => {
    // 复用 TC4 的混合 fixture
    const a1 = makeAssistant({
      id: 'a1',
      status: 'complete',
      content: 'txt',
      thinkingBlocks: [makeThinking({ id: 't1' })],
      tools: [
        makeTool({ id: 'tc1', status: 'completed' }),
        makeTool({ id: 'tc2', status: 'error' }),
      ],
      blocks: [
        { type: 'thinking', refId: 't1' },
        { type: 'toolCall', refId: 'tc1' },
        { type: 'toolCall', refId: 'tc2' },
        { type: 'text', refId: 'text' },
      ],
    })
    const flat = flattenTurnBlocks([a1])
    expect(flatIndices(flat)).toEqual([0, 1, 2, 3])
    const res = computeTraceWindow(flat, { windowSize: W, takeover: true })
    expect(flatIndices(res.visible)).toEqual([0, 1, 2, 3])
    expect(res.compactedCount).toBe(0)
    expect(res.failedCount).toBe(0)
  })
})

// ── TC7：failedCount 不计入 compactedCount（独立性） ──────────────────

describe('TC7 failedCount 独立性（3 completed + 2 error）', () => {
  // 5 个 tool 块：tc0,tc1,tc2 completed；tc3,tc4 error（flatIndex 0-4）
  const tools: ToolCall[] = [
    makeTool({ id: 'tc0', status: 'completed' }),
    makeTool({ id: 'tc1', status: 'completed' }),
    makeTool({ id: 'tc2', status: 'completed' }),
    makeTool({ id: 'tc3', status: 'error' }),
    makeTool({ id: 'tc4', status: 'error' }),
  ]
  const blocks: Array<{ type: 'toolCall'; refId: string }> = tools.map((t) => ({
    type: 'toolCall',
    refId: t.id,
  }))
  const a1 = makeAssistant({ id: 'a1', status: 'complete', tools, blocks })
  const flat = flattenTurnBlocks([a1])

  it('已完成过程块=3(completed)，visible 含全部 3，error 不进任何可见类', () => {
    const res = computeTraceWindow(flat, { windowSize: W, takeover: false })
    expect(flatIndices(res.visible)).toEqual([0, 1, 2])
    expect(res.compactedCount).toBe(0) // ③池3 − visible内③=3
    expect(res.failedCount).toBe(2) // 2 个 error 全在收编区
  })
})

// ── G1：非末位 text 块不进 visible ────────────────────────────────────

describe('G1 text 收集规则：全 turn 末位 text（单个，不按 assistant 分组）', () => {
  it('单 assistant 多个 text（过渡碎片）→ 仅末位 text 进 visible，前面的不收集', () => {
    // a1 含 3 个 text block（流式过渡碎片）→ ①只留末位（flatIndex 2），前两个不收集
    const a1 = makeAssistant({
      id: 'a1',
      status: 'complete',
      content: 'third-text',
      blocks: [
        { type: 'text', refId: 'text' },
        { type: 'text', refId: 'text' },
        { type: 'text', refId: 'text' },
      ],
    })
    const flat = flattenTurnBlocks([a1])
    expect(flatIndices(flat)).toEqual([0, 1, 2])
    const res = computeTraceWindow(flat, { windowSize: W, takeover: false })
    // ①单 assistant 末位 text = flatIndex 2；前两个过渡碎片不收集
    expect(flatIndices(res.visible)).toEqual([2])
    expect(res.compactedCount).toBe(0)
    expect(res.failedCount).toBe(0)
  })

  it('多 assistant 各含 text → 只保留全 turn 最后 text（tool 循环协议防爆炸，2026-08-14 修正）', () => {
    // a1: text → flatIndex 0；a2: text → flatIndex 1（多 assistant turn，各自完整回复）
    const a1 = makeAssistant({
      id: 'a1',
      status: 'complete',
      content: 'first-text',
      blocks: [{ type: 'text', refId: 'text' }],
    })
    const a2 = makeAssistant({
      id: 'a2',
      status: 'complete',
      content: 'second-text',
      blocks: [{ type: 'text', refId: 'text' }],
    })
    const flat = flattenTurnBlocks([a1, a2])
    expect(flatIndices(flat)).toEqual([0, 1])
    const res = computeTraceWindow(flat, { windowSize: W, takeover: false })
    // ①全 turn 末位 text（单个，flatIndex 最大者）——不按 assistant 分组（tool 循环协议防爆炸）
    expect(flatIndices(res.visible)).toEqual([1])
    expect(res.compactedCount).toBe(0)
    expect(res.failedCount).toBe(0)
  })
})

// ── TC-edge：边界态（0 streaming assistant）窗口稳定性（edges wave） ──────
// CL1/CL2 裁决固化：ask-user / compacting / forceWorking / G5（离线重开全 complete）等边界态下
// 无 streaming-status 的 assistant block，computeTraceWindow 的 ②进行中集合（inProgressByAssistant）
// 恒空，全部非 text 非 error 块进 ③已完成池 → 窗口 by-construction 稳定（不滑动、不收编进行中块）。
// core 纯函数按 assistant.status（而非 renderer 层 turn.isStreaming/forceWorking）判定进行中块，
// 是正确的层次分离（forceWorking 是 renderer 为 keepMounted 设的标记，不代表 assistant 真在 streaming）。
describe('TC-edge：边界态（0 streaming assistant）窗口稳定性', () => {
  it('case1: 全 complete 多块单 assistant（thinking+completed tool+error tool+text）→ ②空、visible=末位text+已完成过程块、failedCount 独立计数', () => {
    // 边界态 + error tool 组合（design-review sufficiency minor gap #2 加固）：
    // 验证 failedCount 在 ②进行中集合为空时仍正确独立计数（不因 ②空而误归 visible）。
    const a1 = makeAssistant({
      id: 'a1',
      status: 'complete',
      content: 'final-text',
      thinkingBlocks: [makeThinking({ id: 't1' })],
      tools: [
        makeTool({ id: 'tc1', status: 'completed' }),
        makeTool({ id: 'tc2', status: 'error' }),
      ],
      blocks: [
        { type: 'thinking', refId: 't1' },
        { type: 'toolCall', refId: 'tc1' },
        { type: 'toolCall', refId: 'tc2' },
        { type: 'text', refId: 'text' },
      ],
    })
    const flat = flattenTurnBlocks([a1])
    // flat = [thinking(0), tool-completed(1), tool-error(2), text(3)]
    expect(flatIndices(flat)).toEqual([0, 1, 2, 3])
    const res = computeTraceWindow(flat, { windowSize: W, takeover: false })
    // ②进行中集合空（无 streaming assistant）
    // ③已完成池 = [thinking(0), tool-completed(1)]（error 不进③）；①末位text = text(3)
    // error tool(2) 不在 visible → failedCount=1
    expect(flatIndices(res.visible)).toEqual([0, 1, 3])
    expect(res.compactedCount).toBe(0)
    expect(res.failedCount).toBe(1)
  })

  it('case2: 全 complete 跨 assistant（flatIndex 连续）+ error tool → ②空、visible 跨 assistant 正确、failedCount 独立', () => {
    const a1 = makeAssistant({
      id: 'a1',
      status: 'complete',
      tools: [
        makeTool({ id: 'tc1', status: 'completed' }),
        makeTool({ id: 'tc2', status: 'error' }),
      ],
      blocks: [
        { type: 'toolCall', refId: 'tc1' },
        { type: 'toolCall', refId: 'tc2' },
      ],
    })
    const a2 = makeAssistant({
      id: 'a2',
      status: 'complete',
      content: 'final-text',
      thinkingBlocks: [makeThinking({ id: 't2' })],
      blocks: [
        { type: 'thinking', refId: 't2' },
        { type: 'text', refId: 'text' },
      ],
    })
    const flat = flattenTurnBlocks([a1, a2])
    // flat = [a1.tool-completed(0), a1.tool-error(1), a2.thinking(2), a2.text(3)]
    expect(flatIndices(flat)).toEqual([0, 1, 2, 3])
    const res = computeTraceWindow(flat, { windowSize: W, takeover: false })
    // ②空；③已完成池 = [tool-completed(0), thinking(2)]；①末位text = text(3)
    // error(1) → failedCount=1
    expect(flatIndices(res.visible)).toEqual([0, 2, 3])
    expect(res.compactedCount).toBe(0)
    expect(res.failedCount).toBe(1)
  })

  it('case3: 空 assistants（dispatching 占位 → flatten→[]）→ visible 空、计数归零', () => {
    // dispatching 空窗期：user 已发、message_start 未到，assistants=[]。
    // flattenTurnBlocks([]) → []；computeTraceWindow 首行 return 空結果（窗口稳定，不崩）。
    const flat = flattenTurnBlocks([])
    expect(flat).toEqual([])
    const res = computeTraceWindow(flat, { windowSize: W, takeover: false })
    expect(res).toEqual({ visible: [], compactedCount: 0, failedCount: 0 })
  })

  it('case4: 纯函数稳定性——相同输入两次调用结果 deep equal（takeover false/true 均验）', () => {
    const a1 = makeAssistant({
      id: 'a1',
      status: 'complete',
      content: 'final-text',
      thinkingBlocks: [makeThinking({ id: 't1' })],
      tools: [
        makeTool({ id: 'tc1', status: 'completed' }),
        makeTool({ id: 'tc2', status: 'error' }),
      ],
      blocks: [
        { type: 'thinking', refId: 't1' },
        { type: 'toolCall', refId: 'tc1' },
        { type: 'toolCall', refId: 'tc2' },
        { type: 'text', refId: 'text' },
      ],
    })
    const flat = flattenTurnBlocks([a1])
    // takeover=false 两次调用 deep equal
    const r1 = computeTraceWindow(flat, { windowSize: W, takeover: false })
    const r2 = computeTraceWindow(flat, { windowSize: W, takeover: false })
    expect(r1).toEqual(r2)
    // takeover=true 两次调用 deep equal
    const t1 = computeTraceWindow(flat, { windowSize: W, takeover: true })
    const t2 = computeTraceWindow(flat, { windowSize: W, takeover: true })
    expect(t1).toEqual(t2)
  })
})
