/**
 * panel-tabs 纯逻辑测试（workflow overlay 实况面板的一级 tab 模型——设计 §3.1-2：
 * 固定 tab 不可关 / 关闭激活左侧相邻 / 无左侧相邻回 workflow 固定 tab / 重复打开仅激活）。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow-viz/__tests__/panel-tabs.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  WORKFLOW_FIXED_TAB_KEY,
  agentTabKey,
  closeLiveTab,
  openLiveTab,
  phaseTabKey,
} from '../panel/panel-tabs'
import type { WorkflowLiveTab } from '../panel/panel-tabs'

function phaseTab(name: string): WorkflowLiveTab {
  return { key: phaseTabKey(name), kind: 'phase', title: name, phase: name }
}

function agentTab(id: number, title: string): WorkflowLiveTab {
  return { key: agentTabKey(id), kind: 'agent', title, callId: id }
}

describe('panel-tabs：openLiveTab', () => {
  it('新 tab 追加到尾部并激活；已存在仅激活不重复追加', () => {
    const base = [phaseTab('alpha')]
    const opened = openLiveTab(base, phaseTab('beta'))
    expect(opened.tabs.map((t) => t.title)).toEqual(['alpha', 'beta'])
    expect(opened.activeKey).toBe(phaseTabKey('beta'))

    const again = openLiveTab(opened.tabs, phaseTab('alpha'))
    expect(again.tabs.map((t) => t.title)).toEqual(['alpha', 'beta']) // 不重复
    expect(again.activeKey).toBe(phaseTabKey('alpha'))
  })
})

describe('panel-tabs：closeLiveTab', () => {
  it('固定 tab 不可关（原样返回）', () => {
    const tabs = [phaseTab('alpha')]
    const result = closeLiveTab(tabs, phaseTabKey('alpha'), WORKFLOW_FIXED_TAB_KEY)
    expect(result.tabs).toHaveLength(1)
    expect(result.activeKey).toBe(phaseTabKey('alpha'))
  })

  it('关闭激活 tab 激活左侧相邻；首个动态 tab 关闭后回 workflow 固定 tab', () => {
    const tabs = [phaseTab('alpha'), phaseTab('beta'), agentTab(0, 'rev')]
    // 关最右（agent rev）→ 激活左侧 beta
    const closeRight = closeLiveTab(tabs, agentTabKey(0), agentTabKey(0))
    expect(closeRight.tabs.map((t) => t.title)).toEqual(['alpha', 'beta'])
    expect(closeRight.activeKey).toBe(phaseTabKey('beta'))
    // 关首个（alpha，当前激活）→ 无左侧相邻 → 回 workflow 固定 tab
    const closeFirst = closeLiveTab(tabs, phaseTabKey('alpha'), phaseTabKey('alpha'))
    expect(closeFirst.tabs.map((t) => t.title)).toEqual(['beta', 'rev'])
    expect(closeFirst.activeKey).toBe(WORKFLOW_FIXED_TAB_KEY)
  })

  it('关闭非激活 tab 激活键不变', () => {
    const tabs = [phaseTab('alpha'), phaseTab('beta')]
    const result = closeLiveTab(tabs, phaseTabKey('beta'), phaseTabKey('alpha'))
    expect(result.tabs.map((t) => t.title)).toEqual(['beta'])
    expect(result.activeKey).toBe(phaseTabKey('beta'))
  })

  it('关闭不存在的 tab 原样返回（防御）', () => {
    const tabs = [phaseTab('alpha')]
    const result = closeLiveTab(tabs, phaseTabKey('alpha'), phaseTabKey('ghost'))
    expect(result.tabs).toHaveLength(1)
    expect(result.activeKey).toBe(phaseTabKey('alpha'))
  })
})
