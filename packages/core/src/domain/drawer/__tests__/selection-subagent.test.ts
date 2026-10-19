/**
 * subagent 内容域选中态分区单测（display-containers §6.6①，selection/subagent.ts）。
 *
 * 覆盖：useSubagentSelection 视图（当前分区，切 session 自动跟随）/ setSubagentView /
 * clearSubagentView / readSubagentSelectionFor（updateFor 语义：已删 sid 不复活分区）/
 * per-session 分区隔离（A/B 互不污染）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/drawer/__tests__/selection-subagent.test.ts
 * 测试框架 vitest（禁止 node:test / tsx --test）。
 *
 * 状态隔离：beforeEach 调 _resetSubagentSelectionForTest() 清模块级单例分区。
 * （enteredFrom 进入来源态 2026-10-19 随 drawer workflow tab 删除移除。）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { Ref } from 'vue'
import { bindDrawerSessionId } from '../control'
import {
  readSubagentSelectionFor,
  setSubagentView,
  clearSubagentView,
  useSubagentSelection,
  _resetSubagentSelectionForTest,
} from '../selection/subagent'

/** 当前测试分区键（每用例新建绑定） */
let sid: Ref<string | null>

function focusSession(s: string | null): void {
  sid.value = s
}

beforeEach(() => {
  sid = ref<string | null>(null)
  bindDrawerSessionId(sid)
  _resetSubagentSelectionForTest()
})

describe('useSubagentSelection 视图 + set/clear 写入面', () => {
  it('setSubagentView 写 selectedSubagentId；clearSubagentView 归 null', () => {
    focusSession('A')
    const { selectedSubagentId } = useSubagentSelection()

    expect(selectedSubagentId.value).toBe(null)

    setSubagentView('subagent:A:s1')
    expect(selectedSubagentId.value).toBe('subagent:A:s1')

    clearSubagentView()
    expect(selectedSubagentId.value).toBe(null)
  })

  it('响应式：set 后视图 computed 即时更新（reactive 容器契约，ADR-0049 W2）', () => {
    focusSession('A')
    const { selectedSubagentId } = useSubagentSelection()
    setSubagentView('agentcall:acs-1')
    expect(selectedSubagentId.value).toBe('agentcall:acs-1')
  })

  it('per-session 分区：A 的选中不污染 B；切回 A 恢复', () => {
    focusSession('A')
    setSubagentView('subagent:A:s1')

    focusSession('B')
    const viewB = useSubagentSelection()
    expect(viewB.selectedSubagentId.value).toBe(null)

    setSubagentView('subagent:B:s2')
    expect(viewB.selectedSubagentId.value).toBe('subagent:B:s2')

    focusSession('A')
    const viewA = useSubagentSelection()
    expect(viewA.selectedSubagentId.value).toBe('subagent:A:s1')
  })
})

describe('readSubagentSelectionFor（复合谓词跨域读，updateFor 语义）', () => {
  it('按 sid 读选中态快照', () => {
    focusSession('A')
    setSubagentView('subagent:A:s1')

    const read = readSubagentSelectionFor('A', (s) => s.selectedSubagentId)
    expect(read).toBe('subagent:A:s1')
  })

  it('从未触达的 sid 惰性建分区返回默认值 null；已删分区 no-op 返回 undefined', () => {
    // 惰性 init（useSessionScopedState 契约）：未触达 sid 读回默认 null
    expect(readSubagentSelectionFor('never-touched', (s) => s.selectedSubagentId)).toBe(null)

    focusSession('A')
    setSubagentView('subagent:A:s1')
    clearSubagentView()
    expect(readSubagentSelectionFor('A', (s) => s.selectedSubagentId)).toBe(null)
  })
})
