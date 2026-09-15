/**
 * drawer coordination 协同层单测（TC2）。
 *
 * 覆盖：瞬时参数（selectedCommandName/detailFilePath/browserUrl 设置 + consumeBrowserUrl 消费后清空）/ 公开 API 薄封装。
 * [P4 s5 drawer-widget-removal] pendingOpen 置/读/消费、openTasksDrawerOnFirstData 守卫分发、
 * cleanup 注册（清 pendingOpenMap）用例已删——pendingOpen 机制随 tasks 域移除（PluginViewContainer 承接）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/drawer/__tests__/coordination.test.ts
 * 测试框架 vitest（禁止 node:test / tsx --test）。
 *
 * 状态隔离：beforeEach 调 _resetDrawerForTest() 清模块级单例状态。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { Ref } from 'vue'
import { bindDrawerSessionId, useDrawerControl } from '../control'
import {
  openDrawerTab,
  closeDrawer,
  toggleDrawer,
  setDrawerTab,
  toggleDrawerDock,
  selectedCommandName,
  detailFilePath,
  browserUrl,
  consumeBrowserUrl,
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
})

describe('瞬时参数：设置 + 消费后清空', () => {
  it('openDrawerTab 的 opts 写入对应瞬时参数 ref', () => {
    focusSession('A')
    openDrawerTab('doc', { commandName: '/commit' })
    expect(selectedCommandName.value).toBe('/commit')

    openDrawerTab('detail', { filePath: 'src/foo.ts' })
    expect(detailFilePath.value).toBe('src/foo.ts')

    openDrawerTab('browser', { url: 'https://example.com' })
    expect(browserUrl.value).toBe('https://example.com')
  })

  it('consumeBrowserUrl 读取并清空（消费后为 null，不残留劫持下次打开）', () => {
    focusSession('A')
    openDrawerTab('browser', { url: 'https://example.com' })
    expect(browserUrl.value).toBe('https://example.com')

    const consumed = consumeBrowserUrl()
    expect(consumed).toBe('https://example.com')
    expect(browserUrl.value).toBe(null)

    // 未设置时消费返回 null
    expect(consumeBrowserUrl()).toBe(null)
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
    openDrawerTab('browser', { url: 'https://example.com' })
    expect(browserUrl.value).not.toBe(null)

    _resetDrawerForTest()

    expect(selectedCommandName.value).toBe(null)
    expect(detailFilePath.value).toBe(null)
    expect(browserUrl.value).toBe(null)
  })
})
