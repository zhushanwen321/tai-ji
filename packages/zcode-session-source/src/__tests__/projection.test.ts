/**
 * 投影分类器逐路对拍测试（U1——设计 §7.2 分类器伪代码与 §4.2 判定树逐分支）。
 * 来源注记：自 runtime zcode-import dev 演进版整文件移植（用例零改动，git 可追溯）。
 *
 * 用例与 §7.2 判定序一一对应（验收③覆盖证明，编号即下文 describe/it 前缀）：
 *   ⓪ 闭集检查前置（D4）：未知 kind / origin / source（含四路回退的 semantics.source
 *      与 part 级 metadata.source 通道）→ 'unclassified'，且先于 ① 特判；
 *   ① compact_summary 特判先于一切（kind 通道 + data.summary 旧数据通道，含 null）；
 *   ② semantics 六分支（a-f，含 b 的两个负例与 d-先于-f 的顺序锚——§6-D1 顺序即语义实证）；
 *   ③ 旧数据兜底链（model-only → isTimelineOnlyMessage 六通道 → fork 独立分支 →
 *      LEGACY 17 值 → 遗留提醒文本 → synthetic∧通知文本 → synthetic → role 收口）；
 *   ④ fork 四通道专项（message.source / metadata.source / semantics.source / part 级
 *      source）+ forkContext 通道 + 四路回退优先级交互。
 *
 * 期望值全部对照 asar 原函数（getConversationMessageProjectionPolicy，沙箱冒烟与全量
 * 对拍核验）人工推演，两处有意偏离
 * （compactSummary 落点 / unclassified 降级）单独成组。
 */

import { describe, expect, it } from 'vitest'

import { classifyMessage } from '../projection.ts'

type MsgData = Record<string, unknown>
type PartData = Record<string, unknown>

function textPart(text: string, extra: PartData = {}): PartData {
  return { type: 'text', text, ...extra }
}

describe('⓪ 闭集检查前置（D4）：未知即 unclassified，先于一切分支', () => {
  it('semantics.kind 不在 12 闭集 → unclassified（即使 origin/role 完全合法）', () => {
    const data: MsgData = {
      role: 'user',
      semantics: { kind: 'zcode_future_kind', origin: 'real_user' },
    }
    expect(classifyMessage(data, [])).toBe('unclassified')
  })

  it('semantics.origin 不在 5 闭集 → unclassified', () => {
    const data: MsgData = {
      role: 'user',
      semantics: { kind: 'user_prompt', origin: 'mystery_origin' },
    }
    expect(classifyMessage(data, [])).toBe('unclassified')
  })

  it('semantics 对象缺 kind（空对象/仅带 source）→ unclassified', () => {
    expect(classifyMessage({ role: 'user', semantics: {} }, [])).toBe('unclassified')
  })

  it('metadata.source 未知值（真实宿主库发现的 plan_file_reference，不在 12∪17）→ unclassified', () => {
    const data: MsgData = { role: 'user', synthetic: true, metadata: { source: 'plan_file_reference' } }
    expect(classifyMessage(data, [])).toBe('unclassified')
  })

  it('semantics.source 通道的未知值 → unclassified（第三路回退同样过闸）', () => {
    const data: MsgData = {
      role: 'user',
      semantics: { kind: 'user_prompt', origin: 'real_user', source: 'mystery_source' },
    }
    expect(classifyMessage(data, [])).toBe('unclassified')
  })

  it('part 级 metadata.source 通道的未知值（第四路回退）→ unclassified', () => {
    const data: MsgData = { role: 'user' }
    const parts: PartData[] = [textPart('hello', { metadata: { source: 'future_source' } })]
    expect(classifyMessage(data, parts)).toBe('unclassified')
  })

  it('闭集前置先于 ① 特判：kind=compact_summary 但 origin 未知 → unclassified', () => {
    const data: MsgData = {
      role: 'user',
      semantics: { kind: 'compact_summary', origin: 'mystery_origin' },
    }
    expect(classifyMessage(data, [])).toBe('unclassified')
  })
})

describe('① compact_summary 特判（先于语义分支与兜底链；taiji 落点 = compactSummary）', () => {
  it('semantics.kind=compact_summary → compactSummary（先于 b：同为 real_user 也不判 realUserInput）', () => {
    const data: MsgData = {
      role: 'user',
      semantics: {
        kind: 'compact_summary',
        origin: 'real_user',
        providerVisibility: 'visible',
        uiVisibility: 'visible',
        transcriptVisibility: 'visible',
      },
    }
    expect(classifyMessage(data, [])).toBe('compactSummary')
  })

  it('先于 d：providerVisibility=visible 也不判 providerContextOnly', () => {
    const data: MsgData = {
      role: 'user',
      semantics: { kind: 'compact_summary', origin: 'agent_runtime', providerVisibility: 'visible' },
    }
    expect(classifyMessage(data, [])).toBe('compactSummary')
  })

  it('旧数据通道：无 semantics 但 data.summary 存在 → compactSummary（先于兜底链 model-only）', () => {
    const data: MsgData = { role: 'user', summary: 'This session is being continued...', visibility: 'model-only' }
    expect(classifyMessage(data, [])).toBe('compactSummary')
  })

  it('data.summary 为 null 也算存在（asar 同款 !== undefined 判据）', () => {
    expect(classifyMessage({ role: 'user', summary: null }, [])).toBe('compactSummary')
  })

  it('data.summary 为空串也算存在', () => {
    expect(classifyMessage({ role: 'user', summary: '' }, [])).toBe('compactSummary')
  })
})

describe('② semantics 六分支（顺序 = asar 原序）', () => {
  it('a: kind=timeline_event → timelineOnly（即便其余字段齐全）', () => {
    const data: MsgData = {
      role: 'assistant',
      semantics: {
        kind: 'timeline_event',
        origin: 'agent_runtime',
        providerVisibility: 'hidden',
        uiVisibility: 'hidden',
        transcriptVisibility: 'hidden',
      },
    }
    expect(classifyMessage(data, [])).toBe('timelineOnly')
  })

  it('b: origin=real_user ∧ 无 synthetic ∧ 非 model-only → realUserInput（真人输入）', () => {
    const data: MsgData = {
      role: 'user',
      semantics: {
        kind: 'user_prompt',
        origin: 'real_user',
        providerVisibility: 'visible',
        uiVisibility: 'visible',
        transcriptVisibility: 'visible',
      },
    }
    expect(classifyMessage(data, [])).toBe('realUserInput')
  })

  it('b 负例一：synthetic=true 时 b 不命中（origin=real_user 也不行）→ 落入兜底链 synthetic → hiddenSynthetic', () => {
    const data: MsgData = {
      role: 'user',
      synthetic: true,
      semantics: { kind: 'user_prompt', origin: 'real_user', providerVisibility: 'hidden' },
    }
    expect(classifyMessage(data, [])).toBe('hiddenSynthetic')
  })

  it('b 负例二：visibility=model-only 时 b 不命中 → 兜底链首位接住 → providerContextOnly', () => {
    const data: MsgData = {
      role: 'user',
      visibility: 'model-only',
      semantics: { kind: 'user_prompt', origin: 'real_user', providerVisibility: 'hidden' },
    }
    expect(classifyMessage(data, [])).toBe('providerContextOnly')
  })

  it('c: assistant + assistant_response + ui/transcript 双 visible → visibleAssistant', () => {
    const data: MsgData = {
      role: 'assistant',
      semantics: {
        kind: 'assistant_response',
        origin: 'agent_runtime',
        providerVisibility: 'hidden',
        uiVisibility: 'visible',
        transcriptVisibility: 'visible',
      },
    }
    expect(classifyMessage(data, [])).toBe('visibleAssistant')
  })

  it('c 落空（uiVisibility 缺失）且 f 三条件全不满足（origin=system）→ 兜底链 role 收口 visibleAssistant', () => {
    const data: MsgData = {
      role: 'assistant',
      semantics: {
        kind: 'assistant_response',
        origin: 'system',
        providerVisibility: 'hidden',
      },
    }
    expect(classifyMessage(data, [])).toBe('visibleAssistant')
  })

  it('d 先于 f（§6-D1 顺序即语义锚）：todo_reminder + providerVisibility=visible → providerContextOnly，不因 origin=agent_runtime 判 hiddenSynthetic', () => {
    const data: MsgData = {
      role: 'user',
      semantics: {
        kind: 'todo_reminder',
        origin: 'agent_runtime',
        providerVisibility: 'visible',
        uiVisibility: 'visible',
        transcriptVisibility: 'hidden',
      },
    }
    expect(classifyMessage(data, [])).toBe('providerContextOnly')
  })

  it('e: kind=fork_notice → timelineOnly', () => {
    const data: MsgData = {
      role: 'user',
      semantics: { kind: 'fork_notice', origin: 'system', providerVisibility: 'hidden' },
    }
    expect(classifyMessage(data, [])).toBe('timelineOnly')
  })

  it('f 一（origin=agent_runtime）→ hiddenSynthetic', () => {
    const data: MsgData = {
      role: 'user',
      semantics: { kind: 'system_reminder', origin: 'agent_runtime', providerVisibility: 'hidden' },
    }
    expect(classifyMessage(data, [])).toBe('hiddenSynthetic')
  })

  it('f 二（uiVisibility=hidden）→ hiddenSynthetic', () => {
    const data: MsgData = {
      role: 'user',
      semantics: { kind: 'system_reminder', origin: 'system', providerVisibility: 'hidden', uiVisibility: 'hidden' },
    }
    expect(classifyMessage(data, [])).toBe('hiddenSynthetic')
  })

  it('f 三（transcriptVisibility=hidden）→ hiddenSynthetic', () => {
    const data: MsgData = {
      role: 'user',
      semantics: {
        kind: 'system_reminder',
        origin: 'system',
        providerVisibility: 'hidden',
        transcriptVisibility: 'hidden',
      },
    }
    expect(classifyMessage(data, [])).toBe('hiddenSynthetic')
  })
})

describe('③ 旧数据兜底链（无 semantics；顺序 = asar 原序）', () => {
  it('1a: visibility=model-only → providerContextOnly', () => {
    expect(classifyMessage({ role: 'user', visibility: 'model-only' }, [])).toBe('providerContextOnly')
  })

  it('1b: part.metadata.visibility=model-only（hasModelOnlyPart 通道一）→ providerContextOnly', () => {
    const parts: PartData[] = [textPart('context', { metadata: { visibility: 'model-only' } })]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('providerContextOnly')
  })

  it('1c: part.metadata.source=goal-continuation（hasModelOnlyPart 通道二）→ providerContextOnly', () => {
    const parts: PartData[] = [textPart('<system-reminder>...</system-reminder>', { metadata: { source: 'goal-continuation' } })]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('providerContextOnly')
  })

  it('2a: part.type=timeline → timelineOnly', () => {
    expect(classifyMessage({ role: 'user' }, [{ type: 'timeline' }])).toBe('timelineOnly')
  })

  it('2b: compaction part 带 metadata.timelineStatus → timelineOnly', () => {
    const parts: PartData[] = [{ type: 'compaction', metadata: { timelineStatus: 'active' } }]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('timelineOnly')
  })

  it('2c: compaction part 带 summaryMessageId（part 本体字段）→ timelineOnly', () => {
    const parts: PartData[] = [{ type: 'compaction', summaryMessageId: 'msg_summary_1' }]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('timelineOnly')
  })

  it('2d: part.metadata.forkContext.kind=session_fork → timelineOnly（forkContext 通道）', () => {
    const parts: PartData[] = [textPart('hi', { metadata: { forkContext: { kind: 'session_fork' } } })]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('timelineOnly')
  })

  it('2 负例：forkContext.kind 非 session_fork / compaction 无 timelineStatus 与 summaryMessageId → 不判 timelineOnly', () => {
    const forkish: PartData[] = [textPart('hi', { metadata: { forkContext: { kind: 'other_fork' } } })]
    expect(classifyMessage({ role: 'user' }, forkish)).toBe('realUserInput')
    const bare: PartData[] = [{ type: 'compaction' }]
    expect(classifyMessage({ role: 'user' }, bare)).toBe('realUserInput')
  })

  it('4: LEGACY 17 值（data.source=todo_reminder）→ providerContextOnly', () => {
    expect(classifyMessage({ role: 'user', source: 'todo_reminder' }, [textPart('The TodoWrite tool hasnt been used')])).toBe(
      'providerContextOnly',
    )
  })

  it('4: LEGACY 17 值（metadata.source=resume_referenced_session_context）→ providerContextOnly', () => {
    expect(
      classifyMessage({ role: 'user', metadata: { source: 'resume_referenced_session_context' } }, [textPart('Called the Read tool')]),
    ).toBe('providerContextOnly')
  })

  it('4 负例：MESSAGE_SOURCES 独有值 workflow_launch 不在 LEGACY 17 → 落到 role 收口 realUserInput', () => {
    expect(classifyMessage({ role: 'user', source: 'workflow_launch' }, [])).toBe('realUserInput')
  })

  it('5a: 遗留提醒文本——goal-continuation 前缀 → providerContextOnly', () => {
    const parts: PartData[] = [textPart('<system-reminder source="goal-continuation">Continue working toward the active session goal.</system-reminder>')]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('providerContextOnly')
  })

  it('5b: <system-reminder> 标签 + goal 续跑句（includes）→ providerContextOnly', () => {
    const parts: PartData[] = [textPart('<system-reminder>Continue working toward the active session goal. Current session goal state: x</system-reminder>')]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('providerContextOnly')
  })

  it('5c: <system-reminder> 标签 + goal state 句 → providerContextOnly', () => {
    const parts: PartData[] = [textPart('<system-reminder>Current session goal state</system-reminder>')]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('providerContextOnly')
  })

  it('5d: rewind applied 文本（includes，非前缀）→ providerContextOnly', () => {
    const parts: PartData[] = [textPart('Note: Conversation rewind applied. for the last turn')]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('providerContextOnly')
  })

  it('5 负例：<system-reminder> 但无 goal/rewind 特征 → 不命中提醒文本', () => {
    const parts: PartData[] = [textPart('<system-reminder>todo list updated</system-reminder>')]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('realUserInput')
  })

  it('6a: synthetic ∧ <task-notification> 前缀 → providerContextOnly（子代理完成通知）', () => {
    const parts: PartData[] = [textPart('<task-notification><task-id>agent_1</task-id><status>completed</status></task-notification>', { synthetic: true })]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('providerContextOnly')
  })

  it('6b: synthetic ∧ <subagent-notification> 前缀 → providerContextOnly', () => {
    const parts: PartData[] = [textPart('<subagent-notification>done</subagent-notification>', { synthetic: true })]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('providerContextOnly')
  })

  it('6 负例：通知文本但非 synthetic → 不判 providerContextOnly（∧ 条件）→ role 收口 realUserInput', () => {
    const parts: PartData[] = [textPart('<task-notification><task-id>x</task-id></task-notification>')]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('realUserInput')
  })

  it('6 边界：ignored=true 的 text part 不参与文本拼接（asar textFromParts 过滤）', () => {
    const parts: PartData[] = [textPart('<task-notification>x</task-notification>', { ignored: true, synthetic: true })]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('hiddenSynthetic')
  })

  it('6 边界：前导空白经 trimStart 后仍命中前缀', () => {
    const parts: PartData[] = [textPart('  <task-notification>x</task-notification>', { synthetic: true })]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('providerContextOnly')
  })

  it('6 边界：多 text part 拼接（join 零分隔）后命中前缀', () => {
    const parts: PartData[] = [textPart('<task', { synthetic: true }), textPart('-notification>x</task-notification>')]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('providerContextOnly')
  })

  it('7: 消息级 synthetic=true → hiddenSynthetic', () => {
    expect(classifyMessage({ role: 'user', synthetic: true }, [textPart('injected content')])).toBe('hiddenSynthetic')
  })

  it('7: 仅 part 级 synthetic=true（旧版数据 479 条泄漏形态的兜底）→ hiddenSynthetic', () => {
    const parts: PartData[] = [textPart('This session is being continued from a previous conversation.', { synthetic: true })]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('hiddenSynthetic')
  })

  it('8: 无 semantics 的 assistant → visibleAssistant（role 收口）', () => {
    expect(classifyMessage({ role: 'assistant' }, [textPart('hello')])).toBe('visibleAssistant')
  })

  it('9: 全空兜底 → realUserInput', () => {
    expect(classifyMessage({ role: 'user' }, [textPart('继续')])).toBe('realUserInput')
  })
})

describe('④ fork 四通道专项（独立分支防穿透——设计 §7.2 fork 分支注释）', () => {
  it('通道一：data.source=fork → timelineOnly（isTimelineOnlyMessage 捕获）', () => {
    expect(classifyMessage({ role: 'user', source: 'fork' }, [])).toBe('timelineOnly')
  })

  it('通道二：metadata.source=fork → timelineOnly（isTimelineOnlyMessage 捕获）', () => {
    expect(classifyMessage({ role: 'user', metadata: { source: 'fork' } }, [])).toBe('timelineOnly')
  })

  it('通道三：semantics.source=fork（六分支全落空的 semantics 形态）→ timelineOnly（独立分支捕获）', () => {
    // origin=real_user 被 synthetic=true 压掉 b 分支，providerVisibility 缺省压掉 d，
    // origin 非 agent_runtime 压掉 f——落到兜底链后由 src==='fork' 独立分支收口
    const data: MsgData = {
      role: 'user',
      synthetic: true,
      semantics: { kind: 'user_prompt', origin: 'real_user', source: 'fork', providerVisibility: 'hidden' },
    }
    expect(classifyMessage(data, [])).toBe('timelineOnly')
  })

  it('通道四：仅 part 级 metadata.source=fork → timelineOnly（独立分支存在性的关键回归：漏掉即穿透 realUserInput）', () => {
    const parts: PartData[] = [textPart('fork context', { metadata: { source: 'fork' } })]
    expect(classifyMessage({ role: 'user' }, parts)).toBe('timelineOnly')
  })

  it('优先级交互一：data.source=rewind + metadata.source=fork → timelineOnly（_N 直查 metadata 通道，先于 kN 归一）', () => {
    const data: MsgData = { role: 'user', source: 'rewind', metadata: { source: 'fork' } }
    expect(classifyMessage(data, [])).toBe('timelineOnly')
  })

  it('优先级交互二：data.source=todo_reminder + part 级 source=fork → providerContextOnly（四路回退高通道胜出，part 通道不被消费）', () => {
    const parts: PartData[] = [textPart('fork context', { metadata: { source: 'fork' } })]
    expect(classifyMessage({ role: 'user', source: 'todo_reminder' }, parts)).toBe('providerContextOnly')
  })
})

describe('⑤ 与 asar 的两处有意偏离（设计裁决，非移植误差）', () => {
  it('偏离一（D2/D5）：compact_summary 特判返回 compactSummary——asar 同分支返回 providerContextOnly', () => {
    const data: MsgData = {
      role: 'user',
      semantics: { kind: 'compact_summary', origin: 'agent_runtime', providerVisibility: 'visible' },
    }
    expect(classifyMessage(data, [])).toBe('compactSummary')
  })

  it('偏离二（D4）：未知枚举返回 unclassified——asar 无此概念（静默落兜底链）', () => {
    expect(classifyMessage({ role: 'user', semantics: { kind: 'unknown_kind', origin: 'system' } }, [])).toBe('unclassified')
  })
})
