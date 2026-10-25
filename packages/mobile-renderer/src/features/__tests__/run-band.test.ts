// RunBand 呈现测试（remote-use-mobile-v2 §7.3 M-10 对账：v1 SubagentStatusLine 运行状态行
// 升级为运行带可点入 SubagentSheet——视图呈现断言自 v1 subagent-status.test.ts 迁维至 v2
// 消费方；分区写读逻辑在 shell/__tests__/subagent-records.test.ts）。
//
// 锁定三件事：
//   1. 无运行中子代理结构性不渲染（不占位）
//   2. 有运行中子代理 → 运行带渲染计数文案，点击 → openSheet('subagentList')
//      （sheet-manager 单槽互斥消费面，§6.13）
//   3. 分区清零（跑完推送）→ 运行带消失（响应性跟随分区读口）
//
// 运行：cd packages/mobile-renderer && npx vitest run src/features/__tests__/run-band.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import RunBand from '../RunBand.vue'
import {
  applySubagentRecords,
  __testing as subagentRecordsTesting,
} from '../../shell/subagent-records'
import { activeSheet, resetSheetManagerForTesting } from '../../shell/sheet-manager'
import { i18n } from '../../i18n'
import type { SubagentRecord } from '@taiji/shared'

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

function mountRunBand(sessionId: string) {
  return mount(RunBand, { props: { sessionId }, global: { plugins: [i18n] } })
}

describe('RunBand（M-10 运行带）', () => {
  beforeEach(() => {
    subagentRecordsTesting.resetSubagentPartitionsForTest()
    resetSheetManagerForTesting()
  })

  it('无运行中子代理不渲染不占位', () => {
    const wrapper = mountRunBand('sid-idle')
    expect(wrapper.find('[data-testid="mobile-run-band"]').exists()).toBe(false)
  })

  it('运行中子代理在场 → 运行带渲染计数文案，点击打开 subagentList 槽', async () => {
    applySubagentRecords('sid-band', [
      record({ subagentId: 'bg-1', slug: 'reviewer', status: 'running' }),
      record({ subagentId: 'bg-2', slug: 'worker', status: 'running' }),
    ])
    const wrapper = mountRunBand('sid-band')
    const band = wrapper.find('[data-testid="mobile-run-band"]')
    expect(band.exists()).toBe(true)
    expect(band.find('[data-testid="mobile-run-band-count"]').text()).toBe(
      i18n.global.t('mobile.runBand.running', { count: 2 }),
    )

    await band.trigger('click')
    await flushPromises()
    expect(activeSheet.value).toBe('subagentList')
  })

  it('分区清零（跑完推送 idle）→ 运行带消失（读口响应性）', async () => {
    applySubagentRecords('sid-done', [
      record({ subagentId: 'bg-1', slug: 'worker', status: 'running' }),
    ])
    const wrapper = mountRunBand('sid-done')
    expect(wrapper.find('[data-testid="mobile-run-band"]').exists()).toBe(true)

    applySubagentRecords('sid-done', [
      record({ subagentId: 'bg-1', slug: 'worker', status: 'idle', stopReason: 'completed' }),
    ])
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-run-band"]').exists()).toBe(false)
  })
})
