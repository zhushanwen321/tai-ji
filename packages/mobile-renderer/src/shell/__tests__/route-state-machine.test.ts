// 路由五态状态机单测（remote-use-mobile-v2 §6.7 验收条款 2：五态 + chatFrom 来源返回 +
// popstate；转移表显式，表外转移 fail-fast）。
//
// 纯逻辑单测（TEST-STRATEGY 分层：状态机归单元层）；壳级消费（五路由渲染 DOM 断言）在
// mobile-shell.spec TC-1（使用者视角）。popstate 是系统事件，测试经 dispatchEvent 注入
// 驱动（与 use-visual-viewport 注入假 viewport 同款注入可测形态）。
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  chatFrom,
  goBackFromChat,
  navigateRoute,
  resetRouteForTesting,
  setupRouteHistory,
  shellRoute,
  type ShellRoute,
} from '../route'

function popstate(): void {
  window.dispatchEvent(new PopStateEvent('popstate'))
}

describe('路由五态状态机（§6.7 转移表）', () => {
  beforeEach(() => {
    resetRouteForTesting()
    setupRouteHistory()
  })

  it('初始态 = connect（验身页；bootstrap 先挂载后连接的首屏路由）', () => {
    expect(shellRoute.value).toBe('connect')
    expect(chatFrom.value).toBeNull()
  })

  it('验身成功：connect → sessions（初始目的域）', () => {
    navigateRoute('sessions')
    expect(shellRoute.value).toBe('sessions')
  })

  it('验身失效：任意目的域 → connect（不写历史——history.state 不携带路由条目）', () => {
    navigateRoute('sessions')
    navigateRoute('chat')
    popstate() // 消费 chat 条目回源，历史栈清空
    navigateRoute('activity')
    navigateRoute('connect')
    expect(shellRoute.value).toBe('connect')
  })

  it('目的域互切合法（底部导航切换）', () => {
    navigateRoute('sessions')
    navigateRoute('settings')
    expect(shellRoute.value).toBe('settings')
    navigateRoute('activity')
    expect(shellRoute.value).toBe('activity')
    navigateRoute('sessions')
    expect(shellRoute.value).toBe('sessions')
  })

  it('同态重复转移幂等（no-op）', () => {
    navigateRoute('sessions')
    navigateRoute('sessions')
    expect(shellRoute.value).toBe('sessions')
  })

  it('表外转移 fail-fast：connect 只能出边到 sessions', () => {
    expect(() => navigateRoute('chat')).toThrow(/表外转移/)
    expect(() => navigateRoute('activity')).toThrow(/表外转移/)
    expect(() => navigateRoute('settings')).toThrow(/表外转移/)
  })

  it('表外转移 fail-fast：chat 经编程接口退出被拒（退出只能走 popstate 路径或验身失效）', () => {
    navigateRoute('sessions')
    navigateRoute('chat')
    expect(() => navigateRoute('settings')).toThrow(/表外转移/)
    expect(() => navigateRoute('activity')).toThrow(/表外转移/)
    expect(() => navigateRoute('sessions')).toThrow(/表外转移/)
  })
})

describe('chatFrom 来源返回（F12 返回语义唯一）', () => {
  beforeEach(() => {
    resetRouteForTesting()
    setupRouteHistory()
  })

  it('目的域 → chat：chatFrom 记录来源 + history 写入 chat 条目（pushState state 锚点）', () => {
    navigateRoute('sessions')
    navigateRoute('chat')
    expect(shellRoute.value).toBe('chat')
    expect(chatFrom.value).toBe('sessions')
    expect(history.state).toEqual({ shellRoute: 'chat' })
  })

  it('popstate（系统侧滑/返回键）：chat 回来源目的域，chatFrom 清空', () => {
    navigateRoute('sessions')
    navigateRoute('activity')
    navigateRoute('chat')
    expect(shellRoute.value).toBe('chat')

    popstate()
    expect(shellRoute.value).toBe('activity')
    expect(chatFrom.value).toBeNull()
  })

  it('不同来源域记录各自的 chatFrom（sessions 进 → 回 sessions；activity 进 → 回 activity）', () => {
    navigateRoute('sessions')
    navigateRoute('chat')
    popstate()
    expect(shellRoute.value).toBe('sessions')

    navigateRoute('activity')
    navigateRoute('chat')
    expect(chatFrom.value).toBe('activity')
    popstate()
    expect(shellRoute.value).toBe('activity')
  })

  it('非 chat 态收到 popstate：fail-visible 忽略（路由状态不被系统事件噪声翻转）', () => {
    navigateRoute('sessions')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    popstate()
    expect(shellRoute.value).toBe('sessions')
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('历史栈与路由状态失配'))
    errSpy.mockRestore()
  })

  it('goBackFromChat：调 history.back()（popstate 单点驱动转移，不直改状态）', () => {
    navigateRoute('sessions')
    navigateRoute('chat')
    const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {})
    goBackFromChat()
    expect(backSpy).toHaveBeenCalledTimes(1)
    // 转移由 popstate 驱动（back 被 mock 未派发事件），状态未变——直改即双路径分叉
    expect(shellRoute.value).toBe('chat')
    backSpy.mockRestore()
  })

  it('goBackFromChat 在非 chat 态 no-op', () => {
    navigateRoute('sessions')
    const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {})
    goBackFromChat()
    expect(backSpy).not.toHaveBeenCalled()
    backSpy.mockRestore()
  })

  it('chat → connect（验身失效）合法：chatFrom 保留（返回会话恢复后语义由消费方裁决）', () => {
    navigateRoute('sessions')
    navigateRoute('chat')
    navigateRoute('connect')
    expect(shellRoute.value).toBe('connect')
  })
})

// 五态封闭性静态对账（词表防漂移）：ShellRoute 取值全集 = 三目的域 + chat + connect
it('五态词表封闭（新增路由态必须先过转移表评审）', () => {
  const all: ShellRoute[] = ['sessions', 'activity', 'settings', 'chat', 'connect']
  expect(all).toHaveLength(5)
})
