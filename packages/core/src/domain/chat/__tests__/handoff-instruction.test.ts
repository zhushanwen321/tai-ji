/**
 * 交接回合识别与呈现单测（chat-flow-consistency U9 / 特殊流程 S2）。
 *
 * 覆盖（impl-plan §2 U9 验收条款「交接期指令气泡折叠为系统行且重开后一致」）：
 * - 识别函数 isHandoffPromptText 对模板常量命中 / 近似文本不命中
 * - reducer 派生段（convertMessageBody 经 applyEntry/replayEntries）：命中 user entry →
 *   system 提示行（handoffInstruction 字段携带原文），普通 user 消息不受影响
 * - live ≡ reload：applyEntry 单条喂入（live 帧）与 replayEntries 序列重放（reload）
 *   同一序列产物 deep-equal（识别落在共享派生层，等价构造性成立）
 * - 分组层：指令行作 turn 锚 + 其后 assistant 归同 turn（isHandoffDocTurn 判定），
 *   指令行后的普通 user 消息正常开新 turn
 *
 * 运行：cd packages/core && pnpm exec vitest run src/domain/chat/__tests__/handoff-instruction.test.ts
 */
import { describe, it, expect } from 'vitest'
import { HANDOFF_PROMPT_TEMPLATE } from '@taiji/shared'
import {
  applyEntry,
  createInitialChatViewState,
  replayEntries,
} from '../apply-entry'
import { isHandoffPromptText, convertMessageBody } from '../apply-entry-convert'
import { isHandoffInstructionNotice, isHandoffDocTurn, toRenderItems } from '../message-turns'
import type { Message } from '@taiji/shared'
import { msgEntry } from './helpers/fixtures'

const ISO = (ms: number): string => new Date(ms).toISOString()

/** 构造 handoff 指令 user entry（内容 = 模板原文）。 */
function handoffUserEntry(id = 'e-handoff-1'): ReturnType<typeof msgEntry> {
  return msgEntry(id, { role: 'user', content: HANDOFF_PROMPT_TEMPLATE, timestamp: 1000 }, { timestamp: ISO(1000) })
}

/** 构造 assistant entry（交接文档正文）。 */
function assistantEntry(id: string, text: string, ts: number): ReturnType<typeof msgEntry> {
  return msgEntry(id, { role: 'assistant', content: [{ type: 'text', text }], timestamp: ts }, { timestamp: ISO(ts) })
}

describe('isHandoffPromptText —— 识别锚点（内容 === 模板常量）', () => {
  it('模板常量原文命中', () => {
    expect(isHandoffPromptText(HANDOFF_PROMPT_TEMPLATE)).toBe(true)
  })

  it('近似文本不命中（改一词 / 截断 / 前后空白）', () => {
    expect(isHandoffPromptText(HANDOFF_PROMPT_TEMPLATE.replace('handoff document', 'summary'))).toBe(false)
    expect(isHandoffPromptText(`${HANDOFF_PROMPT_TEMPLATE}\n`)).toBe(false)
    expect(isHandoffPromptText(` ${HANDOFF_PROMPT_TEMPLATE}`)).toBe(false)
    expect(isHandoffPromptText(HANDOFF_PROMPT_TEMPLATE.slice(0, 100))).toBe(false)
    expect(isHandoffPromptText('')).toBe(false)
    // 模板仅是长文本的子串：包含它的用户消息不命中（全文相等判定，非启发式包含）
    expect(isHandoffPromptText(`说点什么\n\n${HANDOFF_PROMPT_TEMPLATE}`)).toBe(false)
  })
})

describe('reducer 派生段 —— 命中 user entry 折叠为系统行（live/reload 同点）', () => {
  it('命中：role 转 system + handoffInstruction 携带原文 + piEntryId 回填', () => {
    const { messages } = replayEntries([handoffUserEntry()])
    expect(messages).toHaveLength(1)
    const m = messages[0]
    expect(m.role).toBe('system')
    expect(m.handoffInstruction).toEqual({ text: HANDOFF_PROMPT_TEMPLATE })
    expect(m.content).toBe(HANDOFF_PROMPT_TEMPLATE)
    expect(m.piEntryId).toBe('e-handoff-1')
    expect(m.status).toBe('complete')
    expect(m.timestamp).toBe(1000)
  })

  it('不命中：普通 user 消息派生不受影响（含模板子串 / 普通文本）', () => {
    const nearMiss = msgEntry(
      'e-user-2',
      { role: 'user', content: `请参考以下指令：\n\n${HANDOFF_PROMPT_TEMPLATE}`, timestamp: 1000 },
      { timestamp: ISO(1000) },
    )
    const { messages } = replayEntries([nearMiss])
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    expect(messages[0].handoffInstruction).toBeUndefined()
  })

  it('convertMessageBody 直调：命中返回系统行形态（单点转换函数行为锁定）', () => {
    const msg = convertMessageBody(
      { role: 'user', content: HANDOFF_PROMPT_TEMPLATE, timestamp: 1000 },
      'entry-9',
      'e9',
      0,
    )
    expect(msg).not.toBeNull()
    expect(msg?.role).toBe('system')
    expect(msg?.handoffInstruction?.text).toBe(HANDOFF_PROMPT_TEMPLATE)
  })
})

describe('live ≡ reload —— applyEntry 单条（live 帧）与 replayEntries（重放）产物一致', () => {
  it('同一序列两条喂入路径 messages deep-equal', () => {
    const entries = [
      handoffUserEntry(),
      assistantEntry('e-a-1', '# Handoff document\n\nContext summary.', 2000),
    ]
    // live 路径：store.applyEntryFrame 逐帧 applyEntry（单条、前置 state 累积）
    let live = createInitialChatViewState()
    for (const e of entries) live = applyEntry(live, e)
    // reload 路径：getHistory → replayEntries 序列重放
    const reloaded = replayEntries(entries)
    expect(live.messages).toEqual(reloaded.messages)
    // 两条消息：指令行（system）+ 文档（assistant）
    expect(live.messages.map((m) => m.role)).toEqual(['system', 'assistant'])
  })
})

describe('分组层 —— 指令行作 turn 锚 + 交接文档回合', () => {
  it('isHandoffInstructionNotice：只认带 handoffInstruction 的 system 行', () => {
    const { messages } = replayEntries([handoffUserEntry()])
    const line = messages[0]
    expect(isHandoffInstructionNotice(line)).toBe(true)
    const plainSystem: Message = { id: 's1', role: 'system', content: 'x', status: 'complete', timestamp: 1 }
    expect(isHandoffInstructionNotice(plainSystem)).toBe(false)
    expect(isHandoffInstructionNotice(line)).toBe(true)
  })

  it('指令行 + 其后 assistant → 同一 turn，isHandoffDocTurn true；普通 user 后开新 turn', () => {
    const { messages } = replayEntries([
      assistantEntry('e-prev', '上一轮回复', 500),
      handoffUserEntry(),
      assistantEntry('e-a-1', '# Handoff document', 2000),
      msgEntry('e-user-next', { role: 'user', content: '下一个问题', timestamp: 3000 }, { timestamp: ISO(3000) }),
      assistantEntry('e-a-2', '新回合回复', 4000),
    ])
    expect(messages).toHaveLength(5)
    const items = toRenderItems(messages)
    const turns = items.filter((i) => i.kind === 'turn')
    // 结构：[assistant 自启 turn（prev）] [指令 notice 独立行] [handoff turn（指令锚 + 文档）] [user turn（新问题）]
    // 指令行是 handoff turn 锚（不产独立 static 项），独立 systemNotice 项不应出现指令行
    expect(turns).toHaveLength(3)
    const handoffTurn = turns[1]
    if (handoffTurn.kind !== 'turn') throw new Error('unreachable')
    expect(handoffTurn.turn.user?.handoffInstruction).toBeDefined()
    expect(isHandoffDocTurn(handoffTurn.turn)).toBe(true)
    expect(handoffTurn.turn.assistants).toHaveLength(1)
    expect(handoffTurn.turn.assistants[0].content).toContain('Handoff document')
    // 前后 turn 判定为 false
    if (turns[0].kind !== 'turn' || turns[2].kind !== 'turn') throw new Error('unreachable')
    expect(isHandoffDocTurn(turns[0].turn)).toBe(false)
    expect(isHandoffDocTurn(turns[2].turn)).toBe(false)
  })

  it('交接中止形态（指令行后无 assistant）：指令行仍作锚产出空 assistant turn（消息不丢，无独立 notice 项）', () => {
    const { messages } = replayEntries([
      handoffUserEntry(),
      msgEntry('e-user-next', { role: 'user', content: '中止后的新消息', timestamp: 3000 }, { timestamp: ISO(3000) }),
    ])
    const items = toRenderItems(messages)
    // 锚位有消息（isEmptyTurn 判 user===null 不命中）→ turn 保留：指令行随锚位照显，
    // 后续 user 正常开新 turn。无独立 systemNotice 项。
    const turns = items.filter((i) => i.kind === 'turn')
    expect(turns).toHaveLength(2)
    if (turns[0].kind !== 'turn') throw new Error('unreachable')
    expect(turns[0].turn.user?.handoffInstruction).toBeDefined()
    expect(turns[0].turn.assistants).toHaveLength(0)
    expect(items.every((i) => i.kind !== 'systemNotice')).toBe(true)
  })
})
