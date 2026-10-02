/**
 * drawer types 单测 —— bashTask tab 扩展（background-task-sidebar-view D5①，u-renderer-store）
 * + display-containers §6.6① 五字段迁出（W0 还债）后的类型锚。
 *
 * 类型级断言（'bashTask' ∈ SideDrawerTab / BashTaskSelectionState.selectedBackgroundTaskId?:
 * string）由 tsc 系（vue-tsc build / lint）在本文件的赋值语句上执行——vitest 的 esbuild
 * 转译不校验类型，故运行期用例走真实分区对象验证字段行为：默认态不写新字段即满足接口
 *（可选成员——各 createDefault* 构造点无需改动的结构保证）+ 分区内写入可读回。
 *
 * [display-containers §6.6①/③ W0] DrawerControlState 收窄为 { isOpen, activeTab }：
 * 选中态五字段迁出至 selection/ 各内容域分区（选中态行为断言随迁）；docked 死状态删除。
 *
 * 运行：cd packages/core && npx vitest run src/domain/drawer/__tests__/types.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { ref } from 'vue'
import type { SideDrawerTab, RightDrawerTab, DrawerControlState } from '../types'
import { bindDrawerSessionId, getDrawerControlState, _resetDrawerControlForTest } from '../control'
import type { BashTaskSelectionState } from '../selection/bash-task'
import type { BtwSelectionState } from '../selection/btw'
import {
  useBashTaskSelection,
  setBackgroundTaskView,
  _resetBashTaskSelectionForTest,
} from '../selection/bash-task'
import { useBtwSelection, setBtwView, _resetBtwSelectionForTest } from '../selection/btw'

// ── 编译期断言（tsc 系执行；esbuild 剥离不报错，与运行期用例共存不冲突）──

// 'bashTask' 可赋给 SideDrawerTab（成员缺失即 vue-tsc 红）
const bashTaskTab: SideDrawerTab = 'bashTask'

// 控制态最小面（display-containers §6.6①/③ 后仅两字段）：若控制态被回填寄生字段，
// 本对象字面量不受影响，但下方「五字段不在 DrawerControlState」负向锚会红
const minimalControlState: DrawerControlState = {
  isOpen: false,
  activeTab: 'terminal',
}

// 选中态可选性锚：默认分区构造（reactive({})）不写字段即满足接口（若未来改必填，
// createDefault* 构造点与本字面量同步被迫改——登记提示）
const minimalBashTaskSelection: BashTaskSelectionState = {}
const minimalBtwSelection: BtwSelectionState = {}

describe('drawer types：bashTask tab 扩展（D5①）', () => {
  afterEach(() => {
    _resetDrawerControlForTest()
    _resetBashTaskSelectionForTest()
    _resetBtwSelectionForTest()
  })

  it("'bashTask' 是合法 SideDrawerTab 成员（编译期断言的运行期影子）", () => {
    expect(bashTaskTab).toBe('bashTask')
  })

  it('bashTask 选中态默认未选中；分区内写入可读回（selection/bash-task.ts，§6.6① 迁出后落点）', () => {
    bindDrawerSessionId(ref<string | null>('sess-bt'))
    expect(minimalBashTaskSelection.selectedBackgroundTaskId).toBeUndefined()
    expect(useBashTaskSelection().selectedBackgroundTaskId.value).toBeUndefined()
    setBackgroundTaskView('bt-abc123')
    expect(useBashTaskSelection().selectedBackgroundTaskId.value).toBe('bt-abc123')
    setBackgroundTaskView(undefined)
    expect(useBashTaskSelection().selectedBackgroundTaskId.value).toBeUndefined()
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
// selectedBtwVid 零加员即可满足接口（默认分区不写该字段的结构保证）。

// 'btw' 可赋给 SideDrawerTab（成员缺失即 vue-tsc 红）
const btwTab: SideDrawerTab = 'btw'

describe('drawer types：btw tab 扩展（btw-question D7，M3-a）', () => {
  afterEach(() => {
    _resetDrawerControlForTest()
    _resetBtwSelectionForTest()
  })

  it("'btw' 是合法 SideDrawerTab 成员（编译期断言的运行期影子）", () => {
    expect(btwTab).toBe('btw')
  })

  it('btw 选中态默认未查看；分区内写入可读回（selection/btw.ts，§6.6① 迁出后落点）', () => {
    // 可选性锚：minimalBtwSelection 字面量（上方）未含 selectedBtwVid 仍满足接口，
    // 若未来改必填则该字面量 tsc 红，createDefaultBtwSelection 构造点同步被迫改。
    expect(minimalBtwSelection.selectedBtwVid).toBeUndefined()
    bindDrawerSessionId(ref<string | null>('sess-btw'))
    expect(useBtwSelection().selectedBtwVid.value).toBeUndefined()
    setBtwView('btw:pi-1')
    expect(useBtwSelection().selectedBtwVid.value).toBe('btw:pi-1')
    setBtwView(undefined)
    expect(useBtwSelection().selectedBtwVid.value).toBeUndefined()
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

// ── display-containers §6.6①/③ 控制态收窄锚（W0 还债）──
// 五字段与 docked 不在 DrawerControlState（若被回填进控制态，本负向锚塌缩为 false、赋值 tsc 红）。
type ParasiteFieldsRemoved = 'docked' extends keyof DrawerControlState
  ? false
  : 'selectedSubagentId' extends keyof DrawerControlState
    ? false
    : 'selectedBtwVid' extends keyof DrawerControlState
      ? false
      : true
const controlStateSlimAnchor: ParasiteFieldsRemoved = true

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

  it('DrawerControlState 仅 { isOpen, activeTab }（五字段迁出 + docked 删除的负向锚运行期影子）', () => {
    expect(controlStateSlimAnchor).toBe(true)
    expect(Object.keys(minimalControlState).sort()).toEqual(['activeTab', 'isOpen'])
  })
})
