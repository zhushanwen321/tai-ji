import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CANVAS_ACTIONS, CANVAS_MARKER_ACTIONS, CANVAS_MARKER } from '../marker'
import {
  CANVAS_ACTOR_MATRIX,
  TOOL_ACTION_MAP,
  CANVAS_TOOL_NAMES,
  NON_TOOL_ACTIONS,
  toolOfAction,
  allToolActions,
  allCanvasActions,
} from '../matrix'
import { ACTION_EVENT_MAP, CANVAS_EVENT_TYPES } from '../state'
import { CANVAS_ERROR_CODES, CANVAS_ERROR_RECOVERY } from '../errors'
import type { CanvasAction } from '../actions'

/**
 * U1 契约验收 ③：词表与工具映射表一致性。
 *
 * 对账口径（matrix.ts 文件头 SSOT）：16 action 全部进入映射对账、无悬空——
 * ① TOOL_ACTION_MAP 引用的每个 action ∈ CANVAS_ACTIONS（无幽灵 action）；
 * ② 映射动作并集 = 经工具可达 action 集：agent 列 true 的 11 个 + review-append
 *   （review actor 经 canvas_review 工具的写入路径，设计 §3.1(2) 审查编排节明文）；
 *   映射内每个 action 的可达格（agent 或 review）恒为 true——工具不暴露无权动作；
 * ③ NON_TOOL_ACTIONS = 其余 4 个 GUI-only 动作（agent 与 review 双 false，仅 user）；
 * ④ 并集 ∪ 非工具集 = 16 全集、交集为空。
 *
 * 注：设计 §3.1(1) 权限矩阵明文——decide-direction / dispatch / comment /
 * converge-check 仅 user、review-append 仅 review，「agent 侧不持有的 action
 * 不进任何工具」（§3.1(2)）。故「16 action 全被映射覆盖」的机器可验形态 =
 * 全部 16 个 action 均有显式归属（12 经工具 + 4 显式 GUI-only），而非 16 个全部
 * 进工具映射（那会与权限矩阵直接矛盾）。
 */

describe('U1 词表完整性', () => {
  it('U1 CANVAS_ACTIONS 恰 16 个、无重复', () => {
    expect(CANVAS_ACTIONS).toHaveLength(16)
    expect(new Set(CANVAS_ACTIONS).size).toBe(16)
  })

  it('U1 CANVAS_MARKER_ACTIONS = CANVAS_ACTIONS + enter，无重复', () => {
    expect(CANVAS_MARKER_ACTIONS).toHaveLength(17)
    expect(new Set(CANVAS_MARKER_ACTIONS).size).toBe(17)
    for (const action of CANVAS_ACTIONS) expect(CANVAS_MARKER_ACTIONS).toContain(action)
    expect(CANVAS_MARKER_ACTIONS).toContain('enter')
  })
})

describe('U1 工具映射一致性（6 工具动词族）', () => {
  it('U1 恰 6 个工具、无重复', () => {
    expect(CANVAS_TOOL_NAMES).toHaveLength(6)
    expect(new Set(CANVAS_TOOL_NAMES).size).toBe(6)
    expect([...CANVAS_TOOL_NAMES].sort()).toEqual(
      ['canvas_edit', 'canvas_enter', 'canvas_export', 'canvas_list', 'canvas_read', 'canvas_review'].sort(),
    )
  })

  it('U1 映射表引用的每个 action 都在词表内（无幽灵 action）', () => {
    for (const action of allToolActions()) {
      expect((CANVAS_ACTIONS as readonly string[]).includes(action), `幽灵 action: ${action}`).toBe(true)
    }
  })

  it('U1 映射动作并集 = 工具可达 action 集（agent 11 + review-append 1 = 12）', () => {
    const toolReachable = (CANVAS_ACTIONS as readonly CanvasAction[]).filter(
      (a) => CANVAS_ACTOR_MATRIX[a].agent || CANVAS_ACTOR_MATRIX[a].review,
    )
    expect(allToolActions().sort()).toEqual([...toolReachable].sort())
    expect(toolReachable).toHaveLength(12)
  })

  it('U1 映射内每个动作的可达格恒 true（工具不暴露无权动作）', () => {
    for (const action of allToolActions()) {
      const reachable = CANVAS_ACTOR_MATRIX[action].agent || CANVAS_ACTOR_MATRIX[action].review
      expect(reachable, `${action} 经工具可达但矩阵 agent/review 双 false`).toBe(true)
    }
  })

  it('U1 映射动作并集中 agent 可用的恰 11 个（agent 暴露面 = agent 列 true 集）', () => {
    const agentAllowed = allToolActions().filter((a) => CANVAS_ACTOR_MATRIX[a].agent)
    expect(agentAllowed).toHaveLength(11)
  })

  it('U1 各工具动作清单与设计 §3.1(2) 表逐工具一致', () => {
    expect([...TOOL_ACTION_MAP.canvas_enter].sort()).toEqual(['create'])
    expect([...TOOL_ACTION_MAP.canvas_edit].sort()).toEqual([
      'comment-respond',
      'grow',
      'patch',
      'select',
      'transition',
    ])
    expect([...TOOL_ACTION_MAP.canvas_read]).toEqual(['read'])
    expect([...TOOL_ACTION_MAP.canvas_review].sort()).toEqual(['review-append', 'review-request', 'review-resolve'])
    expect([...TOOL_ACTION_MAP.canvas_export]).toEqual(['export'])
    expect([...TOOL_ACTION_MAP.canvas_list]).toEqual(['list'])
  })

  it('U1 NON_TOOL_ACTIONS = 4 个 GUI-only 动作（agent 与 review 双 false）', () => {
    const nonTool = NON_TOOL_ACTIONS.map((n) => n.action).sort()
    const guiOnly = (CANVAS_ACTIONS as readonly CanvasAction[]).filter(
      (a) => !CANVAS_ACTOR_MATRIX[a].agent && !CANVAS_ACTOR_MATRIX[a].review,
    ).sort()
    expect(nonTool).toEqual([...guiOnly].sort())
    expect(nonTool).toEqual(['comment', 'converge-check', 'decide-direction', 'dispatch'])
  })

  it('U1 三方对账：映射并集 ∪ 非工具集 = 16 全集、交集为空（无悬空 action）', () => {
    const toolSet = new Set<string>(allToolActions())
    const nonToolSet = new Set<string>(NON_TOOL_ACTIONS.map((n) => n.action))
    for (const a of nonToolSet) expect(toolSet.has(a)).toBe(false)
    const union = new Set<string>([...toolSet, ...nonToolSet])
    expect(union.size).toBe(16)
    for (const action of allCanvasActions()) expect(union.has(action)).toBe(true)
  })

  it('U1 toolOfAction 反查与映射表一致；非工具动作反查为空', () => {
    expect(toolOfAction('grow')).toBe('canvas_edit')
    expect(toolOfAction('review-request')).toBe('canvas_review')
    expect(toolOfAction('review-append')).toBe('canvas_review')
    expect(toolOfAction('create')).toBe('canvas_enter')
    expect(toolOfAction('decide-direction')).toBeUndefined()
    expect(toolOfAction('dispatch')).toBeUndefined()
  })
})

describe('U1 事件词表与 action 对账 SSOT', () => {
  it('U1 ACTION_EVENT_MAP 键集 = 全部 mutation action（16 − read/list）', () => {
    const mutationActions = (CANVAS_ACTIONS as readonly string[]).filter((a) => a !== 'read' && a !== 'list')
    expect(Object.keys(ACTION_EVENT_MAP).sort()).toEqual([...mutationActions].sort())
  })

  it('U1 每个映射事件值 ∈ CANVAS_EVENT_TYPES（含 CommentResponded）', () => {
    expect(CANVAS_EVENT_TYPES).toContain('CommentResponded')
    expect(CANVAS_EVENT_TYPES).toContain('CanvasCreated')
    for (const ev of Object.values(ACTION_EVENT_MAP)) {
      expect((CANVAS_EVENT_TYPES as readonly string[]).includes(ev)).toBe(true)
    }
  })

  it('U1 read / list 不在事件对账范围（查询类不产事件）', () => {
    expect(ACTION_EVENT_MAP).not.toHaveProperty('read')
    expect(ACTION_EVENT_MAP).not.toHaveProperty('list')
  })
})

describe('U1 错误码表自洽', () => {
  it('U1 错误码无重复、恢复文案键集全等且每句非空', () => {
    expect(new Set(CANVAS_ERROR_CODES).size).toBe(CANVAS_ERROR_CODES.length)
    expect(Object.keys(CANVAS_ERROR_RECOVERY).sort()).toEqual([...CANVAS_ERROR_CODES].sort())
    for (const code of CANVAS_ERROR_CODES) {
      expect(CANVAS_ERROR_RECOVERY[code].length).toBeGreaterThan(0)
    }
  })

  it('U1 拦截场景关键码在册（双选定 / 成环 / 未收敛 / 重复处置 / 轮次上限）', () => {
    for (const code of ['selection_conflict', 'cycle_detected', 'not_converged', 'already_resolved', 'review_max_rounds'] as const) {
      expect(CANVAS_ERROR_CODES).toContain(code)
    }
  })
})

describe('U1 桶出口登记', () => {
  const INDEX_TS = resolve(__dirname, '../../../index.ts')

  it('U1 index.ts 导出 CANVAS_MARKER（三侧唯一 marker 入口）', () => {
    expect(readFileSync(INDEX_TS, 'utf-8')).toContain('CANVAS_MARKER')
  })

  it('U1 index.ts canvas 契约段注释头唯一（extensions 清单 SSOT 防双副本）', () => {
    const content = readFileSync(INDEX_TS, 'utf-8')
    const sectionHead = '── ./extensions/canvas：'
    const first = content.indexOf(sectionHead)
    expect(first).toBeGreaterThan(-1)
    expect(content.indexOf(sectionHead, first + 1)).toBe(-1)
  })
})

describe('U1 marker 值卫生', () => {
  it('U1 CANVAS_MARKER 为 NUL 前缀内部服务类 marker（不入对话框降级表的形态前提）', () => {
    expect(CANVAS_MARKER.charCodeAt(0)).toBe(0)
    expect(CANVAS_MARKER).not.toContain(' ')
  })
})
