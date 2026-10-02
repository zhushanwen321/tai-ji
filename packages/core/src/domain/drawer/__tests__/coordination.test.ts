/**
 * drawer coordination 协同层单测（TC2）。
 *
 * 覆盖：瞬时参数（selectedCommandName/detailFilePath 设置）/ 公开 API 薄封装。
 * [P4 s5 drawer-widget-removal] pendingOpen 置/读/消费、openTasksDrawerOnFirstData 守卫分发、
 * cleanup 注册（清 pendingOpenMap）用例已删——pendingOpen 机制随 tasks 域移除（PluginViewContainer 承接）。
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
  selectedCommandName,
  detailFilePath,
  toggleDrawer,
  toggleDrawerDock,
  _resetDrawerForTest,
} from '../coordination'

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

describe('公开 API 薄封装（close/toggle/setTab/toggleDock）', () => {
  it('close 关闭当前分区；toggle 从关到开可指定 tab、从开到关关闭；setTab 切 tab；toggleDock 切换钉住态', () => {
    focusSession('A')
    const { isOpen, activeTab, docked } = useDrawerControl()

    toggleDrawer('git') // 关 → 开（git tab）
    expect(isOpen.value).toBe(true)
    expect(activeTab.value).toBe('git')

    toggleDrawer() // 开 → 关
    expect(isOpen.value).toBe(false)

    setDrawerTab('browser') // 抽屉关闭时仅改 activeTab
    expect(activeTab.value).toBe('browser')
    expect(isOpen.value).toBe(false)

    toggleDrawerDock() // false → true
    expect(docked.value).toBe(true)
    toggleDrawerDock() // true → false
    expect(docked.value).toBe(false)

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
    const { isOpen, activeTab, selectedWorkflowName } = useDrawerControl()

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
