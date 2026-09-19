/**
 * HeaderActionsHost 测试（plugin-header-action-modal-points u4b，AP-1 渲染契约）。
 *
 * 覆盖（三视角 TEST-STRATEGY §3：每条至少一个用户可见 DOM 断言）：
 * - 声明渲染 N 按钮 + testid 形态（header-action-<pluginId>-<id 段>，设计场景 1 契约）
 * - order 升序排序（缺省排后）
 * - badge ≤4 字符宿主截断 + 全文进 tooltip（AP-1 徽标契约）
 * - E13 三态：registered 可点 / unregistered 灰置 / unknown 首次缺省可点 + 保持上次值
 * - 运行时镜像 entry.disabled：true 灰置（插件业务态）/ false / undefined 不灰置
 * - E3 点击 → executeCommand(commandId)；命令缺失（返回 false）→ 本地置灰（禁静默 no-op）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/extension/HeaderActionsHost.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import HeaderActionsHost from '@/components/extension/HeaderActionsHost.vue'
import {
  HEADER_ACTIONS_SOURCE_KEY,
  type HeaderActionsSource,
  type HeaderActionCommandAvailability,
} from '@/composables/shell/useExtensionHostBridge'
import type { ContributionRecord, HeaderActionEntry } from '@taiji/core'

// ── 测试数据 ──
const schedulerAction: ContributionRecord = {
  pluginId: 'scheduler-manager',
  contributionId: 'scheduler-manager.open',
  type: 'headerAction',
  placement: 'panel.header',
  available: true,
  headerAction: { title: '定时任务', icon: 'clock', commandId: 'scheduler-manager.open', order: 20 },
}

function makeSource(overrides: Partial<HeaderActionsSource> = {}): HeaderActionsSource {
  return {
    getDeclarations: () => [schedulerAction],
    getRuntimeState: () => undefined,
    resolveCommandAvailability: () => 'registered',
    executeCommand: vi.fn(() => true),
    ...overrides,
  }
}

function mountHost(source: HeaderActionsSource, sessionId = 's1') {
  return mount(HeaderActionsHost, {
    props: { sessionId },
    global: { provide: { [HEADER_ACTIONS_SOURCE_KEY]: source } },
  })
}

describe('HeaderActionsHost', () => {
  it('按声明渲染按钮，testid 形态 = header-action-<pluginId>-<id 段>', () => {
    const wrapper = mountHost(makeSource())
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.exists()).toBe(true)
    // 用户可见断言：与内置按钮同规格 + 声明 title 兜底 tooltip
    expect(btn.classes()).toContain('size-[22px]')
    expect(btn.attributes('title')).toBe('定时任务')
    // 无 badge 时不渲染徽标
    expect(btn.find('span').exists()).toBe(false)
  })

  it('多条声明按 order 升序排序（缺省排后）', () => {
    const second: ContributionRecord = {
      pluginId: 'demo-echo',
      contributionId: 'demo-echo.ping',
      type: 'headerAction',
      placement: 'panel.header',
      available: true,
      headerAction: { title: 'Ping', icon: 'bell', commandId: 'demo-echo.ping', order: 5 },
    }
    const appended: ContributionRecord = {
      pluginId: 'late',
      contributionId: 'late.last',
      type: 'headerAction',
      placement: 'panel.header',
      available: true,
      headerAction: { title: 'Last', icon: 'bell', commandId: 'late.last' },
    }
    const source = makeSource({ getDeclarations: () => [schedulerAction, appended, second] })
    const wrapper = mountHost(source)
    const testids = wrapper.findAll('button').map((b) => b.attributes('data-testid'))
    expect(testids).toEqual([
      'header-action-demo-echo-ping',
      'header-action-scheduler-manager-open',
      'header-action-late-last',
    ])
  })

  it('badge 超过 4 字符截断显示，全文进 tooltip', () => {
    const entry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      badge: '12345',
      updatedAt: 1,
    }
    const source = makeSource({ getRuntimeState: () => entry })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.text()).toBe('1234')
    expect(btn.attributes('title')).toContain('12345')
  })

  it('E13 unregistered：按钮灰置 + tooltip「本会话未加载所需扩展」', () => {
    const source = makeSource({ resolveCommandAvailability: () => 'unregistered' })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toBe('本会话未加载所需扩展')
  })

  it('E13 unknown：首次缺省可点，tooltip「会话恢复中，暂无法判定」', () => {
    const source = makeSource({ resolveCommandAvailability: () => 'unknown' })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.attributes('title')).toBe('会话恢复中，暂无法判定')
  })

  it('E13 unknown：保持上一次 disabled 值（恢复窗口不翻转判定）', async () => {
    const availability = ref<HeaderActionCommandAvailability>('unregistered')
    const source = makeSource({ resolveCommandAvailability: () => availability.value })
    const wrapper = mountHost(source)
    expect(wrapper.find('[data-testid=header-action-scheduler-manager-open]').attributes('disabled')).toBeDefined()
    availability.value = 'unknown'
    await nextTick()
    expect(wrapper.find('[data-testid=header-action-scheduler-manager-open]').attributes('disabled')).toBeDefined()
    // 恢复后重判（registered → 可点）
    availability.value = 'registered'
    await nextTick()
    expect(wrapper.find('[data-testid=header-action-scheduler-manager-open]').attributes('disabled')).toBeUndefined()
  })

  it('E13 registered：运行时 tooltip 优先于声明 title', () => {
    const entry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      tooltip: '3 个启用任务',
      updatedAt: 1,
    }
    const source = makeSource({ getRuntimeState: () => entry })
    const wrapper = mountHost(source)
    expect(wrapper.find('[data-testid=header-action-scheduler-manager-open]').attributes('title')).toBe('3 个启用任务')
  })

  it('运行时镜像 entry.disabled=true：按钮灰置（插件 updateHeaderAction 推的业务态被消费）', () => {
    const entry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      disabled: true,
      updatedAt: 1,
    }
    const source = makeSource({ getRuntimeState: () => entry })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.attributes('disabled')).toBeDefined()
    // 灰置只挡点击，tooltip 仍是插件侧运行时文案（非 unregistered 提示）
    expect(btn.attributes('title')).toBe('定时任务')
  })

  it('运行时镜像 entry.disabled=false / 未推送（undefined）：不灰置', () => {
    const disabledEntry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      disabled: false,
      updatedAt: 1,
    }
    const enabled = mountHost(makeSource({ getRuntimeState: () => disabledEntry }))
    expect(enabled.find('[data-testid=header-action-scheduler-manager-open]').attributes('disabled')).toBeUndefined()
    // 未推送运行时帧（getRuntimeState → undefined）：E13 registered 主路径可点
    const noEntry = mountHost(makeSource({ getRuntimeState: () => undefined }))
    expect(noEntry.find('[data-testid=header-action-scheduler-manager-open]').attributes('disabled')).toBeUndefined()
  })

  it('点击 → executeCommand(commandId)（执行器收到命令 id）', async () => {
    const executeCommand = vi.fn(() => true)
    const source = makeSource({ executeCommand })
    const wrapper = mountHost(source)
    await wrapper.find('[data-testid=header-action-scheduler-manager-open]').trigger('click')
    expect(executeCommand).toHaveBeenCalledWith('scheduler-manager.open')
  })

  it('E3 命令缺失（executeCommand 返回 false）→ 按钮置灰，禁静默 no-op', async () => {
    const executeCommand = vi.fn(() => false)
    const source = makeSource({ executeCommand })
    const wrapper = mountHost(source)
    const btn = () => wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn().attributes('disabled')).toBeUndefined()
    await btn().trigger('click')
    expect(btn().attributes('disabled')).toBeDefined()
  })

  it('无声明时整组件零 DOM（不挤压内置按钮）', () => {
    const source = makeSource({ getDeclarations: () => [] })
    const wrapper = mountHost(source)
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('sessionId 为空（landing）不渲染', () => {
    const wrapper = mountHost(makeSource(), '')
    expect(wrapper.find('button').exists()).toBe(false)
  })
})
