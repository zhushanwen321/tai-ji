// tree.test.ts —— session-reader C01 簇合并产物（round5-G）。
// 共同被测业务模块：`src/core/tree.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/__tests__/render.test.ts（20 用例，skip 0）
//   - src/__tests__/tree.test.ts（10 用例，skip 0）
//   - src/__tests__/turns.test.ts（9 用例，skip 0）

import { describe, it, expect } from 'vitest'
import { renderOutline, renderExpand, renderDetail, type ToolResultSummaryEntry } from '../core/render.js'
import { type Entry } from '@zhushanwen/session-core'
import { type Turn, segmentTurns } from '../core/turns.js'
import { type TreeView, buildTreeView } from '../core/tree.js'

// ======== 来源：render.test.ts ========
describe("render", () => {
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

    it('8. 多 turn outline：tokenEstimate <= 1500 + assistantBrief/toolSummary 非空 + stats 完整（v2 O1）', () => {
      // v2 O1：加 assistantBrief + 修 toolSummary bug 后 outline 行含结论与工具聚合，
      // 阈值 1500（design §3.3 D4）。3 turn 合成数据，每 turn 带 toolCall + toolResult
      const turns = [0, 1, 2].map((i) =>
        turn(
          i,
          [
            uEntry(`U${i}`, `问题 ${i}`),
            aEntry(`A${i}`, `结论 ${i}`, [{ name: 'bash' }, { name: 'read' }]),
            tEntry(`T${i}`, 'output'),
          ],
          { userEntry: uEntry(`U${i}`, `问题 ${i}`) },
        ),
      )
      const result = renderOutline(turns, emptyTree(), { budget: 2000 })

      expect(result.turns.length).toBe(3)
      expect(result.tokenEstimate).toBeLessThanOrEqual(1500)
      // v2 O1 验证：assistant 结论行存在（非空）+ toolSummary 显示工具（修 v1 恒空 bug）
      expect(result.turns.some((b) => b.assistantBrief !== '')).toBe(true)
      expect(result.turns.some((b) => b.toolSummary !== '')).toBe(true)
      // stats 完整性
      expect(result.stats.totalTurns).toBe(3)
      // totalEntries 近似（leaf+branch+orphan）不含 session header（segmentTurns 规则1 跳过）
      expect(result.stats.totalEntries).toBeGreaterThan(0)
    })

    // ---- D9② 占位行折叠：纯记录条目 turn 不产 outline 行、不占轮次 ----

    function recEntry(id: string, type: string): Entry {
      // pi 1.0 纯记录条目形态（usage/session_info/model_change 等，无 message 字段）
      return { type, id, parentId: null }
    }

    function sysEntry(id: string): Entry {
      // pi 1.0 system 消息（role=system，工具集变更高频追加）——非对话轴，随折叠
      return { type: 'message', id, parentId: null, message: { role: 'system', content: 'sys' } }
    }

    it('9. D9② 纯记录条目 turn 折叠：不产行、totalTurns 只数对话轮，对话 turn 的 T 序号保留原 index', () => {
      const turns = [
        turn(0, [recEntry('MC', 'model_change'), recEntry('TL', 'thinking_level_change')]),
        turn(1, [uEntry('U1', 'first question')], { userEntry: uEntry('U1', 'first question') }),
        turn(2, [recEntry('US', 'usage')]),
        turn(3, [uEntry('U2', 'second question')], { userEntry: uEntry('U2', 'second question') }),
      ]
      const result = renderOutline(turns, emptyTree(), { budget: 2000 })

      // 记录 turn（0/2）折叠：行只剩两个对话 turn
      expect(result.turns).toHaveLength(2)
      expect(result.lines).toHaveLength(2)
      expect(result.stats.totalTurns).toBe(2)
      // T 序号 = 原 turn.index（expand/detail 的入口地址稳定，折叠不重编号）
      expect(result.turns.map((b) => b.index)).toEqual([1, 3])
      // 字节/条目统计保持全量口径（折叠是展示层行为，不丢数据）：2+1+1+1 = 5
      expect(result.stats.totalEntries).toBe(5)
    })

    it('10. D9② system 消息与 custom 审计条目同折叠；custom_message 参与对话流保留', () => {
      const turns = [
        turn(0, [sysEntry('S1'), recEntry('C1', 'custom')]),
        turn(1, [uEntry('U1', 'q')], { userEntry: uEntry('U1', 'q') }),
      ]
      const result = renderOutline(turns, emptyTree(), { budget: 2000 })
      expect(result.turns).toHaveLength(1)
      expect(result.stats.totalTurns).toBe(1)

      const cm: Entry = { type: 'custom_message', id: 'CM', parentId: null, customType: 'plan-context', content: 'prompt' }
      const withCm = renderOutline([turn(0, [cm]), turn(1, [uEntry('U1', 'q')], { userEntry: uEntry('U1', 'q') })], emptyTree(), { budget: 2000 })
      expect(withCm.turns).toHaveLength(2)
    })

    it('11. D9② entry 粒度同谓词：纯记录条目不产行，entryIdx 只数对话条目', () => {
      const turns = [
        turn(0, [recEntry('MC', 'model_change'), uEntry('U0', 'a')], { userEntry: uEntry('U0', 'a') }),
        turn(1, [recEntry('US', 'usage')]),
      ]
      const result = renderOutline(turns, emptyTree(), { granularity: 'entry', budget: 2000 })
      expect(result.turns).toHaveLength(1)
      expect(result.turns[0]?.userBrief).toBe('a')
    })

    it('12. D9② branch_summary 归纯记录折叠：前置 turn 成 turn 不产行（pi 1.0 纯记录类）', () => {
      // pi 1.0 dist branchWithSummary 落盘形态：{type:'branch_summary', id, parentId, fromId,
      // summary, details, usage, fromHook}，无 message 字段。归类 = 纯记录（分叉操作痕迹，
      // 非当前路径对话内容；taiji 无消息编辑入口不产生该形态）
      const bs: Entry = { type: 'branch_summary', id: 'BS', parentId: null, summary: 'original path digest' }
      const turns = [
        turn(0, [bs]),
        turn(1, [uEntry('U1', 'new branch question')], { userEntry: uEntry('U1', 'new branch question') }),
      ]
      const result = renderOutline(turns, emptyTree(), { budget: 2000 })
      // 折叠：前置 turn 不产行，outline 只剩新路径对话 turn
      expect(result.turns).toHaveLength(1)
      expect(result.lines).toHaveLength(1)
      expect(result.stats.totalTurns).toBe(1)
      // T 序号保留原 turn.index（expand/detail 入口地址稳定）
      expect(result.turns.map((b) => b.index)).toEqual([1])
      // 字节/条目统计保持全量口径：BS + U1 = 2
      expect(result.stats.totalEntries).toBe(2)
    })
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

  // 测试内联的类型检查镜像（验证 renderDetail 剥离效果，不依赖 render 内部导出）
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
});

// ======== 来源：tree.test.ts ========
describe("tree", () => {
  /** 构造最小 Entry（tree.ts 只消费 type/id/parentId，其余字段省略） */
  function e(id: string, parentId: string | null): Entry {
    return { type: 'message', id, parentId }
  }

  describe('buildTreeView', () => {
    it('线性链：leafPath 含全部 id，branches/orphans 空', () => {
      const entries = [e('A', null), e('B', 'A'), e('C', 'B')]
      const t = buildTreeView(entries)

      expect(t.leafPath).toEqual(['A', 'B', 'C'])
      expect(t.branches.size).toBe(0)
      expect(t.orphans).toEqual([])
    })

    it('单分叉：旁支子树按 forkPoint 聚合（D+E 归 A，count=2）', () => {
      // 主链 A→B→C，旁支 A→D→E；C 放最后 → leafId=C
      const entries = [e('A', null), e('B', 'A'), e('D', 'A'), e('E', 'D'), e('C', 'B')]
      const t = buildTreeView(entries)

      expect(t.leafPath).toEqual(['A', 'B', 'C'])
      expect(t.branches.size).toBe(1)
      expect(t.branches.get('A')).toBe(2)
      expect(t.orphans).toEqual([])
    })

    it('多级分叉：深层旁支沿祖先链归到 leafPath 上的 forkPoint', () => {
      // 主链 A→B→C→D，旁支 B→X→Y→Z；D 放最后 → leafId=D
      const entries = [
        e('A', null), e('B', 'A'),
        e('X', 'B'), e('Y', 'X'), e('Z', 'Y'),
        e('C', 'B'), e('D', 'C'),
      ]
      const t = buildTreeView(entries)

      expect(t.leafPath).toEqual(['A', 'B', 'C', 'D'])
      // X/Y/Z 全部沿祖先链回到 forkPoint=B → count=3
      expect(t.branches.get('B')).toBe(3)
      expect(t.orphans).toEqual([])
    })

    it('多个 forkPoint：旁支挂在 leafPath 不同节点上各自计数', () => {
      // 主链 A→B→C→D，旁支挂 A（A→X）和挂 C（C→Y）；D 放最后 → leafId=D
      const entries = [e('A', null), e('X', 'A'), e('B', 'A'), e('C', 'B'), e('Y', 'C'), e('D', 'C')]
      const t = buildTreeView(entries)

      expect(t.leafPath).toEqual(['A', 'B', 'C', 'D'])
      expect(t.branches.get('A')).toBe(1)
      expect(t.branches.get('C')).toBe(1)
      expect(t.orphans).toEqual([])
    })

    it('孤儿：parentId 指向不存在 → 进 orphans；leafPath 在断点停', () => {
      // A 是 leafPath 根但 parentId 断（MISSING_A 不在 index）→ leafPath 在 A 处停
      // X 非 leafPath 且 parentId 断 → 孤儿
      // B=leafId（最后），B.parentId=A
      const entries = [e('A', 'MISSING_A'), e('X', 'MISSING_X'), e('B', 'A')]
      const t = buildTreeView(entries)

      // 回溯 B→A→MISSING_A(不在 index) 停
      expect(t.leafPath).toEqual(['A', 'B'])
      // A 在 leafPath 上（断点根，有归属）→ 不重复计入 orphans
      expect(t.orphans).toEqual(['X'])
      expect(t.branches.size).toBe(0)
    })

    it('leafId = entries 最后一条的 id（D-2 语义）：同样节点不同顺序 → 不同 leafPath', () => {
      const ordered = [e('A', null), e('B', 'A'), e('C', 'B'), e('D', 'C')] // leafId=D
      const swapped = [e('A', null), e('B', 'A'), e('D', 'C'), e('C', 'B')] // leafId=C，D 变旁支

      const t1 = buildTreeView(ordered)
      const t2 = buildTreeView(swapped)

      expect(t1.leafPath).toEqual(['A', 'B', 'C', 'D'])
      expect(t2.leafPath).toEqual(['A', 'B', 'C'])
      // swapped 里 D 挂在 C（leafPath 末端）下，成旁支
      expect(t2.branches.get('C')).toBe(1)
    })

    it('空 entries：返回空视图', () => {
      const t = buildTreeView([])
      expect(t.leafPath).toEqual([])
      expect(t.branches.size).toBe(0)
      expect(t.orphans).toEqual([])
    })

    it('多 root 独立子树：触不到 leafPath 的 entry 不计入 branches/orphans', () => {
      // 主链 R→A（leafId=A），另有独立 root X→Y（X.parentId=null，与主链无连接）
      const entries = [e('R', null), e('X', null), e('Y', 'X'), e('A', 'R')]
      const t = buildTreeView(entries)

      expect(t.leafPath).toEqual(['R', 'A'])
      // X 是独立 root（parentId=null）→ 跳过；Y 触不到 leafPath → 静默忽略
      expect(t.branches.size).toBe(0)
      expect(t.orphans).toEqual([])
    })

    it('subagent-identity 尾行（parentId=null）不劫持 leafId：跳过取末尾对话节点', () => {
      // 模拟 subagent session：header A → message B → message C（对话链），尾行 identity sa-x（parentId=null）
      const entries = [e('A', null), e('B', 'A'), e('C', 'B'), e('sa-x', null)]
      const t = buildTreeView(entries)
      // leafId 跳过 sa-x（parentId=null），取 C（末尾 parentId!==null）→ leafPath 含完整对话链
      expect(t.leafPath).toEqual(['A', 'B', 'C'])
      // sa-x parentId=null → 独立 root，不计旁支不计孤儿
      expect(t.branches.size).toBe(0)
      expect(t.orphans).toEqual([])
    })

    it('全空 session（仅 header + 元数据 custom，无 parentId!==null 对话节点）→ leafId fallback entries[0]', () => {
      const entries = [e('A', null), e('sa-x', null)]
      const t = buildTreeView(entries)
      // 全 parentId=null → leafId fallback entries[0]=A → leafPath=[A]
      expect(t.leafPath).toEqual(['A'])
      expect(t.branches.size).toBe(0)
      expect(t.orphans).toEqual([])
    })
  })
});

// ======== 来源：turns.test.ts ========
describe("turns", () => {
  // ---- Entry 构造助手（turns.ts 只消费 type/id/parentId/message.role） ----

  function msg(
    id: string,
    parentId: string | null,
    role: 'user' | 'assistant' | 'toolResult',
  ): Entry {
    return { type: 'message', id, parentId, message: { role, content: '' } }
  }

  function entry(id: string, parentId: string | null, type: string): Entry {
    return { type, id, parentId }
  }

  describe('segmentTurns', () => {
    it('1. user 开 turn，后续 assistant/toolResult 并入同一 turn', () => {
      const entries = [msg('U', null, 'user'), msg('A', 'U', 'assistant'), msg('T', 'A', 'toolResult')]
      const turns = segmentTurns(entries, new Set(['U', 'A', 'T']))

      expect(turns).toHaveLength(1)
      expect(turns[0].index).toBe(0)
      expect(turns[0].isCompaction).toBe(false)
      expect(turns[0].userEntry?.id).toBe('U')
      expect(turns[0].entries.map((e) => e.id)).toEqual(['U', 'A', 'T'])
    })

    it('2. compaction 开新 turn（isCompaction=true，无 userEntry），后续 user 又开一个 turn', () => {
      const entries = [
        msg('U', null, 'user'),
        msg('A', 'U', 'assistant'),
        entry('C', 'A', 'compaction'),
        msg('U2', 'C', 'user'),
      ]
      const turns = segmentTurns(entries, new Set(['U', 'A', 'C', 'U2']))

      expect(turns).toHaveLength(3)
      // turn 0：user + assistant
      expect(turns[0].userEntry?.id).toBe('U')
      expect(turns[0].isCompaction).toBe(false)
      expect(turns[0].entries.map((e) => e.id)).toEqual(['U', 'A'])
      // turn 1：compaction 独立成 turn
      expect(turns[1].isCompaction).toBe(true)
      expect(turns[1].userEntry).toBeUndefined()
      expect(turns[1].entries.map((e) => e.id)).toEqual(['C'])
      // turn 2：新 user
      expect(turns[2].userEntry?.id).toBe('U2')
      expect(turns[2].isCompaction).toBe(false)
    })

    it('3. model_change / thinking_level_change / custom 并入当前 turn', () => {
      const entries = [
        msg('U', null, 'user'),
        entry('M', 'U', 'model_change'),
        entry('T', 'M', 'thinking_level_change'),
        entry('X', 'T', 'custom'),
      ]
      const turns = segmentTurns(entries, new Set(['U', 'M', 'T', 'X']))

      expect(turns).toHaveLength(1)
      expect(turns[0].userEntry?.id).toBe('U')
      expect(turns[0].entries.map((e) => e.id)).toEqual(['U', 'M', 'T', 'X'])
    })

    it('4. branch entry（不在 leafSet）不计入', () => {
      const entries = [
        msg('U', null, 'user'),
        msg('A', 'U', 'assistant'),
        msg('B1', 'U', 'assistant'), // 旁支：不在 leafSet
        msg('B2', 'B1', 'toolResult'), // 旁支子节点
      ]
      const turns = segmentTurns(entries, new Set(['U', 'A']))

      expect(turns).toHaveLength(1)
      expect(turns[0].entries.map((e) => e.id)).toEqual(['U', 'A'])
    })

    it('5. 孤儿 assistant（首个 entry 是 assistant 无前置 user）→ 并入 turn 0（preface）', () => {
      const entries = [msg('O', null, 'assistant'), msg('U', 'O', 'user')]
      const turns = segmentTurns(entries, new Set(['O', 'U']))

      expect(turns).toHaveLength(2)
      // turn 0：preface（孤儿 assistant），无 userEntry，非 compaction
      expect(turns[0].isCompaction).toBe(false)
      expect(turns[0].userEntry).toBeUndefined()
      expect(turns[0].entries.map((e) => e.id)).toEqual(['O'])
      // turn 1：首个 user
      expect(turns[1].userEntry?.id).toBe('U')
      expect(turns[1].index).toBe(1)
    })

    it('6. session header 被忽略（即使在 leafSet 中也不计 turn）', () => {
      const entries = [
        entry('S', null, 'session'),
        msg('U', 'S', 'user'),
        msg('A', 'U', 'assistant'),
      ]
      // S 也在 leafSet，验证规则 1 优先于规则 5
      const turns = segmentTurns(entries, new Set(['S', 'U', 'A']))

      expect(turns).toHaveLength(1)
      expect(turns[0].entries.map((e) => e.id)).toEqual(['U', 'A'])
    })

    it('7. 空 entries → []', () => {
      expect(segmentTurns([], new Set())).toEqual([])
    })

    it('startTime 取 turn 首条 entry 的 timestamp', () => {
      const entries = [
        { ...msg('U', null, 'user'), timestamp: '2026-05-28T03:17:12.844Z' },
        msg('A', 'U', 'assistant'),
      ]
      const turns = segmentTurns(entries, new Set(['U', 'A']))
      expect(turns[0].startTime).toBe('2026-05-28T03:17:12.844Z')
    })

    it('leaf 视图分段结构形态：preface（首 user 前的 model_change）+ user turns + compaction turn', () => {
      // 合成分段结构形态（1 preface + 1 compaction + 2 user turn）：
      // 规则 2（compaction 独立成 turn）+ 规则 4（首 user 前的 model_change/thinking_level_change
      // 成 preface turn，无 userEntry）
      const entries = [
        entry('MC', null, 'model_change'),
        msg('U1', 'MC', 'user'),
        msg('A1', 'U1', 'assistant'),
        entry('C1', 'A1', 'compaction'),
        msg('U2', 'C1', 'user'),
        msg('A2', 'U2', 'assistant'),
      ]
      const tree = buildTreeView(entries)
      const turns = segmentTurns(entries, new Set(tree.leafPath))

      expect(turns.length).toBe(4)
      // 首 turn 是 preface（model_change），无 userEntry、非 compaction
      expect(turns[0].userEntry).toBeUndefined()
      expect(turns[0].isCompaction).toBe(false)
      expect(turns.filter((t) => t.isCompaction).length).toBe(1)
      expect(turns.filter((t) => t.userEntry !== undefined).length).toBe(2)
    })
  })
});
