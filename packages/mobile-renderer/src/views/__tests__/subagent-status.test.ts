// subagent 运行状态行（remote-use A9 / U15；D5 去留表 onSubagents 行）。
//
// 锁定两个验收条款：
//   1. onSubagents 消息写分区并渲染运行状态行——bootstrap effects.onSubagents 直挂
//      applySubagentRecords（写 per-session Map 分区，不可变替换）→ 组件按活跃 sessionId
//      读分区 → running 汇总状态行（idle 不计、死亡纳管态 running+stopReason 不计）。
//   2. 接线位在壳扩展层非 factory 内——effects.onSubagents 与组件模块导出 applySubagentRecords
//      同源（直挂）；core lifecycle factory 产物不含 onSubagents（factory 不含 subagent 语义，
//      D5 去留表口径的机器断言）。
//
// 写分区语义 = 桌面 stores/subagent.ts applyRecords 的最小子集（分区范式：不可变整 Map 替换；
// 推送是权威数据，空数组照写——对齐桌面推送路径不经 strike 守卫）。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/views/__tests__/subagent-status.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import SubagentStatusLine, {
  applySubagentRecords,
  resetSubagentPartitionsForTest,
} from '../SubagentStatusLine.vue'
import { __testing } from '../../bootstrap'
import { createLifecycleEffects } from '@taiji/core'
import { chatStore, sessionStore } from '../../shell/app-runtime'
import type { SubagentRecord } from '@taiji/shared'
import { i18n } from '../../i18n'

const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

function record(overrides: Partial<SubagentRecord> & { subagentId: string }): SubagentRecord {
  return {
    sessionFile: null,
    agent: 'general-purpose',
    slug: '',
    task: 'demo task',
    status: 'idle',
    ...overrides,
  }
}

function mountStatusLine(sessionId: string): VueWrapper {
  return mount(SubagentStatusLine, {
    props: { sessionId },
    global: { plugins: [i18n] },
  })
}

describe('subagent 运行状态行（A9/U15）', () => {
  beforeEach(() => {
    // 模块级分区单例跨用例残留清零（__testing 先例：仅测试消费）
    resetSubagentPartitionsForTest()
  })

  it('onSubagents 消息经壳 effects 写分区并渲染运行状态行（全链路：回调 → 分区 → 渲染）', () => {
    __testing.shellEffects.onSubagents?.('sid-live', [
      record({ subagentId: 'bg-1', slug: 'reviewer', status: 'running' }),
    ])

    const wrapper = mountStatusLine('sid-live')
    const line = wrapper.find('[data-testid="mobile-subagent-status-line"]')
    expect(line.exists()).toBe(true)
    expect(line.attributes('role')).toBe('status')
    expect(line.text()).toBe(t('mobile.subagentStatus.running', { slugs: 'reviewer' }))
  })

  it('推送是权威数据：同 sid 二次推送整体替换（跑完翻 idle → 状态行消失）', async () => {
    applySubagentRecords('sid-replace', [
      record({ subagentId: 'bg-1', slug: 'worker', status: 'running' }),
    ])
    const wrapper = mountStatusLine('sid-replace')
    expect(wrapper.find('[data-testid="mobile-subagent-status-line"]').exists()).toBe(true)

    applySubagentRecords('sid-replace', [
      record({ subagentId: 'bg-1', slug: 'worker', status: 'idle', stopReason: 'completed' }),
    ])
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-subagent-status-line"]').exists()).toBe(false)
  })

  it('running 过滤：idle 记录不计入运行汇总（占用判据 = running 且无 stopReason）', () => {
    applySubagentRecords('sid-filter', [
      record({ subagentId: 'bg-1', slug: 'runner', status: 'running' }),
      record({ subagentId: 'bg-2', slug: 'finished', status: 'idle', stopReason: 'completed' }),
    ])

    const wrapper = mountStatusLine('sid-filter')
    const text = wrapper.find('[data-testid="mobile-subagent-status-line"]').text()
    expect(text).toContain('runner')
    expect(text).not.toContain('finished')
  })

  it('死亡纳管态（running + stopReason）不算在跑；无 running 记录时状态行不渲染', () => {
    applySubagentRecords('sid-dead-running', [
      record({ subagentId: 'bg-1', slug: 'adopted', status: 'running', stopReason: 'failed' }),
    ])
    const wrapper = mountStatusLine('sid-dead-running')
    expect(wrapper.find('[data-testid="mobile-subagent-status-line"]').exists()).toBe(false)

    // 空数组推送（无 subagent 会话）同样不渲染
    applySubagentRecords('sid-empty', [])
    const wrapperEmpty = mountStatusLine('sid-empty')
    expect(wrapperEmpty.find('[data-testid="mobile-subagent-status-line"]').exists()).toBe(false)
  })

  it('分区隔离：不同 session 各读各的分区（props sessionId 切换自动重算）', async () => {
    applySubagentRecords('sid-a', [
      record({ subagentId: 'bg-1', slug: 'alpha', status: 'running' }),
    ])
    const wrapper = mountStatusLine('sid-a')
    expect(wrapper.find('[data-testid="mobile-subagent-status-line"]').text()).toContain('alpha')

    await wrapper.setProps({ sessionId: 'sid-b' })
    expect(wrapper.find('[data-testid="mobile-subagent-status-line"]').exists()).toBe(false)

    applySubagentRecords('sid-b', [
      record({ subagentId: 'bg-2', slug: 'beta', status: 'running' }),
    ])
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-subagent-status-line"]').text()).toContain('beta')
    expect(wrapper.find('[data-testid="mobile-subagent-status-line"]').text()).not.toContain('alpha')
  })

  it('slug 缺省兜底 agent 名（旧 session 数据 slug 空串形态文案不空）', () => {
    applySubagentRecords('sid-noslug', [
      record({ subagentId: 'bg-1', slug: '', agent: 'reviewer', status: 'running' }),
    ])

    const wrapper = mountStatusLine('sid-noslug')
    expect(wrapper.find('[data-testid="mobile-subagent-status-line"]').text()).toBe(
      t('mobile.subagentStatus.running', { slugs: 'reviewer' }),
    )
  })

  it('接线位在壳扩展层非 factory 内：effects.onSubagents 与组件导出同源直挂；factory 产物无 onSubagents', () => {
    // 直挂断言：bootstrap 壳 effects 的 onSubagents 就是组件模块导出的写入口（非包装非转接）
    expect(__testing.shellEffects.onSubagents).toBe(applySubagentRecords)

    // factory 不含 subagent 语义（D5 去留表）：createLifecycleEffects 产物键集无 onSubagents
    const factoryEffects = createLifecycleEffects(
      { chat: chatStore, session: sessionStore },
      { restored: 'r', restoreFailed: 'f' },
    )
    expect(Object.keys(factoryEffects)).not.toContain('onSubagents')
  })
})
