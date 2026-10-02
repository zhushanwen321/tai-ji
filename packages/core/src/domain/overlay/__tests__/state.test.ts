/**
 * overlay 开合态 SSOT 单测 —— display-containers u-w1-core 验收②「overlay SSOT 单一权威」。
 *
 * 覆盖：openOverlay 开/换内容（单例换内容）/ closeOverlay 复位不变量（isOpen=false ⇔ current=null）/
 * 无效载荷 no-op 边界 / useOverlayControl 响应式视图 / 单一权威形态（全部读写经同一 reactive 单例）。
 *
 * 三视角：构建者白盒（单例 reactive + 写原语收口）、使用者黑盒（「点 workflow 块开浮层看图、
 * 再点另一个 run 换内容、关闭后无残留」的用户可见语义）、观察者形态（状态读出形状）。
 *
 * SSOT 迁移对账锚：本域是开合态唯一权威——renderer workflow-viz-overlay.ts 的
 * overlayOpen / overlayCurrent 模块级 ref 已退役（DAG 缓存留 renderer），消费面
 * （Esc 编排器 / AppShell 宿主 / Host 容器）统一读 getOverlayControlState / useOverlayControl。
 *
 * 运行：cd packages/core && npx vitest run src/domain/overlay/__tests__/state.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  getOverlayControlState,
  useOverlayControl,
} from '../state'
import { openOverlay, closeOverlay, _resetOverlayForTest } from '../coordination'
import type { OverlayContent } from '../types'

const WORKFLOW_A: OverlayContent = { kind: 'workflow', payload: { sessionId: 's-1', runId: 'wf-1' } }
const WORKFLOW_B: OverlayContent = { kind: 'workflow', payload: { sessionId: 's-1', runId: 'wf-2' } }
const BROWSER: OverlayContent = { kind: 'browser', payload: { url: 'http://127.0.0.1:5173/' } }

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
    openOverlay({ kind: 'browser', payload: { url: '   ' } })
    expect(getOverlayControlState().isOpen).toBe(false)
    expect(getOverlayControlState().current).toBeNull()
  })
})

describe('单一权威形态（消费面读同一 reactive 单例）', () => {
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
