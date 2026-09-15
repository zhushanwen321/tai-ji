/**
 * drawer control 分区契约单测（TC1）。
 *
 * 覆盖：bindDrawerSessionId 绑定 / per-session 分区隔离 + 切回恢复 / null sid no-op。
 * [P4 s5 drawer-widget-removal] tasks tab 强制 docked 用例与 FR-9（手动 open 清 pendingOpen）
 * 用例已删——pendingOpen 机制 + tasks tab 随 tasks 域移除（PluginViewContainer 承接）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/drawer/__tests__/control.test.ts
 * 测试框架 vitest（禁止 node:test / tsx --test）。core vitest 环境为 node（vue reactivity
 * ref/computed 在 node 环境可跑，无 DOM 依赖）。
 *
 * 状态隔离：drawer 域是模块级单例（controlState/瞬时参数跨用例残留），
 * beforeEach 调 _resetDrawerForTest()（coordination 导出，组合清 control 分区 + 瞬时参数）。
 * 绑定目标 ref 每个用例新建（bindDrawerSessionId 新 ref 覆盖语义）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { Ref } from 'vue'
import { bindDrawerSessionId, useDrawerControl, getBoundSessionId, bindViewedVidPanels, getViewedVids, drawerControl } from '../control'
import { openDrawerTab, toggleDrawerDock, closeDrawer, setDrawerTab, _resetDrawerForTest } from '../coordination'

/** 当前测试分区键（每用例新建，bindDrawerSessionId 覆盖绑定） */
let sid: Ref<string | null>

/** 切换当前 focused session（模拟 selectSession 改 active panel 的 session 绑定） */
function focusSession(s: string | null): void {
  sid.value = s
}

beforeEach(() => {
  sid = ref<string | null>(null)
  bindDrawerSessionId(sid)
  _resetDrawerForTest()
})

describe('drawer control 分区隔离与切回恢复', () => {
  it('A 开 git + docked，切 B 为默认态，切回 A 恢复三态（isOpen/activeTab/docked）', () => {
    focusSession('A')
    const { isOpen, activeTab, docked } = useDrawerControl()
    openDrawerTab('git')
    toggleDrawerDock() // docked=true（仅 A 分区）
    expect(isOpen.value).toBe(true)
    expect(activeTab.value).toBe('git')
    expect(docked.value).toBe(true)

    // 切到 B（B 独立操作，不影响 A 分区）
    focusSession('B')
    const drawerB = useDrawerControl()
    expect(drawerB.isOpen.value).toBe(false)
    expect(drawerB.activeTab.value).toBe('terminal')
    expect(drawerB.docked.value).toBe(false)

    // 切回 A
    focusSession('A')
    const drawerA = useDrawerControl()
    expect(drawerA.isOpen.value).toBe(true)
    expect(drawerA.activeTab.value).toBe('git')
    expect(drawerA.docked.value).toBe(true)
  })

  it('docked 仅当前分区，不污染其他 session', () => {
    focusSession('A')
    openDrawerTab('git')
    toggleDrawerDock()
    expect(useDrawerControl().docked.value).toBe(true)

    focusSession('B')
    expect(useDrawerControl().docked.value).toBe(false) // B 默认，不被 A 污染

    focusSession('A')
    expect(useDrawerControl().docked.value).toBe(true)
  })

  it('切 sid 后 isOpen 立即为 true（reactive 容器契约回归：plain object init 会失效）', () => {
    // 回归：init 工厂漏 reactive() 时，sid 稳定下 open 的 mutate 不触发 computed 重算，
    // isOpen 缓存旧值 false。修复后 reactive 容器使 mutate 正确传播。
    focusSession('A')
    const { isOpen, activeTab } = useDrawerControl()
    expect(isOpen.value).toBe(false) // 缓存建立（模拟组件已渲染）

    openDrawerTab('git') // 手动 toggle，sid 未变化

    expect(isOpen.value).toBe(true) // 修复前为 false（bug）
    expect(activeTab.value).toBe('git')
  })
})

describe('null sid no-op 语义', () => {
  it('绑定值为 null（绑定前等价态）时公开 API 不抛错、不写 Map 分区', () => {
    // sid 初始为 null（未绑定任何 session）。null sid 时 controlState.current 返回
    // 临时默认实例（不写 Map），update no-op——对 null 实例的 mutate 不持久。
    expect(getBoundSessionId()).toBe(null)
    expect(() => {
      openDrawerTab('git')
      openDrawerTab('terminal', { commandName: '/commit' })
    }).not.toThrow()

    // 绑定真实 sid 后，其分区是默认态（isOpen=false/activeTab=terminal）——
    // 证明 null sid 期的 open 没有泄漏进任何真实分区
    focusSession('X')
    const drawer = useDrawerControl()
    expect(drawer.isOpen.value).toBe(false)
    expect(drawer.activeTab.value).toBe('terminal')
    expect(drawer.docked.value).toBe(false)
  })

  it('bindDrawerSessionId 幂等：重复绑定同一 ref 不报错，新 ref 覆盖', () => {
    const refA = ref<string | null>('A')
    bindDrawerSessionId(refA)
    expect(getBoundSessionId()).toBe('A')

    bindDrawerSessionId(refA) // 同 ref 重复绑定
    expect(getBoundSessionId()).toBe('A')

    const refB = ref<string | null>('B')
    bindDrawerSessionId(refB) // 新 ref 覆盖
    expect(getBoundSessionId()).toBe('B')

    refA.value = 'A2' // 旧 ref 不再生效（已解绑）
    expect(getBoundSessionId()).toBe('B')
  })
})

describe('B9 getViewedVids：agentcall LRU 联动豁免查询源（panel 枚举）', () => {
  // [B9] 豁免查询源钉死 panel 枚举：逐 panel → focusedSessionId → drawer 分区 → 当前选中
  // vid（isOpen + activeTab==='subagent' + selectedSubagentId 三分量同时满足）。禁止 drawer
  // 分区全枚举（曾开过 drawer 的 session 焦点切走后分区保留，全枚举会永久过度豁免）。
  /** panel 枚举源（每用例新建 + 重绑定，模拟 renderer 装配层注册） */
  let panels: Ref<Array<string | null>>

  beforeEach(() => {
    panels = ref<Array<string | null>>([])
    bindViewedVidPanels(panels)
  })

  it('panel 焦点 session 的 drawer 正在查看 subagent tab → 该 vid 计入豁免集', () => {
    focusSession('A')
    drawerControl.setSubagentView('agentcall:acs-1', 'workflow')
    panels.value = ['A']

    expect(getViewedVids()).toEqual(new Set(['agentcall:acs-1']))
  })

  it('关闭 drawer 后不豁免（A6：关闭 drawer 后再切走，分区应可释放）', () => {
    focusSession('A')
    drawerControl.setSubagentView('agentcall:acs-1', 'workflow')
    closeDrawer()
    panels.value = ['A']

    expect(getViewedVids()).toEqual(new Set())
  })

  it('drawer 开在其他 tab（非 subagent）→ 不算正在查看，不豁免', () => {
    focusSession('A')
    drawerControl.setSubagentView('agentcall:acs-1', 'workflow')
    setDrawerTab('terminal')
    panels.value = ['A']

    expect(getViewedVids()).toEqual(new Set())
  })

  it('多 panel 全查（split 模式）：各 panel 焦点分区的选中 vid 都计入；null panel 跳过', () => {
    focusSession('A')
    drawerControl.setSubagentView('agentcall:acs-a', 'workflow')
    focusSession('B')
    drawerControl.setSubagentView('subagent:B:s1', 'chat')
    panels.value = ['A', null, 'B']

    expect(getViewedVids()).toEqual(new Set(['agentcall:acs-a', 'subagent:B:s1']))
  })

  it('禁止全枚举：panel 枚举外的分区（曾开过 drawer、焦点已切走）不计入豁免集', () => {
    // B 曾开过 drawer 选中 acs-b，焦点切走后 B 分区保留——但 panel 枚举只含 A，
    // B 的选中 vid 不得进入豁免集（否则永久过度豁免）
    focusSession('B')
    drawerControl.setSubagentView('agentcall:acs-b', 'workflow')
    focusSession('A')
    drawerControl.setSubagentView('agentcall:acs-a', 'workflow')
    panels.value = ['A']

    expect(getViewedVids()).toEqual(new Set(['agentcall:acs-a']))
  })

  it('panel 枚举为空列表（无 panel 或全 null）→ 空集（安全默认：驱逐无豁免）', () => {
    panels.value = [] // beforeEach 绑定后即空列表
    focusSession('A')
    drawerControl.setSubagentView('agentcall:acs-1', 'workflow')

    expect(getViewedVids()).toEqual(new Set())
  })
})
