/**
 * CrashRecoveredBar.vue 组件测试（crash-resilience §3.1 T2 / §4 A3）。
 *
 * 三视角 DOM 断言（TEST-STRATEGY §3，RespawnNoticeBar.test.ts 同型）：
 * - 标志存在：T2 文案可见（已从崩溃中恢复 + 原因 + 会话数据未丢失）+ 关闭按钮可见
 * - oom reason →「内存不足」（设计 T2 唯一定义的措辞）；其余 reason →「未知原因」
 * - 标志缺失：不渲染（一次性语义：消费即清除，后续挂载不再出现）
 * - 关闭按钮 → 条消失（用户主动出口）
 *
 * 运行：cd packages/renderer && npx vitest run src/components/ui/__tests__/CrashRecoveredBar.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import CrashRecoveredBar from '../CrashRecoveredBar.vue'
import {
  _resetCrashRecoveryNoticeForTest,
} from '@/composables/useCrashRecoveryNotice'

/** 置 URL query（happy-dom 的 history.replaceState） */
function setQuery(qs: string): void {
  window.history.replaceState(null, '', qs ? `/?${qs}` : '/')
}

describe('CrashRecoveredBar renderer 崩溃恢复提示条（T2）', () => {
  beforeEach(() => {
    _resetCrashRecoveryNoticeForTest()
    setQuery('')
  })

  it('标志存在：T2 文案可见（崩溃恢复 + oom→内存不足 + 会话数据未丢失）+ 关闭按钮可见', () => {
    setQuery('recoveredFrom=crash&crashReason=oom')
    const wrapper = mount(CrashRecoveredBar)
    const bar = wrapper.find('[data-testid="crash-recovered-bar"]')
    expect(bar.exists()).toBe(true)
    // 用户可见 T2 文案三要素（设计原文：界面已从崩溃中恢复（原因：内存不足），你的会话数据未丢失）
    const text = wrapper.find('[data-testid="crash-recovered-text"]').text()
    expect(text).toContain('界面已从崩溃中恢复')
    expect(text).toContain('内存不足')
    expect(text).toContain('你的会话数据未丢失')
    expect(wrapper.find('[data-testid="crash-recovered-dismiss"]').exists()).toBe(true)
  })

  it('非 oom reason：fallback「未知原因」，不向用户暴露英文技术值', () => {
    setQuery('recoveredFrom=crash&crashReason=killed')
    const wrapper = mount(CrashRecoveredBar)
    const text = wrapper.find('[data-testid="crash-recovered-text"]').text()
    expect(text).toContain('未知原因')
    expect(text).not.toContain('killed')
  })

  it('一次性语义：消费即剥离 query，刷新（模块重载）后挂载不再出现', () => {
    // 首个实例消费标志（同真实时序：消费即 replaceState 清 query）
    setQuery('recoveredFrom=crash&crashReason=oom')
    const first = mount(CrashRecoveredBar)
    expect(first.find('[data-testid="crash-recovered-bar"]').exists()).toBe(true)
    first.unmount()
    // URL 已被消费剥离（刷新后重复出现的根因已消除）
    expect(window.location.search).not.toContain('recoveredFrom')
    // 模拟手动刷新后模块重载（reset = 模块级状态归零，同新窗口），query 已无标志 → 不再渲染
    _resetCrashRecoveryNoticeForTest()
    const second = mount(CrashRecoveredBar)
    expect(second.find('[data-testid="crash-recovered-bar"]').exists()).toBe(false)
  })

  it('关闭按钮点击 → 条消失（用户主动出口）', async () => {
    setQuery('recoveredFrom=crash&crashReason=oom')
    const wrapper = mount(CrashRecoveredBar)
    expect(wrapper.find('[data-testid="crash-recovered-bar"]').exists()).toBe(true)
    await wrapper.find('[data-testid="crash-recovered-dismiss"]').trigger('click')
    expect(wrapper.find('[data-testid="crash-recovered-bar"]').exists()).toBe(false)
  })
})
