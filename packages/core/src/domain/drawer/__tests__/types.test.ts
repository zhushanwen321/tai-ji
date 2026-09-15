/**
 * drawer types 单测 —— bashTask tab 扩展（background-task-sidebar-view D5①，u-renderer-store）。
 *
 * 类型级断言（'bashTask' ∈ SideDrawerTab / selectedBackgroundTaskId?: string）由 tsc 系
 * （vue-tsc build / lint）在本文件的赋值语句上执行——vitest 的 esbuild 转译不校验类型，
 * 故运行期用例走真实 control.ts 分区对象验证字段行为：默认控制态不写新字段即满足接口
 *（可选成员——control.ts createDefaultControlState 无需改动的结构保证）+ 分区内写入可读回。
 *
 * 运行：cd packages/core && npx vitest run src/domain/drawer/__tests__/types.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { ref } from 'vue'
import type { SideDrawerTab, DrawerControlState } from '../types'
import { bindDrawerSessionId, getDrawerControlState, _resetDrawerControlForTest } from '../control'

// ── 编译期断言（tsc 系执行；esbuild 剥离不报错，与运行期用例共存不冲突）──

// 'bashTask' 可赋给 SideDrawerTab（成员缺失即 vue-tsc 红）
const bashTaskTab: SideDrawerTab = 'bashTask'

// 不写 selectedBackgroundTaskId 也满足 DrawerControlState（可选性锚：若未来改为必填，
// 本对象字面量即 tsc 红，createDefaultControlState 构造点同步被迫改——登记提示）
const minimalControlState: DrawerControlState = {
  isOpen: false,
  activeTab: 'terminal',
  docked: false,
  selectedSubagentId: null,
  selectedWorkflowName: null,
  enteredFrom: null,
}

describe('drawer types：bashTask tab 扩展（D5①）', () => {
  afterEach(() => {
    _resetDrawerControlForTest()
  })

  it("'bashTask' 是合法 SideDrawerTab 成员（编译期断言的运行期影子）", () => {
    expect(bashTaskTab).toBe('bashTask')
  })

  it('默认控制态不写 selectedBackgroundTaskId 即满足接口；分区内写入可读回', () => {
    bindDrawerSessionId(ref<string | null>('sess-bt'))
    expect(minimalControlState.selectedBackgroundTaskId).toBeUndefined()
    const state = getDrawerControlState()
    expect(state.selectedBackgroundTaskId).toBeUndefined()
    state.selectedBackgroundTaskId = 'bt-abc123'
    expect(getDrawerControlState().selectedBackgroundTaskId).toBe('bt-abc123')
  })
})
