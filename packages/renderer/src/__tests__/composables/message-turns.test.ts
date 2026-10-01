// @vitest-environment node

/**
 * expandAssistantBlocks 纯函数单测 —— 单条 assistant Message 内部块按真实时序展开。
 *
 * 背景（draft-message-stream §4）：trace 区应按 contentBlocks 真实时序渲染 7 类块。
 * expandAssistantBlocks 把 contentBlocks（索引数组）解成 OrderedBlock[]（带 ref），
 * 供 Turn.vue v-for 渲染。修复「text 在最下方、上方 tool call 还在更新」乱序 bug。
 *
 * 覆盖：
 * - B1：有 contentBlocks，严格按其顺序输出（thinking/text/tool/thinking 交替）
 * - B2：text 块 ref = msg.content（完整字符串，非单 chunk）
 * - B3：无 contentBlocks（降级）→ 旧顺序 text→thinking→tool
 * - B4：contentBlocks 引用不存在的 thinking/toolCall id → 跳过（防御异常数据）
 * - B5：空 contentBlocks + 无内容 → 空数组
 * - B6/B7：subagent/workflow toolCall → kind=agentgraph（contentBlocks 路径 + 降级路径）
 *
 * 运行：npx vitest run src/__tests__/composables/message-turns.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  expandAssistantBlocks,
  renderKey,
  toRenderItems,
  toRenderItemsIncremental,
  createTurnRenderCache,
} from '@/composables/logic/messageTurns'
import type { Message } from '@taiji/shared'
import type { RenderItem } from '@/composables/logic/messageTurns'

function makeMsg(over: Partial<Message> = {}): Message {
  return { id: 'a1', role: 'assistant', content: '', status: 'complete', timestamp: Date.now(), ...over }
}

// [W3·D3 演进] display 过滤已内化到分组输出层：隐藏完成通知消化为 trigger turn 边界、
// 隐藏非通知消息在 groupRenderInput 透明跳过——独立的 filterDisplayableMessages 死导出
// 随过度设计审计候选 1 删除，其行为由「分组规则 v2」用例（core message-turns.incremental）
// 经 toRenderItems 输出侧锁定。

describe('expandAssistantBlocks —— 单条 assistant 内部块按时序展开', () => {
  it('B1: 有 contentBlocks → 严格按其顺序输出（thinking→text→tool→thinking 交替）', () => {
    const msg = makeMsg({
      content: '中间产出',
      thinking: [
        { id: 'th1', content: '推理1', collapsed: true },
        { id: 'th2', content: '推理2', collapsed: true },
      ],
      toolCalls: [
        { id: 'tc1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 },
      ],
      contentBlocks: [
        { type: 'thinking', refId: 'th1' },
        { type: 'text', refId: 'text' },
        { type: 'toolCall', refId: 'tc1' },
        { type: 'thinking', refId: 'th2' },
      ],
    })
    const result = expandAssistantBlocks(msg)
    expect(result.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool', 'thinking'])
    expect(result.map((b) => b.kind)).not.toEqual(['text', 'thinking', 'tool', 'thinking'])
  })

  it('B2: text 块 ref = msg.content（完整字符串，非单 chunk delta）', () => {
    const msg = makeMsg({
      content: '完整文本',
      contentBlocks: [{ type: 'text', refId: 'text' }],
    })
    const result = expandAssistantBlocks(msg)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('text')
    expect(result[0].ref).toBe('完整文本')
  })

  it('B3: 无 contentBlocks（降级）→ 旧顺序 text→thinking→tool', () => {
    const msg = makeMsg({
      content: '文本',
      thinking: [{ id: 'th1', content: '推理', collapsed: true }],
      toolCalls: [{ id: 'tc1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 }],
      // 无 contentBlocks
    })
    const result = expandAssistantBlocks(msg)
    expect(result.map((b) => b.kind)).toEqual(['text', 'thinking', 'tool'])
  })

  it('B4: contentBlocks 引用不存在的 thinking/toolCall id → 跳过（防御异常数据）', () => {
    const msg = makeMsg({
      content: '文本',
      thinking: [{ id: 'th1', content: '推理', collapsed: true }],
      // 只有一个 toolCall，但 contentBlocks 引用了 tc2（不存在）
      toolCalls: [{ id: 'tc1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 }],
      contentBlocks: [
        { type: 'text', refId: 'text' },
        { type: 'thinking', refId: 'th_missing' }, // 不存在 → 跳过
        { type: 'toolCall', refId: 'tc_missing' }, // 不存在 → 跳过
        { type: 'thinking', refId: 'th1' },
      ],
    })
    const result = expandAssistantBlocks(msg)
    // 只解出 text + th1（两个 missing 被跳过）
    expect(result.map((b) => b.kind)).toEqual(['text', 'thinking'])
    const thRef = result[1].ref as { id: string }
    expect(thRef.id).toBe('th1')
  })

  it('B5: 空 contentBlocks + 无内容 → 空数组', () => {
    const msg = makeMsg({ content: '', contentBlocks: [] })
    expect(expandAssistantBlocks(msg)).toEqual([])
  })

  /* ── agentgraph 识别：subagent/workflow toolCall 解为 kind='agentgraph'（IF3）── */

  it('B6: 有 contentBlocks 时 subagent/workflow toolCall → kind=agentgraph（contentBlocks 路径）', () => {
    // subagent/workflow 是图结构重型操作，按 toolName 识别为 agentgraph（不是普通 tool）
    const msg = makeMsg({
      content: 'done',
      toolCalls: [
        { id: 'sa1', toolName: 'subagent', input: {}, status: 'completed', startTime: 0 },
        { id: 'wf1', toolName: 'workflow', input: {}, status: 'completed', startTime: 0 },
        { id: 'grep1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 },
      ],
      contentBlocks: [
        { type: 'text', refId: 'text' },
        { type: 'toolCall', refId: 'sa1' },
        { type: 'toolCall', refId: 'wf1' },
        { type: 'toolCall', refId: 'grep1' },
      ],
    })
    const result = expandAssistantBlocks(msg)
    // subagent + workflow → agentgraph；grep → 普通 tool
    expect(result.map((b) => b.kind)).toEqual(['text', 'agentgraph', 'agentgraph', 'tool'])
    // ref 仍是 ToolCall（数据结构不变，仅 kind 不同）
    const saRef = result[1].ref as { id: string; toolName: string }
    expect(saRef.id).toBe('sa1')
    expect(saRef.toolName).toBe('subagent')
  })

  it('B7: 无 contentBlocks（降级）时 subagent/workflow toolCall → kind=agentgraph（fallback 路径同步识别）', () => {
    // 降级路径（无 contentBlocks）同样按 toolName 识别 agentgraph，与 contentBlocks 路径一致
    const msg = makeMsg({
      content: '文本',
      toolCalls: [
        { id: 'sa1', toolName: 'subagent', input: {}, status: 'completed', startTime: 0 },
        { id: 'grep1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 },
      ],
      // 无 contentBlocks → 走降级路径
    })
    const result = expandAssistantBlocks(msg)
    // 降级顺序 text→tool：subagent 标 agentgraph，grep 标 tool
    expect(result.map((b) => b.kind)).toEqual(['text', 'agentgraph', 'tool'])
  })
})

/**
 * kind 全集现算（renderer-model 归一 M1，conversation-renderer-model-unification §3.3.1）。
 *
 * kind 是 toRenderItems 每渲染从同一堆可选字段现算的派生值（不落 store），全集三态：
 * turn（user+assistant 回合）/ systemNotice（system 无 bashExecution）/ bashExecution（system + bashExecution）。
 *
 * 判定顺序与旧 MessageStream system 分支一致：bashExecution 优先于 systemNotice 兜底。
 * bgNotify/gui 不属全集（完成通知 display:false 过滤 + workflow-result 同源移除，见 SSOT）。
 */
function bashMsg(id: string, over: Partial<Message> = {}): Message {
  return makeMsg({
    id,
    role: 'system',
    content: '',
    bashExecution: {
      command: 'echo hi',
      output: 'hi',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1000,
    },
    ...over,
  })
}

/** kind 全集 → MessageStream 渲染组件映射契约（M1 检查点 1 的测试载体）。
 *  新增 kind 时必须同步更新此表 + MessageStream.vue 模板分发（TC3 防遗漏/多余）。 */
const KIND_COMPONENT_MAP: Record<RenderItem['kind'], string> = {
  turn: 'Turn',
  systemNotice: 'SystemNotice',
  bashExecution: 'BashOutputBlock',
}

describe('renderKey 稳定生成（M5 stable-key）', () => {
  /** 三 kind 全覆盖 fixture：turn(用户首条消息 id) + systemNotice + bashExecution */
  function stableFixture(): Message[] {
    return [
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }),
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      bashMsg('bash-1'),
    ]
  }

  it('TC1: 同一组消息两次 toRenderItems → 各 item 的 renderKey 一致（不随渲染重建漂移）', () => {
    const messages = stableFixture()
    const keysA = toRenderItems(messages).map(renderKey)
    const keysB = toRenderItems(messages).map(renderKey)
    expect(keysA).toEqual(keysB)
    // 且 key 是稳定 id 派生（turn 用首条消息 id，system 类用 message.id），非索引。
    // [W3 v2] bash 消息归 turn 内 notices（不产独立 bashExecution 项）——bash-1 落在 t-u2 的 turn 内
    expect(keysA).toEqual(['t-u1', 's-c1', 't-u2'])
  })

  it('TC1: 顶部插入（load-more）后既有 turn 的 renderKey 不漂移', () => {
    const base = [
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      makeMsg({ id: 'u3', role: 'user', content: 'q3' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'r3' }),
    ]
    const before = toRenderItems(base).map(renderKey)
    // load-more 在顶部插入更早的 turn（旧实现按索引生成 key 会让全部既有 key +1 漂移）
    const withMore = [
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      ...base,
    ]
    const after = toRenderItems(withMore).map(renderKey)
    // 既有 turn 的 key 值不变，只多出首项新 turn 的 key（稳定 id 非索引）
    expect(after.slice(1)).toEqual(before)
  })

  it('TC1: 中间插入/删除后既有 turn 的 renderKey 不漂移', () => {
    const base = [
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      makeMsg({ id: 'u3', role: 'user', content: 'q3' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'r3' }),
    ]
    const before = toRenderItems(base).map(renderKey)
    // 中间插入一条 user/assistant 对（新 turn 出现在 index 2 位置）
    const inserted = [
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'uX', role: 'user', content: 'qX' }),
      makeMsg({ id: 'aX', role: 'assistant', content: 'rX' }),
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      makeMsg({ id: 'u3', role: 'user', content: 'q3' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'r3' }),
    ]
    const afterInsert = toRenderItems(inserted).map(renderKey)
    // 新 turn 插在中间，u2/u3 两个既有 turn 的 key 保持 t-u2/t-u3（索引方案会变 t-3/t-4）
    expect(afterInsert).toEqual(['t-u1', 't-uX', 't-u2', 't-u3'])
    // 删除 u2 turn 后，u3 的 key 仍为 t-u3
    const removed = [
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'u3', role: 'user', content: 'q3' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'r3' }),
    ]
    expect(toRenderItems(removed).map(renderKey)).toEqual(['t-u1', 't-u3'])
    expect(before).toEqual(['t-u1', 't-u2', 't-u3'])
  })

  it('TC1: assistant 自启 turn（首条即 assistant，无 user）用首条 assistant id 作稳定 key', () => {
    const items = toRenderItems([
      makeMsg({ id: 'a0', role: 'assistant', content: '首条 assistant' }),
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
    ])
    expect(items.map(renderKey)).toEqual(['t-a0', 't-u1'])
  })

  it('TC1: 同 session 消息追加（streaming 中间态）不改变既有 turn 的 key 集合', () => {
    const mid = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
    ])
    const done = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
    ])
    // 末尾追加 assistant 只扩展 u2 turn，u1/u2 两个 turn 的 key 不变
    expect(mid.map(renderKey)).toEqual(['t-u1', 't-u2'])
    expect(done.map(renderKey)).toEqual(['t-u1', 't-u2'])
  })
})

describe('toRenderItems kind 全集现算（renderer-model M1）', () => {
  it('TC1: user/assistant 消息 → turn（assistant 归入 user 开启的同一回合）', () => {
    const items = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['turn'])
    const turn = items[0]
    if (turn.kind !== 'turn') throw new Error('expected turn item')
    expect(turn.turn.assistants.map((m) => m.id)).toEqual(['a1'])
  })

  it('TC1: system + bashExecution → bashExecution（不落 systemNotice）', () => {
    const items = toRenderItems([bashMsg('bash-1')])
    expect(items.map((i) => i.kind)).toEqual(['bashExecution'])
    const item = items[0]
    if (item.kind !== 'bashExecution') throw new Error('expected bashExecution item')
    expect(item.message.id).toBe('bash-1')
  })

  it('TC1: system 无 bashExecution（compactionSummary/branchSummary/stream_warn）→ systemNotice', () => {
    const items = toRenderItems([
      makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }),
      makeMsg({ id: 'b1', role: 'system', branchSummary: { summary: 's', fromId: 'prev-id' } }),
      makeMsg({ id: 'w1', role: 'system', customType: 'stream_warn', content: 'warn' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['systemNotice', 'systemNotice', 'systemNotice'])
  })

  it('TC1: 混合序列顺序：turn → systemNotice → turn（边界 system 独立、bash 归 turn 内 notices）', () => {
    const items = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }),
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      bashMsg('bash-1'),
    ])
    // [W3 v2] 压缩记录仍是独立 systemNotice 边界项；bash 执行记录归第二 turn 的 notices（不再独立成项）
    expect(items.map((i) => i.kind)).toEqual(['turn', 'systemNotice', 'turn'])
    // 压缩记录穿插在 turn 之间，不并入任何 turn
    const notice = items[1]
    if (notice.kind !== 'systemNotice') throw new Error('expected systemNotice item')
    expect(notice.message.content).toBe('压缩记录')
    // bash 记录挂在 u2 turn 内部末尾（D4 inline notice）
    const lastTurn = items[2]
    if (lastTurn.kind !== 'turn') throw new Error('expected turn item')
    expect(lastTurn.turn.notices?.map((m) => m.id)).toEqual(['bash-1'])
  })

  it('TC3 kind 一致性：全覆盖消息形态产出的 kind 集合恰好 = 全集（无遗漏/无多余）', () => {
    const messages: Message[] = [
      // → turn
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
      // → systemNotice 各形态（compactionSummary/branchSummary/stream_warn/customType）
      makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }),
      makeMsg({ id: 'b1', role: 'system', branchSummary: { summary: 's', fromId: 'prev-id' } }),
      makeMsg({ id: 'w1', role: 'system', customType: 'stream_warn', content: 'warn' }),
      // → bashExecution（[W3 v2] 边界 system 已关闭当前 turn，无 current 的 bash 退化为独立 static 项）
      bashMsg('bash-1'),
    ]
    const kinds = new Set(toRenderItems(messages).map((i) => i.kind))
    // 三态全集恰好都被产出（无 kind 被遗漏）
    expect([...kinds].sort()).toEqual(['bashExecution', 'systemNotice', 'turn'])
    // 组件映射表 keys 与 kind 全集一致（无多余/缺失分支，与 MessageStream 查表对齐）
    expect(Object.keys(KIND_COMPONENT_MAP).sort()).toEqual(['bashExecution', 'systemNotice', 'turn'])
  })
})

describe('W21 re-export —— D-4 增量函数经 renderer shim 可导入（perf plan minor 消化）', () => {
  // MessageStream 消费的 toRenderItemsIncremental / createTurnRenderCache / TurnRenderCache
  // 必须经本 shim（renderer 旧消费方统一 import 路径）re-export 自 core SSOT。
  it('toRenderItemsIncremental/createTurnRenderCache 可导入且行为等价全量版 + 快路径引用恒等', () => {
    expect(typeof toRenderItemsIncremental).toBe('function')
    expect(typeof createTurnRenderCache).toBe('function')
    const cache = createTurnRenderCache()
    const msgs: Message[] = [
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
      bashMsg('bash-1'),
    ]
    // [W4] filter 弃用参数已移除：分组消费全量数组，display 过滤内化到 toRenderItems 输出层
    const r1 = toRenderItemsIncremental(msgs, false, cache)
    expect(r1).toEqual(toRenderItems(msgs, false))
    // 同源数组引用二次调用 → 快路径零重算（引用恒等）
    const r2 = toRenderItemsIncremental(msgs, false, cache)
    expect(r2).toBe(r1)
  })
})

describe('U6 D5 边界聚合 —— notifySummary 经 renderer 通路（全量构造点）产出', () => {
  /** subagent-bg-notify 隐藏完成通知（display:false + details 单条 record） */
  function notifyMsg(id: string, details: Record<string, unknown>): Message {
    return makeMsg({ id, role: 'system', customType: 'subagent-bg-notify', display: false, content: '', details })
  }

  it('renderer shim 的 toRenderItems：trigger turn 携带 core 派生的 notifySummary（计数 + 三态 + 耗时）', () => {
    const items = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
      notifyMsg('n1', {
        batch: true,
        items: [
          { id: 't1', status: 'running', agent: 'main', startedAt: 1000, endedAt: 61_000 },
          { id: 't2', status: 'failed', agent: 'main', startedAt: 0 },
        ],
      }),
      makeMsg({ id: 'a2', role: 'assistant', content: '续跑' }),
    ])
    const trigger = items[1]
    if (trigger.kind !== 'turn') throw new Error('expected turn item')
    expect(trigger.turn.trigger).toBe('bg-notify')
    expect(trigger.turn.notifySummary).toEqual({
      count: 2,
      failedCount: 1,
      neutralCount: 0,
      outcomes: ['success', 'failed'],
      durationMs: 60_000, // 聚合集合 = 含 endedAt 记录：max(endedAt)=61000 − min(startedAt)=1000（t2 无 endedAt 不入集合）
    })
    // 渲染过滤不变：隐藏通知本体不产出独立渲染项
    expect(items.map((i) => i.kind)).toEqual(['turn', 'turn'])
  })
})
