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
import type { SideDrawerTab, RightDrawerTab, DrawerControlState } from '../types'
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

// ── plan tab 扩展（plan 模式重设计 u1-drawer-tab，第 9 员）──
// 形态照 bashTask 先例：编译期断言由 tsc 系执行，运行期影子验证成员合法 + 默认控制态
// 零加员即可满足接口（plan tab 无选中态字段，OpenDrawerOptions 零加员）。

// 'plan' 可赋给 SideDrawerTab（成员缺失即 vue-tsc 红）
const planTab: SideDrawerTab = 'plan'

describe('drawer types：plan tab 扩展（plan 模式重设计 u1-drawer-tab）', () => {
  afterEach(() => {
    _resetDrawerControlForTest()
  })

  it("'plan' 是合法 SideDrawerTab 成员（编译期断言的运行期影子）", () => {
    expect(planTab).toBe('plan')
  })

  it("默认控制态零加员即满足接口（'plan' 作 activeTab 写入分区可读回）", () => {
    bindDrawerSessionId(ref<string | null>('sess-plan'))
    const state = getDrawerControlState()
    expect(state.activeTab).not.toBe('plan')
    state.activeTab = 'plan'
    expect(getDrawerControlState().activeTab).toBe('plan')
  })
})

// ── btw tab 扩展（btw-question D7，M3-a 第 10 员）──
// 形态照 bashTask 先例：编译期断言由 tsc 系执行，运行期影子验证成员合法 + 可选字段
// selectedBtwVid 零加员即可满足接口（默认控制态不写该字段的结构保证）。

// 'btw' 可赋给 SideDrawerTab（成员缺失即 vue-tsc 红）
const btwTab: SideDrawerTab = 'btw'

describe('drawer types：btw tab 扩展（btw-question D7，M3-a）', () => {
  afterEach(() => {
    _resetDrawerControlForTest()
  })

  it("'btw' 是合法 SideDrawerTab 成员（编译期断言的运行期影子）", () => {
    expect(btwTab).toBe('btw')
  })

  it('默认控制态不写 selectedBtwVid 即满足接口；分区内写入可读回', () => {
    // 可选性锚：minimalControlState 字面量（上方）未含 selectedBtwVid 仍满足接口，
    // 若未来改必填则该字面量 tsc 红，createDefaultControlState 构造点同步被迫改。
    expect(minimalControlState.selectedBtwVid).toBeUndefined()
    bindDrawerSessionId(ref<string | null>('sess-btw'))
    const state = getDrawerControlState()
    expect(state.selectedBtwVid).toBeUndefined()
    state.selectedBtwVid = 'btw:pi-1'
    expect(getDrawerControlState().selectedBtwVid).toBe('btw:pi-1')
  })

  it("'btw' 作 activeTab 写入分区可读回（DrawerPanel tab 元信息消费面）", () => {
    bindDrawerSessionId(ref<string | null>('sess-btw-tab'))
    const state = getDrawerControlState()
    expect(state.activeTab).not.toBe('btw')
    state.activeTab = 'btw'
    expect(getDrawerControlState().activeTab).toBe('btw')
  })
})

// ── 右抽屉 8 tab 枚举（display-containers §7.1，u-foundation 类型契约）──
// 形态照 bashTask/plan/btw 先例：编译期断言由 tsc 系执行，运行期影子验证成员合法。
// 负向断言用条件类型锚（不依赖 @ts-expect-error：若负向条件成立（即收窄被回退），
// 类型从 true 塌缩为 false，赋值即 tsc 红）。

// §7.1 终态 8 员逐字成员序（成员缺失/改序即 tsc 红）
const rightDrawerTabs: RightDrawerTab[] = ['git', 'doc', 'detail', 'subagent', 'bashTask', 'plan', 'btw', 'workflow']

// 'terminal' 不属于右抽屉终态枚举（已迁底抽屉）——若 RightDrawerTab 混入 'terminal'，本类型塌缩为 false、赋值 tsc 红
type TerminalIsNotRightTab = 'terminal' extends RightDrawerTab ? false : true
const terminalNegativeAnchor: TerminalIsNotRightTab = true

// SideDrawerTab W0 超集（10 员，行为不变——tab 数仍 10）：'terminal'/'browser' 仍合法
type TerminalIsSideDrawerTab = 'terminal' extends SideDrawerTab ? true : false
const terminalSideTabAnchor: TerminalIsSideDrawerTab = true
const sideDrawerW0Tabs: SideDrawerTab[] = ['terminal', 'browser', 'git', 'doc', 'detail', 'subagent', 'workflow', 'bashTask', 'plan', 'btw']

describe('drawer types：右抽屉 8 tab 枚举（display-containers §7.1，W0 超集不收窄）', () => {
  it('RightDrawerTab = §7.1 终态 8 员（编译期断言的运行期影子）', () => {
    expect(rightDrawerTabs).toEqual(['git', 'doc', 'detail', 'subagent', 'bashTask', 'plan', 'btw', 'workflow'])
  })

  it('SideDrawerTab 仍为 W0 超集 10 员（用户可见 L1 tab 条不变：tab 数仍 10 含 terminal/browser）', () => {
    expect(sideDrawerW0Tabs).toHaveLength(10)
    expect(sideDrawerW0Tabs).toContain('terminal')
    expect(sideDrawerW0Tabs).toContain('browser')
    expect(terminalSideTabAnchor).toBe(true)
  })

  it("'terminal' 不可赋给 RightDrawerTab（条件类型负向锚的运行期影子）", () => {
    expect(terminalNegativeAnchor).toBe(true)
  })
})
