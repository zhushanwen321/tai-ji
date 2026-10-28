// coordination.test.ts —— core C19 簇合并产物（round5-G）。
// 共同被测业务模块：`src/domain/overlay/coordination.ts`、`src/domain/overlay/state.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/domain/overlay/__tests__/coordination.test.ts（15 用例，skip 0）
//   - src/domain/overlay/__tests__/state.test.ts（10 用例，skip 0）

import { describe, it, expect, beforeEach } from 'vitest'
import { openBrowser, openCanvasOverlay, openSchedulerOverlay, openOverlay, closeBrowserOverlayForSession, closeCanvasOverlayForSession, closeOverlay, _resetOverlayForTest } from '../coordination'
import { getOverlayControlState, useOverlayControl } from '../state'
import { type OverlayContent } from '../types'

// ======== 来源：coordination.test.ts ========
describe("coordination", () => {
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

  describe('openSchedulerOverlay（scheduler 整合浮层一级 tab，2026-10-06：插件树持续推送，浮层直取）', () => {
    it('开浮层：isOpen=true + current=scheduler 载荷（所属会话）', () => {
      openSchedulerOverlay('sess-a')
      const state = getOverlayControlState()
      expect(state.isOpen).toBe(true)
      expect(state.current).toEqual({ kind: 'scheduler', payload: { sessionId: 'sess-a' } })
    })

    it('已开态（workflow 内容）再开 = 单例换内容（isOpen 保持开、载荷替换为 scheduler）', () => {
      openOverlay({ kind: 'workflow', payload: { sessionId: 'sess-a', runId: 'wf-1' } })
      openSchedulerOverlay('sess-a')
      const state = getOverlayControlState()
      expect(state.isOpen).toBe(true)
      expect(state.current).toEqual({ kind: 'scheduler', payload: { sessionId: 'sess-a' } })
    })

    it('sessionId 空白 → no-op（原态保持；无效内容不进浮层）', () => {
      openSchedulerOverlay('sess-a')
      openSchedulerOverlay('   ')
      expect(getOverlayControlState().current).toEqual({ kind: 'scheduler', payload: { sessionId: 'sess-a' } })
    })

    it('关浮层复位不变量对 scheduler 内容同构：closeOverlay 后 isOpen=false + current=null（S5 反向锚：browser 级联不关 scheduler 内容）', () => {
      openSchedulerOverlay('sess-a')
      closeBrowserOverlayForSession('sess-a')
      expect(getOverlayControlState().isOpen).toBe(true)
      expect(getOverlayControlState().current?.kind).toBe('scheduler')
      closeOverlay()
      expect(getOverlayControlState().isOpen).toBe(false)
      expect(getOverlayControlState().current).toBeNull()
    })
  })

  describe('openCanvasOverlay（canvas 画布 tab，problem-solve-canvas §3.1(3)：scheduler 双入口先例平移；D4 归属会话隔离）', () => {
    it('kind 直达打开：isOpen=true + current=canvas 载荷（canvasId + 归属 sessionId）', () => {
      openCanvasOverlay('cvs-1', 'sess-a')
      const state = getOverlayControlState()
      expect(state.isOpen).toBe(true)
      expect(state.current).toEqual({ kind: 'canvas', payload: { canvasId: 'cvs-1', sessionId: 'sess-a' } })
    })

    it('已开态（scheduler 内容）再开 = 单例换内容（isOpen 保持开、载荷替换为 canvas）', () => {
      openSchedulerOverlay('sess-a')
      openCanvasOverlay('cvs-1', 'sess-a')
      const state = getOverlayControlState()
      expect(state.isOpen).toBe(true)
      expect(state.current).toEqual({ kind: 'canvas', payload: { canvasId: 'cvs-1', sessionId: 'sess-a' } })
    })

    it('canvasId / sessionId 空白 → no-op（原态保持；无效内容不进浮层）', () => {
      openCanvasOverlay('cvs-1', 'sess-a')
      openCanvasOverlay('   ', 'sess-a')
      openCanvasOverlay('cvs-1', '')
      expect(getOverlayControlState().current).toEqual({ kind: 'canvas', payload: { canvasId: 'cvs-1', sessionId: 'sess-a' } })
    })

    it('会话删除级联（D4）：删归属会话 → 关 canvas 内容浮层；删其他会话不关', () => {
      openCanvasOverlay('cvs-1', 'sess-a')
      closeCanvasOverlayForSession('sess-b')
      expect(getOverlayControlState().isOpen).toBe(true)
      expect(getOverlayControlState().current?.kind).toBe('canvas')
      closeCanvasOverlayForSession('sess-a')
      expect(getOverlayControlState().isOpen).toBe(false)
      expect(getOverlayControlState().current).toBeNull()
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
});

// ======== 来源：state.test.ts ========
describe("state", () => {
  const WORKFLOW_A: OverlayContent = { kind: 'workflow', payload: { sessionId: 's-1', runId: 'wf-1' } }

  const WORKFLOW_B: OverlayContent = { kind: 'workflow', payload: { sessionId: 's-1', runId: 'wf-2' } }

  const BROWSER: OverlayContent = { kind: 'browser', payload: { url: 'http://127.0.0.1:5173/', sessionId: 's-1' } }

  beforeEach(() => {
    _resetOverlayForTest()
  })

  describe('单例换内容（§6.5/§7.1）', () => {
    it('openOverlay 开浮层：isOpen=true + current=载荷（用户可见：workflow 图浮层打开）', () => {
      openOverlay(WORKFLOW_A)
      const state = getOverlayControlState()
      expect(state.isOpen).toBe(true)
      expect(state.current).toEqual(WORKFLOW_A)
    })

    it('开新内容 = 换内容：不先关后开、isOpen 保持开、current 替换（用户可见：再点另一个 run 直接换图）', () => {
      openOverlay(WORKFLOW_A)
      openOverlay(WORKFLOW_B)
      const state = getOverlayControlState()
      expect(state.isOpen).toBe(true)
      expect(state.current).toEqual(WORKFLOW_B)
    })

    it('跨 kind 换内容（workflow → browser）同为单例换内容语义', () => {
      openOverlay(WORKFLOW_A)
      openOverlay(BROWSER)
      const state = getOverlayControlState()
      expect(state.isOpen).toBe(true)
      expect(state.current).toEqual(BROWSER)
    })
  })

  describe('关浮层复位不变量（isOpen=false ⇔ current=null）', () => {
    it('closeOverlay 后 current 复位 null（用户可见：关闭浮层无残留内容，重开是新内容）', () => {
      openOverlay(WORKFLOW_A)
      closeOverlay()
      const state = getOverlayControlState()
      expect(state.isOpen).toBe(false)
      expect(state.current).toBeNull()
    })

    it('初始态即复位形态（未开过：关态 + 无内容）', () => {
      const state = getOverlayControlState()
      expect(state.isOpen).toBe(false)
      expect(state.current).toBeNull()
    })
  })

  describe('载荷校验边界（无效载荷 no-op，不改开合态）', () => {
    it('workflow 载荷 sessionId/runId 空串 → no-op（原态保持）', () => {
      openOverlay(WORKFLOW_A)
      openOverlay({ kind: 'workflow', payload: { sessionId: '', runId: 'wf-9' } })
      expect(getOverlayControlState().current).toEqual(WORKFLOW_A)
      expect(getOverlayControlState().isOpen).toBe(true)

      closeOverlay()
      openOverlay({ kind: 'workflow', payload: { sessionId: 's-1', runId: '  ' } })
      expect(getOverlayControlState().isOpen).toBe(false)
      expect(getOverlayControlState().current).toBeNull()
    })

    it('browser 载荷 url 空白串 → no-op（W2 URL 注入链的前置边界）', () => {
      openOverlay({ kind: 'browser', payload: { url: '   ', sessionId: 's-1' } })
      expect(getOverlayControlState().isOpen).toBe(false)
      expect(getOverlayControlState().current).toBeNull()
    })

    it('browser 载荷 sessionId 空串 → no-op（发起会话是级联/谓词锚，缺则不进浮层）', () => {
      openOverlay({ kind: 'browser', payload: { url: 'http://127.0.0.1:5173/', sessionId: '' } })
      expect(getOverlayControlState().isOpen).toBe(false)
      expect(getOverlayControlState().current).toBeNull()
    })
  })

  describe('单一权威形态（消费方读同一 reactive 单例）', () => {
    it('getOverlayControlState 与 useOverlayControl 读同一对象同一值（无第二权威）', () => {
      openOverlay(WORKFLOW_A)
      const { isOpen, current } = useOverlayControl()
      expect(isOpen.value).toBe(true)
      expect(current.value).toEqual(WORKFLOW_A)
      // 同一权威：视图值与状态对象逐字段同源
      expect(current.value).toBe(getOverlayControlState().current)
    })

    it('useOverlayControl 响应式跟随开合（Host 容器 :open 绑定语义）', () => {
      const { isOpen, current } = useOverlayControl()
      expect(isOpen.value).toBe(false)

      openOverlay(BROWSER)
      expect(isOpen.value).toBe(true)
      expect(current.value).toEqual(BROWSER)

      closeOverlay()
      expect(isOpen.value).toBe(false)
      expect(current.value).toBeNull()
    })
  })
});
