/**
 * drawer coordination 协同层单测（TC2）。
 *
 * 覆盖：瞬时参数（selectedCommandName/detailFilePath 设置 + 按会话分区，
 * display-containers §6.6② 跨会话劫持消除）/ 公开 API 薄封装。
 * [P4 s5 drawer-widget-removal] pendingOpen 置/读/消费、openTasksDrawerOnFirstData 守卫分发、
 * cleanup 注册（清 pendingOpenMap）用例已删——pendingOpen 机制随 tasks 域移除（PluginViewContainer 承接）。
 * [display-containers §6.6③ W0] toggleDock 用例已删（docked 死状态全链删除）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/drawer/__tests__/coordination.test.ts
 * 测试框架 vitest（禁止 node:test / tsx --test）。
 *
 * 状态隔离：beforeEach 调 _resetDrawerForTest() 清模块级单例状态。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import type { Ref } from 'vue'
import type { WorkflowRunRecord } from '@taiji/shared'
import { bindDrawerSessionId, useDrawerControl } from '../control'
import {
  bindWorkflowOverlayOpener,
  bindWorkflowRunLookup,
  closeDrawer,
  lookupWorkflowRun,
  openDrawerTab,
  openWorkflow,
  openWorkflowInDrawer,
  setDrawerTab,
  toggleDrawer,
  _resetDrawerForTest,
} from '../coordination'
import { selectedCommandName, detailFilePath, useWorkflowSelection } from '../selection'

/** 当前测试分区键（每用例新建绑定） */
let sid: Ref<string | null>

function focusSession(s: string | null): void {
  sid.value = s
}

beforeEach(() => {
  sid = ref<string | null>(null)
  bindDrawerSessionId(sid)
  _resetDrawerForTest()
  // overlay 桥接绑定解绑（workflow-visualization U6：openWorkflow 改向后 openWorkflow 的
  // 单测不依赖 renderer 装配——各用例自行绑定，用例间解绑防串扰）
  bindWorkflowOverlayOpener(null)
  bindWorkflowRunLookup(null)
})

describe('瞬时参数：设置 + 消费后清空', () => {
  it('openDrawerTab 的 opts 写入对应瞬时参数 ref', () => {
    focusSession('A')
    openDrawerTab('doc', { commandName: '/commit' })
    expect(selectedCommandName.value).toBe('/commit')

    openDrawerTab('detail', { filePath: 'src/foo.ts' })
    expect(detailFilePath.value).toBe('src/foo.ts')
  })

  it('opts 缺省字段不覆盖已有瞬时参数（undefined 不写入）', () => {
    focusSession('A')
    openDrawerTab('doc', { commandName: '/commit' })
    openDrawerTab('git') // 无 opts——不应把 commandName 清掉
    expect(selectedCommandName.value).toBe('/commit')
  })
})

// ── display-containers §6.6② 瞬时参数按会话分区：跨会话劫持消除（W0 还债）──
// 改前全局单例：A 会话的链接点击会被 B 会话的旧参数污染（B 首开 doc/detail tab 显 A 的旧值）。
describe('瞬时参数按会话分区（跨会话劫持消除，display-containers §6.6②）', () => {
  it('A 设置的 commandName 不劫持 B 的首次打开（B 分区独立为 null）', () => {
    focusSession('A')
    openDrawerTab('doc', { commandName: '/commit' })
    expect(selectedCommandName.value).toBe('/commit')

    // 切到 B 首开 doc tab：不得看到 A 的旧参数（改前全局单例 → 劫持）
    focusSession('B')
    expect(selectedCommandName.value).toBe(null)
    openDrawerTab('doc')
    expect(selectedCommandName.value).toBe(null)

    // B 自己的参数独立写入，不回灌 A 分区
    openDrawerTab('doc', { commandName: '/fix' })
    expect(selectedCommandName.value).toBe('/fix')
    focusSession('A')
    expect(selectedCommandName.value).toBe('/commit')
  })

  it('A 设置的 detailFilePath 不劫持 B 的首次打开；B 消费后清空不影响 A', () => {
    focusSession('A')
    openDrawerTab('detail', { filePath: 'src/a.ts' })

    focusSession('B')
    expect(detailFilePath.value).toBe(null) // B 首开不被 A 旧值劫持
    openDrawerTab('detail', { filePath: 'src/b.ts' })
    expect(detailFilePath.value).toBe('src/b.ts')

    // 消费后清空（useDetailPane 语义）：只清 B 分区
    detailFilePath.value = null
    expect(detailFilePath.value).toBe(null)
    focusSession('A')
    expect(detailFilePath.value).toBe('src/a.ts') // A 分区保留（切回恢复展示链归 W3）
  })
})

describe('公开 API 薄封装（close/toggle/setTab）', () => {
  it('close 关闭当前分区；toggle 从关到开可指定 tab、从开到关关闭；setTab 切 tab', () => {
    focusSession('A')
    const { isOpen, activeTab } = useDrawerControl()

    toggleDrawer('git') // 关 → 开（git tab）
    expect(isOpen.value).toBe(true)
    expect(activeTab.value).toBe('git')

    toggleDrawer() // 开 → 关
    expect(isOpen.value).toBe(false)

    setDrawerTab('doc') // 抽屉关闭时仅改 activeTab
    expect(activeTab.value).toBe('doc')
    expect(isOpen.value).toBe(false)

    closeDrawer()
    expect(isOpen.value).toBe(false)
  })
})

describe('_resetDrawerForTest 测试隔离', () => {
  it('_resetDrawerForTest 清瞬时参数（测试隔离钩子）', () => {
    focusSession('A')
    openDrawerTab('doc', { commandName: '/commit' })
    openDrawerTab('detail', { filePath: 'src/foo.ts' })
    expect(detailFilePath.value).not.toBe(null)

    _resetDrawerForTest()

    expect(selectedCommandName.value).toBe(null)
    expect(detailFilePath.value).toBe(null)
  })
})

describe('workflow 入口语义分立（workflow-visualization U6/D1）', () => {
  it('openWorkflow 改向 = 调绑定的 overlay opener（转发 nameOrRunId + slug + sessionId 三参）', () => {
    focusSession('A')
    const opener = vi.fn()
    bindWorkflowOverlayOpener(opener)

    // 托盘路径：runId 直传（TrayNativePanel 零改动形态）
    openWorkflow('wf-run-1')
    expect(opener).toHaveBeenCalledWith('wf-run-1', undefined, undefined)

    // block 路径：(scriptName, slug, sessionId) 三参透传
    openWorkflow('flow-a', { slug: 's-2', sessionId: 's9' })
    expect(opener).toHaveBeenCalledWith('flow-a', 's-2', 's9')

    // 无参：空串转发（opener 侧兜底）
    openWorkflow()
    expect(opener).toHaveBeenCalledWith('', undefined, undefined)
  })

  it('openWorkflow 未绑定 opener 时 no-op（headless/测试安全默认，不抛错）', () => {
    focusSession('A')
    expect(() => openWorkflow('wf-run-1')).not.toThrow()
    // drawer 未被误开（改向后 openWorkflow 不再触达 drawerControl）
    expect(useDrawerControl().isOpen.value).toBe(false)
  })

  it('openWorkflowInDrawer = setWorkflowView 三步（切 workflow tab + 记录选中名 + 开 drawer）', () => {
    focusSession('A')
    const { isOpen, activeTab } = useDrawerControl()
    const { selectedWorkflowName } = useWorkflowSelection()

    // runId 形参（D10 回落链传 runId，精确命中）
    openWorkflowInDrawer('wf-run-1')
    expect(isOpen.value).toBe(true)
    expect(activeTab.value).toBe('workflow')
    expect(selectedWorkflowName.value).toBe('wf-run-1')

    // 空串（SubagentTab 返回按钮）：仅切 tab，不记录选中名
    openWorkflowInDrawer('')
    expect(selectedWorkflowName.value).toBe('')
    expect(activeTab.value).toBe('workflow')

    // 缺省同空串
    openWorkflowInDrawer()
    expect(selectedWorkflowName.value).toBe('')
  })

  it('openWorkflowInDrawer 不经 overlay opener（两条通道类型/运行时双分立，回落不重入 overlay 入口）', () => {
    focusSession('A')
    const opener = vi.fn()
    bindWorkflowOverlayOpener(opener)

    openWorkflowInDrawer('wf-run-1')
    expect(opener).not.toHaveBeenCalled()
  })

  it('lookupWorkflowRun 转发绑定 lookup；未绑定返回 undefined（安全默认）', () => {
    focusSession('A')
    expect(lookupWorkflowRun('s9', 'flow-a', 's-2')).toBeUndefined()

    const record: WorkflowRunRecord = {
      runId: 'wf-run-1',
      scriptName: 'flow-a',
      status: 'running',
      startedAt: '2026-10-02T00:00:00Z',
      agentCalls: [],
      stateFilePath: '',
    }
    const lookup = vi.fn(() => record)
    bindWorkflowRunLookup(lookup)
    expect(lookupWorkflowRun('s9', 'flow-a', 's-2')).toBe(record)
    expect(lookup).toHaveBeenCalledWith('s9', 'flow-a', 's-2')
  })
})
