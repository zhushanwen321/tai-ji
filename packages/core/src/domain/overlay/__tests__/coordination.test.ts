/**
 * overlay 协调层单测 —— u-w2-browser-mount：openBrowser URL 注入链 + 会话删除级联。
 *
 * 覆盖（display-containers §7.4/§5.3）：
 * - openBrowser(url, sessionId)：开浮层 browser 内容（URL 注入链核心落点）；已开态换 URL/换会话 = 单例换内容
 * - 无效载荷 no-op（url / sessionId 空白）
 * - closeBrowserOverlayForSession（§7.4 发起会话删除的浮层终态）：**仅发起会话被删才关**
 *   ——删非发起会话浮层不动（S5 反向断言，防过宽清场）；browser 换 workflow 内容后同为不动
 *
 * 三视角：构建者白盒（载荷校验 + 条件式关闭）、使用者黑盒（「点 localhost 链接浮层开浏览器页、
 * 删掉别的会话浮层照常开着」的用户可见语义）、观察者形态（开合态读出形状）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/overlay/__tests__/coordination.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  openBrowser,
  openOverlay,
  closeBrowserOverlayForSession,
  _resetOverlayForTest,
} from '../coordination'
import { getOverlayControlState } from '../state'

beforeEach(() => {
  _resetOverlayForTest()
})

describe('openBrowser URL 注入链（§7.4：localhost 链接点击 → 浮层 BrowserPane）', () => {
  it('openBrowser 开浮层：isOpen=true + current=browser 载荷（url + 发起会话）', () => {
    openBrowser('http://localhost:1420/', 'sess-a')
    const state = getOverlayControlState()
    expect(state.isOpen).toBe(true)
    expect(state.current).toEqual({ kind: 'browser', payload: { url: 'http://localhost:1420/', sessionId: 'sess-a' } })
  })

  it('已开态再点另一链接 = 单例换内容（isOpen 保持开、载荷替换）', () => {
    openBrowser('http://localhost:1420/', 'sess-a')
    openBrowser('http://127.0.0.1:5173/', 'sess-a')
    const state = getOverlayControlState()
    expect(state.isOpen).toBe(true)
    expect(state.current).toEqual({ kind: 'browser', payload: { url: 'http://127.0.0.1:5173/', sessionId: 'sess-a' } })
  })

  it('url / sessionId 空白 → no-op（原态保持；无效内容不进浮层）', () => {
    openBrowser('http://localhost:1420/', 'sess-a')
    openBrowser('   ', 'sess-a')
    openBrowser('http://localhost:1420/', ' ')
    expect(getOverlayControlState().current).toEqual({ kind: 'browser', payload: { url: 'http://localhost:1420/', sessionId: 'sess-a' } })
  })
})

describe('closeBrowserOverlayForSession（§7.4 会话删除级联，仅发起会话触发）', () => {
  it('删发起会话 → 关浮层 + 复位（用户可见：浮层立即关闭、无残留内容）', () => {
    openBrowser('http://localhost:1420/', 'sess-a')
    closeBrowserOverlayForSession('sess-a')
    expect(getOverlayControlState().isOpen).toBe(false)
    expect(getOverlayControlState().current).toBeNull()
  })

  it('S5 反向断言：删非发起会话 → 浮层不动（仍开、内容不变）', () => {
    openBrowser('http://localhost:1420/', 'sess-a')
    closeBrowserOverlayForSession('sess-b')
    const state = getOverlayControlState()
    expect(state.isOpen).toBe(true)
    expect(state.current).toEqual({ kind: 'browser', payload: { url: 'http://localhost:1420/', sessionId: 'sess-a' } })
  })

  it('浮层内容是 workflow 时删任何会话都不经本级联关（workflow 走 closeWorkflowOverlay 先例）', () => {
    openOverlay({ kind: 'workflow', payload: { sessionId: 'sess-a', runId: 'wf-1' } })
    closeBrowserOverlayForSession('sess-a')
    expect(getOverlayControlState().isOpen).toBe(true)
    expect(getOverlayControlState().current?.kind).toBe('workflow')
  })

  it('浮层已关时调用 = no-op（幂等，不抛错）', () => {
    closeBrowserOverlayForSession('sess-a')
    expect(getOverlayControlState().isOpen).toBe(false)
    expect(getOverlayControlState().current).toBeNull()
  })
})
