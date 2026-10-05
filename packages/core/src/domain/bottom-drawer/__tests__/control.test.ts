/**
 * bottom-drawer control 分区契约单测 —— display-containers u-w1-core 验收①「分区范式」。
 *
 * 覆盖：bindBottomDrawerSessionId 绑定 / per-session 分区隔离 + 切回恢复 /
 * 默认关（isOpen 不持久化语义锚）/ 协调函数开合切换 / null sid 不泄漏真实分区。
 *
 * 三视角：构建者白盒（Map 分区 + reactive 容器契约）、使用者黑盒（「按 ⌃` 开底抽屉、
 * 切会话 B 是关的、切回 A 仍开着」的用户可见语义）、观察者形态（状态读出形状）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/bottom-drawer/__tests__/control.test.ts
 * 测试框架 vitest（禁止 node:test / tsx --test）。core vitest 环境为 node。
 *
 * 状态隔离：模块级单例（controlState 分区），beforeEach 调 _resetBottomDrawerForTest()；
 * 绑定目标 ref 每用例新建（bindBottomDrawerSessionId 新 ref 覆盖语义）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { Ref } from 'vue'
import {
  bindBottomDrawerSessionId,
  getBoundBottomDrawerSessionId,
  getBottomDrawerControlState,
  useBottomDrawerControl,
} from '../control'
import {
  openBottomDrawer,
  closeBottomDrawer,
  toggleBottomDrawer,
  _resetBottomDrawerForTest,
} from '../coordination'

/** 当前测试分区键（每用例新建，bindBottomDrawerSessionId 覆盖绑定） */
let sid: Ref<string | null>

/** 切换当前 focused session（模拟 selectSession 改 active panel 的 session 绑定） */
function focusSession(s: string | null): void {
  sid.value = s
}

beforeEach(() => {
  sid = ref<string | null>(null)
  bindBottomDrawerSessionId(sid)
  _resetBottomDrawerForTest()
})

describe('bottom-drawer 分区范式（per-session 开合、不持久化）', () => {
  it('A 开底抽屉、切 B 默认关、切回 A 仍开（用户可见：各会话抽屉状态互不串）', () => {
    focusSession('A')
    const drawerA = useBottomDrawerControl()
    expect(drawerA.isOpen.value).toBe(false) // 默认关（刷新后底抽屉关闭的锚）
    openBottomDrawer()
    expect(drawerA.isOpen.value).toBe(true)

    focusSession('B')
    const drawerB = useBottomDrawerControl()
    expect(drawerB.isOpen.value).toBe(false) // B 独立分区，默认关

    focusSession('A')
    expect(useBottomDrawerControl().isOpen.value).toBe(true) // 切回恢复
  })

  it('sid 稳定下 open 的 mutate 立即生效（reactive 容器契约回归——plain object init 会失效）', () => {
    focusSession('A')
    const { isOpen } = useBottomDrawerControl()
    expect(isOpen.value).toBe(false) // 缓存建立（模拟组件已渲染）

    openBottomDrawer()

    expect(isOpen.value).toBe(true) // 漏 reactive() 时此断言红
  })

  it('分区零加员锚：控制态只有 isOpen（heightPct 是全局布局值不进分区，§7.1 粒度裁决）', () => {
    focusSession('A')
    openBottomDrawer()
    expect(Object.keys(getBottomDrawerControlState())).toEqual(['isOpen'])
  })
})

describe('协调函数（§7.1 openBottomDrawer / closeBottomDrawer / toggleBottomDrawer）', () => {
  it('open/close 成对翻转当前分区开合态', () => {
    focusSession('A')
    const { isOpen } = useBottomDrawerControl()
    openBottomDrawer()
    expect(isOpen.value).toBe(true)
    closeBottomDrawer()
    expect(isOpen.value).toBe(false)
  })

  it('toggle：关→开、开→关（⌃` 与 StatusBar 终端按钮的统一落点语义）', () => {
    focusSession('A')
    const { isOpen } = useBottomDrawerControl()
    toggleBottomDrawer()
    expect(isOpen.value).toBe(true)
    toggleBottomDrawer()
    expect(isOpen.value).toBe(false)
  })

  it('toggle 只作用于当前分区（B 分区不受 A 的切换影响）', () => {
    focusSession('A')
    toggleBottomDrawer()
    focusSession('B')
    toggleBottomDrawer()
    toggleBottomDrawer()
    focusSession('A')
    expect(useBottomDrawerControl().isOpen.value).toBe(true)
    focusSession('B')
    expect(useBottomDrawerControl().isOpen.value).toBe(false)
  })
})

describe('null sid 安全默认（未绑定/无活跃 session）', () => {
  it('公开 API 不抛错，且不泄漏进任何真实分区', () => {
    expect(getBoundBottomDrawerSessionId()).toBe(null)
    expect(() => {
      openBottomDrawer()
      toggleBottomDrawer()
      closeBottomDrawer()
    }).not.toThrow()

    // 绑定真实 sid 后其分区是默认关态——证明 null sid 期的开合没写进真实分区
    focusSession('X')
    expect(useBottomDrawerControl().isOpen.value).toBe(false)
  })

  it('bindBottomDrawerSessionId 幂等：同 ref 重复绑定不报错，新 ref 覆盖', () => {
    const refA = ref<string | null>('A')
    bindBottomDrawerSessionId(refA)
    expect(getBoundBottomDrawerSessionId()).toBe('A')

    bindBottomDrawerSessionId(refA) // 同 ref 重复绑定
    expect(getBoundBottomDrawerSessionId()).toBe('A')

    const refB = ref<string | null>('B')
    bindBottomDrawerSessionId(refB)
    expect(getBoundBottomDrawerSessionId()).toBe('B')

    refA.value = 'A2' // 旧 ref 不再生效（已解绑）
    expect(getBoundBottomDrawerSessionId()).toBe('B')
  })
})
