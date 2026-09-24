/**
 * zcode 会话语义闭集写死锚（消息投影对齐设计 §6-D5，先例形态 =
 * host-db-suffix-parity.test.ts 的「SSOT 改错即红」）。
 * 来源注记：自 runtime test/zcode-semantics-parity.test.ts dev 演进版整文件移植
 * （用例零改动，git 可追溯）——SSOT 随实现迁入本包，锚随 SSOT 同址。
 *
 * 期望值逐段写死（不用数组字面量期望值做整体比对，逐成员独立断言）：semantics.ts 的
 * 五个闭集常量任何一个被改错 / 删值 / 改序（语义上无序，但写死形态连顺序漂移一起拦），
 * 本文件即红——把「zcode 升级新增枚举值」从运行时静默泄漏变成构建期红灯。
 *
 * PROJECTION_POLICIES 成员的两类锚定来源（刻意区分，防误把它整体当 asar 返回域对拍）：
 *   - zcode 原生 5 值（realUserInput / visibleAssistant / providerContextOnly /
 *     hiddenSynthetic / timelineOnly）：对拍 asar getConversationMessageProjectionPolicy
 *     返回域（asar 全量对拍 0 非预期分歧——对拍报告属 .tmp 工作流产物不入库，
 *     实测口径以本文件期望值为准）；
 *   - compactSummary：taiji 特判落点，asar 同分支返回 providerContextOnly，taiji 侧改落
 *     compaction entry（设计 §6-D2 规格）——锚定 D2 规格，不对拍 asar；
 *   - unclassified 不在闭集：它是 D4 降级态而非投影策略，不参与策略 → entry 落点映射。
 */

import { describe, expect, it } from 'vitest'

import {
  LEGACY_METADATA_SOURCES,
  MESSAGE_SOURCES,
  PROJECTION_POLICIES,
  PROJECTION_POLICY_SET,
  SEMANTICS_KINDS,
  SEMANTICS_ORIGINS,
} from '../semantics.ts'
import { classifyMessage } from '../projection.ts'

describe('semantics.kind 闭集（12 值，逐成员写死）', () => {
  it('长度恒为 12（zcode 新增 kind 时此处红——登记新值 + 补落点映射 + 补降级档位）', () => {
    expect(SEMANTICS_KINDS.length).toBe(12)
  })

  it('成员逐一等于 §4.2 值域表', () => {
    expect(SEMANTICS_KINDS[0]).toBe('user_prompt')
    expect(SEMANTICS_KINDS[1]).toBe('slash_command')
    expect(SEMANTICS_KINDS[2]).toBe('system_reminder')
    expect(SEMANTICS_KINDS[3]).toBe('background_notification')
    expect(SEMANTICS_KINDS[4]).toBe('subagent_notification')
    expect(SEMANTICS_KINDS[5]).toBe('todo_reminder')
    expect(SEMANTICS_KINDS[6]).toBe('rewind_notice')
    expect(SEMANTICS_KINDS[7]).toBe('fork_notice')
    expect(SEMANTICS_KINDS[8]).toBe('timeline_event')
    expect(SEMANTICS_KINDS[9]).toBe('compact_summary')
    expect(SEMANTICS_KINDS[10]).toBe('shared_context')
    expect(SEMANTICS_KINDS[11]).toBe('assistant_response')
  })
})

describe('semantics.origin 闭集（5 值，逐成员写死）', () => {
  it('长度恒为 5', () => {
    expect(SEMANTICS_ORIGINS.length).toBe(5)
  })

  it('成员逐一等于 §4.2 值域表', () => {
    expect(SEMANTICS_ORIGINS[0]).toBe('real_user')
    expect(SEMANTICS_ORIGINS[1]).toBe('agent_runtime')
    expect(SEMANTICS_ORIGINS[2]).toBe('system')
    expect(SEMANTICS_ORIGINS[3]).toBe('migration')
    expect(SEMANTICS_ORIGINS[4]).toBe('import')
  })
})

describe('顶层 source 闭集（12 值，逐成员写死）', () => {
  it('长度恒为 12', () => {
    expect(MESSAGE_SOURCES.length).toBe(12)
  })

  it('成员逐一等于 §4.2 值域表', () => {
    expect(MESSAGE_SOURCES[0]).toBe('background_task')
    expect(MESSAGE_SOURCES[1]).toBe('fork')
    expect(MESSAGE_SOURCES[2]).toBe('goal_state_change')
    expect(MESSAGE_SOURCES[3]).toBe('goal-continuation')
    expect(MESSAGE_SOURCES[4]).toBe('plugin_reference')
    expect(MESSAGE_SOURCES[5]).toBe('rewind')
    expect(MESSAGE_SOURCES[6]).toBe('selection_side_chat')
    expect(MESSAGE_SOURCES[7]).toBe('subagent')
    expect(MESSAGE_SOURCES[8]).toBe('subagent_message')
    expect(MESSAGE_SOURCES[9]).toBe('todo_reminder')
    expect(MESSAGE_SOURCES[10]).toBe('workflow_launch')
    expect(MESSAGE_SOURCES[11]).toBe('shared_context')
  })
})

describe('metadata.source 旧字段闭集（17 值，逐成员写死）', () => {
  it('长度恒为 17（asar legacy 集合 vN 同尺寸；不含 fork——fork 走 timelineOnly 独立分支）', () => {
    expect(LEGACY_METADATA_SOURCES.length).toBe(17)
    expect(LEGACY_METADATA_SOURCES).not.toContain('fork')
  })

  it('成员逐一等于 §4.2 值域表', () => {
    expect(LEGACY_METADATA_SOURCES[0]).toBe('agent_control_message')
    expect(LEGACY_METADATA_SOURCES[1]).toBe('background_task')
    expect(LEGACY_METADATA_SOURCES[2]).toBe('goal-continuation')
    expect(LEGACY_METADATA_SOURCES[3]).toBe('goal_completion_verification')
    expect(LEGACY_METADATA_SOURCES[4]).toBe('goal_state_change')
    expect(LEGACY_METADATA_SOURCES[5]).toBe('plugin_reference')
    expect(LEGACY_METADATA_SOURCES[6]).toBe('queued_system_notification')
    expect(LEGACY_METADATA_SOURCES[7]).toBe('resume_goal_state')
    expect(LEGACY_METADATA_SOURCES[8]).toBe('resume_referenced_session_context')
    expect(LEGACY_METADATA_SOURCES[9]).toBe('rewind')
    expect(LEGACY_METADATA_SOURCES[10]).toBe('selection_side_chat')
    expect(LEGACY_METADATA_SOURCES[11]).toBe('subagent')
    expect(LEGACY_METADATA_SOURCES[12]).toBe('subagent_message')
    expect(LEGACY_METADATA_SOURCES[13]).toBe('target_continuation')
    expect(LEGACY_METADATA_SOURCES[14]).toBe('task_notification')
    expect(LEGACY_METADATA_SOURCES[15]).toBe('task_status')
    expect(LEGACY_METADATA_SOURCES[16]).toBe('todo_reminder')
  })
})

describe('投影策略闭集（6 值：asar 原生 5 + taiji 特判 1）', () => {
  it('长度恒为 6 且无重复成员', () => {
    expect(PROJECTION_POLICIES.length).toBe(6)
    expect(PROJECTION_POLICY_SET.size).toBe(6)
  })

  it('zcode 原生 5 值逐一写死（锚定 asar getConversationMessageProjectionPolicy 返回域）', () => {
    expect(PROJECTION_POLICIES[0]).toBe('realUserInput')
    expect(PROJECTION_POLICIES[1]).toBe('visibleAssistant')
    expect(PROJECTION_POLICIES[2]).toBe('providerContextOnly')
    expect(PROJECTION_POLICIES[3]).toBe('hiddenSynthetic')
    expect(PROJECTION_POLICIES[4]).toBe('timelineOnly')
  })

  it('第六成员 = compactSummary（taiji 特判落点，锚定 D2 规格——asar 同分支返回 providerContextOnly，非 asar 对拍成员）', () => {
    expect(PROJECTION_POLICIES[5]).toBe('compactSummary')
  })

  it('unclassified 不在闭集（D4 降级态，不是投影策略）', () => {
    expect(PROJECTION_POLICIES).not.toContain('unclassified')
    expect(PROJECTION_POLICY_SET.has('unclassified')).toBe(false)
  })
})

describe('闭集常量冻结形态（五常量均 Object.freeze）', () => {
  it('写操作静默失效（冻结生效）', () => {
    expect(Object.isFrozen(SEMANTICS_KINDS)).toBe(true)
    expect(Object.isFrozen(SEMANTICS_ORIGINS)).toBe(true)
    expect(Object.isFrozen(MESSAGE_SOURCES)).toBe(true)
    expect(Object.isFrozen(LEGACY_METADATA_SOURCES)).toBe(true)
    expect(Object.isFrozen(PROJECTION_POLICIES)).toBe(true)
  })
})

describe('分类器输出域包含性（classifyMessage 只产闭集策略或 unclassified）', () => {
  it('分支覆盖语料的全部输出 ∈ PROJECTION_POLICIES ∪ {unclassified}', () => {
    const corpus: Array<{ data: Record<string, unknown>; parts: ReadonlyArray<Record<string, unknown>> }> = [
      { data: { role: 'user', semantics: { kind: 'user_prompt', origin: 'real_user' } }, parts: [] },
      { data: { role: 'assistant', semantics: { kind: 'assistant_response', origin: 'agent_runtime', providerVisibility: 'hidden', uiVisibility: 'visible', transcriptVisibility: 'visible' } }, parts: [] },
      { data: { role: 'user', semantics: { kind: 'todo_reminder', origin: 'agent_runtime', providerVisibility: 'visible' } }, parts: [] },
      { data: { role: 'user', semantics: { kind: 'system_reminder', origin: 'agent_runtime', providerVisibility: 'hidden' } }, parts: [] },
      { data: { role: 'assistant', semantics: { kind: 'timeline_event', origin: 'agent_runtime', providerVisibility: 'hidden' } }, parts: [] },
      { data: { role: 'user', semantics: { kind: 'compact_summary', origin: 'agent_runtime', providerVisibility: 'visible' } }, parts: [] },
      { data: { role: 'user', semantics: { kind: 'fork_notice', origin: 'system', providerVisibility: 'hidden' } }, parts: [] },
      { data: { role: 'user', summary: 'legacy summary' }, parts: [] },
      { data: { role: 'user', visibility: 'model-only' }, parts: [] },
      { data: { role: 'user', source: 'fork' }, parts: [] },
      { data: { role: 'user', source: 'todo_reminder' }, parts: [] },
      { data: { role: 'user', synthetic: true }, parts: [{ type: 'text', text: '<task-notification>x</task-notification>', synthetic: true }] },
      { data: { role: 'user' }, parts: [{ type: 'text', text: 'x', synthetic: true }] },
      { data: { role: 'assistant' }, parts: [] },
      { data: { role: 'user' }, parts: [] },
      { data: { role: 'user', semantics: { kind: 'future_kind', origin: 'real_user' } }, parts: [] },
      { data: { role: 'user', metadata: { source: 'plan_file_reference' } }, parts: [] },
    ]
    for (const { data, parts } of corpus) {
      const policy = classifyMessage(data, parts)
      expect(PROJECTION_POLICY_SET.has(policy) || policy === 'unclassified').toBe(true)
    }
  })
})
