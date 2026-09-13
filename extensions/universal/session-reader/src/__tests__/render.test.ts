import { describe, it, expect } from 'vitest'
import { renderOutline, renderExpand, renderDetail, type ToolResultSummaryEntry } from '../core/render.js'
import type { Entry } from '../core/parser.js'
import type { Turn } from '../core/turns.js'
import type { TreeView } from '../core/tree.js'
import { parseSessionFile } from '../core/parser.js'
import { buildTreeView } from '../core/tree.js'
import { segmentTurns } from '../core/turns.js'
import { REAL_SESSION, HAS_REAL_SESSION } from './real-data.js'

// ---- 构造助手 ----

function uEntry(id: string, text: string): Entry {
  return {
    type: 'message',
    id,
    parentId: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

function aEntry(
  id: string,
  text: string,
  toolCalls?: Array<{ name: string; id?: string; arguments?: Record<string, unknown> }>,
  thinking?: string,
): Entry {
  // v2：toolCalls 进 content 的 toolCall block（真实结构，probe 实测 519），不再设 message.toolCalls
  const content: unknown[] = [{ type: 'text', text }]
  if (thinking !== undefined) content.push({ type: 'thinking', thinking })
  if (toolCalls !== undefined) {
    for (const tc of toolCalls) {
      content.push({
        type: 'toolCall',
        id: tc.id ?? `call_${tc.name}`,
        name: tc.name,
        arguments: tc.arguments ?? {},
      })
    }
  }
  return { type: 'message', id, parentId: null, message: { role: 'assistant', content } }
}

function tEntry(
  id: string,
  content: string,
  opts?: { toolCallId?: string; toolName?: string },
): Entry {
  // v2：content 保持 string（测试简化，toolResultText 对 string/数组都处理）；
  // 加 toolCallId/toolName 供 O2 类型化摘要关联测试
  const message: NonNullable<Entry['message']> = { role: 'toolResult', content }
  if (opts?.toolName !== undefined) message.toolName = opts.toolName
  if (opts?.toolCallId !== undefined) message.toolCallId = opts.toolCallId
  return { type: 'message', id, parentId: null, message }
}

function turn(
  idx: number,
  entries: Entry[],
  opts: { userEntry?: Entry; isCompaction?: boolean; startTime?: string } = {},
): Turn {
  const t: Turn = {
    index: idx,
    entries,
    userEntry: opts.userEntry,
    isCompaction: opts.isCompaction ?? false,
  }
  if (opts.startTime !== undefined) t.startTime = opts.startTime
  return t
}

function emptyTree(): TreeView {
  return { leafPath: [], branches: new Map(), orphans: [] }
}

describe('renderOutline', () => {
  it('1. 预算充足 → 全部字段完整渲染（userBrief 截断 / toolSummary 聚合 / omittedBytes 正确）', () => {
    const t = turn(0, [
      uEntry('U', 'do something'),
      aEntry('A', 'sure', [{ name: 'bash' }, { name: 'bash' }, { name: 'read' }, { name: 'read' }], 'secret'),
      tEntry('T', 'output'),
    ], { userEntry: uEntry('U', 'do something') })

    const result = renderOutline([t], emptyTree(), { budget: 2000 })
    const b = result.turns[0]

    expect(b.userBrief).toBe('do something') // 12 chars，未截断
    expect(b.toolSummary).toBe('bash×2,read×2')
    expect(b.assistantBrief).toBe('sure')
    // thinking 'secret'(6B) + toolResult 'output'(6B)
    expect(b.omittedBytes).toBe(12)
    expect(result.truncated).toBeUndefined()
    // E7 行渲染统一：lines 随结果返回，与 turns 一一对应（预算度量 = 展示行同一份）
    expect(result.lines).toEqual(['T000 · do something · bash×2,read×2 · → sure · [12B omitted]'])
  })

  it('2a. 降级：单行 toolSummary 过长超 perTurnBudget → 砍 toolSummary，保 userBrief 骨架', () => {
    // 预算紧张降级后 L1 行不含 assistantBrief（预算充足 level 0 行含）；budget=40, 3 turns → perTurnCharBudget≈53
    // 行 = head + userBrief(10) + toolSummary(20 个工具名≈63 chars) → ~80 > 53 → 砍 toolSummary
    const toolCalls = Array.from({ length: 20 }, (_, k) => ({ name: `t${String(k).padStart(2, '0')}` }))
    const turns = [0, 1, 2].map((i) =>
      turn(i, [uEntry(`U${i}`, 'u'.repeat(10)), aEntry(`A${i}`, 'a'.repeat(10), toolCalls)], {
        userEntry: uEntry(`U${i}`, 'u'.repeat(10)),
      }),
    )
    const result = renderOutline(turns, emptyTree(), { budget: 40 })

    expect(result.turns).toHaveLength(3)
    for (const b of result.turns) {
      expect(b.toolSummary).toBe('') // 被砍（降级）
      expect(b.userBrief).toBe('u'.repeat(10)) // 骨架保留
    }
    // E7：降级后的渲染行（骨架形态）与 briefs 字段同步——行内无 → 结论段、无工具聚合段
    expect(result.lines).toHaveLength(3)
    expect(result.lines).toEqual(['T000 · uuuuuuuuuu', 'T001 · uuuuuuuuuu', 'T002 · uuuuuuuuuu'])
    expect(result.truncated).toBeUndefined()
  })

  it('2b. 降级（砍 assistantBrief 档）：行内 → 结论段消失、toolSummary 保留，与改前语义一致', () => {
    // budget=20 → perTurnCharBudget=80；level 0 行 = T000 · u*10 · bash×2 · → a*80… ≈112 > 80
    // → 砍 assistantBrief 后 ≈26 ≤ 80 停（S3：该档形态与改前 handler 侧渲染降级后 briefs 等价）
    const t = turn(
      0,
      [uEntry('U', 'u'.repeat(10)), aEntry('A', 'a'.repeat(100), [{ name: 'bash' }, { name: 'bash' }])],
      { userEntry: uEntry('U', 'u'.repeat(10)) },
    )
    const result = renderOutline([t], emptyTree(), { budget: 20 })

    expect(result.turns[0].assistantBrief).toBe('') // 被砍
    expect(result.turns[0].toolSummary).toBe('bash×2') // 保留
    expect(result.lines).toEqual(['T000 · uuuuuuuuuu · bash×2'])
    expect(result.truncated).toBeUndefined()
  })

  it('3. 总超预算 → truncated 计数 > 0（从尾部丢弃）', () => {
    // budget=10, 5 turns → 每行降级到骨架 17 chars；total 85/4=21>10 → 截断保留 2，truncated=3
    const turns = [0, 1, 2, 3, 4].map((i) =>
      turn(i, [uEntry(`U${i}`, 'u'.repeat(10)), aEntry(`A${i}`, 'a'.repeat(10))], {
        userEntry: uEntry(`U${i}`, 'u'.repeat(10)),
      }),
    )
    const result = renderOutline(turns, emptyTree(), { budget: 10 })

    expect(result.truncated).toBe(3)
    expect(result.turns).toHaveLength(2)
    // E7：lines 与 turns 同步截短（truncateToTotalBudget 双数组一致）
    expect(result.lines).toHaveLength(2)
  })

  it('4. toolSummary 聚合：同名计数 ×N，不同名逗号分隔', () => {
    const t = turn(
      0,
      [uEntry('U', 'q'), aEntry('A', 'r', [{ name: 'bash' }, { name: 'bash' }, { name: 'read' }, { name: 'read' }, { name: 'edit' }])],
      { userEntry: uEntry('U', 'q') },
    )
    const result = renderOutline([t], emptyTree(), { budget: 2000 })
    expect(result.turns[0].toolSummary).toBe('bash×2,read×2,edit')
  })

  it('5. omittedBytes = toolResult content + thinking 字节和', () => {
    const t = turn(
      0,
      [uEntry('U', 'q'), aEntry('A', 'r', undefined, 'th'), tEntry('T', 'out')],
      { userEntry: uEntry('U', 'q') },
    )
    const result = renderOutline([t], emptyTree(), { budget: 2000 })
    // thinking 'th'(2B) + toolResult 'out'(3B) = 5
    expect(result.turns[0].omittedBytes).toBe(5)
  })

  it('6. granularity:entry → 不聚合，每 entry 一行', () => {
    const turns = [
      turn(0, [uEntry('U0', 'a'), aEntry('A0', 'b')], { userEntry: uEntry('U0', 'a') }),
      turn(1, [uEntry('U1', 'c')], { userEntry: uEntry('U1', 'c') }),
    ]
    const result = renderOutline(turns, emptyTree(), { granularity: 'entry', budget: 2000 })
    // 3 leaf entries → 3 行
    expect(result.turns).toHaveLength(3)
    expect(result.turns.map((b) => b.index)).toEqual([0, 1, 2])
  })

  it('7. allBranches:true → forkPoint 处标注 branch', () => {
    const tree: TreeView = { leafPath: ['U'], branches: new Map([['U', 3]]), orphans: [] }
    const userEntry = uEntry('U', 'hi')
    const turns = [turn(0, [userEntry], { userEntry })]

    const withBranches = renderOutline(turns, tree, { allBranches: true })
    expect(withBranches.turns[0].branch).toBe('U')

    const withoutBranches = renderOutline(turns, tree, { allBranches: false })
    expect(withoutBranches.turns[0].branch).toBeUndefined()
  })

  it('7b. E7 旁支标记统一：渲染行 `[旁支 N entries]`（N = 该 forkPoint 下旁支子树 entry 数）', () => {
    // branches: U → 3 entries 旁支子树（E7/D3：outline 与 export 两条路径共用此形态）
    const tree: TreeView = { leafPath: ['U'], branches: new Map([['U', 3]]), orphans: [] }
    const userEntry = uEntry('U', 'hi')
    const turns = [turn(0, [userEntry], { userEntry })]

    const result = renderOutline(turns, tree, { allBranches: true })
    expect(result.lines).toEqual(['T000 · hi · [旁支 3 entries]'])
    // branchSize 缺失（allBranches:false）不标旁支
    const noBranch = renderOutline(turns, tree, { allBranches: false })
    expect(noBranch.lines).toEqual(['T000 · hi'])
  })

  it.skipIf(!HAS_REAL_SESSION)('8. 真实 019e6c96：outline tokenEstimate <= 1500 + assistantBrief/toolSummary 非空（v2 O1）', async () => {
    // v2 O1：加 assistantBrief + 修 toolSummary bug 后 outline 变长，阈值 600→1500（design §3.3 D4）
    const parsed = await parseSessionFile(REAL_SESSION)
    const tree = buildTreeView(parsed.entries)
    const turns = segmentTurns(parsed.entries, new Set(tree.leafPath))
    const result = renderOutline(turns, tree, { budget: 2000 })

    expect(result.turns.length).toBe(32)
    expect(result.tokenEstimate).toBeLessThanOrEqual(1500)
    // v2 O1 验证：assistant 结论行存在（非空）+ toolSummary 显示真实工具（修 v1 恒空 bug）
    expect(result.turns.some((b) => b.assistantBrief !== '')).toBe(true)
    expect(result.turns.some((b) => b.toolSummary !== '')).toBe(true)
    // stats 完整性
    expect(result.stats.totalTurns).toBe(32)
    // totalEntries 近似（leaf+branch+orphan）不含 session header（segmentTurns 规则1 跳过）；
    // 工具层仅覆盖 stats.totalBytes 与 skippedLines（ParseResult 无 totalEntries 字段）。M1 验量级。
    expect(result.stats.totalEntries).toBeGreaterThan(1000)
    // 5.6MB 全量解析在并发/高负载下可能超 vitest 默认 5s，显式放宽
  }, 60000)
})

describe('renderExpand', () => {
  it('单轮展开：header 含 entry 数 + 每个 entry brief', () => {
    const t = turn(
      0,
      [uEntry('U', 'hello world'), aEntry('A', 'ok'), tEntry('T', 'result text')],
      { userEntry: uEntry('U', 'hello world'), startTime: '2026-05-28T03:17:12.844Z' },
    )
    const out = renderExpand(t)

    expect(out.turn).toContain('3 entries')
    expect(out.turn).toContain('03:17')
    expect(out.entries).toHaveLength(3)
    expect(out.entries[0]).toMatchObject({ index: 0, type: 'message', role: 'user' })
    expect(out.entries[0].brief).toBe('hello world')
    expect(out.entries[1].role).toBe('assistant')
    expect(out.entries[2].role).toBe('toolResult')
    // toolResult 的 omittedBytes = content 字节
    expect(out.entries[2].omittedBytes).toBe(Buffer.byteLength('result text', 'utf8'))
  })

  it('v2 O2：toolResult 类型化摘要（bash: <cmd> (N行)，toolCallId 关联取 args）', () => {
    // 构造带 toolCallId 关联的 turn：assistant 调 bash，toolResult 靠 toolCallId 关联回去取 command
    const tcId = 'call_bash1'
    const t = turn(
      0,
      [
        uEntry('U', '查一下文件'),
        aEntry('A', '好的', [{ name: 'bash', id: tcId, arguments: { command: 'ls -la src/' } }]),
        tEntry('T', 'file1\nfile2\nfile3', { toolCallId: tcId, toolName: 'bash' }),
      ],
      { userEntry: uEntry('U', '查一下文件') },
    )
    const out = renderExpand(t)
    const trBrief = out.entries.find((e) => e.role === 'toolResult')!
    // 类型化摘要：bash: <cmd> (N行)，不是结果文本前 100 字（file1/file2...）
    expect(trBrief.brief).toContain('bash: ls -la src/')
    expect(trBrief.brief).toContain('3行')
    expect(trBrief.brief).not.toContain('file1')
  })

  it('v2 O2：read/edit/write 等工具的类型化摘要', () => {
    const t = turn(
      0,
      [
        uEntry('U', '改代码'),
        aEntry('A1', '读文件', [{ name: 'read', id: 'r1', arguments: { path: '/a/b/src/index.ts' } }]),
        tEntry('TR1', 'content', { toolCallId: 'r1', toolName: 'read' }),
        aEntry('A2', '编辑', [{ name: 'edit', id: 'e1', arguments: { path: '/a/b/foo.ts', edits: [{}, {}] } }]),
        tEntry('TR2', 'ok', { toolCallId: 'e1', toolName: 'edit' }),
        aEntry('A3', '写', [{ name: 'write', id: 'w1', arguments: { path: '/a/b/out.txt', content: 'x'.repeat(2048) } }]),
        tEntry('TR3', 'ok', { toolCallId: 'w1', toolName: 'write' }),
      ],
      { userEntry: uEntry('U', '改代码') },
    )
    const out = renderExpand(t)
    const briefs = out.entries.filter((e) => e.role === 'toolResult').map((e) => e.brief)
    // read: read: index.ts (NKB)（结果 KB）
    expect(briefs[0]).toMatch(/^read: index\.ts \(\d+KB\)$/) // 点号转义
    // edit: edit: foo.ts (2 blocks)（参数 blocks）
    expect(briefs[1]).toBe('edit: foo.ts (2 blocks)')
    // write: write: out.txt (NKB)（参数 content KB）
    expect(briefs[2]).toMatch(/^write: out\.txt \(\d+KB\)$/) // 修正：out.txt
  })
})

describe('renderDetail', () => {
  it('默认 toolResult 摘要态（O3）+ thinking 剥离；includeToolResult/includeThinking 取回', () => {
    const t = turn(0, [
      uEntry('U', 'q'),
      aEntry('A', 'visible', undefined, 'hidden-thinking'),
      tEntry('T', 'tool-output'),
    ], { userEntry: uEntry('U', 'q') })

    // v2 O3：默认不再 continue 跳过 toolResult，条目数不减少（toolResult 变摘要态）
    const defaultOut = renderDetail([t])
    expect(defaultOut).toHaveLength(3)
    expect(defaultOut.some((e) => e.type === 'toolResultSummary')).toBe(true)
    // thinking 块被剥离（assistant 副本，无 thinking）
    const entries = defaultOut.filter((e): e is Entry => e.type !== 'toolResultSummary')
    const assistantDefault = entries.find((e) => e.message?.role === 'assistant')!
    expect(extractTextForTest(assistantDefault.message!.content)).toBe('visible')

    // includeToolResult：toolResult 原文 entry 回来（非摘要态）
    const withTool = renderDetail([t], { includeToolResult: true })
    expect(withTool).toHaveLength(3)
    expect(
      withTool.some(
        (e): e is Entry => e.type !== 'toolResultSummary' && e.message?.role === 'toolResult',
      ),
    ).toBe(true)

    // includeThinking：thinking 块回来
    const withThinking = renderDetail([t], { includeThinking: true })
    const entriesT = withThinking.filter((e): e is Entry => e.type !== 'toolResultSummary')
    const assistantThinking = entriesT.find((e) => e.message?.role === 'assistant')!
    expect(extractTextForTest(assistantThinking.message!.content)).toBe('visible')
    expect(extractThinkingForTest(assistantThinking.message!.content)).toBe('hidden-thinking')
  })

  it('v2 O3：renderDetail 默认摘要态 + includeToolResult 全文', () => {
    const tcId = 'call_r1'
    const t = turn(
      0,
      [
        uEntry('U', 'q'),
        aEntry('A', 'r', [{ name: 'read', id: tcId, arguments: { path: '/x/y/f.ts' } }]),
        tEntry('T', 'line1\nline2\nline3\nline4', { toolCallId: tcId, toolName: 'read' }),
      ],
      { userEntry: uEntry('U', 'q') },
    )

    // 默认摘要态
    const def = renderDetail([t])
    expect(def).toHaveLength(3)
    const summary = def.find(
      (e): e is ToolResultSummaryEntry => e.type === 'toolResultSummary',
    )!
    expect(summary).toBeDefined()
    expect(summary.summary).toMatch(/^read: f\.ts \(\d+KB\)$/)
    expect(summary.totalLines).toBe(4)
    expect(summary.headLines).toContain('line1')
    expect(summary.fullEntry.message?.role).toBe('toolResult')

    // includeToolResult 全文：返回原 Entry
    const full = renderDetail([t], { includeToolResult: true })
    expect(full).toHaveLength(3)
    expect(
      full.some(
        (e): e is Entry => e.type !== 'toolResultSummary' && e.message?.role === 'toolResult',
      ),
    ).toBe(true)
  })

  it('v2 S1：空 content 的 toolResult totalLines=0（与 formatToolResultSummary 口径一致）', () => {
    // 同一空 toolResult：summary 显示 "(0行)"，totalLines 必须也是 0（非 ''.split('\n') 的 1）
    const tcId = 'call_bash1'
    const t = turn(
      0,
      [
        uEntry('U', 'q'),
        aEntry('A', 'r', [{ name: 'bash', id: tcId, arguments: { command: 'ls' } }]),
        tEntry('T', '', { toolCallId: tcId, toolName: 'bash' }), // 空 content
      ],
      { userEntry: uEntry('U', 'q') },
    )
    const def = renderDetail([t])
    const summary = def.find(
      (e): e is ToolResultSummaryEntry => e.type === 'toolResultSummary',
    )!
    expect(summary).toBeDefined()
    expect(summary.totalLines).toBe(0) // 空结果 = 0 行（非 1）
    expect(summary.headLines).toBe('') // 空结果无头行
    // 对照：summary 文案也不含行数（formatToolResultSummary 空结果不 append (N行)）
    expect(summary.summary).not.toContain('行)')
  })
})

// 测试内联的类型守卫镜像（验证 renderDetail 剥离效果，不依赖 render 内部导出）
function extractTextForTest(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: string }).type !== 'thinking')
      .map((b) => ((b as { text?: string }).text) ?? '')
      .join('')
  }
  return ''
}
function extractThinkingForTest(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: string }).type === 'thinking')
      .map((b) => ((b as { thinking?: string }).thinking) ?? '')
      .join('')
  }
  return ''
}
