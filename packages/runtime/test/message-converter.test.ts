import { describe, it, expect } from 'vitest'
import { convertPiHistory } from '../src/infra/pi/message-converter.js'
import type { PiHistoryMessage, PiHistoryToolResult } from '../src/infra/pi/pi-protocol.js'

describe('convertPiHistory', () => {
  it('converts user and assistant text messages', () => {
    const raw: PiHistoryMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
        timestamp: 1000,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there' }],
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(raw)

    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('user')
    expect((messages[0].content as Array<{ type: string; text?: string }>)
      .find((s) => s.type === 'text')?.text).toBe('Hello')
    expect(messages[0].timestamp).toBe(1000)
    expect(messages[1].role).toBe('assistant')
    expect(messages[1].content).toBe('Hi there')
    expect(messages[1].status).toBe('complete')
  })

  it('merges toolResult into parent assistant toolCall', () => {
    const raw: (PiHistoryMessage | PiHistoryToolResult)[] = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc1', name: 'readFile', arguments: { path: '/foo' } }],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        content: [{ type: 'text', text: 'file contents here' }],
        timestamp: 2000,
        toolCallId: 'tc1',
        toolName: 'readFile',
      } satisfies PiHistoryToolResult,
    ]

    const messages = convertPiHistory(raw)

    // toolResult should be merged, not a separate message
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('assistant')
    expect(messages[0].toolCalls).toHaveLength(1)
    expect(messages[0].toolCalls![0].id).toBe('tc1')
    expect(messages[0].toolCalls![0].output).toBe('file contents here')
    expect(messages[0].toolCalls![0].status).toBe('completed')
  })

  it('marks toolCall as error when toolResult has isError', () => {
    const raw: (PiHistoryMessage | PiHistoryToolResult)[] = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc2', name: 'bash', arguments: { cmd: 'exit 1' } }],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        content: [{ type: 'text', text: 'command failed' }],
        timestamp: 2000,
        toolCallId: 'tc2',
        toolName: 'bash',
        isError: true,
      } satisfies PiHistoryToolResult,
    ]

    const messages = convertPiHistory(raw)

    expect(messages).toHaveLength(1)
    expect(messages[0].toolCalls![0].status).toBe('error')
    expect(messages[0].toolCalls![0].output).toBe('command failed')
  })
})

describe('convertPiHistory - skill block parsing', () => {
  // user 消息中的 <skill name="..." location="...">...</skill> 块由 pi backend 注入，
  // convertPiHistory 应剖出 skillName/skillLocation 并只保留用户真实文本。
  const skillUser = (text: string) => [{
    role: 'user',
    content: [{ type: 'text' as const, text }],
    timestamp: 1000,
  } satisfies PiHistoryMessage]

  it('parses a skill block with location, leaves trailing user text', () => {
    const messages = convertPiHistory(skillUser(
      '<skill name="code-review" location="/abs/path/SKILL.md">skill body</skill>do the thing',
    ))
    const skillSeg = (messages[0].content as any[]).find((s) => s.type === 'skill')
    expect(skillSeg?.name).toBe('code-review')
    expect(skillSeg?.location).toBe('/abs/path/SKILL.md')
    expect((messages[0].content as any[]).find((s) => s.type === 'text')?.text).toBe('do the thing')
  })

  it('parses a skill block without location (skillLocation undefined)', () => {
    const messages = convertPiHistory(skillUser(
      '<skill name="merge">body</skill>ship it',
    ))
    const skillSeg = (messages[0].content as any[]).find((s) => s.type === 'skill')
    expect(skillSeg?.name).toBe('merge')
    expect(skillSeg?.location).toBeUndefined()
    expect((messages[0].content as any[]).find((s) => s.type === 'text')?.text).toBe('ship it')
  })

  it('leaves content as-is when skill block lacks name attribute (regex no match)', () => {
    const raw = '<skill location="/x">body</skill>keep me'
    const messages = convertPiHistory(skillUser(raw))
    const content = messages[0].content as any[]
    // 无 skill 匹配 → 整段包成单个 text segment，无 skill segment
    expect(content.find((s) => s.type === 'skill')).toBeUndefined()
    expect(content.find((s) => s.type === 'text')?.text).toBe(raw)
  })

  it('leaves content as-is when skill block is unclosed (regex no match)', () => {
    const raw = '<skill name="x">body without close'
    const messages = convertPiHistory(skillUser(raw))
    const content = messages[0].content as any[]
    expect(content.find((s) => s.type === 'skill')).toBeUndefined()
    expect(content.find((s) => s.type === 'text')?.text).toBe(raw)
  })

  it('restores every skill block (multi-block), keeps text between/after blocks', () => {
    // [行为变更登记 2026-09-06] 升级前正则捕获组锚定 $，此形态「只取首个」、第二个 block
    // 沦为字面文本（capture 副产物非契约）；D7 升级（composer-multi-skill-injection u3，
    // core parseSkillBlock SSOT 同步）为两形态全局反解析——多 block 全部还原为 skill
    // segment，block 间与尾部正文保留（G2 多 skill 生效的恢复路径前提）。
    const messages = convertPiHistory(skillUser(
      '<skill name="first">A</skill><skill name="second">B</skill>tail',
    ))
    const content = messages[0].content as any[]
    expect(content.filter((s) => s.type === 'skill').map((s) => s.name)).toEqual(['first', 'second'])
    // 两 block 紧邻无夹间正文 → 仅尾部 tail 一个 text segment
    expect(content.filter((s) => s.type === 'text').map((s) => s.text)).toEqual(['tail'])
  })

  it('drops whitespace-only trailing text after block (marker-strip trimEnd, delivery-baseline policy)', () => {
    const messages = convertPiHistory(skillUser(
      '<skill name="x">body</skill>   \n  ',
    ))
    const content = messages[0].content as any[]
    expect(content.find((s) => s.type === 'skill')?.name).toBe('x')
    // [语义变更登记 2026-09-07] D7 升级时本形态曾锁定「尾部纯空白保留为 text segment」
    // （preserve-content policy）；簇 A2（decf7d289，defer 队列标记确认通道）在 user 投影
    // 剥 defer marker 后统一 trimEnd（core convertMessageBody 单点）——剥后基线文本 =
    // confirmDelivery overlay 文本，mergeBaselineWithLive 文本去重命中不双计。本形态
    // trimEnd 后无剩余正文 → 不产 text segment，仅 skill（与 core e-user-pi2 形态一致）。
    // 正文保留语义对非空白内容不变（见上方 multi-block 用例）。
    expect(content.find((s) => s.type === 'text')).toBeUndefined()
  })
})

describe('convertPiHistory - contentBlocks 到达顺序（循环内 push）', () => {
  // U9：parts=[thinking, text, toolCall] → contentBlocks 按真实到达顺序
  it('U9: parts=[thinking, text, toolCall] → contentBlocks 顺序=[thinking, text, toolCall]', () => {
    const raw: PiHistoryMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先思考' },
          { type: 'text', text: '结论' },
          { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/x' } },
        ],
        timestamp: 1000,
      },
    ]
    const messages = convertPiHistory(raw)
    const cb = messages[0].contentBlocks
    expect(cb).toBeDefined()
    expect(cb?.map((b) => b.type)).toEqual(['thinking', 'text', 'toolCall'])
    // text 块 refId 统一为 'text'，不再被强制置顶
    const textBlock = cb?.find((b) => b.type === 'text')
    expect(textBlock?.refId).toBe('text')
  })

  // U10：纯 text part → contentBlocks 仅一个 text 块
  it('U10: parts=[{type:text}] → contentBlocks=[{type:text,refId:text}]（仅一个）', () => {
    const raw: PiHistoryMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: '纯文字回答' }],
        timestamp: 1000,
      },
    ]
    const messages = convertPiHistory(raw)
    // §11 检查点 3：contentBlocks 带 contentIndex（parts 下标），与 streaming 路径对称
    expect(messages[0].contentBlocks).toEqual([{ type: 'text', refId: 'text', contentIndex: 0 }])
  })

  // U10b：text part 在前（非末位）→ text 能落在 contentBlocks 非末位
  it('U10b: parts=[text, thinking] → contentBlocks=[text, thinking]（text 不被强制置顶）', () => {
    const raw: PiHistoryMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '先说话' },
          { type: 'thinking', thinking: '后思考' },
        ],
        timestamp: 1000,
      },
    ]
    const messages = convertPiHistory(raw)
    const cb = messages[0].contentBlocks
    expect(cb?.map((b) => b.type)).toEqual(['text', 'thinking'])
  })

  // ── custom message（pi CustomMessage，扩展经 sendMessage 注入）──
  describe('custom message（role:"custom"）', () => {
    it('subagent-bg-notify 单条 → system + customType + bgNotify(单条 record)', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'subagent-bg-notify',
          content: 'Subagent "coder" (job-1) completed. Result:\nDone.',
          details: {
            id: 'job-1',
            status: 'done',
            agent: 'coder',
            model: 'claude-4.5',
            result: 'Done.',
            startedAt: 1000,
            endedAt: 13000,
          },
          timestamp: 13000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages).toHaveLength(1)
      const m = messages[0]
      expect(m.role).toBe('system')
      expect(m.customType).toBe('subagent-bg-notify')
      expect(m.content).toContain('coder')
      // bgNotify 派生字段已删（§3.3.6，前端零消费）——details 原始透传保留
      expect(m.details).toEqual({
        id: 'job-1',
        status: 'done',
        agent: 'coder',
        model: 'claude-4.5',
        result: 'Done.',
        startedAt: 1000,
        endedAt: 13000,
      })
    })

    it('subagent-bg-notify 批量 → bgNotify = {batch, items}', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'subagent-bg-notify',
          content: 'batch content',
          details: {
            batch: true,
            items: [
              { id: 'j1', status: 'done', agent: 'a1', startedAt: 1000 },
              { id: 'j2', status: 'failed', agent: 'a2', startedAt: 2000, error: 'boom' },
            ],
          },
          timestamp: 5000,
        },
      ]
      const messages = convertPiHistory(raw)
      const m = messages[0]
      // bgNotify 派生字段已删（§3.3.6）——details 原始透传保留（含 batch 形态）
      expect(m.details).toEqual({
        batch: true,
        items: [
          { id: 'j1', status: 'done', agent: 'a1', startedAt: 1000 },
          { id: 'j2', status: 'failed', agent: 'a2', startedAt: 2000, error: 'boom' },
        ],
      })
    })

    it('其他 customType → system + customType，details 透传', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'some-other-extension',
          content: 'hello',
          details: { foo: 'bar' },
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages).toHaveLength(1)
      expect(messages[0].role).toBe('system')
      expect(messages[0].customType).toBe('some-other-extension')
      expect(messages[0].details).toEqual({ foo: 'bar' })
    })

    // ── display 字段透传（FR-3 / AC-6）──────────────────────────────────
    // pi CustomMessage.display 是必填 boolean（false=隐藏不渲染，true=渲染）。
    // convertPiHistory 此前转 custom → system 时丢了 display，本次修复透传。
    it('display:false 的 custom message → 透传到 msg.display（goal/todo context 类应隐藏）', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'goal-context',
          content: '<goal_context>...</goal_context>',
          display: false,
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages).toHaveLength(1)
      expect(messages[0].display).toBe(false)
    })

    it('display:true 的 custom message → 透传到 msg.display（workflow-result/subagent-bg-notify 类应显示）', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'workflow-result',
          content: 'done',
          display: true,
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].display).toBe(true)
    })

    it('display 缺失的旧 custom message → msg.display 为 undefined（渲染层按 !== false 判断，保留显示）', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'legacy',
          content: 'old',
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].display).toBeUndefined()
    })

    it('display:false 的 custom message 仍进 result（converter 不丢消息，过滤在渲染层）', () => {
      // AC-3 / FR-7：chat store 保留完整 messages，filterDisplayableMessages 只在渲染层过滤。
      // converter 若丢消息会破坏关键规则 9（fork/compact/replay 需完整历史）。
      const raw = [
        { role: 'user', content: 'hi', timestamp: 1000 },
        {
          role: 'custom',
          customType: 'todo-context',
          content: '<todo_context>...</todo_context>',
          display: false,
          timestamp: 2000,
        },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 3000 },
      ]
      const messages = convertPiHistory(raw)
      // user + custom(system) + assistant = 3 条，display:false 的 custom 不丢
      expect(messages).toHaveLength(3)
      expect(messages[1].display).toBe(false)
    })

    it('subagent-bg-notify details 缺必需字段 → details 原样透传（不再解析校验，§3.3.6）', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'subagent-bg-notify',
          content: 'partial',
          // 缺 id / agent / startedAt
          details: { status: 'done' },
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].details).toEqual({ status: 'done' })
      expect(messages[0].content).toBe('partial')
    })
  })

  describe('piEntryId（文件路径读取时注入的 entry id）', () => {
    it('__entryId 存在时填充到 Message.piEntryId', () => {
      const raw = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          timestamp: 1000,
          __entryId: 'abc123',
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].piEntryId).toBe('abc123')
    })

    it('无 __entryId 时 piEntryId 为 undefined（RPC 路径）', () => {
      const raw = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].piEntryId).toBeUndefined()
    })

    it('__entryId 非字符串时不填充', () => {
      const raw = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          timestamp: 1000,
          __entryId: 123,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].piEntryId).toBeUndefined()
    })
  })

  describe('compactionSummary / branchSummary role', () => {
    it('compactionSummary → system + compactionSummary 字段', () => {
      const raw = [
        { role: 'compactionSummary', summary: '压缩摘要', tokensBefore: 10000, timestamp: 123 },
      ]
      const messages = convertPiHistory(raw)
      expect(messages).toHaveLength(1)
      const m = messages[0]
      expect(m.role).toBe('system')
      expect(m.content).toBe('压缩摘要')
      expect(m.compactionSummary).toEqual({ summary: '压缩摘要', tokensBefore: 10000, timestamp: 123 })
    })

    it('compactionSummary 字段缺失时 content fallback 为“上下文已压缩”', () => {
      const raw = [{ role: 'compactionSummary', timestamp: 100 }]
      const messages = convertPiHistory(raw)
      expect(messages[0].content).toBe('上下文已压缩')
      expect(messages[0].compactionSummary?.summary).toBeUndefined()
    })

    it('branchSummary → system + branchSummary 字段', () => {
      const raw = [
        { role: 'branchSummary', summary: '分支摘要', fromId: 'msg-abc', timestamp: 456 },
      ]
      const messages = convertPiHistory(raw)
      expect(messages).toHaveLength(1)
      const m = messages[0]
      expect(m.role).toBe('system')
      expect(m.content).toBe('分支摘要')
      expect(m.branchSummary).toEqual({ summary: '分支摘要', fromId: 'msg-abc', timestamp: 456 })
    })

    it('branchSummary 字段缺失时 content fallback 为空字符串', () => {
      const raw = [{ role: 'branchSummary', timestamp: 200 }]
      const messages = convertPiHistory(raw)
      expect(messages[0].content).toBe('')
      expect(messages[0].branchSummary?.summary).toBeUndefined()
    })

    it('compactionSummary/branchSummary display 未设（保留显示）', () => {
      const raw = [
        { role: 'compactionSummary', summary: '压缩', timestamp: 100 },
        { role: 'branchSummary', summary: '分支', timestamp: 200 },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].display).toBeUndefined()
      expect(messages[1].display).toBeUndefined()
    })

    it('混合 user/assistant/compactionSummary 顺序不乱', () => {
      const raw = [
        { role: 'user', content: [{ type: 'text', text: '问题' }], timestamp: 100 },
        { role: 'compactionSummary', summary: '压缩摘要', timestamp: 200 },
        { role: 'assistant', content: [{ type: 'text', text: '回答' }], timestamp: 300 },
      ]
      const messages = convertPiHistory(raw)
      expect(messages).toHaveLength(3)
      expect(messages[0].role).toBe('user')
      expect(messages[1].role).toBe('system')
      expect(messages[1].compactionSummary).toBeDefined()
      expect(messages[2].role).toBe('assistant')
    })
  })
})

// ── F1 toolResult details 透传 + outputRaw 历史恢复（自 message-converter-gui.test.ts 并入）──
// details.__gui__ 透传：重开 session 后 GUI 卡片不丢（关键规则 9）；outputRaw 与实时路径对称。


describe('message-converter: F1 toolResult details 透传', () => {
  it('toolResult 含 details.__gui__ → toolCall.details 包含 __gui__', () => {
    const history = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check' },
          { type: 'toolCall', id: 'tc-1', name: 'todo', arguments: { action: 'list' } },
        ],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'todo',
        isError: false,
        content: [{ type: 'text', text: 'Task list updated' }],
        details: {
          __gui__: {
            v: 1,
            component: { type: 'stats-line', props: { items: [{ value: '3 turns' }] } },
          },
          action: 'list',
          todos: [{ id: 1, text: 'test', status: 'completed' }],
        },
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(history)

    // 找到 assistant 消息
    const assistant = messages.find(m => m.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant!.toolCalls).toBeDefined()
    expect(assistant!.toolCalls).toHaveLength(1)

    const tc = assistant!.toolCalls![0]
    expect(tc.id).toBe('tc-1')
    expect(tc.output).toBe('Task list updated')
    // ★ 核心断言：details 透传，含 __gui__
    expect(tc.details).toBeDefined()
    expect(tc.details?.__gui__).toBeDefined()
    const gui = tc.details?.__gui__ as { v: number; component: { type: string } }
    expect(gui.v).toBe(1)
    expect(gui.component.type).toBe('stats-line')
    // extension 自身的 details 字段也保留
    expect(tc.details?.action).toBe('list')
  })

  it('toolResult 无 details → toolCall.details 不设置', () => {
    const history = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-2', name: 'bash', arguments: { command: 'ls' } },
        ],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-2',
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: 'file1\nfile2' }],
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(history)
    const assistant = messages.find(m => m.role === 'assistant')
    const tc = assistant!.toolCalls![0]
    expect(tc.details).toBeUndefined()
  })

  it('toolResult details 为数组 → 不透传（防 Array 当 object）', () => {
    const history = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-3', name: 'test', arguments: {} },
        ],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-3',
        toolName: 'test',
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
        details: [{ unexpected: 'array' }],
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(history)
    const assistant = messages.find(m => m.role === 'assistant')
    const tc = assistant!.toolCalls![0]
    // 数组型 details 不透传（与 event-adapter handleToolExecutionEnd 的 !Array.isArray 约束一致）
    expect(tc.details).toBeUndefined()
  })
})

describe('message-converter: outputRaw 历史恢复（对称实时路径）', () => {
  it('toolResult content 含 ANSI → output 存 stripAnsi 版本，outputRaw 存原始', () => {
    const ansiText = '\x1b[32mgreen\x1b[0m text'
    const history = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-raw-1', name: 'bash', arguments: {} }],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-raw-1',
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: ansiText }],
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(history)
    const tc = messages.find(m => m.role === 'assistant')!.toolCalls![0]
    // output 是 stripAnsi 后的纯文本
    expect(tc.output).toBe('green text')
    // outputRaw 保留原始 ANSI（对称实时路径，关键规则 9）
    expect(tc.outputRaw).toBe(ansiText)
  })

  it('toolResult content 不含 ANSI → outputRaw 不设置', () => {
    const history = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-raw-2', name: 'bash', arguments: {} }],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-raw-2',
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: 'plain text' }],
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(history)
    const tc = messages.find(m => m.role === 'assistant')!.toolCalls![0]
    expect(tc.output).toBe('plain text')
    expect(tc.outputRaw).toBeUndefined()
  })
})
